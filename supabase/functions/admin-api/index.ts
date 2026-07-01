import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const ALLOWED_TABLES = [
  "products", "categories", "orders", "users", "banners",
  "delivery_zones", "coupons", "coupon_usage", "returns",
  "reviews", "audit_log", "admin_accounts", "product_collections",
  "promotions", "favorites", "notifications", "product_relations",
  "referrals",
];

// Tables that only require read (no session needed for SELECT)
// ALL mutations require a valid admin session token
const MUTATION_ACTIONS = ["insert", "update", "delete", "updateOrderStatus"];

async function hashToken(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyAdminSession(
  supabase: ReturnType<typeof createClient>,
  admin_session: { admin_id: string; token: string } | undefined
): Promise<{ ok: boolean; error?: string }> {
  if (!admin_session?.admin_id || !admin_session?.token) {
    return { ok: false, error: "Admin session required" };
  }
  const tokenHash = await hashToken(admin_session.token);
  const { data } = await supabase
    .from("admin_accounts")
    .select("id, is_active")
    .eq("id", admin_session.admin_id)
    .eq("session_token", tokenHash)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) {
    return { ok: false, error: "Invalid or expired admin session" };
  }
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { action, table, data, filters, id, admin_session } = body;

    if (!action || !table) {
      return new Response(
        JSON.stringify({ error: "Missing action or table" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!ALLOWED_TABLES.includes(table)) {
      return new Response(
        JSON.stringify({ error: "Table not allowed" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ALL mutation actions require a valid admin session
    if (MUTATION_ACTIONS.includes(action)) {
      const check = await verifyAdminSession(supabase, admin_session);
      if (!check.ok) {
        return new Response(
          JSON.stringify({ error: check.error }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let result;

    switch (action) {
      case "select": {
        let query = supabase.from(table).select(data || "*");
        if (filters) {
          for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
              query = query.eq(key, value as string);
            }
          }
        }
        if (table === "orders") {
          query = query.order("created_at", { ascending: false }).range(0, 499);
        } else if (table === "audit_log") {
          query = query.order("created_at", { ascending: false }).limit(200);
        } else {
          query = query.order("created_at", { ascending: false }).range(0, 499);
        }
        const { data: rows, error } = await query;
        if (error) throw error;
        result = rows;
        break;
      }

      case "insert": {
        const { data: inserted, error } = await supabase
          .from(table)
          .insert(data)
          .select()
          .single();
        if (error) throw error;
        result = inserted;
        break;
      }

      case "update": {
        if (id === "__bulk__" && filters) {
          let query = supabase
            .from(table)
            .update({ ...data, updated_at: new Date().toISOString() });
          for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
              query = query.eq(key, value as string);
            }
          }
          const { error } = await query;
          if (error) throw error;
          result = { success: true };
        } else {
          if (!id) throw new Error("ID required for update");
          const { error } = await supabase
            .from(table)
            .update({ ...data, updated_at: new Date().toISOString() })
            .eq("id", id);
          if (error) throw error;
          result = { success: true };
        }
        break;
      }

      case "delete": {
        if (id === "__filter__" && filters) {
          let query = supabase.from(table).delete();
          for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
              query = query.eq(key, value as string);
            }
          }
          const { error } = await query;
          if (error) throw error;
        } else {
          if (!id) throw new Error("ID required for delete");
          const { error } = await supabase.from(table).delete().eq("id", id);
          if (error) throw error;
        }
        result = { success: true };
        break;
      }

      case "updateOrderStatus": {
        if (!id) throw new Error("ID required");
        const { status, changed_by } = data;
        const { data: order, error: fetchErr } = await supabase
          .from("orders")
          .select("status_history, telegram_user_id")
          .eq("id", id)
          .maybeSingle();
        if (fetchErr) throw fetchErr;

        const history = Array.isArray(order?.status_history) ? order.status_history : [];
        const newEntry = {
          status,
          changed_at: new Date().toISOString(),
          changed_by: changed_by || "Admin",
        };

        const { data: updatedOrder, error: updateErr } = await supabase
          .from("orders")
          .update({
            status,
            status_history: [...history, newEntry],
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .select()
          .single();
        if (updateErr) throw updateErr;

        if (order?.telegram_user_id) {
          const STATUS_LABELS: Record<string, string> = {
            new: "Новый", processing: "В обработке", assembling: "В сборке",
            assembled: "Собран", shipping: "В доставке", delivered: "Доставлен",
            cancelled: "Отменён", return_requested: "Возврат", returned: "Возвращён",
          };
          await supabase.from("notifications").insert({
            telegram_user_id: order.telegram_user_id,
            type: `order_${status}`,
            title: `Заказ #${id.slice(0, 8).toUpperCase()}`,
            body: `Статус изменён: ${STATUS_LABELS[status] || status}`,
            data: { order_id: id, status },
          }).catch(() => {});
        }

        result = updatedOrder;
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return new Response(
      JSON.stringify({ success: true, data: result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Admin API error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

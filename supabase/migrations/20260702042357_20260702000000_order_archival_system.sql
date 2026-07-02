/*
  # Order Archival System

  Business logic:
  - Client sees only active orders (visible_to_client = true, deleted_at IS NULL)
  - When order is cancelled or completed (delivered), it becomes hidden from client
  - Admin sees ALL orders, including archived ones
  - Full history is preserved for admin analytics

  Changes:
  1. Add visible_to_client boolean (default true)
  2. Add archived_at timestamptz (null while active)
  3. Add cancellation_reason text
  4. Update append_order_status to auto-archive on cancelled/delivered
  5. Add indexes for efficient filtering
*/

-- Add new columns
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'visible_to_client'
  ) THEN
    ALTER TABLE orders ADD COLUMN visible_to_client boolean DEFAULT true;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'archived_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN archived_at timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'cancellation_reason'
  ) THEN
    ALTER TABLE orders ADD COLUMN cancellation_reason text;
  END IF;
END $$;

-- Set existing completed/cancelled/returned orders as archived and hidden from client
UPDATE orders
SET 
  visible_to_client = false,
  archived_at = COALESCE(
    (SELECT (elem->>'changed_at')::timestamptz 
     FROM jsonb_array_elements(status_history) elem 
     WHERE elem->>'status' IN ('cancelled', 'delivered', 'returned')
     ORDER BY (elem->>'changed_at')::timestamptz DESC 
     LIMIT 1),
    updated_at
  )
WHERE status IN ('cancelled', 'delivered', 'returned')
  AND visible_to_client = true;

-- Create indexes for efficient filtering
CREATE INDEX IF NOT EXISTS idx_orders_visible_to_client ON orders(visible_to_client);
CREATE INDEX IF NOT EXISTS idx_orders_archived_at ON orders(archived_at);
CREATE INDEX IF NOT EXISTS idx_orders_telegram_visible ON orders(telegram_user_id, visible_to_client);

-- Update append_order_status function to auto-archive
CREATE OR REPLACE FUNCTION append_order_status(
  p_order_id text,
  p_status text,
  p_changed_by text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result jsonb;
  v_should_archive boolean := false;
BEGIN
  -- Determine if order should be archived (hidden from client)
  IF p_status IN ('cancelled', 'delivered', 'returned') THEN
    v_should_archive := true;
  END IF;

  UPDATE orders
  SET status = p_status,
      status_history = status_history || jsonb_build_array(
        jsonb_build_object(
          'status', p_status,
          'changed_at', now()::text,
          'changed_by', p_changed_by,
          'note', p_note
        )
      ),
      updated_at = now(),
      visible_to_client = CASE WHEN v_should_archive THEN false ELSE visible_to_client END,
      archived_at = CASE WHEN v_should_archive THEN now() ELSE archived_at END,
      cancellation_reason = CASE 
        WHEN p_status = 'cancelled' AND p_note IS NOT NULL THEN p_note
        ELSE cancellation_reason
      END
  WHERE id = p_order_id
  RETURNING jsonb_build_object(
    'id', id,
    'status', status,
    'total_amount', total_amount,
    'status_history', status_history,
    'customer_info', customer_info,
    'delivery_type', delivery_type,
    'delivery_cost', delivery_cost,
    'payment_method', payment_method,
    'notes', notes,
    'created_at', created_at,
    'updated_at', updated_at,
    'visible_to_client', visible_to_client,
    'archived_at', archived_at,
    'cancellation_reason', cancellation_reason,
    'telegram_user_id', telegram_user_id
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Function to get client-visible orders only
CREATE OR REPLACE FUNCTION get_client_orders(p_telegram_user_id bigint)
RETURNS TABLE (
  id uuid,
  telegram_user_id bigint,
  items jsonb,
  total_amount numeric,
  status text,
  customer_info jsonb,
  delivery_type text,
  delivery_cost numeric,
  payment_method text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  status_history jsonb,
  deleted_at timestamptz,
  coupon_id uuid,
  discount_amount numeric,
  transaction_id text,
  paid_at timestamptz,
  visible_to_client boolean,
  archived_at timestamptz,
  cancellation_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM orders
  WHERE telegram_user_id = p_telegram_user_id
    AND visible_to_client = true
    AND deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT 50;
END;
$$;

-- Function to get all orders for admin (with optional filters)
CREATE OR REPLACE FUNCTION get_admin_orders(
  p_status_filter text DEFAULT NULL,
  p_search_query text DEFAULT NULL,
  p_include_archived boolean DEFAULT true
)
RETURNS TABLE (
  id uuid,
  telegram_user_id bigint,
  items jsonb,
  total_amount numeric,
  status text,
  customer_info jsonb,
  delivery_type text,
  delivery_cost numeric,
  payment_method text,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  status_history jsonb,
  deleted_at timestamptz,
  coupon_id uuid,
  discount_amount numeric,
  transaction_id text,
  paid_at timestamptz,
  visible_to_client boolean,
  archived_at timestamptz,
  cancellation_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM orders
  WHERE 
    (p_status_filter IS NULL OR status = p_status_filter)
    AND (NOT p_include_archived OR true)  -- admin sees all
    AND deleted_at IS NULL
    AND (
      p_search_query IS NULL 
      OR id::text ILIKE '%' || p_search_query || '%'
      OR telegram_user_id::text ILIKE '%' || p_search_query || '%'
      OR customer_info::text ILIKE '%' || p_search_query || '%'
    )
  ORDER BY created_at DESC
  LIMIT 200;
END;
$$;

COMMENT ON COLUMN orders.visible_to_client IS 'If false, order is hidden from customer (archived)';
COMMENT ON COLUMN orders.archived_at IS 'When order was archived (completed/cancelled)';
COMMENT ON COLUMN orders.cancellation_reason IS 'Reason for cancellation if applicable';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Check, X, ZoomIn, Package } from 'lucide-react';
import { useAllReturns, useAdjustStock } from '../../lib/supabase/hooks';
import { supabase } from '../../lib/supabase';
import { toast } from '../../components/Toast';
import { auditLogQueries } from '../../lib/supabase/queries';
import { getCurrentAdmin } from '../../lib/auth';
import { formatPrice } from '../../lib/utils';

import type { Return } from '../../lib/supabase/queries';

const STATUS_LABELS: Record<Return['status'], string> = {
  pending: 'На рассмотрении',
  approved: 'Одобрен — ожидает забора',
  rejected: 'Отклонён',
  refunded: 'Возвращён — товар принят',
};

const STATUS_COLORS: Record<Return['status'], string> = {
  pending: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  refunded: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
};

const TELEGRAM_STATUS_MESSAGES: Record<Return['status'], { ru: string; uz: string }> = {
  pending: { ru: 'Ваша заявка на возврат рассматривается', uz: "Qaytarish so'rovingiz ko'rib chiqilmoqda" },
  approved: { ru: 'Возврат подтверждён! Мы скоро заберём товар.', uz: "Qaytarish tasdiqlandi! Tez orada mahsulotni olamiz." },
  rejected: { ru: 'Заявка на возврат отклонена', uz: "Qaytarish so'rovi rad etildi" },
  refunded: { ru: 'Возврат завершён. Средства будут возвращены.', uz: "Qaytarish yakunlandi. Pul qaytariladi." },
};

export const AdminReturns = () => {
  const admin = getCurrentAdmin();
  const { data: returns = [], isLoading } = useAllReturns();
  const adjustStock = useAdjustStock();

  const [adminNote, setAdminNote] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const sendNotification = async (telegramUserId: number, status: Return['status'], orderId: string) => {
    const messages = TELEGRAM_STATUS_MESSAGES[status];
    try {
      // In-app notification
      await supabase.from('notifications').insert({
        telegram_user_id: telegramUserId,
        type: `return_${status}`,
        title: `Возврат заказа #${orderId.slice(0, 8).toUpperCase()}`,
        body: messages.ru,
        data: { return_id: orderId, status },
      });

      // Send via Telegram bot if available
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      await fetch(`${supabaseUrl}/functions/v1/send-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
          'Apikey': anonKey,
        },
        body: JSON.stringify({
          telegram_user_id: telegramUserId,
          message: `<b>📦 ${messages.ru}</b>\n\nЗаказ #${orderId.slice(0, 8).toUpperCase()}`,
          parse_mode: 'HTML',
        }),
      });
    } catch {
      // Non-critical - notification failed
    }
  };

  const handleStatusUpdate = async (id: string, status: Return['status']) => {
    const ret = returns.find(r => r.id === id);
    if (!ret) return;

    setProcessingId(id);
    try {
      // Use RPC function for status + stock handling
      const { error: rpcError } = await supabase.rpc('process_return_stock', {
        p_return_id: id,
        p_status: status,
        p_admin_note: adminNote || null,
      });

      if (rpcError) throw rpcError;

      toast.success(`Статус: ${STATUS_LABELS[status]}`);

      // Send notifications
      await sendNotification(ret.telegram_user_id, status, ret.order_id);

      auditLogQueries.log({
        admin_id: admin?.id ?? 'unknown',
        action: 'status_change',
        entity_type: 'returns',
        entity_id: id,
        details: { new_status: status, admin_note: adminNote, order_id: ret.order_id },
      }).catch(() => {});

      setAdminNote('');
    } catch (err) {
      toast.error('Ошибка при обновлении статуса');
      console.error(err);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-surface-50 dark:bg-surface-900">
      <header className="sticky top-0 z-40 bg-white dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/admin/dashboard" className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <RotateCcw className="w-5 h-5 text-surface-900" />
          <h1 className="text-lg font-bold text-surface-900 dark:text-white">Возвраты</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-3">
        {isLoading ? (
          <div className="text-center py-12"><span className="w-8 h-8 border-4 border-surface-900 border-t-transparent rounded-full animate-spin" /></div>
        ) : returns.length === 0 ? (
          <div className="text-center py-12">
            <RotateCcw className="w-10 h-10 text-surface-300 mx-auto mb-3" />
            <p className="text-sm text-surface-500">Нет заявок на возврат</p>
          </div>
        ) : (
          returns.map((ret) => {
            const items = Array.isArray(ret.items) ? ret.items : [];
            const totalRefund = items.reduce((sum: number, item: { price?: number; quantity?: number }) =>
              sum + (item.price || 0) * (item.quantity || 1), 0);

            return (
              <div key={ret.id} className="bg-white dark:bg-surface-800 rounded-2xl p-4 border border-surface-200 dark:border-surface-700">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-surface-900 dark:text-white">
                      Заказ #{ret.order_id.slice(0, 8).toUpperCase()}
                    </p>
                    <p className="text-xs text-surface-500 mt-0.5">
                      Клиент ID: {ret.telegram_user_id}
                    </p>
                    <p className="text-xs text-surface-400 mt-0.5">
                      {new Date(ret.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${STATUS_COLORS[ret.status as Return["status"]]}`}>
                      {STATUS_LABELS[ret.status as Return["status"]]}
                    </span>
                    <p className="text-sm font-bold text-surface-900 dark:text-white mt-1">
                      {formatPrice(totalRefund)}
                    </p>
                  </div>
                </div>

                <p className="text-sm text-surface-700 dark:text-surface-300 mb-3">
                  <span className="text-surface-500 font-medium">Причина:</span> {ret.reason}
                </p>

                {/* Items being returned */}
                {items.length > 0 && (
                  <div className="mb-3 bg-surface-50 dark:bg-surface-700/50 rounded-xl p-3">
                    <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                      <Package className="w-3 h-3" />
                      Товары к возврату
                    </p>
                    <div className="space-y-2">
                      {items.map((item: { name?: string; productId?: string; quantity?: number; price?: number }, i: number) => (
                        <div key={i} className="flex justify-between text-sm">
                          <span className="text-surface-700 dark:text-surface-300">
                            {item.name || 'Товар'}
                            {' '}× {item.quantity || 1}
                          </span>
                          <span className="font-medium text-surface-900 dark:text-white">
                            {formatPrice((item.price || 0) * (item.quantity || 1))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Photos from customer */}
                {Array.isArray((ret as Return & { photos?: string[] }).photos) && ((ret as Return & { photos?: string[] }).photos ?? []).length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs text-surface-500 mb-1.5">Фото от клиента:</p>
                    <div className="flex gap-2 flex-wrap">
                      {((ret as Return & { photos?: string[] }).photos ?? []).map((url: string, i: number) => (
                        <button
                          key={i}
                          onClick={() => setLightboxUrl(url)}
                          className="relative w-16 h-16 rounded-xl overflow-hidden border border-surface-200 dark:border-surface-600 group"
                        >
                          <img src={url} alt="" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                            <ZoomIn className="w-4 h-4 text-white" />
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {ret.admin_note && (
                  <p className="text-xs text-surface-500 mb-2 italic">Комментарий: {ret.admin_note}</p>
                )}

                {ret.status === 'pending' && (
                  <div className="space-y-3 mt-3">
                    <textarea
                      value={adminNote}
                      onChange={(e) => setAdminNote(e.target.value)}
                      placeholder="Комментарий для клиента..."
                      rows={2}
                      className="w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-700 text-sm resize-none focus:ring-2 focus:ring-surface-900 outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleStatusUpdate(ret.id, 'approved')}
                        disabled={processingId === ret.id}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" />
                        Одобрить
                      </button>
                      <button
                        onClick={() => handleStatusUpdate(ret.id, 'rejected')}
                        disabled={processingId === ret.id}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition disabled:opacity-50"
                      >
                        <X className="w-4 h-4" />
                        Отклонить
                      </button>
                    </div>
                  </div>
                )}

                {ret.status === 'approved' && (
                  <button
                    onClick={() => handleStatusUpdate(ret.id, 'refunded')}
                    disabled={processingId === ret.id}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition mt-3 disabled:opacity-50"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Товар получен — завершить возврат
                  </button>
                )}
              </div>
            );
          })
        )}
      </main>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <img src={lightboxUrl} alt="" className="max-w-full max-h-full rounded-xl object-contain" />
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
};

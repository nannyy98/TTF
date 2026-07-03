/*
  # Fix append_order_status to accept uuid parameter
  
  The function was accepting text but orders.id is uuid.
  This caused "operator does not exist: uuid = text" error.
*/

CREATE OR REPLACE FUNCTION append_order_status(
  p_order_id uuid,
  p_status text,
  p_changed_by text DEFAULT 'Admin',
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_result jsonb;
  v_should_archive boolean := false;
  v_should_return_stock boolean := false;
  v_order RECORD;
  v_item jsonb;
  v_items_array jsonb;
BEGIN
  -- Get current order info
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- Determine if order should be archived (hidden from client)
  IF p_status IN ('cancelled', 'delivered', 'returned') THEN
    v_should_archive := true;
  END IF;

  -- Return stock on cancellation (if was not already cancelled)
  IF p_status = 'cancelled' AND v_order.status != 'cancelled' THEN
    v_should_return_stock := true;
  END IF;

  -- Parse items
  IF jsonb_typeof(v_order.items) = 'string' THEN
    v_items_array := v_order.items::text::jsonb;
  ELSE
    v_items_array := v_order.items;
  END IF;

  -- Return items to stock if needed
  IF v_should_return_stock THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items_array)
    LOOP
      UPDATE products
      SET stock = stock + COALESCE((v_item->>'quantity')::int, 1),
          updated_at = now()
      WHERE id = (v_item->>'productId')::uuid;
    END LOOP;
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
    'telegram_user_id', telegram_user_id,
    'items', items
  ) INTO v_result;

  RETURN v_result;
END;
$$;
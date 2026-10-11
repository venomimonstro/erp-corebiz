BEGIN;
-- Minimal application runtime grants for the new commerce schema.
-- Access is additionally restricted by per-table tenant RLS. Never grant
-- BYPASSRLS, table ownership or DDL to runtime role.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE
      commerce_merchant_config,
      commerce_delivery_method,
      commerce_order_delivery,
      commerce_payment_intent,
      commerce_refund
    TO corebiz_app;
    GRANT SELECT,INSERT ON TABLE commerce_provider_event TO corebiz_app;
  ELSE
    RAISE WARNING 'corebiz_app does not exist: provision runtime role and apply reviewed commerce table grants before launch';
  END IF;
END $$;
COMMIT;

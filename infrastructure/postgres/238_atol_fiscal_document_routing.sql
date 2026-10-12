BEGIN;
-- Routing is explicit and snapshotted PER INTENT. Existing merchants keep
-- YooKassa receipts; never silently issue a second ATOL receipt.
ALTER TABLE commerce_merchant_config ADD COLUMN fiscal_provider text
 NOT NULL DEFAULT 'YOOKASSA'
 CHECK(fiscal_provider IN ('YOOKASSA','ATOL_ONLINE'));
ALTER TABLE commerce_payment_intent ADD COLUMN fiscal_provider text
 NOT NULL DEFAULT 'YOOKASSA'
 CHECK(fiscal_provider IN ('YOOKASSA','ATOL_ONLINE'));
CREATE INDEX commerce_fiscal_unconfirmed_idx
 ON commerce_payment_intent(tenant_id,site_id,updated_at)
 WHERE purpose='STOREFRONT' AND fiscal_provider='ATOL_ONLINE'
   AND status='SUCCEEDED' AND fiscal_status<>'SUCCEEDED';

CREATE TABLE commerce_fiscal_document(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 site_id uuid NOT NULL REFERENCES site(id) ON DELETE RESTRICT,
 payment_intent_id uuid NOT NULL REFERENCES commerce_payment_intent(id) ON DELETE RESTRICT,
 connector_id uuid NOT NULL REFERENCES commerce_provider_connection(id) ON DELETE RESTRICT,
 operation text NOT NULL CHECK(operation IN ('sell')),
 provider text NOT NULL DEFAULT 'ATOL_ONLINE' CHECK(provider='ATOL_ONLINE'),
 environment text NOT NULL CHECK(environment IN ('SANDBOX','PRODUCTION')),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 8 AND 128),
 provider_uuid uuid,
 payload_digest char(64) NOT NULL,
 state text NOT NULL DEFAULT 'SENDING'
   CHECK(state IN ('SENDING','UNKNOWN','WAIT','DONE','FAIL')),
 fn_number text,
 fiscal_document_number bigint,
 fiscal_document_attribute text,
 receipt_url text,
 last_error_code text,
 submitted_at timestamptz,
 verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,payment_intent_id,operation),
 UNIQUE(tenant_id,external_id),
 UNIQUE(provider_uuid),
 UNIQUE(tenant_id,id)
);
CREATE INDEX commerce_fiscal_unsettled_idx
 ON commerce_fiscal_document(tenant_id,state,created_at DESC)
 WHERE state IN ('SENDING','UNKNOWN','WAIT','FAIL');
ALTER TABLE commerce_fiscal_document ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_fiscal_document_tenant ON commerce_fiscal_document
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT SELECT,INSERT,UPDATE ON commerce_fiscal_document TO corebiz_app;
 END IF;
END $$;
COMMIT;

BEGIN;
CREATE TABLE tenant_analytics_snapshot (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 metric_date date NOT NULL,
 metric_code text NOT NULL CHECK(metric_code IN ('PAYMENTS_IN','PAYMENTS_OUT','AR_OPEN','AP_OPEN','BANK_UNMATCHED')),
 currency char(3) NOT NULL DEFAULT 'RUB',
 value_minor bigint NOT NULL,
 source_updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,metric_date,metric_code,currency)
);
ALTER TABLE tenant_analytics_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_analytics_snapshot_isolation ON tenant_analytics_snapshot
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;
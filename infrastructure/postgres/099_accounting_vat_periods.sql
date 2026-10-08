BEGIN;
CREATE TABLE accounting_vat_period (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 legal_entity_id uuid NOT NULL REFERENCES legal_entity(id),
 date_from date NOT NULL,
 date_to date NOT NULL,
 state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','CLOSED')),
 closed_at timestamptz,
 closed_by_membership_id uuid REFERENCES tenant_membership(id),
 close_reason text,
 CHECK (date_from <= date_to),
 UNIQUE (tenant_id, legal_entity_id, date_from, date_to)
);
ALTER TABLE accounting_vat_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_vat_period_isolation ON accounting_vat_period
 USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
COMMIT;
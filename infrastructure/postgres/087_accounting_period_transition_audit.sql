-- Sprint 51: audit transitions of accounting periods.
BEGIN;
CREATE TABLE accounting_period_transition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 period_id uuid NOT NULL,
 from_state text NOT NULL,
 to_state text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=8),
 actor_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
 changed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,period_id) REFERENCES accounting_period(tenant_id,id)
);
CREATE INDEX accounting_period_transition_period_idx
 ON accounting_period_transition(tenant_id,period_id,changed_at DESC);
ALTER TABLE accounting_period_transition ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_period_transition_isolation ON accounting_period_transition
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE OR REPLACE FUNCTION corebiz_accounting_period_transition_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Accounting period transition audit cannot be modified' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER accounting_period_transition_immutable_v1
 BEFORE UPDATE OR DELETE ON accounting_period_transition
 FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_period_transition_immutable();
COMMIT;

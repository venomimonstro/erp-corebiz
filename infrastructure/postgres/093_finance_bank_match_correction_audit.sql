-- Sprint 52e: audited bank-match correction; no mutation of payment ledger.
BEGIN;
CREATE TABLE finance_bank_match_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 bank_line_id uuid NOT NULL REFERENCES finance_bank_statement_line(id) ON DELETE RESTRICT,
 old_payment_id uuid NOT NULL REFERENCES payment(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason))>=12),
 actor_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_bank_match_audit_line_idx
 ON finance_bank_match_audit(tenant_id,bank_line_id,changed_at DESC);
ALTER TABLE finance_bank_match_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_bank_match_audit_isolation ON finance_bank_match_audit
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE OR REPLACE FUNCTION corebiz_bank_match_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Bank match audit is immutable' USING ERRCODE='23514';
END;$$;
CREATE TRIGGER finance_bank_match_audit_immutable_v1
 BEFORE UPDATE OR DELETE ON finance_bank_match_audit
 FOR EACH ROW EXECUTE FUNCTION corebiz_bank_match_audit_immutable();

CREATE OR REPLACE FUNCTION corebiz_bank_line_match_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 v_actor uuid;
 v_reason text;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Bank statement line deletion is forbidden' USING ERRCODE='23514';
 END IF;
 IF (to_jsonb(NEW)-'payment_id') IS DISTINCT FROM (to_jsonb(OLD)-'payment_id') THEN
  RAISE EXCEPTION 'Imported bank statement line is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
  IF NEW.payment_id IS NOT NULL THEN
   RAISE EXCEPTION 'Unmatch first; direct bank match replacement forbidden' USING ERRCODE='23514';
  END IF;
  v_reason:=nullif(btrim(current_setting('app.bank_unmatch_reason',true)),'');
  v_actor:=nullif(current_setting('app.bank_unmatch_actor',true),'')::uuid;
  IF v_actor IS NULL OR v_reason IS NULL OR length(v_reason)<12 THEN
   RAISE EXCEPTION 'Bank unmatch requires an actor and reason' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
   SELECT 1 FROM tenant_membership m WHERE m.id=v_actor AND m.tenant_id=NEW.tenant_id
  ) THEN
   RAISE EXCEPTION 'Bank correction actor tenant mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
   SELECT 1 FROM finance_bank_statement s
   WHERE s.id=NEW.statement_id AND s.tenant_id=NEW.tenant_id AND s.status='IMPORTED'
   FOR UPDATE
  ) THEN
   RAISE EXCEPTION 'Finalized bank statement correction forbidden' USING ERRCODE='23514';
  END IF;
  INSERT INTO finance_bank_match_audit(
   tenant_id,bank_line_id,old_payment_id,reason,actor_membership_id
  ) VALUES(NEW.tenant_id,OLD.id,OLD.payment_id,v_reason,v_actor);
 END IF;
 RETURN NEW;
END;$$;
COMMIT;

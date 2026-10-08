-- Sprint 52a: read-only bank feed staging; never post bank imports directly to cash ledger.
BEGIN;
CREATE TABLE finance_bank_statement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 cash_account_id uuid NOT NULL REFERENCES cash_account(id) ON DELETE RESTRICT,
 source_name text NOT NULL CHECK(length(btrim(source_name))>0),
 external_statement_id text NOT NULL CHECK(length(btrim(external_statement_id))>0),
 currency char(3) NOT NULL,
 date_from date NOT NULL,
 date_to date NOT NULL,
 imported_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
 imported_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'IMPORTED' CHECK(status IN ('IMPORTED','RECONCILED','REJECTED')),
 CHECK(date_from<=date_to),
 UNIQUE(tenant_id,cash_account_id,source_name,external_statement_id),
 UNIQUE(tenant_id,id)
);
CREATE TABLE finance_bank_statement_line (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 statement_id uuid NOT NULL,
 external_line_id text NOT NULL CHECK(length(btrim(external_line_id))>0),
 booked_on date NOT NULL,
 direction text NOT NULL CHECK(direction IN ('IN','OUT')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 counterparty_name text,
 purpose text,
 payment_id uuid REFERENCES payment(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,statement_id) REFERENCES finance_bank_statement(tenant_id,id),
 UNIQUE(tenant_id,statement_id,external_line_id)
);
CREATE INDEX finance_bank_unmatched_idx
 ON finance_bank_statement_line(tenant_id,statement_id,booked_on)
 WHERE payment_id IS NULL;
CREATE OR REPLACE FUNCTION corebiz_validate_bank_statement()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM cash_account a
  WHERE a.id=NEW.cash_account_id AND a.tenant_id=NEW.tenant_id AND a.currency=NEW.currency
 ) THEN
  RAISE EXCEPTION 'Bank statement account currency/tenant mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER finance_bank_statement_validate_v1
 BEFORE INSERT OR UPDATE OF cash_account_id,tenant_id,currency ON finance_bank_statement
 FOR EACH ROW EXECUTE FUNCTION corebiz_validate_bank_statement();

CREATE OR REPLACE FUNCTION corebiz_validate_bank_statement_line()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM finance_bank_statement s
  WHERE s.id=NEW.statement_id AND s.tenant_id=NEW.tenant_id
    AND NEW.booked_on BETWEEN s.date_from AND s.date_to
 ) THEN
  RAISE EXCEPTION 'Bank line outside statement period/tenant' USING ERRCODE='23514';
 END IF;
 IF NEW.payment_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM payment p
  JOIN finance_bank_statement s ON s.id=NEW.statement_id AND s.tenant_id=NEW.tenant_id
  WHERE p.id=NEW.payment_id AND p.tenant_id=NEW.tenant_id
    AND p.cash_account_id=s.cash_account_id
    AND p.currency=s.currency AND p.direction=NEW.direction
    AND p.amount_minor=NEW.amount_minor AND p.status='POSTED'
 ) THEN
   RAISE EXCEPTION 'Bank line payment reconciliation mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER finance_bank_statement_line_validate_v1
 BEFORE INSERT OR UPDATE ON finance_bank_statement_line
 FOR EACH ROW EXECUTE FUNCTION corebiz_validate_bank_statement_line();

DO $$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['finance_bank_statement','finance_bank_statement_line'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format(
   'CREATE POLICY %I ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',
   name||'_isolation',name);
 END LOOP;
END;$$;
COMMIT;

-- Sprint 51a — Accounting RU foundation. No automatic statutory posting.
BEGIN;

CREATE TABLE accounting_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 32),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  category text NOT NULL CHECK (category IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE','OFF_BALANCE')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,code),
  UNIQUE(tenant_id,id)
);

CREATE TABLE accounting_period (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE RESTRICT,
  date_from date NOT NULL,
  date_to date NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','SOFT_LOCKED','HARD_LOCKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(date_from<=date_to),
  UNIQUE(tenant_id,legal_entity_id,date_from,date_to),
  UNIQUE(tenant_id,id)
);

CREATE TABLE accounting_journal_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE RESTRICT,
  period_id uuid NOT NULL,
  business_date date NOT NULL,
  source_type text NOT NULL CHECK(length(btrim(source_type))>0),
  source_id uuid NOT NULL,
  posting_key text NOT NULL CHECK(length(btrim(posting_key))>0),
  rule_code text NOT NULL CHECK(length(btrim(rule_code))>0),
  rule_version integer NOT NULL CHECK(rule_version>0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  debit_account_id uuid NOT NULL,
  credit_account_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  reversal_of_id uuid REFERENCES accounting_journal_entry(id) ON DELETE RESTRICT,
  posted_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,posting_key),
  UNIQUE(tenant_id,reversal_of_id),
  FOREIGN KEY (tenant_id,period_id) REFERENCES accounting_period(tenant_id,id),
  FOREIGN KEY (tenant_id,debit_account_id) REFERENCES accounting_account(tenant_id,id),
  FOREIGN KEY (tenant_id,credit_account_id) REFERENCES accounting_account(tenant_id,id),
  CHECK(debit_account_id<>credit_account_id)
);

CREATE INDEX accounting_journal_trial_balance_idx
 ON accounting_journal_entry(tenant_id,legal_entity_id,business_date,debit_account_id,credit_account_id);

CREATE OR REPLACE FUNCTION corebiz_accounting_validate_entry()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM legal_entity l WHERE l.id=NEW.legal_entity_id
    AND l.tenant_id=NEW.tenant_id
 ) THEN
   RAISE EXCEPTION 'Accounting legal entity tenant mismatch' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(
   SELECT 1 FROM accounting_period p
   WHERE p.id=NEW.period_id AND p.tenant_id=NEW.tenant_id
     AND p.legal_entity_id=NEW.legal_entity_id
     AND p.state='OPEN'
     AND NEW.business_date BETWEEN p.date_from AND p.date_to
   FOR UPDATE
 ) THEN
   RAISE EXCEPTION 'Accounting period locked or business date outside period'
     USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(
   SELECT 1 FROM accounting_account a
   WHERE a.id=NEW.debit_account_id AND a.tenant_id=NEW.tenant_id AND a.active
 ) OR NOT EXISTS (
   SELECT 1 FROM accounting_account a
   WHERE a.id=NEW.credit_account_id AND a.tenant_id=NEW.tenant_id AND a.active
 ) THEN
   RAISE EXCEPTION 'Accounting account inactive or outside tenant' USING ERRCODE='23514';
 END IF;
 IF NEW.reversal_of_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM accounting_journal_entry prior
    WHERE prior.id=NEW.reversal_of_id AND prior.tenant_id=NEW.tenant_id
      AND prior.legal_entity_id=NEW.legal_entity_id
      AND prior.debit_account_id=NEW.credit_account_id
      AND prior.credit_account_id=NEW.debit_account_id
      AND prior.amount_minor=NEW.amount_minor
      AND prior.currency=NEW.currency
 ) THEN
   RAISE EXCEPTION 'Reversal must mirror original entry' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_accounting_entry_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Accounting posting is immutable: create a reversal'
   USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER accounting_entry_validate_v1
BEFORE INSERT ON accounting_journal_entry
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_validate_entry();

CREATE TRIGGER accounting_entry_immutable_v1
BEFORE UPDATE OR DELETE ON accounting_journal_entry
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_entry_immutable();

DO $$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['accounting_account','accounting_period','accounting_journal_entry'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format(
    'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',
    tbl||'_isolation',tbl);
 END LOOP;
END;
$$;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,p.permission_code,'all'
FROM tenant_role r
CROSS JOIN (VALUES ('accounting.read'),('accounting.post'),('accounting.reverse'),('accounting.period.close')) AS p(permission_code)
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;

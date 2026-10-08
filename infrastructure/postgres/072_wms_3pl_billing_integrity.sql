BEGIN;

ALTER TABLE wms_3pl_statement_line
  ADD COLUMN IF NOT EXISTS service_period_from date,
  ADD COLUMN IF NOT EXISTS service_period_to date;

UPDATE wms_3pl_statement_line l
SET service_period_from=s.period_from,
    service_period_to=s.period_to
FROM wms_3pl_statement s
WHERE s.id=l.statement_id
  AND s.tenant_id=l.tenant_id
  AND (l.service_period_from IS NULL OR l.service_period_to IS NULL);

ALTER TABLE wms_3pl_statement_line
  ALTER COLUMN service_period_from SET NOT NULL,
  ALTER COLUMN service_period_to SET NOT NULL;

ALTER TABLE wms_3pl_statement_line
  ADD CONSTRAINT wms_3pl_statement_line_period_check
  CHECK (service_period_to >= service_period_from);

DROP INDEX IF EXISTS wms_3pl_statement_line_rate_uq;
CREATE UNIQUE INDEX wms_3pl_statement_line_period_uq
  ON wms_3pl_statement_line(
    statement_id,service_code,service_period_from,service_period_to
  );

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM warehouse_3pl_contract c
    WHERE c.id=NEW.contract_id
      AND c.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION '3PL rate contract/tenant mismatch'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wms_3pl_rate r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.contract_id=NEW.contract_id
      AND r.service_code=NEW.service_code
      AND r.id<>COALESCE(NEW.id,'00000000-0000-0000-0000-000000000000'::uuid)
      AND daterange(
        r.effective_from,
        COALESCE(r.effective_to,'infinity'::date),
        '[]'
      ) && daterange(
        NEW.effective_from,
        COALESCE(NEW.effective_to,'infinity'::date),
        '[]'
      )
  ) THEN
    RAISE EXCEPTION 'Overlapping 3PL rate period'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_3pl_rate_v1 ON wms_3pl_rate;
CREATE TRIGGER validate_3pl_rate_v1
BEFORE INSERT OR UPDATE OF
  tenant_id,contract_id,service_code,effective_from,effective_to
ON wms_3pl_rate
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_rate();

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_statement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM warehouse_3pl_contract c
    WHERE c.id=NEW.contract_id
      AND c.tenant_id=NEW.tenant_id
      AND c.warehouse_id=NEW.warehouse_id
      AND c.owner_id=NEW.owner_id
  ) THEN
    RAISE EXCEPTION '3PL statement contract dimensions mismatch'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='FINALIZED' THEN
    RAISE EXCEPTION 'Finalized 3PL statement is immutable'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_3pl_statement_v1 ON wms_3pl_statement;
CREATE TRIGGER validate_3pl_statement_v1
BEFORE INSERT OR UPDATE ON wms_3pl_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_statement();

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_statement_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_contract_id uuid;
  v_currency char(3);
  v_period_from date;
  v_period_to date;
BEGIN
  SELECT contract_id,currency,period_from,period_to
  INTO v_contract_id,v_currency,v_period_from,v_period_to
  FROM wms_3pl_statement
  WHERE id=NEW.statement_id
    AND tenant_id=NEW.tenant_id;

  IF v_contract_id IS NULL THEN
    RAISE EXCEPTION '3PL statement line statement/tenant mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.currency IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION '3PL statement line currency mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.service_period_from < v_period_from
     OR NEW.service_period_to > v_period_to
  THEN
    RAISE EXCEPTION '3PL statement line period outside statement'
      USING ERRCODE='23514';
  END IF;

  IF NEW.rate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM wms_3pl_rate r
    WHERE r.id=NEW.rate_id
      AND r.tenant_id=NEW.tenant_id
      AND r.contract_id=v_contract_id
      AND r.service_code=NEW.service_code
      AND r.currency=NEW.currency
      AND r.rate_minor=NEW.rate_minor
      AND r.effective_from<=NEW.service_period_from
      AND COALESCE(r.effective_to,'infinity'::date)>=NEW.service_period_to
  ) THEN
    RAISE EXCEPTION '3PL statement rate snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_3pl_statement_line_v1
  ON wms_3pl_statement_line;
CREATE TRIGGER validate_3pl_statement_line_v1
BEFORE INSERT OR UPDATE ON wms_3pl_statement_line
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_statement_line();

COMMIT;

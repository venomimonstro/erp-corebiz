BEGIN;

CREATE OR REPLACE FUNCTION corebiz_room_rental_statement_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.status='FINALIZED' THEN
    RAISE EXCEPTION 'Finalized room rental statement is immutable'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='FINALIZED' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.contract_id IS DISTINCT FROM OLD.contract_id OR
    NEW.period_from IS DISTINCT FROM OLD.period_from OR
    NEW.period_to IS DISTINCT FROM OLD.period_to OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR
    NEW.lesson_count IS DISTINCT FROM OLD.lesson_count OR
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR
    NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot
  ) THEN
    RAISE EXCEPTION 'Finalized room rental statement is immutable'
      USING ERRCODE='23514';
  END IF;

  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS room_rental_statement_immutable_v1
  ON room_rental_statement;
CREATE TRIGGER room_rental_statement_immutable_v1
BEFORE UPDATE OR DELETE ON room_rental_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_room_rental_statement_immutable();

COMMIT;

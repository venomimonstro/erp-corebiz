BEGIN;

-- Different internal warehouses and SKU mappings must never overwrite the same
-- provider stock cell (seller account + provider warehouse + size/offer).
CREATE UNIQUE INDEX IF NOT EXISTS channel_stock_listing_remote_cell_uq
ON channel_stock_listing(
  tenant_id,connection_id,external_warehouse_id,
  coalesce(external_stock_id,mapping_id::text)
)
WHERE external_warehouse_id IS NOT NULL;

-- Database-level last line of defence; the API already checks this, but
-- imports and parallel workers must be unable to alter a finalized period.
CREATE OR REPLACE FUNCTION corebiz_guard_closed_project_period()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_day date;
DECLARE v_old_day date;
DECLARE v_tenant uuid;
DECLARE v_project uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.project_id IS DISTINCT FROM NEW.project_id OR
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Project accounting entries cannot be reassigned'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    v_tenant:=OLD.tenant_id;
    v_project:=OLD.project_id;
    IF TG_TABLE_NAME='work_project_time_entry' THEN
      v_day:=OLD.work_date;
    ELSE
      v_day:=OLD.expense_on;
    END IF;
  ELSE
    v_tenant:=NEW.tenant_id;
    v_project:=NEW.project_id;
    IF TG_TABLE_NAME='work_project_time_entry' THEN
      v_day:=NEW.work_date;
      IF TG_OP='UPDATE' THEN v_old_day:=OLD.work_date; END IF;
    ELSE
      v_day:=NEW.expense_on;
      IF TG_OP='UPDATE' THEN v_old_day:=OLD.expense_on; END IF;
    END IF;
  END IF;
  -- Shares a serialization barrier with monthly close.
  PERFORM 1 FROM work_project p
  WHERE p.tenant_id=v_tenant AND p.id=v_project FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown project' USING ERRCODE='23503';
  END IF;
  IF EXISTS(
    SELECT 1 FROM work_project_monthly_statement s
    WHERE s.tenant_id=v_tenant AND s.project_id=v_project
      AND s.status IN ('FINALIZED','INVOICED','PAID')
      AND (s.period_key=to_char(v_day,'YYYY-MM')
        OR (v_old_day IS NOT NULL AND s.period_key=to_char(v_old_day,'YYYY-MM')))
  ) THEN
    RAISE EXCEPTION 'Project period closed: no changes to time or expense'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER work_project_expense_closed_period
BEFORE INSERT OR UPDATE OR DELETE
ON work_project_expense FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_closed_project_period();

CREATE TRIGGER work_project_time_closed_period
BEFORE INSERT OR UPDATE OR DELETE
ON work_project_time_entry FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_closed_project_period();

COMMIT;
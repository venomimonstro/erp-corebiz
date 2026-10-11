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
BEGIN
  IF TG_TABLE_NAME='work_project_time_entry' THEN
    v_day:=NEW.work_date;
  ELSE
    v_day:=NEW.expense_on;
  END IF;
  -- Shares a serialization barrier with monthly close.
  PERFORM 1 FROM work_project p
  WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown project' USING ERRCODE='23503';
  END IF;
  IF EXISTS(
    SELECT 1 FROM work_project_monthly_statement s
    WHERE s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id
      AND s.period_key=to_char(v_day,'YYYY-MM')
      AND s.status IN ('FINALIZED','INVOICED','PAID')
  ) THEN
    RAISE EXCEPTION 'Project period closed: no backdated time or expense'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER work_project_expense_closed_period
BEFORE INSERT OR UPDATE OF expense_on,amount_minor,project_id
ON work_project_expense FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_closed_project_period();

CREATE TRIGGER work_project_time_closed_period
BEFORE INSERT OR UPDATE OF work_date,minutes,billable,project_id
ON work_project_time_entry FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_closed_project_period();

COMMIT;
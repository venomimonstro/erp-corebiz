BEGIN;
-- A project statement is the source of exactly one finance invoice, never a
-- re-calculated payment amount. Client media budgets are NOT agency revenue.
ALTER TABLE finance_invoice DROP CONSTRAINT IF EXISTS finance_invoice_source_type_check;
ALTER TABLE finance_invoice ADD CONSTRAINT finance_invoice_source_type_check
  CHECK(source_type IN ('WMS_3PL_STATEMENT','AGENCY_PROJECT_STATEMENT'));

CREATE OR REPLACE FUNCTION corebiz_validate_finance_invoice()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM financial_obligation o
    WHERE o.id=NEW.obligation_id AND o.tenant_id=NEW.tenant_id
      AND o.direction='RECEIVABLE' AND o.party_id=NEW.party_id
      AND o.source_type=NEW.source_type AND o.source_id=NEW.source_id
      AND o.currency=NEW.currency AND o.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Invoice obligation snapshot mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='WMS_3PL_STATEMENT' AND NOT EXISTS (
    SELECT 1 FROM wms_3pl_statement s
    JOIN inventory_owner io ON io.tenant_id=s.tenant_id AND io.id=s.owner_id
    WHERE s.id=NEW.source_id AND s.tenant_id=NEW.tenant_id
      AND s.status='FINALIZED' AND io.owner_type='CLIENT'
      AND io.party_id=NEW.party_id AND s.currency=NEW.currency
      AND s.total_minor=NEW.amount_minor
      AND s.period_from IS NOT DISTINCT FROM NEW.period_from
      AND s.period_to IS NOT DISTINCT FROM NEW.period_to
  ) THEN
    RAISE EXCEPTION 'Invoice 3PL statement snapshot mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='AGENCY_PROJECT_STATEMENT' AND NOT EXISTS (
    SELECT 1 FROM work_project_monthly_statement s
    JOIN work_project p ON p.tenant_id=s.tenant_id AND p.id=s.project_id
    WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.source_id
      AND s.status IN ('FINALIZED','INVOICED','PAID')
      AND s.service_revenue_minor=NEW.amount_minor AND s.service_revenue_minor>0
      AND p.party_id=NEW.party_id AND p.currency=NEW.currency
      AND s.period_from IS NOT DISTINCT FROM NEW.period_from
      AND s.period_to IS NOT DISTINCT FROM NEW.period_to
  ) THEN
    RAISE EXCEPTION 'Invoice agency statement snapshot mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.business_number IS DISTINCT FROM OLD.business_number OR
    NEW.party_id IS DISTINCT FROM OLD.party_id OR
    NEW.source_type IS DISTINCT FROM OLD.source_type OR
    NEW.source_id IS DISTINCT FROM OLD.source_id OR
    NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR
    NEW.period_from IS DISTINCT FROM OLD.period_from OR
    NEW.period_to IS DISTINCT FROM OLD.period_to OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
  ) THEN
    RAISE EXCEPTION 'Issued invoice snapshot fields are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION corebiz_agency_statement_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.status IN ('FINALIZED','INVOICED','PAID') AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.project_id IS DISTINCT FROM OLD.project_id OR
    NEW.period_key IS DISTINCT FROM OLD.period_key OR
    NEW.period_from IS DISTINCT FROM OLD.period_from OR
    NEW.period_to IS DISTINCT FROM OLD.period_to OR
    NEW.service_revenue_minor IS DISTINCT FROM OLD.service_revenue_minor OR
    NEW.media_budget_minor IS DISTINCT FROM OLD.media_budget_minor OR
    NEW.labor_cost_minor IS DISTINCT FROM OLD.labor_cost_minor OR
    NEW.other_cost_minor IS DISTINCT FROM OLD.other_cost_minor OR
    NEW.gross_margin_minor IS DISTINCT FROM OLD.gross_margin_minor OR
    NEW.margin_bps IS DISTINCT FROM OLD.margin_bps OR
    NEW.billable_minutes IS DISTINCT FROM OLD.billable_minutes OR
    NEW.snapshot IS DISTINCT FROM OLD.snapshot OR
    NOT (
      NEW.status=OLD.status OR
      (OLD.status='FINALIZED' AND NEW.status='INVOICED') OR
      (OLD.status='INVOICED' AND NEW.status='PAID')
    )
  ) THEN
    RAISE EXCEPTION 'Finalized agency statement is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS agency_statement_guard_v1 ON work_project_monthly_statement;
CREATE TRIGGER agency_statement_guard_v1 BEFORE UPDATE
ON work_project_monthly_statement FOR EACH ROW
EXECUTE FUNCTION corebiz_agency_statement_guard();

CREATE OR REPLACE FUNCTION corebiz_sync_agency_statement_payment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.source_type='AGENCY_PROJECT_STATEMENT' AND NEW.status='PAID' THEN
    UPDATE work_project_monthly_statement
       SET status='PAID',updated_at=now()
     WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id AND status='INVOICED';
  END IF;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS sync_agency_statement_payment_v1 ON finance_invoice;
CREATE TRIGGER sync_agency_statement_payment_v1 AFTER UPDATE OF status ON finance_invoice
FOR EACH ROW EXECUTE FUNCTION corebiz_sync_agency_statement_payment();
COMMIT;
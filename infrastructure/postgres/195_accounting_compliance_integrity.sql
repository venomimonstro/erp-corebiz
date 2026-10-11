BEGIN;

-- Cross-tenant references on the compliance/tax layer must fail closed.
DROP TRIGGER IF EXISTS accounting_tax_profile_tenant_refs_v2
  ON accounting_tax_profile;
CREATE TRIGGER accounting_tax_profile_tenant_refs_v2
BEFORE INSERT OR UPDATE ON accounting_tax_profile
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'created_by_membership_id','tenant_membership',
  'updated_by_membership_id','tenant_membership'
);

DROP TRIGGER IF EXISTS accounting_compliance_obligation_tenant_refs_v2
  ON accounting_compliance_obligation;
CREATE TRIGGER accounting_compliance_obligation_tenant_refs_v2
BEFORE INSERT OR UPDATE ON accounting_compliance_obligation
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'tax_profile_id','accounting_tax_profile',
  'payment_obligation_id','financial_obligation',
  'packet_id','accounting_compliance_packet',
  'approved_by_membership_id','tenant_membership'
);

DROP TRIGGER IF EXISTS accounting_compliance_event_tenant_refs_v1
  ON accounting_compliance_event;
CREATE TRIGGER accounting_compliance_event_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_compliance_event
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'obligation_id','accounting_compliance_obligation',
  'actor_membership_id','tenant_membership'
);

DROP TRIGGER IF EXISTS accounting_reporting_connector_tenant_refs_v2
  ON accounting_reporting_connector;
CREATE TRIGGER accounting_reporting_connector_tenant_refs_v2
BEFORE INSERT OR UPDATE ON accounting_reporting_connector
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity'
);

DROP TRIGGER IF EXISTS accounting_compliance_packet_tenant_refs_v1
  ON accounting_compliance_packet;
CREATE TRIGGER accounting_compliance_packet_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_compliance_packet
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'obligation_id','accounting_compliance_obligation',
  'signed_by_membership_id','tenant_membership',
  'created_by_membership_id','tenant_membership'
);

DROP TRIGGER IF EXISTS accounting_compliance_receipt_tenant_refs_v1
  ON accounting_compliance_receipt;
CREATE TRIGGER accounting_compliance_receipt_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_compliance_receipt
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'obligation_id','accounting_compliance_obligation'
);

DROP TRIGGER IF EXISTS cash_account_legal_entity_tenant_refs_v1
  ON cash_account;
CREATE TRIGGER cash_account_legal_entity_tenant_refs_v1
BEFORE INSERT OR UPDATE OF legal_entity_id ON cash_account
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity'
);

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE'
     AND NEW.workflow_status IS DISTINCT FROM OLD.workflow_status THEN
    IF NOT (
      (OLD.workflow_status='PLANNED'
        AND NEW.workflow_status IN ('READY','CANCELLED'))
      OR (OLD.workflow_status='READY'
        AND NEW.workflow_status IN ('APPROVED','CANCELLED'))
      OR (OLD.workflow_status='APPROVED'
        AND NEW.workflow_status IN ('SUBMITTED','PAID','CANCELLED'))
      OR (OLD.workflow_status='SUBMITTED'
        AND NEW.workflow_status IN ('ACCEPTED','REJECTED','PAID'))
      OR (OLD.workflow_status='REJECTED'
        AND NEW.workflow_status IN ('READY','CANCELLED'))
      OR (OLD.workflow_status=NEW.workflow_status)
    ) THEN
      RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_INVALID_TRANSITION'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_compliance_transition_guard_v1
  ON accounting_compliance_obligation;
CREATE TRIGGER accounting_compliance_transition_guard_v2
BEFORE UPDATE OF workflow_status
ON accounting_compliance_obligation
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_compliance_transition_guard();

COMMIT;

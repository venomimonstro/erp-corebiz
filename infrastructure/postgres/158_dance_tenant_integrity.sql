BEGIN;

CREATE OR REPLACE FUNCTION corebiz_guard_tenant_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  i integer := 0;
  ref_id uuid;
  ok boolean;
  payload jsonb := to_jsonb(NEW);
BEGIN
  IF mod(TG_NARGS,2) <> 0 THEN
    RAISE EXCEPTION 'corebiz_guard_tenant_references requires column/table pairs';
  END IF;

  WHILE i < TG_NARGS LOOP
    ref_id := nullif(payload ->> TG_ARGV[i], '')::uuid;
    IF ref_id IS NOT NULL THEN
      EXECUTE format(
        'SELECT EXISTS(SELECT 1 FROM %I WHERE tenant_id=$1 AND id=$2)',
        TG_ARGV[i+1]
      )
      INTO ok
      USING NEW.tenant_id, ref_id;

      IF NOT coalesce(ok,false) THEN
        RAISE EXCEPTION
          'Tenant reference mismatch on %.% -> %',
          TG_TABLE_NAME,TG_ARGV[i],TG_ARGV[i+1];
      END IF;
    END IF;
    i := i + 2;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_guard_tenant_references() FROM PUBLIC;

DROP TRIGGER IF EXISTS party_relationship_tenant_refs_v1 ON party_relationship;
CREATE TRIGGER party_relationship_tenant_refs_v1
BEFORE INSERT OR UPDATE ON party_relationship
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'from_party_id','party',
  'to_party_id','party'
);

DROP TRIGGER IF EXISTS dance_student_tenant_refs_v1 ON dance_student;
CREATE TRIGGER dance_student_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_student
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'party_id','party',
  'preferred_branch_id','branch'
);

DROP TRIGGER IF EXISTS dance_program_tenant_refs_v1 ON dance_program;
CREATE TRIGGER dance_program_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_program
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'branch_id','branch',
  'service_id','service_catalog_item'
);

DROP TRIGGER IF EXISTS dance_group_tenant_refs_v1 ON dance_group;
CREATE TRIGGER dance_group_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_group
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'program_id','dance_program',
  'branch_id','branch',
  'trainer_resource_id','service_resource',
  'room_resource_id','service_resource'
);

DROP TRIGGER IF EXISTS dance_group_member_tenant_refs_v1 ON dance_group_member;
CREATE TRIGGER dance_group_member_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_group_member
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'group_id','dance_group',
  'student_id','dance_student'
);

DROP TRIGGER IF EXISTS dance_waitlist_tenant_refs_v1 ON dance_group_waitlist;
CREATE TRIGGER dance_waitlist_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_group_waitlist
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'group_id','dance_group',
  'student_id','dance_student'
);

DROP TRIGGER IF EXISTS dance_lesson_tenant_refs_v1 ON dance_lesson;
CREATE TRIGGER dance_lesson_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_lesson
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'group_id','dance_group',
  'host_booking_id','service_booking',
  'trainer_resource_id','service_resource',
  'room_resource_id','service_resource'
);

DROP TRIGGER IF EXISTS dance_participant_tenant_refs_v1 ON dance_lesson_participant;
CREATE TRIGGER dance_participant_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_lesson_participant
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'lesson_id','dance_lesson',
  'student_id','dance_student',
  'package_id','service_package'
);

DROP TRIGGER IF EXISTS dance_redemption_tenant_refs_v1 ON dance_package_redemption;
CREATE TRIGGER dance_redemption_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_package_redemption
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'package_id','service_package',
  'participant_id','dance_lesson_participant',
  'package_entitlement_id','service_package_entitlement'
);

DROP TRIGGER IF EXISTS dance_makeup_tenant_refs_v1 ON dance_makeup_credit;
CREATE TRIGGER dance_makeup_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_makeup_credit
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'student_id','dance_student',
  'source_lesson_id','dance_lesson',
  'source_participant_id','dance_lesson_participant'
);

DROP TRIGGER IF EXISTS service_package_freeze_tenant_refs_v1 ON service_package_freeze;
CREATE TRIGGER service_package_freeze_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_package_freeze
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'package_id','service_package'
);

DROP TRIGGER IF EXISTS trainer_comp_plan_tenant_refs_v1 ON trainer_compensation_plan;
CREATE TRIGGER trainer_comp_plan_tenant_refs_v1
BEFORE INSERT OR UPDATE ON trainer_compensation_plan
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'trainer_resource_id','service_resource'
);

DROP TRIGGER IF EXISTS trainer_comp_accrual_tenant_refs_v1 ON trainer_compensation_accrual;
CREATE TRIGGER trainer_comp_accrual_tenant_refs_v1
BEFORE INSERT OR UPDATE ON trainer_compensation_accrual
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'lesson_id','dance_lesson',
  'trainer_resource_id','service_resource',
  'plan_id','trainer_compensation_plan',
  'payroll_batch_id','payroll_accrual_batch'
);

DROP TRIGGER IF EXISTS room_rental_contract_tenant_refs_v1 ON room_rental_contract;
CREATE TRIGGER room_rental_contract_tenant_refs_v1
BEFORE INSERT OR UPDATE ON room_rental_contract
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'room_resource_id','service_resource',
  'counterparty_party_id','party'
);

DROP TRIGGER IF EXISTS room_rental_slot_tenant_refs_v1 ON room_rental_slot;
CREATE TRIGGER room_rental_slot_tenant_refs_v1
BEFORE INSERT OR UPDATE ON room_rental_slot
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'contract_id','room_rental_contract'
);

DROP TRIGGER IF EXISTS dance_profitability_tenant_refs_v1 ON dance_lesson_profitability;
CREATE TRIGGER dance_profitability_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_lesson_profitability
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'lesson_id','dance_lesson'
);

DROP TRIGGER IF EXISTS dance_charge_tenant_refs_v1 ON dance_student_charge;
CREATE TRIGGER dance_charge_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_student_charge
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'student_id','dance_student',
  'payer_party_id','party',
  'obligation_id','financial_obligation',
  'invoice_id','finance_invoice'
);

DROP TRIGGER IF EXISTS payment_allocation_tenant_refs_v1 ON payment_allocation;
CREATE TRIGGER payment_allocation_tenant_refs_v1
BEFORE INSERT OR UPDATE ON payment_allocation
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'payment_id','payment',
  'obligation_id','financial_obligation'
);

DROP TRIGGER IF EXISTS package_beneficiary_tenant_refs_v1 ON service_package_beneficiary;
CREATE TRIGGER package_beneficiary_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_package_beneficiary
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'package_id','service_package',
  'party_id','party'
);

DROP TRIGGER IF EXISTS package_plan_entitlement_tenant_refs_v1 ON service_package_plan_entitlement;
CREATE TRIGGER package_plan_entitlement_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_package_plan_entitlement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'plan_id','service_package_plan',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group'
);

DROP TRIGGER IF EXISTS package_entitlement_tenant_refs_v1 ON service_package_entitlement;
CREATE TRIGGER package_entitlement_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_package_entitlement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'package_id','service_package',
  'source_plan_entitlement_id','service_package_plan_entitlement',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group'
);

DROP TRIGGER IF EXISTS service_package_plan_dance_tenant_refs_v1 ON service_package_plan;
CREATE TRIGGER service_package_plan_dance_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_package_plan
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'applicable_service_id','service_catalog_item',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group'
);

DROP TRIGGER IF EXISTS service_package_dance_tenant_refs_v1 ON service_package;
CREATE TRIGGER service_package_dance_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_package
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'plan_id','service_package_plan',
  'party_id','party',
  'payer_party_id','party',
  'sales_order_id','sales_order',
  'dance_program_id_snapshot','dance_program',
  'dance_group_id_snapshot','dance_group'
);

COMMIT;

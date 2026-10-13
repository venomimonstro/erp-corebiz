BEGIN;
-- Strict tenant relationship integrity for parent/child self-service accounts.
-- RLS filters rows, but a foreign UUID referencing another tenant must
-- also be rejected BEFORE INSERT/UPDATE.
DROP TRIGGER IF EXISTS dance_customer_account_tenant_refs_v1
  ON dance_customer_account;
CREATE TRIGGER dance_customer_account_tenant_refs_v1
BEFORE INSERT OR UPDATE OF membership_id,party_id,linked_by_membership_id,tenant_id
ON dance_customer_account
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'membership_id','tenant_membership',
  'party_id','party',
  'linked_by_membership_id','tenant_membership'
);
CREATE INDEX IF NOT EXISTS dance_customer_account_member_status_idx
  ON dance_customer_account(tenant_id,membership_id,status);
CREATE INDEX IF NOT EXISTS dance_family_students_by_party_idx
  ON dance_student(tenant_id,party_id,status);
CREATE INDEX IF NOT EXISTS dance_family_relationship_lookup_idx
  ON party_relationship(tenant_id,to_party_id,relation_type,ends_on,starts_on);
COMMIT;

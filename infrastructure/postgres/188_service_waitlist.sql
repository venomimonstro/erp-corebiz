BEGIN;

CREATE TABLE service_waitlist_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_catalog_item(id) ON DELETE CASCADE,
  preferred_employee_resource_id uuid
    REFERENCES service_resource(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  desired_from timestamptz NOT NULL,
  desired_to timestamptz NOT NULL,
  min_notice_minutes integer NOT NULL DEFAULT 60
    CHECK (min_notice_minutes BETWEEN 0 AND 43200),
  status text NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING','OFFERED','BOOKED','CANCELLED','EXPIRED')),
  offered_starts_at timestamptz,
  offer_expires_at timestamptz,
  source_booking_id uuid REFERENCES service_booking(id) ON DELETE SET NULL,
  booked_booking_id uuid REFERENCES service_booking(id) ON DELETE SET NULL,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (desired_to > desired_from),
  CHECK (
    (status='OFFERED' AND offered_starts_at IS NOT NULL AND offer_expires_at IS NOT NULL)
    OR status<>'OFFERED'
  ),
  UNIQUE (tenant_id,id)
);

CREATE INDEX service_waitlist_match_idx
  ON service_waitlist_entry(
    tenant_id,service_id,status,desired_from,desired_to,
    preferred_employee_resource_id,branch_id
  );

CREATE UNIQUE INDEX service_waitlist_active_party_service_uq
  ON service_waitlist_entry(
    tenant_id,party_id,service_id,
    coalesce(preferred_employee_resource_id,'00000000-0000-0000-0000-000000000000'::uuid),
    desired_from,desired_to
  )
  WHERE status IN ('WAITING','OFFERED');

CREATE OR REPLACE FUNCTION corebiz_service_waitlist_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.preferred_employee_resource_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM service_resource r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.id=NEW.preferred_employee_resource_id
      AND r.type='EMPLOYEE'
      AND r.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'SERVICE_WAITLIST_EMPLOYEE_INVALID'
      USING ERRCODE='23514';
  END IF;

  IF NEW.booked_booking_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM service_booking b
    WHERE b.tenant_id=NEW.tenant_id
      AND b.id=NEW.booked_booking_id
      AND b.party_id=NEW.party_id
      AND b.service_id=NEW.service_id
  ) THEN
    RAISE EXCEPTION 'SERVICE_WAITLIST_BOOKING_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER service_waitlist_guard_v1
BEFORE INSERT OR UPDATE OF
  party_id,service_id,preferred_employee_resource_id,booked_booking_id
ON service_waitlist_entry
FOR EACH ROW EXECUTE FUNCTION corebiz_service_waitlist_guard();

ALTER TABLE service_waitlist_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_waitlist_entry_isolation
  ON service_waitlist_entry
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE TRIGGER service_waitlist_entry_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_waitlist_entry
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'party_id','party',
  'service_id','service_catalog_item',
  'preferred_employee_resource_id','service_resource',
  'branch_id','branch',
  'source_booking_id','service_booking',
  'booked_booking_id','service_booking',
  'created_by_membership_id','tenant_membership'
);

COMMIT;

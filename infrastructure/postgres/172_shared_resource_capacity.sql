BEGIN;

CREATE TABLE service_resource_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  capacity_units integer NOT NULL CHECK (capacity_units > 0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,resource_id,code),
  UNIQUE (tenant_id,id)
);

CREATE INDEX service_resource_zone_resource_idx
  ON service_resource_zone(tenant_id,resource_id,status);

CREATE OR REPLACE FUNCTION corebiz_service_resource_zone_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  resource_capacity integer;
  configured integer;
BEGIN
  SELECT capacity INTO resource_capacity
  FROM service_resource
  WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id
  FOR UPDATE;

  IF resource_capacity IS NULL THEN
    RAISE EXCEPTION 'SERVICE_RESOURCE_ZONE_RESOURCE_MISSING';
  END IF;

  SELECT coalesce(sum(capacity_units),0)::integer INTO configured
  FROM service_resource_zone
  WHERE tenant_id=NEW.tenant_id
    AND resource_id=NEW.resource_id
    AND status='ACTIVE'
    AND id<>NEW.id;

  IF NEW.status='ACTIVE' AND configured + NEW.capacity_units > resource_capacity THEN
    RAISE EXCEPTION 'SERVICE_RESOURCE_ZONE_CAPACITY_EXCEEDED';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER service_resource_zone_guard_v1
BEFORE INSERT OR UPDATE OF resource_id,capacity_units,status
ON service_resource_zone
FOR EACH ROW EXECUTE FUNCTION corebiz_service_resource_zone_guard();

ALTER TABLE service_booking_resource
  ADD COLUMN IF NOT EXISTS zone_id uuid
    REFERENCES service_resource_zone(id) ON DELETE RESTRICT;

ALTER TABLE service_resource_block
  ADD COLUMN IF NOT EXISTS capacity_units integer,
  ADD COLUMN IF NOT EXISTS zone_id uuid
    REFERENCES service_resource_zone(id) ON DELETE CASCADE;

ALTER TABLE service_resource_block
  DROP CONSTRAINT IF EXISTS service_resource_block_capacity_units_ck;

ALTER TABLE service_resource_block
  ADD CONSTRAINT service_resource_block_capacity_units_ck
    CHECK (capacity_units IS NULL OR capacity_units > 0);

CREATE INDEX service_resource_block_capacity_window_idx
  ON service_resource_block(tenant_id,resource_id,zone_id,starts_at,ends_at);

CREATE OR REPLACE FUNCTION corebiz_service_booking_resource_capacity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  booking_start timestamptz;
  booking_end timestamptz;
  booking_status text;
  resource_capacity integer;
  zone_capacity integer;
  used_resource bigint;
  used_zone bigint;
  blocked_resource bigint;
  blocked_zone bigint;
BEGIN
  SELECT
    b.starts_at - make_interval(mins => b.buffer_before_minutes_snapshot),
    b.ends_at + make_interval(mins => b.buffer_after_minutes_snapshot),
    b.status
  INTO booking_start,booking_end,booking_status
  FROM service_booking b
  WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.booking_id;

  IF booking_start IS NULL THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_BOOKING_MISSING';
  END IF;

  SELECT capacity INTO resource_capacity
  FROM service_resource
  WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id
  FOR UPDATE;

  IF resource_capacity IS NULL THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_RESOURCE_MISSING';
  END IF;

  IF NEW.zone_id IS NOT NULL THEN
    SELECT capacity_units INTO zone_capacity
    FROM service_resource_zone
    WHERE tenant_id=NEW.tenant_id
      AND id=NEW.zone_id
      AND resource_id=NEW.resource_id
      AND status='ACTIVE';
    IF zone_capacity IS NULL THEN
      RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_ZONE_INVALID';
    END IF;
    IF NEW.capacity_units > zone_capacity THEN
      RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_ZONE_CAPACITY_EXCEEDED';
    END IF;
  END IF;

  IF booking_status NOT IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE') THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(br.capacity_units),0) INTO used_resource
  FROM service_booking_resource br
  JOIN service_booking b
    ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
  WHERE br.tenant_id=NEW.tenant_id
    AND br.resource_id=NEW.resource_id
    AND (br.booking_id,br.resource_id)<>(NEW.booking_id,NEW.resource_id)
    AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
    AND (
      b.starts_at - make_interval(mins => b.buffer_before_minutes_snapshot)
    ) < booking_end
    AND (
      b.ends_at + make_interval(mins => b.buffer_after_minutes_snapshot)
    ) > booking_start;

  SELECT coalesce(sum(
    CASE WHEN rb.capacity_units IS NULL THEN resource_capacity ELSE rb.capacity_units END
  ),0) INTO blocked_resource
  FROM service_resource_block rb
  WHERE rb.tenant_id=NEW.tenant_id
    AND rb.resource_id=NEW.resource_id
    AND rb.zone_id IS NULL
    AND rb.starts_at < booking_end
    AND rb.ends_at > booking_start;

  IF used_resource + blocked_resource + NEW.capacity_units > resource_capacity THEN
    RAISE EXCEPTION 'SERVICE_RESOURCE_CAPACITY_EXCEEDED';
  END IF;

  IF NEW.zone_id IS NOT NULL THEN
    SELECT coalesce(sum(br.capacity_units),0) INTO used_zone
    FROM service_booking_resource br
    JOIN service_booking b
      ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
    WHERE br.tenant_id=NEW.tenant_id
      AND br.resource_id=NEW.resource_id
      AND br.zone_id=NEW.zone_id
      AND (br.booking_id,br.resource_id)<>(NEW.booking_id,NEW.resource_id)
      AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
      AND (
        b.starts_at - make_interval(mins => b.buffer_before_minutes_snapshot)
      ) < booking_end
      AND (
        b.ends_at + make_interval(mins => b.buffer_after_minutes_snapshot)
      ) > booking_start;

    SELECT coalesce(sum(
      CASE WHEN rb.capacity_units IS NULL THEN zone_capacity ELSE rb.capacity_units END
    ),0) INTO blocked_zone
    FROM service_resource_block rb
    WHERE rb.tenant_id=NEW.tenant_id
      AND rb.resource_id=NEW.resource_id
      AND rb.zone_id=NEW.zone_id
      AND rb.starts_at < booking_end
      AND rb.ends_at > booking_start;

    IF used_zone + blocked_zone + NEW.capacity_units > zone_capacity THEN
      RAISE EXCEPTION 'SERVICE_RESOURCE_ZONE_CAPACITY_EXCEEDED';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_booking_resource_capacity_guard_v1
  ON service_booking_resource;
CREATE TRIGGER service_booking_resource_capacity_guard_v1
BEFORE INSERT OR UPDATE OF resource_id,capacity_units,zone_id
ON service_booking_resource
FOR EACH ROW EXECUTE FUNCTION corebiz_service_booking_resource_capacity_guard();

ALTER TABLE room_rental_contract
  ADD COLUMN IF NOT EXISTS capacity_units integer,
  ADD COLUMN IF NOT EXISTS zone_id uuid
    REFERENCES service_resource_zone(id) ON DELETE SET NULL;

UPDATE room_rental_contract c
SET capacity_units=r.capacity
FROM service_resource r
WHERE r.tenant_id=c.tenant_id
  AND r.id=c.room_resource_id
  AND c.capacity_units IS NULL;

ALTER TABLE room_rental_contract
  ALTER COLUMN capacity_units SET DEFAULT 1,
  ALTER COLUMN capacity_units SET NOT NULL;

ALTER TABLE room_rental_contract
  DROP CONSTRAINT IF EXISTS room_rental_contract_capacity_units_ck;

ALTER TABLE room_rental_contract
  ADD CONSTRAINT room_rental_contract_capacity_units_ck
    CHECK (capacity_units > 0);

DROP TRIGGER IF EXISTS room_rental_contract_overlap_guard_v1
  ON room_rental_contract;

CREATE OR REPLACE FUNCTION corebiz_room_rental_contract_capacity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  max_capacity integer;
  used_capacity bigint;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF NEW.zone_id IS NULL THEN
    SELECT capacity INTO max_capacity
    FROM service_resource
    WHERE tenant_id=NEW.tenant_id AND id=NEW.room_resource_id
    FOR UPDATE;
  ELSE
    SELECT z.capacity_units INTO max_capacity
    FROM service_resource_zone z
    WHERE z.tenant_id=NEW.tenant_id
      AND z.id=NEW.zone_id
      AND z.resource_id=NEW.room_resource_id
      AND z.status='ACTIVE';
  END IF;

  IF max_capacity IS NULL OR NEW.capacity_units > max_capacity THEN
    RAISE EXCEPTION 'ROOM_RENTAL_CAPACITY_INVALID';
  END IF;

  SELECT coalesce(sum(c.capacity_units),0) INTO used_capacity
  FROM room_rental_contract c
  WHERE c.tenant_id=NEW.tenant_id
    AND c.room_resource_id=NEW.room_resource_id
    AND c.zone_id IS NOT DISTINCT FROM NEW.zone_id
    AND c.id<>NEW.id
    AND c.status='ACTIVE'
    AND daterange(c.valid_from,c.valid_to,'[]')
        && daterange(NEW.valid_from,NEW.valid_to,'[]');

  IF used_capacity + NEW.capacity_units > max_capacity THEN
    RAISE EXCEPTION 'ROOM_RENTAL_CAPACITY_EXCEEDED';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER room_rental_contract_capacity_guard_v2
BEFORE INSERT OR UPDATE OF
  room_resource_id,zone_id,capacity_units,valid_from,valid_to,status
ON room_rental_contract
FOR EACH ROW EXECUTE FUNCTION corebiz_room_rental_contract_capacity_guard();

ALTER TABLE dance_lesson
  ADD COLUMN IF NOT EXISTS room_capacity_units integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS room_zone_id uuid
    REFERENCES service_resource_zone(id) ON DELETE SET NULL;

ALTER TABLE dance_lesson
  DROP CONSTRAINT IF EXISTS dance_lesson_room_capacity_units_ck,
  DROP CONSTRAINT IF EXISTS dance_lesson_lesson_type_check;

ALTER TABLE dance_lesson
  ADD CONSTRAINT dance_lesson_room_capacity_units_ck
    CHECK (room_capacity_units > 0),
  ADD CONSTRAINT dance_lesson_lesson_type_check
    CHECK (lesson_type IN (
      'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS',
      'REHEARSAL','RENTAL_EVENT','SELF_PRACTICE'
    ));

ALTER TABLE service_resource_zone ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_resource_zone_isolation
  ON service_resource_zone
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER service_resource_zone_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_resource_zone
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'resource_id','service_resource'
);

CREATE TRIGGER service_booking_resource_zone_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_booking_resource
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'booking_id','service_booking',
  'resource_id','service_resource',
  'zone_id','service_resource_zone'
);

CREATE TRIGGER service_resource_block_zone_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_resource_block
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'resource_id','service_resource',
  'zone_id','service_resource_zone'
);

COMMIT;

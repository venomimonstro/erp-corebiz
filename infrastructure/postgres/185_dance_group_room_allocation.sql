BEGIN;

ALTER TABLE dance_group
  ADD COLUMN IF NOT EXISTS room_zone_id uuid
    REFERENCES service_resource_zone(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS room_capacity_units integer NOT NULL DEFAULT 1;

ALTER TABLE dance_group
  DROP CONSTRAINT IF EXISTS dance_group_room_capacity_units_ck;

ALTER TABLE dance_group
  ADD CONSTRAINT dance_group_room_capacity_units_ck
  CHECK (room_capacity_units BETWEEN 1 AND 100000);

CREATE OR REPLACE FUNCTION corebiz_dance_group_room_allocation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_capacity integer;
BEGIN
  IF NEW.room_resource_id IS NULL THEN
    IF NEW.room_zone_id IS NOT NULL THEN
      RAISE EXCEPTION 'DANCE_GROUP_ZONE_REQUIRES_ROOM'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT capacity
  INTO v_capacity
  FROM service_resource
  WHERE tenant_id=NEW.tenant_id
    AND id=NEW.room_resource_id
    AND type IN ('ROOM','HALL','WORKPLACE');

  IF v_capacity IS NULL THEN
    RAISE EXCEPTION 'DANCE_GROUP_ROOM_INVALID'
      USING ERRCODE='23514';
  END IF;

  IF NEW.room_zone_id IS NOT NULL THEN
    SELECT capacity_units
    INTO v_capacity
    FROM service_resource_zone
    WHERE tenant_id=NEW.tenant_id
      AND id=NEW.room_zone_id
      AND resource_id=NEW.room_resource_id
      AND status='ACTIVE';

    IF v_capacity IS NULL THEN
      RAISE EXCEPTION 'DANCE_GROUP_ZONE_INVALID'
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.room_capacity_units>v_capacity THEN
    RAISE EXCEPTION 'DANCE_GROUP_ROOM_CAPACITY_EXCEEDED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dance_group_room_allocation_guard_v1
  ON dance_group;
CREATE TRIGGER dance_group_room_allocation_guard_v1
BEFORE INSERT OR UPDATE OF
  room_resource_id,room_zone_id,room_capacity_units
ON dance_group
FOR EACH ROW EXECUTE FUNCTION corebiz_dance_group_room_allocation_guard();

CREATE TRIGGER dance_group_room_zone_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_group
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'room_zone_id','service_resource_zone'
);

COMMIT;

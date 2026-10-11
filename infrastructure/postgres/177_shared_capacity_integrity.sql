BEGIN;

CREATE OR REPLACE FUNCTION corebiz_assert_service_resource_allocation(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_resource_id uuid,
  p_capacity_units integer,
  p_zone_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_status text;
  v_resource_capacity integer;
  v_zone_capacity integer;
  v_used bigint;
  v_blocked bigint;
BEGIN
  SELECT
    b.starts_at-make_interval(mins=>b.buffer_before_minutes_snapshot),
    b.ends_at+make_interval(mins=>b.buffer_after_minutes_snapshot),
    b.status
  INTO v_start,v_end,v_status
  FROM service_booking b
  WHERE b.tenant_id=p_tenant_id AND b.id=p_booking_id;

  IF v_start IS NULL THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_BOOKING_MISSING';
  END IF;
  IF v_status NOT IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE') THEN
    RETURN;
  END IF;

  SELECT capacity
  INTO v_resource_capacity
  FROM service_resource
  WHERE tenant_id=p_tenant_id AND id=p_resource_id
  FOR UPDATE;

  IF v_resource_capacity IS NULL THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_RESOURCE_MISSING';
  END IF;

  SELECT coalesce(sum(br.capacity_units),0)
  INTO v_used
  FROM service_booking_resource br
  JOIN service_booking b
    ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
  WHERE br.tenant_id=p_tenant_id
    AND br.resource_id=p_resource_id
    AND br.booking_id<>p_booking_id
    AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
    AND (
      b.starts_at-make_interval(mins=>b.buffer_before_minutes_snapshot)
    )<v_end
    AND (
      b.ends_at+make_interval(mins=>b.buffer_after_minutes_snapshot)
    )>v_start;

  SELECT coalesce(sum(
    CASE
      WHEN rb.capacity_units IS NOT NULL THEN rb.capacity_units
      WHEN rb.zone_id IS NULL THEN v_resource_capacity
      ELSE z.capacity_units
    END
  ),0)
  INTO v_blocked
  FROM service_resource_block rb
  LEFT JOIN service_resource_zone z
    ON z.tenant_id=rb.tenant_id AND z.id=rb.zone_id
  WHERE rb.tenant_id=p_tenant_id
    AND rb.resource_id=p_resource_id
    AND rb.starts_at<v_end
    AND rb.ends_at>v_start;

  IF v_used+v_blocked+p_capacity_units>v_resource_capacity THEN
    RAISE EXCEPTION 'SERVICE_RESOURCE_CAPACITY_EXCEEDED';
  END IF;

  IF p_zone_id IS NOT NULL THEN
    SELECT capacity_units
    INTO v_zone_capacity
    FROM service_resource_zone
    WHERE tenant_id=p_tenant_id
      AND id=p_zone_id
      AND resource_id=p_resource_id
      AND status='ACTIVE';

    IF v_zone_capacity IS NULL OR p_capacity_units>v_zone_capacity THEN
      RAISE EXCEPTION 'SERVICE_BOOKING_RESOURCE_ZONE_INVALID';
    END IF;

    SELECT coalesce(sum(br.capacity_units),0)
    INTO v_used
    FROM service_booking_resource br
    JOIN service_booking b
      ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
    WHERE br.tenant_id=p_tenant_id
      AND br.resource_id=p_resource_id
      AND br.zone_id=p_zone_id
      AND br.booking_id<>p_booking_id
      AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
      AND (
        b.starts_at-make_interval(mins=>b.buffer_before_minutes_snapshot)
      )<v_end
      AND (
        b.ends_at+make_interval(mins=>b.buffer_after_minutes_snapshot)
      )>v_start;

    SELECT coalesce(sum(
      coalesce(rb.capacity_units,v_zone_capacity)
    ),0)
    INTO v_blocked
    FROM service_resource_block rb
    WHERE rb.tenant_id=p_tenant_id
      AND rb.resource_id=p_resource_id
      AND rb.zone_id=p_zone_id
      AND rb.starts_at<v_end
      AND rb.ends_at>v_start;

    IF v_used+v_blocked+p_capacity_units>v_zone_capacity THEN
      RAISE EXCEPTION 'SERVICE_RESOURCE_ZONE_CAPACITY_EXCEEDED';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_service_booking_resource_capacity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  PERFORM corebiz_assert_service_resource_allocation(
    NEW.tenant_id,NEW.booking_id,NEW.resource_id,
    NEW.capacity_units,NEW.zone_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_booking_resource_capacity_guard_v1
  ON service_booking_resource;
CREATE TRIGGER service_booking_resource_capacity_guard_v2
BEFORE INSERT OR UPDATE OF resource_id,capacity_units,zone_id
ON service_booking_resource
FOR EACH ROW EXECUTE FUNCTION corebiz_service_booking_resource_capacity_guard();

CREATE OR REPLACE FUNCTION corebiz_service_booking_recheck_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  allocation record;
BEGIN
  IF NEW.status NOT IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE') THEN
    RETURN NEW;
  END IF;

  FOR allocation IN
    SELECT resource_id,capacity_units,zone_id
    FROM service_booking_resource
    WHERE tenant_id=NEW.tenant_id AND booking_id=NEW.id
    ORDER BY resource_id
  LOOP
    PERFORM corebiz_assert_service_resource_allocation(
      NEW.tenant_id,NEW.id,allocation.resource_id,
      allocation.capacity_units,allocation.zone_id
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_booking_recheck_capacity_v1
  ON service_booking;
CREATE TRIGGER service_booking_recheck_capacity_v1
AFTER UPDATE OF
  starts_at,ends_at,status,buffer_before_minutes_snapshot,
  buffer_after_minutes_snapshot
ON service_booking
FOR EACH ROW EXECUTE FUNCTION corebiz_service_booking_recheck_capacity();

CREATE OR REPLACE FUNCTION corebiz_service_resource_block_recheck_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  allocation record;
BEGIN
  FOR allocation IN
    SELECT DISTINCT
      br.booking_id,br.resource_id,br.capacity_units,br.zone_id
    FROM service_booking_resource br
    JOIN service_booking b
      ON b.tenant_id=br.tenant_id AND b.id=br.booking_id
    WHERE br.tenant_id=NEW.tenant_id
      AND br.resource_id=NEW.resource_id
      AND b.status IN ('DRAFT','CONFIRMED','ARRIVED','IN_SERVICE')
      AND (
        b.starts_at-make_interval(mins=>b.buffer_before_minutes_snapshot)
      )<NEW.ends_at
      AND (
        b.ends_at+make_interval(mins=>b.buffer_after_minutes_snapshot)
      )>NEW.starts_at
    ORDER BY br.resource_id,br.booking_id
  LOOP
    PERFORM corebiz_assert_service_resource_allocation(
      NEW.tenant_id,allocation.booking_id,allocation.resource_id,
      allocation.capacity_units,allocation.zone_id
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_resource_block_recheck_capacity_v1
  ON service_resource_block;
CREATE TRIGGER service_resource_block_recheck_capacity_v1
AFTER INSERT OR UPDATE OF
  resource_id,starts_at,ends_at,capacity_units,zone_id
ON service_resource_block
FOR EACH ROW EXECUTE FUNCTION corebiz_service_resource_block_recheck_capacity();

COMMIT;

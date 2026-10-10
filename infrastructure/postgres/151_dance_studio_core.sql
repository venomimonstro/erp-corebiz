BEGIN;

CREATE TABLE party_relationship (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  from_party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  to_party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  relation_type text NOT NULL
    CHECK (relation_type IN (
      'PARENT','GUARDIAN','PAYER','CHILD','FAMILY_MEMBER','EMERGENCY_CONTACT'
    )),
  is_primary boolean NOT NULL DEFAULT false,
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_party_id <> to_party_id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  UNIQUE (tenant_id,from_party_id,to_party_id,relation_type,starts_on)
);

CREATE INDEX party_relationship_from_idx
  ON party_relationship(tenant_id,from_party_id,relation_type,ends_on);
CREATE INDEX party_relationship_to_idx
  ON party_relationship(tenant_id,to_party_id,relation_type,ends_on);

CREATE TABLE dance_student (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  birth_date date,
  training_level text
    CHECK (training_level IS NULL OR training_level IN ('BEGINNER','INTERMEDIATE','ADVANCED')),
  status text NOT NULL DEFAULT 'LEAD'
    CHECK (status IN ('LEAD','TRIAL','ACTIVE','PAUSED','CHURNED','ARCHIVED')),
  preferred_branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  joined_at timestamptz,
  first_lesson_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,party_id),
  UNIQUE (tenant_id,id)
);

CREATE INDEX dance_student_status_idx
  ON dance_student(tenant_id,status,preferred_branch_id);

CREATE TABLE dance_program (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  name text NOT NULL,
  code text,
  min_age integer CHECK (min_age IS NULL OR min_age BETWEEN 0 AND 120),
  max_age integer CHECK (max_age IS NULL OR max_age BETWEEN 0 AND 120),
  default_duration_minutes integer NOT NULL DEFAULT 60
    CHECK (default_duration_minutes BETWEEN 15 AND 360),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  UNIQUE (tenant_id,code),
  UNIQUE (tenant_id,id)
);

CREATE TABLE dance_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES dance_program(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  name text NOT NULL,
  trainer_resource_id uuid REFERENCES service_resource(id) ON DELETE SET NULL,
  room_resource_id uuid REFERENCES service_resource(id) ON DELETE SET NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  break_even_members integer NOT NULL DEFAULT 1
    CHECK (break_even_members BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  schedule jsonb NOT NULL DEFAULT '[]'::jsonb,
  currency char(3) NOT NULL DEFAULT 'RUB',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (break_even_members <= capacity),
  UNIQUE (tenant_id,id)
);

CREATE INDEX dance_group_program_idx
  ON dance_group(tenant_id,program_id,status);
CREATE INDEX dance_group_trainer_idx
  ON dance_group(tenant_id,trainer_resource_id,status);

CREATE TABLE dance_group_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES dance_group(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES dance_student(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('TRIAL','ACTIVE','PAUSED','WAITLIST','LEFT')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  reserved_place boolean NOT NULL DEFAULT true,
  discount_bps integer NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  UNIQUE (tenant_id,group_id,student_id)
);

CREATE INDEX dance_group_member_student_idx
  ON dance_group_member(tenant_id,student_id,status);

CREATE TABLE dance_group_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES dance_group(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES dance_student(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING','OFFERED','ACCEPTED','CANCELLED','EXPIRED')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (offer_expires_at IS NULL OR offered_at IS NOT NULL),
  CHECK (offer_expires_at IS NULL OR offer_expires_at > offered_at),
  UNIQUE (tenant_id,group_id,student_id)
);

CREATE INDEX dance_waitlist_queue_idx
  ON dance_group_waitlist(tenant_id,group_id,status,priority,created_at);

CREATE TABLE dance_lesson (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  group_id uuid REFERENCES dance_group(id) ON DELETE SET NULL,
  host_booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE RESTRICT,
  lesson_type text NOT NULL
    CHECK (lesson_type IN (
      'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS','REHEARSAL','RENTAL_EVENT'
    )),
  trainer_resource_id uuid REFERENCES service_resource(id) ON DELETE SET NULL,
  room_resource_id uuid REFERENCES service_resource(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'OPEN_FOR_BOOKING'
    CHECK (status IN (
      'PLANNED','OPEN_FOR_BOOKING','STARTED','COMPLETED',
      'CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER'
    )),
  attendance_locked_at timestamptz,
  currency char(3) NOT NULL DEFAULT 'RUB',
  version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id,host_booking_id),
  UNIQUE (tenant_id,id)
);

CREATE UNIQUE INDEX dance_lesson_group_start_uq
  ON dance_lesson(tenant_id,group_id,starts_at)
  WHERE group_id IS NOT NULL
    AND status NOT IN ('CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER');

CREATE INDEX dance_lesson_calendar_idx
  ON dance_lesson(tenant_id,starts_at,status,trainer_resource_id,room_resource_id);

CREATE TABLE dance_lesson_participant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES dance_lesson(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES dance_student(id) ON DELETE RESTRICT,
  package_id uuid REFERENCES service_package(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'BOOKED'
    CHECK (status IN (
      'BOOKED','WAITLIST','ATTENDED','LATE','NO_SHOW',
      'EXCUSED_ABSENCE','CANCELLED_IN_TIME','CANCELLED_LATE'
    )),
  price_source text NOT NULL DEFAULT 'DIRECT'
    CHECK (price_source IN ('PACKAGE','DIRECT','TRIAL','FREE','MAKEUP')),
  charge_minor bigint NOT NULL DEFAULT 0 CHECK (charge_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  attendance_marked_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  attendance_marked_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,lesson_id,student_id),
  UNIQUE (tenant_id,id)
);

CREATE INDEX dance_participant_student_idx
  ON dance_lesson_participant(tenant_id,student_id,status,created_at DESC);

CREATE TABLE dance_package_redemption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES service_package(id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES dance_lesson_participant(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('RESERVED','CONSUMED','RELEASED')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (tenant_id,participant_id)
);

CREATE INDEX dance_package_redemption_package_idx
  ON dance_package_redemption(tenant_id,package_id,state);

CREATE TABLE dance_makeup_credit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES dance_student(id) ON DELETE CASCADE,
  source_lesson_id uuid NOT NULL REFERENCES dance_lesson(id) ON DELETE RESTRICT,
  source_participant_id uuid NOT NULL REFERENCES dance_lesson_participant(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','RESERVED','USED','EXPIRED','CANCELLED')),
  used_lesson_id uuid REFERENCES dance_lesson(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,source_participant_id)
);

ALTER TABLE service_package_plan
  ADD COLUMN IF NOT EXISTS freeze_days_allowed integer NOT NULL DEFAULT 0
    CHECK (freeze_days_allowed BETWEEN 0 AND 3650),
  ADD COLUMN IF NOT EXISTS makeup_days_valid integer NOT NULL DEFAULT 0
    CHECK (makeup_days_valid BETWEEN 0 AND 3650),
  ADD COLUMN IF NOT EXISTS allow_makeup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS family_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS activation_policy text NOT NULL DEFAULT 'FULL_PAYMENT'
    CHECK (activation_policy IN ('FULL_PAYMENT','IMMEDIATE','PROPORTIONAL','GRACE_PERIOD')),
  ADD COLUMN IF NOT EXISTS allowed_debt_minor bigint NOT NULL DEFAULT 0
    CHECK (allowed_debt_minor >= 0);

ALTER TABLE service_package
  ADD COLUMN IF NOT EXISTS payer_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS freeze_days_total_snapshot integer NOT NULL DEFAULT 0
    CHECK (freeze_days_total_snapshot BETWEEN 0 AND 3650),
  ADD COLUMN IF NOT EXISTS freeze_days_used integer NOT NULL DEFAULT 0
    CHECK (freeze_days_used BETWEEN 0 AND 3650),
  ADD CONSTRAINT service_package_freeze_days_ck
    CHECK (freeze_days_used <= freeze_days_total_snapshot);

CREATE TABLE service_package_freeze (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES service_package(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  applied_days integer NOT NULL CHECK (applied_days > 0),
  status text NOT NULL DEFAULT 'APPLIED'
    CHECK (status IN ('APPLIED','CANCELLED')),
  reason text,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX service_package_freeze_package_idx
  ON service_package_freeze(tenant_id,package_id,status,starts_on);

CREATE TABLE trainer_compensation_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  trainer_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  lesson_type text,
  calculation_type text NOT NULL
    CHECK (calculation_type IN ('FIXED','HOURLY','PERCENT','ATTENDEE','TIERED')),
  fixed_minor bigint NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  hourly_minor bigint NOT NULL DEFAULT 0 CHECK (hourly_minor >= 0),
  percent_bps integer NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  per_attendee_minor bigint NOT NULL DEFAULT 0 CHECK (per_attendee_minor >= 0),
  threshold_count integer NOT NULL DEFAULT 0 CHECK (threshold_count BETWEEN 0 AND 10000),
  threshold_extra_minor bigint NOT NULL DEFAULT 0 CHECK (threshold_extra_minor >= 0),
  revenue_basis text NOT NULL DEFAULT 'EARNED'
    CHECK (revenue_basis IN ('LIST','BILLED','PAID','EARNED')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  currency char(3) NOT NULL DEFAULT 'RUB',
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (
    lesson_type IS NULL OR lesson_type IN (
      'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS','REHEARSAL','RENTAL_EVENT'
    )
  )
);

CREATE INDEX trainer_compensation_plan_active_idx
  ON trainer_compensation_plan(
    tenant_id,trainer_resource_id,status,valid_from,valid_to,priority
  );

CREATE TABLE trainer_compensation_accrual (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES dance_lesson(id) ON DELETE RESTRICT,
  trainer_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES trainer_compensation_plan(id) ON DELETE SET NULL,
  rule_snapshot jsonb NOT NULL,
  attended_count integer NOT NULL DEFAULT 0 CHECK (attended_count >= 0),
  eligible_revenue_minor bigint NOT NULL DEFAULT 0 CHECK (eligible_revenue_minor >= 0),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'CALCULATED'
    CHECK (status IN ('CALCULATED','APPROVED','EXPORTED','REVERSED')),
  payroll_batch_id uuid REFERENCES payroll_accrual_batch(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  UNIQUE (tenant_id,lesson_id,trainer_resource_id)
);

CREATE INDEX trainer_accrual_period_idx
  ON trainer_compensation_accrual(tenant_id,trainer_resource_id,status,created_at);

CREATE TABLE room_rental_contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  room_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  counterparty_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  pricing_type text NOT NULL
    CHECK (pricing_type IN ('HOURLY','FIXED_MONTHLY','FIXED_SLOT')),
  hourly_rate_minor bigint NOT NULL DEFAULT 0 CHECK (hourly_rate_minor >= 0),
  monthly_minor bigint NOT NULL DEFAULT 0 CHECK (monthly_minor >= 0),
  slot_minor bigint NOT NULL DEFAULT 0 CHECK (slot_minor >= 0),
  minimum_billable_minutes integer NOT NULL DEFAULT 0
    CHECK (minimum_billable_minutes BETWEEN 0 AND 1440),
  cancellation_charge_bps integer NOT NULL DEFAULT 0
    CHECK (cancellation_charge_bps BETWEEN 0 AND 10000),
  currency char(3) NOT NULL DEFAULT 'RUB',
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX room_rental_contract_active_idx
  ON room_rental_contract(tenant_id,room_resource_id,status,valid_from,valid_to);

CREATE TABLE room_rental_slot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES room_rental_contract(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  slot_minor bigint NOT NULL DEFAULT 0 CHECK (slot_minor >= 0),
  CHECK (end_minute > start_minute)
);

CREATE TABLE dance_lesson_profitability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES dance_lesson(id) ON DELETE RESTRICT,
  booked_count integer NOT NULL DEFAULT 0 CHECK (booked_count >= 0),
  attended_count integer NOT NULL DEFAULT 0 CHECK (attended_count >= 0),
  earned_revenue_minor bigint NOT NULL DEFAULT 0 CHECK (earned_revenue_minor >= 0),
  trainer_cost_minor bigint NOT NULL DEFAULT 0 CHECK (trainer_cost_minor >= 0),
  room_cost_minor bigint NOT NULL DEFAULT 0 CHECK (room_cost_minor >= 0),
  other_cost_minor bigint NOT NULL DEFAULT 0 CHECK (other_cost_minor >= 0),
  contribution_margin_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'RUB',
  calculated_at timestamptz NOT NULL DEFAULT now(),
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id,lesson_id)
);

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'party_relationship',
    'dance_student',
    'dance_program',
    'dance_group',
    'dance_group_member',
    'dance_group_waitlist',
    'dance_lesson',
    'dance_lesson_participant',
    'dance_package_redemption',
    'dance_makeup_credit',
    'service_package_freeze',
    'trainer_compensation_plan',
    'trainer_compensation_accrual',
    'room_rental_contract',
    'room_rental_slot',
    'dance_lesson_profitability'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_dance_party_relationship_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM party p
    WHERE p.id=NEW.from_party_id AND p.tenant_id=NEW.tenant_id
  ) OR NOT EXISTS (
    SELECT 1 FROM party p
    WHERE p.id=NEW.to_party_id AND p.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Dance party relationship tenant mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dance_party_relationship_guard_v1
BEFORE INSERT OR UPDATE ON party_relationship
FOR EACH ROW EXECUTE FUNCTION corebiz_dance_party_relationship_guard();

CREATE OR REPLACE FUNCTION corebiz_dance_lesson_profitability_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Dance lesson profitability snapshot is immutable'
    USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER dance_lesson_profitability_immutable_v1
BEFORE UPDATE OR DELETE ON dance_lesson_profitability
FOR EACH ROW EXECUTE FUNCTION corebiz_dance_lesson_profitability_immutable();

COMMIT;

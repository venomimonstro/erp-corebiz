BEGIN;
ALTER TABLE work_project_time_entry
  ADD COLUMN IF NOT EXISTS cost_rate_minor_snapshot bigint
  CHECK (cost_rate_minor_snapshot IS NULL OR cost_rate_minor_snapshot>=0);
-- NULL means historical records, before per-entry cost capture was introduced.
COMMENT ON COLUMN work_project_time_entry.cost_rate_minor_snapshot
  IS 'Hourly labor cost in project currency minor units at booking time; NULL indicates pre-migration history';
COMMIT;
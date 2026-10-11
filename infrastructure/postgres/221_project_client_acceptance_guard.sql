BEGIN;
-- A project delivered to a paying client is not done merely because its
-- internal task cards have been moved to Done. Protect direct SQL, imports
-- and future API entry points with the same completion gate.
CREATE OR REPLACE FUNCTION corebiz_guard_project_client_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'COMPLETED'
     OR OLD.status='COMPLETED' THEN RETURN NEW; END IF;

  IF EXISTS (
    SELECT 1 FROM work_project_milestone m
    WHERE m.tenant_id=NEW.tenant_id AND m.project_id=NEW.id
      AND m.status NOT IN ('DONE','CANCELLED')
  ) OR EXISTS (
    SELECT 1 FROM task t WHERE t.tenant_id=NEW.tenant_id
      AND t.linked_type='PROJECT' AND t.linked_id=NEW.id
      AND t.state NOT IN ('DONE','CANCELLED')
  ) OR EXISTS (
    SELECT 1 FROM work_project_deliverable d
    WHERE d.tenant_id=NEW.tenant_id AND d.project_id=NEW.id
      AND d.status NOT IN ('APPROVED','CANCELLED')
  ) OR EXISTS (
    SELECT 1 FROM work_project_client_approval a
    WHERE a.tenant_id=NEW.tenant_id AND a.project_id=NEW.id
      AND a.status='PENDING'
  ) THEN
    RAISE EXCEPTION
      'Cannot complete project: open milestones, tasks, deliverables or client approvals'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER work_project_acceptance_completion_guard
BEFORE UPDATE OF status ON work_project
FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_project_client_acceptance();
COMMIT;

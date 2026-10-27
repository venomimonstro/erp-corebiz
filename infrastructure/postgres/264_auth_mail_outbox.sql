BEGIN;

-- Durable authentication mail outbox. Raw verification/reset tokens are NEVER
-- stored in this table. The worker generates a fresh token in memory for each
-- delivery attempt; only its SHA-256 hash is persisted in the existing token
-- tables. A failed delivery can therefore retry after restart without placing
-- a reusable bearer secret in PostgreSQL.

CREATE TABLE auth_mail_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('EMAIL_VERIFICATION','PASSWORD_RESET')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','RUNNING','SENT','FAILED','BOUNCED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  retry_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_job_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX auth_mail_delivery_one_active_idx
  ON auth_mail_delivery(user_id,kind)
  WHERE status IN ('PENDING','RUNNING','FAILED');

CREATE INDEX auth_mail_delivery_queue_idx
  ON auth_mail_delivery(status,retry_at,created_at)
  WHERE status IN ('PENDING','RUNNING','FAILED');

REVOKE ALL ON auth_mail_delivery FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.corebiz_enqueue_auth_mail(
  p_user_id uuid,
  p_kind text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_existing auth_mail_delivery%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR p_kind NOT IN ('EMAIL_VERIFICATION','PASSWORD_RESET') THEN
    RAISE EXCEPTION 'AUTH_MAIL_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;

  -- Serialize enqueue/requeue for one user + purpose without exposing table
  -- privileges to the application role.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text||'|auth-mail|'||p_kind,0
    )
  );

  IF NOT EXISTS(
    SELECT 1 FROM public.app_user
    WHERE id=p_user_id AND status='ACTIVE'
  ) THEN
    RETURN false;
  END IF;

  IF p_kind='EMAIL_VERIFICATION' AND EXISTS(
    SELECT 1 FROM public.app_user
    WHERE id=p_user_id AND email_verified_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_existing
  FROM public.auth_mail_delivery
  WHERE user_id=p_user_id
    AND kind=p_kind
    AND status IN ('PENDING','RUNNING','FAILED')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- Rapid duplicate clicks do not create mail floods or invalidate a link
    -- that may already be in flight. A failed job may be explicitly nudged
    -- back to PENDING once the user asks again.
    IF v_existing.status='FAILED'
       AND v_existing.updated_at<=now()-interval '60 seconds' THEN
      UPDATE public.auth_mail_delivery
      SET status='PENDING',
          retry_at=now(),
          claimed_at=NULL,
          last_error_code=NULL,
          updated_at=now()
      WHERE id=v_existing.id;
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  INSERT INTO public.auth_mail_delivery(user_id,kind)
  VALUES(p_user_id,p_kind);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_auth_mail()
RETURNS TABLE(
  job_id uuid,
  user_id uuid,
  recipient_email text,
  kind text,
  attempts integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_job public.auth_mail_delivery%ROWTYPE;
BEGIN
  SELECT q.*
  INTO v_job
  FROM public.auth_mail_delivery q
  JOIN public.app_user u ON u.id=q.user_id
  WHERE u.status='ACTIVE'
    AND q.attempts<8
    AND (
      (
        q.status IN ('PENDING','FAILED')
        AND q.retry_at<=now()
      )
      OR (
        q.status='RUNNING'
        AND q.claimed_at<now()-interval '10 minutes'
      )
    )
  ORDER BY q.created_at,q.id
  FOR UPDATE OF q SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.auth_mail_delivery
  SET status='RUNNING',
      attempts=attempts+1,
      claimed_at=now(),
      updated_at=now(),
      last_error_code=NULL
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT v_job.id,u.id,u.email,v_job.kind,v_job.attempts+1
  FROM public.app_user u
  WHERE u.id=v_job.user_id AND u.status='ACTIVE';
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_issue_auth_mail_token(
  p_job_id uuid,
  p_token_hash text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_job public.auth_mail_delivery%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'AUTH_MAIL_TOKEN_HASH_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_job
  FROM public.auth_mail_delivery
  WHERE id=p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.status<>'RUNNING' THEN
    RETURN false;
  END IF;

  -- Lock user before token rows to keep the same deadlock order as auth API.
  PERFORM 1
  FROM public.app_user
  WHERE id=v_job.user_id AND status='ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_job.kind='EMAIL_VERIFICATION' THEN
    IF EXISTS(
      SELECT 1 FROM public.app_user
      WHERE id=v_job.user_id AND email_verified_at IS NOT NULL
    ) THEN
      UPDATE public.auth_mail_delivery
      SET status='SENT',sent_at=now(),updated_at=now(),
          last_error_code=NULL
      WHERE id=v_job.id;
      RETURN false;
    END IF;

    UPDATE public.email_verification_token
    SET consumed_at=now()
    WHERE user_id=v_job.user_id AND consumed_at IS NULL;

    INSERT INTO public.email_verification_token(
      user_id,token_hash,expires_at
    ) VALUES(
      v_job.user_id,p_token_hash,now()+interval '24 hours'
    );
  ELSIF v_job.kind='PASSWORD_RESET' THEN
    UPDATE public.password_reset_token
    SET consumed_at=now()
    WHERE user_id=v_job.user_id AND consumed_at IS NULL;

    INSERT INTO public.password_reset_token(
      user_id,token_hash,expires_at
    ) VALUES(
      v_job.user_id,p_token_hash,now()+interval '30 minutes'
    );
  ELSE
    RAISE EXCEPTION 'AUTH_MAIL_KIND_INVALID' USING ERRCODE='22023';
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_complete_auth_mail(
  p_job_id uuid,
  p_provider_job_id text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF p_provider_job_id IS NULL
     OR length(btrim(p_provider_job_id)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'AUTH_MAIL_PROVIDER_ID_INVALID' USING ERRCODE='22023';
  END IF;

  UPDATE public.auth_mail_delivery
  SET status='SENT',
      provider_job_id=btrim(p_provider_job_id),
      sent_at=now(),
      claimed_at=NULL,
      last_error_code=NULL,
      updated_at=now()
  WHERE id=p_job_id AND status='RUNNING';

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_fail_auth_mail(
  p_job_id uuid,
  p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_attempts integer;
BEGIN
  SELECT attempts INTO v_attempts
  FROM public.auth_mail_delivery
  WHERE id=p_job_id AND status='RUNNING'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.auth_mail_delivery
  SET status='FAILED',
      retry_at=now()+CASE
        WHEN v_attempts<=1 THEN interval '1 minute'
        WHEN v_attempts=2 THEN interval '5 minutes'
        WHEN v_attempts=3 THEN interval '15 minutes'
        WHEN v_attempts=4 THEN interval '1 hour'
        ELSE interval '6 hours'
      END,
      claimed_at=NULL,
      last_error_code=left(
        regexp_replace(
          COALESCE(NULLIF(btrim(p_error_code),''),'DELIVERY_FAILED'),
          '[^A-Z0-9_.:-]','_','g'
        ),
        120
      ),
      updated_at=now()
  WHERE id=p_job_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_mark_auth_mail_bounced(
  p_provider_job_id text,
  p_reason_code text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  UPDATE public.auth_mail_delivery
  SET status='BOUNCED',
      last_error_code=left(
        regexp_replace(
          COALESCE(NULLIF(btrim(p_reason_code),''),'BOUNCED'),
          '[^A-Z0-9_.:-]','_','g'
        ),
        120
      ),
      updated_at=now()
  WHERE provider_job_id=p_provider_job_id
    AND status='SENT';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.corebiz_enqueue_auth_mail(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_auth_mail() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_issue_auth_mail_token(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_complete_auth_mail(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_fail_auth_mail(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_mark_auth_mail_bounced(text,text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION public.corebiz_enqueue_auth_mail(uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_claim_auth_mail()
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_issue_auth_mail_token(uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_complete_auth_mail(uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_fail_auth_mail(uuid,text)
      TO corebiz_app;
  END IF;
END;
$$;

COMMIT;

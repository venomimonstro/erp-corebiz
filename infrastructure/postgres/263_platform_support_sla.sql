BEGIN;

-- SaaS support is a platform workflow, not tenant impersonation. The customer
-- keeps tenant-scoped support APIs while platform operators work through
-- session-proved SECURITY DEFINER functions exposing support data only.

ALTER TABLE support_ticket
  ADD COLUMN IF NOT EXISTS first_response_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_level smallint NOT NULL DEFAULT 0
    CHECK(escalation_level BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS last_escalated_at timestamptz;

ALTER TABLE support_message
  ADD COLUMN IF NOT EXISTS author_operator_user_id uuid
    REFERENCES app_user(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.corebiz_support_sla_deadlines(
  p_priority text,
  p_started_at timestamptz
)
RETURNS TABLE(first_response_due_at timestamptz,resolution_due_at timestamptz)
LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT
    p_started_at + CASE p_priority
      WHEN 'URGENT' THEN interval '15 minutes'
      WHEN 'HIGH' THEN interval '1 hour'
      WHEN 'NORMAL' THEN interval '4 hours'
      ELSE interval '1 day'
    END,
    p_started_at + CASE p_priority
      WHEN 'URGENT' THEN interval '4 hours'
      WHEN 'HIGH' THEN interval '8 hours'
      WHEN 'NORMAL' THEN interval '2 days'
      ELSE interval '5 days'
    END
$$;

CREATE OR REPLACE FUNCTION public.corebiz_support_apply_sla()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_first timestamptz;
  v_resolution timestamptz;
BEGIN
  SELECT d.first_response_due_at,d.resolution_due_at
  INTO v_first,v_resolution
  FROM public.corebiz_support_sla_deadlines(
    NEW.priority,COALESCE(NEW.created_at,now())
  ) d;

  NEW.first_response_due_at:=COALESCE(NEW.first_response_due_at,v_first);
  NEW.resolution_due_at:=COALESCE(NEW.resolution_due_at,v_resolution);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_ticket_sla_defaults_v1 ON support_ticket;
CREATE TRIGGER support_ticket_sla_defaults_v1
BEFORE INSERT ON support_ticket
FOR EACH ROW EXECUTE FUNCTION public.corebiz_support_apply_sla();

UPDATE support_ticket
SET first_response_due_at=COALESCE(
      first_response_due_at,
      created_at + CASE priority
        WHEN 'URGENT' THEN interval '15 minutes'
        WHEN 'HIGH' THEN interval '1 hour'
        WHEN 'NORMAL' THEN interval '4 hours'
        ELSE interval '1 day'
      END
    ),
    resolution_due_at=COALESCE(
      resolution_due_at,
      created_at + CASE priority
        WHEN 'URGENT' THEN interval '4 hours'
        WHEN 'HIGH' THEN interval '8 hours'
        WHEN 'NORMAL' THEN interval '2 days'
        ELSE interval '5 days'
      END
    )
WHERE first_response_due_at IS NULL
   OR resolution_due_at IS NULL;

CREATE INDEX IF NOT EXISTS support_ticket_sla_queue_idx
  ON support_ticket(
    status,first_response_due_at,resolution_due_at,last_escalated_at
  )
  WHERE status NOT IN ('RESOLVED','CLOSED');

CREATE TABLE support_sla_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  escalation_level smallint NOT NULL CHECK(escalation_level BETWEEN 1 AND 3),
  breach_type text NOT NULL CHECK(breach_type IN ('FIRST_RESPONSE','RESOLUTION')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_sla_event_ticket_idx
  ON support_sla_event(tenant_id,ticket_id,created_at DESC);

ALTER TABLE support_sla_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_sla_event_isolation ON support_sla_event
  USING(
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK(
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE OR REPLACE FUNCTION public.corebiz_platform_operator_session_ok(
  p_user_id uuid,
  p_session_hash text
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT p_session_hash IS NOT NULL
    AND p_session_hash ~ '^[0-9a-f]{64}$'
    AND EXISTS(
      SELECT 1
      FROM public.platform_operator op
      JOIN public.app_user u ON u.id=op.user_id
      JOIN public.user_session s ON s.user_id=u.id
      WHERE op.user_id=p_user_id
        AND op.status='ACTIVE'
        AND u.status='ACTIVE'
        AND s.session_hash=p_session_hash
        AND s.revoked_at IS NULL
        AND s.expires_at>now()
    )
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_queue(
  p_user_id uuid,
  p_session_hash text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_output jsonb;
BEGIN
  IF NOT public.corebiz_platform_operator_session_ok(
    p_user_id,p_session_hash
  ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100
     OR p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_INVALID_PAGE' USING ERRCODE='22023';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'total',(
      SELECT count(*) FROM public.support_ticket
      WHERE status<>'CLOSED'
    ),
    'items',COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ticketId',q.id,
        'tenantId',q.tenant_id,
        'companyName',q.company_name,
        'number',q.business_number,
        'subject',q.subject,
        'status',q.status,
        'priority',q.priority,
        'category',q.category,
        'createdAt',q.created_at,
        'updatedAt',q.updated_at,
        'firstResponseDueAt',q.first_response_due_at,
        'resolutionDueAt',q.resolution_due_at,
        'firstRespondedAt',q.first_responded_at,
        'slaBreachedAt',q.sla_breached_at,
        'escalationLevel',q.escalation_level
      )
      ORDER BY
        q.escalation_level DESC,
        q.priority_rank,
        LEAST(q.first_response_due_at,q.resolution_due_at),
        q.created_at
    ),'[]'::jsonb)
  )
  INTO v_output
  FROM (
    SELECT st.id,st.tenant_id,t.name AS company_name,
      st.business_number,st.subject,st.status,st.priority,st.category,
      st.created_at,st.updated_at,st.first_response_due_at,
      st.resolution_due_at,st.first_responded_at,st.sla_breached_at,
      st.escalation_level,
      CASE st.priority
        WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
        WHEN 'NORMAL' THEN 2 ELSE 3
      END AS priority_rank
    FROM public.support_ticket st
    JOIN public.tenant t ON t.id=st.tenant_id
    WHERE st.status<>'CLOSED'
    ORDER BY
      st.escalation_level DESC,
      priority_rank,
      LEAST(st.first_response_due_at,st.resolution_due_at),
      st.created_at
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN v_output;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_ticket(
  p_user_id uuid,
  p_session_hash text,
  p_ticket_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_output jsonb;
BEGIN
  IF NOT public.corebiz_platform_operator_session_ok(
    p_user_id,p_session_hash
  ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'ticket',pg_catalog.jsonb_build_object(
      'ticketId',st.id,'tenantId',st.tenant_id,'companyName',t.name,
      'number',st.business_number,'subject',st.subject,'status',st.status,
      'priority',st.priority,'category',st.category,
      'contextUrl',st.context_url,'createdAt',st.created_at,
      'updatedAt',st.updated_at,
      'firstResponseDueAt',st.first_response_due_at,
      'resolutionDueAt',st.resolution_due_at,
      'firstRespondedAt',st.first_responded_at,
      'slaBreachedAt',st.sla_breached_at,
      'escalationLevel',st.escalation_level
    ),
    'messages',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',m.id,'body',m.body,'createdAt',m.created_at,
          'authorKind',CASE
            WHEN m.author_operator_user_id IS NOT NULL THEN 'OPERATOR'
            ELSE 'CUSTOMER'
          END
        ) ORDER BY m.created_at,m.id
      )
      FROM public.support_message m
      WHERE m.ticket_id=st.id
        AND m.tenant_id=st.tenant_id
        AND m.visibility='PUBLIC'
    ),'[]'::jsonb),
    'attachments',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',a.id,'filename',a.filename,'mimeType',a.mime_type,
          'sizeBytes',a.size_bytes,'createdAt',a.created_at
        ) ORDER BY a.created_at,a.id
      )
      FROM public.support_attachment a
      WHERE a.ticket_id=st.id
        AND a.tenant_id=st.tenant_id
        AND a.verified_at IS NOT NULL
    ),'[]'::jsonb)
  )
  INTO v_output
  FROM public.support_ticket st
  JOIN public.tenant t ON t.id=st.tenant_id
  WHERE st.id=p_ticket_id;

  IF v_output IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_TICKET_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  RETURN v_output;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_reply(
  p_user_id uuid,
  p_session_hash text,
  p_ticket_id uuid,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_ticket public.support_ticket%ROWTYPE;
  v_message_id uuid;
  v_late boolean;
BEGIN
  IF NOT public.corebiz_platform_operator_session_ok(
    p_user_id,p_session_hash
  ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_REPLY_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_ticket
  WHERE id=p_ticket_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_TICKET_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  IF v_ticket.status='CLOSED' THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_TICKET_CLOSED' USING ERRCODE='23514';
  END IF;

  v_late:=v_ticket.first_responded_at IS NULL
    AND v_ticket.first_response_due_at<now();

  INSERT INTO public.support_message(
    tenant_id,ticket_id,author_membership_id,author_operator_user_id,
    body,visibility
  ) VALUES(
    v_ticket.tenant_id,v_ticket.id,NULL,p_user_id,btrim(p_body),'PUBLIC'
  ) RETURNING id INTO v_message_id;

  UPDATE public.support_ticket
  SET status='WAITING_CUSTOMER',
      first_responded_at=COALESCE(first_responded_at,now()),
      sla_breached_at=CASE
        WHEN v_late THEN COALESCE(sla_breached_at,now())
        ELSE sla_breached_at
      END,
      updated_at=now()
  WHERE id=v_ticket.id;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,action,resource_type,resource_id,after_data
  ) VALUES(
    v_ticket.tenant_id,p_user_id,'support.operator_reply',
    'support_ticket',v_ticket.id::text,
    pg_catalog.jsonb_build_object('messageId',v_message_id)
  );

  RETURN pg_catalog.jsonb_build_object(
    'messageId',v_message_id,'ticketId',v_ticket.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_close(
  p_user_id uuid,
  p_session_hash text,
  p_ticket_id uuid,
  p_resolution text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_ticket public.support_ticket%ROWTYPE;
  v_message_id uuid;
BEGIN
  IF NOT public.corebiz_platform_operator_session_ok(
    p_user_id,p_session_hash
  ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_resolution IS NULL
     OR length(btrim(p_resolution)) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_RESOLUTION_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_ticket
  WHERE id=p_ticket_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLATFORM_SUPPORT_TICKET_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  IF v_ticket.status='CLOSED' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ticketId',v_ticket.id,'status','CLOSED'
    );
  END IF;

  INSERT INTO public.support_message(
    tenant_id,ticket_id,author_membership_id,author_operator_user_id,
    body,visibility
  ) VALUES(
    v_ticket.tenant_id,v_ticket.id,NULL,p_user_id,
    'Результат обращения: '||btrim(p_resolution),'PUBLIC'
  ) RETURNING id INTO v_message_id;

  UPDATE public.support_ticket
  SET status='CLOSED',
      first_responded_at=COALESCE(first_responded_at,now()),
      sla_breached_at=CASE
        WHEN (
          (first_responded_at IS NULL AND first_response_due_at<now())
          OR resolution_due_at<now()
        ) THEN COALESCE(sla_breached_at,now())
        ELSE sla_breached_at
      END,
      resolved_at=COALESCE(resolved_at,now()),
      closed_at=now(),updated_at=now()
  WHERE id=v_ticket.id;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,action,resource_type,resource_id,after_data
  ) VALUES(
    v_ticket.tenant_id,p_user_id,'support.operator_closed',
    'support_ticket',v_ticket.id::text,
    pg_catalog.jsonb_build_object(
      'messageId',v_message_id,'resolutionRecorded',true
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'ticketId',v_ticket.id,'status','CLOSED'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_attachment(
  p_user_id uuid,
  p_session_hash text,
  p_attachment_id uuid
)
RETURNS TABLE(object_key text,filename text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NOT public.corebiz_platform_operator_session_ok(
    p_user_id,p_session_hash
  ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  RETURN QUERY
  SELECT a.object_key,a.filename
  FROM public.support_attachment a
  WHERE a.id=p_attachment_id
    AND a.verified_at IS NOT NULL
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_support_sla_escalation()
RETURNS TABLE(
  ticket_id uuid,tenant_id uuid,business_number text,priority text,
  escalation_level smallint,breach_type text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_ticket public.support_ticket%ROWTYPE;
  v_type text;
  v_next smallint;
BEGIN
  SELECT st.*
  INTO v_ticket
  FROM public.support_ticket st
  WHERE st.status NOT IN ('RESOLVED','CLOSED')
    AND (
      (
        st.first_responded_at IS NULL
        AND st.first_response_due_at<=now()
      )
      OR st.resolution_due_at<=now()
    )
    AND st.escalation_level<3
    AND (
      st.last_escalated_at IS NULL
      OR st.last_escalated_at<=now()-CASE st.escalation_level
        WHEN 0 THEN interval '0 minutes'
        WHEN 1 THEN interval '2 hours'
        ELSE interval '8 hours'
      END
    )
  ORDER BY
    st.escalation_level DESC,
    LEAST(st.first_response_due_at,st.resolution_due_at),
    st.created_at
  FOR UPDATE OF st SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  v_type:=CASE
    WHEN v_ticket.first_responded_at IS NULL
      AND v_ticket.first_response_due_at<=now()
    THEN 'FIRST_RESPONSE'
    ELSE 'RESOLUTION'
  END;
  v_next:=LEAST(3,v_ticket.escalation_level+1)::smallint;

  UPDATE public.support_ticket
  SET escalation_level=v_next,
      sla_breached_at=COALESCE(sla_breached_at,now()),
      last_escalated_at=now(),
      updated_at=now()
  WHERE id=v_ticket.id;

  INSERT INTO public.support_sla_event(
    tenant_id,ticket_id,escalation_level,breach_type
  ) VALUES(v_ticket.tenant_id,v_ticket.id,v_next,v_type);

  RETURN QUERY SELECT
    v_ticket.id,v_ticket.tenant_id,v_ticket.business_number,
    v_ticket.priority,v_next,v_type;
END;
$$;

REVOKE ALL ON FUNCTION public.corebiz_support_sla_deadlines(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_support_apply_sla() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_platform_operator_session_ok(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_platform_support_queue(uuid,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_platform_support_ticket(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_platform_support_reply(uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_platform_support_close(uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_platform_support_attachment(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_support_sla_escalation() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION public.corebiz_platform_support_queue(uuid,text,integer,integer)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_platform_support_ticket(uuid,text,uuid)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_platform_support_reply(uuid,text,uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_platform_support_close(uuid,text,uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_platform_support_attachment(uuid,text,uuid)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_claim_support_sla_escalation()
      TO corebiz_app;
  END IF;
END;
$$;

COMMIT;

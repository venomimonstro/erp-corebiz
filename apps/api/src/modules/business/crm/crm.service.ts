import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";

@Injectable()
export class CrmService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async board(
    context: TenantContext,
    pipelineId?: string
  ): Promise<{
    pipeline: { id: string; name: string };
    stages: Array<{
      id: string;
      name: string;
      kind: string;
      position: number;
      color: string | null;
      deals: Array<{
        id: string;
        title: string;
        amountMinor: string;
        currency: string;
        partyName: string | null;
        responsibleMembershipId: string | null;
        version: number;
        hasNextAction: boolean;
        overdueTasks: number;
      }>;
    }>;
  }> {
    const scope = await this.authorization.resolveScope(context, "crm.read");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      const pipelineResult = await client.query<{ id: string; name: string }>(
        `SELECT id, name
         FROM crm_pipeline
         WHERE tenant_id = $1
           AND status = 'ACTIVE'
           AND ($2::uuid IS NULL OR id = $2)
         ORDER BY
           CASE WHEN id = $2::uuid THEN 0 ELSE 1 END,
           is_default DESC,
           created_at ASC
         LIMIT 1`,
        [context.tenantId, pipelineId ?? null]
      );

      const pipeline = pipelineResult.rows[0];
      if (!pipeline) throw new NotFoundException("Воронка не найдена");

      const stagesResult = await client.query<{
        id: string;
        name: string;
        kind: string;
        position: number;
        color: string | null;
      }>(
        `SELECT id, name, kind, position, color
         FROM crm_stage
         WHERE tenant_id = $1 AND pipeline_id = $2
         ORDER BY position ASC`,
        [context.tenantId, pipeline.id]
      );

      const values: unknown[] = [context.tenantId, pipeline.id];
      let scopeSql = "";

      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql = "AND d.responsible_membership_id = ANY($3::uuid[])";
      }

      const dealsResult = await client.query<{
        id: string;
        stage_id: string;
        title: string;
        amount_minor: string;
        currency: string;
        party_name: string | null;
        responsible_membership_id: string | null;
        version: number;
        has_next_action: boolean;
        overdue_tasks: string;
      }>(
        `SELECT
           d.id,
           d.stage_id,
           d.title,
           d.amount_minor::text,
           d.currency,
           p.display_name AS party_name,
           d.responsible_membership_id,
           d.version,
           EXISTS (
             SELECT 1 FROM task t
             WHERE t.tenant_id = d.tenant_id
               AND t.linked_type = 'DEAL'
               AND t.linked_id = d.id
               AND t.state IN ('OPEN','IN_PROGRESS','WAITING')
           ) AS has_next_action,
           (
             SELECT count(*)::text FROM task t
             WHERE t.tenant_id = d.tenant_id
               AND t.linked_type = 'DEAL'
               AND t.linked_id = d.id
               AND t.state IN ('OPEN','IN_PROGRESS','WAITING')
               AND t.due_at < now()
           ) AS overdue_tasks
         FROM crm_deal d
         LEFT JOIN party p ON p.id = d.party_id
         WHERE d.tenant_id = $1
           AND d.pipeline_id = $2
           ${scopeSql}
         ORDER BY d.updated_at DESC
         LIMIT 1000`,
        values
      );

      return {
        pipeline,
        stages: stagesResult.rows.map((stage) => ({
          id: stage.id,
          name: stage.name,
          kind: stage.kind,
          position: stage.position,
          color: stage.color,
          deals: dealsResult.rows
            .filter((deal) => deal.stage_id === stage.id)
            .map((deal) => ({
              id: deal.id,
              title: deal.title,
              amountMinor: deal.amount_minor,
              currency: deal.currency,
              partyName: deal.party_name,
              responsibleMembershipId: deal.responsible_membership_id,
              version: deal.version,
              hasNextAction: deal.has_next_action,
              overdueTasks: Number(deal.overdue_tasks)
            }))
        }))
      };
    });
  }

  async createDeal(
    context: TenantContext,
    input: {
      title: string;
      pipelineId?: string;
      stageId?: string;
      partyId?: string;
      amountMinor?: string;
      responsibleMembershipId?: string;
      source?: string;
    }
  ): Promise<{ id: string; version: number }> {
    const scope = await this.authorization.resolveScope(context, "crm.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    const title = input.title.trim();
    if (title.length < 2 || title.length > 240) {
      throw new BadRequestException("Некорректное название сделки");
    }

    const amountMinor = input.amountMinor ?? "0";
    if (!/^\d+$/.test(amountMinor)) {
      throw new BadRequestException("Некорректная сумма");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const pipeline = await client.query<{ id: string }>(
        `SELECT id FROM crm_pipeline
         WHERE tenant_id = $1
           AND status = 'ACTIVE'
           AND ($2::uuid IS NULL OR id = $2)
         ORDER BY
           CASE WHEN id = $2::uuid THEN 0 ELSE 1 END,
           is_default DESC,
           created_at ASC
         LIMIT 1`,
        [context.tenantId, input.pipelineId ?? null]
      );

      const pipelineId = pipeline.rows[0]?.id;
      if (!pipelineId) throw new NotFoundException("Воронка не найдена");

      const stage = await client.query<{ id: string }>(
        `SELECT id FROM crm_stage
         WHERE tenant_id = $1
           AND pipeline_id = $2
           AND kind = 'NORMAL'
           AND ($3::uuid IS NULL OR id = $3)
         ORDER BY
           CASE WHEN id = $3::uuid THEN 0 ELSE 1 END,
           position ASC
         LIMIT 1`,
        [context.tenantId, pipelineId, input.stageId ?? null]
      );

      const stageId = stage.rows[0]?.id;
      if (!stageId) throw new NotFoundException("Этап не найден");

      const responsible =
        input.responsibleMembershipId ?? context.membershipId;

      if (
        scopedMembershipIds &&
        !scopedMembershipIds.includes(responsible)
      ) {
        throw new BadRequestException("Ответственный сотрудник недоступен");
      }

      const responsibleCheck = await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'ACTIVE'`,
        [context.tenantId, responsible]
      );

      if (!responsibleCheck.rowCount) {
        throw new BadRequestException("Ответственный сотрудник недоступен");
      }

      if (input.partyId) {
        const partyCheck = await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id = $1
             AND id = $2
             AND status = 'ACTIVE'`,
          [context.tenantId, input.partyId]
        );

        if (!partyCheck.rowCount) {
          throw new BadRequestException("Клиент недоступен");
        }
      }

      const result = await client.query<{ id: string; version: number }>(
        `INSERT INTO crm_deal(
           tenant_id, pipeline_id, stage_id, party_id,
           responsible_membership_id, title, amount_minor, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, version`,
        [
          context.tenantId,
          pipelineId,
          stageId,
          input.partyId ?? null,
          responsible,
          title,
          amountMinor,
          input.source?.trim() || null
        ]
      );

      const deal = result.rows[0];
      if (!deal) throw new Error("DEAL_CREATE_FAILED");

      await client.query(
        `INSERT INTO crm_deal_stage_history(
           tenant_id, deal_id, to_stage_id, actor_membership_id
         ) VALUES ($1,$2,$3,$4)`,
        [context.tenantId, deal.id, stageId, context.membershipId]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id
         ) VALUES ($1,$2,$3,'crm.deal_created','crm_deal',$4)`,
        [context.tenantId, context.userId, context.membershipId, deal.id]
      );

      return deal;
    });
  }

  async moveDeal(
    context: TenantContext,
    dealId: string,
    input: { toStageId: string; version: number; lostReason?: string }
  ): Promise<{ id: string; stageId: string; version: number }> {
    const scope = await this.authorization.resolveScope(context, "crm.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const scopedMembershipIds =
      await this.authorization.membershipIdsForScope(context, scope);

    return this.database.withTenantTransaction(context, async (client) => {
      const dealResult = await client.query<{
        id: string;
        pipeline_id: string;
        stage_id: string;
        responsible_membership_id: string | null;
        version: number;
      }>(
        `SELECT id, pipeline_id, stage_id, responsible_membership_id, version
         FROM crm_deal
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [context.tenantId, dealId]
      );

      const deal = dealResult.rows[0];
      if (!deal) throw new NotFoundException("Сделка не найдена");

      if (
        scopedMembershipIds &&
        (!deal.responsible_membership_id ||
          !scopedMembershipIds.includes(deal.responsible_membership_id))
      ) {
        throw new NotFoundException("Сделка не найдена");
      }

      if (deal.version !== input.version) {
        throw new ConflictException(
          "Сделка уже изменена другим пользователем. Обновите данные."
        );
      }

      const stageResult = await client.query<{
        id: string;
        kind: string;
      }>(
        `SELECT id, kind
         FROM crm_stage
         WHERE tenant_id = $1
           AND pipeline_id = $2
           AND id = $3`,
        [context.tenantId, deal.pipeline_id, input.toStageId]
      );

      const target = stageResult.rows[0];
      if (!target) throw new BadRequestException("Недопустимый этап");

      if (target.kind === "LOST" && !input.lostReason?.trim()) {
        throw new BadRequestException("Укажите причину проигрыша сделки");
      }

      const updated = await client.query<{
        id: string;
        stage_id: string;
        version: number;
      }>(
        `UPDATE crm_deal
         SET stage_id = $3,
             lost_reason = CASE WHEN $4 = 'LOST' THEN $5 ELSE NULL END,
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, stage_id, version`,
        [
          context.tenantId,
          deal.id,
          target.id,
          target.kind,
          input.lostReason?.trim() ?? null
        ]
      );

      await client.query(
        `INSERT INTO crm_deal_stage_history(
           tenant_id, deal_id, from_stage_id, to_stage_id, actor_membership_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          context.tenantId,
          deal.id,
          deal.stage_id,
          target.id,
          context.membershipId
        ]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, before_data, after_data
         ) VALUES ($1,$2,$3,'crm.deal_stage_changed','crm_deal',$4,$5,$6)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          deal.id,
          JSON.stringify({ stageId: deal.stage_id, version: deal.version }),
          JSON.stringify({ stageId: target.id })
        ]
      );

      const row = updated.rows[0];
      if (!row) throw new Error("DEAL_MOVE_FAILED");

      return {
        id: row.id,
        stageId: row.stage_id,
        version: row.version
      };
    });
  }
  async nextAction(
    context:TenantContext,dealId:string,
    input:{title:string;dueAt:string;idempotencyKey:string}
  ):Promise<{taskId:string;dealId:string;dueAt:string}>{
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(!scope)throw new BadRequestException("Недостаточно прав");
    const ids=await this.authorization.membershipIdsForScope(context,scope);
    const title=input?.title?.trim();
    const key=input?.idempotencyKey?.trim();
    const time=Date.parse(input?.dueAt??"");
    if(!title||title.length>240 || !key||key.length<8||key.length>120 ||
       !Number.isFinite(time)||
       time<Date.now()-300000 || time>Date.now()+366*86400000){
      throw new BadRequestException("Укажите действие, срок и ключ запроса");
    }
    const iso=new Date(time).toISOString();
    const fingerprint=createHash("sha256").update(JSON.stringify({title,dueAt:iso}))
      .digest("hex");
    return this.database.withTenantTransaction(context,async client=>{
      const deal=await client.query<{
        id:string;responsible_membership_id:string|null;
      }>(
        `SELECT id,responsible_membership_id FROM crm_deal
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,dealId]);
      const row=deal.rows[0];
      if(!row || (ids && (!row.responsible_membership_id ||
          !ids.includes(row.responsible_membership_id))))
        throw new NotFoundException("Сделка не найдена");
      const prior=await client.query<{
        task_id:string;payload_fingerprint:string;
      }>(
        `SELECT task_id,payload_fingerprint FROM crm_next_action
         WHERE tenant_id=$1 AND deal_id=$2 AND idempotency_key=$3`,
        [context.tenantId,dealId,key]);
      if(prior.rows[0]){
        if(prior.rows[0].payload_fingerprint!==fingerprint)
          throw new ConflictException(
            "Ключ действия уже использован для другого содержания");
        return {taskId:prior.rows[0].task_id,dealId,dueAt:iso};
      }
      const task=await client.query<{id:string}>(
        `INSERT INTO task(
           tenant_id,title,type,responsible_membership_id,due_at,
           linked_type,linked_id,created_by_membership_id
         ) VALUES($1,$2,'FOLLOW_UP',$3,$4,'DEAL',$5,$6) RETURNING id`,
        [context.tenantId,title,row.responsible_membership_id??context.membershipId,
          iso,dealId,context.membershipId]);
      const taskId=task.rows[0]!.id;
      await client.query(
        `INSERT INTO crm_next_action(
           tenant_id,deal_id,task_id,idempotency_key,payload_fingerprint
         ) VALUES($1,$2,$3,$4,$5)`,
        [context.tenantId,dealId,taskId,key,fingerprint]);
      await client.query(
        `UPDATE crm_deal SET next_action_at=$3,next_action_title=$4,
           updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId,dealId,iso,title]);
      await client.query(
        `INSERT INTO crm_activity(
           tenant_id,deal_id,activity_type,subject,body,due_at,
           responsible_membership_id,created_by_membership_id,
           source_type,source_id
         ) VALUES($1,$2,'TASK',$3,'Назначено следующее действие',$4,$5,$6,'TASK',$7)`,
        [context.tenantId,dealId,title,iso,
          row.responsible_membership_id??context.membershipId,
          context.membershipId,taskId]);
      return {taskId,dealId,dueAt:iso};
    });
  }

  async pipelines(context:TenantContext) {
    const scope=await this.authorization.resolveScope(context,"crm.read");
    if(!scope) throw new BadRequestException("Недостаточно прав");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.name,p.is_default,p.status,
           coalesce(json_agg(json_build_object(
             'id',s.id,'name',s.name,'kind',s.kind,
             'position',s.position,'probability',s.probability,'color',s.color
           ) ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL),'[]'::json) AS stages
         FROM crm_pipeline p
         LEFT JOIN crm_stage s
           ON s.tenant_id=p.tenant_id AND s.pipeline_id=p.id
         WHERE p.tenant_id=$1 AND p.status='ACTIVE'
         GROUP BY p.id
         ORDER BY p.is_default DESC,p.created_at`,
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createPipeline(
    context:TenantContext,
    input:{
      name:string;
      stages?:Array<{name:string;probability?:number;color?:string}>;
    }
  ) {
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(scope!=="all"){
      throw new BadRequestException("Создание воронок доступно администратору CRM");
    }
    const name=input.name?.trim();
    if(!name||name.length>120){
      throw new BadRequestException("Некорректное название воронки");
    }
    const stages=(input.stages?.length?input.stages:[
      {name:"Новая",probability:10},
      {name:"Квалификация",probability:25},
      {name:"КП / оценка",probability:50},
      {name:"Переговоры",probability:75}
    ]).slice(0,20);

    return this.database.withTenantTransaction(context,async client=>{
      const pipeline=await client.query<{id:string}>(
        `INSERT INTO crm_pipeline(tenant_id,name,is_default)
         VALUES($1,$2,false) RETURNING id`,
        [context.tenantId,name]
      );
      const id=pipeline.rows[0]!.id;
      let position=10;
      for(const stage of stages){
        const stageName=stage.name?.trim();
        if(!stageName) continue;
        const probability=Math.max(0,Math.min(100,Math.floor(stage.probability??0)));
        await client.query(
          `INSERT INTO crm_stage(
             tenant_id,pipeline_id,name,kind,position,probability,color
           ) VALUES($1,$2,$3,'NORMAL',$4,$5,$6)`,
          [
            context.tenantId,id,stageName,position,probability,
            stage.color?.trim()||null
          ]
        );
        position+=10;
      }
      await client.query(
        `INSERT INTO crm_stage(
           tenant_id,pipeline_id,name,kind,position,probability,color
         ) VALUES
           ($1,$2,'Успешно','WON',900,100,'#10B981'),
           ($1,$2,'Проиграно','LOST',1000,0,'#EF4444')`,
        [context.tenantId,id]
      );
      return {id};
    });
  }

  async dealDetails(context:TenantContext,dealId:string) {
    const scope=await this.authorization.resolveScope(context,"crm.read");
    if(!scope) throw new BadRequestException("Недостаточно прав");
    const scoped=await this.authorization.membershipIdsForScope(context,scope);
    return this.database.withTenantTransaction(context,async client=>{
      const deal=await client.query<any>(
        `SELECT
           d.*,p.display_name AS party_name,
           s.name AS stage_name,s.kind AS stage_kind,
           pl.name AS pipeline_name,
           tm.user_id AS responsible_user_id
         FROM crm_deal d
         JOIN crm_stage s
           ON s.tenant_id=d.tenant_id AND s.id=d.stage_id
         JOIN crm_pipeline pl
           ON pl.tenant_id=d.tenant_id AND pl.id=d.pipeline_id
         LEFT JOIN party p
           ON p.tenant_id=d.tenant_id AND p.id=d.party_id
         LEFT JOIN tenant_membership tm
           ON tm.tenant_id=d.tenant_id AND tm.id=d.responsible_membership_id
         WHERE d.tenant_id=$1 AND d.id=$2
           AND (
             $3::uuid[] IS NULL
             OR d.responsible_membership_id=ANY($3::uuid[])
           )`,
        [context.tenantId,dealId,scoped]
      );
      const row=deal.rows[0];
      if(!row) throw new NotFoundException("Сделка не найдена");

      const [contacts,tags,notes,activities,tasks,history]=await Promise.all([
        row.party_id?client.query(
          `SELECT id,type,value,label,is_primary
           FROM party_contact
           WHERE tenant_id=$1 AND party_id=$2
           ORDER BY is_primary DESC,created_at`,
          [context.tenantId,row.party_id]
        ):Promise.resolve({rows:[]}),
        client.query(
          `SELECT t.id,t.name,t.color
           FROM crm_deal_tag dt
           JOIN crm_tag t ON t.tenant_id=dt.tenant_id AND t.id=dt.tag_id
           WHERE dt.tenant_id=$1 AND dt.deal_id=$2
           ORDER BY t.name`,
          [context.tenantId,dealId]
        ),
        client.query(
          `SELECT id,body,pinned,created_by_membership_id,created_at,updated_at
           FROM crm_note
           WHERE tenant_id=$1 AND deal_id=$2
           ORDER BY pinned DESC,created_at DESC
           LIMIT 200`,
          [context.tenantId,dealId]
        ),
        client.query(
          `SELECT *
           FROM crm_activity
           WHERE tenant_id=$1 AND deal_id=$2
           ORDER BY happened_at DESC,id DESC
           LIMIT 300`,
          [context.tenantId,dealId]
        ),
        client.query(
          `SELECT
             id,title,type,state,priority,responsible_membership_id,
             due_at,completed_at,description
           FROM task
           WHERE tenant_id=$1 AND linked_type='DEAL' AND linked_id=$2
           ORDER BY
             CASE state WHEN 'DONE' THEN 1 WHEN 'CANCELLED' THEN 2 ELSE 0 END,
             due_at NULLS LAST,created_at DESC
           LIMIT 200`,
          [context.tenantId,dealId]
        ),
        client.query(
          `SELECT
             h.id,h.from_stage_id,h.to_stage_id,
             fs.name AS from_stage_name,ts.name AS to_stage_name,
             h.actor_membership_id,h.created_at
           FROM crm_deal_stage_history h
           LEFT JOIN crm_stage fs
             ON fs.tenant_id=h.tenant_id AND fs.id=h.from_stage_id
           JOIN crm_stage ts
             ON ts.tenant_id=h.tenant_id AND ts.id=h.to_stage_id
           WHERE h.tenant_id=$1 AND h.deal_id=$2
           ORDER BY h.created_at DESC
           LIMIT 100`,
          [context.tenantId,dealId]
        )
      ]);

      return {
        deal:row,
        contacts:contacts.rows,
        tags:tags.rows,
        notes:notes.rows,
        activities:activities.rows,
        tasks:tasks.rows,
        history:history.rows
      };
    });
  }

  async updateDeal(
    context:TenantContext,
    dealId:string,
    input:{
      title?:string;
      amountMinor?:string;
      priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";
      leadScore?:number;
      nextActionAt?:string|null;
      nextActionTitle?:string|null;
      expectedCloseDate?:string|null;
      responsibleMembershipId?:string;
      version:number;
    }
  ) {
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(!scope) throw new BadRequestException("Недостаточно прав");
    const scoped=await this.authorization.membershipIdsForScope(context,scope);
    if(!Number.isSafeInteger(input.version)||input.version<1){
      throw new BadRequestException("Некорректная версия сделки");
    }
    if(input.amountMinor!==undefined&&!/^\d+$/.test(input.amountMinor)){
      throw new BadRequestException("Некорректная сумма");
    }
    if(input.leadScore!==undefined&&(
      !Number.isSafeInteger(input.leadScore)||input.leadScore<0||input.leadScore>100
    )){
      throw new BadRequestException("Lead score должен быть от 0 до 100");
    }

    return this.database.withTenantTransaction(context,async client=>{
      const current=await client.query<any>(
        `SELECT *
         FROM crm_deal
         WHERE tenant_id=$1 AND id=$2
           AND ($3::uuid[] IS NULL OR responsible_membership_id=ANY($3::uuid[]))
         FOR UPDATE`,
        [context.tenantId,dealId,scoped]
      );
      const deal=current.rows[0];
      if(!deal) throw new NotFoundException("Сделка не найдена");
      if(Number(deal.version)!==input.version){
        throw new ConflictException("Сделка уже изменена другим пользователем");
      }
      if(input.responsibleMembershipId&&scoped&&
         !scoped.includes(input.responsibleMembershipId)){
        throw new BadRequestException("Ответственный сотрудник недоступен");
      }

      const result=await client.query(
        `UPDATE crm_deal
         SET title=coalesce($3,title),
             amount_minor=coalesce($4::bigint,amount_minor),
             priority=coalesce($5,priority),
             lead_score=coalesce($6,lead_score),
             next_action_at=$7,
             next_action_title=$8,
             expected_close_date=$9::date,
             responsible_membership_id=coalesce($10::uuid,responsible_membership_id),
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [
          context.tenantId,dealId,input.title?.trim()||null,
          input.amountMinor??null,input.priority??null,
          input.leadScore??null,
          input.nextActionAt===undefined?deal.next_action_at:input.nextActionAt,
          input.nextActionTitle===undefined?deal.next_action_title:
            input.nextActionTitle?.trim()||null,
          input.expectedCloseDate===undefined?deal.expected_close_date:
            input.expectedCloseDate,
          input.responsibleMembershipId??null
        ]
      );
      return result.rows[0];
    });
  }

  async addNote(
    context:TenantContext,
    dealId:string,
    input:{body:string;pinned?:boolean}
  ){
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(!scope) throw new BadRequestException("Недостаточно прав");
    const scoped=await this.authorization.membershipIdsForScope(context,scope);
    const body=input?.body?.trim();
    if(!body) throw new BadRequestException("Введите текст заметки");
    return this.database.withTenantTransaction(context,async client=>{
      const allowed=await client.query(
        `SELECT 1 FROM crm_deal WHERE tenant_id=$1 AND id=$2
          AND ($3::uuid[] IS NULL OR responsible_membership_id=ANY($3::uuid[]))`,
        [context.tenantId,dealId,scoped]);
      if(!allowed.rowCount)throw new NotFoundException("Сделка не найдена");
      const result=await client.query(
        `INSERT INTO crm_note(
           tenant_id,deal_id,body,pinned,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5)
         RETURNING *`,
        [context.tenantId,dealId,body,Boolean(input.pinned),context.membershipId]
      );
      await client.query(
        `INSERT INTO crm_activity(
           tenant_id,deal_id,activity_type,subject,body,
           created_by_membership_id
         ) VALUES($1,$2,'NOTE','Заметка',$3,$4)`,
        [context.tenantId,dealId,body,context.membershipId]
      );
      return result.rows[0];
    });
  }

  async addActivity(
    context:TenantContext,
    dealId:string,
    input:{
      activityType:"CALL"|"EMAIL"|"MEETING"|"MESSAGE"|"TASK";
      direction?:"INBOUND"|"OUTBOUND";
      subject?:string;
      body?:string;
      happenedAt?:string;
      dueAt?:string;
    }
  ){
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(!scope) throw new BadRequestException("Недостаточно прав");
    const scoped=await this.authorization.membershipIdsForScope(context,scope);
    if(!input || !["CALL","EMAIL","MEETING","MESSAGE","TASK"].includes(input.activityType)){
      throw new BadRequestException("Некорректный тип активности");
    }
    return this.database.withTenantTransaction(context,async client=>{
      const deal=await client.query<any>(
        "SELECT party_id,responsible_membership_id FROM crm_deal WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,dealId]
      );
      const row=deal.rows[0];
      if(!row || (scoped && (!row.responsible_membership_id ||
          !scoped.includes(row.responsible_membership_id))))
        throw new NotFoundException("Сделка не найдена");
      const happened=input.happenedAt?new Date(input.happenedAt):new Date();
      const due=input.dueAt?new Date(input.dueAt):null;
      if(Number.isNaN(happened.getTime())||(due&&Number.isNaN(due.getTime()))){
        throw new BadRequestException("Некорректная дата активности");
      }
      const activity=await client.query(
        `INSERT INTO crm_activity(
           tenant_id,deal_id,party_id,activity_type,direction,
           subject,body,happened_at,due_at,responsible_membership_id,
           created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          context.tenantId,dealId,row.party_id,input.activityType,
          input.direction??null,input.subject?.trim()||null,
          input.body?.trim()||null,happened,due,
          row.responsible_membership_id,context.membershipId
        ]
      );
      if(input.activityType==="TASK"&&due){
        await client.query(
          `INSERT INTO task(
             tenant_id,title,type,state,priority,responsible_membership_id,
             due_at,linked_type,linked_id,description,created_by_membership_id
           ) VALUES(
             $1,$2,'CRM','OPEN','NORMAL',$3,$4,'DEAL',$5,$6,$7
           )`,
          [
            context.tenantId,input.subject?.trim()||"Следующее действие",
            row.responsible_membership_id??context.membershipId,due,dealId,
            input.body?.trim()||null,context.membershipId
          ]
        );
      }
      return activity.rows[0];
    });
  }

  async tags(context:TenantContext){
    const scope=await this.authorization.resolveScope(context,"crm.read");
    if(!scope) throw new BadRequestException("Недостаточно прав");
    return this.database.withTenantTransaction(context,async client=>(
      await client.query(
        "SELECT id,name,color FROM crm_tag WHERE tenant_id=$1 ORDER BY name",
        [context.tenantId]
      )
    ).rows);
  }

  async createTag(
    context:TenantContext,
    input:{name:string;color?:string}
  ){
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(scope!=="all")throw new BadRequestException("Создавать теги может администратор CRM");
    const name=input?.name?.trim();
    if(!name||name.length>80) throw new BadRequestException("Некорректный тег");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `INSERT INTO crm_tag(tenant_id,name,color)
         VALUES($1,$2,$3)
         ON CONFLICT(tenant_id,name)
         DO UPDATE SET color=coalesce(EXCLUDED.color,crm_tag.color)
         RETURNING *`,
        [context.tenantId,name,input.color?.trim()||null]
      );
      return result.rows[0];
    });
  }

  async setDealTags(
    context:TenantContext,
    dealId:string,
    tagIds:string[]
  ){
    const scope=await this.authorization.resolveScope(context,"crm.write");
    if(!scope)throw new BadRequestException("Недостаточно прав");
    const scoped=await this.authorization.membershipIdsForScope(context,scope);
    if(!Array.isArray(tagIds)||tagIds.length>50||
       !tagIds.every(x=>typeof x==="string"))
      throw new BadRequestException("Некорректные теги");
    const ids=Array.from(new Set(tagIds));
    return this.database.withTenantTransaction(context,async client=>{
      const allowed=await client.query(
        `SELECT 1 FROM crm_deal WHERE tenant_id=$1 AND id=$2
         AND ($3::uuid[] IS NULL OR responsible_membership_id=ANY($3::uuid[]))`,
        [context.tenantId,dealId,scoped]);
      if(!allowed.rowCount)throw new NotFoundException("Сделка не найдена");
      const valid=ids.length?await client.query<{id:string}>(
        "SELECT id FROM crm_tag WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [context.tenantId,ids]
      ):{rows:[]};
      if(valid.rows.length!==ids.length){
        throw new BadRequestException("Один или несколько тегов недоступны");
      }
      await client.query(
        "DELETE FROM crm_deal_tag WHERE tenant_id=$1 AND deal_id=$2",
        [context.tenantId,dealId]
      );
      for(const id of ids){
        await client.query(
          `INSERT INTO crm_deal_tag(tenant_id,deal_id,tag_id)
           VALUES($1,$2,$3)`,
          [context.tenantId,dealId,id]
        );
      }
      return {updated:true,count:ids.length};
    });
  }

}

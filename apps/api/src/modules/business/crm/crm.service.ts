import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
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
}

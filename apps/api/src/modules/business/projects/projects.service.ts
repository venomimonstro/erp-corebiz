import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";

type ProjectStatus =
  | "PLANNED"
  | "ACTIVE"
  | "ON_HOLD"
  | "COMPLETED"
  | "CANCELLED";

@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async list(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.read"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId];
      let scopeSql = "";
      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql = "AND p.responsible_membership_id = ANY($2::uuid[])";
      }

      const result = await client.query(
        `SELECT
           p.id,p.business_number,p.name,p.code,p.status,p.billing_mode,
           p.party_id,party.display_name AS party_name,p.source_deal_id,
           p.responsible_membership_id,p.currency,p.budget_minor::text,
           p.hourly_rate_minor::text,p.estimated_minutes,p.starts_on,p.due_on,
           p.version,p.created_at,p.updated_at,
           COALESCE(time_stats.actual_minutes,0)::int AS actual_minutes,
           COALESCE(time_stats.billable_minutes,0)::int AS billable_minutes,
           COALESCE(time_stats.billable_value_minor,0)::text AS billable_value_minor,
           COALESCE(milestones.total,0)::int AS milestone_count,
           COALESCE(milestones.done,0)::int AS milestone_done,
           COALESCE(milestones.overdue,0)::int AS overdue_milestones,
           COALESCE(tasks.open_count,0)::int AS open_tasks
         FROM work_project p
         LEFT JOIN party
           ON party.tenant_id=p.tenant_id AND party.id=p.party_id
         LEFT JOIN LATERAL (
           SELECT
             COALESCE(sum(t.minutes),0) AS actual_minutes,
             COALESCE(sum(t.minutes) FILTER (WHERE t.billable),0) AS billable_minutes,
             COALESCE(sum(
               CASE WHEN t.billable
                 THEN (t.hourly_rate_minor_snapshot*t.minutes + 30) / 60
                 ELSE 0
               END
             ),0) AS billable_value_minor
           FROM work_project_time_entry t
           WHERE t.tenant_id=p.tenant_id AND t.project_id=p.id
         ) time_stats ON true
         LEFT JOIN LATERAL (
           SELECT
             count(*) AS total,
             count(*) FILTER (WHERE m.status='DONE') AS done,
             count(*) FILTER (
               WHERE m.status NOT IN ('DONE','CANCELLED')
                 AND m.due_at IS NOT NULL
                 AND m.due_at<now()
             ) AS overdue
           FROM work_project_milestone m
           WHERE m.tenant_id=p.tenant_id AND m.project_id=p.id
         ) milestones ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS open_count
           FROM task t
           WHERE t.tenant_id=p.tenant_id
             AND t.linked_type='PROJECT'
             AND t.linked_id=p.id
             AND t.state NOT IN ('DONE','CANCELLED')
         ) tasks ON true
         WHERE p.tenant_id=$1
           ${scopeSql}
         ORDER BY
           CASE p.status
             WHEN 'ACTIVE' THEN 0
             WHEN 'ON_HOLD' THEN 1
             WHEN 'PLANNED' THEN 2
             ELSE 3
           END,
           p.due_on NULLS LAST,p.updated_at DESC
         LIMIT 500`,
        values
      );
      return result.rows;
    });
  }

  async details(
    context: TenantContext,
    projectId: string
  ): Promise<Record<string, unknown>> {
    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.read"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId, projectId];
      let scopeSql = "";
      if (scopedMembershipIds) {
        values.push(scopedMembershipIds);
        scopeSql = "AND p.responsible_membership_id = ANY($3::uuid[])";
      }

      const project = await client.query(
        `SELECT
           p.*,p.budget_minor::text AS budget_minor,
           p.hourly_rate_minor::text AS hourly_rate_minor,
           party.display_name AS party_name,d.title AS source_deal_title
         FROM work_project p
         LEFT JOIN party
           ON party.tenant_id=p.tenant_id AND party.id=p.party_id
         LEFT JOIN crm_deal d
           ON d.tenant_id=p.tenant_id AND d.id=p.source_deal_id
         WHERE p.tenant_id=$1 AND p.id=$2
           ${scopeSql}`,
        values
      );
      if (!project.rows[0]) throw new NotFoundException("Проект не найден");

      const [milestones, timeEntries, tasks] = await Promise.all([
        client.query(
          `SELECT
             id,name,position,status,due_at,amount_minor::text,
             completed_at,created_at,updated_at
           FROM work_project_milestone
           WHERE tenant_id=$1 AND project_id=$2
           ORDER BY position,due_at NULLS LAST,created_at`,
          [context.tenantId, projectId]
        ),
        client.query(
          `SELECT
             e.id,e.task_id,e.membership_id,e.work_date,e.minutes,e.billable,
             e.hourly_rate_minor_snapshot::text,e.note,e.created_at,
             u.email AS membership_name
           FROM work_project_time_entry e
           JOIN tenant_membership m
             ON m.tenant_id=e.tenant_id AND m.id=e.membership_id
           JOIN app_user u
             ON u.id=m.user_id
           WHERE e.tenant_id=$1 AND e.project_id=$2
           ORDER BY e.work_date DESC,e.created_at DESC
           LIMIT 1000`,
          [context.tenantId, projectId]
        ),
        client.query(
          `SELECT id,title,state,priority,responsible_membership_id,due_at
           FROM task
           WHERE tenant_id=$1
             AND linked_type='PROJECT'
             AND linked_id=$2
           ORDER BY
             CASE state WHEN 'DONE' THEN 1 WHEN 'CANCELLED' THEN 2 ELSE 0 END,
             due_at NULLS LAST,created_at DESC
           LIMIT 500`,
          [context.tenantId, projectId]
        )
      ]);

      const actualMinutes = timeEntries.rows.reduce(
        (sum, row) => sum + Number(row.minutes ?? 0),
        0
      );
      const billableValueMinor = timeEntries.rows.reduce(
        (sum, row) =>
          sum +
          (row.billable
            ? (BigInt(row.hourly_rate_minor_snapshot ?? "0") *
                BigInt(row.minutes ?? 0) +
                30n) /
              60n
            : 0n),
        0n
      );

      return {
        project: project.rows[0],
        milestones: milestones.rows,
        timeEntries: timeEntries.rows,
        tasks: tasks.rows,
        metrics: {
          actualMinutes,
          billableValueMinor: billableValueMinor.toString()
        }
      };
    });
  }

  async create(
    context: TenantContext,
    input: {
      name: string;
      code?: string;
      partyId?: string;
      sourceDealId?: string;
      responsibleMembershipId?: string;
      billingMode?: "FIXED" | "TIME_AND_MATERIAL" | "RETAINER" | "MILESTONE" | "INTERNAL";
      projectType?: string;
      monthlyRetainerMinor?: string;
      mediaBudgetMinor?: string;
      targetMarginBps?: number;
      currency?: string;
      budgetMinor?: string;
      hourlyRateMinor?: string;
      estimatedMinutes?: number;
      startsOn?: string;
      dueOn?: string;
      notes?: string;
    }
  ): Promise<{ id: string; number: string; version: number }> {
    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.write"
    );
    const name = input.name?.trim();
    if (!name || name.length > 220) {
      throw new BadRequestException("Некорректное название проекта");
    }
    const billingMode = input.billingMode ?? "FIXED";
    if (!["FIXED","TIME_AND_MATERIAL","RETAINER","MILESTONE","INTERNAL"].includes(billingMode)) {
      throw new BadRequestException("Некорректная модель биллинга");
    }
    const currency = input.currency?.trim().toUpperCase() || "RUB";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Некорректная валюта");
    }
    const budgetMinor = input.budgetMinor ?? "0";
    const hourlyRateMinor = input.hourlyRateMinor ?? "0";
    if (!/^\d+$/.test(budgetMinor) || !/^\d+$/.test(hourlyRateMinor)) {
      throw new BadRequestException("Некорректный бюджет или ставка");
    }
    const monthlyRetainerMinor=input.monthlyRetainerMinor??"0";
    const mediaBudgetMinor=input.mediaBudgetMinor??"0";
    if(!/^\d+$/.test(monthlyRetainerMinor)||!/^\d+$/.test(mediaBudgetMinor)){
      throw new BadRequestException("Некорректный ретейнер или рекламный бюджет");
    }
    const targetMarginBps=input.targetMarginBps===undefined
      ?null
      :Math.floor(input.targetMarginBps);
    if(targetMarginBps!==null&&(targetMarginBps<0||targetMarginBps>10000)){
      throw new BadRequestException("Целевая маржа должна быть от 0 до 100%");
    }
    const estimatedMinutes = Number(input.estimatedMinutes ?? 0);
    if (!Number.isSafeInteger(estimatedMinutes) || estimatedMinutes < 0) {
      throw new BadRequestException("Некорректная оценка трудозатрат");
    }
    this.validateDate(input.startsOn, "дата начала");
    this.validateDate(input.dueOn, "срок проекта");
    if (
      input.startsOn &&
      input.dueOn &&
      input.dueOn < input.startsOn
    ) {
      throw new BadRequestException("Срок проекта раньше даты начала");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      let partyId = input.partyId ?? null;
      let responsibleMembershipId =
        input.responsibleMembershipId ?? context.membershipId;

      if (input.sourceDealId) {
        const deal = await client.query<{
          party_id: string | null;
          responsible_membership_id: string | null;
        }>(
          `SELECT party_id,responsible_membership_id
           FROM crm_deal
           WHERE tenant_id=$1
             AND id=$2
             AND (
               $3::uuid[] IS NULL
               OR responsible_membership_id = ANY($3::uuid[])
             )`,
          [context.tenantId, input.sourceDealId, scopedMembershipIds]
        );
        const dealRow = deal.rows[0];
        if (!dealRow) throw new NotFoundException("Сделка не найдена");
        if (partyId && dealRow.party_id && partyId !== dealRow.party_id) {
          throw new ConflictException(
            "Клиент проекта не совпадает с клиентом сделки"
          );
        }
        partyId = partyId ?? dealRow.party_id;
        responsibleMembershipId =
          input.responsibleMembershipId ??
          dealRow.responsible_membership_id ??
          context.membershipId;
      }

      if (
        scopedMembershipIds &&
        !scopedMembershipIds.includes(responsibleMembershipId)
      ) {
        throw new NotFoundException("Ответственный сотрудник недоступен");
      }

      if (partyId) {
        const party = await client.query(
          `SELECT 1 FROM party
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId, partyId]
        );
        if (!party.rowCount) throw new NotFoundException("Клиент не найден");
      }

      const membership = await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, responsibleMembershipId]
      );
      if (!membership.rowCount) {
        throw new NotFoundException("Ответственный сотрудник не найден");
      }

      const counter = await client.query<{ value: string }>(
        `INSERT INTO tenant_counter(tenant_id,counter_key,value)
         VALUES ($1,'work_project',1)
         ON CONFLICT (tenant_id,counter_key)
         DO UPDATE SET
           value=tenant_counter.value+1,
           updated_at=now()
         RETURNING value::text`,
        [context.tenantId]
      );
      const sequence = BigInt(counter.rows[0]?.value ?? "0");
      const number =
        "PRJ-" +
        new Date().getUTCFullYear() +
        "-" +
        sequence.toString().padStart(6, "0");

      try {
        const result = await client.query<{
          id: string;
          business_number: string;
          version: number;
        }>(
          `INSERT INTO work_project(
             tenant_id,business_number,source_deal_id,party_id,
             responsible_membership_id,name,code,status,billing_mode,
             currency,budget_minor,hourly_rate_minor,estimated_minutes,
             starts_on,due_on,notes,project_type,monthly_retainer_minor,
             media_budget_minor,target_margin_bps,created_by_membership_id
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,'PLANNED',$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20
           )
           ON CONFLICT (tenant_id,source_deal_id)
             WHERE source_deal_id IS NOT NULL
           DO NOTHING
           RETURNING id,business_number,version`,
          [
            context.tenantId,
            number,
            input.sourceDealId ?? null,
            partyId,
            responsibleMembershipId,
            name,
            input.code?.trim() || null,
            billingMode,
            currency,
            budgetMinor,
            hourlyRateMinor,
            estimatedMinutes,
            input.startsOn ?? null,
            input.dueOn ?? null,
            input.notes?.trim() || null,
            input.projectType?.trim()||null,
            monthlyRetainerMinor,
            mediaBudgetMinor,
            targetMarginBps,
            context.membershipId
          ]
        );
        let row = result.rows[0];
        if (!row && input.sourceDealId) {
          const existing = await client.query<{
            id: string;
            business_number: string;
            version: number;
          }>(
            `SELECT id,business_number,version
             FROM work_project
             WHERE tenant_id=$1
               AND source_deal_id=$2
               AND (
                 $3::uuid[] IS NULL
                 OR responsible_membership_id = ANY($3::uuid[])
               )`,
            [context.tenantId, input.sourceDealId, scopedMembershipIds]
          );
          row = existing.rows[0];
          if (row) {
            return {
              id: row.id,
              number: row.business_number,
              version: row.version
            };
          }
        }
        if (!row) throw new Error("PROJECT_CREATE_FAILED");

        await this.audit(client, context, "project.created", "work_project", row.id, {
          number: row.business_number,
          sourceDealId: input.sourceDealId ?? null,
          partyId
        });

        return {
          id: row.id,
          number: row.business_number,
          version: row.version
        };
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException("Проект с таким кодом уже существует");
        }
        throw error;
      }
    });
  }

  async createFromDeal(
    context: TenantContext,
    dealId: string
  ): Promise<{ id: string; number: string; version: number }> {
    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.write"
    );
    const deal = await this.database.withTenantTransaction(
      context,
      async (client) => {
        const result = await client.query<{
          title: string;
          amount_minor: string;
          party_id: string | null;
          responsible_membership_id: string | null;
        }>(
          `SELECT
             title,amount_minor::text,party_id,responsible_membership_id
           FROM crm_deal
           WHERE tenant_id=$1
             AND id=$2
             AND (
               $3::uuid[] IS NULL
               OR responsible_membership_id = ANY($3::uuid[])
             )`,
          [context.tenantId, dealId, scopedMembershipIds]
        );
        const row = result.rows[0];
        if (!row) throw new NotFoundException("Сделка не найдена");
        return row;
      }
    );

    return this.create(context, {
      name: deal.title,
      sourceDealId: dealId,
      partyId: deal.party_id ?? undefined,
      responsibleMembershipId:
        deal.responsible_membership_id ?? undefined,
      budgetMinor: deal.amount_minor,
      billingMode: "FIXED"
    });
  }

  async changeStatus(
    context: TenantContext,
    projectId: string,
    input: { status: ProjectStatus; version: number }
  ): Promise<{ status: ProjectStatus; version: number }> {
    if (
      !["PLANNED","ACTIVE","ON_HOLD","COMPLETED","CANCELLED"].includes(
        input.status
      ) ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1
    ) {
      throw new BadRequestException("Некорректный статус или версия проекта");
    }

    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.write"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertWritableProject(
        client,
        context.tenantId,
        projectId,
        scopedMembershipIds
      );
      const current = await client.query<{
        status: ProjectStatus;
        version: number;
      }>(
        `SELECT status,version
         FROM work_project
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [context.tenantId, projectId]
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException("Проект не найден");
      if (row.version !== input.version) {
        throw new ConflictException("Проект уже был изменён");
      }

      const transitions: Record<ProjectStatus, ProjectStatus[]> = {
        PLANNED: ["ACTIVE","CANCELLED"],
        ACTIVE: ["ON_HOLD","COMPLETED","CANCELLED"],
        ON_HOLD: ["ACTIVE","CANCELLED"],
        COMPLETED: [],
        CANCELLED: []
      };
      if (!transitions[row.status].includes(input.status)) {
        throw new ConflictException("Недоступный переход статуса проекта");
      }

      if (input.status === "COMPLETED") {
        const blockers = await client.query<{
          milestones: string;
          tasks: string;
        }>(
          `SELECT
             (SELECT count(*) FROM work_project_milestone
               WHERE tenant_id=$1 AND project_id=$2
                 AND status NOT IN ('DONE','CANCELLED'))::text AS milestones,
             (SELECT count(*) FROM task
               WHERE tenant_id=$1
                 AND linked_type='PROJECT'
                 AND linked_id=$2
                 AND state NOT IN ('DONE','CANCELLED'))::text AS tasks`,
          [context.tenantId, projectId]
        );
        const blocking = blockers.rows[0]!;
        if (Number(blocking.milestones) > 0 || Number(blocking.tasks) > 0) {
          throw new ConflictException(
            "Сначала завершите этапы и задачи проекта"
          );
        }
      }

      const update = await client.query<{
        status: ProjectStatus;
        version: number;
      }>(
        `UPDATE work_project
         SET status=$3,
             version=version+1,
             completed_at=CASE WHEN $3='COMPLETED' THEN now() ELSE completed_at END,
             updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND version=$4
         RETURNING status,version`,
        [context.tenantId, projectId, input.status, input.version]
      );
      const updated = update.rows[0];
      if (!updated) throw new ConflictException("Проект уже был изменён");

      await this.audit(
        client,
        context,
        "project.status_changed",
        "work_project",
        projectId,
        { from: row.status, to: updated.status }
      );
      return updated;
    });
  }

  async addMilestone(
    context: TenantContext,
    projectId: string,
    input: {
      name: string;
      position?: number;
      dueAt?: string;
      amountMinor?: string;
    }
  ): Promise<{ id: string }> {
    const name = input.name?.trim();
    if (!name || name.length > 220) {
      throw new BadRequestException("Некорректное название этапа");
    }
    const position = Number(input.position ?? 100);
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new BadRequestException("Некорректная позиция этапа");
    }
    const amountMinor = input.amountMinor ?? "0";
    if (!/^\d+$/.test(amountMinor)) {
      throw new BadRequestException("Некорректная сумма этапа");
    }
    const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      throw new BadRequestException("Некорректный срок этапа");
    }

    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.write"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertWritableProject(
        client,
        context.tenantId,
        projectId,
        scopedMembershipIds
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO work_project_milestone(
           tenant_id,project_id,name,position,due_at,amount_minor
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [context.tenantId, projectId, name, position, dueAt, amountMinor]
      );
      return result.rows[0]!;
    });
  }

  async changeMilestoneStatus(
    context: TenantContext,
    projectId: string,
    milestoneId: string,
    status: "IN_PROGRESS" | "DONE" | "CANCELLED"
  ): Promise<{ status: string }> {
    if (!["IN_PROGRESS","DONE","CANCELLED"].includes(status)) {
      throw new BadRequestException("Некорректный статус этапа");
    }

    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.write"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertWritableProject(
        client,
        context.tenantId,
        projectId,
        scopedMembershipIds
      );
      const result = await client.query<{ status: string }>(
        `UPDATE work_project_milestone
         SET status=$4,
             completed_at=CASE WHEN $4='DONE' THEN now() ELSE completed_at END,
             updated_at=now()
         WHERE tenant_id=$1 AND project_id=$2 AND id=$3
           AND (
             (status='PLANNED' AND $4 IN ('IN_PROGRESS','DONE','CANCELLED'))
             OR (status='IN_PROGRESS' AND $4 IN ('DONE','CANCELLED'))
           )
         RETURNING status`,
        [context.tenantId, projectId, milestoneId, status]
      );
      const row = result.rows[0];
      if (!row) {
        throw new ConflictException("Этап уже завершён или переход недоступен");
      }
      return row;
    });
  }

  async addTimeEntry(
    context: TenantContext,
    projectId: string,
    input: {
      taskId?: string;
      membershipId?: string;
      workDate?: string;
      minutes: number;
      billable?: boolean;
      note?: string;
      idempotencyKey?: string;
    }
  ): Promise<{ id: string }> {
    const minutes = Number(input.minutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new BadRequestException("Время должно быть от 1 до 1440 минут");
    }
    this.validateDate(input.workDate, "дата работы");
    const scopedMembershipIds = await this.membershipIdsForScope(
      context,
      "projects.write"
    );

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query<{ id: string }>(
          `SELECT e.id
           FROM work_project_time_entry e
           JOIN work_project p
             ON p.tenant_id=e.tenant_id AND p.id=e.project_id
           WHERE e.tenant_id=$1
             AND e.idempotency_key=$2
             AND e.project_id=$3
             AND ($4::uuid[] IS NULL OR p.responsible_membership_id = ANY($4::uuid[]))`,
          [
            context.tenantId,
            input.idempotencyKey,
            projectId,
            scopedMembershipIds
          ]
        );
        if (existing.rows[0]) return existing.rows[0];
      }

      const project = await client.query<{
        status: ProjectStatus;
        hourly_rate_minor: string;
      }>(
        `SELECT status,hourly_rate_minor::text
         FROM work_project
         WHERE tenant_id=$1 AND id=$2
           AND ($3::uuid[] IS NULL OR responsible_membership_id = ANY($3::uuid[]))
         FOR UPDATE`,
        [context.tenantId, projectId, scopedMembershipIds]
      );
      const projectRow = project.rows[0];
      if (!projectRow) throw new NotFoundException("Проект не найден");
      if (projectRow.status !== "ACTIVE") {
        throw new ConflictException(
          "Время можно списывать только на активный проект"
        );
      }

      const entryDate=input.workDate??new Date().toISOString().slice(0,10);
      const lockedMonth=await client.query(
        `SELECT 1 FROM work_project_monthly_statement
         WHERE tenant_id=$1 AND project_id=$2 AND period_key=$3
           AND status IN ('FINALIZED','INVOICED','PAID')`,
        [context.tenantId,projectId,entryDate.slice(0,7)]);
      if(lockedMonth.rowCount)
        throw new ConflictException("Этот месяц закрыт: часы задним числом не допускаются");
      const membershipId = input.membershipId ?? context.membershipId;
      const membership = await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, membershipId]
      );
      if (!membership.rowCount) {
        throw new NotFoundException("Сотрудник не найден");
      }

      const assigned=await client.query<{
        cost_rate_minor:string;billable_rate_minor:string;status:string
      }>(`SELECT cost_rate_minor::text,billable_rate_minor::text,status
         FROM work_project_member
         WHERE tenant_id=$1 AND project_id=$2 AND membership_id=$3`,
        [context.tenantId,projectId,membershipId]);
      if(assigned.rows[0]?.status==="ARCHIVED")
        throw new ConflictException("Сотрудник больше не назначен на проект");
      const costRateSnapshot=assigned.rows[0]?.cost_rate_minor??null;
      const saleRateSnapshot=assigned.rows[0] &&
        BigInt(assigned.rows[0].billable_rate_minor)>0n
          ?assigned.rows[0].billable_rate_minor:projectRow.hourly_rate_minor;
      if (input.taskId) {
        const task = await client.query(
          `SELECT 1 FROM task
           WHERE tenant_id=$1 AND id=$2
             AND linked_type='PROJECT' AND linked_id=$3`,
          [context.tenantId, input.taskId, projectId]
        );
        if (!task.rowCount) {
          throw new ConflictException("Задача не относится к этому проекту");
        }
      }

      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO work_project_time_entry(
             tenant_id,project_id,task_id,membership_id,work_date,
             minutes,billable,hourly_rate_minor_snapshot,cost_rate_minor_snapshot,
             note,idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            context.tenantId,
            projectId,
            input.taskId ?? null,
            membershipId,
            input.workDate ?? new Date().toISOString().slice(0, 10),
            minutes,
            input.billable ?? true,
            saleRateSnapshot,
            costRateSnapshot,
            input.note?.trim() || null,
            input.idempotencyKey?.trim() || null
          ]
        );
        const row = result.rows[0];
        if (!row) throw new Error("PROJECT_TIME_ENTRY_CREATE_FAILED");
        return row;
      } catch (error) {
        if (input.idempotencyKey && this.isUniqueViolation(error)) {
          const existing = await client.query<{ id: string }>(
            `SELECT e.id
             FROM work_project_time_entry e
             JOIN work_project p
               ON p.tenant_id=e.tenant_id AND p.id=e.project_id
             WHERE e.tenant_id=$1
               AND e.idempotency_key=$2
               AND e.project_id=$3
               AND ($4::uuid[] IS NULL OR p.responsible_membership_id = ANY($4::uuid[]))`,
            [
              context.tenantId,
              input.idempotencyKey,
              projectId,
              scopedMembershipIds
            ]
          );
          if (existing.rows[0]) return existing.rows[0];
        }
        throw error;
      }
    });
  }

  private async membershipIdsForScope(
    context: TenantContext,
    permission: "projects.read" | "projects.write"
  ): Promise<string[] | null> {
    const scope = await this.authorization.resolveScope(context, permission);
    if (!scope) throw new ForbiddenException("Недостаточно прав");
    return this.authorization.membershipIdsForScope(context, scope);
  }

  private async assertWritableProject(
    client: PoolClient,
    tenantId: string,
    projectId: string,
    scopedMembershipIds: string[] | null
  ): Promise<void> {
    const result = await client.query<{ status: ProjectStatus }>(
      `SELECT status FROM work_project
       WHERE tenant_id=$1 AND id=$2
         AND ($3::uuid[] IS NULL OR responsible_membership_id = ANY($3::uuid[]))
       FOR UPDATE`,
      [tenantId, projectId, scopedMembershipIds]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Проект не найден");
    if (["COMPLETED","CANCELLED"].includes(row.status)) {
      throw new ConflictException("Завершённый проект нельзя изменять");
    }
  }

  private validateDate(value: string | undefined, label: string): void {
    if (!value) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException("Некорректная " + label);
    }
    const parsed = new Date(value + "T00:00:00Z");
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException("Некорректная " + label);
    }
  }

  private async audit(
    client: PoolClient,
    context: TenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    afterData?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event(
         tenant_id,actor_user_id,actor_membership_id,
         action,resource_type,resource_id,after_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.tenantId,
        context.userId,
        context.membershipId,
        action,
        resourceType,
        resourceId,
        afterData ? JSON.stringify(afterData) : null
      ]
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
    );
  }

  async agencyHealth(context:TenantContext) {
    const financeScope=await this.authorization.resolveScope(context,"finance.read");
    if(!financeScope)throw new ForbiddenException("Финансовые показатели доступны только уполномоченным сотрудникам");
    const projectScope=await this.membershipIdsForScope(context,"projects.read");
    const crmScope=await this.authorization.resolveScope(context,"crm.read");
    const crmMemberships=crmScope
      ?await this.authorization.membershipIdsForScope(context,crmScope):[];
    return this.database.withTenantTransaction(context,async client=>{
      const [invoice,contracts,deliveries,followups,cash]=await Promise.all([
        client.query<{
          id:string;business_number:string;party_name:string|null;due_at:string|null;
          amount_minor:string;remaining_minor:string;project_id:string;project_name:string;
        }>(`SELECT i.id,i.business_number,party.display_name AS party_name,
                  i.due_at::text,i.amount_minor::text,
                  (o.amount_minor-o.settled_minor)::text AS remaining_minor,
                  p.id AS project_id,p.name AS project_name
           FROM finance_invoice i
           JOIN financial_obligation o ON o.tenant_id=i.tenant_id AND o.id=i.obligation_id
           JOIN work_project_monthly_statement s ON s.tenant_id=i.tenant_id AND s.id=i.source_id
           JOIN work_project p ON p.tenant_id=s.tenant_id AND p.id=s.project_id
           LEFT JOIN party ON party.tenant_id=p.tenant_id AND party.id=p.party_id
           WHERE i.tenant_id=$1 AND i.source_type='AGENCY_PROJECT_STATEMENT'
             AND o.status IN ('OPEN','PARTIALLY_SETTLED') AND o.amount_minor>o.settled_minor
             AND i.status NOT IN ('CANCELLED','CREDITED')
             AND ($2::uuid[] IS NULL OR p.responsible_membership_id=ANY($2::uuid[]))
           ORDER BY i.due_at NULLS LAST,i.issued_at DESC LIMIT 500`,
          [context.tenantId,projectScope]),
        client.query<{
          id:string;contract_number:string;project_id:string;project_name:string;
          ends_on:string;renewal_notice_days:number;service_fee_minor:string;
        }>(`SELECT c.id,c.contract_number,c.project_id,p.name AS project_name,
                  c.ends_on::text,c.renewal_notice_days,c.service_fee_minor::text
           FROM agency_client_contract c
           JOIN work_project p ON p.tenant_id=c.tenant_id AND p.id=c.project_id
           WHERE c.tenant_id=$1 AND c.status='ACTIVE'
             AND p.status NOT IN ('CANCELLED','COMPLETED')
             AND ($2::uuid[] IS NULL OR p.responsible_membership_id=ANY($2::uuid[]))
             AND c.ends_on IS NOT NULL
             AND c.ends_on<=current_date+c.renewal_notice_days
           ORDER BY c.ends_on LIMIT 100`,
          [context.tenantId,projectScope]),
        client.query<{
          id:string;project_id:string;project_name:string;title:string;due_at:string|null;
          source:string;
        }>(`SELECT a.id,a.project_id,p.name AS project_name,a.title,
                  a.due_at::text,'APPROVAL'::text AS source
           FROM work_project_client_approval a
           JOIN work_project p ON p.tenant_id=a.tenant_id AND p.id=a.project_id
           WHERE a.tenant_id=$1 AND a.status='PENDING' AND a.due_at<now()
             AND ($2::uuid[] IS NULL OR p.responsible_membership_id=ANY($2::uuid[]))
           UNION ALL
           SELECT d.id,d.project_id,p.name,d.title,d.due_at::text,'DELIVERABLE'::text
           FROM work_project_deliverable d
           JOIN work_project p ON p.tenant_id=d.tenant_id AND p.id=d.project_id
           WHERE d.tenant_id=$1 AND d.status NOT IN ('APPROVED','CANCELLED')
             AND d.due_at<now()
             AND ($2::uuid[] IS NULL OR p.responsible_membership_id=ANY($2::uuid[]))
           ORDER BY due_at LIMIT 200`,
          [context.tenantId,projectScope]),
        crmScope?client.query<{
          id:string;title:string;next_action_at:string|null;
          next_action_title:string|null;amount_minor:string;
        }>(`SELECT d.id,d.title,d.next_action_at::text,d.next_action_title,d.amount_minor::text
           FROM crm_deal d
           JOIN crm_stage stage ON stage.tenant_id=d.tenant_id AND stage.id=d.stage_id
           WHERE d.tenant_id=$1 AND stage.kind='NORMAL'
             AND ($2::uuid[] IS NULL OR d.responsible_membership_id=ANY($2::uuid[]))
             AND (d.next_action_at IS NULL OR d.next_action_at<now())
           ORDER BY d.next_action_at NULLS FIRST,d.updated_at ASC LIMIT 100`,
          [context.tenantId,crmMemberships]):Promise.resolve({rows:[]}),
        client.query<{monthly_recurring_minor:string;active_contracts:string}>(
          `SELECT COALESCE(sum(c.service_fee_minor),0)::text AS monthly_recurring_minor,
                  count(*)::text AS active_contracts
           FROM agency_client_contract c
           JOIN work_project p ON p.tenant_id=c.tenant_id AND p.id=c.project_id
           WHERE c.tenant_id=$1 AND c.status='ACTIVE' AND c.billing_cycle='MONTHLY'
             AND c.starts_on<=current_date
             AND (c.ends_on IS NULL OR c.ends_on>=current_date)
             AND p.currency='RUB' AND p.status NOT IN ('CANCELLED','COMPLETED')
             AND ($2::uuid[] IS NULL OR p.responsible_membership_id=ANY($2::uuid[]))`,
          [context.tenantId,projectScope])
      ]);
      const items:Array<{
        type:string;title:string;description:string;href:string;
        dueAt:string|null;priority:"high"|"medium";
      }>=[];
      let outstandingRub=0n,overdueRub=0n,overdueInvoices=0;
      const today=Date.now();
      for(const row of invoice.rows){
        const amount=BigInt(row.remaining_minor);
        outstandingRub+=amount;
        if(row.due_at && new Date(row.due_at).getTime()<today){
          overdueRub+=amount;overdueInvoices++;
          if(items.length<100)items.push({
            type:"INVOICE",title:"Просрочена оплата "+row.business_number,
            description:(row.party_name??row.project_name)+" · остаток "+(Number(amount)/100).toLocaleString("ru-RU")+" ₽",
            href:"/app/finance",dueAt:row.due_at,priority:"high"
          });
        }
      }
      for(const row of contracts.rows)if(items.length<150)items.push({
        type:"RENEWAL",title:"Продление договора "+row.contract_number,
        description:row.project_name,href:"/app/agency/contracts",
        dueAt:row.ends_on,priority:row.ends_on<new Date().toISOString().slice(0,10)?"high":"medium"
      });
      for(const row of deliveries.rows)if(items.length<200)items.push({
        type:row.source,title:(row.source==="APPROVAL"?"Ожидается согласование: ":"Просрочен результат: ")+row.title,
        description:row.project_name,href:"/app/projects/"+row.project_id,
        dueAt:row.due_at,priority:"high"
      });
      for(const row of followups.rows)if(items.length<250)items.push({
        type:"CRM",title:row.next_action_at?"Просрочен контакт: "+row.title:"Нет следующего действия: "+row.title,
        description:row.next_action_title??"Назначьте следующий шаг в сделке",
        href:"/app/crm/deals/"+row.id,dueAt:row.next_action_at,
        priority:row.next_action_at?"high":"medium"
      });
      const score={overdueInvoices,overdueDeliveries:deliveries.rows.length,
        renewalDue:contracts.rows.length,unworkedDeals:followups.rows.length,
        unpaidInvoiceCount:invoice.rows.length,
        outstandingMinor:outstandingRub.toString(),overdueMinor:overdueRub.toString(),
        contractedMonthlyRevenueMinor:cash.rows[0]?.monthly_recurring_minor??"0",
        activeMonthlyContracts:Number(cash.rows[0]?.active_contracts??0),
        crmVisible:Boolean(crmScope)};
      items.sort((a,b)=>Number(a.priority==="medium")-Number(b.priority==="medium")
        ||String(a.dueAt??"9999").localeCompare(String(b.dueAt??"9999")));
      return {score,alerts:items.slice(0,120)};
    });
  }

  async agencyOverview(context:TenantContext) {
    if(!await this.authorization.resolveScope(context,"finance.read"))
      throw new ForbiddenException("Недостаточно прав на финансовую сводку агентства");
    const scoped=await this.membershipIdsForScope(context,"projects.read");
    return this.database.withTenantTransaction(context,async client=>{
      const result=await client.query(
        `SELECT
           p.id,p.business_number,p.name,p.status,p.billing_mode,p.project_type,
           p.currency,p.budget_minor::text,p.monthly_retainer_minor::text,
           p.media_budget_minor::text,p.target_margin_bps,p.due_on,
           party.display_name AS party_name,
           coalesce(t.actual_minutes,0)::integer AS actual_minutes,
           coalesce(t.labor_cost_minor,0)::text AS labor_cost_minor,
           coalesce(expenses.total_minor,0)::text AS other_cost_minor,
           coalesce(d.pending,0)::integer AS pending_deliverables,
           coalesce(d.overdue,0)::integer AS overdue_deliverables,
           coalesce(a.pending,0)::integer AS pending_approvals,
           coalesce(a.overdue,0)::integer AS overdue_approvals
         FROM work_project p
         LEFT JOIN party
           ON party.tenant_id=p.tenant_id AND party.id=p.party_id
         LEFT JOIN LATERAL(
           SELECT
             coalesce(sum(e.minutes),0) AS actual_minutes,
             coalesce(sum(
               coalesce(e.cost_rate_minor_snapshot,pm.cost_rate_minor,0)*
               e.minutes/60
             ),0)::bigint AS labor_cost_minor
           FROM work_project_time_entry e
           LEFT JOIN work_project_member pm
             ON pm.tenant_id=e.tenant_id
            AND pm.project_id=e.project_id
            AND pm.membership_id=e.membership_id
            AND pm.status='ACTIVE'
           WHERE e.tenant_id=p.tenant_id AND e.project_id=p.id
         ) t ON true
         LEFT JOIN LATERAL(
           SELECT coalesce(sum(e.amount_minor),0)::bigint AS total_minor
           FROM work_project_expense e
           WHERE e.tenant_id=p.tenant_id AND e.project_id=p.id
         ) expenses ON true
         LEFT JOIN LATERAL(
           SELECT
             count(*) FILTER (
               WHERE status NOT IN ('APPROVED','CANCELLED')
             ) AS pending,
             count(*) FILTER (
               WHERE status NOT IN ('APPROVED','CANCELLED')
                 AND due_at<now()
             ) AS overdue
           FROM work_project_deliverable d
           WHERE d.tenant_id=p.tenant_id AND d.project_id=p.id
         ) d ON true
         LEFT JOIN LATERAL(
           SELECT
             count(*) FILTER (WHERE status='PENDING') AS pending,
             count(*) FILTER (
               WHERE status='PENDING' AND due_at<now()
             ) AS overdue
           FROM work_project_client_approval a
           WHERE a.tenant_id=p.tenant_id AND a.project_id=p.id
         ) a ON true
         WHERE p.tenant_id=$1
           AND p.status NOT IN ('COMPLETED','CANCELLED')
           AND (
             $2::uuid[] IS NULL
             OR p.responsible_membership_id=ANY($2::uuid[])
           )
         ORDER BY
           (coalesce(a.overdue,0)+coalesce(d.overdue,0)) DESC,
           p.due_on NULLS LAST,p.updated_at DESC`,
        [context.tenantId,scoped]
      );
      return result.rows;
    });
  }

  async deliverables(context:TenantContext,projectId:string){
    const scoped=await this.membershipIdsForScope(context,"projects.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertReadableProject(
        client,context.tenantId,projectId,scoped
      );
      return (await client.query(
        `SELECT
           d.*,m.name AS milestone_name,
           ap.display_name AS approved_by_name
         FROM work_project_deliverable d
         LEFT JOIN work_project_milestone m
           ON m.tenant_id=d.tenant_id AND m.id=d.milestone_id
         LEFT JOIN party ap
           ON ap.tenant_id=d.tenant_id AND ap.id=d.approved_by_party_id
         WHERE d.tenant_id=$1 AND d.project_id=$2
         ORDER BY
           CASE d.status
             WHEN 'REWORK' THEN 0
             WHEN 'CLIENT_REVIEW' THEN 1
             WHEN 'INTERNAL_REVIEW' THEN 2
             WHEN 'IN_PROGRESS' THEN 3
             WHEN 'PLANNED' THEN 4
             ELSE 5
           END,
           d.due_at NULLS LAST,d.created_at`,
        [context.tenantId,projectId]
      )).rows;
    });
  }

  async addDeliverable(
    context:TenantContext,
    projectId:string,
    input:{
      title:string;
      deliverableType?:"DESIGN"|"DEVELOPMENT"|"SEO"|"CONTENT"|"ADVERTISING"|"ANALYTICS"|"STRATEGY"|"REPORT"|"OTHER";
      milestoneId?:string;
      dueAt?:string;
      clientApprovalRequired?:boolean;
    }
  ){
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    const title=input.title?.trim();
    if(!title||title.length>220){
      throw new BadRequestException("Некорректное название результата");
    }
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(
        client,context.tenantId,projectId,scoped
      );
      const result=await client.query(
        `INSERT INTO work_project_deliverable(
           tenant_id,project_id,milestone_id,title,deliverable_type,
           due_at,client_approval_required,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          context.tenantId,projectId,input.milestoneId??null,title,
          input.deliverableType??"OTHER",
          input.dueAt?new Date(input.dueAt):null,
          input.clientApprovalRequired!==false,context.membershipId
        ]
      );
      return result.rows[0];
    });
  }

  async changeDeliverableStatus(
    context:TenantContext,
    projectId:string,
    deliverableId:string,
    input:{status:string;version:number;note?:string}
  ){
    const allowed=[
      "PLANNED","IN_PROGRESS","INTERNAL_REVIEW",
      "CLIENT_REVIEW","APPROVED","REWORK","CANCELLED"
    ];
    if(!allowed.includes(input.status)){
      throw new BadRequestException("Некорректный статус результата");
    }
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(
        client,context.tenantId,projectId,scoped
      );
      if(input.status==="APPROVED"){
        const d=await client.query<{client_approval_required:boolean}>(
          `SELECT client_approval_required FROM work_project_deliverable
           WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
          [context.tenantId,projectId,deliverableId]);
        if(!d.rows[0])throw new NotFoundException("Результат не найден");
        if(d.rows[0].client_approval_required){
          const accepted=await client.query(
            `SELECT 1 FROM work_project_client_approval
             WHERE tenant_id=$1 AND project_id=$2 AND deliverable_id=$3
               AND request_type='DELIVERABLE' AND status='APPROVED' LIMIT 1`,
            [context.tenantId,projectId,deliverableId]);
          if(!accepted.rowCount)throw new ConflictException("Требуется подтверждённое согласование клиента");
        }
      }
      const result=await client.query(
        `UPDATE work_project_deliverable
         SET status=$4,
             approval_note=CASE
               WHEN $4 IN ('APPROVED','REWORK') THEN $6
               ELSE approval_note
             END,
             approved_at=CASE WHEN $4='APPROVED' THEN now() ELSE NULL END,
             version=version+1,updated_at=now()
         WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND version=$5
         RETURNING *`,
        [
          context.tenantId,projectId,deliverableId,input.status,
          input.version,input.note?.trim()||null
        ]
      );
      if(!result.rows[0]){
        throw new ConflictException("Результат уже изменён");
      }
      return result.rows[0];
    });
  }

  async approvals(context:TenantContext,projectId:string){
    const scoped=await this.membershipIdsForScope(context,"projects.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertReadableProject(
        client,context.tenantId,projectId,scoped
      );
      return (await client.query(
        `SELECT
           a.*,d.title AS deliverable_title,
           rp.display_name AS responded_by_name
         FROM work_project_client_approval a
         LEFT JOIN work_project_deliverable d
           ON d.tenant_id=a.tenant_id AND d.id=a.deliverable_id
         LEFT JOIN party rp
           ON rp.tenant_id=a.tenant_id AND rp.id=a.responded_by_party_id
         WHERE a.tenant_id=$1 AND a.project_id=$2
         ORDER BY
           CASE a.status WHEN 'PENDING' THEN 0 ELSE 1 END,
           a.due_at NULLS LAST,a.created_at DESC`,
        [context.tenantId,projectId]
      )).rows;
    });
  }

  async requestApproval(
    context:TenantContext,
    projectId:string,
    input:{
      deliverableId?:string;
      requestType?:"DELIVERABLE"|"BUDGET"|"SCOPE_CHANGE"|"CAMPAIGN_LAUNCH"|"OTHER";
      title:string;
      dueAt?:string;
    }
  ){
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    const title=input.title?.trim();
    if(!title||title.length>240)throw new BadRequestException("Некорректный предмет согласования");
    if(input.requestType&&!["DELIVERABLE","BUDGET","SCOPE_CHANGE","CAMPAIGN_LAUNCH","OTHER"].includes(input.requestType))
      throw new BadRequestException("Некорректный тип согласования");
    if(input.dueAt&&!Number.isFinite(Date.parse(input.dueAt)))
      throw new BadRequestException("Некорректный срок");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(
        client,context.tenantId,projectId,scoped
      );
      if(input.deliverableId){
        const match=await client.query(
          `SELECT 1 FROM work_project_deliverable WHERE tenant_id=$1 AND project_id=$2 AND id=$3`,
          [context.tenantId,projectId,input.deliverableId]);
        if(!match.rowCount)throw new NotFoundException("Результат не принадлежит проекту");
      }
      const result=await client.query(
        `INSERT INTO work_project_client_approval(
           tenant_id,project_id,deliverable_id,request_type,title,
           due_at,created_by_membership_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          context.tenantId,projectId,input.deliverableId??null,
          input.requestType??"OTHER",title,
          input.dueAt?new Date(input.dueAt):null,context.membershipId
        ]
      );
      return result.rows[0];
    });
  }


  async agencyExpenses(context: TenantContext, projectId: string) {
    const scoped = await this.membershipIdsForScope(context, "projects.read");
    return this.database.withTenantTransaction(context, async (client) => {
      await this.assertReadableProject(client, context.tenantId, projectId, scoped);
      return (await client.query(
        `SELECT id,project_id,category,description,amount_minor::text,
                expense_on,created_at
         FROM work_project_expense
         WHERE tenant_id=$1 AND project_id=$2
         ORDER BY expense_on DESC,created_at DESC LIMIT 500`,
        [context.tenantId,projectId]
      )).rows;
    });
  }

  async addAgencyExpense(
    context: TenantContext,
    projectId: string,
    input: {category?:string;description?:string;amountMinor?:string;expenseOn?:string}
  ) {
    const category=input?.category;
    const description=input?.description?.trim();
    const amount=input?.amountMinor;
    if (!category || !["CONTRACTOR","SOFTWARE","TRAVEL","OTHER"].includes(category))
      throw new BadRequestException("Некорректная категория расхода");
    if (!description || description.length<2 || description.length>240)
      throw new BadRequestException("Укажите описание расхода");
    if (!amount || !/^[1-9][0-9]{0,14}$/.test(amount))
      throw new BadRequestException("Некорректная сумма расхода в копейках");
    const expenseOn=input?.expenseOn??new Date().toISOString().slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseOn) ||
        !Number.isFinite(Date.parse(expenseOn)) ||
        new Date(expenseOn).toISOString().slice(0,10)!==expenseOn)
      throw new BadRequestException("Некорректная дата расхода");
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    return this.database.withTenantTransaction(context,async(client)=>{
      await this.assertWritableProject(client,context.tenantId,projectId,scoped);
      const project=await client.query<{currency:string}>(
        "SELECT currency FROM work_project WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId,projectId]
      );
      if(project.rows[0]?.currency!=="RUB")
        throw new BadRequestException("Расходы пока доступны только для проектов в RUB");
      const lockedMonth=await client.query(
        `SELECT 1 FROM work_project_monthly_statement
         WHERE tenant_id=$1 AND project_id=$2 AND period_key=$3
           AND status IN ('FINALIZED','INVOICED','PAID')`,
        [context.tenantId,projectId,expenseOn.slice(0,7)]);
      if(lockedMonth.rowCount)
        throw new ConflictException("Месяц уже закрыт: расходы задним числом не допускаются");
      return (await client.query(
        `INSERT INTO work_project_expense(
           tenant_id,project_id,category,description,amount_minor,
           expense_on,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,project_id,category,description,amount_minor::text,expense_on`,
        [context.tenantId,projectId,category,description,amount,expenseOn,context.membershipId]
      )).rows[0];
    });
  }

  private agencyPeriod(period: string) {
    if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
      throw new BadRequestException("Период должен быть в формате ГГГГ-ММ");
    const [year,month]=period.split("-").map(Number);
    if(year<2000 || year>2100)
      throw new BadRequestException("Некорректный год");
    const start=period+"-01";
    const next=new Date(Date.UTC(year,month,1)).toISOString().slice(0,10);
    const end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
    return {start,next,end};
  }

  private async calculateAgencyStatement(
    client: PoolClient, context: TenantContext, projectId:string, period:string
  ) {
    const dates=this.agencyPeriod(period);
    const projectResult=await client.query<{
      id:string;party_id:string|null;currency:string;status:string;
      billing_mode:string;monthly_retainer_minor:string;
      budget_minor:string;media_budget_minor:string;completed_at:string|null;
      target_margin_bps:number|null;
    }>(`SELECT id,party_id,currency,status,billing_mode,
              monthly_retainer_minor::text,budget_minor::text,
              media_budget_minor::text,completed_at::text,target_margin_bps
         FROM work_project WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId,projectId]);
    const project=projectResult.rows[0];
    if(!project) throw new NotFoundException("Проект не найден");
    const totals=await client.query<{
      billable_minutes:string;billable_value_minor:string;labor_cost_minor:string;
      missing_cost_entries:string;other_cost_minor:string;milestone_revenue_minor:string;
    }>(`SELECT
      (SELECT COALESCE(sum(e.minutes) FILTER (WHERE e.billable),0)::text
       FROM work_project_time_entry e WHERE e.tenant_id=$1 AND e.project_id=$2
       AND e.work_date >= $3::date AND e.work_date < $4::date) AS billable_minutes,
      (SELECT COALESCE(sum((e.hourly_rate_minor_snapshot*e.minutes+30)/60)
                FILTER(WHERE e.billable),0)::text
       FROM work_project_time_entry e WHERE e.tenant_id=$1 AND e.project_id=$2
       AND e.work_date >= $3::date AND e.work_date < $4::date) AS billable_value_minor,
      (SELECT COALESCE(sum(coalesce(e.cost_rate_minor_snapshot,pm.cost_rate_minor,0)*e.minutes/60),0)::text
       FROM work_project_time_entry e LEFT JOIN work_project_member pm
         ON pm.tenant_id=e.tenant_id AND pm.project_id=e.project_id
         AND pm.membership_id=e.membership_id
       WHERE e.tenant_id=$1 AND e.project_id=$2
       AND e.work_date >= $3::date AND e.work_date < $4::date) AS labor_cost_minor,
      (SELECT count(*)::text FROM work_project_time_entry e
       LEFT JOIN work_project_member pm ON pm.tenant_id=e.tenant_id
         AND pm.project_id=e.project_id AND pm.membership_id=e.membership_id
       WHERE e.tenant_id=$1 AND e.project_id=$2
         AND e.work_date >= $3::date AND e.work_date < $4::date
         AND coalesce(e.cost_rate_minor_snapshot,pm.cost_rate_minor,0)=0) AS missing_cost_entries,
      (SELECT COALESCE(sum(e.amount_minor),0)::text FROM work_project_expense e
       WHERE e.tenant_id=$1 AND e.project_id=$2
         AND e.expense_on >= $3::date AND e.expense_on < $4::date) AS other_cost_minor,
      (SELECT COALESCE(sum(m.amount_minor),0)::text FROM work_project_milestone m
       WHERE m.tenant_id=$1 AND m.project_id=$2 AND m.status='DONE'
         AND m.completed_at >= $3::date AND m.completed_at < $4::date) AS milestone_revenue_minor`,
      [context.tenantId,projectId,dates.start,dates.next]);
    const stats=totals.rows[0]!;
    let revenue=0n;
    if(project.billing_mode==="RETAINER") revenue=BigInt(project.monthly_retainer_minor);
    if(project.billing_mode==="TIME_AND_MATERIAL") revenue=BigInt(stats.billable_value_minor);
    if(project.billing_mode==="MILESTONE") revenue=BigInt(stats.milestone_revenue_minor);
    if(project.billing_mode==="FIXED" && project.status==="COMPLETED" &&
       project.completed_at?.slice(0,7)===period) revenue=BigInt(project.budget_minor);
    if(project.billing_mode==="INTERNAL")
      throw new BadRequestException("Внутренний проект не выставляется клиенту");
    const labor=BigInt(stats.labor_cost_minor);
    const other=BigInt(stats.other_cost_minor);
    const gross=revenue-labor-other;
    const rawMargin=revenue>0n ? gross*10000n/revenue : null;
    const margin=rawMargin!==null && rawMargin>=-100000n && rawMargin<=10000n
      ? Number(rawMargin):null;
    const warnings:string[]=[];
    if(!project.party_id) warnings.push("К проекту не привязан клиент");
    if(BigInt(stats.missing_cost_entries)>0n)
      warnings.push("Для части записей времени не указана себестоимость сотрудника");
    if(revenue<=0n) warnings.push("Нет выручки за выбранный период");
    if(project.media_budget_minor!=="0")
      warnings.push("Клиентский медиабюджет указан отдельно и не входит в себестоимость");
    if(rawMargin!==null && margin===null) warnings.push("Маржа за пределами допустимого диапазона");
    if(project.target_margin_bps!==null && rawMargin!==null &&
       rawMargin<BigInt(project.target_margin_bps)) warnings.push("Маржа ниже целевой");
    return {
      projectId,period,periodFrom:dates.start,periodTo:dates.end,
      currency:project.currency,billingMode:project.billing_mode,
      partyId:project.party_id,
      serviceRevenueMinor:revenue.toString(),
      mediaBudgetMinor:project.media_budget_minor,
      laborCostMinor:labor.toString(),
      otherCostMinor:other.toString(),
      grossMarginMinor:gross.toString(),marginBps:margin,
      billableMinutes:Number(stats.billable_minutes),
      warnings
    };
  }

  async agencyStatementPreview(context:TenantContext, projectId:string, period:string) {
    const scope=await this.membershipIdsForScope(context,"projects.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertReadableProject(client,context.tenantId,projectId,scope);
      return this.calculateAgencyStatement(client,context,projectId,period);
    });
  }

  async agencyStatements(context:TenantContext,projectId:string) {
    const scope=await this.membershipIdsForScope(context,"projects.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertReadableProject(client,context.tenantId,projectId,scope);
      return (await client.query(
        `SELECT s.id,s.period_key,s.period_from,s.period_to,
                s.service_revenue_minor::text,s.labor_cost_minor::text,
                s.other_cost_minor::text,s.gross_margin_minor::text,
                s.margin_bps,s.status,s.snapshot,s.finalized_at,
                i.id AS invoice_id,i.business_number AS invoice_number,
                i.status AS invoice_status,i.due_at AS invoice_due_at
         FROM work_project_monthly_statement s
         LEFT JOIN finance_invoice i ON i.tenant_id=s.tenant_id
           AND i.source_type='AGENCY_PROJECT_STATEMENT' AND i.source_id=s.id
         WHERE s.tenant_id=$1 AND s.project_id=$2
         ORDER BY s.period_key DESC LIMIT 36`,
        [context.tenantId,projectId]
      )).rows;
    });
  }

  async finalizeAgencyStatement(context:TenantContext,projectId:string,period:string) {
    const dates=this.agencyPeriod(period);
    const today=new Date().toISOString().slice(0,7);
    if(period>=today)
      throw new BadRequestException("Закрывать можно только завершённые месяцы");
    const scope=await this.membershipIdsForScope(context,"projects.write");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(client,context.tenantId,projectId,scope);
      // Serialize close/retry by locking the project, without cross-tenant locks.
      const lock=await client.query("SELECT id FROM work_project WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId,projectId]);
      if(!lock.rowCount) throw new NotFoundException("Проект не найден");
      const existing=await client.query<{id:string;status:string}>(
        `SELECT id,status FROM work_project_monthly_statement
         WHERE tenant_id=$1 AND project_id=$2 AND period_key=$3 FOR UPDATE`,
        [context.tenantId,projectId,period]);
      if(existing.rows[0] && existing.rows[0].status!=="DRAFT"){
        return {id:existing.rows[0].id,status:existing.rows[0].status,alreadyFinalized:true};
      }
      const preview=await this.calculateAgencyStatement(client,context,projectId,period);
      // Missing cost rates cannot be silently treated as actual profit.
      if(preview.warnings.some(w=>w.includes("себестоимость сотрудника")))
        throw new ConflictException("Укажите себестоимость сотрудников перед закрытием периода");
      if(!preview.partyId)
        throw new ConflictException("У проекта должен быть клиент CRM");
      const snapshot=JSON.stringify({
        period,model:preview.billingMode,mediaBudgetExcluded:true,
        missingCostEntries:0,warnings:preview.warnings,
        calculatedAt:new Date().toISOString()
      });
      const result=await client.query<{id:string;status:string}>(
        `INSERT INTO work_project_monthly_statement(
           tenant_id,project_id,period_key,period_from,period_to,
           service_revenue_minor,media_budget_minor,labor_cost_minor,
           other_cost_minor,gross_margin_minor,margin_bps,billable_minutes,
           status,snapshot,finalized_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'FINALIZED',$13,now())
         ON CONFLICT(tenant_id,project_id,period_key) DO UPDATE SET
           period_from=EXCLUDED.period_from,period_to=EXCLUDED.period_to,
           service_revenue_minor=EXCLUDED.service_revenue_minor,
           media_budget_minor=EXCLUDED.media_budget_minor,
           labor_cost_minor=EXCLUDED.labor_cost_minor,
           other_cost_minor=EXCLUDED.other_cost_minor,
           gross_margin_minor=EXCLUDED.gross_margin_minor,
           margin_bps=EXCLUDED.margin_bps,billable_minutes=EXCLUDED.billable_minutes,
           snapshot=EXCLUDED.snapshot,status='FINALIZED',finalized_at=now(),
           updated_at=now()
         WHERE work_project_monthly_statement.status='DRAFT'
         RETURNING id,status`,
        [context.tenantId,projectId,period,dates.start,dates.end,
         preview.serviceRevenueMinor,preview.mediaBudgetMinor,
         preview.laborCostMinor,preview.otherCostMinor,
         preview.grossMarginMinor,preview.marginBps,
         preview.billableMinutes,snapshot]);
      if(!result.rows[0]) throw new ConflictException("Период уже закрыт");
      return {...result.rows[0],alreadyFinalized:false,preview};
    });
  }

  async agencyStaff(context:TenantContext) {
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    return this.database.withTenantTransaction(context,async client=>{
      return (await client.query(
        `SELECT m.id AS membership_id,u.email,
                COALESCE(sum(pm.allocation_percent) FILTER (
                  WHERE pm.status='ACTIVE' AND p.status IN ('PLANNED','ACTIVE')
                ),0)::integer AS allocated_percent
         FROM tenant_membership m
         JOIN app_user u ON u.id=m.user_id
         LEFT JOIN work_project_member pm ON pm.tenant_id=m.tenant_id
            AND pm.membership_id=m.id
         LEFT JOIN work_project p ON p.tenant_id=pm.tenant_id AND p.id=pm.project_id
         WHERE m.tenant_id=$1 AND m.status='ACTIVE'
           AND ($2::uuid[] IS NULL OR m.id=ANY($2::uuid[]))
         GROUP BY m.id,u.email
         ORDER BY u.email LIMIT 500`,
        [context.tenantId,scoped]
      )).rows;
    });
  }

  async agencyTeam(context:TenantContext,projectId:string) {
    const scoped=await this.membershipIdsForScope(context,"projects.read");
    const costScope=await this.authorization.resolveScope(context,"finance.read");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertReadableProject(client,context.tenantId,projectId,scoped);
      return (await client.query(
        `SELECT pm.membership_id,u.email,pm.role_code,pm.allocation_percent,
                pm.status,
                CASE WHEN $3::boolean THEN pm.cost_rate_minor::text ELSE NULL END AS cost_rate_minor,
                CASE WHEN $3::boolean THEN pm.billable_rate_minor::text ELSE NULL END AS billable_rate_minor,
                COALESCE(hours.month_minutes,0)::integer AS month_minutes
         FROM work_project_member pm
         JOIN tenant_membership m ON m.tenant_id=pm.tenant_id AND m.id=pm.membership_id
         JOIN app_user u ON u.id=m.user_id
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(e.minutes),0) AS month_minutes
           FROM work_project_time_entry e
           WHERE e.tenant_id=pm.tenant_id AND e.project_id=pm.project_id
             AND e.membership_id=pm.membership_id
             AND e.work_date >= date_trunc('month',current_date)::date
         ) hours ON true
         WHERE pm.tenant_id=$1 AND pm.project_id=$2
         ORDER BY CASE pm.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,u.email`,
        [context.tenantId,projectId,Boolean(costScope)]
      )).rows;
    });
  }

  async upsertAgencyTeamMember(
    context:TenantContext,projectId:string,membershipId:string,
    input:{roleCode?:string;allocationPercent?:number;costRateMinor?:string;
           billableRateMinor?:string;status?:"ACTIVE"|"ARCHIVED"}
  ) {
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    if(!await this.authorization.resolveScope(context,"finance.write"))
      throw new ForbiddenException("Стоимость труда может задавать только финансовый администратор");
    const role=String(input?.roleCode??"SPECIALIST").trim().toUpperCase();
    const allowed=["SPECIALIST","PROJECT_MANAGER","DESIGNER","DEVELOPER","QA",
      "SEO","PPC","SMM","ANALYST","ACCOUNT_MANAGER","COPYWRITER","OTHER"];
    const allocation=input?.allocationPercent;
    const cost=input?.costRateMinor;
    const billable=input?.billableRateMinor;
    const status=input?.status??"ACTIVE";
    if(!allowed.includes(role))throw new BadRequestException("Неизвестная роль проекта");
    if(typeof allocation!=="number"||!Number.isInteger(allocation)||allocation<1||allocation>100)
      throw new BadRequestException("Загрузка сотрудника: от 1 до 100%");
    if(typeof cost!=="string"|| !/^\d{1,14}$/.test(cost) ||
       typeof billable!=="string"|| !/^\d{1,14}$/.test(billable))
      throw new BadRequestException("Ставки указываются целыми копейками");
    if(!["ACTIVE","ARCHIVED"].includes(status))
      throw new BadRequestException("Некорректный статус сотрудника");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(client,context.tenantId,projectId,scoped);
      const membership=await client.query(
        `SELECT 1 FROM tenant_membership WHERE tenant_id=$1 AND id=$2
           AND status='ACTIVE' FOR UPDATE`,
        [context.tenantId,membershipId]);
      if(!membership.rowCount)throw new NotFoundException("Сотрудник не найден");
      if(status==="ACTIVE"){
        const allocated=await client.query<{total:string}>(
          `SELECT coalesce(sum(pm.allocation_percent),0)::text AS total
           FROM work_project_member pm JOIN work_project p
             ON p.tenant_id=pm.tenant_id AND p.id=pm.project_id
           WHERE pm.tenant_id=$1 AND pm.membership_id=$2
             AND pm.project_id<>$3 AND pm.status='ACTIVE'
             AND p.status IN ('PLANNED','ACTIVE')`,
          [context.tenantId,membershipId,projectId]);
        if(Number(allocated.rows[0]?.total??0)+allocation>100)
          throw new ConflictException("Плановая загрузка сотрудника превышает 100%");
      }
      return (await client.query(
        `INSERT INTO work_project_member(
           tenant_id,project_id,membership_id,role_code,allocation_percent,
           cost_rate_minor,billable_rate_minor,status
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(tenant_id,project_id,membership_id) DO UPDATE SET
           role_code=EXCLUDED.role_code,allocation_percent=EXCLUDED.allocation_percent,
           cost_rate_minor=EXCLUDED.cost_rate_minor,
           billable_rate_minor=EXCLUDED.billable_rate_minor,
           status=EXCLUDED.status,updated_at=now()
         RETURNING membership_id,role_code,allocation_percent,status`,
        [context.tenantId,projectId,membershipId,role,allocation,
         cost,billable,status]
      )).rows[0];
    });
  }

  async decideAgencyApproval(context:TenantContext,projectId:string,approvalId:string,
    input:{decision?:"APPROVED"|"REJECTED";responseNote?:string;evidenceReference?:string}
  ){
    if(!["APPROVED","REJECTED"].includes(input?.decision??""))
      throw new BadRequestException("Решение должно быть APPROVED или REJECTED");
    const note=input?.responseNote?.trim();
    const reference=input?.evidenceReference?.trim();
    if(!note||note.length<5||note.length>2000)
      throw new BadRequestException("Необходим комментарий к решению");
    if(input.decision==="APPROVED"&&(!reference||reference.length<5||reference.length>500))
      throw new BadRequestException("Необходимо подтверждение согласия клиента: ссылка или номер письма");
    if(reference&&reference.length>500)
      throw new BadRequestException("Некорректная ссылка на подтверждение");
    const scoped=await this.membershipIdsForScope(context,"projects.write");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(client,context.tenantId,projectId,scoped);
      const q=await client.query<{deliverable_id:string|null;request_type:string}>(
        `SELECT deliverable_id,request_type FROM work_project_client_approval
         WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND status='PENDING'
         FOR UPDATE`,[context.tenantId,projectId,approvalId]);
      const row=q.rows[0];
      if(!row)throw new ConflictException("Согласование уже закрыто или не найдено");
      const res=await client.query(
        `UPDATE work_project_client_approval SET status=$4,response_note=$5,
         evidence_reference=$6,responded_at=now(),recorded_by_membership_id=$7
         WHERE tenant_id=$1 AND project_id=$2 AND id=$3
         RETURNING id,status,responded_at`,
        [context.tenantId,projectId,approvalId,input.decision,note,
         reference??null,context.membershipId]);
      if(row.deliverable_id&&row.request_type==="DELIVERABLE"){
        await client.query(
          `UPDATE work_project_deliverable
           SET status=$4,approved_at=CASE WHEN $4='APPROVED' THEN now() ELSE NULL END,
               approval_note=$5,version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND status='CLIENT_REVIEW'`,
          [context.tenantId,projectId,row.deliverable_id,
           input.decision==="APPROVED"?"APPROVED":"REWORK",note]);
      }
      await this.audit(client,context,"project.approval_decision_recorded",
        "work_project_client_approval",approvalId,
        {decision:input.decision,evidenceReference:reference??null});
      return res.rows[0];
    });
  }

  async agencyContracts(context:TenantContext,projectId?:string){
    if(!await this.authorization.resolveScope(context,"finance.read"))
      throw new ForbiddenException("Нет доступа к договорам");
    const scope=await this.membershipIdsForScope(context,"projects.read");
    return this.database.withTenantTransaction(context,async client=>{
      if(projectId)await this.assertReadableProject(client,context.tenantId,projectId,scope);
      return (await client.query(
        `SELECT c.*,c.service_fee_minor::text,c.client_media_budget_minor::text,
                p.name AS project_name,p.currency,p.party_id,
                party.display_name AS customer_name,
                CASE WHEN c.status='ACTIVE' AND c.ends_on IS NOT NULL
                    AND c.ends_on <= current_date+c.renewal_notice_days
                  THEN true ELSE false END AS renewal_due
         FROM agency_client_contract c
         JOIN work_project p ON p.tenant_id=c.tenant_id AND p.id=c.project_id
         LEFT JOIN party ON party.tenant_id=p.tenant_id AND party.id=p.party_id
         WHERE c.tenant_id=$1 AND ($2::uuid IS NULL OR c.project_id=$2)
           AND ($3::uuid[] IS NULL OR p.responsible_membership_id=ANY($3::uuid[]))
         ORDER BY CASE WHEN c.status='ACTIVE' AND c.ends_on IS NOT NULL
                     AND c.ends_on <= current_date+c.renewal_notice_days THEN 0 ELSE 1 END,
           c.ends_on NULLS LAST,c.created_at DESC LIMIT 500`,
        [context.tenantId,projectId??null,scope]
      )).rows;
    });
  }

  async createAgencyContract(context:TenantContext,projectId:string,input:{
    contractNumber?:string;title?:string;contractType?:string;billingCycle?:string;
    serviceFeeMinor?:string;clientMediaBudgetMinor?:string;
    startsOn?:string;endsOn?:string;renewalNoticeDays?:number;notes?:string
  }){
    if(!await this.authorization.resolveScope(context,"finance.write"))
      throw new ForbiddenException("Создать договор может финансовый администратор");
    const scope=await this.membershipIdsForScope(context,"projects.write");
    const number=input?.contractNumber?.trim();
    const title=input?.title?.trim();
    const contractType=input?.contractType;
    const billingCycle=input?.billingCycle;
    const fee=input?.serviceFeeMinor;
    const media=input?.clientMediaBudgetMinor??"0";
    const days=input?.renewalNoticeDays??30;
    if(!number||number.length<2||number.length>80||!title||title.length<2||title.length>220)
      throw new BadRequestException("Укажите номер и название договора");
    if(!["WEBSITE_BUILD","SUPPORT","SEO","PPC","SMM","MARKETING_RETAINER","OTHER"].includes(contractType??""))
      throw new BadRequestException("Некорректный тип договора");
    if(!["ONE_TIME","MONTHLY","QUARTERLY"].includes(billingCycle??""))
      throw new BadRequestException("Некорректный период оплаты");
    if(typeof fee!=="string"|| !/^\d{1,15}$/.test(fee)||
       !/^\d{1,15}$/.test(media))
      throw new BadRequestException("Суммы должны быть указаны в копейках");
    if(!Number.isInteger(days)||days<0||days>365)
      throw new BadRequestException("Некорректный срок уведомления");
    this.validateDate(input.startsOn,"дата начала договора");
    if(!input.startsOn)throw new BadRequestException("Укажите дату начала договора");
    this.validateDate(input.endsOn,"дата окончания договора");
    if(input.endsOn&&input.endsOn<input.startsOn)
      throw new BadRequestException("Дата окончания раньше начала");
    if(input.notes && input.notes.length>3000)throw new BadRequestException("Примечание слишком длинное");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(client,context.tenantId,projectId,scope);
      const project=await client.query<{party_id:string|null}>(
        "SELECT party_id FROM work_project WHERE tenant_id=$1 AND id=$2",
        [context.tenantId,projectId]);
      if(!project.rows[0]?.party_id)
        throw new ConflictException("Сначала привяжите к проекту клиента CRM");
      try{
        return (await client.query(
          `INSERT INTO agency_client_contract(
             tenant_id,project_id,contract_number,title,contract_type,billing_cycle,
             service_fee_minor,client_media_budget_minor,starts_on,ends_on,
             renewal_notice_days,notes,created_by_membership_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id,contract_number,status,version`,
          [context.tenantId,projectId,number,title,contractType,billingCycle,
           fee,media,input.startsOn,input.endsOn??null,days,
           input.notes?.trim()??null,context.membershipId]
        )).rows[0];
      }catch(e){if(this.isUniqueViolation(e))
        throw new ConflictException("Договор с таким номером уже существует");
        throw e;
      }
    });
  }

  async changeAgencyContractStatus(
    context:TenantContext,projectId:string,contractId:string,
    input:{status?:string;version?:number;signedOn?:string}
  ){
    if(!await this.authorization.resolveScope(context,"finance.write"))
      throw new ForbiddenException("Недостаточно прав на договоры");
    const scope=await this.membershipIdsForScope(context,"projects.write");
    const status=input?.status;
    if(!["ACTIVE","PAUSED","EXPIRED","TERMINATED"].includes(status??""))
      throw new BadRequestException("Некорректный статус договора");
    if(typeof input?.version!=="number"||!Number.isInteger(input.version)||input.version<1)
      throw new BadRequestException("Некорректная версия договора");
    if(input.signedOn)this.validateDate(input.signedOn,"дата подписания");
    return this.database.withTenantTransaction(context,async client=>{
      await this.assertWritableProject(client,context.tenantId,projectId,scope);
      const contract=await client.query<{status:string;version:number;ends_on:string|null;signed_on:string|null}>(
        `SELECT status,version,ends_on::text,signed_on::text
         FROM agency_client_contract WHERE tenant_id=$1 AND project_id=$2 AND id=$3
         FOR UPDATE`,[context.tenantId,projectId,contractId]);
      const row=contract.rows[0];
      if(!row)throw new NotFoundException("Договор не найден");
      if(row.version!==input.version)throw new ConflictException("Договор изменился, обновите данные");
      const transitions:Record<string,string[]>={
        DRAFT:["ACTIVE","TERMINATED"],ACTIVE:["PAUSED","EXPIRED","TERMINATED"],
        PAUSED:["ACTIVE","TERMINATED"],EXPIRED:[],TERMINATED:[]
      };
      if(!transitions[row.status]?.includes(status!))
        throw new ConflictException("Этот переход статуса договора недоступен");
      if(status==="ACTIVE"&&!row.signed_on&&!input.signedOn)
        throw new BadRequestException("Для активации укажите дату подписания");
      if(status==="ACTIVE"&&row.ends_on&&row.ends_on<new Date().toISOString().slice(0,10))
        throw new ConflictException("Нельзя активировать договор с истекшим сроком");
      const res=await client.query(
        `UPDATE agency_client_contract SET status=$4,version=version+1,
           signed_on=coalesce(signed_on,$5::date),updated_at=now()
         WHERE tenant_id=$1 AND project_id=$2 AND id=$3 RETURNING *`,
        [context.tenantId,projectId,contractId,status,input.signedOn??null]);
      await this.audit(client,context,"agency.contract_status_changed",
        "agency_client_contract",contractId,{from:row.status,to:status});
      return res.rows[0];
    });
  }

}

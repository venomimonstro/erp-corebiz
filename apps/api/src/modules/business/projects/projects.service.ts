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
      billingMode?: "FIXED" | "TIME_AND_MATERIAL" | "INTERNAL";
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
    if (!["FIXED","TIME_AND_MATERIAL","INTERNAL"].includes(billingMode)) {
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
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, input.sourceDealId]
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
             starts_on,due_on,notes,created_by_membership_id
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,'PLANNED',$8,$9,$10,$11,$12,$13,$14,$15,$16
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
             WHERE tenant_id=$1 AND source_deal_id=$2`,
            [context.tenantId, input.sourceDealId]
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
           WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, dealId]
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

      const membershipId = input.membershipId ?? context.membershipId;
      const membership = await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId, membershipId]
      );
      if (!membership.rowCount) {
        throw new NotFoundException("Сотрудник не найден");
      }

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
             minutes,billable,hourly_rate_minor_snapshot,note,idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            context.tenantId,
            projectId,
            input.taskId ?? null,
            membershipId,
            input.workDate ?? new Date().toISOString().slice(0, 10),
            minutes,
            input.billable ?? true,
            projectRow.hourly_rate_minor,
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
}

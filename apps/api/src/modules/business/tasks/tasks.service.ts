import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { AuthorizationService } from "../../platform/authorization/authorization.service";

@Injectable()
export class TasksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService
  ) {}

  async list(
    context: TenantContext,
    filter: "all" | "today" | "overdue" | "mine"
  ): Promise<Array<{
    id: string;
    title: string;
    type: string;
    state: string;
    priority: string;
    dueAt: string | null;
    responsibleMembershipId: string;
    linkedType: string | null;
    linkedId: string | null;
  }>> {
    const scope = await this.authorization.resolveScope(context, "tasks.read");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [context.tenantId];
      const clauses = ["t.tenant_id = $1"];

      if (scope === "own" || filter === "mine") {
        values.push(context.membershipId);
        clauses.push(`t.responsible_membership_id = $${values.length}`);
      }

      if (filter === "today") {
        clauses.push(
          "t.due_at >= date_trunc('day', now()) AND t.due_at < date_trunc('day', now()) + interval '1 day'"
        );
      }

      if (filter === "overdue") {
        clauses.push(
          "t.due_at < now() AND t.state IN ('OPEN','IN_PROGRESS','WAITING')"
        );
      }

      const result = await client.query<{
        id: string;
        title: string;
        type: string;
        state: string;
        priority: string;
        due_at: Date | null;
        responsible_membership_id: string;
        linked_type: string | null;
        linked_id: string | null;
      }>(
        `SELECT
           t.id,
           t.title,
           t.type,
           t.state,
           t.priority,
           t.due_at,
           t.responsible_membership_id,
           t.linked_type,
           t.linked_id
         FROM task t
         WHERE ${clauses.join(" AND ")}
         ORDER BY
           CASE WHEN t.state = 'DONE' THEN 1 ELSE 0 END,
           t.due_at ASC NULLS LAST,
           t.created_at DESC
         LIMIT 500`,
        values
      );

      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        state: row.state,
        priority: row.priority,
        dueAt: row.due_at?.toISOString() ?? null,
        responsibleMembershipId: row.responsible_membership_id,
        linkedType: row.linked_type,
        linkedId: row.linked_id
      }));
    });
  }

  async create(
    context: TenantContext,
    input: {
      title: string;
      type?: string;
      priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      dueAt?: string;
      responsibleMembershipId?: string;
      linkedType?: string;
      linkedId?: string;
      description?: string;
    }
  ): Promise<{ id: string }> {
    const scope = await this.authorization.resolveScope(context, "tasks.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    const title = input.title.trim();
    if (title.length < 2 || title.length > 240) {
      throw new BadRequestException("Некорректное название задачи");
    }

    const responsible =
      scope === "own"
        ? context.membershipId
        : input.responsibleMembershipId ?? context.membershipId;

    let dueAt: Date | null = null;
    if (input.dueAt) {
      dueAt = new Date(input.dueAt);
      if (Number.isNaN(dueAt.getTime())) {
        throw new BadRequestException("Некорректный срок задачи");
      }
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const membership = await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'ACTIVE'`,
        [context.tenantId, responsible]
      );

      if (!membership.rowCount) {
        throw new BadRequestException("Ответственный сотрудник недоступен");
      }

      if (input.linkedType && input.linkedId) {
        await this.validateLinkedEntity(
          client,
          context.tenantId,
          input.linkedType,
          input.linkedId
        );
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO task(
           tenant_id, title, type, priority, due_at,
           responsible_membership_id, linked_type, linked_id,
           description, created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          context.tenantId,
          title,
          input.type?.trim() || "OTHER",
          input.priority ?? "NORMAL",
          dueAt,
          responsible,
          input.linkedType?.trim().toUpperCase() || null,
          input.linkedId ?? null,
          input.description?.trim() || null,
          context.membershipId
        ]
      );

      const task = result.rows[0];
      if (!task) throw new Error("TASK_CREATE_FAILED");

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id
         ) VALUES ($1,$2,$3,'task.created','task',$4)`,
        [context.tenantId, context.userId, context.membershipId, task.id]
      );

      return task;
    });
  }

  async move(
    context: TenantContext,
    taskId: string,
    state: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED"
  ): Promise<{ id: string; state: string }> {
    const scope = await this.authorization.resolveScope(context, "tasks.write");
    if (!scope) throw new BadRequestException("Недостаточно прав");

    return this.database.withTenantTransaction(context, async (client) => {
      const values: unknown[] = [
        context.tenantId,
        taskId,
        state
      ];

      let scopeSql = "";
      if (scope === "own") {
        values.push(context.membershipId);
        scopeSql = `AND responsible_membership_id = $${values.length}`;
      }

      const result = await client.query<{ id: string; state: string }>(
        `UPDATE task
         SET state = $3,
             completed_at = CASE WHEN $3 = 'DONE' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2
           ${scopeSql}
         RETURNING id, state`,
        values
      );

      const task = result.rows[0];
      if (!task) throw new NotFoundException("Задача не найдена");

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, after_data
         ) VALUES ($1,$2,$3,'task.state_changed','task',$4,$5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          task.id,
          JSON.stringify({ state: task.state })
        ]
      );

      return task;
    });
  }

  private async validateLinkedEntity(
    client: import("pg").PoolClient,
    tenantId: string,
    linkedType: string,
    linkedId: string
  ): Promise<void> {
    const type = linkedType.trim().toUpperCase();

    if (type === "DEAL") {
      const result = await client.query(
        "SELECT 1 FROM crm_deal WHERE tenant_id = $1 AND id = $2",
        [tenantId, linkedId]
      );
      if (!result.rowCount) throw new NotFoundException("Сделка не найдена");
      return;
    }

    if (type === "PARTY") {
      const result = await client.query(
        "SELECT 1 FROM party WHERE tenant_id = $1 AND id = $2",
        [tenantId, linkedId]
      );
      if (!result.rowCount) throw new NotFoundException("Клиент не найден");
      return;
    }

    throw new BadRequestException("Связь с этим типом объекта пока не поддерживается");
  }
}

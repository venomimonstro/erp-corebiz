import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type Condition = {
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
  value: unknown;
};

type Action =
  | { type: "CREATE_TASK"; title: string; responsibleMembershipId?: string; priority?: string }
  | { type: "ASSIGN_RESPONSIBLE"; membershipId: string }
  | { type: "ADD_TAG"; tag: string }
  | { type: "NOTIFY"; title: string; body?: string; recipientMembershipId?: string };

@Injectable()
export class WorkflowService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT d.id, d.name, d.trigger_event, d.entity_type, d.enabled, " +
        "v.id AS version_id, v.version, v.status, v.conditions, v.actions, v.published_at " +
        "FROM workflow_definition d LEFT JOIN workflow_version v " +
        "ON v.tenant_id = d.tenant_id AND v.workflow_id = d.id " +
        "WHERE d.tenant_id = $1 " +
        "ORDER BY d.updated_at DESC, v.version DESC",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async createDefinition(
    context: TenantContext,
    input: {
      name: string;
      triggerEvent: string;
      entityType?: string;
    }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    const triggerEvent = input.triggerEvent.trim();

    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название workflow");
    }
    if (!/^[a-z0-9_.-]{3,120}$/i.test(triggerEvent)) {
      throw new BadRequestException("Некорректное имя события");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO workflow_definition(" +
        "tenant_id, name, trigger_event, entity_type, created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [
          context.tenantId,
          name,
          triggerEvent,
          input.entityType?.trim() || null,
          context.membershipId
        ]
      );

      return { id: result.rows[0]!.id };
    });
  }

  async createDraft(
    context: TenantContext,
    workflowId: string,
    input: {
      conditions?: Condition[];
      actions: Action[];
    }
  ): Promise<{ id: string; version: number }> {
    this.validateConditions(input.conditions ?? []);
    this.validateActions(input.actions ?? []);

    return this.database.withTenantTransaction(context, async (client) => {
      const workflow = await client.query(
        "SELECT 1 FROM workflow_definition WHERE tenant_id = $1 AND id = $2",
        [context.tenantId, workflowId]
      );

      if (!workflow.rowCount) throw new NotFoundException("Workflow не найден");

      const versionResult = await client.query<{ next_version: number }>(
        "SELECT COALESCE(max(version),0) + 1 AS next_version " +
        "FROM workflow_version WHERE tenant_id = $1 AND workflow_id = $2",
        [context.tenantId, workflowId]
      );

      const version = Number(versionResult.rows[0]?.next_version ?? 1);

      const result = await client.query<{ id: string }>(
        "INSERT INTO workflow_version(" +
        "tenant_id, workflow_id, version, status, conditions, actions, created_by_membership_id" +
        ") VALUES ($1,$2,$3,'DRAFT',$4,$5,$6) RETURNING id",
        [
          context.tenantId,
          workflowId,
          version,
          JSON.stringify(input.conditions ?? []),
          JSON.stringify(input.actions),
          context.membershipId
        ]
      );

      return { id: result.rows[0]!.id, version };
    });
  }

  async test(
    context: TenantContext,
    versionId: string,
    payload: Record<string, unknown>
  ): Promise<{
    matched: boolean;
    actions: Action[];
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const version = await client.query<{
        conditions: Condition[];
        actions: Action[];
      }>(
        "SELECT conditions, actions FROM workflow_version " +
        "WHERE tenant_id = $1 AND id = $2",
        [context.tenantId, versionId]
      );

      const row = version.rows[0];
      if (!row) throw new NotFoundException("Версия workflow не найдена");

      const conditions = Array.isArray(row.conditions) ? row.conditions : [];
      const actions = Array.isArray(row.actions) ? row.actions : [];

      this.validateConditions(conditions);
      this.validateActions(actions);

      return {
        matched: this.matches(conditions, payload),
        actions
      };
    });
  }

  async publish(
    context: TenantContext,
    versionId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const version = await client.query<{
        workflow_id: string;
        status: string;
        conditions: Condition[];
        actions: Action[];
      }>(
        "SELECT workflow_id, status, conditions, actions " +
        "FROM workflow_version WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [context.tenantId, versionId]
      );

      const row = version.rows[0];
      if (!row) throw new NotFoundException("Версия workflow не найдена");
      if (row.status === "PUBLISHED") return;
      if (row.status !== "DRAFT") {
        throw new BadRequestException("Опубликовать можно только draft");
      }

      this.validateConditions(Array.isArray(row.conditions) ? row.conditions : []);
      this.validateActions(Array.isArray(row.actions) ? row.actions : []);

      await client.query(
        "UPDATE workflow_version SET status = 'ARCHIVED' " +
        "WHERE tenant_id = $1 AND workflow_id = $2 AND status = 'PUBLISHED'",
        [context.tenantId, row.workflow_id]
      );

      await client.query(
        "UPDATE workflow_version SET status = 'PUBLISHED', " +
        "published_by_membership_id = $3, published_at = now() " +
        "WHERE tenant_id = $1 AND id = $2",
        [context.tenantId, versionId, context.membershipId]
      );

      await client.query(
        "UPDATE workflow_definition SET enabled = true, updated_at = now() " +
        "WHERE tenant_id = $1 AND id = $2",
        [context.tenantId, row.workflow_id]
      );
    });
  }

  async executions(
    context: TenantContext
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT e.id, d.name AS workflow_name, e.status, e.depth, " +
        "e.input_payload, e.output_payload, e.error_message, " +
        "e.started_at, e.finished_at " +
        "FROM workflow_execution e JOIN workflow_definition d " +
        "ON d.tenant_id = e.tenant_id AND d.id = e.workflow_id " +
        "WHERE e.tenant_id = $1 ORDER BY e.started_at DESC LIMIT 200",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  private validateConditions(conditions: Condition[]): void {
    if (conditions.length > 20) {
      throw new BadRequestException("Максимум 20 условий");
    }

    const ops = new Set(["eq","neq","gt","gte","lt","lte","contains"]);
    for (const condition of conditions) {
      if (!condition?.field || !ops.has(condition.op)) {
        throw new BadRequestException("Некорректное условие workflow");
      }
    }
  }

  private validateActions(actions: Action[]): void {
    if (!actions.length) {
      throw new BadRequestException("Workflow должен содержать действие");
    }
    if (actions.length > 20) {
      throw new BadRequestException("Максимум 20 действий");
    }

    const allowed = new Set([
      "CREATE_TASK",
      "ASSIGN_RESPONSIBLE",
      "ADD_TAG",
      "NOTIFY"
    ]);

    for (const action of actions) {
      if (!action || !allowed.has(action.type)) {
        throw new BadRequestException("Недопустимое действие workflow");
      }

      if (action.type === "CREATE_TASK" && !action.title?.trim()) {
        throw new BadRequestException("У CREATE_TASK нет title");
      }
      if (
        action.type === "ASSIGN_RESPONSIBLE" &&
        !action.membershipId
      ) {
        throw new BadRequestException("Не указан ответственный");
      }
      if (action.type === "ADD_TAG" && !action.tag?.trim()) {
        throw new BadRequestException("Не указан тег");
      }
      if (action.type === "NOTIFY" && !action.title?.trim()) {
        throw new BadRequestException("У NOTIFY нет title");
      }
    }
  }

  private matches(
    conditions: Condition[],
    payload: Record<string, unknown>
  ): boolean {
    return conditions.every((condition) => {
      const actual = this.getPath(payload, condition.field);
      const expected = condition.value;

      switch (condition.op) {
        case "eq":
          return actual === expected;
        case "neq":
          return actual !== expected;
        case "gt":
          return Number(actual) > Number(expected);
        case "gte":
          return Number(actual) >= Number(expected);
        case "lt":
          return Number(actual) < Number(expected);
        case "lte":
          return Number(actual) <= Number(expected);
        case "contains":
          return Array.isArray(actual)
            ? actual.includes(expected)
            : String(actual ?? "").includes(String(expected ?? ""));
      }
    });
  }

  private getPath(
    payload: Record<string, unknown>,
    path: string
  ): unknown {
    let current: unknown = payload;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}

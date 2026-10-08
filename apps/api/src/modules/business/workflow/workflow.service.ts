import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type Condition = {
  path: string;
  operator: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE" | "IN" | "EXISTS";
  value?: unknown;
};

type Action =
  | { type: "CREATE_TASK"; title: string; assigneeMembershipId?: string; dueInHours?: number; linkedType?: string; linkedIdPath?: string }
  | { type: "ADD_TAG"; tag: string; entityType?: string; entityIdPath?: string }
  | { type: "NOTIFY"; recipientMembershipId?: string; title: string; body?: string; linkedType?: string; linkedIdPath?: string };

@Injectable()
export class WorkflowService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT d.id,d.name,d.trigger_event,d.entity_type,d.enabled,d.updated_at," +
        "v.id AS published_version_id,v.version AS published_version " +
        "FROM workflow_definition d LEFT JOIN workflow_version v " +
        "ON v.tenant_id=d.tenant_id AND v.workflow_id=d.id AND v.status='PUBLISHED' " +
        "WHERE d.tenant_id=$1 ORDER BY d.updated_at DESC",
        [context.tenantId]
      );
      return result.rows;
    });
  }

  async create(
    context: TenantContext,
    input: { name: string; triggerEvent: string; entityType?: string }
  ): Promise<{ id: string }> {
    const name = input.name.trim();
    const trigger = input.triggerEvent.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название автоматизации");
    }
    if (!/^[a-z][a-z0-9_.-]{2,120}$/.test(trigger)) {
      throw new BadRequestException("Некорректное имя события");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO workflow_definition(" +
        "tenant_id,name,trigger_event,entity_type,created_by_membership_id" +
        ") VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [context.tenantId, name, trigger, input.entityType?.trim() || null, context.membershipId]
      );
      return { id: result.rows[0]!.id };
    });
  }

  async createDraft(
    context: TenantContext,
    workflowId: string,
    input: { conditions?: Condition[]; actions: Action[] }
  ): Promise<{ id: string; version: number; validation: string[] }> {
    const validation = this.validateDefinition(input.conditions ?? [], input.actions ?? []);

    return this.database.withTenantTransaction(context, async (client) => {
      const exists = await client.query(
        "SELECT 1 FROM workflow_definition WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, workflowId]
      );
      if (!exists.rowCount) throw new NotFoundException("Автоматизация не найдена");

      const versionResult = await client.query<{ next_version: number }>(
        "SELECT COALESCE(max(version),0)+1 AS next_version " +
        "FROM workflow_version WHERE tenant_id=$1 AND workflow_id=$2",
        [context.tenantId, workflowId]
      );
      const version = Number(versionResult.rows[0]?.next_version ?? 1);

      const result = await client.query<{ id: string }>(
        "INSERT INTO workflow_version(" +
        "tenant_id,workflow_id,version,status,conditions,actions,created_by_membership_id" +
        ") VALUES ($1,$2,$3,'DRAFT',$4,$5,$6) RETURNING id",
        [
          context.tenantId,
          workflowId,
          version,
          JSON.stringify(input.conditions ?? []),
          JSON.stringify(input.actions ?? []),
          context.membershipId
        ]
      );

      return { id: result.rows[0]!.id, version, validation };
    });
  }

  async test(
    context: TenantContext,
    versionId: string,
    payload: Record<string, unknown>
  ): Promise<{ matched: boolean; actions: Action[]; validation: string[] }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ conditions: Condition[]; actions: Action[] }>(
        "SELECT conditions,actions FROM workflow_version WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, versionId]
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Версия автоматизации не найдена");

      const conditions = Array.isArray(row.conditions) ? row.conditions : [];
      const actions = Array.isArray(row.actions) ? row.actions : [];
      const validation = this.validateDefinition(conditions, actions);

      return {
        matched: validation.length === 0 && this.matches(conditions, payload),
        actions,
        validation
      };
    });
  }

  async publish(context: TenantContext, versionId: string): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        workflow_id: string;
        status: string;
        conditions: Condition[];
        actions: Action[];
      }>(
        "SELECT workflow_id,status,conditions,actions FROM workflow_version " +
        "WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId, versionId]
      );

      const version = result.rows[0];
      if (!version) throw new NotFoundException("Версия автоматизации не найдена");
      if (version.status === "PUBLISHED") return;
      if (version.status !== "DRAFT") {
        throw new BadRequestException("Опубликовать можно только draft");
      }

      const validation = this.validateDefinition(
        Array.isArray(version.conditions) ? version.conditions : [],
        Array.isArray(version.actions) ? version.actions : []
      );
      if (validation.length) {
        throw new BadRequestException(validation.join("; "));
      }

      await client.query(
        "UPDATE workflow_version SET status='ARCHIVED' " +
        "WHERE tenant_id=$1 AND workflow_id=$2 AND status='PUBLISHED'",
        [context.tenantId, version.workflow_id]
      );

      await client.query(
        "UPDATE workflow_version SET status='PUBLISHED'," +
        "published_by_membership_id=$3,published_at=now() " +
        "WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, versionId, context.membershipId]
      );

      await client.query(
        "UPDATE workflow_definition SET enabled=true,updated_at=now() " +
        "WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, version.workflow_id]
      );
    });
  }

  async executions(
    context: TenantContext,
    workflowId?: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query(
        "SELECT e.id,e.workflow_id,d.name AS workflow_name,e.status,e.depth," +
        "e.input_payload,e.output_payload,e.error_message,e.started_at,e.finished_at " +
        "FROM workflow_execution e JOIN workflow_definition d " +
        "ON d.tenant_id=e.tenant_id AND d.id=e.workflow_id " +
        "WHERE e.tenant_id=$1 AND ($2::uuid IS NULL OR e.workflow_id=$2) " +
        "ORDER BY e.started_at DESC LIMIT 200",
        [context.tenantId, workflowId ?? null]
      );
      return result.rows;
    });
  }

  validateDefinition(conditions: Condition[], actions: Action[]): string[] {
    const errors: string[] = [];
    if (conditions.length > 20) errors.push("Не более 20 условий");
    if (!actions.length) errors.push("Добавьте хотя бы одно действие");
    if (actions.length > 10) errors.push("Не более 10 действий");

    const operators = new Set(["EQ","NEQ","GT","GTE","LT","LTE","IN","EXISTS"]);

    for (const condition of conditions) {
      if (!condition.path || condition.path.length > 160) {
        errors.push("Некорректный путь условия");
      }
      if (!operators.has(condition.operator)) {
        errors.push("Недопустимый оператор условия");
      }
    }

    for (const action of actions) {
      if (action.type === "CREATE_TASK") {
        if (!action.title?.trim()) errors.push("CREATE_TASK: нет заголовка");
        if ((action.dueInHours ?? 0) > 24 * 365) errors.push("CREATE_TASK: срок слишком большой");
      } else if (action.type === "ADD_TAG") {
        if (!action.tag?.trim() || action.tag.length > 80) errors.push("ADD_TAG: некорректный тег");
      } else if (action.type === "NOTIFY") {
        if (!action.title?.trim()) errors.push("NOTIFY: нет заголовка");
      } else {
        errors.push("Недопустимое действие workflow");
      }
    }
    return errors;
  }

  private matches(conditions: Condition[], payload: Record<string, unknown>): boolean {
    return conditions.every((condition) => {
      const actual = this.readPath(payload, condition.path);
      if (condition.operator === "EXISTS") return actual !== undefined && actual !== null;
      if (condition.operator === "EQ") return actual === condition.value;
      if (condition.operator === "NEQ") return actual !== condition.value;
      if (condition.operator === "IN") {
        return Array.isArray(condition.value) && condition.value.includes(actual);
      }
      const left = Number(actual);
      const right = Number(condition.value);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      if (condition.operator === "GT") return left > right;
      if (condition.operator === "GTE") return left >= right;
      if (condition.operator === "LT") return left < right;
      if (condition.operator === "LTE") return left <= right;
      return false;
    });
  }

  private readPath(source: unknown, path: string): unknown {
    const clean = path.replace(/^payload\./, "");
    if (!clean) return source;
    return clean.split(".").reduce<unknown>((current, key) => {
      if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, source);
  }
}

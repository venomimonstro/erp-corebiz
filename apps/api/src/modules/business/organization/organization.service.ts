import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class OrganizationService {
  constructor(private readonly database: DatabaseService) {}

  async overview(context: TenantContext): Promise<{
    legalEntities: Array<{ id: string; name: string; inn: string | null; kpp: string | null }>;
    branches: Array<{ id: string; name: string; legalEntityId: string | null }>;
    teams: Array<{ id: string; name: string; branchId: string | null; members: number }>;
  }> {
    return this.database.withTenantTransaction(context, async (client) => {
      const legalEntities = await client.query<{
        id: string;
        name: string;
        inn: string | null;
        kpp: string | null;
      }>(
        "SELECT id, name, inn, kpp FROM legal_entity WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY name",
        [context.tenantId]
      );

      const branches = await client.query<{
        id: string;
        name: string;
        legal_entity_id: string | null;
      }>(
        "SELECT id, name, legal_entity_id FROM branch WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY name",
        [context.tenantId]
      );

      const teams = await client.query<{
        id: string;
        name: string;
        branch_id: string | null;
        members: string;
      }>(
        "SELECT t.id, t.name, t.branch_id, count(tm.membership_id)::text AS members FROM team t LEFT JOIN team_membership tm ON tm.team_id = t.id AND tm.tenant_id = t.tenant_id WHERE t.tenant_id = $1 AND t.status = 'ACTIVE' GROUP BY t.id, t.name, t.branch_id ORDER BY t.name",
        [context.tenantId]
      );

      return {
        legalEntities: legalEntities.rows.map((row) => ({
          id: row.id,
          name: row.name,
          inn: row.inn,
          kpp: row.kpp
        })),
        branches: branches.rows.map((row) => ({
          id: row.id,
          name: row.name,
          legalEntityId: row.legal_entity_id
        })),
        teams: teams.rows.map((row) => ({
          id: row.id,
          name: row.name,
          branchId: row.branch_id,
          members: Number(row.members)
        }))
      };
    });
  }

  async createLegalEntity(
    context: TenantContext,
    input: { name: string; inn?: string; kpp?: string }
  ): Promise<{ id: string; name: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 200) {
      throw new BadRequestException("Некорректное название юрлица");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{ id: string; name: string }>(
        "INSERT INTO legal_entity(tenant_id, name, inn, kpp) VALUES ($1,$2,$3,$4) RETURNING id, name",
        [context.tenantId, name, input.inn?.trim() || null, input.kpp?.trim() || null]
      );

      const entity = result.rows[0];
      if (!entity) throw new Error("LEGAL_ENTITY_CREATE_FAILED");

      await this.audit(client, context, "organization.legal_entity_created", "legal_entity", entity.id);
      return entity;
    });
  }

  async createBranch(
    context: TenantContext,
    input: { name: string; legalEntityId?: string }
  ): Promise<{ id: string; name: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название филиала");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.legalEntityId) {
        const legalEntity = await client.query(
          "SELECT 1 FROM legal_entity WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'",
          [context.tenantId, input.legalEntityId]
        );
        if (!legalEntity.rowCount) throw new NotFoundException("Юрлицо не найдено");
      }

      const result = await client.query<{ id: string; name: string }>(
        "INSERT INTO branch(tenant_id, legal_entity_id, name) VALUES ($1,$2,$3) RETURNING id, name",
        [context.tenantId, input.legalEntityId ?? null, name]
      );

      const branch = result.rows[0];
      if (!branch) throw new Error("BRANCH_CREATE_FAILED");

      await this.audit(client, context, "organization.branch_created", "branch", branch.id);
      return branch;
    });
  }

  async createTeam(
    context: TenantContext,
    input: { name: string; branchId?: string }
  ): Promise<{ id: string; name: string }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException("Некорректное название команды");
    }

    return this.database.withTenantTransaction(context, async (client) => {
      if (input.branchId) {
        const branch = await client.query(
          "SELECT 1 FROM branch WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'",
          [context.tenantId, input.branchId]
        );
        if (!branch.rowCount) throw new NotFoundException("Филиал не найден");
      }

      const result = await client.query<{ id: string; name: string }>(
        "INSERT INTO team(tenant_id, branch_id, name) VALUES ($1,$2,$3) RETURNING id, name",
        [context.tenantId, input.branchId ?? null, name]
      );

      const team = result.rows[0];
      if (!team) throw new Error("TEAM_CREATE_FAILED");

      await this.audit(client, context, "organization.team_created", "team", team.id);
      return team;
    });
  }

  async assignTeam(
    context: TenantContext,
    teamId: string,
    membershipId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const team = await client.query(
        "SELECT 1 FROM team WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'",
        [context.tenantId, teamId]
      );
      const membership = await client.query(
        "SELECT 1 FROM tenant_membership WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'",
        [context.tenantId, membershipId]
      );

      if (!team.rowCount) throw new NotFoundException("Команда не найдена");
      if (!membership.rowCount) throw new NotFoundException("Сотрудник не найден");

      await client.query(
        "INSERT INTO team_membership(tenant_id, team_id, membership_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [context.tenantId, teamId, membershipId]
      );

      await this.audit(
        client,
        context,
        "organization.team_member_added",
        "team",
        teamId,
        { membershipId }
      );
    });
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
      "INSERT INTO audit_event(tenant_id, actor_user_id, actor_membership_id, action, resource_type, resource_id, after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
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
}

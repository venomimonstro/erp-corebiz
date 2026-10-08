import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class RolesService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      isSystem: boolean;
      permissions: Array<{ code: string; scope: string }>;
    }>
  > {
    return this.database.withTenantTransaction(context, async (client) => {
      const roles = await client.query<{
        id: string;
        code: string;
        name: string;
        is_system: boolean;
      }>(
        `SELECT id, code, name, is_system
         FROM tenant_role
         WHERE tenant_id = $1
         ORDER BY is_system DESC, name ASC`,
        [context.tenantId]
      );

      const permissions = await client.query<{
        role_id: string;
        permission_code: string;
        scope: string;
      }>(
        `SELECT role_id, permission_code, scope
         FROM role_permission
         WHERE tenant_id = $1
         ORDER BY permission_code`,
        [context.tenantId]
      );

      return roles.rows.map((role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        isSystem: role.is_system,
        permissions: permissions.rows
          .filter((p) => p.role_id === role.id)
          .map((p) => ({ code: p.permission_code, scope: p.scope }))
      }));
    });
  }

  async assignRole(
    context: TenantContext,
    membershipId: string,
    roleId: string
  ): Promise<void> {
    await this.database.withTenantTransaction(context, async (client) => {
      const membership = await client.query(
        `SELECT id
         FROM tenant_membership
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'ACTIVE'`,
        [context.tenantId, membershipId]
      );

      if (!membership.rowCount) {
        throw new NotFoundException("Сотрудник не найден");
      }

      const role = await client.query<{
        code: string;
      }>(
        `SELECT code
         FROM tenant_role
         WHERE tenant_id = $1
           AND id = $2`,
        [context.tenantId, roleId]
      );

      const roleRow = role.rows[0];
      if (!roleRow) {
        throw new NotFoundException("Роль не найдена");
      }

      const ownerMembership = await client.query<{ is_owner: boolean }>(
        `SELECT is_owner
         FROM tenant_membership
         WHERE id = $1 AND tenant_id = $2`,
        [membershipId, context.tenantId]
      );

      if (
        ownerMembership.rows[0]?.is_owner &&
        roleRow.code !== "OWNER"
      ) {
        throw new BadRequestException("Роль владельца нельзя заменить");
      }

      await client.query(
        `DELETE FROM membership_role
         WHERE tenant_id = $1
           AND membership_id = $2`,
        [context.tenantId, membershipId]
      );

      await client.query(
        `INSERT INTO membership_role(tenant_id, membership_id, role_id)
         VALUES ($1, $2, $3)`,
        [context.tenantId, membershipId, roleId]
      );

      await client.query(
        `INSERT INTO audit_event(
           tenant_id, actor_user_id, actor_membership_id,
           action, resource_type, resource_id, after_data
         ) VALUES ($1, $2, $3, 'membership.role_changed', 'tenant_membership', $4, $5)`,
        [
          context.tenantId,
          context.userId,
          context.membershipId,
          membershipId,
          JSON.stringify({ roleId })
        ]
      );
    });
  }
}

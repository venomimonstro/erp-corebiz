import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

@Injectable()
export class RolesService {
  constructor(private readonly database: DatabaseService) {}

  private async requireManageAll(
    client:import("pg").PoolClient,context:TenantContext
  ):Promise<void>{
    const result=await client.query(
      `SELECT 1 FROM membership_role mr
       JOIN role_permission rp ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
       JOIN tenant_membership tm ON tm.tenant_id=mr.tenant_id AND tm.id=mr.membership_id
       WHERE mr.tenant_id=$1 AND mr.membership_id=$2
         AND tm.user_id=$3 AND tm.status='ACTIVE'
         AND rp.permission_code IN ('*','roles.manage')
         AND rp.scope='all'
       LIMIT 1`,
      [context.tenantId,context.membershipId,context.userId]
    );
    if(!result.rowCount)throw new ForbiddenException(
      "Управление ролями требует прав на всю организацию"
    );
  }

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
      await this.requireManageAll(client,context);
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
      await this.requireManageAll(client,context);
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

      const ownerMembership = await client.query<{is_owner:boolean}>(
        `SELECT is_owner FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [context.tenantId,membershipId]
      );
      const isTargetOwner=ownerMembership.rows[0]?.is_owner===true;
      if(isTargetOwner&&roleRow.code!=="OWNER")
        throw new BadRequestException("Роль владельца нельзя заменить");
      // OWNER is a legal/business ownership flag, not merely a role row.
      // Never let a roles.manage administrator mint an OWNER identity.
      const actor=await client.query<{is_owner:boolean}>(
        `SELECT is_owner FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND status='ACTIVE'`,
        [context.tenantId,context.membershipId,context.userId]
      );
      if(!actor.rows[0])throw new ForbiddenException("Сотрудник не активен");
      if(roleRow.code==="OWNER"&&(!isTargetOwner||!actor.rows[0].is_owner))
        throw new ForbiddenException(
          "Назначение владельца не является операцией управления ролями"
        );
      if(!actor.rows[0].is_owner){
        // An administrator can delegate no more than the permissions and
        // object scopes they themselves hold. Compare EVERY permission in
        // the assigned role; permission_code='*' must match an actor wildcard.
        const elevated=await client.query<{permission_code:string;scope:string}>(
          `SELECT target.permission_code,target.scope
           FROM role_permission target
           WHERE target.tenant_id=$1 AND target.role_id=$2
             AND NOT EXISTS (
               SELECT 1
               FROM membership_role actor_role
               JOIN role_permission own_grant
                 ON own_grant.tenant_id=actor_role.tenant_id
                AND own_grant.role_id=actor_role.role_id
               WHERE actor_role.tenant_id=$1
                 AND actor_role.membership_id=$3
                 AND own_grant.permission_code IN ('*',target.permission_code)
                 AND (CASE own_grant.scope
                        WHEN 'all' THEN 4 WHEN 'branch' THEN 3
                        WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END)
                     >= (CASE target.scope
                        WHEN 'all' THEN 4 WHEN 'branch' THEN 3
                        WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END)
             )
           LIMIT 1`,
          [context.tenantId,roleId,context.membershipId]
        );
        if(elevated.rows.length)
          throw new ForbiddenException(
            "Нельзя назначить роль с правами выше собственных полномочий"
          );
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

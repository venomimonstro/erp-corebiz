import { Injectable } from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";

export type PermissionScope = "own" | "team" | "branch" | "all";

@Injectable()
export class AuthorizationService {
  constructor(private readonly database: DatabaseService) {}

  async resolveScope(
    context: TenantContext,
    permissionCode: string
  ): Promise<PermissionScope | null> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<{
        permission_code: string;
        scope: PermissionScope;
      }>(
        `SELECT rp.permission_code, rp.scope
         FROM membership_role mr
         JOIN role_permission rp
           ON rp.role_id = mr.role_id
          AND rp.tenant_id = mr.tenant_id
         WHERE mr.tenant_id = $1
           AND mr.membership_id = $2
           AND rp.permission_code IN ('*', $3)`,
        [context.tenantId, context.membershipId, permissionCode]
      );

      const wildcard = result.rows.find((row) => row.permission_code === "*");
      if (wildcard) return "all";

      const exact = result.rows.find(
        (row) => row.permission_code === permissionCode
      );

      return exact?.scope ?? null;
    });
  }

  async membershipIdsForScope(
    context: TenantContext,
    scope: PermissionScope
  ): Promise<string[] | null> {
    if (scope === "all") return null;
    if (scope === "own") return [context.membershipId];

    return this.database.withTenantTransaction(context, async (client) => {
      if (scope === "team") {
        const result = await client.query<{ membership_id: string }>(
          `SELECT DISTINCT membership_id
           FROM (
             SELECT $2::uuid AS membership_id
             UNION
             SELECT tm2.membership_id
             FROM team_membership tm1
             JOIN team_membership tm2
               ON tm2.tenant_id = tm1.tenant_id
              AND tm2.team_id = tm1.team_id
             WHERE tm1.tenant_id = $1
               AND tm1.membership_id = $2
           ) scoped`,
          [context.tenantId, context.membershipId]
        );

        return result.rows.map((row) => row.membership_id);
      }

      const result = await client.query<{ membership_id: string }>(
        `SELECT DISTINCT membership_id
         FROM (
           SELECT $2::uuid AS membership_id
           UNION
           SELECT tm2.membership_id
           FROM team_membership tm1
           JOIN team t1
             ON t1.tenant_id = tm1.tenant_id
            AND t1.id = tm1.team_id
           JOIN team t2
             ON t2.tenant_id = t1.tenant_id
            AND t2.branch_id = t1.branch_id
           JOIN team_membership tm2
             ON tm2.tenant_id = t2.tenant_id
            AND tm2.team_id = t2.id
           WHERE tm1.tenant_id = $1
             AND tm1.membership_id = $2
             AND t1.branch_id IS NOT NULL
         ) scoped`,
        [context.tenantId, context.membershipId]
      );

      return result.rows.map((row) => row.membership_id);
    });
  }

  async hasPermission(
    context: TenantContext,
    permissionCode: string
  ): Promise<boolean> {
    return (await this.resolveScope(context, permissionCode)) !== null;
  }
}

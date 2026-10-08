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

  async hasPermission(
    context: TenantContext,
    permissionCode: string
  ): Promise<boolean> {
    return (await this.resolveScope(context, permissionCode)) !== null;
  }
}

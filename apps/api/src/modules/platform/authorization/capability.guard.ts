import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { TenantContext } from "@corebiz/contracts";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { REQUIRED_PERMISSION } from "./require-permission.decorator";

const PERMISSION_CAPABILITY: Record<string, string> = {
  crm: "crm",
  tasks: "tasks",
  catalog: "catalog",
  sales: "sales",
  procurement: "procurement",
  inventory: "inventory",
  finance: "finance",
  accounting: "accounting",
  service: "service",
  dance: "dance",
  projects: "projects",
  channels: "channels",
  oms: "oms",
  returns: "oms",
  sites: "sites",
  analytics: "growth",
  marketing: "growth",
  growth: "growth",
  wms: "wms",
  workflow: "workflow",
  support: "support"
};

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()]
    );

    if (!permission) return true;

    const prefix = permission.split(".", 1)[0] ?? "";
    const capability = PERMISSION_CAPABILITY[prefix];
    if (!capability) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = request.auth;
    if (!auth) return true;

    const tenantContext: TenantContext = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };

    const enabled = await this.database.withTenantTransaction(
      tenantContext,
      async (client) => {
        const result = await client.query<{ enabled: boolean }>(
          `SELECT enabled
           FROM capability_toggle
           WHERE tenant_id=$1 AND capability_key=$2`,
          [auth.tenantId, capability]
        );

        // Legacy tenants may not have a row until migration/backfill is applied.
        // Missing rows remain enabled for backwards compatibility; an explicit
        // false is authoritative and blocks the module on the server.
        return result.rows[0]?.enabled !== false;
      }
    );

    if (!enabled) {
      throw new ForbiddenException(
        "Модуль отключён в настройках компании"
      );
    }

    return true;
  }
}

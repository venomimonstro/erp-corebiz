import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { TenantContext } from "@corebiz/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { AuthorizationService } from "./authorization.service";
import { REQUIRED_PERMISSION } from "./require-permission.decorator";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()]
    );

    if (!permission) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = request.auth;

    if (!auth) {
      throw new ForbiddenException("Недостаточно прав");
    }

    const tenantContext: TenantContext = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: auth.membershipId
    };

    const allowed = await this.authorization.hasPermission(
      tenantContext,
      permission
    );

    if (!allowed) {
      throw new ForbiddenException("Недостаточно прав");
    }

    return true;
  }
}

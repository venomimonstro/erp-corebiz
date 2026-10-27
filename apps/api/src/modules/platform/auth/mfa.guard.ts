import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedRequest } from "./auth.types";
import { PUBLIC_ROUTE } from "./public.decorator";

const MFA_BOOTSTRAP_ROUTES = new Set([
  "/api/v1/auth/mfa/status",
  "/api/v1/auth/mfa/begin",
  "/api/v1/auth/mfa/confirm",
  "/api/v1/auth/mfa/verify-session",
  "/api/v1/auth/mfa/recovery/rotate",
  "/api/v1/auth/mfa/disable",
  "/api/v1/auth/logout",
  "/api/v1/auth/me",
  "/api/v1/auth/switch-tenant",
  "/api/v1/auth/email-verification/status",
  "/api/v1/auth/email-verification/request",
  "/api/v1/workspace/context"
]);

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly reflector:Reflector){}

  canActivate(context:ExecutionContext):boolean{
    const isPublic=this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE,[
      context.getHandler(),context.getClass()
    ]);
    if(isPublic)return true;

    const request=context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth=request.auth;
    if(!auth||!auth.mfaRequired||auth.mfaVerified)return true;

    const path=(request.originalUrl||request.url||request.path||"")
      .split("?")[0]!
      .replace(/\/$/,"");
    if(MFA_BOOTSTRAP_ROUTES.has(path))return true;

    throw new ForbiddenException({
      code:auth.mfaEnabled?"MFA_SESSION_REQUIRED":"MFA_SETUP_REQUIRED",
      message:auth.mfaEnabled
        ?"Подтвердите двухфакторную защиту для этой сессии"
        :"Для вашей роли необходимо включить двухфакторную защиту"
    });
  }
}

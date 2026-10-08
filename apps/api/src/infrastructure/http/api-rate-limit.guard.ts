import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { RedisService } from "../cache/redis.service";
import type { AuthenticatedRequest } from "../../modules/platform/auth/auth.types";

@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request =
      context.switchToHttp().getRequest<AuthenticatedRequest & Request>();

    if (request.method === "OPTIONS") return true;

    const identity = request.auth?.userId ?? request.ip ?? "unknown";
    const tenant = request.auth?.tenantId ?? "public";
    const route = this.routeBucket(request);
    const digest = createHash("sha256")
      .update(identity + "|" + tenant + "|" + route)
      .digest("hex");

    const mutation = !["GET", "HEAD"].includes(request.method.toUpperCase());
    const windowSeconds = 60;
    const limit = mutation ? 120 : 300;
    const count = await this.redis.incrementWindow(
      "api-rate:" + digest,
      windowSeconds
    );

    if (count > limit) {
      throw new HttpException(
        "Слишком много запросов. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    return true;
  }

  private routeBucket(request: Request): string {
    const path = request.path || request.url || "/";
    const normalized = path
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
      .replace(/\/\d+(?=\/|$)/g, "/:id");
    return request.method.toUpperCase() + ":" + normalized.slice(0, 180);
  }
}

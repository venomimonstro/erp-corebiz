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

type Budget = {
  userLimit: number;
  tenantLimit: number | null;
  windowSeconds: number;
  costClass: "LIGHT" | "NORMAL" | "HEAVY";
};

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
    const budget = this.budget(request);

    const userDigest = createHash("sha256")
      .update(identity + "|" + tenant + "|" + route)
      .digest("hex");

    const userCount = await this.redis.incrementWindow(
      "api-rate:user:" + userDigest,
      budget.windowSeconds
    );

    if (userCount > budget.userLimit) {
      this.reject(
        budget,
        "USER_RATE_LIMIT",
        budget.userLimit
      );
    }

    if (tenant !== "public" && budget.tenantLimit !== null) {
      const tenantDigest = createHash("sha256")
        .update(tenant + "|" + route)
        .digest("hex");

      const tenantCount = await this.redis.incrementWindow(
        "api-rate:tenant:" + tenantDigest,
        budget.windowSeconds
      );

      if (tenantCount > budget.tenantLimit) {
        this.reject(
          budget,
          "TENANT_RATE_LIMIT",
          budget.tenantLimit
        );
      }
    }

    return true;
  }

  private budget(request: Request): Budget {
    const method = request.method.toUpperCase();
    const path = request.path || request.url || "/";

    const heavy =
      (
        method !== "GET" &&
        (
          /\/data-management\/exports(?:\/|$)/.test(path) ||
          /\/connections\/[^/]+\/sync(?:\/|$)/.test(path) ||
          /\/analytics\/.*(?:sync|evaluate)(?:\/|$)/.test(path) ||
          /\/assistant(?:\/|$)/.test(path) ||
          /\/migration\/.+(?:run|import|apply)(?:\/|$)/.test(path)
        )
      ) ||
      (
        method === "GET" &&
        (
          /\/data-management\/exports\/.+\/download(?:\/|$)/.test(path) ||
          /\/reports?(?:\/|$)/.test(path)
        )
      );

    if (heavy) {
      return {
        userLimit: 12,
        tenantLimit: 40,
        windowSeconds: 60,
        costClass: "HEAVY"
      };
    }

    if (
      method === "GET" &&
      /\/(?:search|global-search)(?:\/|\?|$)/.test(path)
    ) {
      return {
        userLimit: 30,
        tenantLimit: 120,
        windowSeconds: 60,
        costClass: "NORMAL"
      };
    }

    const mutation = !["GET", "HEAD"].includes(method);
    return {
      userLimit: mutation ? 120 : 300,
      tenantLimit: mutation ? 600 : 1500,
      windowSeconds: 60,
      costClass: "LIGHT"
    };
  }

  private reject(
    budget: Budget,
    code: string,
    limit: number
  ): never {
    throw new HttpException(
      {
        message:
          "Слишком много операций. Повторите через несколько секунд.",
        code,
        costClass: budget.costClass,
        limit,
        retryAfterSeconds: budget.windowSeconds
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }

  private routeBucket(request: Request): string {
    const path = request.path || request.url || "/";
    const normalized = path
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
      .replace(/\/\d+(?=\/|$)/g, "/:id");
    return request.method.toUpperCase() + ":" + normalized.slice(0, 180);
  }
}

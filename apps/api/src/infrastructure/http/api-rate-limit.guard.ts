import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { RedisService } from "../cache/redis.service";
import type { AuthenticatedRequest } from "../../modules/platform/auth/auth.types";
import {
  API_COST_CLASS,
  type ApiCostClass
} from "./api-cost.decorator";

type Policy = {
  windowSeconds: number;
  routeLimit: number;
  identityLimit: number;
  tenantLimit: number;
};

const POLICIES: Record<ApiCostClass, Policy> = {
  NORMAL: {
    windowSeconds: 60,
    routeLimit: 300,
    identityLimit: 900,
    tenantLimit: 6000
  },
  SEARCH: {
    windowSeconds: 60,
    routeLimit: 120,
    identityLimit: 180,
    tenantLimit: 1200
  },
  HEAVY: {
    windowSeconds: 60,
    routeLimit: 30,
    identityLimit: 60,
    tenantLimit: 240
  },
  EXPENSIVE: {
    windowSeconds: 60,
    routeLimit: 6,
    identityLimit: 10,
    tenantLimit: 30
  },
  WEBHOOK: {
    windowSeconds: 60,
    routeLimit: 120,
    identityLimit: 180,
    tenantLimit: 1200
  }
};

@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request =
      http.getRequest<AuthenticatedRequest & Request>();
    const response = http.getResponse<Response>();

    if (request.method === "OPTIONS") return true;

    const configured =
      this.reflector.getAllAndOverride<ApiCostClass>(
        API_COST_CLASS,
        [context.getHandler(), context.getClass()]
      ) ?? "NORMAL";

    const mutation =
      !["GET", "HEAD"].includes(request.method.toUpperCase());

    const policy = this.policy(configured, mutation);
    const identity = request.auth?.userId ?? request.ip ?? "unknown";
    const tenant = request.auth?.tenantId ?? "public";
    const route = this.routeBucket(request);
    const identityHash = this.digest(identity);
    const tenantHash = this.digest(tenant);
    const routeHash = this.digest(
      identity + "|" + tenant + "|" + route
    );

    const prefix = "api-budget:" + configured.toLowerCase() + ":";
    const [routeCount, identityCount, tenantCount] =
      await Promise.all([
        this.redis.incrementWindow(
          prefix + "route:" + routeHash,
          policy.windowSeconds
        ),
        this.redis.incrementWindow(
          prefix + "identity:" + identityHash,
          policy.windowSeconds
        ),
        this.redis.incrementWindow(
          prefix + "tenant:" + tenantHash,
          policy.windowSeconds
        )
      ]);

    if (
      routeCount > policy.routeLimit ||
      identityCount > policy.identityLimit ||
      tenantCount > policy.tenantLimit
    ) {
      response.setHeader(
        "Retry-After",
        String(policy.windowSeconds)
      );

      throw new HttpException(
        {
          code: "API_BUDGET_EXCEEDED",
          message:
            "Лимит нагрузки временно исчерпан. Повторите запрос позже.",
          retryAfterSeconds: policy.windowSeconds,
          costClass: configured
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    return true;
  }

  private policy(
    costClass: ApiCostClass,
    mutation: boolean
  ): Policy {
    const base = POLICIES[costClass];

    if (costClass !== "NORMAL") return base;

    return {
      ...base,
      routeLimit: mutation ? 120 : base.routeLimit
    };
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private routeBucket(request: Request): string {
    const path = request.path || request.url || "/";
    const normalized = path
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
      .replace(/\/\d+(?=\/|$)/g, "/:id");

    return (
      request.method.toUpperCase() +
      ":" +
      normalized.slice(0, 180)
    );
  }
}

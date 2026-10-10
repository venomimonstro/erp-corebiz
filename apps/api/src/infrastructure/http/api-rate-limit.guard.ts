import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { RedisService } from "../cache/redis.service";
import {
  API_COST_CLASS,
  type ApiCostClass
} from "./api-cost.decorator";
import type { AuthenticatedRequest } from "../../modules/platform/auth/auth.types";
import { RuntimePressureService } from "../../modules/platform/runtime-pressure/runtime-pressure.service";

type Budget = {
  userLimit: number;
  tenantLimit: number | null;
  windowSeconds: number;
  costClass: "LIGHT" | "NORMAL" | "HEAVY" | "EXPENSIVE" | "WEBHOOK";
  userConcurrency: number | null;
  tenantConcurrency: number | null;
  leaseSeconds: number;
};

@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
    private readonly runtimePressure: RuntimePressureService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request =
      context.switchToHttp().getRequest<AuthenticatedRequest & Request>();
    const response = context.switchToHttp().getResponse<Response>();

    if (request.method === "OPTIONS") return true;

    const identity = request.auth?.userId ?? request.ip ?? "unknown";
    const tenant = request.auth?.tenantId ?? "public";
    const route = this.routeBucket(request);
    const budget = this.budget(context, request);

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

    if (
      tenant !== "public" &&
      request.auth &&
      (
        budget.userConcurrency !== null ||
        budget.tenantConcurrency !== null
      )
    ) {
      await this.acquireConcurrency(
        request,
        response,
        route,
        budget
      );
    }

    return true;
  }

  private budget(
    context: ExecutionContext,
    request: Request
  ): Budget {
    const metadata = this.reflector.getAllAndOverride<ApiCostClass>(
      API_COST_CLASS,
      [context.getHandler(), context.getClass()]
    );

    const inferred = metadata ?? this.inferCostClass(request);

    if (inferred === "EXPENSIVE") {
      return {
        userLimit: 8,
        tenantLimit: 24,
        windowSeconds: 60,
        costClass: "EXPENSIVE",
        userConcurrency: 1,
        tenantConcurrency: 2,
        leaseSeconds: 300
      };
    }

    if (inferred === "HEAVY") {
      return {
        userLimit: 20,
        tenantLimit: 80,
        windowSeconds: 60,
        costClass: "HEAVY",
        userConcurrency: 2,
        tenantConcurrency: 4,
        leaseSeconds: 180
      };
    }

    if (inferred === "SEARCH") {
      return {
        userLimit: 30,
        tenantLimit: 120,
        windowSeconds: 60,
        costClass: "NORMAL",
        userConcurrency: null,
        tenantConcurrency: null,
        leaseSeconds: 60
      };
    }

    if (inferred === "WEBHOOK") {
      return {
        userLimit: 240,
        tenantLimit: null,
        windowSeconds: 60,
        costClass: "WEBHOOK",
        userConcurrency: null,
        tenantConcurrency: null,
        leaseSeconds: 60
      };
    }

    const mutation = !["GET", "HEAD"].includes(
      request.method.toUpperCase()
    );

    return {
      userLimit: mutation ? 120 : 300,
      tenantLimit: mutation ? 600 : 1500,
      windowSeconds: 60,
      costClass: "LIGHT",
      userConcurrency: null,
      tenantConcurrency: null,
      leaseSeconds: 60
    };
  }

  private inferCostClass(request: Request): ApiCostClass {
    const method = request.method.toUpperCase();
    const path = request.path || request.url || "/";

    const expensive =
      method !== "GET" &&
      (
        /\/data-management\/exports(?:\/|$)/.test(path) ||
        /\/connections\/[^/]+\/sync(?:\/|$)/.test(path) ||
        /\/analytics\/.*(?:sync|evaluate)(?:\/|$)/.test(path) ||
        /\/assistant(?:\/|$)/.test(path) ||
        /\/migration\/.+(?:run|import|apply)(?:\/|$)/.test(path)
      );

    if (expensive) return "EXPENSIVE";

    const heavy =
      method === "GET" &&
      (
        /\/data-management\/exports\/.+\/download(?:\/|$)/.test(path) ||
        /\/reports?(?:\/|$)/.test(path)
      );

    if (heavy) return "HEAVY";

    if (
      method === "GET" &&
      /\/(?:search|global-search)(?:\/|\?|$)/.test(path)
    ) {
      return "SEARCH";
    }

    return "NORMAL";
  }

  private async acquireConcurrency(
    request: AuthenticatedRequest & Request,
    response: Response,
    route: string,
    budget: Budget
  ): Promise<void> {
    const auth = request.auth!;
    const token = randomUUID();
    const routeHash = createHash("sha256")
      .update(route)
      .digest("hex")
      .slice(0, 24);

    const held: Array<{ key: string; token: string }> = [];

    try {
      if (budget.userConcurrency !== null) {
        const userKey =
          "api-concurrency:user:" +
          auth.tenantId +
          ":" +
          auth.userId +
          ":" +
          routeHash;

        const acquired = await this.redis.acquireSemaphore(
          userKey,
          token,
          budget.userConcurrency,
          budget.leaseSeconds
        );

        if (!acquired) {
          await this.runtimePressure.deny(
            {
              tenantId: auth.tenantId,
              userId: auth.userId,
              membershipId: auth.membershipId
            },
            {
              operation: route,
              reason: "USER_CONCURRENCY_LIMIT",
              currentValue: budget.userConcurrency,
              limitValue: budget.userConcurrency,
              retryAfterSeconds: 5
            }
          );
        }

        held.push({ key: userKey, token });
      }

      if (budget.tenantConcurrency !== null) {
        const tenantKey =
          "api-concurrency:tenant:" +
          auth.tenantId +
          ":" +
          routeHash;

        const acquired = await this.redis.acquireSemaphore(
          tenantKey,
          token,
          budget.tenantConcurrency,
          budget.leaseSeconds
        );

        if (!acquired) {
          await this.releaseHeld(held);
          await this.runtimePressure.deny(
            {
              tenantId: auth.tenantId,
              userId: auth.userId,
              membershipId: auth.membershipId
            },
            {
              operation: route,
              reason: "TENANT_CONCURRENCY_LIMIT",
              currentValue: budget.tenantConcurrency,
              limitValue: budget.tenantConcurrency,
              retryAfterSeconds: 5
            }
          );
        }

        held.push({ key: tenantKey, token });
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void this.releaseHeld(held);
      };

      response.once("finish", release);
      response.once("close", release);
    } catch (error) {
      await this.releaseHeld(held);
      throw error;
    }
  }

  private async releaseHeld(
    held: Array<{ key: string; token: string }>
  ): Promise<void> {
    await Promise.all(
      held.map(({ key, token }) =>
        this.redis.releaseSemaphore(key, token)
      )
    );
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

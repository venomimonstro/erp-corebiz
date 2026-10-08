import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable
} from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "../../../infrastructure/config/env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const env = getEnv();
    const origin = request.headers.origin;

    if (!origin && env.nodeEnv !== "production") {
      return true;
    }

    if (origin !== env.webOrigin) {
      throw new ForbiddenException("Недопустимый источник запроса");
    }

    return true;
  }
}

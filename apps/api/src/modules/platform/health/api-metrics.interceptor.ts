import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { ApiMetricsService } from "./api-metrics.service";

@Injectable()
export class ApiMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: ApiMetricsService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const started = performance.now();

    return next.handle().pipe(
      finalize(() => {
        const duration = performance.now() - started;
        const route =
          request.route?.path
            ? request.method + ":" + request.route.path
            : request.method + ":" + (request.path || request.url);

        this.metrics.record(route, duration, response.statusCode);
      })
    );
  }
}

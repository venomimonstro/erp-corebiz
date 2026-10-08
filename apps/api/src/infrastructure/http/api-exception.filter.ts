import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ApiError } from "@corebiz/contracts";

type TraceRequest = Request & { traceId?: string };

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<TraceRequest>();
    const response = http.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const raw =
      exception instanceof HttpException ? exception.getResponse() : undefined;

    const message =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "message" in raw
          ? Array.isArray(raw.message)
            ? raw.message.join("; ")
            : String(raw.message)
          : status >= 500
            ? "Внутренняя ошибка сервиса"
            : "Запрос не выполнен";

    const body: ApiError = {
      ok: false,
      error: {
        code:
          exception instanceof HttpException
            ? `HTTP_${status}`
            : "INTERNAL_ERROR",
        message,
        ...(request.traceId ? { traceId: request.traceId } : {})
      }
    };

    response.status(status).json(body);
  }
}

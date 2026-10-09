import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function traceMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  const incoming = request.header("x-trace-id")?.trim();
  const traceId = incoming && /^[a-zA-Z0-9_.:-]{1,128}$/.test(incoming)
    ? incoming
    : randomUUID();

  response.setHeader("x-trace-id", traceId);
  (request as Request & { traceId: string }).traceId = traceId;
  next();
}

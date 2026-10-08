import type { NextFunction, Request, Response } from "express";

export function securityHeadersMiddleware(
  _request: Request,
  response: Response,
  next: NextFunction
): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

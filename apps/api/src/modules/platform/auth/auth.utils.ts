import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import { getEnv } from "../../../infrastructure/config/env";

export const SESSION_COOKIE = "corebiz_session";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookie(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rest.join("="));
  }

  return undefined;
}

export function setSessionCookie(response: Response, token: string): void {
  const env = getEnv();
  const secure = env.nodeEnv === "production" ? "; Secure" : "";

  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  );
}

export function clearSessionCookie(response: Response): void {
  const env = getEnv();
  const secure = env.nodeEnv === "production" ? "; Secure" : "";

  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

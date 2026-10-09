import { BadRequestException } from "@nestjs/common";

export type LoginPayload = { email: string; password: string };
export type RegisterPayload = LoginPayload & { companyName: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Некорректные данные формы");
  }
  return value as Record<string, unknown>;
}

export function parseLoginPayload(value: unknown): LoginPayload {
  const body = record(value);
  if (
    typeof body.email !== "string" ||
    body.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
    typeof body.password !== "string" ||
    body.password.length < 1 ||
    body.password.length > 200
  ) {
    throw new BadRequestException("Некорректный email или пароль");
  }
  return { email: body.email.trim(), password: body.password };
}

export function parseRegisterPayload(value: unknown): RegisterPayload {
  const input = parseLoginPayload(value);
  const body = record(value);
  if (input.password.length < 10 ||
    typeof body.companyName !== "string" ||
    body.companyName.trim().length < 2 ||
    body.companyName.trim().length > 160) {
    throw new BadRequestException("Проверьте название компании и пароль (от 10 символов)");
  }
  return { ...input, companyName: body.companyName.trim() };
}

export function parseMembershipPayload(value: unknown): string {
  const body = record(value);
  if (typeof body.membershipId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.membershipId)) {
    throw new BadRequestException("Некорректный идентификатор компании");
  }
  return body.membershipId;
}

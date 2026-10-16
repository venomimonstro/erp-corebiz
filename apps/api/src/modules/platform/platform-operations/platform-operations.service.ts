import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { hashToken } from "../auth/auth.utils";

export type OperatorTenant = {
  tenantId: string;
  companyName: string;
  tenantStatus: string;
  subscriptionStatus: string | null;
  planCode: string | null;
  periodEnd: string | null;
  activeUsers: number;
  openTickets: number;
  createdAt: string;
};

@Injectable()
export class PlatformOperationsService {
  constructor(private readonly database: DatabaseService) {}

  async setSuspension(
    userId: string, session: string | undefined, tenantId: string,
    action: "SUSPEND" | "RESUME", reason: string
  ): Promise<{ tenantId: string; status: string; suspensionId: string }> {
    if (!session || !/^[0-9a-f-]{36}$/i.test(tenantId))
      throw new ForbiddenException("Недостаточно прав оператора");
    if (!["SUSPEND","RESUME"].includes(action) ||
        typeof reason !== "string" ||
        reason.trim().length < 15 || reason.trim().length > 800)
      throw new BadRequestException("Укажите причину от 15 до 800 символов");

    let outcome: {tenantId: string; status: string; suspensionId: string} | undefined;
    try {
      const res = await this.database.query<{
        outcome: {tenantId: string; status: string; suspensionId: string}
      }>(
        "SELECT public.corebiz_platform_tenant_suspension($1::uuid,$2::text,$3::uuid,$4::text,$5::text) AS outcome",
        [userId, hashToken(session), tenantId, action, reason.trim()]
      );
      outcome = res.rows[0]?.outcome;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code) : "";
      if (code === "42501")
        throw new ForbiddenException("Недостаточно прав оператора");
      if (code === "22023")
        throw new BadRequestException("Некорректные параметры действия");
      if (code === "P0002")
        throw new NotFoundException("Компания не найдена");
      if (code === "23514" || code === "23505")
        throw new ConflictException("Состояние компании изменилось");
      throw error;
    }
    if (!outcome || outcome.tenantId !== tenantId)
      throw new Error("PLATFORM_ACTION_INVALID_RESPONSE");
    return outcome;
  }

  async tenants(
    userId: string,
    rawSession: string | undefined,
    limit: number,
    offset: number
  ): Promise<{total: number; items: OperatorTenant[]}> {
    if (!rawSession || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 100 || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > 100000) {
      throw new ForbiddenException("Доступ оператора платформы запрещён");
    }
    try {
      const result = await this.database.query<{
        overview: { total: number; items: OperatorTenant[] };
      }>(
        `SELECT public.corebiz_platform_operator_tenants(
           $1::uuid,$2::text,$3::integer,$4::integer
         ) AS overview`,
        [userId, hashToken(rawSession), limit, offset]
      );
      const data = result.rows[0]?.overview;
      if (!data || !Array.isArray(data.items)) {
        throw new Error("PLATFORM_OPERATOR_RESPONSE_INVALID");
      }
      return data;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error &&
          error.code === "42501") {
        throw new ForbiddenException("Доступ оператора платформы запрещён");
      }
      throw error;
    }
  }
}

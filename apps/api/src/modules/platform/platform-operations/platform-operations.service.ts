import {
  ForbiddenException,
  Injectable
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

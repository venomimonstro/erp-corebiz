export type TenantId = string;
export type UserId = string;
export type MembershipId = string;

export type TenantContext = Readonly<{
  tenantId: TenantId;
  userId: UserId;
  membershipId: MembershipId;
}>;

export type ApiSuccess<T> = Readonly<{
  ok: true;
  data: T;
}>;

export type ApiError = Readonly<{
  ok: false;
  error: {
    code: string;
    message: string;
    traceId?: string;
    details?: Record<string, unknown>;
  };
}>;

export type ApiResult<T> = ApiSuccess<T> | ApiError;

export type HealthStatus = Readonly<{
  status: "ok" | "degraded";
  service: "api";
  version: string;
  timestamp: string;
}>;

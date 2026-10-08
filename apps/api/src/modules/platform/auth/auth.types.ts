import type { Request } from "express";
import type { TenantContext } from "@corebiz/contracts";

export type AuthenticatedRequest = Request & {
  auth?: TenantContext & {
    sessionId: string;
    email: string;
    tenantName: string;
    isOwner: boolean;
  };
};

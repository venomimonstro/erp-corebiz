import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSION = "corebiz.required_permission";

export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

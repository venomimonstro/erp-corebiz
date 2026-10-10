import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthorizationService } from "./authorization.service";
import { CapabilityGuard } from "./capability.guard";
import { PermissionGuard } from "./permission.guard";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";
import { WorkspaceController } from "./workspace.controller";

@Module({
  controllers: [RolesController, WorkspaceController],
  providers: [
    AuthorizationService,
    RolesService,
    {
      provide: APP_GUARD,
      useClass: PermissionGuard
    },
    {
      provide: APP_GUARD,
      useClass: CapabilityGuard
    }
  ],
  exports: [AuthorizationService]
})
export class AuthorizationModule {}

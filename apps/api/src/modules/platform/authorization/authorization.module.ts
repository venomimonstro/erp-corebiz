import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthorizationService } from "./authorization.service";
import { PermissionGuard } from "./permission.guard";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";

@Module({
  controllers: [RolesController],
  providers: [
    AuthorizationService,
    RolesService,
    {
      provide: APP_GUARD,
      useClass: PermissionGuard
    }
  ],
  exports: [AuthorizationService]
})
export class AuthorizationModule {}

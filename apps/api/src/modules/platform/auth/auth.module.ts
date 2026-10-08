import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { SessionContextMiddleware } from "./session-context.middleware";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionContextMiddleware,
    {
      provide: APP_GUARD,
      useClass: AuthGuard
    }
  ],
  exports: [AuthService, SessionContextMiddleware]
})
export class AuthModule {}

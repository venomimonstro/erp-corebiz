import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthRateLimitService } from "./auth-rate-limit.service";
import { AuthService } from "./auth.service";
import { BrowserOriginGuard } from "./browser-origin.guard";
import { SessionContextMiddleware } from "./session-context.middleware";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRateLimitService,
    SessionContextMiddleware,
    {
      provide: APP_GUARD,
      useClass: BrowserOriginGuard
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard
    }
  ],
  exports: [AuthService, SessionContextMiddleware]
})
export class AuthModule {}

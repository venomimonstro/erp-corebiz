import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthRateLimitService } from "./auth-rate-limit.service";
import { AuthService } from "./auth.service";
import { EmailVerificationService } from "./email-verification.service";
import { AuthMailWebhookService } from "./auth-mail-webhook.service";
import { BrowserOriginGuard } from "./browser-origin.guard";
import { MfaService } from "./mfa.service";
import { MfaGuard } from "./mfa.guard";
import { SessionContextMiddleware } from "./session-context.middleware";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    EmailVerificationService,
    AuthMailWebhookService,
    MfaService,
    AuthRateLimitService,
    SessionContextMiddleware,
    {
      provide: APP_GUARD,
      useClass: BrowserOriginGuard
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: MfaGuard
    }
  ],
  exports: [AuthService, SessionContextMiddleware]
})
export class AuthModule {}

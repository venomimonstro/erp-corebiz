import {
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisService } from "../../../infrastructure/cache/redis.service";

@Injectable()
export class AuthRateLimitService {
  constructor(private readonly redis: RedisService) {}

  async assertLoginAllowed(ip: string, email: string): Promise<void> {
    // The IP+email budget alone is bypassed by rotating email addresses.
    // A second aggregate IP budget bounds expensive Argon2 work without
    // storing raw IP/email in Redis keys.
    const ipCount = await this.redis.incrementWindow(
      this.key("login-ip", ip, ""), 15 * 60
    );
    if (ipCount > 100) {
      throw new HttpException(
        "Слишком много попыток входа с этого адреса. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    const key = this.key("login", ip, email.toLowerCase().trim());
    const count = await this.redis.incrementWindow(key, 15 * 60);

    if (count > 10) {
      throw new HttpException(
        "Слишком много попыток входа. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  async resetLogin(ip: string, email: string): Promise<void> {
    await this.redis.delete(this.key("login", ip, email.toLowerCase().trim()));
  }

  async assertRegistrationAllowed(ip: string): Promise<void> {
    const key = this.key("register", ip, "");
    const count = await this.redis.incrementWindow(key, 60 * 60);

    if (count > 5) {
      throw new HttpException(
        "Слишком много регистраций. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  async assertPasswordResetAllowed(ip: string, email: string): Promise<void> {
    const normalized =
      typeof email === "string" ? email.trim().toLowerCase().slice(0,254) : "";
    const ipCount = await this.redis.incrementWindow(
      this.key("reset-ip", ip, ""), 60 * 60
    );
    const targetCount = await this.redis.incrementWindow(
      this.key("reset-target", ip, normalized), 60 * 60
    );
    if (ipCount > 30 || targetCount > 5) {
      throw new HttpException(
        "Слишком много запросов. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  async assertEmailVerificationAllowed(ip: string, userId: string): Promise<void> {
    const byUser = await this.redis.incrementWindow(
      this.key("verify-email-user", "global", userId), 60 * 60
    );
    const byIp = await this.redis.incrementWindow(
      this.key("verify-email-ip", ip, ""), 60 * 60
    );
    if (byUser > 5 || byIp > 30) {
      throw new HttpException(
        "Слишком много запросов подтверждения. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  async assertRecoveryCompletionAllowed(ip: string): Promise<void> {
    const count = await this.redis.incrementWindow(
      this.key("token-complete", ip, ""), 15 * 60
    );
    if (count > 30) {
      throw new HttpException(
        "Слишком много попыток проверки ссылки. Повторите позже.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  private key(action: string, ip: string, subject: string): string {
    const digest = createHash("sha256")
      .update(`${ip}|${subject}`)
      .digest("hex");
    return `auth-rate:${action}:${digest}`;
  }
}

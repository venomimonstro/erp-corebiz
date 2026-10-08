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

  private key(action: string, ip: string, subject: string): string {
    const digest = createHash("sha256")
      .update(`${ip}|${subject}`)
      .digest("hex");
    return `auth-rate:${action}:${digest}`;
  }
}

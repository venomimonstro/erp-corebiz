import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class AuthMailService {
  private readonly endpoint =
    "https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json";

  async sendReset(email: string, token: string): Promise<void> {
    const link = this.link("/reset-password", token);
    await this.deliver(
      email,
      "Восстановление доступа к CoreBiz",
      [
        "Вы запросили восстановление пароля CoreBiz.",
        "Ссылка действует 30 минут и может быть использована только один раз.",
        link,
        "Если вы не запрашивали восстановление, просто проигнорируйте письмо."
      ].join("\n\n")
    );
  }

  async sendVerification(email: string, token: string): Promise<void> {
    const link = this.link("/verify-email", token);
    await this.deliver(
      email,
      "Подтвердите адрес электронной почты в CoreBiz",
      [
        "Подтвердите вашу почту для оплаты тарифа CoreBiz и управления подпиской.",
        "Ссылка действует 24 часа и может быть использована только один раз.",
        link,
        "Если вы не создавали аккаунт CoreBiz, просто проигнорируйте письмо."
      ].join("\n\n")
    );
  }

  private link(path: string, token: string): string {
    const env = getEnv();
    const origin = new URL(env.webOrigin);
    if (env.nodeEnv === "production" && origin.protocol !== "https:") {
      throw new ServiceUnavailableException("Для писем требуется HTTPS");
    }
    if (origin.username || origin.password || origin.search || origin.hash) {
      throw new ServiceUnavailableException("Некорректный адрес приложения");
    }
    const link = new URL(path, origin);
    link.searchParams.set("token", token);
    return link.toString();
  }

  private async deliver(email: string, subject: string, text: string): Promise<void> {
    const key = process.env.COREBIZ_UNISENDER_GO_KEY?.trim();
    const sender = process.env.COREBIZ_EMAIL_SENDER?.trim();
    if (!key || !sender || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
      throw new ServiceUnavailableException("Email-провайдер не настроен");
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          message: {
            recipients: [{ email }],
            from_email: sender,
            from_name: "CoreBiz",
            subject,
            body: { plaintext: text },
            track_links: 0,
            track_read: 0
          }
        }),
        redirect: "error",
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new ServiceUnavailableException("Email-провайдер недоступен");
    }
    if (!response.ok) {
      throw new ServiceUnavailableException("Email-провайдер отклонил запрос");
    }
    // HTTP 200 does not guarantee delivery. The provider must at least accept
    // this recipient and return a job id. Bounce/actual delivery is independent.
    const payload = await response.json().catch(() => null) as
      { status?: string; error?: unknown; job_id?: string;
        emails?: string[]; failed_emails?: Record<string,string> } | null;
    if (!payload || payload.status !== "success" ||
        typeof payload.job_id !== "string" || !payload.job_id ||
        payload.error || !Array.isArray(payload.emails) ||
        !payload.emails.includes(email) || payload.failed_emails?.[email]) {
      throw new ServiceUnavailableException("Не удалось отправить письмо");
    }
  }
}

import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class AuthMailService {
  // Only a fixed, documented endpoint is accepted. No arbitrary URLs or
  // tenant-controlled template URLs to avoid SSRF / secret exfiltration.
  private readonly endpoint =
    "https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json";

  async sendReset(email: string, token: string): Promise<void> {
    const key = process.env.COREBIZ_UNISENDER_GO_KEY?.trim();
    const sender = process.env.COREBIZ_EMAIL_SENDER?.trim();
    if (!key || !sender || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
      throw new ServiceUnavailableException("Email-провайдер не настроен");
    }
    const origin = new URL(getEnv().webOrigin);
    if (getEnv().nodeEnv === "production" && origin.protocol !== "https:") {
      throw new ServiceUnavailableException("Для писем требуется HTTPS");
    }
    const link = new URL("/reset-password", origin);
    link.searchParams.set("token", token);
    const text = [
      "Вы запросили восстановление пароля CoreBiz.",
      "Ссылка действует 30 минут и может быть использована только один раз.",
      link.toString(),
      "Если вы не запрашивали восстановление, просто проигнорируйте письмо."
    ].join("\n\n");

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
            subject: "Восстановление доступа к CoreBiz",
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
    // Unisender Go may return an HTTP 200 with an application-level error.
    const payload = await response.json().catch(() => null) as
      { status?: string; error?: unknown } | null;
    if (!payload || payload.error ||
        (payload.status && payload.status !== "success")) {
      throw new ServiceUnavailableException("Не удалось отправить письмо");
    }
  }
}

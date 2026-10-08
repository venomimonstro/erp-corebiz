import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class IntegrationCryptoService {
  private readonly key = createHash("sha256")
    .update(getEnv().sessionSecret + "|corebiz-integrations-v1")
    .digest();

  encrypt(value: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return [
      "v1",
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  decrypt<T extends Record<string, unknown>>(payload: string): T {
    const [version, ivRaw, tagRaw, dataRaw] = payload.split(".");
    if (
      version !== "v1" ||
      !ivRaw ||
      !tagRaw ||
      !dataRaw
    ) {
      throw new Error("INTEGRATION_SECRET_FORMAT_INVALID");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivRaw, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataRaw, "base64url")),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString("utf8")) as T;
  }
}

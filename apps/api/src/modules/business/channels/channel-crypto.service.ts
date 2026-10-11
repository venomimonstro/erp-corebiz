import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { getEnv } from "../../../infrastructure/config/env";

@Injectable()
export class ChannelCryptoService {
  private readonly legacyKey = createHash("sha256")
    .update(getEnv().sessionSecret + "|corebiz-channels-v1")
    .digest();
  private readonly separatedKey=process.env.CHANNEL_ENCRYPTION_KEY?.trim()
    ?createHash("sha256")
       .update(process.env.CHANNEL_ENCRYPTION_KEY.trim()+"|corebiz-channels-v2")
       .digest()
    :null;

  encrypt(value: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.separatedKey??this.legacyKey, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return [
      this.separatedKey?"v2":"v1",
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  decrypt<T extends Record<string, unknown>>(payload: string): T {
    const [version, ivRaw, tagRaw, dataRaw] = payload.split(".");
    if (!["v1","v2"].includes(version) || !ivRaw || !tagRaw || !dataRaw) {
      throw new Error("CHANNEL_SECRET_FORMAT_INVALID");
    }

    if(version==="v2"&&!this.separatedKey)
      throw new Error("CHANNEL_ENCRYPTION_KEY_REQUIRED_FOR_V2");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      version==="v2"?this.separatedKey!:this.legacyKey,
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

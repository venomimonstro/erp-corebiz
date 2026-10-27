import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  createHash,
  createHmac
} from "node:crypto";
import { getEnv } from "../../../infrastructure/config/env";

type StorageConfig = {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
};

type ObjectInfo = {
  sizeBytes: bigint;
  mimeType: string;
  etag: string | null;
};

@Injectable()
export class SupportStorageService {
  createUploadUrl(objectKey: string, expiresSeconds = 600): string {
    return this.presign("PUT", objectKey, expiresSeconds);
  }

  createDownloadUrl(objectKey: string, expiresSeconds = 300): string {
    return this.presign("GET", objectKey, expiresSeconds);
  }

  async verifyObject(objectKey: string): Promise<ObjectInfo> {
    const url = this.presign("HEAD", objectKey, 120);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new BadGatewayException(
        "Хранилище файлов временно недоступно"
      );
    }

    if (!response.ok) {
      throw new BadGatewayException(
        "Не удалось подтвердить загруженный файл"
      );
    }

    const rawSize = response.headers.get("content-length") ?? "";
    if (!/^\d+$/.test(rawSize)) {
      throw new BadGatewayException(
        "Хранилище не вернуло размер загруженного файла"
      );
    }

    const sizeBytes = BigInt(rawSize);
    const mimeType = this.normalizeMime(
      response.headers.get("content-type") ?? ""
    );
    const etag = response.headers.get("etag")?.replace(/^"|"$/g, "") || null;

    await this.scan(objectKey);

    return { sizeBytes, mimeType, etag };
  }

  async deleteObject(objectKey: string): Promise<void> {
    const url = this.presign("DELETE", objectKey, 120);
    try {
      const response = await fetch(url, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok && response.status !== 404) {
        throw new Error("STORAGE_DELETE_FAILED_" + response.status);
      }
    } catch {
      // Cleanup is best-effort here. The database record remains rejected and
      // a lifecycle rule on the private bucket must remove abandoned objects.
    }
  }

  private async scan(objectKey: string): Promise<void> {
    const scannerUrl = process.env.COREBIZ_FILE_SCAN_URL?.trim();
    const scannerToken = process.env.COREBIZ_FILE_SCAN_TOKEN?.trim();

    if (!scannerUrl || !scannerToken) {
      if (getEnv().nodeEnv === "production") {
        throw new ServiceUnavailableException(
          "Антивирусная проверка файлов не настроена"
        );
      }
      return;
    }

    let endpoint: URL;
    try {
      endpoint = new URL(scannerUrl);
    } catch {
      throw new ServiceUnavailableException(
        "Некорректная конфигурация антивирусной проверки"
      );
    }
    if (getEnv().nodeEnv === "production" && endpoint.protocol !== "https:") {
      throw new ServiceUnavailableException(
        "Антивирусная проверка должна использовать HTTPS"
      );
    }

    const objectUrl = this.createDownloadUrl(objectKey, 120);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + scannerToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: objectUrl }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw new BadGatewayException(
        "Антивирусная проверка временно недоступна"
      );
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // handled below
    }

    if (!response.ok ||
        !payload ||
        typeof payload !== "object" ||
        (payload as { clean?: unknown }).clean !== true) {
      await this.deleteObject(objectKey);
      throw new BadGatewayException(
        "Файл не прошёл проверку безопасности"
      );
    }
  }

  private presign(
    method: "GET" | "PUT" | "HEAD" | "DELETE",
    objectKey: string,
    expiresSeconds: number
  ): string {
    const cfg = this.config();
    const expires = Math.max(30, Math.min(900, Math.floor(expiresSeconds)));
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const scope = date + "/" + cfg.region + "/s3/aws4_request";
    const credential = cfg.accessKey + "/" + scope;

    const canonicalUri = this.objectPath(
      cfg.endpoint.pathname,
      cfg.bucket,
      objectKey
    );

    const queryEntries: Array<[string, string]> = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", credential],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expires)],
      ["X-Amz-SignedHeaders", "host"]
    ];

    const canonicalQuery = queryEntries
      .map(([key, value]) => [this.encode(key), this.encode(value)] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => key + "=" + value)
      .join("&");

    const canonicalHeaders = "host:" + cfg.endpoint.host.toLowerCase() + "\n";
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      "host",
      "UNSIGNED-PAYLOAD"
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      this.sha256(canonicalRequest)
    ].join("\n");

    const signingKey = this.hmac(
      this.hmac(
        this.hmac(
          this.hmac(
            Buffer.from("AWS4" + cfg.secretKey, "utf8"),
            date
          ),
          cfg.region
        ),
        "s3"
      ),
      "aws4_request"
    );

    const signature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");

    const url = new URL(cfg.endpoint.toString());
    url.pathname = canonicalUri;
    url.search = canonicalQuery + "&X-Amz-Signature=" + signature;
    return url.toString();
  }

  private config(): StorageConfig {
    const rawEndpoint = process.env.COREBIZ_STORAGE_ENDPOINT?.trim();
    const bucket = process.env.COREBIZ_STORAGE_BUCKET?.trim();
    const region = process.env.COREBIZ_STORAGE_REGION?.trim() || "us-east-1";
    const accessKey = process.env.COREBIZ_STORAGE_ACCESS_KEY?.trim();
    const secretKey = process.env.COREBIZ_STORAGE_SECRET_KEY?.trim();

    if (!rawEndpoint || !bucket || !accessKey || !secretKey) {
      throw new ServiceUnavailableException(
        "Приватное хранилище файлов не настроено"
      );
    }

    let endpoint: URL;
    try {
      endpoint = new URL(rawEndpoint);
    } catch {
      throw new ServiceUnavailableException(
        "Некорректный адрес хранилища файлов"
      );
    }

    if (!["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket) ||
        !/^[a-z0-9-]{3,64}$/i.test(region)) {
      throw new ServiceUnavailableException(
        "Некорректная конфигурация хранилища файлов"
      );
    }
    if (getEnv().nodeEnv === "production" && endpoint.protocol !== "https:") {
      throw new ServiceUnavailableException(
        "Хранилище файлов в production должно использовать HTTPS"
      );
    }

    endpoint.search = "";
    endpoint.hash = "";
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");

    return { endpoint, bucket, region, accessKey, secretKey };
  }

  private objectPath(
    endpointPath: string,
    bucket: string,
    objectKey: string
  ): string {
    const segments = [
      ...endpointPath.split("/").filter(Boolean),
      bucket,
      ...objectKey.split("/").filter(Boolean)
    ];
    return "/" + segments.map((part) => this.encode(part)).join("/");
  }

  private normalizeMime(value: string): string {
    return value.split(";")[0]!.trim().toLowerCase();
  }

  private encode(value: string): string {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) =>
        "%" + character.charCodeAt(0).toString(16).toUpperCase()
    );
  }

  private sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private hmac(key: Buffer, value: string): Buffer {
    return createHmac("sha256", key).update(value, "utf8").digest();
  }
}

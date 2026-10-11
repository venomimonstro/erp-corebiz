import { BadGatewayException, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export type MerchantCredentials = { shopId: string; secret: string };
export type ProviderPayment = {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid?: boolean;
  amount: { value: string; currency: string };
  confirmation?: { confirmation_url?: string };
  metadata?: Record<string, string>;
  receipt_registration?: string;
};
const ORIGIN = "https://api.yookassa.ru/v3";

export function moneyToMinor(value: string): string {
  if (!/^(0|[1-9]\d{0,11})\.\d{2}$/.test(value)) {
    throw new BadGatewayException("Некорректная сумма от платёжного провайдера");
  }
  const [rub, kopek] = value.split(".");
  return (BigInt(rub!) * 100n + BigInt(kopek!)).toString();
}
export function minorToMoney(value: string): string {
  if (!/^\d{1,15}$/.test(value)) throw new ServiceUnavailableException("Некорректная сумма");
  return (BigInt(value) / 100n).toString() + "." +
    (BigInt(value) % 100n).toString().padStart(2,"0");
}

export function sealMerchantSecret(secret: string): string {
  const raw = process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new ServiceUnavailableException("Не настроен ключ шифрования эквайринга");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",Buffer.from(raw,"hex"),iv);
  const encrypted = Buffer.concat([cipher.update(secret,"utf8"),cipher.final()]);
  return "v1:"+iv.toString("base64url")+":"+
    cipher.getAuthTag().toString("base64url")+":"+encrypted.toString("base64url");
}
export function openMerchantSecret(input: string): string {
  const raw = process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new ServiceUnavailableException("Не настроен ключ шифрования эквайринга");
  }
  const parts = input.split(":");
  if (parts.length!==4 || parts[0]!=="v1") throw new ServiceUnavailableException("Ключ эквайринга недоступен");
  try {
    const decipher=createDecipheriv("aes-256-gcm",Buffer.from(raw,"hex"),Buffer.from(parts[1]!,"base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!,"base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!,"base64url")),decipher.final()]).toString("utf8");
  } catch {
    throw new ServiceUnavailableException("Ошибка расшифровки настроек эквайринга");
  }
}
export function providerIdempotencyKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0,64);
}
export class YooKassaGateway {
  async create(
    creds: MerchantCredentials,
    key: string,
    payload: Record<string,unknown>
  ): Promise<ProviderPayment> {
    return this.request(creds,"POST","/payments",payload,key);
  }
  async get(creds:MerchantCredentials,id:string):Promise<ProviderPayment> {
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new BadGatewayException("Неверный идентификатор оплаты");
    return this.request(creds,"GET","/payments/"+encodeURIComponent(id));
  }
  private async request(
    creds:MerchantCredentials,
    method:"GET"|"POST",
    path:string,
    payload?:Record<string,unknown>,
    idemKey?:string
  ):Promise<ProviderPayment>{
    if(!/^\d{3,30}$/.test(creds.shopId) || !creds.secret || creds.secret.length>300){
      throw new ServiceUnavailableException("Некорректные реквизиты эквайринга");
    }
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(ORIGIN+path,{
        method,
        signal:controller.signal,
        headers:{
          "Authorization":"Basic "+Buffer.from(creds.shopId+":"+creds.secret).toString("base64"),
          "Content-Type":"application/json",
          ...(idemKey?{"Idempotence-Key":idemKey}:{})
        },
        ...(payload?{body:JSON.stringify(payload)}:{})
      });
      if(!response.ok) {
        // Never leak provider errors: they can contain payment identifiers or PII.
        throw new BadGatewayException("Провайдер оплаты не подтвердил операцию");
      }
      const data=await response.json() as ProviderPayment;
      if(!data || typeof data.id!=="string" ||
        !data.amount || typeof data.amount.value!=="string" ||
        !["pending","waiting_for_capture","succeeded","canceled"].includes(data.status)) {
        throw new BadGatewayException("Некорректный ответ провайдера оплаты");
      }
      return data;
    }catch(error){
      if(error instanceof BadGatewayException) throw error;
      throw new ServiceUnavailableException("Провайдер оплаты временно недоступен");
    }finally{clearTimeout(timeout);}
  }
}

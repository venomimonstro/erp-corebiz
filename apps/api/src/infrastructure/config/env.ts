export type AppEnv = Readonly<{
  nodeEnv: "development" | "test" | "production";
  apiPort: number;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
  webOrigin: string;
}>;

let cached: AppEnv | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`ENV_${name}_REQUIRED`);
  return value;
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "4000");
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("ENV_API_PORT_INVALID");
  }
  return parsed;
}

function validHttpsUrl(name:string,value:string):void{
  let url:URL;
  try{url=new URL(value);}catch{throw new Error(`ENV_${name}_INVALID`);}
  if(url.protocol!=="https:"||url.username||url.password){
    throw new Error(`ENV_${name}_HTTPS_REQUIRED`);
  }
}

function validateProductionSecurity(webOrigin:string):void{
  validHttpsUrl("WEB_ORIGIN",webOrigin);

  const mfaKey=required("COREBIZ_MFA_ENCRYPTION_KEY");
  let decoded:Buffer;
  try{decoded=Buffer.from(mfaKey,"base64");}
  catch{throw new Error("ENV_COREBIZ_MFA_ENCRYPTION_KEY_INVALID");}
  if(decoded.length!==32){
    throw new Error("ENV_COREBIZ_MFA_ENCRYPTION_KEY_INVALID");
  }

  const mailKey=required("COREBIZ_UNISENDER_GO_KEY");
  if(mailKey.length<16)throw new Error("ENV_COREBIZ_UNISENDER_GO_KEY_INVALID");
  const sender=required("COREBIZ_EMAIL_SENDER");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)){
    throw new Error("ENV_COREBIZ_EMAIL_SENDER_INVALID");
  }
  const webhook=required("COREBIZ_UNISENDER_WEBHOOK_AUTH");
  if(webhook.length<32){
    throw new Error("ENV_COREBIZ_UNISENDER_WEBHOOK_AUTH_TOO_SHORT");
  }

  const storageEndpoint=required("COREBIZ_STORAGE_ENDPOINT");
  validHttpsUrl("COREBIZ_STORAGE_ENDPOINT",storageEndpoint);
  required("COREBIZ_STORAGE_BUCKET");
  required("COREBIZ_STORAGE_ACCESS_KEY");
  required("COREBIZ_STORAGE_SECRET_KEY");

  const scanner=required("COREBIZ_FILE_SCAN_URL");
  validHttpsUrl("COREBIZ_FILE_SCAN_URL",scanner);
  const scannerToken=required("COREBIZ_FILE_SCAN_TOKEN");
  if(scannerToken.length<24){
    throw new Error("ENV_COREBIZ_FILE_SCAN_TOKEN_TOO_SHORT");
  }
}

export function getEnv(): AppEnv {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("ENV_NODE_ENV_INVALID");
  }

  const sessionSecret = required("SESSION_SECRET");
  if (nodeEnv === "production" && sessionSecret.length < 32) {
    throw new Error("ENV_SESSION_SECRET_TOO_SHORT");
  }

  const webOrigin=required("WEB_ORIGIN");
  if(nodeEnv==="production"){
    validateProductionSecurity(webOrigin);
  }

  cached = {
    nodeEnv: nodeEnv as AppEnv["nodeEnv"],
    apiPort: parsePort(process.env.API_PORT),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    sessionSecret,
    webOrigin
  };

  return cached;
}

import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

type AuthMailJob = {
  job_id: string;
  user_id: string;
  recipient_email: string;
  kind: "EMAIL_VERIFICATION" | "PASSWORD_RESET";
  attempts: number;
};

type ProviderResponse = {
  status?: string;
  error?: unknown;
  job_id?: string;
  emails?: string[];
  failed_emails?: Record<string,string>;
};

const ENDPOINT =
  "https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json";

class DeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function token(): string {
  return randomBytes(48).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value,"utf8").digest("hex");
}

function webOrigin(): URL {
  const raw=process.env.WEB_ORIGIN?.trim();
  if(!raw)throw new DeliveryError("WEB_ORIGIN_REQUIRED");
  let origin:URL;
  try{origin=new URL(raw);}catch{
    throw new DeliveryError("WEB_ORIGIN_INVALID");
  }
  if(!["http:","https:"].includes(origin.protocol)||
     origin.username||origin.password||origin.search||origin.hash){
    throw new DeliveryError("WEB_ORIGIN_INVALID");
  }
  if(process.env.NODE_ENV==="production"&&origin.protocol!=="https:"){
    throw new DeliveryError("WEB_ORIGIN_HTTPS_REQUIRED");
  }
  return origin;
}

function message(job:AuthMailJob,rawToken:string):{
  subject:string;text:string;
}{
  const origin=webOrigin();
  const verification=job.kind==="EMAIL_VERIFICATION";
  const link=new URL(
    verification?"/verify-email":"/reset-password",
    origin
  );
  link.searchParams.set("token",rawToken);

  if(verification){
    return {
      subject:"Подтвердите адрес электронной почты в CoreBiz",
      text:[
        "Подтвердите вашу почту для оплаты тарифа CoreBiz и управления подпиской.",
        "Ссылка действует 24 часа и может быть использована только один раз.",
        link.toString(),
        "Если вы не создавали аккаунт CoreBiz, просто проигнорируйте письмо."
      ].join("\n\n")
    };
  }
  return {
    subject:"Восстановление доступа к CoreBiz",
    text:[
      "Вы запросили восстановление пароля CoreBiz.",
      "Ссылка действует 30 минут и может быть использована только один раз.",
      link.toString(),
      "Если вы не запрашивали восстановление, просто проигнорируйте письмо."
    ].join("\n\n")
  };
}

async function deliver(
  job:AuthMailJob,
  rawToken:string
):Promise<string>{
  const key=process.env.COREBIZ_UNISENDER_GO_KEY?.trim();
  const sender=process.env.COREBIZ_EMAIL_SENDER?.trim();
  if(!key||!sender||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)){
    throw new DeliveryError("MAIL_PROVIDER_NOT_CONFIGURED");
  }

  const content=message(job,rawToken);
  let response:Response;
  try{
    response=await fetch(ENDPOINT,{
      method:"POST",
      headers:{
        "X-API-KEY":key,
        "Content-Type":"application/json",
        Accept:"application/json"
      },
      body:JSON.stringify({
        message:{
          recipients:[{email:job.recipient_email}],
          from_email:sender,
          from_name:"CoreBiz",
          subject:content.subject,
          body:{plaintext:content.text},
          track_links:0,
          track_read:0
        }
      }),
      redirect:"error",
      signal:AbortSignal.timeout(8_000)
    });
  }catch{
    throw new DeliveryError("MAIL_PROVIDER_NETWORK");
  }

  if(!response.ok){
    throw new DeliveryError(
      "MAIL_PROVIDER_HTTP_"+String(response.status)
    );
  }

  const payload=await response.json().catch(()=>null) as ProviderResponse|null;
  if(!payload||payload.status!=="success"||
     typeof payload.job_id!=="string"||!payload.job_id||
     payload.error||!Array.isArray(payload.emails)||
     !payload.emails.includes(job.recipient_email)||
     payload.failed_emails?.[job.recipient_email]){
    throw new DeliveryError("MAIL_PROVIDER_REJECTED");
  }
  return payload.job_id;
}

async function fail(pool:Pool,jobId:string,code:string):Promise<void>{
  await pool.query(
    "SELECT public.corebiz_fail_auth_mail($1::uuid,$2::text)",
    [jobId,code]
  );
}

export async function processAuthMailOnce(pool:Pool):Promise<boolean>{
  const claimed=await pool.query<AuthMailJob>(
    "SELECT * FROM public.corebiz_claim_auth_mail()"
  );
  const job=claimed.rows[0];
  if(!job)return false;

  const rawToken=token();
  try{
    const issued=await pool.query<{issued:boolean}>(
      `SELECT public.corebiz_issue_auth_mail_token(
         $1::uuid,$2::text
       ) AS issued`,
      [job.job_id,sha256(rawToken)]
    );

    // Verification may already have been completed while the queued job was
    // waiting. The SQL function marks that job terminal without sending.
    if(issued.rows[0]?.issued!==true)return true;

    const providerJobId=await deliver(job,rawToken);
    const completed=await pool.query<{completed:boolean}>(
      `SELECT public.corebiz_complete_auth_mail(
         $1::uuid,$2::text
       ) AS completed`,
      [job.job_id,providerJobId]
    );
    if(completed.rows[0]?.completed!==true){
      throw new DeliveryError("MAIL_OUTBOX_COMPLETE_CONFLICT");
    }
    return true;
  }catch(error){
    const code=error instanceof DeliveryError
      ?error.code
      :"MAIL_DELIVERY_INTERNAL";
    await fail(pool,job.job_id,code).catch(()=>{});
    process.stderr.write(
      "[worker] auth mail delivery failed code="+code+"\n"
    );
    return true;
  }
}

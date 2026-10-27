import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type MfaAuth = {
  userId:string;
  sessionId:string;
  tenantId:string;
  membershipId:string;
  email:string;
};

type MfaSecretRow = {
  status:"PENDING"|"ACTIVE";
  secret_ciphertext:string;
};

const BASE32="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

@Injectable()
export class MfaService {
  constructor(private readonly database:DatabaseService){}

  async status(auth:MfaAuth):Promise<{
    required:boolean;
    enabled:boolean;
    verified:boolean;
    recoveryCodesRemaining:number;
  }>{
    const result=await this.database.query<{
      required:boolean;enabled:boolean;verified:boolean;
      recovery_codes_remaining:number;
    }>(
      `SELECT * FROM public.corebiz_auth_mfa_state(
         $1::uuid,$2::uuid,$3::uuid
       )`,
      [auth.userId,auth.membershipId,auth.sessionId]
    );
    const row=result.rows[0];
    if(!row)throw new UnauthorizedException("Сессия недействительна");
    return {
      required:row.required===true,
      enabled:row.enabled===true,
      verified:row.verified===true,
      recoveryCodesRemaining:Number(row.recovery_codes_remaining??0)
    };
  }

  async begin(auth:MfaAuth):Promise<{
    secret:string;
    otpauthUri:string;
  }>{
    const current=await this.status(auth);
    if(current.enabled){
      throw new ConflictException("Двухфакторная защита уже включена");
    }

    const secret=this.base32Encode(randomBytes(20));
    const encrypted=this.encrypt(secret);
    const result=await this.database.query<{started:boolean}>(
      `SELECT public.corebiz_auth_mfa_begin(
         $1::uuid,$2::text
       ) AS started`,
      [auth.userId,encrypted]
    );
    if(result.rows[0]?.started!==true){
      throw new UnauthorizedException("Аккаунт недоступен");
    }

    const label=encodeURIComponent("CoreBiz:"+auth.email);
    const issuer=encodeURIComponent("CoreBiz");
    return {
      secret,
      otpauthUri:
        "otpauth://totp/"+label+
        "?secret="+encodeURIComponent(secret)+
        "&issuer="+issuer+
        "&algorithm=SHA1&digits=6&period=30"
    };
  }

  async confirm(auth:MfaAuth,code:unknown):Promise<{
    recoveryCodes:string[];
  }>{
    const normalized=this.totpInput(code);
    const row=await this.secret(auth.userId,"PENDING");
    if(!row||!this.verifyTotp(this.decrypt(row.secret_ciphertext),normalized)){
      throw new BadRequestException("Неверный код приложения-аутентификатора");
    }

    const recoveryCodes=this.generateRecoveryCodes();
    const hashes=recoveryCodes.map(value=>this.hashRecovery(value));
    try{
      const result=await this.database.query<{enabled:boolean}>(
        `SELECT public.corebiz_auth_mfa_enable(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text[]
         ) AS enabled`,
        [
          auth.userId,auth.sessionId,auth.tenantId,auth.membershipId,hashes
        ]
      );
      if(result.rows[0]?.enabled!==true){
        throw new UnauthorizedException("Сессия недействительна");
      }
    }catch(error){
      this.mapConstraint(error);
      throw error;
    }
    return {recoveryCodes};
  }

  async verifyLogin(userId:string,code:unknown):Promise<boolean>{
    return this.verifyUserCode(userId,code,true);
  }

  async verifyCurrentSession(auth:MfaAuth,code:unknown):Promise<boolean>{
    if(!await this.verifyUserCode(auth.userId,code,true)){
      throw new BadRequestException("Неверный код двухфакторной защиты");
    }
    const result=await this.database.query<{verified:boolean}>(
      `SELECT public.corebiz_auth_mfa_mark_session_verified(
         $1::uuid,$2::uuid
       ) AS verified`,
      [auth.userId,auth.sessionId]
    );
    if(result.rows[0]?.verified!==true){
      throw new UnauthorizedException("Сессия недействительна");
    }
    return true;
  }

  async rotateRecovery(auth:MfaAuth,code:unknown):Promise<{
    recoveryCodes:string[];
  }>{
    if(!await this.verifyTotpOnly(auth.userId,code)){
      throw new BadRequestException("Неверный код приложения-аутентификатора");
    }
    const recoveryCodes=this.generateRecoveryCodes();
    const hashes=recoveryCodes.map(value=>this.hashRecovery(value));
    const result=await this.database.query<{rotated:boolean}>(
      `SELECT public.corebiz_auth_mfa_replace_recovery(
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text[]
       ) AS rotated`,
      [
        auth.userId,auth.sessionId,auth.tenantId,auth.membershipId,hashes
      ]
    );
    if(result.rows[0]?.rotated!==true){
      throw new UnauthorizedException("Подтвердите текущую MFA-сессию");
    }
    return {recoveryCodes};
  }

  async disable(auth:MfaAuth,code:unknown):Promise<{disabled:true}>{
    if(!await this.verifyUserCode(auth.userId,code,true)){
      throw new BadRequestException("Неверный код двухфакторной защиты");
    }
    try{
      const result=await this.database.query<{disabled:boolean}>(
        `SELECT public.corebiz_auth_mfa_disable(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid
         ) AS disabled`,
        [auth.userId,auth.sessionId,auth.tenantId,auth.membershipId]
      );
      if(result.rows[0]?.disabled!==true){
        throw new UnauthorizedException("Сессия недействительна");
      }
      return {disabled:true};
    }catch(error){
      const code=this.dbCode(error);
      if(code==="23514"){
        throw new ForbiddenException(
          "Для привилегированной роли двухфакторную защиту отключить нельзя"
        );
      }
      throw error;
    }
  }

  private async verifyUserCode(
    userId:string,
    input:unknown,
    consumeRecovery:boolean
  ):Promise<boolean>{
    if(typeof input!=="string")return false;
    const value=input.trim();
    if(/^\d{6}$/.test(value)){
      return this.verifyTotpOnly(userId,value);
    }

    const recovery=this.normalizeRecovery(value);
    if(!recovery)return false;
    if(!consumeRecovery)return false;
    const result=await this.database.query<{consumed:boolean}>(
      `SELECT public.corebiz_auth_mfa_consume_recovery(
         $1::uuid,$2::text
       ) AS consumed`,
      [userId,this.hashRecovery(recovery)]
    );
    return result.rows[0]?.consumed===true;
  }

  private async verifyTotpOnly(userId:string,input:unknown):Promise<boolean>{
    const code=this.totpInput(input,false);
    if(!code)return false;
    const row=await this.secret(userId,"ACTIVE");
    if(!row)return false;
    return this.verifyTotp(this.decrypt(row.secret_ciphertext),code);
  }

  private async secret(
    userId:string,
    requiredStatus:"PENDING"|"ACTIVE"
  ):Promise<MfaSecretRow|null>{
    const result=await this.database.query<MfaSecretRow>(
      `SELECT status,secret_ciphertext
       FROM public.corebiz_auth_mfa_secret($1::uuid)`,
      [userId]
    );
    const row=result.rows[0]??null;
    return row?.status===requiredStatus?row:null;
  }

  private verifyTotp(secret:string,code:string):boolean{
    const counter=Math.floor(Date.now()/30_000);
    const expected=[
      this.totp(secret,counter-1),
      this.totp(secret,counter),
      this.totp(secret,counter+1)
    ];
    const actual=Buffer.from(code,"utf8");
    return expected.some(candidate=>{
      const other=Buffer.from(candidate,"utf8");
      return other.length===actual.length&&timingSafeEqual(other,actual);
    });
  }

  private totp(secret:string,counter:number):string{
    const key=this.base32Decode(secret);
    const message=Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest=createHmac("sha1",key).update(message).digest();
    const offset=digest[digest.length-1]!&0x0f;
    const binary=(
      ((digest[offset]!&0x7f)<<24)|
      ((digest[offset+1]!&0xff)<<16)|
      ((digest[offset+2]!&0xff)<<8)|
      (digest[offset+3]!&0xff)
    )>>>0;
    return String(binary%1_000_000).padStart(6,"0");
  }

  private encryptionKey():Buffer{
    const raw=process.env.COREBIZ_MFA_ENCRYPTION_KEY?.trim();
    if(!raw){
      throw new ServiceUnavailableException(
        "Шифрование MFA не настроено"
      );
    }
    let key:Buffer;
    try{key=Buffer.from(raw,"base64");}catch{
      throw new ServiceUnavailableException(
        "Некорректный ключ шифрования MFA"
      );
    }
    if(key.length!==32){
      throw new ServiceUnavailableException(
        "Ключ шифрования MFA должен содержать 32 байта"
      );
    }
    return key;
  }

  private encrypt(value:string):string{
    const iv=randomBytes(12);
    const cipher=createCipheriv("aes-256-gcm",this.encryptionKey(),iv);
    const encrypted=Buffer.concat([
      cipher.update(value,"utf8"),cipher.final()
    ]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  private decrypt(value:string):string{
    const parts=value.split(".");
    if(parts.length!==4||parts[0]!=="v1"){
      throw new ServiceUnavailableException("Секрет MFA повреждён");
    }
    try{
      const iv=Buffer.from(parts[1]!,"base64url");
      const tag=Buffer.from(parts[2]!,"base64url");
      const ciphertext=Buffer.from(parts[3]!,"base64url");
      if(iv.length!==12||tag.length!==16)throw new Error("bad envelope");
      const decipher=createDecipheriv(
        "aes-256-gcm",this.encryptionKey(),iv
      );
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),decipher.final()
      ]).toString("utf8");
    }catch{
      throw new ServiceUnavailableException("Секрет MFA повреждён");
    }
  }

  private generateRecoveryCodes():string[]{
    const codes=new Set<string>();
    while(codes.size<10){
      const raw=randomBytes(8).toString("hex").toUpperCase();
      codes.add(raw.match(/.{1,4}/g)!.join("-"));
    }
    return [...codes];
  }

  private hashRecovery(value:string):string{
    return createHash("sha256")
      .update(this.normalizeRecovery(value)!,"utf8").digest("hex");
  }

  private normalizeRecovery(value:string):string|null{
    const normalized=value.toUpperCase().replace(/[^A-F0-9]/g,"");
    return /^[A-F0-9]{16}$/.test(normalized)?normalized:null;
  }

  private totpInput(value:unknown,throwOnInvalid=true):string{
    if(typeof value==="string"&&/^\d{6}$/.test(value.trim())){
      return value.trim();
    }
    if(throwOnInvalid){
      throw new BadRequestException("Введите шестизначный код");
    }
    return "";
  }

  private base32Encode(input:Buffer):string{
    let bits=0;
    let value=0;
    let output="";
    for(const byte of input){
      value=(value<<8)|byte;
      bits+=8;
      while(bits>=5){
        output+=BASE32[(value>>>(bits-5))&31]!;
        bits-=5;
      }
    }
    if(bits>0)output+=BASE32[(value<<(5-bits))&31]!;
    return output;
  }

  private base32Decode(input:string):Buffer{
    let bits=0;
    let value=0;
    const output:number[]=[];
    for(const raw of input.toUpperCase().replace(/=+$/,"")){
      const index=BASE32.indexOf(raw);
      if(index<0)throw new ServiceUnavailableException("Секрет MFA повреждён");
      value=(value<<5)|index;
      bits+=5;
      if(bits>=8){
        output.push((value>>>(bits-8))&255);
        bits-=8;
      }
    }
    return Buffer.from(output);
  }

  private mapConstraint(error:unknown):void{
    if(this.dbCode(error)==="23514"){
      throw new ConflictException("Настройка MFA изменилась, начните заново");
    }
  }

  private dbCode(error:unknown):string{
    return error&&typeof error==="object"&&"code" in error
      ?String((error as {code:unknown}).code):"";
  }
}

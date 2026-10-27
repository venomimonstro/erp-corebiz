import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { PrivateObjectStorageService } from "../../../infrastructure/storage/private-object-storage.service";
import { hashToken } from "../auth/auth.utils";

export type OperatorTenant = {
  tenantId: string;
  companyName: string;
  tenantStatus: string;
  subscriptionStatus: string | null;
  planCode: string | null;
  periodEnd: string | null;
  activeUsers: number;
  openTickets: number;
  createdAt: string;
};

@Injectable()
export class PlatformOperationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: PrivateObjectStorageService
  ) {}

  async summary(
    userId: string, rawSession: string | undefined
  ): Promise<Record<string, number>> {
    if (!rawSession) throw new ForbiddenException("Недостаточно прав оператора");
    try {
      const result = await this.database.query<{
        overview: Record<string, number>
      }>(
        "SELECT public.corebiz_platform_operator_summary($1::uuid,$2::text) AS overview",
        [userId, hashToken(rawSession)]
      );
      const row = result.rows[0]?.overview;
      if (!row || typeof row.tenants !== "number")
        throw new Error("PLATFORM_OVERVIEW_INVALID_RESPONSE");
      return row;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error &&
          error.code === "42501")
        throw new ForbiddenException("Недостаточно прав оператора");
      throw error;
    }
  }

  async suspensionHistory(
    userId: string, session: string | undefined, tenantId: string
  ): Promise<Array<{
    id:string; suspendedAt:string; resumedAt:string|null;
    reason:string; resumeReason:string|null;
  }>> {
    if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
      throw new ForbiddenException("Недостаточно прав оператора");
    try {
      const res = await this.database.query<{
        history: Array<{
          id:string;suspendedAt:string;resumedAt:string|null;
          reason:string;resumeReason:string|null;
        }>
      }>(
        "SELECT public.corebiz_platform_suspension_history($1::uuid,$2::text,$3::uuid) AS history",
        [userId,hashToken(session),tenantId]
      );
      const history=res.rows[0]?.history;
      if (!Array.isArray(history)) throw new Error("PLATFORM_HISTORY_INVALID");
      return history;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error &&
          error.code === "42501")
        throw new ForbiddenException("Недостаточно прав оператора");
      throw error;
    }
  }

  async setSuspension(
    userId: string, session: string | undefined, tenantId: string,
    action: "SUSPEND" | "RESUME", reason: string
  ): Promise<{ tenantId: string; status: string; suspensionId: string }> {
    if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
      throw new ForbiddenException("Недостаточно прав оператора");
    if (!["SUSPEND","RESUME"].includes(action) ||
        typeof reason !== "string" ||
        reason.trim().length < 15 || reason.trim().length > 800)
      throw new BadRequestException("Укажите причину от 15 до 800 символов");

    let outcome: {tenantId: string; status: string; suspensionId: string} | undefined;
    try {
      const res = await this.database.query<{
        outcome: {tenantId: string; status: string; suspensionId: string}
      }>(
        "SELECT public.corebiz_platform_tenant_suspension($1::uuid,$2::text,$3::uuid,$4::text,$5::text) AS outcome",
        [userId, hashToken(session), tenantId, action, reason.trim()]
      );
      outcome = res.rows[0]?.outcome;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code) : "";
      if (code === "42501")
        throw new ForbiddenException("Недостаточно прав оператора");
      if (code === "22023")
        throw new BadRequestException("Некорректные параметры действия");
      if (code === "P0002")
        throw new NotFoundException("Компания не найдена");
      if (code === "23514" || code === "23505")
        throw new ConflictException("Состояние компании изменилось");
      throw error;
    }
    if (!outcome || outcome.tenantId !== tenantId)
      throw new Error("PLATFORM_ACTION_INVALID_RESPONSE");
    return outcome;
  }

  async supportQueue(
    userId: string,
    rawSession: string | undefined,
    limit: number,
    offset: number
  ): Promise<{total:number;items:Array<Record<string,unknown>>}> {
    if(!rawSession) throw new ForbiddenException("Недостаточно прав оператора");
    try{
      const result=await this.database.query<{
        queue:{total:number;items:Array<Record<string,unknown>>}
      }>(
        `SELECT public.corebiz_platform_support_queue(
           $1::uuid,$2::text,$3::integer,$4::integer
         ) AS queue`,
        [userId,hashToken(rawSession),limit,offset]
      );
      const queue=result.rows[0]?.queue;
      if(!queue||!Array.isArray(queue.items))
        throw new Error("PLATFORM_SUPPORT_QUEUE_INVALID");
      return queue;
    }catch(error){
      this.mapSupportError(error);
      throw error;
    }
  }

  async supportTicket(
    userId:string,
    rawSession:string|undefined,
    ticketId:string
  ):Promise<Record<string,unknown>>{
    if(!rawSession||!this.uuid(ticketId))
      throw new ForbiddenException("Недостаточно прав оператора");
    try{
      const result=await this.database.query<{ticket:Record<string,unknown>}>(
        `SELECT public.corebiz_platform_support_ticket(
           $1::uuid,$2::text,$3::uuid
         ) AS ticket`,
        [userId,hashToken(rawSession),ticketId]
      );
      const ticket=result.rows[0]?.ticket;
      if(!ticket)throw new NotFoundException("Обращение не найдено");
      return ticket;
    }catch(error){
      this.mapSupportError(error);
      throw error;
    }
  }

  async supportReply(
    userId:string,
    rawSession:string|undefined,
    ticketId:string,
    body:string
  ):Promise<Record<string,unknown>>{
    if(!rawSession||!this.uuid(ticketId))
      throw new ForbiddenException("Недостаточно прав оператора");
    if(typeof body!=="string"||body.trim().length<1||body.trim().length>20000)
      throw new BadRequestException("Некорректное сообщение");
    try{
      const result=await this.database.query<{outcome:Record<string,unknown>}>(
        `SELECT public.corebiz_platform_support_reply(
           $1::uuid,$2::text,$3::uuid,$4::text
         ) AS outcome`,
        [userId,hashToken(rawSession),ticketId,body.trim()]
      );
      const outcome=result.rows[0]?.outcome;
      if(!outcome)throw new Error("PLATFORM_SUPPORT_REPLY_INVALID_RESPONSE");
      return outcome;
    }catch(error){
      this.mapSupportError(error);
      throw error;
    }
  }

  async supportClose(
    userId:string,
    rawSession:string|undefined,
    ticketId:string,
    resolution:string
  ):Promise<Record<string,unknown>>{
    if(!rawSession||!this.uuid(ticketId))
      throw new ForbiddenException("Недостаточно прав оператора");
    if(typeof resolution!=="string"||
       resolution.trim().length<10||resolution.trim().length>2000)
      throw new BadRequestException("Укажите результат от 10 до 2000 символов");
    try{
      const result=await this.database.query<{outcome:Record<string,unknown>}>(
        `SELECT public.corebiz_platform_support_close(
           $1::uuid,$2::text,$3::uuid,$4::text
         ) AS outcome`,
        [userId,hashToken(rawSession),ticketId,resolution.trim()]
      );
      const outcome=result.rows[0]?.outcome;
      if(!outcome)throw new Error("PLATFORM_SUPPORT_CLOSE_INVALID_RESPONSE");
      return outcome;
    }catch(error){
      this.mapSupportError(error);
      throw error;
    }
  }

  async supportAttachmentDownload(
    userId:string,
    rawSession:string|undefined,
    attachmentId:string
  ):Promise<{url:string;expiresAt:string;filename:string}>{
    if(!rawSession||!this.uuid(attachmentId))
      throw new ForbiddenException("Недостаточно прав оператора");
    try{
      const result=await this.database.query<{
        object_key:string;filename:string;
      }>(
        `SELECT * FROM public.corebiz_platform_support_attachment(
           $1::uuid,$2::text,$3::uuid
         )`,
        [userId,hashToken(rawSession),attachmentId]
      );
      const item=result.rows[0];
      if(!item)throw new NotFoundException("Вложение не найдено");
      const expiresAt=new Date(Date.now()+5*60_000);
      return {
        url:this.storage.createDownloadUrl(item.object_key,300),
        expiresAt:expiresAt.toISOString(),
        filename:item.filename
      };
    }catch(error){
      this.mapSupportError(error);
      throw error;
    }
  }

  async claimSupportDiagnostics(
    userId:string,
    rawSession:string|undefined,
    token:string
  ):Promise<Record<string,unknown>>{
    if(!rawSession||typeof token!=="string"||
       token.trim().length<32||token.trim().length>200){
      throw new BadRequestException("Некорректный токен диагностики");
    }
    try{
      const result=await this.database.query<{access:Record<string,unknown>}>(
        `SELECT public.corebiz_platform_support_claim_diagnostics(
           $1::uuid,$2::text,$3::text
         ) AS access`,
        [userId,hashToken(rawSession),hashToken(token.trim())]
      );
      const access=result.rows[0]?.access;
      if(!access)throw new NotFoundException("Доступ диагностики недоступен");
      return access;
    }catch(error){
      const code=this.dbCode(error);
      if(code==="42501")
        throw new ForbiddenException(
          "Для диагностики требуется активная MFA-сессия оператора"
        );
      if(code==="P0002")
        throw new NotFoundException(
          "Токен истёк, уже использован или был отозван"
        );
      if(code==="22023")
        throw new BadRequestException("Некорректный токен диагностики");
      throw error;
    }
  }

  async supportDiagnostics(
    userId:string,
    rawSession:string|undefined,
    accessId:string
  ):Promise<Record<string,unknown>>{
    if(!rawSession||!this.uuid(accessId))
      throw new ForbiddenException("Диагностический доступ недоступен");
    try{
      const result=await this.database.query<{diagnostics:Record<string,unknown>}>(
        `SELECT public.corebiz_platform_support_diagnostics(
           $1::uuid,$2::text,$3::uuid
         ) AS diagnostics`,
        [userId,hashToken(rawSession),accessId]
      );
      const diagnostics=result.rows[0]?.diagnostics;
      if(!diagnostics)throw new NotFoundException("Диагностика недоступна");
      return diagnostics;
    }catch(error){
      const code=this.dbCode(error);
      if(code==="42501")
        throw new ForbiddenException(
          "Диагностический доступ истёк, отозван или принадлежит другой сессии"
        );
      if(code==="P0002")
        throw new NotFoundException("Компания недоступна");
      throw error;
    }
  }

  async endSupportDiagnostics(
    userId:string,
    rawSession:string|undefined,
    accessId:string
  ):Promise<{ended:true}>{
    if(!rawSession||!this.uuid(accessId))
      throw new ForbiddenException("Диагностический доступ недоступен");
    const result=await this.database.query<{ended:boolean}>(
      `SELECT public.corebiz_platform_support_end_diagnostics(
         $1::uuid,$2::text,$3::uuid
       ) AS ended`,
      [userId,hashToken(rawSession),accessId]
    );
    if(result.rows[0]?.ended!==true)
      throw new NotFoundException("Активная диагностическая сессия не найдена");
    return {ended:true};
  }

  async tenants(
    userId: string,
    rawSession: string | undefined,
    limit: number,
    offset: number
  ): Promise<{total: number; items: OperatorTenant[]}> {
    if (!rawSession || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 100 || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > 100000) {
      throw new ForbiddenException("Доступ оператора платформы запрещён");
    }
    try {
      const result = await this.database.query<{
        overview: { total: number; items: OperatorTenant[] };
      }>(
        `SELECT public.corebiz_platform_operator_tenants(
           $1::uuid,$2::text,$3::integer,$4::integer
         ) AS overview`,
        [userId, hashToken(rawSession), limit, offset]
      );
      const data = result.rows[0]?.overview;
      if (!data || !Array.isArray(data.items)) {
        throw new Error("PLATFORM_OPERATOR_RESPONSE_INVALID");
      }
      return data;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error &&
          error.code === "42501") {
        throw new ForbiddenException("Доступ оператора платформы запрещён");
      }
      throw error;
    }
  }
  private dbCode(error:unknown):string{
    return error&&typeof error==="object"&&"code" in error
      ?String((error as {code:unknown}).code):"";
  }

  private mapSupportError(error: unknown): void {
    const code=error&&typeof error==="object"&&"code" in error
      ?String(error.code):"";
    if(code==="42501")
      throw new ForbiddenException("Недостаточно прав оператора");
    if(code==="22023")
      throw new BadRequestException("Некорректные параметры поддержки");
    if(code==="P0002")
      throw new NotFoundException("Обращение не найдено");
    if(code==="23514")
      throw new ConflictException("Состояние обращения изменилось");
  }

  private uuid(value:string):boolean{
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(value);
  }

}

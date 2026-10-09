import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RedisService } from "../../../infrastructure/cache/redis.service";
import { CrmService } from "../crm/crm.service";
import { PartyService } from "../party/party.service";
import { BookingService } from "../service-ops/booking.service";

@Injectable()
export class SiteFormsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly crm: CrmService,
    private readonly parties: PartyService,
    private readonly bookings: BookingService
  ) {}

  async bindings(
    context: TenantContext,
    siteId: string
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result=await client.query(
        `SELECT id,name,public_key,action,config,status,created_at,updated_at
         FROM site_form_binding
         WHERE tenant_id=$1 AND site_id=$2
         ORDER BY created_at DESC`,
        [context.tenantId,siteId]
      );
      return result.rows;
    });
  }

  async createBinding(
    context: TenantContext,
    siteId: string,
    input: {
      name: string;
      action: "CRM_LEAD" | "BOOKING";
      responsibleMembershipId?: string;
      pipelineId?: string;
      stageId?: string;
      serviceId?: string;
      resourceIds?: string[];
    }
  ): Promise<{ id: string; publicKey: string }> {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.name !== "string" ||
        (input.action !== "CRM_LEAD" && input.action !== "BOOKING") ||
        (input.responsibleMembershipId !== undefined && typeof input.responsibleMembershipId !== "string") ||
        (input.pipelineId !== undefined && typeof input.pipelineId !== "string") ||
        (input.stageId !== undefined && typeof input.stageId !== "string") ||
        (input.serviceId !== undefined && typeof input.serviceId !== "string") ||
        (input.resourceIds !== undefined && (
          !Array.isArray(input.resourceIds) ||
          input.resourceIds.length > 10 ||
          input.resourceIds.some(id => typeof id !== "string")
        ))) {
      throw new BadRequestException("Некорректная конфигурация формы");
    }
    const name=input.name.trim();
    if(name.length<2||name.length>160){
      throw new BadRequestException("Некорректное название формы");
    }

    const responsible=input.responsibleMembershipId??context.membershipId;
    const config:Record<string,unknown>={
      responsibleMembershipId:responsible
    };

    if(input.action==="CRM_LEAD"){
      if(input.pipelineId) config.pipelineId=input.pipelineId;
      if(input.stageId) config.stageId=input.stageId;
    }else{
      if(!input.serviceId) throw new BadRequestException("Для BOOKING требуется serviceId");
      config.serviceId=input.serviceId;
      const resourceIds=Array.from(new Set(input.resourceIds??[])).slice(0,10);
      if (!resourceIds.length) {
        throw new BadRequestException("Укажите хотя бы одного специалиста или ресурс для онлайн-записи");
      }
      if (resourceIds.some(id=>typeof id!=="string" || !/^[0-9a-f-]{36}$/i.test(id))) {
        throw new BadRequestException("Некорректный resourceId");
      }
      config.resourceIds=resourceIds;
    }

    const publicKey="form_"+randomBytes(24).toString("base64url");

    return this.database.withTenantTransaction(context,async client=>{
      const site=await client.query(
        `SELECT 1 FROM site WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,siteId]
      );
      if(!site.rowCount) throw new NotFoundException("Сайт не найден");

      const member=await client.query(
        `SELECT 1 FROM tenant_membership
         WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
        [context.tenantId,responsible]
      );
      if(!member.rowCount) throw new NotFoundException("Ответственный сотрудник недоступен");

      if (input.action==="BOOKING") {
        const service=await client.query(
          `SELECT 1 FROM service_catalog_item
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.serviceId]
        );
        if(!service.rowCount) throw new NotFoundException("Услуга недоступна");
        const resourceIds=config.resourceIds as string[];
        const resourceRows=await client.query<{id:string}>(
          `SELECT id FROM service_resource
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE'`,
          [context.tenantId,resourceIds]
        );
        if(resourceRows.rowCount!==resourceIds.length) {
          throw new BadRequestException("Один или несколько ресурсов недоступны");
        }
      }

      const result=await client.query<{id:string}>(
        `INSERT INTO site_form_binding(
           tenant_id,site_id,name,public_key,action,config,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          context.tenantId,siteId,name,publicKey,input.action,
          JSON.stringify(config),context.membershipId
        ]
      );

      return {id:result.rows[0]!.id,publicKey};
    });
  }

  async bookingAvailability(publicKey:string, from:string, to:string):Promise<Array<{
    resourceId:string;resourceName:string;startsAt:string;endsAt:string;
  }>> {
    if (!publicKey || publicKey.length > 160) throw new BadRequestException("Invalid booking link");
    const start=new Date(from), end=new Date(to);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
        end<=start || end.getTime()-start.getTime()>86400000 ||
        end.getTime()<Date.now() || start.getTime()>Date.now()+90*86400000)
      throw new BadRequestException("Select a future day within 90 days");
    const result=await this.database.query<{
      binding_id:string;tenant_id:string;action:string;config:Record<string,unknown>;
    }>("SELECT * FROM corebiz_resolve_site_form_binding($1)",[publicKey]);
    const binding=result.rows[0];
    if (!binding || binding.action!=="BOOKING") throw new NotFoundException("Booking form not found");
    const hits=await this.redis.incrementWindow("site-form-availability:"+binding.binding_id,60);
    if(hits>120) throw new BadRequestException("Too many availability requests");
    const serviceId=typeof binding.config.serviceId==="string"?binding.config.serviceId:"";
    const allowed=Array.isArray(binding.config.resourceIds)?binding.config.resourceIds.filter(
      (id):id is string=>typeof id==="string"
    ):[];
    if(!serviceId || !allowed.length) return [];
    const context:TenantContext={
      tenantId:binding.tenant_id,userId:"00000000-0000-0000-0000-000000000000",
      membershipId:"00000000-0000-0000-0000-000000000000"
    };
    const slots=await this.bookings.availability(context,{
      serviceId,from:start.toISOString(),to:end.toISOString(),slotStepMinutes:30
    });
    return slots.filter(slot=>allowed.includes(slot.resourceId) && new Date(slot.startsAt).getTime()>Date.now()).slice(0,100);
  }

  async submit(
    publicKey:string,
    input:{
      idempotencyKey:string;
      name?:string;
      phone?:string;
      email?:string;
      message?:string;
      startsAt?:string;
      resourceId?:string;
      honeypot?:string;
    }
  ):Promise<Record<string,unknown>>{
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.idempotencyKey !== "string" ||
        (input.honeypot !== undefined && typeof input.honeypot !== "string")) {
      throw new BadRequestException("Некорректные данные заявки");
    }
    if(input.honeypot?.trim()){
      return {accepted:true};
    }
    if(!input.idempotencyKey.trim()||input.idempotencyKey.length>160){
      throw new BadRequestException("Требуется idempotencyKey");
    }

    const binding=await this.database.query<{
      binding_id:string;
      tenant_id:string;
      site_id:string;
      action:"CRM_LEAD"|"BOOKING";
      config:Record<string,unknown>;
    }>(
      "SELECT * FROM corebiz_resolve_site_form_binding($1)",
      [publicKey]
    );
    const row=binding.rows[0];
    if(!row) throw new NotFoundException("Форма недоступна");

    const rate=await this.redis.incrementWindow(
      "site-form:"+row.binding_id,
      60
    );
    if(rate>120){
      return {accepted:false,reason:"rate_limited"};
    }

    const payload=this.validatePayload(input);

    const existing=await this.database.withTenantTransaction(
      {
        tenantId:row.tenant_id,
        userId:"00000000-0000-0000-0000-000000000000",
        membershipId:"00000000-0000-0000-0000-000000000000"
      },
      async client=>{
        const found=await client.query<{
          id:string;status:string;result_type:string|null;result_id:string|null;
        }>(
          `SELECT id,status,result_type,result_id
           FROM site_submission
           WHERE tenant_id=$1 AND binding_id=$2 AND idempotency_key=$3`,
          [row.tenant_id,row.binding_id,input.idempotencyKey.trim()]
        );
        if(found.rows[0]) return found.rows[0];

        const created=await client.query<{id:string}>(
          `INSERT INTO site_submission(
             tenant_id,binding_id,idempotency_key,payload
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT(binding_id,idempotency_key) DO NOTHING
           RETURNING id`,
          [
            row.tenant_id,row.binding_id,input.idempotencyKey.trim(),
            JSON.stringify(payload)
          ]
        );
        if(!created.rows[0]) {
          const duplicate=await client.query<{
            id:string;status:string;result_type:string|null;result_id:string|null;
          }>(`SELECT id,status,result_type,result_id FROM site_submission
              WHERE tenant_id=$1 AND binding_id=$2 AND idempotency_key=$3`,
            [row.tenant_id,row.binding_id,input.idempotencyKey.trim()]);
          return duplicate.rows[0]!;
        }
        return {
          id:created.rows[0].id,
          status:"RECEIVED",
          result_type:null,
          result_id:null
        };
      }
    );

    if(existing.status==="PROCESSED"){
      return {
        accepted:true,
        submissionId:existing.id,
        resultType:existing.result_type,
        resultId:existing.result_id,
        reused:true
      };
    }

    if(existing.status!=="RECEIVED") {
      throw new ConflictException("Заявка уже обрабатывается или требует проверки");
    }
    const claimed=await this.database.withTenantTransaction(
      {tenantId:row.tenant_id,userId:"00000000-0000-0000-0000-000000000000",
       membershipId:"00000000-0000-0000-0000-000000000000"},
      async client=>client.query(
        `UPDATE site_submission SET status='PROCESSING'
         WHERE tenant_id=$1 AND id=$2 AND status='RECEIVED' RETURNING id`,
        [row.tenant_id,existing.id])
    );
    if(!claimed.rowCount) throw new ConflictException("Заявка уже обрабатывается");
    const responsible=String(row.config?.responsibleMembershipId??"");
    const actor=await this.database.withTenantTransaction(
      {
        tenantId:row.tenant_id,
        userId:"00000000-0000-0000-0000-000000000000",
        membershipId:"00000000-0000-0000-0000-000000000000"
      },
      async client=>{
        const result=await client.query<{user_id:string}>(
          `SELECT user_id
           FROM tenant_membership
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [row.tenant_id,responsible]
        );
        return result.rows[0]??null;
      }
    );
    if(!actor){
      await this.fail(row.tenant_id,existing.id,"RESPONSIBLE_UNAVAILABLE");
      throw new ConflictException("Форма временно недоступна");
    }

    const context:TenantContext={
      tenantId:row.tenant_id,
      userId:actor.user_id,
      membershipId:responsible
    };

    try{
      if(row.action==="CRM_LEAD"){
        const customer=await this.parties.create(context,{
          displayName:payload.name,
          phone:payload.phone??undefined,
          email:payload.email??undefined,
          responsibleMembershipId:responsible
        });

        const deal=await this.crm.createDeal(context,{
          title:"Заявка с сайта — "+payload.name,
          partyId:customer.id,
          responsibleMembershipId:responsible,
          pipelineId:typeof row.config.pipelineId==="string"?row.config.pipelineId:undefined,
          stageId:typeof row.config.stageId==="string"?row.config.stageId:undefined,
          source:"SITE_FORM"
        });

        await this.complete(row.tenant_id,existing.id,"CRM_DEAL",deal.id);
        return {accepted:true,submissionId:existing.id,resultType:"CRM_DEAL",resultId:deal.id};
      }

      const startsAt=new Date(payload.startsAt??"");
      if(Number.isNaN(startsAt.getTime())){
        throw new BadRequestException("Для записи требуется startsAt");
      }
      if(startsAt.getTime()<=Date.now() || startsAt.getTime()>Date.now()+90*86400000)
        throw new BadRequestException("Выберите будущее время в пределах 90 дней");
      const serviceId=String(row.config.serviceId??"");
      const resourceIds=Array.isArray(row.config.resourceIds)
        ? row.config.resourceIds.map(String)
        : [];

      const requestedResource=payload.resourceId;
      if(requestedResource && !resourceIds.includes(requestedResource))
        throw new BadRequestException("Выбранный специалист не разрешён для этой формы");
      if(!requestedResource && resourceIds.length!==1)
        throw new BadRequestException("Выберите специалиста или ресурс");

      const customer=await this.parties.create(context,{
        displayName:payload.name,
        phone:payload.phone??undefined,
        email:payload.email??undefined,
        responsibleMembershipId:responsible
      });

      const booking=await this.bookings.createBooking(context,{
        serviceId,
        resourceIds:requestedResource?[requestedResource]:resourceIds,
        startsAt:startsAt.toISOString(),
        partyId:customer.id,
        source:"PUBLIC_SITE",
        notes:payload.message??undefined,
        idempotencyKey:"site-submission:"+existing.id
      });

      await this.complete(row.tenant_id,existing.id,"SERVICE_BOOKING",booking.id);
      return {accepted:true,submissionId:existing.id,resultType:"SERVICE_BOOKING",resultId:booking.id};
    }catch(error){
      await this.fail(
        row.tenant_id,
        existing.id,
        error instanceof Error?error.message:String(error)
      );
      throw error;
    }
  }

  private validatePayload(input:any):{
    name:string;phone?:string;email?:string;message?:string;startsAt?:string;resourceId?:string
  }{
    for (const field of ["name","phone","email","message","startsAt","resourceId"] as const) {
      if (input[field] !== undefined && input[field] !== null &&
          typeof input[field] !== "string") {
        throw new BadRequestException("Некорректное поле: " + field);
      }
    }
    const name=String(input.name??"").trim();
    if(name.length<2||name.length>200) throw new BadRequestException("Укажите имя");

    const phone=String(input.phone??"").trim();
    const email=String(input.email??"").trim().toLowerCase();
    if(!phone&&!email) throw new BadRequestException("Укажите телефон или email");
    if(phone.length>40||email.length>320) throw new BadRequestException("Некорректные контакты");

    const message=String(input.message??"").trim();
    if(message.length>4000) throw new BadRequestException("Сообщение слишком длинное");

    const startsAt=String(input.startsAt??"").trim();
    const resourceId=String(input.resourceId??"").trim();
    if(resourceId && !/^[0-9a-f-]{36}$/i.test(resourceId)) throw new BadRequestException("Некорректный ресурс");

    return {
      name,
      ...(phone?{phone}:{}),
      ...(email?{email}:{}),
      ...(message?{message}:{}),
      ...(startsAt?{startsAt}:{}),
      ...(resourceId?{resourceId}:{})
    };
  }

  private async complete(
    tenantId:string,submissionId:string,resultType:string,resultId:string
  ):Promise<void>{
    await this.database.withTenantTransaction(
      {tenantId,userId:"00000000-0000-0000-0000-000000000000",membershipId:"00000000-0000-0000-0000-000000000000"},
      async client=>{
        await client.query(
          `UPDATE site_submission
           SET status='PROCESSED',result_type=$3,result_id=$4,processed_at=now(),last_error=NULL
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId,submissionId,resultType,resultId]
        );
      }
    );
  }

  private async fail(tenantId:string,submissionId:string,message:string):Promise<void>{
    await this.database.withTenantTransaction(
      {tenantId,userId:"00000000-0000-0000-0000-000000000000",membershipId:"00000000-0000-0000-0000-000000000000"},
      async client=>{
        await client.query(
          `UPDATE site_submission
           SET status='FAILED',last_error=$3
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId,submissionId,message.slice(0,2000)]
        );
      }
    );
  }
}

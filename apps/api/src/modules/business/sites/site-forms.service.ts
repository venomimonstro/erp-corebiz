import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { TenantContext } from "@corebiz/contracts";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";
import { RedisService } from "../../../infrastructure/cache/redis.service";
import { CrmService } from "../crm/crm.service";
import { PartyService } from "../party/party.service";
import { BookingService } from "../service-ops/booking.service";
import { DanceStudioService } from "../dance-studio/dance-studio.service";

@Injectable()
export class SiteFormsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly crm: CrmService,
    private readonly parties: PartyService,
    private readonly bookings: BookingService,
    private readonly dance: DanceStudioService
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
      action: "CRM_LEAD" | "BOOKING" | "DANCE_BOOKING";
      responsibleMembershipId?: string;
      pipelineId?: string;
      stageId?: string;
      serviceId?: string;
      resourceIds?: string[];
      danceGroupId?: string;
    }
  ): Promise<{ id: string; publicKey: string }> {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.name !== "string" ||
        !["CRM_LEAD","BOOKING","DANCE_BOOKING"].includes(input.action) ||
        (input.responsibleMembershipId !== undefined && typeof input.responsibleMembershipId !== "string") ||
        (input.pipelineId !== undefined && typeof input.pipelineId !== "string") ||
        (input.stageId !== undefined && typeof input.stageId !== "string") ||
        (input.serviceId !== undefined && typeof input.serviceId !== "string") ||
        (input.resourceIds !== undefined && (
          !Array.isArray(input.resourceIds) ||
          input.resourceIds.length > 10 ||
          input.resourceIds.some(id => typeof id !== "string")
        )) ||
        (input.danceGroupId !== undefined && typeof input.danceGroupId !== "string")) {
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
    }else if(input.action==="BOOKING"){
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
    }else{
      if(!input.danceGroupId || !/^[0-9a-f-]{36}$/i.test(input.danceGroupId)){
        throw new BadRequestException("Для DANCE_BOOKING требуется danceGroupId");
      }
      config.danceGroupId=input.danceGroupId;
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

      if (input.action==="DANCE_BOOKING") {
        const group=await client.query(
          `SELECT 1
           FROM dance_group
           WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
          [context.tenantId,input.danceGroupId]
        );
        if(!group.rowCount) throw new NotFoundException("Группа студии недоступна");
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

  async bookingAvailability(
    publicKey:string,
    from:string,
    to:string,
    clientIdentity="unknown"
  ):Promise<Array<{
    resourceId:string;
    resourceName:string;
    startsAt:string;
    endsAt:string;
    lessonId?:string;
    groupName?:string;
    spotsLeft?:number;
    waitlist?:number;
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
    if (!binding || !["BOOKING","DANCE_BOOKING"].includes(binding.action)) {
      throw new NotFoundException("Booking form not found");
    }
    const clientKey=this.clientKey(clientIdentity);
    const [clientHits,totalHits]=await Promise.all([
      this.redis.incrementWindow(
        "site-form-availability:client:"+binding.binding_id+":"+clientKey,
        60
      ),
      this.redis.incrementWindow(
        "site-form-availability:total:"+binding.binding_id,
        60
      )
    ]);
    if(clientHits>60 || totalHits>3000){
      throw new BadRequestException("Too many availability requests");
    }
    if(binding.action==="DANCE_BOOKING"){
      const groupId=typeof binding.config.danceGroupId==="string"
        ? binding.config.danceGroupId
        : "";
      if(!groupId) return [];

      return this.database.withTenantTransaction(
        {
          tenantId:binding.tenant_id,
          userId:"00000000-0000-0000-0000-000000000000",
          membershipId:"00000000-0000-0000-0000-000000000000"
        },
        async client=>{
          const lessons=await client.query<{
            id:string;group_name:string;starts_at:Date;ends_at:Date;
            trainer_id:string|null;trainer_name:string|null;capacity:number;
            booked_count:number;waitlist:number;
          }>(
            `SELECT
               l.id,g.name AS group_name,l.starts_at,l.ends_at,
               l.trainer_resource_id AS trainer_id,tr.name AS trainer_name,
               l.capacity,
               count(lp.id) FILTER (
                 WHERE lp.status NOT IN ('WAITLIST','CANCELLED_IN_TIME')
               )::integer AS booked_count,
               count(lp.id) FILTER (WHERE lp.status='WAITLIST')::integer AS waitlist
             FROM dance_lesson l
             JOIN dance_group g
               ON g.tenant_id=l.tenant_id AND g.id=l.group_id
             LEFT JOIN service_resource tr
               ON tr.tenant_id=l.tenant_id AND tr.id=l.trainer_resource_id
             LEFT JOIN dance_lesson_participant lp
               ON lp.tenant_id=l.tenant_id AND lp.lesson_id=l.id
             WHERE l.tenant_id=$1 AND l.group_id=$2
               AND l.status='OPEN_FOR_BOOKING'
               AND l.starts_at >= $3 AND l.starts_at < $4
               AND l.starts_at > now()
             GROUP BY l.id,g.name,tr.name
             ORDER BY l.starts_at
             LIMIT 100`,
            [binding.tenant_id,groupId,start,end]
          );
          return lessons.rows.map(row=>({
            resourceId:row.trainer_id??"",
            resourceName:row.trainer_name??"Тренер",
            startsAt:row.starts_at.toISOString(),
            endsAt:row.ends_at.toISOString(),
            lessonId:row.id,
            groupName:row.group_name,
            spotsLeft:Math.max(0,row.capacity-row.booked_count),
            waitlist:row.waitlist
          }));
        }
      );
    }

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
      childName?:string;
      childBirthDate?:string;
      lessonId?:string;
      honeypot?:string;
    },
    clientIdentity="unknown"
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
      action:"CRM_LEAD"|"BOOKING"|"DANCE_BOOKING";
      config:Record<string,unknown>;
    }>(
      "SELECT * FROM corebiz_resolve_site_form_binding($1)",
      [publicKey]
    );
    const row=binding.rows[0];
    if(!row) throw new NotFoundException("Форма недоступна");

    const clientKey=this.clientKey(clientIdentity);
    const [clientRate,totalRate]=await Promise.all([
      this.redis.incrementWindow(
        "site-form:client:"+row.binding_id+":"+clientKey,
        60
      ),
      this.redis.incrementWindow(
        "site-form:total:"+row.binding_id,
        60
      )
    ]);
    if(clientRate>30 || totalRate>600){
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
          responsibleMembershipId:responsible,
          idempotencyKey:"site-submission-party:"+existing.id
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

      if(row.action==="DANCE_BOOKING"){
        const childName=payload.childName?.trim()??"";
        const childBirthDate=payload.childBirthDate?.trim()??"";
        const lessonId=payload.lessonId?.trim()??"";
        const groupId=String(row.config.danceGroupId??"");
        if(childName.length<2||childName.length>200){
          throw new BadRequestException("Укажите имя ребёнка");
        }
        if(!/^\d{4}-\d{2}-\d{2}$/.test(childBirthDate)){
          throw new BadRequestException("Укажите дату рождения ребёнка");
        }
        if(!/^[0-9a-f-]{36}$/i.test(lessonId)){
          throw new BadRequestException("Выберите занятие");
        }

        const allowedLesson=await this.database.withTenantTransaction(
          context,
          async client=>{
            const result=await client.query(
              `SELECT 1 FROM dance_lesson
               WHERE tenant_id=$1 AND id=$2 AND group_id=$3
                 AND status='OPEN_FOR_BOOKING' AND starts_at>now()`,
              [row.tenant_id,lessonId,groupId]
            );
            return Boolean(result.rowCount);
          }
        );
        if(!allowedLesson) throw new NotFoundException("Занятие уже недоступно");

        const parent=await this.parties.create(context,{
          displayName:payload.name,
          phone:payload.phone??undefined,
          email:payload.email??undefined,
          responsibleMembershipId:responsible,
          idempotencyKey:"dance-public-parent:"+existing.id
        });
        const child=await this.parties.create(context,{
          displayName:childName,
          responsibleMembershipId:responsible,
          idempotencyKey:"dance-public-child:"+existing.id
        });
        const student=await this.dance.createStudent(context,{
          partyId:child.id,
          birthDate:childBirthDate,
          payerPartyId:parent.id,
          payerRelation:"PARENT"
        });
        const participant=await this.dance.addParticipant(
          context,
          lessonId,
          {
            studentId:student.id,
            chargeMinor:"0",
            allowWaitlist:true
          }
        );

        await this.complete(
          row.tenant_id,
          existing.id,
          "DANCE_LESSON_PARTICIPANT",
          String((participant as any).id)
        );
        return {
          accepted:true,
          submissionId:existing.id,
          resultType:"DANCE_LESSON_PARTICIPANT",
          resultId:(participant as any).id,
          status:(participant as any).status
        };
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

      // Reserve the scarce slot before creating CRM data. Under a concurrent
      // public race only the winner creates a Party; losers receive a clean
      // conflict instead of leaving orphan customer cards.
      const booking=await this.bookings.createBooking(context,{
        serviceId,
        resourceIds:requestedResource?[requestedResource]:resourceIds,
        startsAt:startsAt.toISOString(),
        source:"PUBLIC_SITE",
        notes:payload.message??undefined,
        idempotencyKey:"site-submission:"+existing.id
      });

      try {
        const customer=await this.parties.create(context,{
          displayName:payload.name,
          phone:payload.phone??undefined,
          email:payload.email??undefined,
          responsibleMembershipId:responsible,
          idempotencyKey:"site-submission-party:"+existing.id
        });

        await this.bookings.attachParty(context,booking.id,customer.id);
      } catch (error) {
        // Do not keep a ghost slot when CRM/customer linking failed after the
        // atomic booking reservation. Cancellation also makes capacity free.
        try {
          await this.bookings.setStatus(
            context,
            booking.id,
            "CANCELLED",
            booking.version
          );
        } catch {
          // Preserve the original failure. Release diagnostics will surface
          // any impossible cancellation separately.
        }
        throw error;
      }

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
    name:string;phone?:string;email?:string;message?:string;startsAt?:string;
    resourceId?:string;childName?:string;childBirthDate?:string;lessonId?:string
  }{
    for (const field of [
      "name","phone","email","message","startsAt","resourceId",
      "childName","childBirthDate","lessonId"
    ] as const) {
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

    const childName=String(input.childName??"").trim();
    const childBirthDate=String(input.childBirthDate??"").trim();
    const lessonId=String(input.lessonId??"").trim();
    if(childName.length>200) throw new BadRequestException("Некорректное имя ребёнка");
    if(childBirthDate && !/^\d{4}-\d{2}-\d{2}$/.test(childBirthDate))
      throw new BadRequestException("Некорректная дата рождения");
    if(lessonId && !/^[0-9a-f-]{36}$/i.test(lessonId))
      throw new BadRequestException("Некорректный урок");

    return {
      name,
      ...(phone?{phone}:{}),
      ...(email?{email}:{}),
      ...(message?{message}:{}),
      ...(startsAt?{startsAt}:{}),
      ...(resourceId?{resourceId}:{}),
      ...(childName?{childName}:{}),
      ...(childBirthDate?{childBirthDate}:{}),
      ...(lessonId?{lessonId}:{})
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

  private clientKey(identity:string):string{
    return createHash("sha256")
      .update(String(identity||"unknown").slice(0,500))
      .digest("hex")
      .slice(0,32);
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

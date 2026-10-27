import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service";

type UnisenderEvent = {
  event_name?: unknown;
  event_data?: unknown;
};

type UnisenderEventGroup = {
  events?: unknown;
};

type UnisenderPayload = {
  auth?: unknown;
  events_by_user?: unknown;
};

const DELIVERY_STATUSES = new Set([
  "accepted","sent","delivered","soft_bounced","hard_bounced",
  "spam","unsubscribed","subscribed"
]);

@Injectable()
export class AuthMailWebhookService {
  constructor(private readonly database: DatabaseService) {}

  async accept(payload: unknown): Promise<{
    accepted: true;
    events: number;
    matched: number;
  }> {
    if(!payload||typeof payload!=="object"||Array.isArray(payload)){
      throw new BadRequestException("Некорректный webhook");
    }
    const input=payload as UnisenderPayload;
    this.assertSecret(input.auth);

    if(!Array.isArray(input.events_by_user)){
      throw new BadRequestException("Некорректный webhook");
    }

    const events:Array<{
      jobId:string;
      status:string;
      eventAt:Date;
      deliveryStatus:string|null;
    }>=[];
    for(const rawGroup of input.events_by_user){
      if(!rawGroup||typeof rawGroup!=="object"||Array.isArray(rawGroup)){
        continue;
      }
      const group=rawGroup as UnisenderEventGroup;
      if(!Array.isArray(group.events))continue;
      for(const rawEvent of group.events){
        if(events.length>=100){
          throw new BadRequestException("Слишком много событий webhook");
        }
        const parsed=this.parseEvent(rawEvent as UnisenderEvent);
        if(parsed)events.push(parsed);
      }
    }

    let matched=0;
    if(events.length){
      await this.database.withTransaction(async client=>{
        for(const event of events){
          const result=await client.query<{recorded:boolean}>(
            `SELECT public.corebiz_record_auth_mail_provider_status(
               $1::text,$2::text,$3::timestamptz,$4::text
             ) AS recorded`,
            [
              event.jobId,event.status,event.eventAt,
              event.deliveryStatus
            ]
          );
          if(result.rows[0]?.recorded===true)matched++;
        }
      });
    }

    return {accepted:true,events:events.length,matched};
  }

  private parseEvent(raw:UnisenderEvent):{
    jobId:string;
    status:string;
    eventAt:Date;
    deliveryStatus:string|null;
  }|null{
    if(!raw||typeof raw!=="object"||
       raw.event_name!=="transactional_email_status"||
       !raw.event_data||typeof raw.event_data!=="object"||
       Array.isArray(raw.event_data)){
      return null;
    }
    const data=raw.event_data as Record<string,unknown>;
    const jobId=typeof data.job_id==="string"?data.job_id.trim():"";
    const status=typeof data.status==="string"
      ?data.status.trim().toLowerCase():"";
    if(!jobId||jobId.length>200||!DELIVERY_STATUSES.has(status)){
      return null;
    }

    const eventAt=this.eventDate(data.event_time);
    if(!eventAt)return null;

    let deliveryStatus:string|null=null;
    if(data.delivery_info&&typeof data.delivery_info==="object"&&
       !Array.isArray(data.delivery_info)){
      const detail=(data.delivery_info as Record<string,unknown>)
        .delivery_status;
      if(typeof detail==="string"&&detail.trim()){
        deliveryStatus=detail.trim().slice(0,160);
      }
    }
    return {jobId,status,eventAt,deliveryStatus};
  }

  private eventDate(value:unknown):Date|null{
    if(typeof value!=="string"||
       !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)){
      return null;
    }
    const date=new Date(value.replace(" ","T")+"Z");
    return Number.isFinite(date.getTime())?date:null;
  }

  private assertSecret(value:unknown):void{
    const configured=process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH?.trim();
    if(!configured||configured.length<32){
      throw new ServiceUnavailableException(
        "Webhook почтового провайдера не настроен"
      );
    }
    if(typeof value!=="string"||!value){
      throw new ForbiddenException("Webhook не авторизован");
    }
    const expected=createHash("sha256")
      .update(configured,"utf8").digest();
    const actual=createHash("sha256")
      .update(value,"utf8").digest();
    if(!timingSafeEqual(expected,actual)){
      throw new ForbiddenException("Webhook не авторизован");
    }
  }
}

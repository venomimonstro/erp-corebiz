import {
  ForbiddenException,
  ServiceUnavailableException
} from "@nestjs/common";
import { AuthMailWebhookService } from "./auth-mail-webhook.service";

describe("Unisender auth mail webhook", () => {
  const original=process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH;
  afterEach(()=>{
    if(original===undefined)delete process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH;
    else process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH=original;
  });

  it("rejects requests when webhook secret is not configured", async () => {
    delete process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH;
    const service=new AuthMailWebhookService({} as any);
    await expect(service.accept({
      auth:"anything",events_by_user:[]
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("uses the auth secret and records only supported email status events", async () => {
    process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH="x".repeat(48);
    const queries:Array<{sql:string;values:unknown[]}>=[];

    const db={
      withTransaction:jest.fn(async (fn:any)=>fn({
        query:jest.fn(async (sql:string,values:unknown[])=>{
          queries.push({sql,values});
          return {rows:[{recorded:true}]};
        })
      }))
    };
    const service=new AuthMailWebhookService(db as any);

    await expect(service.accept({
      auth:"x".repeat(48),
      events_by_user:[{
        events:[
          {
            event_name:"transactional_email_status",
            event_data:{
              job_id:"provider-job-1",
              status:"hard_bounced",
              event_time:"2026-10-27 10:00:00",
              email:"ignored@example.com",
              delivery_info:{delivery_status:"err_user_unknown"}
            }
          },
          {
            event_name:"transactional_spam_block",
            event_data:{domain:"example.com"}
          }
        ]
      }]
    })).resolves.toEqual({accepted:true,events:1,matched:1});

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain(
      "corebiz_record_auth_mail_provider_status"
    );
    expect(queries[0]?.values.slice(0,2)).toEqual([
      "provider-job-1","hard_bounced"
    ]);
    expect(queries[0]?.values).not.toContain("ignored@example.com");
  });

  it("rejects an invalid webhook auth value", async () => {
    process.env.COREBIZ_UNISENDER_WEBHOOK_AUTH="a".repeat(48);
    const service=new AuthMailWebhookService({} as any);
    await expect(service.accept({
      auth:"b".repeat(48),events_by_user:[]
    })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

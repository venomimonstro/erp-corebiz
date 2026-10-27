import { BadRequestException } from "@nestjs/common";
import { EmailVerificationService } from "./email-verification.service";

const userId = "11111111-1111-4111-8111-111111111111";

describe("commercial email verification", () => {
  it("never queues another delivery for an already verified email", async () => {
    const db = {
      query:jest.fn(async () => ({
        rows:[{email_verified_at:new Date()}]
      }))
    };
    const service=new EmailVerificationService(db as any);
    await expect(service.request(userId)).resolves.toEqual({
      queued:false,verified:true
    });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("queues one verification delivery through the database outbox", async () => {
    const db = {
      query:jest.fn(async (sql:string) => {
        if(sql.includes("SELECT email_verified_at")) {
          return {rows:[{email_verified_at:null}]};
        }
        if(sql.includes("corebiz_enqueue_auth_mail")) {
          return {rows:[{queued:true}]};
        }
        return {rows:[]};
      })
    };
    const service=new EmailVerificationService(db as any);
    await expect(service.request(userId)).resolves.toEqual({
      queued:true,verified:false
    });
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining("corebiz_enqueue_auth_mail"),
      [userId]
    );
  });

  it("reports a coalesced duplicate without creating another mail", async () => {
    const db = {
      query:jest.fn(async (sql:string) => sql.includes("SELECT email_verified_at")
        ? {rows:[{email_verified_at:null}]}
        : {rows:[{queued:false}]})
    };
    const service=new EmailVerificationService(db as any);
    await expect(service.request(userId)).resolves.toEqual({
      queued:false,verified:false
    });
  });

  it("consumes a valid link and marks the account verified", async () => {
    const token="A".repeat(43);
    const statements:string[]=[];
    const db={
      withTransaction:jest.fn(async (fn:any)=>fn({
        query:jest.fn(async (sql:string)=>{
          statements.push(sql);
          if(sql.startsWith("SELECT t.user_id")) {
            return {rows:[{user_id:userId}]};
          }
          if(sql.startsWith("SELECT id FROM app_user")) {
            return {rows:[{id:userId}]};
          }
          return {rows:[],rowCount:1};
        })
      }))
    };
    const service=new EmailVerificationService(db as any);
    await expect(service.complete(token)).resolves.toEqual({verified:true});
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements[2]).toContain("FOR UPDATE OF t");
    expect(statements.some(s=>s.includes("email_verified_at=COALESCE"))).toBe(true);
    expect(statements.some(s=>s.includes("consumed_at=now()"))).toBe(true);
  });

  it("rejects malformed or replayed verification links", async () => {
    const db={
      withTransaction:jest.fn(async (fn:any)=>fn({
        query:jest.fn(async()=>({rows:[]}))
      }))
    };
    const service=new EmailVerificationService(db as any);
    await expect(service.complete("short")).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(db.withTransaction).not.toHaveBeenCalled();
    await expect(service.complete("A".repeat(43))).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

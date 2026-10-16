import { BadRequestException } from "@nestjs/common";
import { EmailVerificationService } from "./email-verification.service";
import { hashToken } from "./auth.utils";

const userId = "11111111-1111-4111-8111-111111111111";

describe("commercial email verification", () => {
  it("never reissues a token for an already verified email", async () => {
    const mail = {sendVerification: jest.fn()};
    const client = {query: jest.fn(async () => ({
      rows: [{id:userId,email:"owner@example.com",email_verified_at:new Date()}]
    }))};
    const db = {
      withTransaction: jest.fn(async (fn: any) => fn(client))
    };
    const service = new EmailVerificationService(db as any,mail as any);
    await expect(service.request(userId)).resolves.toEqual({
      sent:false,verified:true
    });
    expect(mail.sendVerification).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("persists a hash, never the raw token, and sends a 24-hour link", async () => {
    const statements: Array<{sql:string;params:unknown[]}> = [];
    const client = {query: jest.fn(async (sql:string,params:unknown[]=[]) => {
      statements.push({sql,params});
      if (sql.startsWith("SELECT id,email")) {
        return {rows:[{id:userId,email:"owner@example.com",email_verified_at:null}]};
      }
      return {rows:[],rowCount:1};
    })};
    const db = {withTransaction: jest.fn(async (fn:any) => fn(client))};
    const mail = {
      sendVerification: jest.fn(async (_email:string,_token:string) => undefined)
    };
    const service = new EmailVerificationService(db as any,mail as any);
    await expect(service.request(userId)).resolves.toEqual({
      sent:true,verified:false
    });
    const token=mail.sendVerification.mock.calls[0]?.[1];
    const persisted=statements.find(x=>x.sql.includes("INSERT INTO email_verification_token"));
    expect(typeof token).toBe("string");
    expect(persisted?.sql).toContain("interval '24 hours'");
    expect(persisted?.params[1]).toBe(hashToken(token as string));
    expect(persisted?.params[1]).not.toBe(token);
    expect(statements[0].sql).toContain("FOR UPDATE");
  });

  it("invalidates a token when its delivery fails", async () => {
    const client={query:jest.fn(async (sql:string) =>
      sql.startsWith("SELECT") ? {
        rows:[{id:userId,email:"owner@example.com",email_verified_at:null}]
      } : {rows:[]}
    )};
    const db={
      withTransaction:jest.fn(async (fn:any)=>fn(client)),
      query:jest.fn(async()=>({rows:[],rowCount:1}))
    };
    const mail={sendVerification:jest.fn(async()=>{throw new Error("provider down");})};
    const service=new EmailVerificationService(db as any,mail as any);
    await expect(service.request(userId)).rejects.toThrow("provider down");
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE email_verification_token SET consumed_at=now()"),
      [expect.stringMatching(/^[0-9a-f]{64}$/)]
    );
  });

  it("consumes a valid link and marks the account verified", async () => {
    const token="A".repeat(43);
    const statements:string[]=[];
    const db={
      withTransaction:jest.fn(async (fn:any)=>fn({
        query:jest.fn(async (sql:string)=>{
          statements.push(sql);
          if (sql.startsWith("SELECT t.user_id")) {
            return {rows:[{user_id:userId}]};
          }
          if (sql.startsWith("SELECT id FROM app_user")) {
            return {rows:[{id:userId}]};
          }
          return {rows:[],rowCount:1};
        })
      }))
    };
    const service=new EmailVerificationService(db as any,{} as any);
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
    const service=new EmailVerificationService(db as any,{} as any);
    await expect(service.complete("short")).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(db.withTransaction).not.toHaveBeenCalled();
    await expect(service.complete("A".repeat(43))).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

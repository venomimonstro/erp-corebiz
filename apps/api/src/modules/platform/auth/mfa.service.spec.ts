import { ForbiddenException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { MfaService } from "./mfa.service";

const auth={
  userId:"11111111-1111-4111-8111-111111111111",
  sessionId:"22222222-2222-4222-8222-222222222222",
  tenantId:"33333333-3333-4333-8333-333333333333",
  membershipId:"44444444-4444-4444-8444-444444444444",
  email:"owner@example.test"
};

describe("privileged TOTP MFA",()=>{
  const previous=process.env.COREBIZ_MFA_ENCRYPTION_KEY;

  beforeEach(()=>{
    process.env.COREBIZ_MFA_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  });
  afterAll(()=>{
    if(previous===undefined)delete process.env.COREBIZ_MFA_ENCRYPTION_KEY;
    else process.env.COREBIZ_MFA_ENCRYPTION_KEY=previous;
  });

  it("encrypts the TOTP secret and persists only hashed recovery codes",async()=>{
    let ciphertext="";
    let enabledHashes:string[]=[];
    const db={
      query:jest.fn(async(sql:string,values:unknown[] = [])=>{
        if(sql.includes("corebiz_auth_mfa_state")){
          return {rows:[{
            required:true,enabled:false,verified:false,
            recovery_codes_remaining:0
          }]};
        }
        if(sql.includes("corebiz_auth_mfa_begin")){
          ciphertext=String(values[1]);
          return {rows:[{started:true}]};
        }
        if(sql.includes("corebiz_auth_mfa_secret")){
          return {rows:[{status:"PENDING",secret_ciphertext:ciphertext}]};
        }
        if(sql.includes("corebiz_auth_mfa_enable")){
          enabledHashes=values[4] as string[];
          return {rows:[{enabled:true}]};
        }
        throw new Error("unexpected query: "+sql);
      })
    };
    const service=new MfaService(db as any);
    const setup=await service.begin(auth);

    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUri).toContain("otpauth://totp/");
    expect(ciphertext).toMatch(/^v1\./);
    expect(ciphertext).not.toContain(setup.secret);

    const counter=Math.floor(Date.now()/30_000);
    const code=(service as any).totp(setup.secret,counter) as string;
    const result=await service.confirm(auth,code);

    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
    expect(enabledHashes).toHaveLength(10);
    expect(enabledHashes.every(value=>/^[0-9a-f]{64}$/.test(value))).toBe(true);
    for(const plain of result.recoveryCodes){
      expect(enabledHashes).not.toContain(plain);
    }
  });

  it("uses a recovery code only through the atomic consume function",async()=>{
    const db={
      query:jest.fn(async(sql:string,values:unknown[])=>{
        if(sql.includes("corebiz_auth_mfa_consume_recovery")){
          expect(values[1]).toMatch(/^[0-9a-f]{64}$/);
          expect(values[1]).not.toBe("ABCD1234ABCD1234");
          return {rows:[{consumed:true}]};
        }
        throw new Error("unexpected query");
      })
    };
    const service=new MfaService(db as any);
    await expect(
      service.verifyLogin(auth.userId,"ABCD-1234-ABCD-1234")
    ).resolves.toBe(true);
  });

  it("does not allow privileged MFA disable when the DB gate refuses it",async()=>{
    const db={
      query:jest.fn(async(sql:string)=>{
        if(sql.includes("corebiz_auth_mfa_secret")){
          // Generate a valid active secret envelope without exposing it to DB.
          const helper=new MfaService({} as any);
          return {rows:[{
            status:"ACTIVE",
            secret_ciphertext:(helper as any).encrypt(
              "JBSWY3DPEHPK3PXP"
            )
          }]};
        }
        if(sql.includes("corebiz_auth_mfa_disable")){
          const error=Object.assign(new Error("required"),{code:"23514"});
          throw error;
        }
        throw new Error("unexpected query");
      })
    };
    const service=new MfaService(db as any);
    const counter=Math.floor(Date.now()/30_000);
    const code=(service as any).totp("JBSWY3DPEHPK3PXP",counter);
    await expect(service.disable(auth,code))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

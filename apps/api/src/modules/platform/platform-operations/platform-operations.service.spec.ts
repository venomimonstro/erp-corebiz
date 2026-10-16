import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { PlatformOperationsService } from "./platform-operations.service";

const id = "11111111-1111-4111-8111-111111111111";
const token = "long-secret-session-token";

describe("platform operator read-only access", () => {
  it("blocks anonymous operator dashboard", async () => {
    const db = { query: jest.fn() };
    const service = new PlatformOperationsService(db as any);
    await expect(service.tenants(id, undefined, 25, 0))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not pass raw session token to SQL", async () => {
    const db = {
      query: jest.fn(async (_sql: string, _values: unknown[]) => ({
        rows: [{overview:{total:0,items:[]}}]
      }))
    };
    const service = new PlatformOperationsService(db as any);
    const result = await service.tenants(id, token, 25, 0);
    expect(result).toEqual({total:0,items:[]});
    const params = db.query.mock.calls[0]?.[1] as unknown[];
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[1]).not.toBe(token);
  });

  it("checks the operator's session for suspension history", async () => {
    const db={query:jest.fn()};
    const svc=new PlatformOperationsService(db as any);
    await expect(svc.suspensionHistory(id,undefined,id))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reads only the selected tenant's history through a trusted DB function", async () => {
    const db={query:jest.fn(async (_sql:string,_args:unknown[])=>({
      rows:[{history:[]}]
    }))};
    const svc=new PlatformOperationsService(db as any);
    await expect(svc.suspensionHistory(id,token,id)).resolves.toEqual([]);
    const sql=db.query.mock.calls[0]![0] as string;
    const args=db.query.mock.calls[0]![1] as unknown[];
    expect(sql).toContain("corebiz_platform_suspension_history");
    expect(args[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(args[2]).toBe(id);
  });

  it("requires a valid session for aggregate platform metrics", async () => {
    const db={query:jest.fn()};
    const svc=new PlatformOperationsService(db as any);
    await expect(svc.summary(id,undefined)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it("obtains business-wide statistics only via operator-gated SQL", async () => {
    const db={query:jest.fn(async (_sql:string,_params:unknown[])=>({
      rows:[{overview:{
        tenants:3,operating:2,suspended:1,paidActive:1
      }}]
    }))};
    const svc=new PlatformOperationsService(db as any);
    const data=await svc.summary(id,token);
    expect(data.tenants).toBe(3);
    const params=db.query.mock.calls[0]![1] as unknown[];
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[1]).not.toBe(token);
  });

  it("rejects untrusted actions before reaching SQL", async () => {
    const db={query:jest.fn()};
    const svc=new PlatformOperationsService(db as any);
    await expect(svc.setSuspension(id,undefined,id,"SUSPEND","A proper justification"))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setSuspension(id,token,id,"SUSPEND","too short"))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setSuspension(id,token,"bad-id","RESUME","A proper justification"))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("hashes operator session rather than sending raw cookie to SQL", async () => {
    const tenantId="22222222-2222-4222-8222-222222222222";
    const db={query:jest.fn(async (_sql:string,_params:unknown[])=>({
      rows:[{outcome:{tenantId,status:"SUSPENDED",suspensionId:id}}]
    }))};
    const svc=new PlatformOperationsService(db as any);
    await expect(svc.setSuspension(
      id,token,tenantId,"SUSPEND","Repeated abuse investigation"
    )).resolves.toMatchObject({status:"SUSPENDED"});
    const args=db.query.mock.calls[0]![1] as unknown[];
    expect(args[0]).toBe(id);
    expect(args[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(args[1]).not.toBe(token);
    expect(args[2]).toBe(tenantId);
    expect(args[3]).toBe("SUSPEND");
  });

  it("does not allow suspension when state conflicts", async () => {
    const db={query:jest.fn(async ()=>{
      throw Object.assign(new Error("state conflict"),{code:"23514"});
    })};
    const svc=new PlatformOperationsService(db as any);
    await expect(svc.setSuspension(
      id,token,id,"SUSPEND","Potential fraudulent operation"
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it("denies explicit DB permission errors", async () => {
    const db = {
      query: jest.fn(async () => {
        throw Object.assign(new Error("PLATFORM_OPERATOR_FORBIDDEN"), {
          code: "42501"
        });
      })
    };
    const service = new PlatformOperationsService(db as any);
    await expect(service.tenants(id, token, 25, 0))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

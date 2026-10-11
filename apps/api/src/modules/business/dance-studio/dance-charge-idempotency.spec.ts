import {BadRequestException,ConflictException} from "@nestjs/common";
import {DanceEconomicsService} from "./dance-economics.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const input={
  studentId:"44444444-4444-4444-8444-444444444444",
  payerPartyId:"55555555-5555-4555-8555-555555555555",
  sourceType:"OTHER" as const,sourceId:null,
  amountMinor:"50000",dueAt:null,note:"Пробное посещение",
  requestKey:"66666666-6666-4666-8666-666666666666"
};

describe("dance financial write idempotency",()=>{
  function setup(query:(sql:string)=>Promise<any>){
    const client={query:jest.fn(query)};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const auth={
      resolveScope:jest.fn(async()=> "all"),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    const service=new DanceEconomicsService(db as any,auth as any,{} as any);
    return {service,client,db};
  }
  const previous={
    id:"charge-1",student_id:input.studentId,payer_party_id:input.payerPartyId,
    source_type:input.sourceType,source_id:null,amount_minor:input.amountMinor,
    due_at:null,obligation_id:"obligation-1",invoice_id:"invoice-1",
    status:"OPEN"
  };

  it("retries return the original charge without inserting another invoice",async()=>{
    const {service,client}=setup(async sql=>{
      if(sql.includes("FROM dance_student_charge")&&sql.includes("request_key"))
        return {rows:[previous]};
      throw new Error("Unexpected SQL write: "+sql.slice(0,100));
    });
    const result=await (service as any).createChargeTx(client,context,input);
    expect(result.reused).toBe(true);
    expect(result.id).toBe("charge-1");
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("same request key cannot be reused for a different sum",async()=>{
    const {service,client}=setup(async sql=>{
      if(sql.includes("request_key"))return {rows:[previous]};
      throw new Error("Unexpected query");
    });
    await expect((service as any).createChargeTx(client,context,{
      ...input,amountMinor:"150000"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("concurrent insertion conflict reads the winner instead of making more charges",async()=>{
    const {service,client}=setup(async sql=>{
      if(sql.includes("SELECT id,student_id")&&sql.includes("FOR UPDATE"))
        return {rows:[]};
      if(sql.includes("INSERT INTO dance_student_charge"))return {rows:[]};
      if(sql.includes("FROM dance_student_charge WHERE tenant_id=$1 AND request_key"))
        return {rows:[previous]};
      throw new Error("Unexpected SQL: "+sql.slice(0,100));
    });
    const result=await (service as any).createChargeTx(client,context,input);
    expect(result.reused).toBe(true);
    expect(client.query.mock.calls.filter(c=>String(c[0]).includes("INSERT INTO financial_obligation")))
      .toHaveLength(0);
  });

  it("manual operators cannot issue a synthetic package or lesson invoice",async()=>{
    const {service,db}=setup(async()=>({rows:[]}));
    await expect(service.createCharge(context,input.studentId,{
      amountMinor:"50000",sourceType:"PACKAGE"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
});

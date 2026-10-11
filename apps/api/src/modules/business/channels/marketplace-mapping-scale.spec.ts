import {BadRequestException} from "@nestjs/common";
import {MarketplaceHubService} from "./marketplace-hub.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const connectionId="44444444-4444-4444-8444-444444444444";
function harness(){
  const query=jest.fn(async(sql:string,_args:unknown[])=>({
    rows:[{id:"mapping-1",sku:"SKU-100",external_offer_id:"OZ-100"}]
  }));
  const database={withTenantTransaction:jest.fn(async(_context:unknown,fn:any)=>
    fn({query}))};
  return {service:new MarketplaceHubService(database as any),query,database};
}

describe("ecommerce mapping lookup at million-SKU scale",()=>{
  it("queries only this tenant and connection with bounded result count",async()=>{
    const {service,query}=harness();
    const result=await service.searchMappings(ctx,{
      connectionId,query:"SKU-100",limit:50
    });
    expect(result).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql,params]=query.mock.calls[0];
    expect(sql).toContain("m.tenant_id=$1 AND m.connection_id=$2");
    expect(sql).toContain("LIMIT $4");
    expect(sql).not.toContain("OFFSET");
    expect(params).toEqual([ctx.tenantId,connectionId,"SKU-100",50]);
  });
  it("escapes wildcard characters and keeps query values out of SQL",async()=>{
    const {service,query}=harness();
    const search="ab_%\\cd";
    await service.searchMappings(ctx,{connectionId,query:search});
    const [sql,params]=query.mock.calls[0];
    expect(sql).not.toContain(search);
    expect(params[2]).toContain("\\_");
    expect(params[2]).toContain("\\%");
  });
  it.each([
    [{connectionId:"not-a-uuid"},"подключение"],
    [{connectionId,query:"ab"},"минимум"],
    [{connectionId,query:"a".repeat(101)},"минимум"],
    [{connectionId,limit:1000000},"Размер"]
  ])("rejects abusive or invalid mapping requests before opening DB",async(input,message)=>{
    const {service,database}=harness();
    await expect(service.searchMappings(ctx,input)).rejects.toThrow(message);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});

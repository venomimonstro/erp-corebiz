import {BadRequestException} from "@nestjs/common";
import {RussianPostService} from "./russian-post.service";
import {openMerchantSecret} from "../payments/yookassa.gateway";
const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const site="44444444-4444-4444-8444-444444444444";
const credentials={
  accessToken:"exampleAccessToken12345678",
  userAuthorizationKey:"dXNlcm5hbWU6cGFzc3dvcmQ=",
  fromPostcode:"010000"
};
function setup(scope="all"){
  const seen:Array<{sql:string;params:unknown[]}>=[];
  const client={
    query:jest.fn(async(sql:string,params:unknown[]=[])=>{
      seen.push({sql,params});
      if(sql.includes("SELECT 1 FROM site"))
        return {rows:[{"?column?":1}],rowCount:1};
      if(sql.includes("INSERT INTO commerce_provider_connection"))
        return {rows:[{id:"55555555-5555-4555-8555-555555555555"}],rowCount:1};
      return {rows:[],rowCount:0};
    })
  };
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
  const auth={resolveScope:jest.fn().mockResolvedValue(scope)};
  return {service:new RussianPostService(db as any,auth as any),seen};
}
describe("Russian Post merchant connection security",()=>{
  const old=process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
  beforeAll(()=>{process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY="e".repeat(64);});
  afterAll(()=>{
    if(old===undefined)delete process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
    else process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY=old;
  });
  it("does not permit a branch-scoped employee to configure carrier credentials",async()=>{
    const x=setup("branch");
    await expect(x.service.configure(ctx,site,credentials))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(x.seen).toHaveLength(0);
  });
  it("rejects invalid postal indexes before DB and provider work",async()=>{
    const x=setup();
    await expect(x.service.configure(ctx,site,{
      ...credentials,fromPostcode:"not-an-index"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(x.seen).toHaveLength(0);
  });
  it("stores only encrypted merchant credentials and public sender postcode",async()=>{
    const x=setup();
    const result=await x.service.configure(ctx,site,credentials);
    expect(result.state).toBe("CONFIGURED_UNVERIFIED");
    const insert=x.seen.find(q=>q.sql.includes("INSERT INTO commerce_provider_connection"));
    expect(insert).toBeDefined();
    const encrypted=String(insert?.params[2]);
    expect(encrypted).not.toContain(credentials.accessToken);
    expect(JSON.parse(openMerchantSecret(encrypted))).toMatchObject({
      accessToken:credentials.accessToken,
      userAuthorizationKey:credentials.userAuthorizationKey
    });
    expect(JSON.parse(String(insert?.params[3]))).toEqual({
      fromPostcode:"010000"
    });
  });
});

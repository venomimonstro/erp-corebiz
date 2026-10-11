import {BadRequestException,ConflictException} from "@nestjs/common";
import {RetailNetworkService} from "./retail-network.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const location="44444444-4444-4444-8444-444444444444";
const sku="55555555-5555-4555-8555-555555555555";
const warehouse="66666666-6666-4666-8666-666666666666";
describe("electronics serial number, IMEI and DataMatrix privacy",()=>{
  const oldKey=process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
  beforeAll(()=>{process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY="a".repeat(64);});
  afterAll(()=>{
    if(oldKey===undefined)delete process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
    else process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY=oldKey;
  });
  function setup(physical="1000",registered="0"){
    const values:unknown[][]=[];
    const query=jest.fn(async(sql:string,args?:unknown[])=>{
      if(args)values.push(args);
      if(sql.includes("SELECT warehouse_id FROM retail_location"))return {
        rows:[{warehouse_id:warehouse}],rowCount:1
      };
      if(sql.includes("SELECT physical_milli::text FROM inventory_balance"))return{
        rows:[{physical_milli:physical}],rowCount:1
      };
      if(sql.includes("SELECT count(*)::text AS count FROM retail_serial_unit"))return{
        rows:[{count:registered}],rowCount:1
      };
      if(sql.includes("INSERT INTO retail_serial_unit("))return{
        rows:[{id:"77777777-7777-4777-8777-777777777777",serial_number:"SER-01"}],
        rowCount:1
      };
      return {rows:[],rowCount:0};
    });
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
    const auth={resolveScope:jest.fn().mockResolvedValue("all")};
    return {service:new RetailNetworkService(db as any,auth as any,{} as any),query,values};
  }
  it("rejects invalid IMEI without any database writes",async()=>{
    const a=setup();
    await expect(a.service.registerSerialized(ctx,location,{
      skuId:sku,serialNumber:"SER-01",imei:"123456789012345"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(a.query).not.toHaveBeenCalled();
  });
  it("does not register more serial units than physical warehouse stock",async()=>{
    const a=setup("1000","1");
    await expect(a.service.registerSerialized(ctx,location,{
      skuId:sku,serialNumber:"SER-02"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(a.query.mock.calls.some(call=>String(call[0]).includes("INSERT INTO retail_serial_unit")))
      .toBe(false);
  });
  it("never returns or writes unencrypted DataMatrix payload",async()=>{
    const a=setup();
    const markingCode="010460012345678921ABCDEFGHIJKLMN";
    const result=await a.service.registerSerialized(ctx,location,{
      skuId:sku,serialNumber:"SER-01",
      imei:"490154203237518",gtin:"04600123456789",
      markingProductGroup:"ELECTRONICS",markingCode
    });
    expect(result.markingCodePresent).toBe(true);
    expect(result.markingState).toBe("NOT_CHECKED");
    expect(JSON.stringify(result)).not.toContain(markingCode);
    const insert=a.values.find(v=>v.length===11);
    expect(insert).toBeDefined();
    expect(insert?.[9]).toEqual(expect.stringMatching(/^v1:/));
    expect(JSON.stringify(insert)).not.toContain(markingCode);
  });
});

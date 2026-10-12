import {BookingService} from "./booking.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const sample={
  id:"44444444-4444-4444-8444-444444444444",
  status:"CONFIRMED",business_number:"B-123",party_name:"Client",
  service_name:"Haircut",resources:[],
  price_minor_snapshot:"140000",currency:"RUB",
  settled_minor:"55000",billing_status:"PARTIAL",
  obligation_status:"OPEN",invoice_status:"ISSUED",
  billing:{amountMinor:"140000",settledMinor:"55000",status:"OPEN"},
  refund:{status:"PENDING",amountMinor:"30000"}
};

function fixture(withFinance:boolean){
  const db={
    withTenantTransaction:jest.fn(async(_ctx:unknown,callback:any)=>
      callback({query:jest.fn(async()=>({rows:[sample],rowCount:1}))}))
  };
  const auth={
    resolveScope:jest.fn(async(_ctx:unknown,code:string)=>{
      if(code==="service.read")return "all";
      if(code==="finance.read"&&withFinance)return "all";
      return null;
    }),
    membershipIdsForScope:jest.fn(async()=>null)
  };
  return new BookingService(db as any,{} as any,{} as any,
    auth as any,{} as any,{} as any);
}

describe("service booking list/detail role-based finance isolation",()=>{
  it("service-only employee sees a visit without payment or invoice data",async()=>{
    const booking=fixture(false);
    const rows=await booking.bookings(ctx);
    const detail=await booking.bookingDetails(ctx,sample.id);
    for(const row of [rows[0],detail]){
      expect(row).toMatchObject({
        id:sample.id,status:"CONFIRMED",service_name:"Haircut",
        price_minor_snapshot:null,currency:null,billing_status:null,
        obligation_status:null,invoice_status:null,settled_minor:null,
        billing:null,refund:null
      });
      expect(JSON.stringify(row)).not.toContain("55000");
      expect(JSON.stringify(row)).not.toContain("140000");
      expect(JSON.stringify(row)).not.toContain("PENDING");
    }
  });
  it("owner with finance.read can see real settlement and invoice",async()=>{
    const booking=fixture(true);
    const rows=await booking.bookings(ctx);
    const detail=await booking.bookingDetails(ctx,sample.id);
    expect(rows[0].price_minor_snapshot).toBe("140000");
    expect(rows[0].billing_status).toBe("PARTIAL");
    expect(detail.billing).toEqual(sample.billing);
    expect(detail.refund).toEqual(sample.refund);
  });
});

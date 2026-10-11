import {NotFoundException} from "@nestjs/common";
import {SalesService} from "./sales.service";
import {InventoryService} from "../inventory/inventory.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const allowed=[context.membershipId];

describe("sales responsibility scope survives delegation to inventory",()=>{
  it("passes employee scope into warehouse reservation",async()=>{
    const service=Object.create(SalesService.prototype) as any;
    service.authorization={
      resolveScope:jest.fn().mockResolvedValue("own"),
      membershipIdsForScope:jest.fn().mockResolvedValue(allowed)
    };
    service.inventory={reserveOrder:jest.fn().mockResolvedValue({orderId:"order"})};
    await service.reserve(context,"order","reservation-once","warehouse");
    expect(service.inventory.reserveOrder).toHaveBeenCalledWith(context,{
      orderId:"order",warehouseId:"warehouse",idempotencyKey:"reservation-once",
      allowedMembershipIds:allowed
    });
  });
  it("passes employee scope into warehouse shipment",async()=>{
    const service=Object.create(SalesService.prototype) as any;
    service.authorization={
      resolveScope:jest.fn().mockResolvedValue("own"),
      membershipIdsForScope:jest.fn().mockResolvedValue(allowed)
    };
    service.inventory={shipOrder:jest.fn().mockResolvedValue({orderId:"order"})};
    await service.ship(context,"order","shipment-once");
    expect(service.inventory.shipOrder).toHaveBeenCalledWith(context,{
      orderId:"order",idempotencyKey:"shipment-once",
      allowedMembershipIds:allowed
    });
  });
  it.each(["reserveOrder","shipOrder"])(
    "%s rejects orders outside permitted employees before any stock movement",
    async(method)=>{
      const queries:Array<{sql:string;params:unknown[]}>= [];
      const service=Object.create(InventoryService.prototype) as any;
      service.database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({
        query:jest.fn(async(sql:string,params:unknown[])=>{
          queries.push({sql,params});
          return {rows:[],rowCount:0};
        })
      }))};
      await expect(service[method](context,{
        orderId:"44444444-4444-4444-8444-444444444444",
        idempotencyKey:"test-action-01",allowedMembershipIds:allowed
      })).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("responsible_membership_id");
      expect(queries[0].params).toContainEqual(allowed);
    }
  );
});

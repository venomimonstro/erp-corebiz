import test from "node:test";
import assert from "node:assert/strict";
import {readEntity} from "./tenant-export.js";

const tenant="11111111-1111-4111-8111-111111111111";
const entity={table:"inventory_balance",label:"inventory_balances"};

test("million-SKU inventory export seeks composite PK and never uses OFFSET",async()=>{
  const calls:Array<{sql:string;params:unknown[]}>=[],
    rows=Array.from({length:5001},(_,i)=>({
      tenant_id:tenant,
      warehouse_id:"22222222-2222-4222-8222-222222222222",
      sku_id:"33333333-3333-4333-8333-"+String(i).padStart(12,"0"),
      physical_milli:1000
    }));
  const client={
    query:async(sql:string,params:unknown[]=[])=>{
      calls.push({sql,params});
      if(sql.includes("to_regclass("))return {rows:[{exists:true}]};
      if(sql.includes("information_schema.columns"))
        return {rows:[{exists:sql.includes("column_name='tenant_id'")}]};
      if(sql.includes("SELECT * FROM"))return {
        rows:params.length===2?rows.slice(0,5000):rows.slice(5000)
      };
      throw new Error("Unexpected query: "+sql);
    }
  };
  const output:Array<Record<string,unknown>>=[];
  for await(const page of readEntity(client as any,tenant,entity))
    output.push(...page);
  assert.equal(output.length,5001);
  const dataQueries=calls.filter(call=>call.sql.includes("SELECT * FROM"));
  assert.equal(dataQueries.length,2);
  assert.ok(dataQueries.every(call=>call.sql.includes("tenant_id=$1")));
  assert.ok(dataQueries.every(call=>!call.sql.includes("OFFSET")));
  assert.ok(dataQueries[1].sql.includes('"warehouse_id","sku_id")>('));
  assert.deepEqual(dataQueries[1].params.slice(2),[
    rows[4999].warehouse_id,rows[4999].sku_id
  ]);
  assert.ok(output.every(item=>item.tenant_id===tenant));
});

test("SKU export uses stable id cursor and doesn't fetch every prior page",async()=>{
  const calls:string[]=[];
  let n=0;
  const client={query:async(sql:string,_params:unknown[]=[])=>{
    calls.push(sql);
    if(sql.includes("to_regclass"))return {rows:[{exists:true}]};
    if(sql.includes("information_schema"))return {rows:[{exists:true}]};
    if(sql.includes("SELECT * FROM")){
      n++;
      return {rows:[{tenant_id:tenant,id:"44444444-4444-4444-8444-444444444444"}]};
    }
    throw new Error(sql);
  }};
  let total=0;
  for await(const rows of readEntity(client as any,tenant,{table:"sku",label:"skus"}))
    total+=rows.length;
  assert.equal(total,1);
  assert.equal(n,1);
  assert.ok(calls.find(q=>q.includes("SELECT * FROM"))?.includes("ORDER BY \"id\" LIMIT $2"));
});

#!/usr/bin/env node
/**
 * Read-only, staged 1M-SKU keyset benchmark. Never seed a real database.
 *
 * COREBIZ_CONFIRM_DISPOSABLE_DB=YES \
 * COREBIZ_BENCHMARK_DATABASE_URL='postgresql://.../isolated_staging' \
 * COREBIZ_BENCHMARK_TENANT_ID='<uuid>' \
 * node apps/api/scripts/catalog-million-sku-readonly-gate.mjs
 *
 * Run a separate 1000-session HTTP test via scripts/load-1000-sessions.mjs.
 * These are independent acceptance gates and do not prove 1000 users by
 * themselves.
 */
import assert from "node:assert/strict";
import {Pool} from "pg";
import {performance} from "node:perf_hooks";

if(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB!=="YES")
  throw new Error("DISPOSABLE_STAGING_CONFIRMATION_REQUIRED");
if(process.env.NODE_ENV==="production")
  throw new Error("PRODUCTION_BENCHMARK_FORBIDDEN");

const url=process.env.COREBIZ_BENCHMARK_DATABASE_URL;
const tenantId=process.env.COREBIZ_BENCHMARK_TENANT_ID;
if(!url||!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(tenantId??""))
  throw new Error("STAGING_DATABASE_URL_AND_TENANT_REQUIRED");
if(new URL(url).pathname.toLowerCase().includes("/postgres"))
  throw new Error("DEFAULT_POSTGRES_DB_NOT_ALLOWED");
const samples=[];
const pool=new Pool({
  connectionString:url,max:1,connectionTimeoutMillis:3000,
  statement_timeout:15000,application_name:"corebiz-catalog-million-sku-gate"
});
const client=await pool.connect();
let committed=false;
try{
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  const count=await client.query(`SELECT count(*)::bigint AS total
    FROM sku WHERE tenant_id=$1 AND status='ACTIVE'`,[tenantId]);
  const total=Number(count.rows[0]?.total??"0");
  assert.ok(Number.isSafeInteger(total),"Unsafe SKU count");
  if(total<1000000)throw new Error("BENCHMARK_TENANT_HAS_FEWER_THAN_1M_ACTIVE_SKU");

  let cursor=null;
  let checks=0;
  for(let i=0;i<120;i++){
    const started=performance.now();
    const result=await client.query(`SELECT s.id,p.name,s.code,s.sale_price_minor::text
      FROM sku s
      JOIN product_variant v
        ON v.tenant_id=s.tenant_id AND v.id=s.variant_id
      JOIN product p
        ON p.tenant_id=v.tenant_id AND p.id=v.product_id
      WHERE s.tenant_id=$1
        AND s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
        AND ($2::uuid IS NULL OR s.id>$2::uuid)
      ORDER BY s.id LIMIT 101`,[tenantId,cursor]);
    samples.push(performance.now()-started);
    const rows=result.rows;
    if(rows.length===0)throw new Error("UNEXPECTED_EMPTY_KEYSET_PAGE");
    checks+=rows.length;
    const next=rows[Math.min(99,rows.length-1)].id;
    if(cursor!==null&&!(next>cursor))throw new Error("KEYSET_CURSOR_NOT_ADVANCING");
    cursor=next;
  }

  const ordered=samples.slice().sort((a,b)=>a-b);
  const at=q=>ordered[Math.ceil(ordered.length*q)-1];
  const statistics={
    activeSku:total, pages:samples.length, scannedRows:checks,
    p50Ms:Number(at(.5).toFixed(1)),
    p95Ms:Number(at(.95).toFixed(1)),
    p99Ms:Number(at(.99).toFixed(1)),
    maxMs:Number(ordered.at(-1).toFixed(1)),
    p95TargetMs:250,
    passed:at(.95)<=250
  };
  process.stdout.write(JSON.stringify(statistics,null,2)+"\n");
  await client.query("ROLLBACK");
  committed=true;
  if(!statistics.passed)process.exitCode=1;
}catch(error){
  process.stderr.write("CATALOG_BENCHMARK_FAILED: "+
    (error instanceof Error?error.message:"unknown error")+"\n");
  process.exitCode=1;
}finally{
  if(!committed)try{await client.query("ROLLBACK");}catch{}
  client.release();
  await pool.end();
}

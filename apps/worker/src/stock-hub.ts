import {createDecipheriv,createHash} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {availableUnits,distributeUnits,conservativeTarget,type MarketListing} from "./stock-allocation.js";

type PoolKey={tenant_id:string;warehouse_id:string;sku_id:string};
type ListingRow={
  id:string;connection_id:string;provider:string;
  priority:number;enabled:boolean;publish_enabled:boolean;
  external_warehouse_id:string|null;external_stock_id:string|null;
  published_units:number|null;target_units:number|null;status:string|null;
  credentials_ready:boolean;mapping_active:boolean;connection_status:string;
  fresh_order_feed:boolean;
};
type PublishJob={
  tenant_id:string;listing_id:string;connection_id:string;provider:string;
  external_offer_id:string;external_stock_id:string|null;
  external_warehouse_id:string;target_units:number;generation:string;
  credentials_ciphertext:string;config:Record<string,unknown>;
};

function credentials(ciphertext:string):Record<string,unknown>{
  const [version,iv,tag,body]=ciphertext.split(".");
  if(!["v1","v2"].includes(version)||!iv||!tag||!body)
    throw new Error("CHANNEL_CREDENTIAL_FORMAT");
  const secret=version==="v2"
    ?process.env.CHANNEL_ENCRYPTION_KEY?.trim()
    :process.env.SESSION_SECRET?.trim();
  if(!secret)throw new Error(version==="v2"
    ?"CHANNEL_ENCRYPTION_KEY_REQUIRED_FOR_V2"
    :"SESSION_SECRET_REQUIRED_FOR_LEGACY_CHANNEL_KEY");
  const key=createHash("sha256").update(secret+
    (version==="v2"?"|corebiz-channels-v2":"|corebiz-channels-v1")).digest();
  const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(body,"base64url")),decipher.final()
  ]).toString("utf8")) as Record<string,unknown>;
}

async function tenantTx<T>(pool:Pool,id:string,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id',$1,true)",[id]);
    const out=await fn(c);
    await c.query("COMMIT");
    return out;
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}

async function reconcile(pool:Pool,key:PoolKey):Promise<void>{
  await tenantTx(pool,key.tenant_id,async client=>{
    // Serialize all recalculations for one warehouse/SKU, without global locks.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
      [key.tenant_id+":"+key.warehouse_id,key.sku_id]);
    const rows=await client.query<ListingRow>(
      `SELECT l.id,l.connection_id,c.provider,l.priority,l.enabled,l.publish_enabled,
              l.external_warehouse_id,l.external_stock_id,
              t.published_units,t.target_units,t.status,
              (c.credentials_ciphertext IS NOT NULL) AS credentials_ready,
              (m.status='ACTIVE') AS mapping_active,c.status AS connection_status,
              (c.last_synced_at>now()-interval '10 minutes') AS fresh_order_feed
       FROM channel_stock_listing l JOIN channel_connection c
         ON c.tenant_id=l.tenant_id AND c.id=l.connection_id
       JOIN channel_product_mapping m ON m.tenant_id=l.tenant_id AND m.id=l.mapping_id
       LEFT JOIN channel_stock_target t ON t.tenant_id=l.tenant_id AND t.listing_id=l.id
       WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.sku_id=$3
       ORDER BY l.priority,l.id FOR UPDATE OF l`,
      [key.tenant_id,key.warehouse_id,key.sku_id]);
    if(!rows.rows.length)return;
    const [balance,policy,shadow,unknown,siteOrders]=await Promise.all([
      client.query<{physical:string;reserved:string}>(
        `SELECT coalesce(physical_milli,0)::text AS physical,
                coalesce(reserved_milli,0)::text AS reserved
         FROM inventory_balance WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3`,
        [key.tenant_id,key.warehouse_id,key.sku_id]),
      client.query<{safety:string;enabled:boolean}>(`SELECT safety_stock_milli::text AS safety,enabled
         FROM inventory_policy WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3`,
        [key.tenant_id,key.warehouse_id,key.sku_id]),
      client.query<{demand:string}>(`SELECT coalesce(sum(
        greatest(0, demand.quantity_milli-
          coalesce((SELECT sum(r.quantity_milli)
             FROM inventory_reservation r
             WHERE r.tenant_id=demand.tenant_id
               AND r.sales_order_id=demand.sales_order_id
               AND r.sku_id=$3 AND r.warehouse_id=$2 AND r.status='ACTIVE'),0))
      ),0)::text AS demand
      FROM (
        SELECT o.tenant_id,o.sales_order_id,o.connection_id,o.status,
          sum(li.quantity_milli)::bigint AS quantity_milli
        FROM channel_order_inbox o
        JOIN channel_order_line_inbox li ON li.tenant_id=o.tenant_id
           AND li.inbox_order_id=o.id
        WHERE li.tenant_id=$1 AND li.mapped_sku_id=$3
          AND (o.status IN ('RECEIVED','READY','NEEDS_MAPPING','IMPORTING','FAILED')
            OR (o.status='IMPORTED' AND NOT EXISTS(
              SELECT 1 FROM oms_order oo WHERE oo.tenant_id=o.tenant_id
                AND oo.sales_order_id=o.sales_order_id
                AND oo.state IN ('SHIPPED','CANCELLED'))))
          AND EXISTS(
            SELECT 1 FROM channel_stock_listing l WHERE l.tenant_id=li.tenant_id
              AND l.warehouse_id=$2 AND l.sku_id=$3 AND l.connection_id=o.connection_id)
        GROUP BY o.tenant_id,o.sales_order_id,o.connection_id,o.status,o.id
      ) demand`,
        [key.tenant_id,key.warehouse_id,key.sku_id]),
      client.query<{connection_id:string}>(`SELECT DISTINCT o.connection_id
         FROM channel_order_inbox o JOIN channel_order_line_inbox li
           ON li.tenant_id=o.tenant_id AND li.inbox_order_id=o.id
         WHERE o.tenant_id=$1 AND (o.status IN ('RECEIVED','READY','NEEDS_MAPPING','IMPORTING','FAILED')
              OR o.status='IMPORTED') AND li.mapped_sku_id IS NULL
           AND EXISTS(SELECT 1 FROM channel_stock_listing l
             WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.connection_id=o.connection_id)`,
        [key.tenant_id,key.warehouse_id]),
      client.query<{demand:string}>(`SELECT coalesce(sum(greatest(0,li.quantity_milli-
          coalesce((SELECT sum(r.quantity_milli) FROM inventory_reservation r
            WHERE r.tenant_id=li.tenant_id AND r.sales_order_id=o.id
              AND r.sales_order_line_id=li.id AND r.warehouse_id=$2
              AND r.status='ACTIVE'),0))),0)::text AS demand
        FROM sales_order_line li
        JOIN sales_order o ON o.tenant_id=li.tenant_id AND o.id=li.order_id
        WHERE li.tenant_id=$1 AND li.sku_id=$3
          AND (o.warehouse_id IS NULL OR o.warehouse_id=$2)
          AND o.order_status IN ('CONFIRMED','COMPLETED')
          AND o.fulfillment_status NOT IN ('SHIPPED','CANCELLED')
          AND NOT EXISTS(
            SELECT 1 FROM channel_order_inbox co
            WHERE co.tenant_id=o.tenant_id AND co.sales_order_id=o.id)`,
        [key.tenant_id,key.warehouse_id,key.sku_id])
    ]);
    const b=balance.rows[0];
    const stock=availableUnits(BigInt(b?.physical??"0"),BigInt(b?.reserved??"0"),
      BigInt(shadow.rows[0]?.demand??"0")+BigInt(siteOrders.rows[0]?.demand??"0"),
      policy.rows[0]?.enabled===false?BigInt(b?.physical??"0"):BigInt(policy.rows[0]?.safety??"0"));
    const blocked=new Set(unknown.rows.map(r=>r.connection_id));
    const ls:MarketListing[]=rows.rows.map(l=>({
      id:l.id,priority:l.priority,
      enabled:l.enabled&&l.mapping_active&&l.connection_status==="ACTIVE"&&
        l.credentials_ready&&l.fresh_order_feed&&!blocked.has(l.connection_id)&&
        (l.provider!=="WILDBERRIES"||Boolean(l.external_stock_id)),
      publishEnabled:l.publish_enabled,
      externalWarehouseId:l.external_warehouse_id,provider:l.provider
    }));
    const allocation=distributeUnits(stock,ls);
    // 0 -> publish 0 first if the marketplace has not yet been initialized.
    // Do not increase a channel while acknowledged quantities on other channels
    // already consume all physical ATP. Decreases go first; acks retrigger.
    const existingPublished=rows.rows.reduce((sum,r)=>sum+(r.published_units??0),0);
    const desired=rows.rows.map(l=>{
      const requested=allocation.get(l.id)??0;
      return {l,amount:conservativeTarget(requested,l.published_units,existingPublished,stock)};
    });
    for(const {l,amount} of desired){
      const canSend=Boolean(l.credentials_ready&&l.external_warehouse_id&&
        l.mapping_active&&l.connection_status!=="DISABLED"&&
        (l.provider!=="WILDBERRIES"||l.external_stock_id));
      const hasToDrain=l.published_units!==null&&l.published_units>0;
      const next=canSend&&(l.publish_enabled||hasToDrain)?"PENDING":"PAUSED";
      await client.query(
        `INSERT INTO channel_stock_target(
           tenant_id,listing_id,target_units,status,next_attempt_at
         ) VALUES($1,$2,$3,$4,now())
         ON CONFLICT(tenant_id,listing_id) DO UPDATE SET
           target_units=EXCLUDED.target_units,
           generation=CASE WHEN channel_stock_target.target_units<>EXCLUDED.target_units
             THEN channel_stock_target.generation+1 ELSE channel_stock_target.generation END,
           status=CASE
             WHEN channel_stock_target.status='SENDING' THEN 'SENDING'
             WHEN $4='PAUSED' THEN 'PAUSED'
             WHEN channel_stock_target.target_units<>EXCLUDED.target_units THEN 'PENDING'
             WHEN channel_stock_target.published_units IS DISTINCT FROM EXCLUDED.target_units
                AND channel_stock_target.status IN ('PAUSED','SYNCED','BLOCKED') THEN 'PENDING'
             ELSE channel_stock_target.status END,
           attempts=CASE WHEN channel_stock_target.target_units<>EXCLUDED.target_units
                THEN 0 ELSE channel_stock_target.attempts END,
           next_attempt_at=CASE WHEN channel_stock_target.target_units<>EXCLUDED.target_units
                AND EXCLUDED.target_units=0 THEN now()
                WHEN channel_stock_target.target_units<>EXCLUDED.target_units
                THEN greatest(now(),coalesce(channel_stock_target.next_attempt_at,now()))
                ELSE channel_stock_target.next_attempt_at END,
           updated_at=now()`,
        [key.tenant_id,l.id,amount,next]);
    }
    await client.query(`UPDATE channel_stock_listing SET updated_at=now()
      WHERE tenant_id=$1 AND warehouse_id=$2 AND sku_id=$3`,
      [key.tenant_id,key.warehouse_id,key.sku_id]);
  });
}

async function send(job:PublishJob):Promise<void>{
  const creds=credentials(job.credentials_ciphertext);
  const count=job.target_units;
  const warehouse=job.external_warehouse_id;
  if(!/^[1-9][0-9]*$/.test(warehouse)||!Number.isSafeInteger(Number(warehouse)))
    throw new Error("EXTERNAL_WAREHOUSE_ID_REQUIRED");
  let url:string;let options:RequestInit;let expected:number;
  if(job.provider==="OZON"){
    const clientId=String(creds.clientId??"");
    const key=String(creds.apiKey??"");
    if(!clientId||key.length<16)throw new Error("OZON_CREDENTIALS_INVALID");
    url="https://api-seller.ozon.ru/v2/products/stocks";
    options={method:"POST",headers:{"Client-Id":clientId,"Api-Key":key,
      "Content-Type":"application/json"},
      body:JSON.stringify({stocks:[{offer_id:job.external_offer_id,stock:count,
        warehouse_id:Number(warehouse)}]})};
    expected=200;
  }else if(job.provider==="WILDBERRIES"){
    const key=String(creds.apiToken??"");
    if(key.length<32)throw new Error("WB_CREDENTIALS_INVALID");
    if(!job.external_stock_id||!/^[1-9][0-9]*$/.test(job.external_stock_id)||
       !Number.isSafeInteger(Number(job.external_stock_id)))
      throw new Error("WB_CHRT_ID_REQUIRED");
    url="https://marketplace-api.wildberries.ru/api/v3/stocks/"+warehouse;
    options={method:"PUT",headers:{Authorization:key,"Content-Type":"application/json"},
      body:JSON.stringify({stocks:[{chrtId:Number(job.external_stock_id),amount:count}]})};
    expected=204;
  }else if(job.provider==="YANDEX_MARKET"){
    const key=String(creds.apiKey??"");
    const businessId=String(creds.businessId??"");
    if(key.length<16||!/^[1-9][0-9]*$/.test(businessId))
      throw new Error("YANDEX_CREDENTIALS_INVALID");
    url="https://api.partner.market.yandex.ru/v3/businesses/"+businessId+"/offers/stocks/update";
    options={method:"POST",headers:{"Api-Key":key,"Content-Type":"application/json"},
      body:JSON.stringify({skuItems:[{sku:job.external_offer_id,
        partnerWarehouseId:Number(warehouse),count,updatedAt:new Date().toISOString()}]})};
    expected=200;
  }else throw new Error("UNSUPPORTED_STOCK_PROVIDER");
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(12000)});
  const text=await response.text();
  if(response.status!==expected)
    throw new Error("PROVIDER_HTTP_"+response.status+":"+text.slice(0,220).replace(/\s+/g," "));
  if(job.provider==="OZON"){
    let parsed:any;
    try{parsed=JSON.parse(text);}catch{throw new Error("OZON_INVALID_RESPONSE");}
    const rows=Array.isArray(parsed?.result)?parsed.result:[];
    if(!rows.some((r:any)=>r?.updated===true&&r?.offer_id===job.external_offer_id))
      throw new Error("OZON_STOCK_REJECTED");
  }
  if(job.provider==="YANDEX_MARKET"){
    let parsed:any;
    try{parsed=JSON.parse(text);}catch{throw new Error("YANDEX_INVALID_RESPONSE");}
    if(parsed?.status==="ERROR"||parsed?.status==="FAILED"||parsed?.errors?.length)
      throw new Error("YANDEX_STOCK_REJECTED");
  }
}

async function publish(pool:Pool,job:PublishJob):Promise<void>{
  let error:string|null=null;
  try{await send(job);}catch(e){error=e instanceof Error?e.message:String(e);}
  await tenantTx(pool,job.tenant_id,async client=>{
    const current=await client.query<{attempts:number}>(
      `SELECT attempts FROM channel_stock_target WHERE tenant_id=$1 AND listing_id=$2
       FOR UPDATE`,[job.tenant_id,job.listing_id]);
    if(!current.rows.length)return;
    if(error){
      const tries=current.rows[0]!.attempts;
      await client.query(`UPDATE channel_stock_target SET
        status=CASE WHEN generation<>$3::bigint THEN 'PENDING'
           WHEN attempts>=8 THEN 'BLOCKED' ELSE 'RETRY' END,
        last_error=$4,lease_until=NULL,
        next_attempt_at=now()+make_interval(secs=>least(300,5*power(2,least($5,6)))::integer),
        updated_at=now()
        WHERE tenant_id=$1 AND listing_id=$2`,
        [job.tenant_id,job.listing_id,job.generation,error.slice(0,500),tries]);
    }else{
      await client.query(`UPDATE channel_stock_target SET
         published_units=$4,published_generation=$3,
         status=CASE WHEN generation=$3::bigint THEN
           CASE WHEN EXISTS(SELECT 1 FROM channel_stock_listing l
              WHERE l.tenant_id=$1 AND l.id=$2 AND l.publish_enabled)
              THEN 'SYNCED' ELSE 'PAUSED' END
           ELSE 'PENDING' END,
         attempts=0,lease_until=NULL,last_published_at=now(),last_error=NULL,
         next_attempt_at=CASE WHEN $5='OZON' THEN now()+interval '31 seconds'
                              ELSE NULL END,
         updated_at=now()
         WHERE tenant_id=$1 AND listing_id=$2`,
        [job.tenant_id,job.listing_id,job.generation,job.target_units,job.provider]);
      const affected=await client.query<{warehouse_id:string;sku_id:string}>(`SELECT warehouse_id,sku_id
        FROM channel_stock_listing WHERE tenant_id=$1 AND id=$2`,
        [job.tenant_id,job.listing_id]);
      if(affected.rows[0]){
        await client.query(`INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
         VALUES($1,$2,$3) ON CONFLICT(tenant_id,warehouse_id,sku_id)
         DO UPDATE SET queued_at=now()`,[job.tenant_id,
            affected.rows[0].warehouse_id,affected.rows[0].sku_id]);
      }
    }
  });
  if(error)process.stderr.write("[stock-hub] listing "+job.listing_id+" retry: "+error.replace(/\s+/g," ").slice(0,200)+"\n");
}
export async function processStockHubOnce(pool:Pool):Promise<boolean>{
  const dirty=await pool.query<PoolKey>("SELECT * FROM corebiz_claim_stock_dirty()");
  if(dirty.rows[0]){await reconcile(pool,dirty.rows[0]);return true;}
  const job=await pool.query<PublishJob>("SELECT * FROM corebiz_claim_stock_target()");
  if(job.rows[0]){await publish(pool,job.rows[0]);return true;}
  const scheduled=await pool.query<{corebiz_schedule_fbs_stock_poll:number}>(
    "SELECT corebiz_schedule_fbs_stock_poll()");
  if((scheduled.rows[0]?.corebiz_schedule_fbs_stock_poll??0)>0)return true;
  // Recheck active FBS pools periodically even without local stock writes.
  const periodic=await pool.query(`INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
    SELECT tenant_id,warehouse_id,sku_id FROM (
      SELECT DISTINCT ON (tenant_id,warehouse_id,sku_id)
        tenant_id,warehouse_id,sku_id
      FROM channel_stock_listing
      WHERE publish_enabled AND updated_at<now()-interval '90 seconds'
      ORDER BY tenant_id,warehouse_id,sku_id
      LIMIT 15
    ) stale
    ON CONFLICT(tenant_id,warehouse_id,sku_id) DO NOTHING`);
  if((periodic.rowCount??0)>0)return true;
  return false;
}

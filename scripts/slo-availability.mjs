#!/usr/bin/env node
/**
 * CoreBiz 99.9% SLO audit: one safe synthetic readiness probe per minute.
 * Run from an independent monitoring host; never run synthetic mutations on
 * a live business database. Missing samples count as unavailable minutes.
 *
 * COREBIZ_SLO_BASE_URL=https://erp.example.com
 * COREBIZ_SLO_EVIDENCE_FILE=/var/lib/corebiz-monitor/availability.jsonl
 * node scripts/slo-availability.mjs probe
 * node scripts/slo-availability.mjs report
 */
import {appendFile,readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

export const WINDOW_MINUTES=30*24*60;
const INTERVAL_MS=60000;
const MAX_LATENCY_MS=8000;

export function evaluate(samples,nowMs=Date.now(),windowMinutes=WINDOW_MINUTES){
  if(!Number.isSafeInteger(windowMinutes)||windowMinutes<1)
    throw new Error("INVALID_SLO_WINDOW");
  const end=Math.floor(nowMs/INTERVAL_MS);
  // Exclude current incomplete minute: an unobserved current minute is not
  // availability proof and should not flip verdicts mid-interval.
  const first=end-windowMinutes;
  const slots=new Map();
  for(const item of samples){
    if(!item||typeof item!=="object"||
       typeof item.at!=="string"||typeof item.ok!=="boolean")
      continue;
    const ms=Date.parse(item.at);
    if(!Number.isFinite(ms))continue;
    const minute=Math.floor(ms/INTERVAL_MS);
    if(minute<first||minute>=end)continue;
    const current=slots.get(minute);
    // Any failure or duplicate sample during a minute makes it a failure.
    slots.set(minute,current===undefined?item.ok:current&&item.ok);
  }
  const observed=slots.size;
  const successes=[...slots.values()].filter(Boolean).length;
  const missing=windowMinutes-observed;
  const failures=windowMinutes-successes;
  const availability=successes/windowMinutes;
  const target=.999;
  const budget=Math.floor(windowMinutes*(1-target)+1e-9);
  return {
    windowMinutes,observedMinutes:observed,missingMinutes:missing,
    successfulMinutes:successes,unavailableMinutes:failures,
    availabilityPct:Number((availability*100).toFixed(5)),
    targetPct:99.9,allowedUnavailableMinutes:budget,
    // 30-day evidence requires coverage of every minute OR a recorded failure
    // for every missing minute. Missing is never counted as success.
    passed:failures<=budget,
    evidenceCoveragePct:Number((100*observed/windowMinutes).toFixed(3))
  };
}
const invoked=process.argv[1]&&
  import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
  const file=process.env.COREBIZ_SLO_EVIDENCE_FILE;
  if(!file)throw new Error("COREBIZ_SLO_EVIDENCE_FILE_REQUIRED");
  const mode=process.argv[2];
  if(mode==="probe"){
    const raw=process.env.COREBIZ_SLO_BASE_URL;
    if(!raw)throw new Error("COREBIZ_SLO_BASE_URL_REQUIRED");
    const url=new URL(raw);
    if(url.username||url.password||url.search||url.hash||
       !["https:","http:"].includes(url.protocol)||
       (url.protocol==="http:"&&
         !["localhost","127.0.0.1","[::1]"].includes(url.hostname)))
      throw new Error("SLO_PROBE_REQUIRES_HTTPS_OR_LOCALHOST");
    const dest=new URL("/api/v1/health/ready",url);
    const at=new Date().toISOString();
    const started=performance.now();
    let ok=false,status=0;
    try{
      const response=await fetch(dest,{
        method:"GET",redirect:"error",
        signal:AbortSignal.timeout(MAX_LATENCY_MS),
        headers:{Accept:"application/json"}
      });
      status=response.status;
      if(response.ok){
        const data=await response.json();
        ok=data?.ok===true&&data?.data?.status==="ok";
      }
    }catch{/* timeout, invalid JSON and transport errors are down */}
    const ms=Math.round(performance.now()-started);
    ok=ok&&ms<=MAX_LATENCY_MS;
    const record={at,ok,status,latencyMs:ms};
    await appendFile(file,JSON.stringify(record)+"\n",{mode:0o600});
    process.stdout.write(JSON.stringify(record)+"\n");
    if(!ok)process.exitCode=1;
  }else if(mode==="report"){
    const raw=await readFile(file,"utf8");
    const samples=raw.split("\n").filter(Boolean).flatMap(line=>{
      try{return [JSON.parse(line)];}catch{return [];}
    });
    const result=evaluate(samples);
    process.stdout.write(JSON.stringify(result,null,2)+"\n");
    if(!result.passed)process.exitCode=1;
  }else{
    throw new Error("Usage: node scripts/slo-availability.mjs probe|report");
  }
}

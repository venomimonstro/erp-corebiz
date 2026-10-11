#!/usr/bin/env node
/**
 * Disposable ONLY: 1,000 independent authenticated user sessions at once.
 * Supply 1,000 unique preseeded session cookies; this tool never generates
 * accounts, writes to business data, or prints authentication secrets.
 *
 * COREBIZ_CONFIRM_DISPOSABLE_DB=YES
 * COREBIZ_LOAD_BASE_URL=http://127.0.0.1:4000
 * COREBIZ_LOAD_SESSIONS_FILE=/tmp/disposable-sessions.json
 * node scripts/load-1000-sessions.mjs
 *
 * JSON: [{"cookie":"corebiz_session=<token>"},...], >= 1000 entries.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

if(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB!=="YES")
  throw new Error("BLOCKED: disposable DB confirmation required");
const base=new URL(process.env.COREBIZ_LOAD_BASE_URL||"");
if(base.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(base.hostname))
  throw new Error("BLOCKED: only loopback HTTP on disposable environment");
const filename=process.env.COREBIZ_LOAD_SESSIONS_FILE;
if(!filename)throw new Error("COREBIZ_LOAD_SESSIONS_FILE_REQUIRED");
const actorFile=JSON.parse(readFileSync(filename,"utf8"));
if(!Array.isArray(actorFile)||actorFile.length<1000)
  throw new Error("REQUIRE_1000_INDEPENDENT_SESSIONS");
const actors=actorFile.slice(0,1000);
const names=new Set();
for(const actor of actors){
  assert.ok(actor&&typeof actor.cookie==="string"&&
    /^corebiz_session=[A-Za-z0-9_=-]{24,300}$/.test(actor.cookie),
    "Invalid fixture session cookie");
  if(names.has(actor.cookie))throw new Error("SESSIONS_MUST_BE_UNIQUE");
  names.add(actor.cookie);
}

const paths=[
  "/api/v1/dashboard/workspace",
  "/api/v1/catalog/products/page?limit=25",
  "/api/v1/dashboard/workspace",
  "/api/v1/catalog/products/page?limit=25"
];
const started=performance.now();
const samples=await Promise.all(actors.map(async(actor,i)=>{
  const begin=performance.now();
  try{
    const response=await fetch(new URL(paths[i%paths.length],base),{
      method:"GET",headers:{Cookie:actor.cookie},
      redirect:"manual",signal:AbortSignal.timeout(30000)
    });
    // Avoid retaining megabytes of response data or sensitive company details.
    const body=await response.text();
    return {status:response.status,ms:performance.now()-begin,
      ok:response.status===200&&body.includes('"ok":true')};
  }catch{
    return {status:0,ms:performance.now()-begin,ok:false};
  }
}));
const durations=samples.map(s=>s.ms).sort((a,b)=>a-b);
const at=(p)=>Math.round(durations[Math.min(durations.length-1,
  Math.ceil(p*durations.length)-1)]);
const failures=samples.filter(s=>!s.ok);
const histogram={};
for(const s of samples)histogram[s.status]=(histogram[s.status]??0)+1;
const result={
  actors:actors.length,requests:samples.length,
  durationMs:Math.round(performance.now()-started),
  rps:Number((samples.length*1000/(performance.now()-started)).toFixed(1)),
  p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),
  maxMs:Math.round(durations.at(-1)??0),
  errors:failures.length,errorRate:Number((failures.length/samples.length).toFixed(4)),
  statusCounts:histogram,
  thresholds:{p95Ms:1500,maxErrorRate:.005},
  passed:at(.95)<=1500&&failures.length/samples.length<=.005
};
process.stdout.write(JSON.stringify(result,null,2)+"\n");
if(!result.passed)process.exitCode=1;

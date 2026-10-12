import test from "node:test";
import assert from "node:assert/strict";
import {evaluate,WINDOW_MINUTES} from "./slo-availability.mjs";
const minute=60_000;
const now=Date.parse("2026-10-12T11:00:00Z");
const sample=(index,ok=true)=>({
  at:new Date(now-(index+1)*minute).toISOString(),ok,
  status:ok?200:503,latencyMs:ok?50:10000
});
test("no data never proves 99.9 percent uptime",()=>{
  const result=evaluate([],now,1000);
  assert.equal(result.passed,false);
  assert.equal(result.missingMinutes,1000);
  assert.equal(result.successfulMinutes,0);
});
test("exact 99.9 percent window has one minute of failure per 1000",()=>{
  const values=Array.from({length:1000},(_,i)=>sample(i,i!==400));
  const result=evaluate(values,now,1000);
  assert.equal(result.availabilityPct,99.9);
  assert.equal(result.allowedUnavailableMinutes,1);
  assert.equal(result.passed,true);
  values.push({...sample(401),ok:false,status:503});
  assert.equal(evaluate(values,now,1000).passed,false);
});
test("missing sample is downtime, duplicate failure overrides earlier success",()=>{
  const values=Array.from({length:1000},(_,i)=>sample(i));
  values.splice(7,1);
  assert.equal(evaluate(values,now,1000).missingMinutes,1);
  assert.equal(evaluate(values,now,1000).passed,true);
  values.push(sample(23,false));
  assert.equal(evaluate(values,now,1000).passed,false);
});
test("rejects future and stale samples outside last completed minute",()=>{
  const r=evaluate([sample(0),sample(2000),{
    at:new Date(now).toISOString(),ok:true}],now,1000);
  assert.equal(r.observedMinutes,1);
});
test("30-day SLO means maximum 43 unavailable minutes",()=>{
  assert.equal(WINDOW_MINUTES,43200);
  assert.equal(evaluate([],now).allowedUnavailableMinutes,43);
});

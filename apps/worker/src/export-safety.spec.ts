import test from "node:test";
import assert from "node:assert/strict";
import {gunzipSync} from "node:zlib";
import {csvBatch,csvCell} from "./export-safety.js";
import {compressExport,cleanValue} from "./tenant-export.js";

test("CSV formulas from customer and supplier fields are rendered as text",()=>{
  for(const value of [
    "=HYPERLINK(\"http://example.invalid\")",
    "+SUM(1,1)",
    "-2+2",
    "@SUM(A1)",
    "\t=1+1",
    "\r\n=1+1",
    "  =CMD"
  ]){
    const serialized=csvCell(value);
    assert.ok(serialized.startsWith('"\''));
    assert.ok(!serialized.startsWith('"='));
  }
  assert.equal(csvCell("Обычный товар"),'"Обычный товар"');
  assert.equal(csvCell(10),'"10"');
  assert.equal(csvCell(null),'""');
});

test("CSV pages include a header only once and keep column order stable",()=>{
  const columns=["name","sku"];
  const first=csvBatch([{name:"=A1",sku:"A"}],columns,true);
  const next=csvBatch([{name:"Книга",sku:"B"}],columns,false);
  assert.ok(first.startsWith('"name","sku"\n'));
  assert.ok(first.includes('"\'=A1","A"\n'));
  assert.equal((first+next).split('"name","sku"').length-1,1);
  assert.ok(next.includes('"Книга","B"\n'));
});

test("streaming compression round-trips 20000 records without materializing raw archive",async()=>{
  async function* source(){
    yield '{"data":[';
    for(let i=0;i<20000;i++){
      yield (i?",":"")+JSON.stringify({sku:"SKU-"+i,price:i,tenant:"tenant-A"});
    }
    yield ']}';
  }
  const zipped=await compressExport(source());
  assert.ok(zipped.rawBytes>zipped.compressedBytes);
  const plain=JSON.parse(gunzipSync(zipped.artifact).toString("utf8"));
  assert.equal(plain.data.length,20000);
  assert.equal(plain.data[19999].sku,"SKU-19999");
  assert.equal(zipped.artifact.length,zipped.compressedBytes);
});

test("streamer preserves exact bytes across small and empty chunks",async()=>{
  async function* source(){yield "";yield "a";yield "b";yield "";yield "c";}
  const result=await compressExport(source());
  assert.equal(gunzipSync(result.artifact).toString(),"abc");
  assert.equal(result.rawBytes,3);
});

test("export preserves real timestamps, binary fields and strips nested secrets",()=>{
  const input={
    created_at:new Date("2026-10-11T09:20:30Z"),
    barcode:"12345",
    document_bytes:Buffer.from("hello","utf8"),
    nested:{
      api_key:"do-not-export",
      access_token:"secret",
      provider_password:"password",
      delivery_at:new Date("2026-11-01T00:00:00Z")
    }
  };
  const result=cleanValue(input) as any;
  assert.equal(result.created_at,"2026-10-11T09:20:30.000Z");
  assert.equal(result.document_bytes,Buffer.from("hello").toString("base64"));
  assert.equal(result.nested.delivery_at,"2026-11-01T00:00:00.000Z");
  assert.equal(result.nested.api_key,undefined);
  assert.equal(result.nested.access_token,undefined);
  assert.equal(result.nested.provider_password,undefined);
});

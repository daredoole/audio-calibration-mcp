import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceAuthority } from "../lib/evidence-tokens.mjs";

test("evidence authority accepts exact unexpired server-issued evidence",()=>{
  const authority=createEvidenceAuthority({key:Buffer.alloc(32,7),now:()=>1000,ttlMs:5000}), token=authority.issue({kind:"quality",accepted:true,entries:[{id:"1",traceHash:"abc"}]});
  assert.equal(authority.verify(token,"quality").accepted,true);
});

test("evidence authority rejects caller fabrication, tampering, wrong kind, and expiry",()=>{
  let now=1000; const authority=createEvidenceAuthority({key:Buffer.alloc(32,8),now:()=>now,ttlMs:100}), token=authority.issue({kind:"quality",accepted:true});
  assert.throws(()=>authority.verify("caller-asserted","quality"),/required/);
  assert.throws(()=>authority.verify(`${token.slice(0,-1)}x`,"quality"),/signature/);
  assert.throws(()=>authority.verify(token,"protected"),/Expected protected/);
  now=1200; assert.throws(()=>authority.verify(token,"quality"),/expired/);
});

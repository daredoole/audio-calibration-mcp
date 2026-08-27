import test from "node:test";
import assert from "node:assert/strict";
import { runAnalysisWorker, workerPoolStatus } from "../lib/worker-runner.mjs";

const trace={smoothing:"1/48",ppo:96,startFreq:100,frequencies:[100,200,400,800,1600,3200],magnitude:[70,71,69,70,68,67]};
const args={id:"1",lowHz:100,highHz:3200,stepErb:1,widthErb:1,modalBoundaryHz:200,smoothingTransitionHz:1000};

test("analysis worker isolates dual-resolution computation",async()=>{
  const result=await runAnalysisWorker("dual-resolution",{source:trace,minimal:trace,rawUsable:false,args});
  assert.equal(result.measurementId,"1"); assert.equal(result.rawAvailable,false); assert.ok(result.perceptual.rows.length>0);
  assert.equal(workerPoolStatus().active,0);
});

test("analysis worker rejects unknown tasks and honours pre-cancellation",async()=>{
  await assert.rejects(()=>runAnalysisWorker("unknown",{}),/Unknown analysis worker task/);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(()=>runAnalysisWorker("dual-resolution",{source:trace,minimal:trace,rawUsable:false,args},{signal:controller.signal}),/cancelled/);
});

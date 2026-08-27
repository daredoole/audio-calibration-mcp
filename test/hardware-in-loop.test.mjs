import test from "node:test";
import assert from "node:assert/strict";
import { rew } from "../core.mjs";

test("opt-in REW hardware loop performs read-only API negotiation",{skip:process.env.AUDIO_CALIBRATION_HIL!=="true"},async()=>{
  const version=await rew("/version",{timeoutMs:5000}),measurements=await rew("/measurements",{timeoutMs:5000});
  assert.ok(version); assert.ok(Array.isArray(measurements)||measurements&&typeof measurements==="object");
});

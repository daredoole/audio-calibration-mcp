import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { bindPlan } from "../core.mjs";
import { registerAnalysisTools } from "../tool-domains/analysis-tools.mjs";
import { analysisJobs } from "../tool-domains/release-tools.mjs";

const entry = { id: "1", role: "left", controlFingerprint: "control-1", presetFingerprint: "preset-1" };

test("analysis tool domain is dependency-injected and covers quality, async, EQ, protection, compression, and verification", async () => {
  const handlers = new Map(), server = { tool: (name, _description, _schema, handler) => handlers.set(name, handler) }, ok = data => data;
  const trace = { frequencyResponse: { frequencies: [100, 1000], magnitude: [70, 70] } };
  registerAnalysisTools(server, {
    ok, guarded: fn => fn, liveEntrySchema: {}, fetchTraceBundle: async value => ({ ...value, ...trace }),
    rew: async path => ({ smoothing: path.includes("smoothing=None") ? "None" : "1/48", freqStep: 1, frequencies: [100, 1000], magnitude: [70, 70] }),
    measurementQuality: (traces, args) => ({ accepted: true, count: traces.length, stateVerified: args.stateVerified }),
    humanListeningAssessment: traces => ({ dimensions: { tonalBalance: { score: 80 } }, traceCount: traces.length }), bindPlan,
    multiResolutionEqProposal: () => ({ accepted: true, filters: [] }), linkedStereoEqProposal: () => ({ accepted: true, leftFilters: [], rightFilters: [] }),
    speakerProtectionAssessment: args => ({ accepted: true, args }), compressionMetrics: traces => ({ traceCount: traces.length, maximumCompressionDb: 0 }),
    measuredPostEqVerification: () => ({ accepted: true })
  });
  assert.equal(handlers.size, 7);
  const quality = await handlers.get("rew_measurement_quality")({ entries: [entry], routeStable: true, dspStable: true }); assert.equal(quality.accepted, true);
  const asyncStart = await handlers.get("rew_human_listening_assessment")({ entries: [entry], deviceClass: "laptop" });
  let job; for (let i = 0; i < 50; i++) { job = analysisJobs.status(asyncStart.id); if (job.status === "complete") break; await delay(2); } assert.equal(job.status, "complete"); assert.equal(job.result.traceCount, 1);
  const eq = await handlers.get("audio_eq_design_plan")({ entries: [entry], deviceClass: "laptop" }); assert.equal(eq.kind, "audio-eq-design");
  const stereo = await handlers.get("audio_linked_stereo_eq_plan")({ leftEntries: [entry, { ...entry, id: "2" }], rightEntries: [{ ...entry, id: "3", role: "right" }, { ...entry, id: "4", role: "right" }], deviceClass: "laptop" }); assert.equal(stereo.kind, "linked-stereo-eq-design");
  assert.equal((await handlers.get("audio_speaker_protection_assessment")({ maximumBoostDb: 0 })).accepted, true);
  assert.equal((await handlers.get("rew_compression_analysis")({ entries: [entry, { ...entry, id: "2" }], levelsDbfs: [-40, -30] })).traceCount, 2);
  const verified = await handlers.get("audio_post_eq_verification")({ beforeEntries: [entry, { ...entry, id: "2" }], afterEntries: [{ ...entry, id: "3" }, { ...entry, id: "4" }], deviceClass: "laptop", beforeControlFingerprint: "controls", afterControlFingerprint: "controls", beforePresetFingerprint: "before-preset", afterPresetFingerprint: "after-preset", levelMatchedWithinDb: 0.1 }); assert.equal(verified.accepted, true);
});

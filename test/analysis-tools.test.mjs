import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { bindPlan } from "../core.mjs";
import { registerAnalysisTools } from "../tool-domains/analysis-tools.mjs";
import { analysisJobs } from "../tool-domains/release-tools.mjs";

const entry = { id: "1", role: "left", controlFingerprint: "control-1", presetFingerprint: "preset-1", microphoneCalibrationHash: "mic-1", traceHash: "trace-1", snrDb: 30, clipped: false };

test("analysis tool domain is dependency-injected and covers quality, async, EQ, protection, compression, and verification", async () => {
  const handlers = new Map(), server = { tool: (name, _description, _schema, handler) => handlers.set(name, handler) }, ok = data => data;
  const trace = { frequencyResponse: { frequencies: [100, 1000], magnitude: [70, 70] } };
  registerAnalysisTools(server, {
    ok, guarded: fn => fn, liveEntrySchema: {}, fetchTraceBundle: async value => ({ ...value, ...trace }), traceBundleHash: value => `trace-${value.id}`,
    issueEvidence: value => JSON.stringify(value), verifyEvidence: (token, kind) => { const value=JSON.parse(token); if(value.kind!==kind) throw new Error("wrong evidence"); return value; },
    runAnalysisWorker: async (kind,payload) => kind === "human-listening" ? ({ quality: { accepted: true, metrics: { repeatabilitySdDb: 0.2 } }, dimensions: { tonalBalance: { score: 80, raw: { bassRmseDb: 2, midRmseDb: 2, trebleRmseDb: 2 } } }, traceCount: payload.traces.length }) : kind === "post-eq" ? ({ before: { quality:{accepted:true},dimensions:{tonalBalance:{score:70,raw:{}}}}, after: {quality:{accepted:true},dimensions:{tonalBalance:{score:80,raw:{}}}}, measuredLevel:{differenceDb:0}, verification:{accepted:true} }) : null,
    rew: async path => ({ smoothing: path.includes("smoothing=None") ? "None" : "1/48", freqStep: 1, frequencies: [100, 1000], magnitude: [70, 70] }),
    measurementQuality: (traces, args) => ({ accepted: true, count: traces.length, stateVerified: args.stateVerified }),
    humanListeningAssessment: traces => ({ quality: { accepted: true, metrics: { repeatabilitySdDb: 0.2 } }, dimensions: { tonalBalance: { score: 80, raw: { bassRmseDb: 2, midRmseDb: 2, trebleRmseDb: 2 } } }, traceCount: traces.length }), bindPlan,
    multiResolutionEqProposal: () => ({ accepted: true, filters: [] }), linkedStereoEqProposal: () => ({ accepted: true, leftFilters: [], rightFilters: [] }),
    speakerProtectionAssessment: args => ({ accepted: true, args }), compressionMetrics: traces => ({ traceCount: traces.length, maximumCompressionDb: 0 }),
    measuredBroadbandLevelDifference: () => ({ differenceDb: 0, bandHz: [500, 8000] }), measuredPostEqVerification: () => ({ accepted: true })
  });
  assert.equal(handlers.size, 7);
  const protectedToken=JSON.stringify({kind:"protected-measurement-evidence",sourcePlanHash:"plan",entries:[entry]});
  const quality = await handlers.get("rew_measurement_quality")({ entries: [entry], protectedEvidenceToken: protectedToken }); assert.equal(quality.accepted, true);
  const asyncStart = await handlers.get("rew_human_listening_assessment")({ entries: [entry], qualityEvidenceToken: quality.qualityEvidenceToken, deviceClass: "laptop" });
  let job; for (let i = 0; i < 50; i++) { job = analysisJobs.status(asyncStart.id); if (job.status === "complete") break; await delay(2); } assert.equal(job.status, "complete"); assert.equal(job.result.traceCount, 1);
  const eq = await handlers.get("audio_eq_design_plan")({ entries: [entry], qualityEvidenceToken: quality.qualityEvidenceToken, deviceClass: "laptop" }); assert.equal(eq.kind, "audio-eq-design");
  const left=[entry,{...entry,id:"2",traceHash:"trace-2"}],right=[{...entry,id:"3",role:"right",traceHash:"trace-3"},{...entry,id:"4",role:"right",traceHash:"trace-4"}], leftToken=JSON.stringify({kind:"accepted-measurement-quality",accepted:true,entries:left}),rightToken=JSON.stringify({kind:"accepted-measurement-quality",accepted:true,entries:right});
  const stereo = await handlers.get("audio_linked_stereo_eq_plan")({ leftEntries:left,rightEntries:right,leftQualityEvidenceToken:leftToken,rightQualityEvidenceToken:rightToken,deviceClass:"laptop" }); assert.equal(stereo.kind, "linked-stereo-eq-design");
  assert.equal((await handlers.get("audio_speaker_protection_assessment")({ maximumBoostDb: 0 })).accepted, true);
  assert.equal((await handlers.get("rew_compression_analysis")({ entries: [entry, { ...entry, id: "2" }], levelsDbfs: [-40, -30] })).traceCount, 2);
  const after=right.map(x=>({...x,role:"left",controlFingerprint:"control-1",presetFingerprint:"preset-2"})),afterToken=JSON.stringify({kind:"accepted-measurement-quality",accepted:true,entries:after});
  const verificationStart = await handlers.get("audio_post_eq_verification")({ beforeEntries:left,afterEntries:after,beforeQualityEvidenceToken:leftToken,afterQualityEvidenceToken:afterToken,deviceClass:"laptop",levelMatchToleranceDb:0.2 });
  let verified; for (let i = 0; i < 50; i++) { verified = analysisJobs.status(verificationStart.id); if (verified.status === "complete") break; await delay(2); } assert.equal(verified.result.accepted, true);

  await assert.rejects(()=>handlers.get("rew_measurement_quality")({entries:[entry]}));
  const altered=JSON.stringify({kind:"protected-measurement-evidence",entries:[{...entry,traceHash:"forged"}]});
  await assert.rejects(()=>handlers.get("rew_measurement_quality")({entries:[{id:"1",role:"left"}],protectedEvidenceToken:altered}),/trace bytes changed/);
  const rejected=JSON.stringify({kind:"accepted-measurement-quality",accepted:false,entries:[entry]});
  await assert.rejects(()=>handlers.get("audio_eq_design_plan")({entries:[entry],qualityEvidenceToken:rejected,deviceClass:"laptop"}),/rejected/);
});

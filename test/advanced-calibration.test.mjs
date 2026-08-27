import test from "node:test";
import assert from "node:assert/strict";
import {
  directLateWindowAnalysis, erbSmooth, frequencyDependentSmooth, linkedStereoEqProposal, measuredBroadbandLevelDifference, measuredPostEqVerification,
  measurementStateFingerprint, multiResolutionEqProposal, speakerProtectionAssessment
} from "../advanced-calibration.mjs";

function response({ peakHz = 1000, peakDb = 6, offsetDb = 0 } = {}) {
  const frequencies = [], magnitude = [];
  for (let f = 120; f <= 16000; f *= 2 ** (1 / 24)) {
    frequencies.push(f);
    const octaves = Math.log2(f / peakHz), bump = peakDb * Math.exp(-0.5 * (octaves / 0.18) ** 2);
    magnitude.push(offsetDb + bump);
  }
  return { frequencies, magnitude };
}

test("ERB analysis preserves a separate perceptual view and audibility metadata", () => {
  const result = erbSmooth(response(), { lowHz: 120, highHz: 12000, stepErb: 0.5, widthErb: 1 });
  assert.ok(result.rows.length > 20);
  assert.ok(result.rows.every(x => x.audibilityThresholdDb >= 1));
  assert.match(result.boundary, /heuristics/);
});

test("frequency-dependent smoothing preserves modal resolution and broadens high frequencies", () => {
  const result = frequencyDependentSmooth(response(), { lowHz: 120, highHz: 12000, modalBoundaryHz: 200, transitionHz: 1000 });
  const low = result.rows.find(x => x.frequencyHz >= 150), high = result.rows.find(x => x.frequencyHz >= 9000);
  assert.equal(low.regime, "modal-high-resolution");
  assert.equal(high.regime, "high-frequency-perceptual");
  assert.ok(high.effectiveBandwidthOctaves > low.effectiveBandwidthOctaves);
});

test("direct and late windows separate impulse energy", () => {
  const impulse = Array(4800).fill(0); impulse[480] = 1; impulse[960] = 0.2;
  const result = directLateWindowAnalysis({ impulse }, { sampleRateHz: 48000, directWindowMs: 5, lateWindowMs: 80 });
  assert.ok(result.directEnergyFraction > result.lateEnergyFraction);
  assert.ok(result.directToLateDb > 10);
});

test("state fingerprint distinguishes preset from controlled measurement state", () => {
  const common = { route: { sink: "speaker" }, volume: { sink: "50%" }, microphone: { hash: "mic" }, rew: { rate: 48000 }, sweep: { levelDbfs: -30 } };
  const a = measurementStateFingerprint({ ...common, dsp: { enabled: true }, preset: { hash: "a" } }), b = measurementStateFingerprint({ ...common, dsp: { enabled: true }, preset: { hash: "b" } });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(a.controlFingerprint, b.controlFingerprint);
});

test("speaker protection disables unsafe or unsupported boost", () => {
  const unknown = speakerProtectionAssessment({ maximumBoostDb: 6 });
  assert.equal(unknown.permittedBoostDb, 0); assert.equal(unknown.acceptedForAutomaticEq, false);
  const limited = speakerProtectionAssessment({ measuredF3Hz: 180, headroomDb: 5, maximumBoostDb: 4, compressionDb: 2, limiterObserved: true });
  assert.equal(limited.correctionFloorHz, 180); assert.equal(limited.permittedBoostDb, 0);
});

test("linked stereo EQ requires validation and constrains channel differences", () => {
  const left = [response({ peakDb: 6 }), response({ peakDb: 5.8 })], right = [response({ peakDb: 5.5 }), response({ peakDb: 5.4 })];
  const result = linkedStereoEqProposal(left, right, { deviceClass: "laptop", lowHz: 200, highHz: 8000, validationCount: 1, minValidationImprovementDb: 0.05, maxInterchannelGainDeltaDb: 1, maxQ: 4 });
  assert.equal(result.status, "proposal-cross-validated");
  assert.ok(result.filters.left.length > 0);
  result.filters.left.forEach((filter, i) => assert.ok(Math.abs(filter.gainDb - result.filters.right[i].gainDb) <= 1));
});

test("multi-resolution EQ gates raw, minimal, perceptual, repeated, and held-out evidence", () => {
  const raw = [response({ peakDb: 6 }), response({ peakDb: 5.8 }), response({ peakDb: 5.9 })], minimal = raw.map(x => ({ ...x }));
  const result = multiResolutionEqProposal(raw, minimal, { deviceClass: "laptop", lowHz: 200, highHz: 8000, validationCount: 1, minValidationImprovementDb: 0.05, maxQ: 4 });
  assert.equal(result.status, "proposal-cross-validated-multiresolution");
  assert.ok(result.filters.length > 0);
  assert.ok(result.featureGates.every(x => Object.keys(x.evidence).join(",") === "raw,minimal,perceptual"));
  assert.ok(Object.values(result.resolutionValidation).every(x => x.withheldValidation.improvementDb > 0));
});

test("measured verification rejects unmatched controls and accepts real improvement", () => {
  const assessment = (mid, repeatability = 0.5) => ({ quality: { accepted: true, metrics: { repeatabilitySdDb: repeatability } }, dimensions: { tonalBalance: { raw: { bassRmseDb: 2, midRmseDb: mid, trebleRmseDb: 2 } } } });
  const rejected = measuredPostEqVerification(assessment(4), assessment(2), { stateMatched: false, measuredLevelDifferenceDb: 0.1 });
  assert.equal(rejected.accepted, false);
  const levelRejected = measuredPostEqVerification(assessment(4), assessment(2), { stateMatched: true, measuredLevelDifferenceDb: -3.45 });
  assert.equal(levelRejected.accepted, false); assert.equal(levelRejected.evidence.levelMatched, false);
  const accepted = measuredPostEqVerification(assessment(4), assessment(2), { stateMatched: true, measuredLevelDifferenceDb: 0.1 });
  assert.equal(accepted.status, "verified-improvement");
});

test("measured broadband level difference is derived from traces", () => {
  const before = [{ frequencyResponse: response({ peakDb: 0, offsetDb: 70 }) }, { frequencyResponse: response({ peakDb: 0, offsetDb: 70.2 }) }];
  const after = [{ frequencyResponse: response({ peakDb: 0, offsetDb: 66.5 }) }, { frequencyResponse: response({ peakDb: 0, offsetDb: 66.7 }) }];
  const measured = measuredBroadbandLevelDifference(before, after, { lowHz: 500, highHz: 8000 });
  assert.ok(measured.differenceDb < -3.4 && measured.differenceDb > -3.6);
});

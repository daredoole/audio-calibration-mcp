import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_REGISTRY, TARGET_REGISTRY, compressionMetrics, exportFilters, guidedSessionPlan, humanListeningAssessment,
  listeningTestPlan, listeningTestReport, measurementQuality, perceptualEqProposal, renderHumanReport, targetOffsetDb, targetProfile
} from "../human-listening.mjs";
import { verifyPlan } from "../core.mjs";

function trace({ deviceClass = "laptop", bumpDb = 0, dipDb = 0, levelOffset = 0, role, clipped = false } = {}) {
  const target = targetProfile(deviceClass), frequencies = Array.from({ length: 90 }, (_, i) => target.anchors[0][0] * 2 ** (i / 12)).filter(x => x <= target.anchors.at(-1)[0]);
  const magnitude = frequencies.map(f => 70 + levelOffset + targetOffsetDb(target, f) + bumpDb * Math.exp(-0.5 * (Math.log2(f / 1000) / 0.16) ** 2) - dipDb * Math.exp(-0.5 * (Math.log2(f / 2500) / 0.08) ** 2));
  return { frequencies, magnitude, phase: frequencies.map(() => 0), role, clipped, snrDb: 35 };
}

test("target registry labels defaults as preference starting points", () => {
  assert.equal(Object.keys(TARGET_REGISTRY).length, 3);
  assert.equal(EVIDENCE_REGISTRY["itu-bs1770"].doesNotSupport.includes("a loudspeaker or room response target"), true);
  assert.equal(targetProfile("laptop").classification, "preference-starting-point");
  assert.throws(() => targetProfile("car", "perceptual-neutral-room-v1"), /not applicable/);
});

test("measurement quality rejects clipping, route drift, and non-repeatability", () => {
  const good = measurementQuality([trace(), trace()], { lowHz: 120, highHz: 16000, microphoneCalibrationHash: "abc", stateVerified: true });
  assert.equal(good.accepted, true); assert.equal(good.confidence, "high");
  assert.equal(measurementQuality([trace({ clipped: true })], { lowHz: 120, highHz: 16000 }).accepted, false);
  assert.match(measurementQuality([trace()], { lowHz: 120, highHz: 16000, routeStable: false }).reasons.join(" "), /routing/);
  assert.equal(measurementQuality([trace(), trace({ levelOffset: 5 })], { lowHz: 120, highHz: 16000 }).accepted, false);
});

test("human assessment separates dimensions, confidence, and preference", () => {
  const assessment = humanListeningAssessment([trace({ role: "left" }), trace({ role: "right", bumpDb: 0.5 })], { deviceClass: "laptop", lowHz: 120, highHz: 16000, microphoneCalibrationHash: "cal-hash" });
  assert.equal(assessment.globalScore, null);
  assert.ok(assessment.dimensions.tonalBalance.score > 80);
  assert.ok(assessment.dimensions.imagingChannelMatch.score > 80);
  assert.equal(assessment.evidenceBoundary.preference.includes("perceptual-neutral"), true);
});

test("perceptual EQ cuts stable peaks, ignores nulls, and validates withheld traces", () => {
  const proposal = perceptualEqProposal([trace({ bumpDb: 5 }), trace({ bumpDb: 4.8 }), trace({ bumpDb: 5.1 })], { deviceClass: "laptop", validationCount: 1, maxFilters: 4 });
  assert.equal(proposal.status, "proposal-cross-validated");
  assert.ok(proposal.filters.length > 0);
  assert.ok(proposal.filters.every(x => x.gainDb < 0));
  assert.ok(proposal.withheldValidation.improvementDb > 0);
  const nullOnly = perceptualEqProposal([trace({ dipDb: 8 }), trace({ dipDb: 8 })], { deviceClass: "laptop", validationCount: 1 });
  assert.equal(nullOnly.filters.length, 0);
});

test("guided and listening plans are hash-bound and preference reports remain bounded", () => {
  const session = guidedSessionPlan({ name: "Laptop", deviceClass: "laptop" });
  assert.equal(verifyPlan(session, session.confirmationToken).measurement.repetitions, 4);
  assert.throws(() => verifyPlan({ ...session, targetId: "tampered" }, session.confirmationToken), /mismatch/);
  const plan = listeningTestPlan({ presetA: "Before", presetB: "After", mode: "AB", trials: 8, seed: "fixed" });
  const report = listeningTestReport(plan, Array.from({ length: 8 }, (_, i) => ({ trial: i + 1, choice: i < 6 ? "B" : "A" })));
  assert.equal(report.preference, "After"); assert.match(report.boundary, /not universal/);
  const abx = listeningTestPlan({ presetA: "Before", presetB: "After", mode: "ABX", trials: 8, seed: "fixed" });
  const abxReport = listeningTestReport(abx, abx.assignments.map(x => ({ trial: x.trial, choice: x.hiddenX })));
  assert.equal(abxReport.correct, 8); assert.equal(abxReport.preference, null); assert.match(abxReport.boundary, /not which preset is preferred/);
});

test("filter exports are deterministic and report escapes HTML", () => {
  const filters = [{ type: "PK", frequencyHz: 1000, gainDb: -3, q: 1.4 }];
  assert.match(exportFilters(filters, "equalizer-apo"), /Preamp: 0 dB/);
  assert.match(exportFilters(filters, "camilladsp-yaml"), /type: Peaking/);
  const assessment = humanListeningAssessment([trace()], { deviceClass: "laptop", lowHz: 120, highHz: 16000 });
  const curve = [{ frequencyHz: 120, levelDb: 60 }, { frequencyHz: 1000, levelDb: 70 }, { frequencyHz: 16000, levelDb: 64 }], report = renderHumanReport({ title: "<Safe>", assessment, resolutionViews: { raw: curve, minimal: curve, perceptual: curve } });
  assert.match(report.html, /&lt;Safe&gt;/); assert.doesNotMatch(report.html, /<title><Safe>/);
  assert.match(report.html, /Raw \/ unsmoothed/); assert.match(report.html, /polyline/); assert.equal(report.json.schemaVersion, 2);
});

test("compression analysis detects lost level increase", () => {
  const low = trace({ levelOffset: 0 }), high = trace({ levelOffset: 6 });
  const result = compressionMetrics([low, high], [-30, -20]);
  assert.ok(result.medianCompressionDb > 3.5 && result.medianCompressionDb < 4.5);
});

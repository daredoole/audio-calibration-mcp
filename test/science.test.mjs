import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapConfidence, complexTransferQuality, monteCarloUncertainty, roomAcousticMetrics, spatialRoomSummary, speechTransmissionScreening, standardUncertainty, uncertaintyBudget } from "../lib/measurement-science.mjs";
import { designRegularizedFir, maximumCleanOutput, optimizeComplexSources, optimizePhysicalSourceControls, polarCharacterization } from "../lib/system-science.mjs";
import { evaluationCorpusManifest, laboratoryListeningPlan, laboratoryListeningReport, sofaMetadataAssessment, spatialLayoutAssessment } from "../lib/listening-spatial.mjs";

test("GUM budget and deterministic sampling propagate distributions", () => {
  assert.equal(standardUncertainty({ uncertainty: Math.sqrt(3), distribution: "rectangular" }), 1);
  assert.equal(standardUncertainty({ uncertainty: Math.sqrt(6), distribution: "triangular" }), 1);
  assert.throws(() => standardUncertainty({ uncertainty: 1, distribution: "uniform-ish" }));
  const components = [{ name: "repeatability", uncertainty: 1, distribution: "normal", degreesOfFreedom: 9 }, { name: "position", uncertainty: Math.sqrt(3), distribution: "rectangular", sensitivity: 2 }];
  const budget = uncertaintyBudget(components);
  assert.ok(Math.abs(budget.combinedStandardUncertainty - Math.sqrt(5)) < 1e-12);
  assert.ok(budget.expandedUncertainty > budget.combinedStandardUncertainty);
  const first = monteCarloUncertainty(components, { trials: 2000, seed: 3 }), second = monteCarloUncertainty(components, { trials: 2000, seed: 3 });
  assert.deepEqual(first, second);
  assert.ok(first.interval95[1] > first.interval95[0]);
  const boot = bootstrapConfidence([1, 2, 3, 4], { trials: 1000, seed: 4 });
  assert.equal(boot.estimate, 2.5);
});

test("complex transfer quality rejects weak and contaminated bins", () => {
  const result = complexTransferQuality([
    { frequencyHz: 100, inputPower: 1, outputPower: 1, crossReal: 0.99, crossImag: 0, harmonicPower: 1e-5, averages: 8 },
    { frequencyHz: 200, inputPower: 1, outputPower: 1, crossReal: 0.2, crossImag: 0, harmonicPower: 0.2, averages: 8 }
  ], { minimumValidFraction: 0.4, repeatTimingSeconds: [0, 0.001], repeatElapsedSeconds: [0, 10] });
  assert.equal(result.bins[0].valid, true);
  assert.equal(result.bins[1].valid, false);
  assert.ok(result.clockDriftPpm > 0);
});

test("room metrics recover a monotonic decay and spatial variance", () => {
  const sampleRateHz = 8000, impulse = Array.from({ length: 8000 }, (_, i) => Math.exp(-i / 1000));
  const metrics = roomAcousticMetrics(impulse, sampleRateHz);
  assert.ok(metrics.edt.rt60Seconds > 0);
  assert.ok(metrics.t20.rSquared > 0.99);
  assert.ok(Number.isFinite(metrics.clarityC50Db));
  const summary = spatialRoomSummary([metrics, { ...metrics, clarityC50Db: metrics.clarityC50Db + 1 }]);
  assert.equal(summary.positions, 2);
  const sti = speechTransmissionScreening([{ centerFrequencyHz: 500, importanceWeight: 1, modulationTransferFactors: [0.8, 0.7] }, { centerFrequencyHz: 1000, importanceWeight: 2, modulationTransferFactors: [0.9, 0.8] }]);
  assert.ok(sti.screeningIndex > 0.5 && sti.screeningIndex <= 1);
});

test("polar and maximum clean output screens preserve claim boundaries", () => {
  const frequencies = [100, 1000].map((frequencyHz, i) => ({ frequencyHz, levelDb: 90 - i }));
  const polar = polarCharacterization([-30, 0, 30].map(horizontalDeg => ({ horizontalDeg, verticalDeg: 0, response: frequencies.map(point => ({ ...point, levelDb: point.levelDb - Math.abs(horizontalDeg) / 30 })) })));
  assert.equal(polar.rows.length, 2);
  assert.ok(polar.rows[0].directivityIndexDb > 0);
  const output = maximumCleanOutput([{ inputLevelDb: -30, outputLevelDb: 70, coherence: 0.99 }, { inputLevelDb: -20, outputLevelDb: 79, coherence: 0.95 }, { inputLevelDb: -10, outputLevelDb: 85, coherence: 0.5 }]);
  assert.equal(output.maximumCleanOutputDb, 79);
});

test("complex source optimizer uses held-out verification", () => {
  const c = value => ({ re: value, im: 0 });
  const trainMatrices = [[[c(1), c(0.2)], [c(0.4), c(1)]]], heldOutMatrices = [[[c(0.9), c(0.25)], [c(0.45), c(0.95)]]], targets = [[c(1), c(1)]];
  const result = optimizeComplexSources({ trainMatrices, heldOutMatrices, targets, iterations: 1000, regularization: 0.01 });
  assert.equal(result.weights[0].length, 2);
  assert.ok(result.trainingRmsError < 0.2);
  assert.ok(result.heldOutRmsError !== null);
  const physical = optimizePhysicalSourceControls({ frequenciesHz: [100], trainMatrices, heldOutMatrices, targets, constraints: [{ minimumDelayMs: 0, maximumDelayMs: 0, minimumGainDb: -3, maximumGainDb: 3, polarities: [1] }, { minimumDelayMs: 0, maximumDelayMs: 1, delayStepMs: 0.5, minimumGainDb: -3, maximumGainDb: 3, polarities: [1, -1], lowPassHz: 120 }], passes: 2 });
  assert.equal(physical.controls.length, 2);
  assert.equal(physical.constraints.discretePolarity, true);
});

test("FIR designer bounds gain and reports deployment evidence", () => {
  const taps = 64, measuredResponse = Array.from({ length: taps / 2 + 1 }, () => ({ re: 1, im: 0 })), targetResponse = measuredResponse.map(value => ({ ...value }));
  const result = designRegularizedFir({ measuredResponse, targetResponse, taps, latencySamples: 16 });
  assert.equal(result.taps.length, taps);
  assert.equal(result.deploymentGate.requiresMeasuredHardwareVerification, true);
  assert.ok(result.metadata.peak <= 1);
});

test("laboratory listening plans randomize and reports confidence", () => {
  const plan = laboratoryListeningPlan({ method: "MUSHRA", systems: [{ id: "A", role: "hidden-reference" }, { id: "B", role: "anchor" }, { id: "C", role: "candidate" }], trials: 4, listeners: 2, seed: "fixed" });
  assert.equal(plan.ready, true);
  assert.equal(plan.assignments.length, 8);
  const report = laboratoryListeningReport(plan, [{ systemId: "A", score: 90, correct: true, repeatGroup: "x" }, { systemId: "A", score: 92, correct: true, repeatGroup: "x" }, { systemId: "B", score: 30, correct: false }]);
  assert.equal(report.systems.A.mean, 91);
  assert.equal(report.listenerScreening.successes, 2);
});

test("immersive, SOFA, and corpus preflights distinguish metadata from conformance", () => {
  const layout = spatialLayoutAssessment({ channels: [{ label: "L", azimuthDeg: -30, elevationDeg: 0 }, { label: "R", azimuthDeg: 30, elevationDeg: 0 }] });
  assert.equal(layout.valid, true);
  const sofa = sofaMetadataAssessment({ SOFAConventions: "SimpleFreeFieldHRIR", DataType: "FIR", RoomType: "free field", SourcePosition: [[0, 0, 1]], ReceiverPosition: [[0, 0, 0]], DataIR: [[[1]]], SamplingRate: 48000 });
  assert.equal(sofa.valid, true);
  const hash = "a".repeat(64), corpus = evaluationCorpusManifest({ synthetic: [{ id: "synthetic", sha256: hash, availability: "bundled", verified: true }], external: [{ id: "lab-a", domain: "room-rir", sha256: hash, license: "CC-BY", provenance: "Lab A", institutions: ["Institution A"], availability: "local", verified: true, independent: true }], loopbacks: [{ id: "lab-b", domain: "room-rir", sha256: hash, provenance: "Lab B", institutions: ["Institution B"], availability: "local", verified: true, independent: true }] });
  assert.equal(corpus.gates.interLabReady, true);
  assert.equal(corpus.gates.domainReadiness["room-rir"].interLabReady, true);
});

test("scientific kernels reject malformed or unsafe dimensions", () => {
  assert.throws(() => uncertaintyBudget([]));
  assert.throws(() => monteCarloUncertainty([{ uncertainty: 1, distribution: "unknown" }], { trials: 1000 }));
  assert.throws(() => roomAcousticMetrics(Array(128).fill(0), 48000));
  assert.throws(() => polarCharacterization([{ horizontalDeg: 0, response: [{ frequencyHz: 100, levelDb: 1 }, { frequencyHz: 200, levelDb: 2 }] }, { horizontalDeg: 10, response: [{ frequencyHz: 101, levelDb: 1 }, { frequencyHz: 200, levelDb: 2 }] }, { horizontalDeg: 20, response: [{ frequencyHz: 100, levelDb: 1 }, { frequencyHz: 200, levelDb: 2 }] }]));
  assert.throws(() => designRegularizedFir({ measuredResponse: [], targetResponse: [], taps: 63 }));
  assert.throws(() => optimizePhysicalSourceControls({ frequenciesHz: [100], trainMatrices: [[[{ re: 1, im: 0 }]]], targets: [[{ re: 1, im: 0 }]], constraints: [] }));
});

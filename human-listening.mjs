import { bindPlan, crossoverMetrics, frequencyAxis, interpolate, median, parseSeries, stableToken } from "./core.mjs";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = values => { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN; };
const rms = values => { const valid = values.filter(Number.isFinite); return valid.length ? Math.sqrt(mean(valid.map(x => x * x))) : NaN; };
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export const EVIDENCE_REGISTRY = Object.freeze({
  "rew-api": Object.freeze({ type: "official-documentation", title: "Room EQ Wizard API", url: "https://www.roomeqwizard.com/help/help_en-GB/html/api.html", supports: ["measurement and processing API semantics"], doesNotSupport: ["a universal preferred target curve"] }),
  "itu-bs1116": Object.freeze({ type: "recommendation", title: "ITU-R BS.1116 — subjective assessment of small audio impairments", url: "https://www.itu.int/rec/R-REC-BS.1116/en", supports: ["controlled subjective comparison design"], doesNotSupport: ["claiming this home workflow is a conforming laboratory test"] }),
  "itu-bs1534": Object.freeze({ type: "recommendation", title: "ITU-R BS.1534 — MUSHRA", url: "https://www.itu.int/rec/R-REC-BS.1534/en", supports: ["randomized multi-stimulus listening-test concepts"], doesNotSupport: ["using a short A/B test as universal preference evidence"] }),
  "itu-bs1770": Object.freeze({ type: "recommendation", title: "ITU-R BS.1770 — programme loudness and true peak", url: "https://www.itu.int/rec/R-REC-BS.1770/en", supports: ["programme loudness and true-peak handling"], doesNotSupport: ["a loudspeaker or room response target"] }),
  "local-target-policy-v1": Object.freeze({ type: "engineering-policy", title: "Conservative perceptual-target policy v1", url: null, supports: ["versioned reversible starting targets", "cut-first validation workflow"], doesNotSupport: ["objective perfection", "universal listener preference", "speaker capability inference"] })
});

export const TARGET_REGISTRY = Object.freeze({
  "perceptual-neutral-room-v1": Object.freeze({
    id: "perceptual-neutral-room-v1", label: "Perceptual neutral room", deviceClasses: ["general"], classification: "preference-starting-point",
    anchors: [[20, 4], [80, 3], [300, 0.8], [1000, 0], [10000, -1.5], [20000, -3]],
    provenance: ["rew-api", "local-target-policy-v1"],
    caveat: "This is a reversible starting preference, not an audibility standard or proof of correctness."
  }),
  "perceptual-neutral-nearfield-v1": Object.freeze({
    id: "perceptual-neutral-nearfield-v1", label: "Perceptual neutral nearfield", deviceClasses: ["laptop"], classification: "preference-starting-point",
    anchors: [[120, 1.5], [300, 0.7], [1000, 0], [10000, -1], [20000, -2]],
    provenance: ["rew-api", "local-target-policy-v1"],
    caveat: "Do not extend correction below measured acoustic capability or protection filtering."
  }),
  "perceptual-neutral-car-v1": Object.freeze({
    id: "perceptual-neutral-car-v1", label: "Perceptual neutral vehicle cabin", deviceClasses: ["car"], classification: "preference-starting-point",
    anchors: [[20, 6], [80, 5], [300, 1.5], [1000, 0], [10000, -2.5], [20000, -4]],
    provenance: ["rew-api", "local-target-policy-v1"],
    caveat: "Cabin, road-noise, seat, and playback-level effects require measured and listening validation."
  })
});

const DEFAULT_TARGET = Object.freeze({ laptop: "perceptual-neutral-nearfield-v1", car: "perceptual-neutral-car-v1", general: "perceptual-neutral-room-v1" });

export function targetProfile(deviceClass, targetId) {
  const target = TARGET_REGISTRY[targetId || DEFAULT_TARGET[deviceClass]];
  if (!target) throw new Error("Unknown target profile");
  if (!target.deviceClasses.includes(deviceClass)) throw new Error("Target profile is not applicable to this device class");
  return target;
}

export function targetOffsetDb(target, frequencyHz) {
  const anchors = target.anchors;
  if (frequencyHz <= anchors[0][0]) return anchors[0][1];
  if (frequencyHz >= anchors.at(-1)[0]) return anchors.at(-1)[1];
  let i = 1; while (anchors[i][0] < frequencyHz) i++;
  const [f0, g0] = anchors[i - 1], [f1, g1] = anchors[i];
  const t = Math.log(frequencyHz / f0) / Math.log(f1 / f0);
  return g0 + t * (g1 - g0);
}

function magnitudeTrace(trace) { return trace?.frequencyResponse || trace; }
function traceSamples(trace, lowHz, highHz, ppo = 12) {
  const source = magnitudeTrace(trace), magnitude = parseSeries(source?.magnitude), frequencies = frequencyAxis(source || {}, magnitude.length), rows = [];
  if (!magnitude.length || !frequencies.length) return rows;
  for (let f = lowHz; f <= highHz * 1.000001; f *= 2 ** (1 / ppo)) {
    if (f < frequencies[0] || f > frequencies.at(-1)) continue;
    const level = interpolate(frequencies, magnitude, f); if (Number.isFinite(level)) rows.push({ frequencyHz: f, levelDb: level });
  }
  return rows;
}

function normalizedResiduals(trace, target, lowHz, highHz, ppo = 12) {
  const rows = traceSamples(trace, lowHz, highHz, ppo);
  const reference = rows.filter(x => x.frequencyHz >= Math.max(lowHz, 500) && x.frequencyHz <= Math.min(highHz, 2000));
  const offset = median(reference.map(x => x.levelDb - targetOffsetDb(target, x.frequencyHz)));
  return rows.map(x => ({ ...x, targetDb: targetOffsetDb(target, x.frequencyHz) + offset, residualDb: x.levelDb - targetOffsetDb(target, x.frequencyHz) - offset }));
}

export function measurementQuality(traces, { lowHz = 20, highHz = 20000, snrDb, minSnrDb = 15, routeStable = true, dspStable = true, stateVerified = false, microphoneCalibrationHash, expectedTraceCount } = {}) {
  if (!Array.isArray(traces) || !traces.length) throw new Error("At least one trace is required");
  const sampled = traces.map(t => traceSamples(t, lowHz, highHz, 12));
  const expectedPoints = Math.max(1, Math.floor(Math.log2(highHz / lowHz) * 12) + 1);
  const coverage = mean(sampled.map(x => Math.min(1, x.length / expectedPoints)));
  const groups = new Map(); traces.forEach((trace, i) => { const key = `${trace.role || "unspecified"}\u0000${trace.seat || "unspecified"}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(sampled[i]); });
  const repeatabilityGroups = [...groups.values()].filter(group => group.length >= 2).map(group => {
    const deviations = [];
    for (let i = 0; i < expectedPoints; i++) { const levels = group.map(rows => rows[i]?.levelDb).filter(Number.isFinite); if (levels.length !== group.length) continue; const center = mean(levels); deviations.push(Math.sqrt(mean(levels.map(x => (x - center) ** 2)))); }
    return median(deviations);
  });
  const repeatability = repeatabilityGroups.length ? median(repeatabilityGroups) : null;
  const reportedSnr = Number.isFinite(snrDb) ? snrDb : median(traces.map(t => Number(t.snrDb ?? t.signalToNoiseRatioDb)));
  const clipped = traces.some(t => Boolean(t.clipped || t.overload || Number(t.peakDbfs) >= -0.1));
  const reasons = [];
  if (coverage < 0.9) reasons.push("frequency coverage is incomplete");
  if (clipped) reasons.push("clipping or overload was reported");
  if (repeatability !== null && repeatability > 1.5) reasons.push("repeatability exceeds 1.5 dB median standard deviation");
  if (Number.isFinite(reportedSnr) && reportedSnr < minSnrDb) reasons.push(`reported SNR is below the ${minSnrDb} dB session minimum`);
  if (!routeStable) reasons.push("audio routing changed during capture");
  if (!dspStable) reasons.push("DSP state changed during capture");
  if (expectedTraceCount && traces.length !== expectedTraceCount) reasons.push("captured trace count differs from the plan");
  const evidence = [coverage >= 0.9, !clipped, routeStable, dspStable, repeatability === null || repeatability <= 1.5, !Number.isFinite(reportedSnr) || reportedSnr >= 25];
  const confidenceScore = mean(evidence.map(Boolean).map(x => x ? 1 : 0)) * (repeatabilityGroups.length ? 1 : 0.82) * (stateVerified ? 1 : 0.85);
  return {
    accepted: reasons.length === 0, reasons, confidence: confidenceScore >= 0.9 ? "high" : confidenceScore >= 0.7 ? "medium" : "low",
    metrics: { traceCount: traces.length, expectedTraceCount: expectedTraceCount ?? null, coverageRatio: round(coverage, 3), repeatabilitySdDb: round(repeatability), repeatabilityGroupCount: repeatabilityGroups.length, snrDb: round(reportedSnr), minimumSnrDb: minSnrDb, highConfidenceSnrDb: 25, clipped, routeStable, dspStable, stateVerification: stateVerified ? "verified-by-protected-session" : "caller-supplied-or-unknown", microphoneCalibration: microphoneCalibrationHash ? { status: "identified", hash: microphoneCalibrationHash } : { status: "unknown" } },
    warnings: [repeatability === null ? "Repeatability is unknown because no role-and-seat group contains multiple traces." : null, !Number.isFinite(reportedSnr) ? "SNR was not supplied by the measurement chain." : Number.isFinite(reportedSnr) && reportedSnr < 25 && reportedSnr >= minSnrDb ? "SNR passes the session minimum but lowers confidence; repeat or improve the signal-to-noise ratio when practical." : null, !stateVerified ? "Route and DSP stability were not linked to a protected-session state record." : null, !microphoneCalibrationHash ? "Microphone calibration identity is unverified." : null].filter(Boolean)
  };
}

function dimension(name, value, raw, confidence, interpretation) { return { name, score: Number.isFinite(value) ? round(clamp(value, 0, 100), 1) : null, raw, confidence, interpretation }; }
function bandRmse(rows, low, high) { return rms(rows.filter(x => x.frequencyHz >= low && x.frequencyHz <= high).map(x => x.residualDb)); }
function estimateInRoomF3(rows) {
  const reference = median(rows.filter(x => x.frequencyHz >= 200 && x.frequencyHz <= 1000).map(x => x.levelDb));
  const found = rows.find(x => x.levelDb >= reference - 3); return found?.frequencyHz;
}
function nestedSeries(value, names) { for (const name of names) { const found = parseSeries(value?.[name]); if (found.length) return found; } return []; }

export function humanListeningAssessment(traces, { deviceClass = "general", targetId, lowHz, highHz, crossoverHz, microphoneCalibrationHash, routeStable = true, dspStable = true, stateVerified = false, snrDb, minSnrDb } = {}) {
  const target = targetProfile(deviceClass, targetId), floor = lowHz ?? target.anchors[0][0], ceiling = highHz ?? target.anchors.at(-1)[0];
  const quality = measurementQuality(traces, { lowHz: floor, highHz: ceiling, microphoneCalibrationHash, routeStable, dspStable, stateVerified, snrDb, minSnrDb: minSnrDb ?? (deviceClass === "laptop" ? 15 : 20) });
  const residualSets = traces.map(t => normalizedResiduals(t, target, floor, ceiling, 12)).filter(x => x.length);
  const averageRows = residualSets[0]?.map((row, i) => ({ ...row, residualDb: mean(residualSets.map(x => x[i]?.residualDb)) })) || [];
  const estimatedF3 = estimateInRoomF3(averageRows), bassEvaluationFloor = Math.max(floor, estimatedF3 || floor), bassEvaluationCeiling = Math.min(300, ceiling), trebleEvaluationCeiling = Math.min(ceiling, 12000);
  const bassEvaluationBand = bassEvaluationFloor <= bassEvaluationCeiling ? [round(bassEvaluationFloor, 1), bassEvaluationCeiling] : null;
  const bassRmse = bassEvaluationBand ? bandRmse(averageRows, bassEvaluationFloor, bassEvaluationCeiling) : NaN, midRmse = bandRmse(averageRows, Math.max(floor, 300), Math.min(4000, ceiling)), trebleRmse = bandRmse(averageRows, Math.max(floor, 4000), trebleEvaluationCeiling);
  const tonalWeightedError = mean([[bassRmse, 0.3], [midRmse, 0.5], [trebleRmse, 0.2]].filter(([x]) => Number.isFinite(x)).flatMap(([x, weight]) => Array(Math.round(weight * 10)).fill(x)));
  const left = traces.find(t => /(^|[-_ ])l(eft)?($|[-_ ])/i.test(t.role || "")), right = traces.find(t => /(^|[-_ ])r(ight)?($|[-_ ])/i.test(t.role || ""));
  let channelMatchDb = NaN;
  if (left && right) { const a = normalizedResiduals(left, target, Math.max(300, floor), ceiling, 12), b = normalizedResiduals(right, target, Math.max(300, floor), ceiling, 12); channelMatchDb = median(a.map((x, i) => Math.abs(x.residualDb - (b[i]?.residualDb ?? NaN)))); }
  const groupDelayValues = traces.flatMap(t => nestedSeries(t.groupDelay, ["groupDelay", "magnitude", "data"]));
  const groupDelayJitter = groupDelayValues.length > 2 ? Math.sqrt(mean(groupDelayValues.map(x => (x - mean(groupDelayValues)) ** 2))) : NaN;
  const distortionValues = traces.flatMap(t => nestedSeries(t.distortion, ["thd", "THD", "distortion"])).filter(x => x >= 0);
  const distortionMedian = median(distortionValues);
  const rtValues = traces.flatMap(t => nestedSeries(t.rt60, ["rt60", "t20", "t30", "magnitude"])).filter(x => x > 0 && x < 10);
  let crossover = null;
  const main = traces.find(t => /main|front|left|right/i.test(t.role || "")), sub = traces.find(t => /sub/i.test(t.role || ""));
  if (main && sub && crossoverHz) crossover = crossoverMetrics(magnitudeTrace(main), magnitudeTrace(sub), crossoverHz, 0.5);
  const confidence = quality.confidence;
  const dimensions = {
    tonalBalance: dimension("tonal balance", 100 - tonalWeightedError * 12, { bassRmseDb: round(bassRmse), midRmseDb: round(midRmse), trebleRmseDb: round(trebleRmse), evaluationBandsHz: { bass: bassEvaluationBand, mid: [Math.max(floor, 300), Math.min(4000, ceiling)], treble: [Math.max(floor, 4000), trebleEvaluationCeiling] }, targetId: target.id }, confidence, tonalWeightedError <= 2 ? "Broad tonal balance is close to the selected preference target within the capability-bounded evaluation bands." : "Broad tonal deviations are likely audible; inspect placement and stable peaks before EQ."),
    imagingChannelMatch: dimension("imaging and channel match", Number.isFinite(channelMatchDb) ? 100 - channelMatchDb * 20 : NaN, { medianLeftRightDifferenceDb: round(channelMatchDb) }, left && right ? confidence : "unavailable", left && right ? "Lower broad-band left/right mismatch generally supports a more stable phantom image." : "Separate left and right traces were not identified."),
    bassExtension: dimension("bass extension", NaN, { estimatedInRoomF3Hz: round(estimatedF3, 1) }, confidence, "This is an in-room -3 dB estimate, not an anechoic capability or safe boost boundary. Tonal scoring does not penalize response below it."),
    crossoverIntegration: dimension("crossover integration", crossover ? 100 - Math.abs(Math.min(0, crossover.medianSummationDb)) * 18 - crossover.medianPhaseDeltaDeg / 3.6 : NaN, crossover ? { crossoverHz, medianPhaseDeltaDeg: round(crossover.medianPhaseDeltaDeg), medianSummationDb: round(crossover.medianSummationDb) } : {}, crossover ? confidence : "unavailable", crossover ? "Prediction must be confirmed with a measured main-plus-sub trace." : "Main, sub, and crossover metadata were not all supplied."),
    decayResonance: dimension("decay and resonance", rtValues.length ? 100 - Math.sqrt(mean(rtValues.map(x => (x - median(rtValues)) ** 2))) * 100 : NaN, { medianRt60Seconds: round(median(rtValues)), sampleCount: rtValues.length }, rtValues.length ? confidence : "unavailable", rtValues.length ? "Score reflects decay consistency, not a universal ideal RT60 for every room." : "No usable decay trace was available."),
    distortionCompression: dimension("distortion and compression", distortionValues.length ? 100 - 35 * Math.log10(1 + median(distortionValues)) : NaN, { medianThdPercent: round(distortionMedian), sampleCount: distortionValues.length }, distortionValues.length ? confidence : "unavailable", distortionValues.length ? "THD is reported in percent; audibility still depends on spectrum, frequency, programme, and playback level." : "No percent-THD or level-ladder evidence was available."),
    timing: dimension("timing", Number.isFinite(groupDelayJitter) ? 100 - groupDelayJitter * 8 : NaN, { groupDelaySpreadMs: round(groupDelayJitter) }, Number.isFinite(groupDelayJitter) ? confidence : "unavailable", Number.isFinite(groupDelayJitter) ? "Inspect unsmoothed excess/group delay before attributing audibility." : "No group-delay trace was available."),
    measurementConfidence: dimension("measurement confidence", quality.confidence === "high" ? 100 : quality.confidence === "medium" ? 70 : 40, quality.metrics, quality.confidence, quality.accepted ? "Measurements passed the available objective quality gates." : "Fix rejected measurement conditions before accepting tuning conclusions.")
  };
  return { schemaVersion: 1, target, quality, dimensions, globalScore: null, globalScoreReason: "A single sound-quality score would hide coverage, uncertainty, and listener preference.", evidenceBoundary: { facts: "Raw REW-derived metrics", calculations: "Documented deterministic transforms", interpretation: "Audibility-oriented engineering inference", preference: `Selected target ${target.id}` } };
}

function peakingMagnitudeDb(frequencyHz, filter, sampleRateHz = 48000) {
  const A = 10 ** (filter.gainDb / 40), w0 = 2 * Math.PI * filter.frequencyHz / sampleRateHz, alpha = Math.sin(w0) / (2 * filter.q), c0 = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * c0, b2 = 1 - alpha * A, a0 = 1 + alpha / A, a1 = -2 * c0, a2 = 1 - alpha / A;
  const w = 2 * Math.PI * frequencyHz / sampleRateHz, numerator = Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), -b1 * Math.sin(w) - b2 * Math.sin(2 * w)), denominator = Math.hypot(a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), -a1 * Math.sin(w) - a2 * Math.sin(2 * w));
  return 20 * Math.log10(numerator / denominator);
}
function applyFilters(rows, filters, sampleRateHz) { return rows.map(x => ({ ...x, residualDb: x.residualDb + filters.reduce((sum, f) => sum + peakingMagnitudeDb(x.frequencyHz, f, sampleRateHz), 0) })); }

export function perceptualEqProposal(traces, { deviceClass = "general", targetId, lowHz, highHz, maxCutDb = 6, maxFilters = 10, validationCount = 1, minCorrectionDb = 1.25, maxSpatialSpreadDb = 2.5, maxQ = 4, minValidationImprovementDb = 0.25, sampleRateHz = 48000 } = {}) {
  if (!Array.isArray(traces) || !traces.length) throw new Error("At least one trace is required");
  const target = targetProfile(deviceClass, targetId), floor = lowHz ?? target.anchors[0][0], ceiling = highHz ?? Math.min(target.anchors.at(-1)[0], 16000);
  const useValidation = traces.length > 1 ? clamp(validationCount, 1, traces.length - 1) : 0, training = traces.slice(0, traces.length - useValidation), validation = useValidation ? traces.slice(-useValidation) : [];
  const sets = training.map(t => normalizedResiduals(t, target, floor, ceiling, 12));
  const curve = (sets[0] || []).map((row, i) => {
    const values = sets.map(x => x[i]?.residualDb).filter(Number.isFinite), peak = mean(values), spread = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
    return { index: i, frequencyHz: row.frequencyHz, deviationDb: peak, spreadDb: spread };
  }), candidates = curve.filter((x, i, all) => x.deviationDb >= minCorrectionDb && x.spreadDb <= maxSpatialSpreadDb && x.deviationDb >= (all[i - 1]?.deviationDb ?? -Infinity) && x.deviationDb >= (all[i + 1]?.deviationDb ?? -Infinity)).sort((a, b) => b.deviationDb - a.deviationDb);
  const selected = [];
  for (const c of candidates) {
    if (selected.some(x => Math.abs(Math.log2(x.frequencyHz / c.frequencyHz)) < 0.25)) continue;
    const halfHeight = c.deviationDb / 2; let left = c.index, right = c.index; while (left > 0 && curve[left].deviationDb > halfHeight) left--; while (right < curve.length - 1 && curve[right].deviationDb > halfHeight) right++; const bandwidthHz = Math.max(1, curve[right].frequencyHz - curve[left].frequencyHz), q = clamp(c.frequencyHz / bandwidthHz, 0.5, maxQ);
    selected.push({ type: "PK", frequencyHz: Math.round(c.frequencyHz), gainDb: round(-Math.min(maxCutDb, c.deviationDb * 0.8), 1), q: round(q, 2), evidence: { stablePeakDb: round(c.deviationDb), trainingSpreadDb: round(c.spreadDb), estimatedHalfHeightBandwidthHz: round(bandwidthHz, 1) } });
    if (selected.length >= maxFilters) break;
  }
  const evaluate = source => {
    const rows = source.flatMap(t => normalizedResiduals(t, target, floor, ceiling, 12)), before = rms(rows.map(x => x.residualDb)), after = rms(applyFilters(rows, selected, sampleRateHz).map(x => x.residualDb));
    return { beforeRmseDb: round(before), predictedAfterRmseDb: round(after), improvementDb: round(before - after) };
  };
  const trainingResult = evaluate(training), validationResult = validation.length ? evaluate(validation) : null;
  const accepted = selected.length > 0 && trainingResult.improvementDb >= minValidationImprovementDb && (!validationResult || validationResult.improvementDb >= minValidationImprovementDb), status = !accepted ? "proposal-rejected" : validationResult ? "proposal-cross-validated" : "proposal-unvalidated";
  return { schemaVersion: 1, status, target, filters: accepted ? selected : [], proposedFilters: selected, training: trainingResult, withheldValidation: validationResult, predictionModel: { type: "RBJ peaking-biquad magnitude", sampleRateHz, acousticVerification: "required" }, constraints: { cutOnly: true, maxCutDb, maxFilters, maxQ, minCorrectionDb, minValidationImprovementDb, maxSpatialSpreadDb, correctionRangeHz: [floor, ceiling], preampHeadroomDb: 0 }, warnings: [validation.length ? null : "No withheld trace was available; the proposal is unvalidated and must not be auto-applied.", "Held-out validation tests generalization of the modelled filter response; it is not a post-change acoustic measurement.", "Do not use this proposal to fill narrow or spatial cancellations.", "Verify predicted improvement with level-matched before/after measurements."].filter(Boolean) };
}

export function compressionMetrics(traces, levelsDbfs) {
  if (traces.length < 2 || traces.length !== levelsDbfs.length) throw new Error("Matching traces and sweep levels are required");
  const order = traces.map((trace, i) => ({ trace, level: levelsDbfs[i] })).sort((a, b) => a.level - b.level), base = traceSamples(order[0].trace, 20, 20000, 12), rows = [];
  for (let i = 1; i < order.length; i++) {
    const current = traceSamples(order[i].trace, 20, 20000, 12), expected = order[i].level - order[0].level;
    rows.push(...base.map((x, j) => ({ frequencyHz: round(x.frequencyHz, 1), sweepLevelDbfs: order[i].level, expectedIncreaseDb: expected, measuredIncreaseDb: round((current[j]?.levelDb ?? NaN) - x.levelDb), compressionDb: round(expected - ((current[j]?.levelDb ?? NaN) - x.levelDb) ) })).filter(x => Number.isFinite(x.compressionDb)));
  }
  return { medianCompressionDb: round(median(rows.map(x => x.compressionDb))), worstBands: [...rows].sort((a, b) => b.compressionDb - a.compressionDb).slice(0, 12), rows, interpretation: "Positive compression means output increased less than the sweep-level change; confirm that gain, limiting, noise, and routing were unchanged." };
}

export function guidedSessionPlan({ name, deviceClass, mode = "guided", measurementProfile = "standard", targetId, outputChannels = [], home } = {}) {
  const profiles = { quick: { repetitions: 2, sweepLength: "256k" }, standard: { repetitions: 4, sweepLength: "512k" }, reference: { repetitions: 6, sweepLength: "1M" } };
  if (!profiles[measurementProfile]) throw new Error("Unknown measurement profile");
  const target = targetProfile(deviceClass, targetId);
  return bindPlan({ schemaVersion: 1, kind: "guided-audio-session", createdAt: new Date().toISOString(), name, deviceClass, mode, measurementProfile, measurement: profiles[measurementProfile], targetId: target.id, outputChannels, home, state: "planned", stages: ["inventory", "route-and-dsp-snapshot", "microphone-calibration-and-level-check", "protected-repeated-measurements", "quality-gate", "human-listening-assessment", "physical-fix-review", "cross-validated-eq-proposal", "hash-bound-dsp-apply", "post-change-measurement", "level-matched-listening-test", "report"] });
}

export function listeningTestPlan({ presetA, presetB, presetFingerprintA, presetFingerprintB, mode = "ABX", trials = 8, levelMatchedWithinDb = 0.2, measuredLevelDifferenceDb, programExcerpts = [], playbackChainFingerprint, seed } = {}) {
  if (!presetA || !presetB || presetA === presetB) throw new Error("Two distinct presets are required");
  if (presetFingerprintA && presetFingerprintB && presetFingerprintA === presetFingerprintB) throw new Error("Preset fingerprints must identify different DSP states");
  const levelMatchVerified = Number.isFinite(measuredLevelDifferenceDb) && Math.abs(measuredLevelDifferenceDb) <= levelMatchedWithinDb;
  const resolvedSeed = seed || stableToken({ presetA, presetB, mode, trials, createdAt: Date.now() }), assignments = [];
  for (let i = 0; i < trials; i++) { const bit = parseInt(stableToken({ resolvedSeed, i }).slice(0, 2), 16) % 2; assignments.push({ trial: i + 1, referenceOrder: bit ? ["B", "A"] : ["A", "B"], hiddenX: mode === "ABX" ? (bit ? "A" : "B") : null }); }
  return bindPlan({ schemaVersion: 2, kind: "listening-test", mode, presetA, presetB, presetFingerprintA: presetFingerprintA || null, presetFingerprintB: presetFingerprintB || null, trials, levelMatchedWithinDb, measuredLevelDifferenceDb: round(measuredLevelDifferenceDb), levelMatchVerified, ready: levelMatchVerified && Boolean(playbackChainFingerprint) && programExcerpts.length > 0, programExcerpts, playbackChainFingerprint: playbackChainFingerprint || null, seedHash: stableToken(resolvedSeed), assignments, instructions: ["Do not begin until measured level difference is within the bound.", "Randomize presentation without showing the listener the assignment.", "Use the recorded program excerpts, playback chain, level, and listening position.", "Record preference and confidence without coaching."] });
}

export function listeningTestReport(plan, responses) {
  const unsigned = plan?.confirmationToken ? (({ confirmationToken, ...rest }) => rest)(plan) : plan;
  if (unsigned?.kind !== "listening-test" || !Array.isArray(responses)) throw new Error("A listening-test plan and responses are required");
  const usable = responses.filter(x => Number.isInteger(x.trial) && /^(A|B|same)$/i.test(x.choice || ""));
  if (unsigned.mode === "ABX") {
    const scored = usable.filter(x => /^(A|B)$/i.test(x.choice)).map(x => ({ ...x, answer: unsigned.assignments.find(a => a.trial === x.trial)?.hiddenX })).filter(x => x.answer), correct = scored.filter(x => x.choice.toUpperCase() === x.answer).length, n = scored.length, p = n ? correct / n : NaN, z = n ? (correct - n / 2) / Math.sqrt(n / 4) : NaN;
    return { mode: "ABX", trialsPlanned: unsigned.trials, trialsCompleted: usable.length, scoredTrials: n, correct, correctFraction: round(p, 3), approximateChanceZ: round(z), preference: null, conclusion: n >= 8 && p >= 0.75 ? "The listener may discriminate the presets under this test; replicate before generalizing." : "Discrimination evidence is inconclusive or too limited.", boundary: "ABX tests identity discrimination, not which preset is preferred or universally better." };
  }
  const a = usable.filter(x => /^A$/i.test(x.choice)).length, b = usable.filter(x => /^B$/i.test(x.choice)).length, same = usable.length - a - b, decisive = a + b, p = decisive ? Math.max(a, b) / decisive : NaN;
  const standardError = decisive ? Math.sqrt(0.25 / decisive) : NaN;
  return { trialsPlanned: unsigned.trials, trialsCompleted: usable.length, preference: a === b ? "inconclusive" : a > b ? unsigned.presetA : unsigned.presetB, counts: { presetA: a, presetB: b, same }, majorityFraction: round(p, 3), approximateChanceZ: round(decisive ? (Math.max(a, b) - decisive / 2) / Math.sqrt(decisive / 4) : NaN), confidenceIntervalApprox: Number.isFinite(p) ? [round(clamp(p - 1.96 * standardError, 0, 1), 3), round(clamp(p + 1.96 * standardError, 0, 1), 3)] : null, conclusion: decisive >= 8 && Number.isFinite(p) && p >= 0.75 ? "A repeatable preference may be present; repeat on different material before generalizing." : "Preference evidence is inconclusive or too limited to generalize.", boundary: "This records listener preference under this test, not universal sound quality." };
}

export function exportFilters(filters, format = "rew-generic") {
  if (!Array.isArray(filters) || !filters.every(f => f.type === "PK" && Number.isFinite(f.frequencyHz) && Number.isFinite(f.gainDb) && Number.isFinite(f.q))) throw new Error("Only validated PK filters are exportable");
  const preamp = Math.max(0, ...filters.map(x => x.gainDb));
  if (format === "json") return JSON.stringify({ schemaVersion: 1, preampDb: -preamp, filters }, null, 2) + "\n";
  if (format === "camilladsp-yaml") return `filters:\n${filters.map((f, i) => `  eq_${i + 1}:\n    type: Biquad\n    parameters:\n      type: Peaking\n      freq: ${f.frequencyHz}\n      gain: ${f.gainDb}\n      q: ${f.q}`).join("\n")}\n`;
  const header = format === "equalizer-apo" ? `Preamp: ${round(-preamp, 1)} dB\n` : "";
  return header + filters.map((f, i) => `Filter ${i + 1}: ON PK Fc ${f.frequencyHz} Hz Gain ${f.gainDb} dB Q ${f.q}`).join("\n") + "\n";
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
function resolutionChartSvg(views) {
  const definitions = [["raw", "Raw / unsmoothed", "#d9485f"], ["minimal", "1/48 octave", "#2f77d0"], ["perceptual", "ERB perceptual", "#15956f"], ["adaptive", "Frequency-dependent", "#8b5cf6"]], series = definitions.map(([key, label, color]) => ({ key, label, color, rows: (views?.[key] || []).filter(x => Number.isFinite(x.frequencyHz) && Number.isFinite(x.levelDb) && x.frequencyHz > 0) })).filter(x => x.rows.length);
  if (!series.length) return "";
  const all = series.flatMap(x => x.rows), minF = Math.min(...all.map(x => x.frequencyHz)), maxF = Math.max(...all.map(x => x.frequencyHz)), minDb = Math.min(...all.map(x => x.levelDb)) - 2, maxDb = Math.max(...all.map(x => x.levelDb)) + 2, width = 920, height = 380, left = 56, right = 20, top = 24, bottom = 42, x = f => left + Math.log(f / minF) / Math.log(maxF / minF) * (width - left - right), y = db => top + (maxDb - db) / (maxDb - minDb || 1) * (height - top - bottom), downsample = rows => rows.length <= 600 ? rows : rows.filter((_, i) => i % Math.ceil(rows.length / 600) === 0);
  const gridF = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f >= minF && f <= maxF), gridDb = Array.from({ length: 7 }, (_, i) => minDb + i * (maxDb - minDb) / 6);
  return `<figure><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Raw, lightly smoothed, perceptual, and frequency-dependent response curves" style="width:100%;height:auto;background:#fff;border:1px solid #ddd">${gridF.map(f => `<line x1="${x(f)}" y1="${top}" x2="${x(f)}" y2="${height - bottom}" stroke="#e5e7eb"/><text x="${x(f)}" y="${height - 16}" text-anchor="middle" font-size="11">${f >= 1000 ? `${f / 1000}k` : f}</text>`).join("")}${gridDb.map(db => `<line x1="${left}" y1="${y(db)}" x2="${width - right}" y2="${y(db)}" stroke="#eef0f2"/><text x="${left - 7}" y="${y(db) + 4}" text-anchor="end" font-size="11">${round(db, 1)}</text>`).join("")}${series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${downsample(s.rows).map(p => `${round(x(p.frequencyHz), 1)},${round(y(p.levelDb), 1)}`).join(" ")}"/>`).join("")}</svg><figcaption>${series.map(s => `<span style="margin-right:1rem;color:${s.color}">● ${escapeHtml(s.label)}</span>`).join("")}</figcaption></figure>`;
}
export function renderHumanReport({ title = "Audio Calibration Report", assessment, eq, listening, resolutionViews } = {}) {
  if (!assessment?.dimensions) throw new Error("A human-listening assessment is required");
  const lines = [`# ${title}`, "", `Target: ${assessment.target.label} (${assessment.target.classification})`, `Measurement confidence: ${assessment.quality.confidence}`, "", "## Listening-relevant dimensions", ""];
  for (const item of Object.values(assessment.dimensions)) lines.push(`- ${item.name}: ${item.score ?? "not scored"}/100 — ${item.interpretation}`);
  lines.push("", "## Evidence boundary", "", `- Facts: ${assessment.evidenceBoundary.facts}`, `- Calculations: ${assessment.evidenceBoundary.calculations}`, `- Interpretation: ${assessment.evidenceBoundary.interpretation}`, `- Preference: ${assessment.evidenceBoundary.preference}`);
  if (resolutionViews) lines.push("", "## Resolution views", "", "The HTML report overlays raw/unsmoothed, 1/48-octave, ERB-perceptual, and frequency-dependent curves. The JSON report preserves the plotted samples.");
  if (eq) lines.push("", "## EQ proposal", "", `Status: ${eq.status}; filters: ${eq.filters?.length ?? 0}; withheld improvement: ${eq.withheldValidation?.improvementDb ?? "not available"} dB RMSE.`);
  if (listening) lines.push("", "## Listening test", "", `${listening.preference}: ${listening.conclusion}`);
  const markdown = lines.join("\n") + "\n", chart = resolutionChartSvg(resolutionViews), html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;line-height:1.5}li{margin:.5rem 0}figure{margin:1.5rem 0}figcaption{font-size:.9rem;margin-top:.5rem}</style><body>${lines.map(line => line.startsWith("# ") ? `<h1>${escapeHtml(line.slice(2))}</h1>` : line.startsWith("## ") ? `<h2>${escapeHtml(line.slice(3))}</h2>${line === "## Resolution views" ? chart : ""}` : line.startsWith("- ") ? `<li>${escapeHtml(line.slice(2))}</li>` : line ? `<p>${escapeHtml(line)}</p>` : "").join("\n")}</body>`;
  return { markdown, html, json: { schemaVersion: 2, title, assessment, eq: eq || null, listening: listening || null, resolutionViews: resolutionViews || null } };
}

export const humanListeningInternals = { traceSamples, normalizedResiduals, peakingMagnitudeDb, applyFilters, estimateInRoomF3 };

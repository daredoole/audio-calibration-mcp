import { frequencyAxis, interpolate, parseSeries, stableToken } from "./core.mjs";
import { humanListeningInternals, perceptualEqProposal } from "./human-listening.mjs";

const finite = values => values.filter(Number.isFinite);
const mean = values => { const x = finite(values); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN; };
const rms = values => Math.sqrt(mean(finite(values).map(x => x * x)));
const median = values => { const x = finite(values).sort((a, b) => a - b); return x.length ? (x[Math.floor((x.length - 1) / 2)] + x[Math.floor(x.length / 2)]) / 2 : NaN; };
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const magnitudeRows = trace => {
  const magnitude = parseSeries(trace?.magnitude), frequencies = frequencyAxis(trace || {}, magnitude.length);
  return magnitude.map((levelDb, i) => ({ frequencyHz: frequencies[i], levelDb })).filter(x => Number.isFinite(x.frequencyHz) && Number.isFinite(x.levelDb) && x.frequencyHz > 0);
};
export function traceViewRows(trace, { lowHz = 20, highHz = 20000, maxPoints = 600 } = {}) {
  const rows = magnitudeRows(trace).filter(x => x.frequencyHz >= lowHz && x.frequencyHz <= highHz), stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  return rows.filter((_, i) => i % stride === 0).map(x => ({ frequencyHz: round(x.frequencyHz, 1), levelDb: round(x.levelDb, 3) }));
}

export const erbNumber = frequencyHz => 21.4 * Math.log10(1 + 0.00437 * frequencyHz);
export const frequencyFromErb = erb => (10 ** (erb / 21.4) - 1) / 0.00437;
export function frequencyAudibilityThresholdDb(frequencyHz) {
  if (frequencyHz < 80) return 2;
  if (frequencyHz < 200) return 1.5;
  if (frequencyHz <= 6000) return 1;
  if (frequencyHz <= 12000) return 1.5;
  return 2;
}

export function erbSmooth(trace, { lowHz = 20, highHz = 20000, stepErb = 0.5, widthErb = 1 } = {}) {
  const rows = magnitudeRows(trace).filter(x => x.frequencyHz >= lowHz && x.frequencyHz <= highHz);
  if (!rows.length) return { rows: [], method: "ERB Gaussian power average" };
  const source = rows.map(x => ({ ...x, erb: erbNumber(x.frequencyHz), power: 10 ** (x.levelDb / 10) }));
  const start = erbNumber(Math.max(lowHz, rows[0].frequencyHz)), end = erbNumber(Math.min(highHz, rows.at(-1).frequencyHz)), output = [];
  for (let center = start; center <= end + 1e-9; center += stepErb) {
    let weighted = 0, weights = 0;
    for (const row of source) { const z = (row.erb - center) / widthErb, weight = Math.exp(-0.5 * z * z); weighted += row.power * weight; weights += weight; }
    if (weights > 0) output.push({ frequencyHz: round(frequencyFromErb(center), 1), levelDb: round(10 * Math.log10(weighted / weights), 3), audibilityThresholdDb: frequencyAudibilityThresholdDb(frequencyFromErb(center)) });
  }
  return { rows: output, method: "ERB Gaussian power average", stepErb, widthErb, boundary: "Audibility thresholds are conservative workflow heuristics, not universal just-noticeable-difference claims." };
}

export function engineeringTraceSummary(trace, { lowHz = 20, highHz = 20000 } = {}) {
  const rows = magnitudeRows(trace).filter(x => x.frequencyHz >= lowHz && x.frequencyHz <= highHz), candidates = [], prefix = [0];
  for (const row of rows) prefix.push(prefix.at(-1) + row.levelDb);
  let left = 0, right = 0;
  for (let i = 0; i < rows.length; i++) {
    const center = rows[i], low = center.frequencyHz / 2 ** (1 / 12), high = center.frequencyHz * 2 ** (1 / 12); while (left < rows.length && rows[left].frequencyHz < low) left++; right = Math.max(right, i + 1); while (right < rows.length && rows[right].frequencyHz <= high) right++; const count = right - left - 1, local = count > 0 ? (prefix[right] - prefix[left] - center.levelDb) / count : NaN, deviationDb = center.levelDb - local;
    if (Number.isFinite(deviationDb) && Math.abs(deviationDb) >= 1.5) candidates.push({ frequencyHz: round(center.frequencyHz, 1), deviationFromLocalDb: round(deviationDb), kind: deviationDb > 0 ? "narrow-peak-candidate" : "narrow-dip-candidate" });
  }
  candidates.sort((a, b) => Math.abs(b.deviationFromLocalDb) - Math.abs(a.deviationFromLocalDb));
  return { pointCount: rows.length, frequencyRangeHz: rows.length ? [round(rows[0].frequencyHz, 1), round(rows.at(-1).frequencyHz, 1)] : null, levelRangeDb: rows.length ? [round(Math.min(...rows.map(x => x.levelDb))), round(Math.max(...rows.map(x => x.levelDb)))] : null, narrowFeatureCandidates: candidates.slice(0, 20), boundary: "Candidates require repeatability, phase/time inspection, and audibility context before correction." };
}

export function frequencyDependentSmooth(trace, { lowHz = 20, highHz = 20000, modalBoundaryHz = 200, transitionHz = 1000, ppo = 24 } = {}) {
  if (transitionHz <= modalBoundaryHz) throw new Error("Transition frequency must exceed the modal boundary");
  const source = magnitudeRows(trace).filter(x => x.frequencyHz >= lowHz / 1.5 && x.frequencyHz <= highHz * 1.5).map(x => ({ ...x, power: 10 ** (x.levelDb / 10) })), rows = [];
  for (let center = lowHz; center <= highHz * 1.000001; center *= 2 ** (1 / ppo)) {
    let bandwidthOctaves, regime;
    if (center <= modalBoundaryHz) { bandwidthOctaves = 1 / 48; regime = "modal-high-resolution"; }
    else if (center < transitionHz) { const mix = Math.log(center / modalBoundaryHz) / Math.log(transitionHz / modalBoundaryHz); bandwidthOctaves = (1 / 48) * (1 - mix) + (1 / 12) * mix; regime = "transition"; }
    else if (center < 8000) { const erbBandwidthHz = 24.7 * (4.37 * center / 1000 + 1); bandwidthOctaves = Math.max(1 / 12, Math.log2((center + erbBandwidthHz / 2) / Math.max(1, center - erbBandwidthHz / 2))); regime = "ERB-perceptual"; }
    else { bandwidthOctaves = 1 / 6; regime = "high-frequency-perceptual"; }
    const sigma = bandwidthOctaves / 2.355; let weighted = 0, weights = 0;
    for (const point of source) { const z = Math.log2(point.frequencyHz / center) / sigma, weight = Math.exp(-0.5 * z * z); if (weight < 1e-6) continue; weighted += point.power * weight; weights += weight; }
    if (weights > 0) rows.push({ frequencyHz: round(center, 1), levelDb: round(10 * Math.log10(weighted / weights), 3), effectiveBandwidthOctaves: round(bandwidthOctaves, 4), regime, audibilityThresholdDb: frequencyAudibilityThresholdDb(center) });
  }
  return { rows, modalBoundaryHz, transitionHz, ppo, method: "frequency-dependent Gaussian power average", boundary: "Modal boundary and smoothing transition are explicit workflow parameters, not automatically inferred room constants." };
}

function impulseSeries(trace) {
  for (const key of ["impulse", "impulseResponse", "ir", "magnitude", "data", "samples"]) { const values = parseSeries(trace?.[key]); if (values.length) return values; }
  return parseSeries(trace);
}
function windowedSpectrum(samples, start, end, sampleRateHz, lowHz, highHz, ppo = 12) {
  const length = end - start, rows = [];
  if (length < 8) return rows;
  for (let frequencyHz = Math.max(lowHz, sampleRateHz / length); frequencyHz <= Math.min(highHz, sampleRateHz / 2); frequencyHz *= 2 ** (1 / ppo)) {
    let real = 0, imaginary = 0, weight = 0;
    for (let n = 0; n < length; n++) { const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / Math.max(1, length - 1)), angle = 2 * Math.PI * frequencyHz * n / sampleRateHz, value = samples[start + n] * window; real += value * Math.cos(angle); imaginary -= value * Math.sin(angle); weight += window; }
    rows.push({ frequencyHz: round(frequencyHz, 1), levelDb: round(20 * Math.log10(Math.max(1e-30, 2 * Math.hypot(real, imaginary) / Math.max(weight, 1e-30))), 3) });
  }
  return rows;
}
export function directLateWindowAnalysis(trace, { sampleRateHz = 48000, prePeakMs = 1, directWindowMs = 5, lateWindowMs = 80, lowHz = 20, highHz = 20000, ppo = 12 } = {}) {
  if (lateWindowMs <= directWindowMs) throw new Error("Late-window endpoint must follow the direct window");
  const samples = impulseSeries(trace);
  if (samples.length < 16) throw new Error("A usable impulse response is required");
  let peakIndex = 0; for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]) > Math.abs(samples[peakIndex])) peakIndex = i;
  const msToSamples = ms => Math.max(0, Math.round(ms * sampleRateHz / 1000)), start = Math.max(0, peakIndex - msToSamples(prePeakMs)), directEnd = Math.min(samples.length, peakIndex + msToSamples(directWindowMs)), lateEnd = Math.min(samples.length, peakIndex + msToSamples(lateWindowMs));
  const energy = (a, b) => samples.slice(a, b).reduce((sum, x) => sum + x * x, 0), directEnergy = energy(start, directEnd), lateEnergy = energy(directEnd, lateEnd), totalEnergy = directEnergy + lateEnergy;
  return { peakIndex, peakTimeMs: round(peakIndex * 1000 / sampleRateHz, 4), windowsMs: { prePeakMs, directWindowMs, lateWindowMs }, directEnergyFraction: round(directEnergy / totalEnergy, 4), lateEnergyFraction: round(lateEnergy / totalEnergy, 4), directToLateDb: round(10 * Math.log10(Math.max(directEnergy, 1e-30) / Math.max(lateEnergy, 1e-30))), spectra: { direct: windowedSpectrum(samples, start, directEnd, sampleRateHz, lowHz, highHz, ppo), late: windowedSpectrum(samples, directEnd, lateEnd, sampleRateHz, lowHz, highHz, ppo), directReliabilityFloorHz: round(sampleRateHz / Math.max(1, directEnd - start), 1), lateReliabilityFloorHz: round(sampleRateHz / Math.max(1, lateEnd - directEnd), 1), ppo }, boundary: "Window choice and time-frequency resolution change the result; inspect the impulse and room geometry before interpreting reflections." };
}

export function measurementStateFingerprint({ route, volume, dsp, microphone, preset, rew, sweep } = {}) {
  const state = { route: route ?? null, volume: volume ?? null, dsp: dsp ?? null, microphone: microphone ?? null, preset: preset ?? null, rew: rew ?? null, sweep: sweep ?? null };
  const controlState = { route: state.route, volume: state.volume, microphone: state.microphone, rew: state.rew, sweep: state.sweep };
  return { state, fingerprint: stableToken(state), controlState, controlFingerprint: stableToken(controlState), complete: Object.values(state).every(value => value !== null), capturedFields: Object.keys(state).filter(key => state[key] !== null) };
}

const octaveDistance = (a, b) => Math.abs(Math.log2(a / b));
export function linkedStereoEqProposal(leftTraces, rightTraces, options = {}) {
  if (leftTraces.length < 2 || rightTraces.length < 2) throw new Error("At least two repeated traces per channel are required for linked stereo EQ");
  const left = options.leftProposal || perceptualEqProposal(leftTraces, options), right = options.rightProposal || perceptualEqProposal(rightTraces, options), maxInterchannelGainDeltaDb = options.maxInterchannelGainDeltaDb ?? 1, regularization = clamp(options.regularization ?? 0.75, 0, 1), pairs = [];
  for (const lf of left.proposedFilters) {
    const rf = right.proposedFilters.filter(x => octaveDistance(x.frequencyHz, lf.frequencyHz) <= 1 / 6).sort((a, b) => octaveDistance(a.frequencyHz, lf.frequencyHz) - octaveDistance(b.frequencyHz, lf.frequencyHz))[0];
    if (!rf || pairs.some(x => x.right === rf)) continue;
    const commonFrequency = Math.sqrt(lf.frequencyHz * rf.frequencyHz), commonGain = (lf.gainDb + rf.gainDb) / 2, halfDelta = clamp((lf.gainDb - rf.gainDb) * (1 - regularization) / 2, -maxInterchannelGainDeltaDb / 2, maxInterchannelGainDeltaDb / 2), commonQ = Math.min(lf.q, rf.q, options.maxQ ?? 4);
    pairs.push({ left: lf, right: rf, linked: { frequencyHz: Math.round(commonFrequency), leftGainDb: round(commonGain + halfDelta, 1), rightGainDb: round(commonGain - halfDelta, 1), q: round(commonQ, 2) } });
  }
  const candidateFilters = {
    left: pairs.map(x => ({ type: "PK", frequencyHz: x.linked.frequencyHz, gainDb: x.linked.leftGainDb, q: x.linked.q })),
    right: pairs.map(x => ({ type: "PK", frequencyHz: x.linked.frequencyHz, gainDb: x.linked.rightGainDb, q: x.linked.q }))
  };
  const evaluate = (traces, filters, target) => {
    const count = clamp(options.validationCount ?? 1, 1, traces.length - 1), training = traces.slice(0, -count), validation = traces.slice(-count), floor = options.lowHz ?? target.anchors[0][0], ceiling = options.highHz ?? Math.min(target.anchors.at(-1)[0], 16000), run = source => {
      const rows = source.flatMap(trace => humanListeningInternals.normalizedResiduals(trace, target, floor, ceiling, 12)), before = rms(rows.map(x => x.residualDb)), after = rms(humanListeningInternals.applyFilters(rows, filters, options.sampleRateHz ?? 48000).map(x => x.residualDb));
      return { beforeRmseDb: round(before), predictedAfterRmseDb: round(after), improvementDb: round(before - after) };
    };
    return { training: run(training), withheldValidation: run(validation) };
  };
  const linkedValidation = { left: evaluate(leftTraces, candidateFilters.left, left.target), right: evaluate(rightTraces, candidateFilters.right, right.target) }, minimum = options.minValidationImprovementDb ?? 0.25;
  const linkedResolutionValidation = options.leftRawTraces && options.rightRawTraces ? {
    left: { raw: representationValidation(options.leftRawTraces.map(asFrequencyTrace), candidateFilters.left, left.target, options), minimal: representationValidation(leftTraces.map(asFrequencyTrace), candidateFilters.left, left.target, options), perceptual: representationValidation(options.leftRawTraces.map(x => erbFrequencyTrace(x, { lowHz: options.lowHz, highHz: options.highHz, stepErb: 0.5, widthErb: 1 })), candidateFilters.left, left.target, options) },
    right: { raw: representationValidation(options.rightRawTraces.map(asFrequencyTrace), candidateFilters.right, right.target, options), minimal: representationValidation(rightTraces.map(asFrequencyTrace), candidateFilters.right, right.target, options), perceptual: representationValidation(options.rightRawTraces.map(x => erbFrequencyTrace(x, { lowHz: options.lowHz, highHz: options.highHz, stepErb: 0.5, widthErb: 1 })), candidateFilters.right, right.target, options) }
  } : null;
  const linkedPasses = Object.values(linkedValidation).every(channel => channel.training.improvementDb >= minimum && channel.withheldValidation.improvementDb >= minimum) && (!linkedResolutionValidation || Object.values(linkedResolutionValidation).flatMap(Object.values).every(channel => channel.training.improvementDb >= minimum && channel.withheldValidation.improvementDb >= minimum)), validated = /cross-validated/.test(left.status) && /cross-validated/.test(right.status) && linkedPasses, filters = validated ? candidateFilters : { left: [], right: [] };
  return { status: validated && pairs.length ? (linkedResolutionValidation ? "proposal-cross-validated-multiresolution" : "proposal-cross-validated") : "proposal-rejected", filters, proposedFilters: candidateFilters, candidates: pairs.map(x => x.linked), channelModels: { left, right }, linkedValidation, linkedResolutionValidation, constraints: { linkedCenters: true, regularization, maxInterchannelGainDeltaDb, validationRequiredPerChannel: true, multiresolutionValidationRequired: Boolean(linkedResolutionValidation), minimumImprovementDb: minimum }, warning: "Linked stereo constraints preserve image stability; measured post-application verification remains mandatory." };
}

function asFrequencyTrace(trace) { return trace?.frequencyResponse || trace; }
function erbFrequencyTrace(trace, options) { const rows = erbSmooth(asFrequencyTrace(trace), options).rows; return { frequencies: rows.map(x => x.frequencyHz), magnitude: rows.map(x => x.levelDb) }; }
function representationValidation(traces, filters, target, options) {
  const count = clamp(options.validationCount ?? 1, 1, traces.length - 1), floor = options.lowHz ?? target.anchors[0][0], ceiling = options.highHz ?? Math.min(target.anchors.at(-1)[0], 16000), evaluate = source => {
    const rows = source.flatMap(trace => humanListeningInternals.normalizedResiduals(trace, target, floor, ceiling, 24)), before = rms(rows.map(x => x.residualDb)), after = rms(humanListeningInternals.applyFilters(rows, filters, options.sampleRateHz ?? 48000).map(x => x.residualDb));
    return { beforeRmseDb: round(before), predictedAfterRmseDb: round(after), improvementDb: round(before - after) };
  };
  return { training: evaluate(traces.slice(0, -count)), withheldValidation: evaluate(traces.slice(-count)) };
}
export function multiResolutionEqProposal(rawTraces, minimallySmoothedTraces, options = {}) {
  if (rawTraces.length < 2 || rawTraces.length !== minimallySmoothedTraces.length) throw new Error("Matching repeated raw and minimally smoothed traces are required");
  const base = perceptualEqProposal(minimallySmoothedTraces, options), target = base.target, floor = options.lowHz ?? target.anchors[0][0], ceiling = options.highHz ?? Math.min(target.anchors.at(-1)[0], 16000), validationCount = clamp(options.validationCount ?? 1, 1, rawTraces.length - 1), perceptualTraces = rawTraces.map(trace => erbFrequencyTrace(trace, { lowHz: floor, highHz: ceiling, stepErb: 0.5, widthErb: 1 }));
  const representations = { raw: { traces: rawTraces.map(asFrequencyTrace), ppo: 192 }, minimal: { traces: minimallySmoothedTraces.map(asFrequencyTrace), ppo: 96 }, perceptual: { traces: perceptualTraces, ppo: 24 } };
  for (const representation of Object.values(representations)) representation.rowSets = representation.traces.map(trace => humanListeningInternals.normalizedResiduals(trace, target, floor, ceiling, representation.ppo));
  const residualNear = (rows, frequencyHz) => {
    rows = rows.filter(x => Math.abs(Math.log2(x.frequencyHz / frequencyHz)) <= 1 / 24);
    return rows.length ? Math.max(...rows.map(x => x.residualDb)) : NaN;
  };
  const featureGates = base.proposedFilters.map(filter => {
    const thresholds = { raw: options.minCorrectionDb ?? 1.25, minimal: options.minCorrectionDb ?? 1.25, perceptual: frequencyAudibilityThresholdDb(filter.frequencyHz) }, evidence = {};
    for (const [name, representation] of Object.entries(representations)) {
      const values = representation.rowSets.map(rows => residualNear(rows, filter.frequencyHz)), training = values.slice(0, -validationCount), withheld = values.slice(-validationCount), threshold = thresholds[name];
      evidence[name] = { thresholdDb: threshold, trainingMedianDb: round(median(training)), trainingPassingFraction: round(training.filter(x => x >= threshold).length / training.length, 3), withheldMedianDb: round(median(withheld)), meaningful: training.filter(x => x >= threshold).length / training.length >= 0.75 && median(withheld) >= threshold };
    }
    return { filter, evidence, accepted: Object.values(evidence).every(x => x.meaningful) };
  });
  const proposedFilters = featureGates.filter(x => x.accepted).map(x => x.filter), evaluateSets = rowSets => { const evaluate = sets => { const rows = sets.flat(), before = rms(rows.map(x => x.residualDb)), after = rms(humanListeningInternals.applyFilters(rows, proposedFilters, options.sampleRateHz ?? 48000).map(x => x.residualDb)); return { beforeRmseDb: round(before), predictedAfterRmseDb: round(after), improvementDb: round(before - after) }; }; return { training: evaluate(rowSets.slice(0, -validationCount)), withheldValidation: evaluate(rowSets.slice(-validationCount)) }; }, validation = Object.fromEntries(Object.entries(representations).map(([name, representation]) => [name, evaluateSets(representation.rowSets)])), minimum = options.minValidationImprovementDb ?? 0.25, passes = proposedFilters.length > 0 && Object.values(validation).every(x => x.training.improvementDb >= minimum && x.withheldValidation.improvementDb >= minimum), accepted = base.status === "proposal-cross-validated" && passes;
  return { ...base, schemaVersion: 2, status: accepted ? "proposal-cross-validated-multiresolution" : "proposal-rejected", filters: accepted ? proposedFilters : [], proposedFilters, featureGates, resolutionValidation: validation, constraints: { ...base.constraints, rawMeaningfulnessRequired: true, minimallySmoothedMeaningfulnessRequired: true, perceptualMeaningfulnessRequired: true, repeatedTrainingPassingFraction: 0.75, heldOutMeaningfulnessRequired: true }, warnings: [...base.warnings, "Every accepted feature must remain meaningful in raw, 1/48, ERB-perceptual, repeated-training, and held-out evidence."].filter(Boolean) };
}

export function speakerProtectionAssessment({ measuredF3Hz, manufacturerF3Hz, minimumCorrectionHz, continuousSplDb, measuredMaxCleanSplDb, headroomDb, maximumBoostDb = 0, compressionDb = 0, limiterObserved = false } = {}) {
  const knownFloors = finite([measuredF3Hz, manufacturerF3Hz, minimumCorrectionHz]), correctionFloorHz = knownFloors.length ? Math.max(...knownFloors) : null, availableHeadroomDb = Number.isFinite(headroomDb) ? Math.max(0, headroomDb - Math.max(0, compressionDb)) : 0, permittedBoostDb = limiterObserved ? 0 : Math.min(Math.max(0, maximumBoostDb), availableHeadroomDb);
  const reasons = [];
  if (!knownFloors.length) reasons.push("No defensible low-frequency capability boundary was supplied.");
  if (!Number.isFinite(headroomDb)) reasons.push("Headroom is unknown; positive EQ is disabled.");
  if (compressionDb >= 1) reasons.push("Measured compression reduces available headroom.");
  if (limiterObserved) reasons.push("Limiter activity was observed; positive EQ is disabled.");
  if (Number.isFinite(continuousSplDb) && Number.isFinite(measuredMaxCleanSplDb) && continuousSplDb > measuredMaxCleanSplDb) reasons.push("Requested continuous SPL exceeds measured clean output.");
  return { acceptedForAutomaticEq: knownFloors.length > 0 && reasons.length === 0, correctionFloorHz: round(correctionFloorHz, 1), permittedBoostDb: round(permittedBoostDb, 1), availableHeadroomDb: round(availableHeadroomDb, 1), reasons, invariants: ["Never boost below the highest defensible capability boundary.", "Compression or limiter evidence overrides visual target error.", "Unknown headroom means cut-only EQ."] };
}

export function measuredPostEqVerification(beforeAssessment, afterAssessment, { minimumTonalImprovementDb = 0.25, maximumRepeatabilityRegressionDb = 0.25, stateMatched = false, levelMatchedWithinDb } = {}) {
  const b = beforeAssessment?.dimensions?.tonalBalance?.raw, a = afterAssessment?.dimensions?.tonalBalance?.raw;
  if (!b || !a) throw new Error("Before and after listening assessments are required");
  const weighted = raw => mean([[raw.bassRmseDb, 0.3], [raw.midRmseDb, 0.5], [raw.trebleRmseDb, 0.2]].flatMap(([x, w]) => Number.isFinite(x) ? Array(Math.round(w * 10)).fill(x) : []));
  const beforeError = weighted(b), afterError = weighted(a), tonalImprovementDb = beforeError - afterError, repeatabilityRegressionDb = (afterAssessment.quality?.metrics?.repeatabilitySdDb ?? Infinity) - (beforeAssessment.quality?.metrics?.repeatabilitySdDb ?? Infinity), evidenceValid = Boolean(beforeAssessment.quality?.accepted && afterAssessment.quality?.accepted && stateMatched && Number.isFinite(levelMatchedWithinDb) && levelMatchedWithinDb <= 0.2);
  const accepted = evidenceValid && tonalImprovementDb >= minimumTonalImprovementDb && repeatabilityRegressionDb <= maximumRepeatabilityRegressionDb;
  return { status: accepted ? "verified-improvement" : "verification-rejected", accepted, metrics: { beforeWeightedTonalErrorDb: round(beforeError), afterWeightedTonalErrorDb: round(afterError), tonalImprovementDb: round(tonalImprovementDb), repeatabilityRegressionDb: round(repeatabilityRegressionDb), levelMatchedWithinDb: round(levelMatchedWithinDb) }, evidence: { beforeQualityAccepted: Boolean(beforeAssessment.quality?.accepted), afterQualityAccepted: Boolean(afterAssessment.quality?.accepted), stateMatched }, reasons: [!evidenceValid ? "Quality, state fingerprint, or <=0.2 dB level-match evidence is missing." : null, tonalImprovementDb < minimumTonalImprovementDb ? "Measured tonal improvement is below the acceptance threshold." : null, repeatabilityRegressionDb > maximumRepeatabilityRegressionDb ? "Repeatability regressed beyond the allowed amount." : null].filter(Boolean) };
}

export const advancedInternals = { magnitudeRows, impulseSeries, octaveDistance, rms, interpolate, humanListeningInternals };

// lib/analysis-worker.mjs
import { parentPort, workerData } from "node:worker_threads";

// core.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function validatedRewBase(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("AUDIO_REW_URL must be a plain HTTP origin without credentials or path");
  const host = url.hostname.toLowerCase();
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return url.origin;
  if (process.env.AUDIO_REW_ALLOW_REMOTE !== "true") throw new Error("Remote REW requires AUDIO_REW_ALLOW_REMOTE=true");
  const parts = host.split(".").map(Number), privateIpv4 = parts.length === 4 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 169 && parts[1] === 254);
  if (!privateIpv4 && !host.endsWith(".local")) throw new Error("Remote REW must use a private IPv4 address or .local hostname");
  return url.origin;
}
var REW_BASE = validatedRewBase(process.env.AUDIO_REW_URL || "http://127.0.0.1:4735");
var DEVICE_LIMITS = Object.freeze({
  general: { startHz: 20, endHz: 2e4, levelDbfs: -24, maxSplDb: 85, maxBoostDb: 3 },
  car: { startHz: 20, endHz: 2e4, levelDbfs: -24, maxSplDb: 85, maxBoostDb: 3 },
  laptop: { startHz: 120, endHz: 2e4, levelDbfs: -30, maxSplDb: 75, maxBoostDb: 0 }
});
var MAX_SERIES_INPUT_BYTES = 16 * 1024 * 1024;
var MAX_SERIES_SAMPLES = 2e6;
var MAX_REW_RESPONSE_BYTES = 64 * 1024 * 1024;
var parsedRewConcurrency = Number.parseInt(process.env.AUDIO_REW_MAX_CONCURRENCY || "4", 10);
var REW_MAX_CONCURRENCY = Number.isFinite(parsedRewConcurrency) ? Math.max(1, Math.min(8, parsedRewConcurrency)) : 4;
function parseSeries(value) {
  if (typeof value === "string") {
    const compact = value.trim();
    if (Buffer.byteLength(compact) > MAX_SERIES_INPUT_BYTES) throw new Error("Numeric series exceeds the input limit");
    if (compact && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0) {
      const bytes = Buffer.from(compact, "base64");
      if (bytes.length >= 4 && bytes.length % 4 === 0) {
        const decoded = [];
        if (bytes.length / 4 > MAX_SERIES_SAMPLES) throw new Error("Numeric series exceeds the sample limit");
        for (let offset = 0; offset < bytes.length; offset += 4) decoded.push(bytes.readFloatBE(offset));
        if (decoded.every(Number.isFinite)) return decoded;
      }
    }
  }
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : [];
  if (raw.length > MAX_SERIES_SAMPLES) throw new Error("Numeric series exceeds the sample limit");
  return raw.map(Number).filter(Number.isFinite);
}
function frequencyAxis(trace, n) {
  const direct = parseSeries(trace?.frequencies || trace?.frequency);
  if (direct.length === n) return direct;
  const start = Number(trace?.startFreq || trace?.startFrequency || 10), ppo = Number(trace?.ppo);
  if (Number.isFinite(ppo) && ppo > 0) return Array.from({ length: n }, (_, i) => start * 2 ** (i / ppo));
  const step = Number(trace?.freqStep || trace?.frequencyStep || 1);
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function interpolate(xs, ys, x) {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs.at(-1)) return ys.at(-1);
  let low = 1, high = xs.length - 1;
  while (low < high) {
    const middle = low + high >> 1;
    if (xs[middle] < x) low = middle + 1;
    else high = middle;
  }
  const i = low;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}
function circularDelta(a, b) {
  return Math.abs((a - b + 540) % 360 - 180);
}
function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : NaN;
}
function crossoverMetrics(main, sub, crossoverHz, spanOctaves = 1) {
  const am = parseSeries(main.magnitude), ap = parseSeries(main.phase), bm = parseSeries(sub.magnitude), bp = parseSeries(sub.phase);
  const ax = frequencyAxis(main, am.length), bx = frequencyAxis(sub, bm.length), lo = crossoverHz / 2 ** spanOctaves, hi = crossoverHz * 2 ** spanOctaves, rows = [];
  for (let f = lo; f <= hi; f *= 2 ** (1 / 24)) {
    const ma = interpolate(ax, am, f), mb = interpolate(bx, bm, f), pa = interpolate(ax, ap, f), pb = interpolate(bx, bp, f);
    if (![ma, mb, pa, pb].every(Number.isFinite)) continue;
    const va = 10 ** (ma / 20), vb = 10 ** (mb / 20), d = (pa - pb) * Math.PI / 180;
    const sum = 20 * Math.log10(Math.sqrt(va * va + vb * vb + 2 * va * vb * Math.cos(d)));
    rows.push({ frequencyHz: Math.round(f * 10) / 10, phaseDeltaDeg: circularDelta(pa, pb), predictedSumDb: sum, betterInputDb: Math.max(ma, mb), summationDb: sum - Math.max(ma, mb) });
  }
  return { crossoverHz, medianPhaseDeltaDeg: median(rows.map((x) => x.phaseDeltaDeg)), medianSummationDb: median(rows.map((x) => x.summationDb)), atCrossover: rows.reduce((a, b) => Math.abs(b.frequencyHz - crossoverHz) < Math.abs(a.frequencyHz - crossoverHz) ? b : a, rows[0] || null), rows };
}

// human-listening.mjs
var clamp = (value, low, high) => Math.max(low, Math.min(high, value));
var mean = (values) => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
};
var rms = (values) => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? Math.sqrt(mean(valid.map((x) => x * x))) : NaN;
};
var round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
var EVIDENCE_REGISTRY = Object.freeze({
  "rew-api": Object.freeze({ type: "official-documentation", title: "Room EQ Wizard API", url: "https://www.roomeqwizard.com/help/help_en-GB/html/api.html", supports: ["measurement and processing API semantics"], doesNotSupport: ["a universal preferred target curve"] }),
  "itu-bs1116": Object.freeze({ type: "recommendation", title: "ITU-R BS.1116 \u2014 subjective assessment of small audio impairments", url: "https://www.itu.int/rec/R-REC-BS.1116/en", supports: ["controlled subjective comparison design"], doesNotSupport: ["claiming this home workflow is a conforming laboratory test"] }),
  "itu-bs1534": Object.freeze({ type: "recommendation", title: "ITU-R BS.1534 \u2014 MUSHRA", url: "https://www.itu.int/rec/R-REC-BS.1534/en", supports: ["randomized multi-stimulus listening-test concepts"], doesNotSupport: ["using a short A/B test as universal preference evidence"] }),
  "itu-bs1770": Object.freeze({ type: "recommendation", title: "ITU-R BS.1770 \u2014 programme loudness and true peak", url: "https://www.itu.int/rec/R-REC-BS.1770/en", supports: ["programme loudness and true-peak handling"], doesNotSupport: ["a loudspeaker or room response target"] }),
  "local-target-policy-v1": Object.freeze({ type: "engineering-policy", title: "Conservative perceptual-target policy v1", url: null, supports: ["versioned reversible starting targets", "cut-first validation workflow"], doesNotSupport: ["objective perfection", "universal listener preference", "speaker capability inference"] })
});
var TARGET_REGISTRY = Object.freeze({
  "perceptual-neutral-room-v1": Object.freeze({
    id: "perceptual-neutral-room-v1",
    label: "Perceptual neutral room",
    deviceClasses: ["general"],
    classification: "preference-starting-point",
    anchors: [[20, 4], [80, 3], [300, 0.8], [1e3, 0], [1e4, -1.5], [2e4, -3]],
    provenance: ["rew-api", "local-target-policy-v1"],
    caveat: "This is a reversible starting preference, not an audibility standard or proof of correctness."
  }),
  "perceptual-neutral-car-v1": Object.freeze({
    id: "perceptual-neutral-car-v1",
    label: "Perceptual neutral vehicle cabin",
    deviceClasses: ["car"],
    classification: "preference-starting-point",
    anchors: [[20, 6], [80, 5], [300, 1.5], [1e3, 0], [1e4, -2.5], [2e4, -4]],
    provenance: ["rew-api", "local-target-policy-v1"],
    caveat: "Cabin, road-noise, seat, and playback-level effects require measured and listening validation."
  }),
  "perceptual-neutral-nearfield-v1": Object.freeze({
    id: "perceptual-neutral-nearfield-v1",
    label: "Perceptual neutral nearfield",
    deviceClasses: ["laptop"],
    classification: "preference-starting-point",
    anchors: [[120, 1.5], [300, 0.7], [1e3, 0], [1e4, -1], [2e4, -2]],
    provenance: ["rew-api", "local-target-policy-v1"],
    caveat: "Do not extend correction below measured acoustic capability or protection filtering."
  })
});
var DEFAULT_TARGET = Object.freeze({ general: "perceptual-neutral-room-v1", car: "perceptual-neutral-car-v1", laptop: "perceptual-neutral-nearfield-v1" });
function targetProfile(deviceClass, targetId) {
  const target = TARGET_REGISTRY[targetId || DEFAULT_TARGET[deviceClass]];
  if (!target) throw new Error("Unknown target profile");
  if (!target.deviceClasses.includes(deviceClass)) throw new Error("Target profile is not applicable to this device class");
  return target;
}
function targetOffsetDb(target, frequencyHz) {
  const anchors = target.anchors;
  if (frequencyHz <= anchors[0][0]) return anchors[0][1];
  if (frequencyHz >= anchors.at(-1)[0]) return anchors.at(-1)[1];
  let i = 1;
  while (anchors[i][0] < frequencyHz) i++;
  const [f0, g0] = anchors[i - 1], [f1, g1] = anchors[i];
  const t = Math.log(frequencyHz / f0) / Math.log(f1 / f0);
  return g0 + t * (g1 - g0);
}
function magnitudeTrace(trace) {
  return trace?.frequencyResponse || trace;
}
function traceSamples(trace, lowHz, highHz, ppo = 12) {
  const source = magnitudeTrace(trace), magnitude = parseSeries(source?.magnitude), frequencies = frequencyAxis(source || {}, magnitude.length), rows = [];
  if (!magnitude.length || !frequencies.length) return rows;
  for (let f = lowHz; f <= highHz * 1.000001; f *= 2 ** (1 / ppo)) {
    if (f < frequencies[0] || f > frequencies.at(-1)) continue;
    const level = interpolate(frequencies, magnitude, f);
    if (Number.isFinite(level)) rows.push({ frequencyHz: f, levelDb: level });
  }
  return rows;
}
function normalizedResiduals(trace, target, lowHz, highHz, ppo = 12) {
  const rows = traceSamples(trace, lowHz, highHz, ppo);
  const reference = rows.filter((x) => x.frequencyHz >= Math.max(lowHz, 500) && x.frequencyHz <= Math.min(highHz, 2e3));
  const offset = median(reference.map((x) => x.levelDb - targetOffsetDb(target, x.frequencyHz)));
  return rows.map((x) => ({ ...x, targetDb: targetOffsetDb(target, x.frequencyHz) + offset, residualDb: x.levelDb - targetOffsetDb(target, x.frequencyHz) - offset }));
}
function measurementQuality(traces, { lowHz = 20, highHz = 2e4, snrDb, minSnrDb = 15, requireSnr = true, routeStable = true, dspStable = true, stateVerified = false, microphoneCalibrationHash, requireMicrophoneCalibration = false, expectedTraceCount } = {}) {
  if (!Array.isArray(traces) || !traces.length) throw new Error("At least one trace is required");
  const sampled = traces.map((t) => traceSamples(t, lowHz, highHz, 12));
  const expectedPoints = Math.max(1, Math.floor(Math.log2(highHz / lowHz) * 12) + 1);
  const coverage = mean(sampled.map((x) => Math.min(1, x.length / expectedPoints)));
  const groups = /* @__PURE__ */ new Map();
  traces.forEach((trace, i) => {
    const key = `${trace.role || "unspecified"}\0${trace.seat || "unspecified"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sampled[i]);
  });
  const repeatabilityGroups = [...groups.values()].filter((group) => group.length >= 2).map((group) => {
    const deviations = [];
    for (let i = 0; i < expectedPoints; i++) {
      const levels = group.map((rows) => rows[i]?.levelDb).filter(Number.isFinite);
      if (levels.length !== group.length) continue;
      const center = mean(levels);
      deviations.push(Math.sqrt(mean(levels.map((x) => (x - center) ** 2))));
    }
    return median(deviations);
  });
  const repeatability = repeatabilityGroups.length ? median(repeatabilityGroups) : null;
  const reportedSnr = Number.isFinite(snrDb) ? snrDb : median(traces.map((t) => Number(t.snrDb ?? t.signalToNoiseRatioDb)));
  const clipped = traces.some((t) => Boolean(t.clipped || t.overload || Number(t.peakDbfs) >= -0.1));
  const reasons = [];
  if (coverage < 0.9) reasons.push("frequency coverage is incomplete");
  if (clipped) reasons.push("clipping or overload was reported");
  if (repeatability !== null && repeatability > 1.5) reasons.push("repeatability exceeds 1.5 dB median standard deviation");
  if (!Number.isFinite(reportedSnr) && requireSnr) reasons.push("SNR evidence is required but was not supplied by the measurement chain");
  if (Number.isFinite(reportedSnr) && reportedSnr < minSnrDb) reasons.push(`reported SNR is below the ${minSnrDb} dB session minimum`);
  if (requireMicrophoneCalibration && !microphoneCalibrationHash) reasons.push("microphone calibration identity is required but unverified");
  if (!routeStable) reasons.push("audio routing changed during capture");
  if (!dspStable) reasons.push("DSP state changed during capture");
  if (expectedTraceCount && traces.length !== expectedTraceCount) reasons.push("captured trace count differs from the plan");
  const evidence = [coverage >= 0.9, !clipped, routeStable, dspStable, repeatability === null || repeatability <= 1.5, Number.isFinite(reportedSnr) && reportedSnr >= 25];
  const confidenceScore = mean(evidence.map(Boolean).map((x) => x ? 1 : 0)) * (repeatabilityGroups.length ? 1 : 0.82) * (stateVerified ? 1 : 0.85);
  return {
    accepted: reasons.length === 0,
    reasons,
    confidence: confidenceScore >= 0.9 ? "high" : confidenceScore >= 0.7 ? "medium" : "low",
    metrics: { traceCount: traces.length, expectedTraceCount: expectedTraceCount ?? null, coverageRatio: round(coverage, 3), repeatabilitySdDb: round(repeatability), repeatabilityGroupCount: repeatabilityGroups.length, snrDb: round(reportedSnr), minimumSnrDb: minSnrDb, snrRequired: requireSnr, highConfidenceSnrDb: 25, clipped, routeStable, dspStable, stateVerification: stateVerified ? "verified-by-protected-session" : "caller-supplied-or-unknown", microphoneCalibration: microphoneCalibrationHash ? { status: "identified", hash: microphoneCalibrationHash } : { status: "unknown" }, microphoneCalibrationRequired: requireMicrophoneCalibration },
    warnings: [repeatability === null ? "Repeatability is unknown because no role-and-seat group contains multiple traces." : null, !Number.isFinite(reportedSnr) ? "SNR was not supplied by the measurement chain." : Number.isFinite(reportedSnr) && reportedSnr < 25 && reportedSnr >= minSnrDb ? "SNR passes the session minimum but lowers confidence; repeat or improve the signal-to-noise ratio when practical." : null, !stateVerified ? "Route and DSP stability were not linked to a protected-session state record." : null, !microphoneCalibrationHash ? "Microphone calibration identity is unverified." : null].filter(Boolean)
  };
}
function dimension(name, value, raw, confidence, interpretation) {
  return { name, score: Number.isFinite(value) ? round(clamp(value, 0, 100), 1) : null, raw, confidence, interpretation };
}
function bandRmse(rows, low, high) {
  return rms(rows.filter((x) => x.frequencyHz >= low && x.frequencyHz <= high).map((x) => x.residualDb));
}
function estimateInRoomF3(rows) {
  const reference = median(rows.filter((x) => x.frequencyHz >= 200 && x.frequencyHz <= 1e3).map((x) => x.levelDb));
  const found = rows.find((x) => x.levelDb >= reference - 3);
  return found?.frequencyHz;
}
function nestedSeries(value, names) {
  for (const name of names) {
    const found = parseSeries(value?.[name]);
    if (found.length) return found;
  }
  return [];
}
function humanListeningAssessment(traces, { deviceClass = "general", targetId, lowHz, highHz, crossoverHz, microphoneCalibrationHash, requireMicrophoneCalibration = false, routeStable = true, dspStable = true, stateVerified = false, snrDb, minSnrDb, requireSnr = true } = {}) {
  const target = targetProfile(deviceClass, targetId), floor = lowHz ?? target.anchors[0][0], ceiling = highHz ?? target.anchors.at(-1)[0];
  const quality = measurementQuality(traces, { lowHz: floor, highHz: ceiling, microphoneCalibrationHash, requireMicrophoneCalibration, routeStable, dspStable, stateVerified, snrDb, minSnrDb: minSnrDb ?? (deviceClass === "laptop" ? 15 : 20), requireSnr });
  const residualSets = traces.map((t) => normalizedResiduals(t, target, floor, ceiling, 12)).filter((x) => x.length);
  const averageRows = residualSets[0]?.map((row, i) => ({ ...row, residualDb: mean(residualSets.map((x) => x[i]?.residualDb)) })) || [];
  const estimatedF3 = estimateInRoomF3(averageRows), bassEvaluationFloor = Math.max(floor, estimatedF3 || floor), bassEvaluationCeiling = Math.min(300, ceiling), trebleEvaluationCeiling = Math.min(ceiling, 12e3);
  const bassEvaluationBand = bassEvaluationFloor <= bassEvaluationCeiling ? [round(bassEvaluationFloor, 1), bassEvaluationCeiling] : null;
  const bassRmse = bassEvaluationBand ? bandRmse(averageRows, bassEvaluationFloor, bassEvaluationCeiling) : NaN, midRmse = bandRmse(averageRows, Math.max(floor, 300), Math.min(4e3, ceiling)), trebleRmse = bandRmse(averageRows, Math.max(floor, 4e3), trebleEvaluationCeiling);
  const tonalWeightedError = mean([[bassRmse, 0.3], [midRmse, 0.5], [trebleRmse, 0.2]].filter(([x]) => Number.isFinite(x)).flatMap(([x, weight]) => Array(Math.round(weight * 10)).fill(x)));
  const left = traces.find((t) => /(^|[-_ ])l(eft)?($|[-_ ])/i.test(t.role || "")), right = traces.find((t) => /(^|[-_ ])r(ight)?($|[-_ ])/i.test(t.role || ""));
  let channelMatchDb = NaN;
  if (left && right) {
    const a = normalizedResiduals(left, target, Math.max(300, floor), ceiling, 12), b = normalizedResiduals(right, target, Math.max(300, floor), ceiling, 12);
    channelMatchDb = median(a.map((x, i) => Math.abs(x.residualDb - (b[i]?.residualDb ?? NaN))));
  }
  const groupDelayValues = traces.flatMap((t) => nestedSeries(t.groupDelay, ["groupDelay", "magnitude", "data"]));
  const groupDelayJitter = groupDelayValues.length > 2 ? Math.sqrt(mean(groupDelayValues.map((x) => (x - mean(groupDelayValues)) ** 2))) : NaN;
  const distortionValues = traces.flatMap((t) => nestedSeries(t.distortion, ["thd", "THD", "distortion"])).filter((x) => x >= 0);
  const distortionMedian = median(distortionValues);
  const rtValues = traces.flatMap((t) => nestedSeries(t.rt60, ["rt60", "t20", "t30", "magnitude"])).filter((x) => x > 0 && x < 10);
  let crossover = null;
  const main = traces.find((t) => /main|front|left|right/i.test(t.role || "")), sub = traces.find((t) => /sub/i.test(t.role || ""));
  if (main && sub && crossoverHz) crossover = crossoverMetrics(magnitudeTrace(main), magnitudeTrace(sub), crossoverHz, 0.5);
  const confidence = quality.confidence;
  const dimensions = {
    tonalBalance: dimension("tonal balance", 100 - tonalWeightedError * 12, { bassRmseDb: round(bassRmse), midRmseDb: round(midRmse), trebleRmseDb: round(trebleRmse), evaluationBandsHz: { bass: bassEvaluationBand, mid: [Math.max(floor, 300), Math.min(4e3, ceiling)], treble: [Math.max(floor, 4e3), trebleEvaluationCeiling] }, targetId: target.id }, confidence, tonalWeightedError <= 2 ? "Broad tonal balance is close to the selected preference target within the capability-bounded evaluation bands." : "Broad tonal deviations are likely audible; inspect placement and stable peaks before EQ."),
    imagingChannelMatch: dimension("imaging and channel match", Number.isFinite(channelMatchDb) ? 100 - channelMatchDb * 20 : NaN, { medianLeftRightDifferenceDb: round(channelMatchDb) }, left && right ? confidence : "unavailable", left && right ? "Lower broad-band left/right mismatch generally supports a more stable phantom image." : "Separate left and right traces were not identified."),
    bassExtension: dimension("bass extension", NaN, { estimatedInRoomF3Hz: round(estimatedF3, 1) }, confidence, "This is an in-room -3 dB estimate, not an anechoic capability or safe boost boundary. Tonal scoring does not penalize response below it."),
    crossoverIntegration: dimension("crossover integration", crossover ? 100 - Math.abs(Math.min(0, crossover.medianSummationDb)) * 18 - crossover.medianPhaseDeltaDeg / 3.6 : NaN, crossover ? { crossoverHz, medianPhaseDeltaDeg: round(crossover.medianPhaseDeltaDeg), medianSummationDb: round(crossover.medianSummationDb) } : {}, crossover ? confidence : "unavailable", crossover ? "Prediction must be confirmed with a measured main-plus-sub trace." : "Main, sub, and crossover metadata were not all supplied."),
    decayResonance: dimension("decay and resonance", rtValues.length ? 100 - Math.sqrt(mean(rtValues.map((x) => (x - median(rtValues)) ** 2))) * 100 : NaN, { medianRt60Seconds: round(median(rtValues)), sampleCount: rtValues.length }, rtValues.length ? confidence : "unavailable", rtValues.length ? "Score reflects decay consistency, not a universal ideal RT60 for every room." : "No usable decay trace was available."),
    distortionCompression: dimension("distortion and compression", distortionValues.length ? 100 - 35 * Math.log10(1 + median(distortionValues)) : NaN, { medianThdPercent: round(distortionMedian), sampleCount: distortionValues.length }, distortionValues.length ? confidence : "unavailable", distortionValues.length ? "THD is reported in percent; audibility still depends on spectrum, frequency, programme, and playback level." : "No percent-THD or level-ladder evidence was available."),
    timing: dimension("timing", Number.isFinite(groupDelayJitter) ? 100 - groupDelayJitter * 8 : NaN, { groupDelaySpreadMs: round(groupDelayJitter) }, Number.isFinite(groupDelayJitter) ? confidence : "unavailable", Number.isFinite(groupDelayJitter) ? "Inspect unsmoothed excess/group delay before attributing audibility." : "No group-delay trace was available."),
    measurementConfidence: dimension("measurement confidence", quality.confidence === "high" ? 100 : quality.confidence === "medium" ? 70 : 40, quality.metrics, quality.confidence, quality.accepted ? "Measurements passed the available objective quality gates." : "Fix rejected measurement conditions before accepting tuning conclusions.")
  };
  return { schemaVersion: 1, target, quality, dimensions, globalScore: null, globalScoreReason: "A single sound-quality score would hide coverage, uncertainty, and listener preference.", evidenceBoundary: { facts: "Raw REW-derived metrics", calculations: "Documented deterministic transforms", interpretation: "Audibility-oriented engineering inference", preference: `Selected target ${target.id}` } };
}
function peakingMagnitudeDb(frequencyHz, filter, sampleRateHz = 48e3) {
  const A = 10 ** (filter.gainDb / 40), w0 = 2 * Math.PI * filter.frequencyHz / sampleRateHz, alpha = Math.sin(w0) / (2 * filter.q), c0 = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * c0, b2 = 1 - alpha * A, a0 = 1 + alpha / A, a1 = -2 * c0, a2 = 1 - alpha / A;
  const w = 2 * Math.PI * frequencyHz / sampleRateHz, numerator = Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), -b1 * Math.sin(w) - b2 * Math.sin(2 * w)), denominator = Math.hypot(a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), -a1 * Math.sin(w) - a2 * Math.sin(2 * w));
  return 20 * Math.log10(numerator / denominator);
}
function applyFilters(rows, filters, sampleRateHz) {
  return rows.map((x) => ({ ...x, residualDb: x.residualDb + filters.reduce((sum, f) => sum + peakingMagnitudeDb(x.frequencyHz, f, sampleRateHz), 0) }));
}
var humanListeningInternals = { traceSamples, normalizedResiduals, peakingMagnitudeDb, applyFilters, estimateInRoomF3 };

// advanced-calibration.mjs
var finite = (values) => values.filter(Number.isFinite);
var mean2 = (values) => {
  const x = finite(values);
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN;
};
var median2 = (values) => {
  const x = finite(values).sort((a, b) => a - b);
  return x.length ? (x[Math.floor((x.length - 1) / 2)] + x[Math.floor(x.length / 2)]) / 2 : NaN;
};
var round2 = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
var magnitudeRows = (trace) => {
  const magnitude = parseSeries(trace?.magnitude), frequencies = frequencyAxis(trace || {}, magnitude.length);
  return magnitude.map((levelDb, i) => ({ frequencyHz: frequencies[i], levelDb })).filter((x) => Number.isFinite(x.frequencyHz) && Number.isFinite(x.levelDb) && x.frequencyHz > 0);
};
var erbNumber = (frequencyHz) => 21.4 * Math.log10(1 + 437e-5 * frequencyHz);
var frequencyFromErb = (erb) => (10 ** (erb / 21.4) - 1) / 437e-5;
function frequencyAudibilityThresholdDb(frequencyHz) {
  if (frequencyHz < 80) return 2;
  if (frequencyHz < 200) return 1.5;
  if (frequencyHz <= 6e3) return 1;
  if (frequencyHz <= 12e3) return 1.5;
  return 2;
}
function erbSmooth(trace, { lowHz = 20, highHz = 2e4, stepErb = 0.5, widthErb = 1 } = {}) {
  const rows = magnitudeRows(trace).filter((x) => x.frequencyHz >= lowHz && x.frequencyHz <= highHz);
  if (!rows.length) return { rows: [], method: "ERB Gaussian power average" };
  const source = rows.map((x) => ({ ...x, erb: erbNumber(x.frequencyHz), power: 10 ** (x.levelDb / 10) }));
  const start = erbNumber(Math.max(lowHz, rows[0].frequencyHz)), end = erbNumber(Math.min(highHz, rows.at(-1).frequencyHz)), output = [];
  for (let center = start; center <= end + 1e-9; center += stepErb) {
    let weighted = 0, weights = 0;
    for (const row of source) {
      const z = (row.erb - center) / widthErb, weight = Math.exp(-0.5 * z * z);
      weighted += row.power * weight;
      weights += weight;
    }
    if (weights > 0) output.push({ frequencyHz: round2(frequencyFromErb(center), 1), levelDb: round2(10 * Math.log10(weighted / weights), 3), audibilityThresholdDb: frequencyAudibilityThresholdDb(frequencyFromErb(center)) });
  }
  return { rows: output, method: "ERB Gaussian power average", stepErb, widthErb, boundary: "Audibility thresholds are conservative workflow heuristics, not universal just-noticeable-difference claims." };
}
function engineeringTraceSummary(trace, { lowHz = 20, highHz = 2e4 } = {}) {
  const rows = magnitudeRows(trace).filter((x) => x.frequencyHz >= lowHz && x.frequencyHz <= highHz), candidates = [], prefix = [0];
  for (const row of rows) prefix.push(prefix.at(-1) + row.levelDb);
  let left = 0, right = 0;
  for (let i = 0; i < rows.length; i++) {
    const center = rows[i], low = center.frequencyHz / 2 ** (1 / 12), high = center.frequencyHz * 2 ** (1 / 12);
    while (left < rows.length && rows[left].frequencyHz < low) left++;
    right = Math.max(right, i + 1);
    while (right < rows.length && rows[right].frequencyHz <= high) right++;
    const count = right - left - 1, local = count > 0 ? (prefix[right] - prefix[left] - center.levelDb) / count : NaN, deviationDb = center.levelDb - local;
    if (Number.isFinite(deviationDb) && Math.abs(deviationDb) >= 1.5) candidates.push({ frequencyHz: round2(center.frequencyHz, 1), deviationFromLocalDb: round2(deviationDb), kind: deviationDb > 0 ? "narrow-peak-candidate" : "narrow-dip-candidate" });
  }
  candidates.sort((a, b) => Math.abs(b.deviationFromLocalDb) - Math.abs(a.deviationFromLocalDb));
  return { pointCount: rows.length, frequencyRangeHz: rows.length ? [round2(rows[0].frequencyHz, 1), round2(rows.at(-1).frequencyHz, 1)] : null, levelRangeDb: rows.length ? [round2(Math.min(...rows.map((x) => x.levelDb))), round2(Math.max(...rows.map((x) => x.levelDb)))] : null, narrowFeatureCandidates: candidates.slice(0, 20), boundary: "Candidates require repeatability, phase/time inspection, and audibility context before correction." };
}
function frequencyDependentSmooth(trace, { lowHz = 20, highHz = 2e4, modalBoundaryHz = 200, transitionHz = 1e3, ppo = 24 } = {}) {
  if (transitionHz <= modalBoundaryHz) throw new Error("Transition frequency must exceed the modal boundary");
  const source = magnitudeRows(trace).filter((x) => x.frequencyHz >= lowHz / 1.5 && x.frequencyHz <= highHz * 1.5).map((x) => ({ ...x, power: 10 ** (x.levelDb / 10) })), rows = [];
  for (let center = lowHz; center <= highHz * 1.000001; center *= 2 ** (1 / ppo)) {
    let bandwidthOctaves, regime;
    if (center <= modalBoundaryHz) {
      bandwidthOctaves = 1 / 48;
      regime = "modal-high-resolution";
    } else if (center < transitionHz) {
      const mix = Math.log(center / modalBoundaryHz) / Math.log(transitionHz / modalBoundaryHz);
      bandwidthOctaves = 1 / 48 * (1 - mix) + 1 / 12 * mix;
      regime = "transition";
    } else if (center < 8e3) {
      const erbBandwidthHz = 24.7 * (4.37 * center / 1e3 + 1);
      bandwidthOctaves = Math.max(1 / 12, Math.log2((center + erbBandwidthHz / 2) / Math.max(1, center - erbBandwidthHz / 2)));
      regime = "ERB-perceptual";
    } else {
      bandwidthOctaves = 1 / 6;
      regime = "high-frequency-perceptual";
    }
    const sigma = bandwidthOctaves / 2.355;
    let weighted = 0, weights = 0;
    for (const point of source) {
      const z = Math.log2(point.frequencyHz / center) / sigma, weight = Math.exp(-0.5 * z * z);
      if (weight < 1e-6) continue;
      weighted += point.power * weight;
      weights += weight;
    }
    if (weights > 0) rows.push({ frequencyHz: round2(center, 1), levelDb: round2(10 * Math.log10(weighted / weights), 3), effectiveBandwidthOctaves: round2(bandwidthOctaves, 4), regime, audibilityThresholdDb: frequencyAudibilityThresholdDb(center) });
  }
  return { rows, modalBoundaryHz, transitionHz, ppo, method: "frequency-dependent Gaussian power average", boundary: "Modal boundary and smoothing transition are explicit workflow parameters, not automatically inferred room constants." };
}
function measuredBroadbandLevelDifference(beforeTraces, afterTraces, { lowHz = 500, highHz = 8e3 } = {}) {
  const traceLevel = (trace) => {
    const rows = humanListeningInternals.traceSamples(trace, lowHz, highHz, 24);
    return rows.length ? 10 * Math.log10(mean2(rows.map((row) => 10 ** (row.levelDb / 10)))) : NaN;
  };
  const beforeLevelDb = median2(beforeTraces.map(traceLevel)), afterLevelDb = median2(afterTraces.map(traceLevel));
  return { beforeLevelDb: round2(beforeLevelDb), afterLevelDb: round2(afterLevelDb), differenceDb: round2(afterLevelDb - beforeLevelDb), bandHz: [lowHz, highHz] };
}
function measuredPostEqVerification(beforeAssessment, afterAssessment, { minimumTonalImprovementDb = 0.25, maximumRepeatabilityRegressionDb = 0.25, stateMatched = false, measuredLevelDifferenceDb, levelMatchToleranceDb = 0.2 } = {}) {
  const b = beforeAssessment?.dimensions?.tonalBalance?.raw, a = afterAssessment?.dimensions?.tonalBalance?.raw;
  if (!b || !a) throw new Error("Before and after listening assessments are required");
  const weighted = (raw) => mean2([[raw.bassRmseDb, 0.3], [raw.midRmseDb, 0.5], [raw.trebleRmseDb, 0.2]].flatMap(([x, w]) => Number.isFinite(x) ? Array(Math.round(w * 10)).fill(x) : []));
  const beforeError = weighted(b), afterError = weighted(a), tonalImprovementDb = beforeError - afterError, repeatabilityRegressionDb = (afterAssessment.quality?.metrics?.repeatabilitySdDb ?? Infinity) - (beforeAssessment.quality?.metrics?.repeatabilitySdDb ?? Infinity), levelMatched = Number.isFinite(measuredLevelDifferenceDb) && Math.abs(measuredLevelDifferenceDb) <= levelMatchToleranceDb, evidenceValid = Boolean(beforeAssessment.quality?.accepted && afterAssessment.quality?.accepted && stateMatched && levelMatched);
  const accepted = evidenceValid && tonalImprovementDb >= minimumTonalImprovementDb && repeatabilityRegressionDb <= maximumRepeatabilityRegressionDb;
  return { status: accepted ? "verified-improvement" : "verification-rejected", accepted, metrics: { beforeWeightedTonalErrorDb: round2(beforeError), afterWeightedTonalErrorDb: round2(afterError), tonalImprovementDb: round2(tonalImprovementDb), repeatabilityRegressionDb: round2(repeatabilityRegressionDb), measuredLevelDifferenceDb: round2(measuredLevelDifferenceDb), levelMatchToleranceDb: round2(levelMatchToleranceDb) }, evidence: { beforeQualityAccepted: Boolean(beforeAssessment.quality?.accepted), afterQualityAccepted: Boolean(afterAssessment.quality?.accepted), stateMatched, levelMatched }, reasons: [!evidenceValid ? `Quality, state fingerprint, or measured level match within \xB1${levelMatchToleranceDb} dB is missing.` : null, tonalImprovementDb < minimumTonalImprovementDb ? "Measured tonal improvement is below the acceptance threshold." : null, repeatabilityRegressionDb > maximumRepeatabilityRegressionDb ? "Repeatability regressed beyond the allowed amount." : null].filter(Boolean) };
}

// lib/analysis-worker.mjs
function execute(kind, payload) {
  if (kind === "human-listening") return humanListeningAssessment(payload.traces, payload.args);
  if (kind === "dual-resolution") {
    const { source, minimal, rawUsable, args } = payload;
    return { measurementId: args.id, rawAvailable: Boolean(rawUsable), engineering: { ...engineeringTraceSummary(source, args), smoothing: rawUsable ? "None" : "1/48 fallback", spacing: rawUsable ? "native-linear" : "96-PPO logarithmic", derivedAnalysisGridPpo: rawUsable ? 192 : 96 }, minimallySmoothed: { ...engineeringTraceSummary(minimal, args), smoothing: "1/48", ppo: 96 }, adaptive: frequencyDependentSmooth(source, { lowHz: args.lowHz, highHz: args.highHz, modalBoundaryHz: args.modalBoundaryHz, transitionHz: args.smoothingTransitionHz, ppo: 24 }), perceptual: erbSmooth(source, args), rawTracePreservedInRew: true, use: { engineering: "phase, timing, resonances, narrow defects, and quality checks", adaptive: "modal-resolution below the boundary with progressively perceptual smoothing above it", perceptual: "broad tonal balance and audibility-oriented EQ decisions" } };
  }
  if (kind === "post-eq") {
    const { beforeTraces, afterTraces, assessmentArgs, verificationArgs, levelRange } = payload;
    const before = humanListeningAssessment(beforeTraces, assessmentArgs), after = humanListeningAssessment(afterTraces, assessmentArgs), measuredLevel = measuredBroadbandLevelDifference(beforeTraces, afterTraces, levelRange), verification = measuredPostEqVerification(before, after, { ...verificationArgs, measuredLevelDifferenceDb: measuredLevel.differenceDb });
    return { before, after, measuredLevel, verification };
  }
  throw new Error(`Unknown analysis worker task: ${kind}`);
}
try {
  parentPort.postMessage({ ok: true, result: execute(workerData.kind, workerData.payload) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error).slice(0, 2e3) });
}

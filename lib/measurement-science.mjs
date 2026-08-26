const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
};

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const variance = values => values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1);
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * p;
  const lower = Math.floor(position), fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
};

const mulberry32 = seed => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const normalSample = random => {
  const u = Math.max(Number.EPSILON, random()), v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export function standardUncertainty(component) {
  const magnitude = Math.abs(finite(component.uncertainty, "uncertainty"));
  if (component.distribution === "rectangular") return magnitude / Math.sqrt(3);
  if (component.distribution === "triangular") return magnitude / Math.sqrt(6);
  if (component.distribution === "normal") return magnitude / finite(component.coverageFactor ?? 1, "coverageFactor");
  throw new Error(`Unsupported uncertainty distribution: ${component.distribution}`);
}

export function uncertaintyBudget(components, { coverageProbability = 0.95 } = {}) {
  if (!Array.isArray(components) || components.length === 0) throw new Error("At least one uncertainty component is required");
  const rows = components.map(component => {
    const sensitivity = finite(component.sensitivity ?? 1, "sensitivity"), u = standardUncertainty(component), contribution = Math.abs(sensitivity * u);
    return { name: component.name, distribution: component.distribution, sensitivity, standardUncertainty: u, contribution, degreesOfFreedom: component.degreesOfFreedom ?? null };
  });
  const combinedStandardUncertainty = Math.sqrt(rows.reduce((sum, row) => sum + row.contribution ** 2, 0));
  const denominator = rows.reduce((sum, row) => row.degreesOfFreedom > 0 ? sum + row.contribution ** 4 / row.degreesOfFreedom : sum, 0);
  const effectiveDegreesOfFreedom = denominator > 0 ? combinedStandardUncertainty ** 4 / denominator : Infinity;
  const coverageFactor = coverageProbability === 0.95 ? (effectiveDegreesOfFreedom < 5 ? 2.776 : effectiveDegreesOfFreedom < 10 ? 2.262 : effectiveDegreesOfFreedom < 30 ? 2.045 : 1.96) : 1;
  return {
    method: "JCGM-GUM linear propagation",
    claimLevel: "standards-aligned",
    coverageProbability,
    components: rows,
    combinedStandardUncertainty,
    effectiveDegreesOfFreedom: Number.isFinite(effectiveDegreesOfFreedom) ? effectiveDegreesOfFreedom : null,
    coverageFactor,
    expandedUncertainty: combinedStandardUncertainty * coverageFactor,
    boundary: "Conformance requires a complete traceable uncertainty budget, calibrated instrumentation, and the applicable normative procedure."
  };
}

export function monteCarloUncertainty(components, { trials = 20000, seed = 1729, estimate = 0 } = {}) {
  if (trials < 1000 || trials > 200000) throw new Error("trials must be between 1,000 and 200,000");
  const random = mulberry32(seed), samples = new Array(trials);
  for (let trial = 0; trial < trials; trial++) {
    let value = estimate;
    for (const component of components) {
      const width = Math.abs(finite(component.uncertainty, "uncertainty")), sensitivity = finite(component.sensitivity ?? 1, "sensitivity");
      let draw;
      if (component.distribution === "normal") draw = normalSample(random) * width / finite(component.coverageFactor ?? 1, "coverageFactor");
      else if (component.distribution === "rectangular") draw = (random() * 2 - 1) * width;
      else if (component.distribution === "triangular") draw = (random() - random()) * width;
      else throw new Error(`Unsupported uncertainty distribution: ${component.distribution}`);
      value += sensitivity * draw;
    }
    samples[trial] = value;
  }
  return { method: "JCGM 101 Monte Carlo propagation", claimLevel: "standards-aligned", trials, seed, mean: mean(samples), standardUncertainty: Math.sqrt(variance(samples)), interval95: [quantile(samples, 0.025), quantile(samples, 0.975)] };
}

export function bootstrapConfidence(values, { trials = 10000, seed = 2718 } = {}) {
  if (!Array.isArray(values) || values.length < 2) throw new Error("At least two repeat values are required");
  const clean = values.map((value, index) => finite(value, `values[${index}]`)), random = mulberry32(seed), estimates = [];
  for (let trial = 0; trial < trials; trial++) estimates.push(mean(clean.map(() => clean[Math.floor(random() * clean.length)])));
  return { estimate: mean(clean), repeatabilityStandardDeviation: Math.sqrt(variance(clean)), trials, seed, confidenceInterval95: [quantile(estimates, 0.025), quantile(estimates, 0.975)] };
}

export function complexTransferQuality(bins, options = {}) {
  if (!Array.isArray(bins) || bins.length < 2) throw new Error("At least two transfer-function bins are required");
  const thresholds = { minimumCoherence: options.minimumCoherence ?? 0.8, maximumPhaseUncertaintyDeg: options.maximumPhaseUncertaintyDeg ?? 20, maximumHarmonicContaminationDb: options.maximumHarmonicContaminationDb ?? -30, minimumInputPower: options.minimumInputPower ?? 1e-12 };
  const rows = bins.map((bin, index) => {
    const sxx = finite(bin.inputPower, `bins[${index}].inputPower`), syy = finite(bin.outputPower, `bins[${index}].outputPower`), crossReal = finite(bin.crossReal, `bins[${index}].crossReal`), crossImag = finite(bin.crossImag, `bins[${index}].crossImag`), averages = Math.max(1, Number(bin.averages ?? 1));
    const coherence = Math.max(0, Math.min(1, (crossReal ** 2 + crossImag ** 2) / Math.max(Number.EPSILON, sxx * syy)));
    const phaseUncertaintyDeg = Math.sqrt(Math.max(0, 1 - coherence) / Math.max(Number.EPSILON, 2 * coherence * averages)) * 180 / Math.PI;
    const harmonicContaminationDb = bin.harmonicPower === undefined ? null : 10 * Math.log10(Math.max(Number.EPSILON, finite(bin.harmonicPower, "harmonicPower")) / Math.max(Number.EPSILON, syy));
    const reasons = [];
    if (sxx < thresholds.minimumInputPower) reasons.push("insufficient excitation");
    if (coherence < thresholds.minimumCoherence) reasons.push("low coherence");
    if (phaseUncertaintyDeg > thresholds.maximumPhaseUncertaintyDeg) reasons.push("phase confidence too low");
    if (harmonicContaminationDb !== null && harmonicContaminationDb > thresholds.maximumHarmonicContaminationDb) reasons.push("harmonic contamination");
    return { frequencyHz: finite(bin.frequencyHz, "frequencyHz"), coherence, phaseUncertaintyDeg, harmonicContaminationDb, valid: reasons.length === 0, rejectionReasons: reasons };
  });
  const timing = (options.repeatTimingSeconds || []).map(Number), elapsed = (options.repeatElapsedSeconds || []).map(Number);
  let clockDriftPpm = null;
  if (timing.length >= 2 && timing.length === elapsed.length) {
    const xMean = mean(elapsed), yMean = mean(timing), denominator = elapsed.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
    if (denominator > 0) clockDriftPpm = elapsed.reduce((sum, x, i) => sum + (x - xMean) * (timing[i] - yMean), 0) / denominator * 1e6;
  }
  const validFraction = rows.filter(row => row.valid).length / rows.length;
  return { claimLevel: "engineering-quality-screen", thresholds, bins: rows, validFraction, accepted: validFraction >= (options.minimumValidFraction ?? 0.9) && (clockDriftPpm === null || Math.abs(clockDriftPpm) <= (options.maximumClockDriftPpm ?? 100)), clockDriftPpm, automaticRejection: true };
}

const decayFit = (time, decay, upperDb, lowerDb) => {
  const points = decay.map((level, i) => ({ x: time[i], y: level })).filter(point => point.y <= upperDb && point.y >= lowerDb);
  if (points.length < 3) return null;
  const xMean = mean(points.map(point => point.x)), yMean = mean(points.map(point => point.y));
  const sxx = points.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0), slope = points.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0) / sxx, intercept = yMean - slope * xMean;
  const residual = points.reduce((sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0), total = points.reduce((sum, point) => sum + (point.y - yMean) ** 2, 0);
  if (!(slope < 0)) return null;
  const slopeStandardError = points.length > 2 ? Math.sqrt((residual / (points.length - 2)) / sxx) : Infinity, rt60 = -60 / slope;
  return { rt60Seconds: rt60, slopeDbPerSecond: slope, rSquared: total > 0 ? 1 - residual / total : 1, standardUncertaintySeconds: Math.abs(60 / slope ** 2 * slopeStandardError), points: points.length };
};

export function roomAcousticMetrics(impulse, sampleRateHz, options = {}) {
  if (!Array.isArray(impulse) || impulse.length < 128) throw new Error("Impulse response requires at least 128 samples");
  const rate = finite(sampleRateHz, "sampleRateHz");
  if (rate < 8000 || rate > 384000) throw new Error("sampleRateHz outside supported range");
  const samples = impulse.map(Number), directIndex = options.directIndex ?? samples.reduce((best, value, index) => Math.abs(value) > Math.abs(samples[best]) ? index : best, 0), energy = samples.slice(directIndex).map(value => value ** 2);
  const schroeder = new Array(energy.length); let cumulative = 0;
  for (let i = energy.length - 1; i >= 0; i--) { cumulative += energy[i]; schroeder[i] = cumulative; }
  if (!(schroeder[0] > 0)) throw new Error("Impulse response has no energy");
  const decayDb = schroeder.map(value => 10 * Math.log10(Math.max(Number.EPSILON, value / schroeder[0]))), time = decayDb.map((_, i) => i / rate), sumRange = (startMs, endMs = Infinity) => energy.reduce((sum, value, i) => { const ms = i / rate * 1000; return ms >= startMs && ms < endMs ? sum + value : sum; }, 0);
  const early50 = sumRange(0, 50), early80 = sumRange(0, 80), totalEnergy = sumRange(0), late50 = Math.max(Number.EPSILON, totalEnergy - early50), late80 = Math.max(Number.EPSILON, totalEnergy - early80);
  const centerTimeMs = energy.reduce((sum, value, i) => sum + i / rate * value, 0) / totalEnergy * 1000;
  const result = {
    claimLevel: "ISO-3382-aligned screening",
    directIndex,
    directTimeSeconds: directIndex / rate,
    edt: decayFit(time, decayDb, 0, -10),
    t20: decayFit(time, decayDb, -5, -25),
    t30: decayFit(time, decayDb, -5, -35),
    clarityC50Db: 10 * Math.log10(early50 / late50),
    clarityC80Db: 10 * Math.log10(early80 / late80),
    definitionD50Percent: early50 / totalEnergy * 100,
    centerTimeMs,
    decay: decayDb.map((levelDb, i) => ({ timeSeconds: time[i], levelDb }))
  };
  result.acceptedForInterpretation = [result.edt, result.t20, result.t30].filter(Boolean).every(metric => metric.rSquared >= (options.minimumDecayRSquared ?? 0.9));
  result.boundary = "ISO conformity requires its prescribed source, room, positions, bands, background-noise correction, instrumentation, and reporting procedure.";
  return result;
}

export function spatialRoomSummary(metrics) {
  if (!Array.isArray(metrics) || metrics.length < 2) throw new Error("At least two positions are required");
  const fields = ["clarityC50Db", "clarityC80Db", "definitionD50Percent", "centerTimeMs"], summary = {};
  for (const field of fields) { const values = metrics.map(item => finite(item[field], field)); summary[field] = { mean: mean(values), standardDeviation: Math.sqrt(variance(values)), minimum: Math.min(...values), maximum: Math.max(...values) }; }
  return { positions: metrics.length, spatialVariance: summary, claimLevel: "ISO-3382-aligned screening" };
}

export function speechTransmissionScreening(bands, { redundancyPenalty = 0 } = {}) {
  if (!Array.isArray(bands) || bands.length < 2) throw new Error("At least two speech bands are required");
  const weightSum = bands.reduce((sum, band) => sum + finite(band.importanceWeight, "importanceWeight"), 0);
  if (!(weightSum > 0)) throw new Error("Speech-band weights must sum above zero");
  const rows = bands.map(band => {
    if (!Array.isArray(band.modulationTransferFactors) || band.modulationTransferFactors.length === 0) throw new Error("Each speech band needs modulation transfer factors");
    const transmissionIndices = band.modulationTransferFactors.map(value => { const mtf = Math.max(1e-6, Math.min(1 - 1e-6, finite(value, "modulationTransferFactor"))), apparentSnrDb = Math.max(-15, Math.min(15, 10 * Math.log10(mtf / (1 - mtf)))); return (apparentSnrDb + 15) / 30; });
    return { centerFrequencyHz: finite(band.centerFrequencyHz, "centerFrequencyHz"), importanceWeight: band.importanceWeight, meanTransmissionIndex: mean(transmissionIndices), transmissionIndices };
  });
  const screeningIndex = Math.max(0, Math.min(1, rows.reduce((sum, row) => sum + row.meanTransmissionIndex * row.importanceWeight, 0) / weightSum - redundancyPenalty));
  return { claimLevel: "IEC-60268-16-inspired STI screening", screeningIndex, rows, redundancyPenalty, boundary: "This tool accepts caller-supplied modulation transfer factors and importance weights. It does not implement or certify the complete IEC 60268-16 measurement, auditory masking, level, redundancy, gender, uncertainty, or reporting procedure." };
}

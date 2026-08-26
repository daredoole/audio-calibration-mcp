const finite = (value, name) => { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${name} must be finite`); return number; };
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const db = value => 20 * Math.log10(Math.max(Number.EPSILON, value));
const complex = value => ({ re: finite(value.re, "complex.re"), im: finite(value.im, "complex.im") });
const add = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const multiply = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const conjugate = a => ({ re: a.re, im: -a.im });
const magnitude = a => Math.hypot(a.re, a.im);

export function polarCharacterization(angles) {
  if (!Array.isArray(angles) || angles.length < 3) throw new Error("At least three polar angles are required");
  const frequencies = angles[0].response.map(point => finite(point.frequencyHz, "frequencyHz"));
  if (angles.some(angle => angle.response.length !== frequencies.length)) throw new Error("Every angle must use the same frequency grid");
  const rows = frequencies.map((frequencyHz, index) => {
    const onAxis = angles.find(angle => Number(angle.horizontalDeg) === 0 && Number(angle.verticalDeg ?? 0) === 0)?.response[index]?.levelDb;
    if (angles.some(angle => finite(angle.response[index].frequencyHz, "frequencyHz") !== frequencyHz)) throw new Error("Every angle must use the same frequency values");
    const levels = angles.map(angle => finite(angle.response[index].levelDb, "levelDb"));
    const angularMeanDb = 10 * Math.log10(mean(levels.map(value => 10 ** (value / 10))));
    return { frequencyHz, onAxisDb: onAxis ?? levels[0], angularMeanDb, directivityIndexDb: (onAxis ?? levels[0]) - angularMeanDb, spatialStandardDeviationDb: Math.sqrt(mean(levels.map(value => (value - mean(levels)) ** 2))) };
  });
  const horizontal = new Set(angles.map(angle => Number(angle.horizontalDeg))), vertical = new Set(angles.map(angle => Number(angle.verticalDeg ?? 0)));
  return { claimLevel: "CTA-2034-style exploratory characterization", rows, scan: { positions: angles.length, horizontalAngles: horizontal.size, verticalAngles: vertical.size }, completeSpinorama: horizontal.size >= 19 && vertical.size >= 19, boundary: "A CTA-2034-B conformity claim requires its complete normative angular grid, environment, processing, and reporting procedure." };
}

export function maximumCleanOutput(levelRuns, options = {}) {
  if (!Array.isArray(levelRuns) || levelRuns.length < 2) throw new Error("At least two ascending level runs are required");
  const sorted = [...levelRuns].sort((a, b) => a.inputLevelDb - b.inputLevelDb), baseline = sorted[0], limitDb = options.maximumCompressionDb ?? 3, minimumCoherence = options.minimumCoherence ?? 0.8;
  const rows = sorted.map(run => {
    const expectedOutputDb = baseline.outputLevelDb + (run.inputLevelDb - baseline.inputLevelDb), compressionDb = expectedOutputDb - run.outputLevelDb, coherent = run.coherence === undefined || run.coherence >= minimumCoherence, clean = compressionDb <= limitDb && coherent && !run.limiterObserved;
    return { ...run, expectedOutputDb, compressionDb, clean, reasons: [compressionDb > limitDb ? "compression limit exceeded" : null, !coherent ? "coherence limit exceeded" : null, run.limiterObserved ? "limiter observed" : null].filter(Boolean) };
  });
  const accepted = rows.filter(row => row.clean);
  return { claimLevel: "AES75-inspired screening", maximumCleanOutputDb: accepted.length ? Math.max(...accepted.map(row => row.outputLevelDb)) : null, rows, boundary: "AES75 conformity requires the normative excitation, transfer-function procedure, calibrated level chain, stopping conditions, and reporting requirements." };
}

export function optimizeComplexSources({ trainMatrices, heldOutMatrices = [], targets, regularization = 0.01, maxGainDb = 6, iterations = 500 }) {
  if (!Array.isArray(trainMatrices) || trainMatrices.length === 0) throw new Error("Training matrices are required");
  const frequencies = trainMatrices.length, sources = trainMatrices[0][0]?.length;
  if (!sources) throw new Error("At least one source is required");
  const weights = [];
  for (let f = 0; f < frequencies; f++) {
    const A = trainMatrices[f].map(row => row.map(complex)), target = (targets[f] || A.map(() => ({ re: 1, im: 0 }))).map(complex);
    if (A.some(row => row.length !== sources) || target.length !== A.length) throw new Error("Inconsistent transfer-matrix dimensions");
    let w = Array.from({ length: sources }, () => ({ re: 0, im: 0 }));
    const norm2 = A.reduce((sum, row) => sum + row.reduce((inner, value) => inner + magnitude(value) ** 2, 0), 0), step = 0.4 / Math.max(Number.EPSILON, norm2 + regularization), maxGain = 10 ** (maxGainDb / 20);
    for (let iteration = 0; iteration < iterations; iteration++) {
      const residual = A.map((row, seat) => add(row.reduce((sum, value, source) => add(sum, multiply(value, w[source])), { re: 0, im: 0 }), { re: -target[seat].re, im: -target[seat].im }));
      w = w.map((value, source) => {
        const gradient = A.reduce((sum, row, seat) => add(sum, multiply(conjugate(row[source]), residual[seat])), { re: regularization * value.re, im: regularization * value.im });
        const next = { re: value.re - step * gradient.re, im: value.im - step * gradient.im }, gain = magnitude(next);
        return gain > maxGain ? { re: next.re * maxGain / gain, im: next.im * maxGain / gain } : next;
      });
    }
    weights.push(w.map(value => ({ ...value, magnitudeDb: db(magnitude(value)), phaseDeg: Math.atan2(value.im, value.re) * 180 / Math.PI })));
  }
  const evaluate = matrices => matrices.map((matrix, f) => {
    const target = (targets[f] || matrix.map(() => ({ re: 1, im: 0 }))).map(complex), outputs = matrix.map(row => row.map(complex).reduce((sum, value, source) => add(sum, multiply(value, weights[f][source])), { re: 0, im: 0 }));
    return Math.sqrt(mean(outputs.map((output, seat) => magnitude(add(output, { re: -target[seat].re, im: -target[seat].im })) ** 2)));
  });
  const trainingError = evaluate(trainMatrices), heldOutError = heldOutMatrices.length ? evaluate(heldOutMatrices) : null;
  return { claimLevel: "research-grade constrained optimization", weights, regularization, maxGainDb, trainingRmsError: mean(trainingError), heldOutRmsError: heldOutError ? mean(heldOutError) : null, accepted: Boolean(heldOutError) && mean(heldOutError) <= mean(trainingError) * 1.5, constraints: { iterations, complexFrequencyWeights: true }, boundary: "These independent frequency weights are not directly deployable. FIR realization, causality, latency, headroom, and measured post-application verification are mandatory." };
}

export function optimizePhysicalSourceControls({ frequenciesHz, trainMatrices, heldOutMatrices = [], targets, constraints, passes = 3 }) {
  if (!Array.isArray(frequenciesHz) || frequenciesHz.length !== trainMatrices.length || targets.length !== frequenciesHz.length) throw new Error("Frequency, matrix, and target grids must match");
  const sources = trainMatrices[0]?.[0]?.length;
  if (!sources || sources > 8 || constraints.length !== sources) throw new Error("One constraint set is required for each of 1-8 sources");
  const candidates = constraints.map((constraint, source) => {
    const delays = [], gains = [], delayStepMs = constraint.delayStepMs ?? 0.25, gainStepDb = constraint.gainStepDb ?? 1;
    for (let value = constraint.minimumDelayMs ?? 0; value <= (constraint.maximumDelayMs ?? 0) + 1e-9; value += delayStepMs) delays.push(value);
    for (let value = constraint.minimumGainDb ?? -12; value <= (constraint.maximumGainDb ?? 6) + 1e-9; value += gainStepDb) gains.push(value);
    const polarities = constraint.polarities ?? [1, -1], rows = [];
    for (const delayMs of delays) for (const gainDb of gains) for (const polarity of polarities) rows.push({ source, delayMs, gainDb, polarity, highPassHz: constraint.highPassHz ?? null, lowPassHz: constraint.lowPassHz ?? null });
    if (rows.length > 5000) throw new Error("Source constraint grid exceeds 5,000 candidates");
    return rows;
  });
  const responseWeight = (control, frequencyHz) => {
    const phase = -2 * Math.PI * frequencyHz * control.delayMs / 1000, gain = 10 ** (control.gainDb / 20) * control.polarity;
    const highPass = control.highPassHz ? 1 / Math.sqrt(1 + (control.highPassHz / frequencyHz) ** 4) : 1, lowPass = control.lowPassHz ? 1 / Math.sqrt(1 + (frequencyHz / control.lowPassHz) ** 4) : 1, scale = gain * highPass * lowPass;
    return { re: scale * Math.cos(phase), im: scale * Math.sin(phase) };
  };
  const objective = (matrices, controls) => mean(matrices.flatMap((matrix, f) => matrix.map((row, seat) => { const output = row.map(complex).reduce((sum, value, source) => add(sum, multiply(value, responseWeight(controls[source], frequenciesHz[f]))), { re: 0, im: 0 }), target = complex(targets[f][seat]); return magnitude(add(output, { re: -target.re, im: -target.im })) ** 2; })));
  let controls = candidates.map(rows => rows.reduce((best, row) => Math.abs(row.gainDb) + Math.abs(row.delayMs) < Math.abs(best.gainDb) + Math.abs(best.delayMs) && row.polarity === 1 ? row : best, rows[0]));
  for (let pass = 0; pass < passes; pass++) for (let source = 0; source < sources; source++) {
    let best = controls[source], bestError = objective(trainMatrices, controls);
    for (const candidate of candidates[source]) { const proposal = [...controls]; proposal[source] = candidate; const error = objective(trainMatrices, proposal); if (error < bestError) { best = candidate; bestError = error; } }
    controls[source] = best;
  }
  const trainingRmsError = Math.sqrt(objective(trainMatrices, controls)), heldOutRmsError = heldOutMatrices.length ? Math.sqrt(objective(heldOutMatrices, controls)) : null, maximumGainDb = Math.max(...controls.map(control => control.gainDb)), totalLinearGain = controls.reduce((sum, control) => sum + 10 ** (control.gainDb / 20), 0);
  return { claimLevel: "physically constrained research optimization", controls, trainingRmsError, heldOutRmsError, accepted: heldOutRmsError !== null && heldOutRmsError <= trainingRmsError * 1.5, headroom: { maximumSourceGainDb: maximumGainDb, summedGainUpperBoundDb: db(totalLinearGain) }, constraints: { discreteDelay: true, discretePolarity: true, fixedHighPassLowPass: true, passes }, boundary: "Crossover responses are generic fourth-order magnitude constraints, not device filters. Confirm realized phase, causality, headroom, limiter behavior, and every protected held-out seat by measurement before deployment." };
}

const fft = (input, inverse = false) => {
  const n = input.length; if (n < 2 || (n & (n - 1))) throw new Error("FFT length must be a power of two");
  const output = input.map(complex);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [output[i], output[j]] = [output[j], output[i]]; }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length, root = { re: Math.cos(angle), im: Math.sin(angle) };
    for (let start = 0; start < n; start += length) { let factor = { re: 1, im: 0 }; for (let j = 0; j < length / 2; j++) { const even = output[start + j], odd = multiply(output[start + j + length / 2], factor); output[start + j] = add(even, odd); output[start + j + length / 2] = add(even, { re: -odd.re, im: -odd.im }); factor = multiply(factor, root); } }
  }
  return inverse ? output.map(value => ({ re: value.re / n, im: value.im / n })) : output;
};

export function designRegularizedFir({ measuredResponse, targetResponse, taps = 1024, regularization = 0.01, maxBoostDb = 6, latencySamples = null, quantizationBits = 32 }) {
  if (taps < 64 || taps > 16384 || (taps & (taps - 1))) throw new Error("taps must be a power of two from 64 to 16,384");
  if (measuredResponse.length !== taps / 2 + 1 || targetResponse.length !== measuredResponse.length) throw new Error("Responses must contain taps/2+1 complex bins");
  const maxGain = 10 ** (maxBoostDb / 20), positive = measuredResponse.map((raw, index) => { const h = complex(raw), target = complex(targetResponse[index]), denominator = magnitude(h) ** 2 + regularization; let value = multiply(target, { re: h.re / denominator, im: -h.im / denominator }); const gain = magnitude(value); if (gain > maxGain) value = { re: value.re * maxGain / gain, im: value.im * maxGain / gain }; return value; });
  const spectrum = [...positive, ...positive.slice(1, -1).reverse().map(conjugate)], unshifted = fft(spectrum, true).map(value => value.re), latency = latencySamples ?? Math.floor(taps / 4), shifted = unshifted.map((_, index) => unshifted[(index - latency + taps) % taps]);
  const windowed = shifted.map((value, index) => value * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (taps - 1)))), scale = 2 ** (quantizationBits - 1) - 1, quantized = windowed.map(value => Math.round(Math.max(-1, Math.min(1, value)) * scale) / scale), peakIndex = quantized.reduce((best, value, index) => Math.abs(value) > Math.abs(quantized[best]) ? index : best, 0), totalEnergy = quantized.reduce((sum, value) => sum + value ** 2, 0), preEnergy = quantized.slice(0, peakIndex).reduce((sum, value) => sum + value ** 2, 0);
  return { claimLevel: "engineering FIR design", taps: quantized, metadata: { tapCount: taps, regularization, maxBoostDb, latencySamples: latency, quantizationBits, peakIndex, peak: Math.max(...quantized.map(Math.abs)), preRingingEnergyRatio: preEnergy / Math.max(Number.EPSILON, totalEnergy), headroomDb: -db(Math.max(...quantized.map(Math.abs))) }, deploymentGate: { accepted: preEnergy / Math.max(Number.EPSILON, totalEnergy) <= 0.25, requiresMeasuredHardwareVerification: true, requiresLimiterInteractionCheck: true, requiresTruePeakVerification: true }, boundary: "Generated coefficients are a proposal; measured hardware response and protected-level verification decide deployment." };
}

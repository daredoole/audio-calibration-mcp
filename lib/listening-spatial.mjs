const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const variance = values => values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1);
const hashSeed = text => [...String(text)].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0, 2166136261);
const randomSource = seed => { let state = hashSeed(seed); return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
const shuffle = (values, random) => { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; };
const wilson = (successes, total, z = 1.96) => { const p = successes / total, denominator = 1 + z ** 2 / total, center = (p + z ** 2 / (2 * total)) / denominator, margin = z * Math.sqrt(p * (1 - p) / total + z ** 2 / (4 * total ** 2)) / denominator; return [Math.max(0, center - margin), Math.min(1, center + margin)]; };

export function laboratoryListeningPlan({ method, systems, trials = 12, listeners = 1, seed = "audio-calibration", excerpts = [] }) {
  if (!["MUSHRA", "BS.1116"].includes(method)) throw new Error("method must be MUSHRA or BS.1116");
  if (!Array.isArray(systems) || systems.length < 2) throw new Error("At least two systems are required");
  const random = randomSource(seed), assignments = [];
  for (let listener = 1; listener <= listeners; listener++) for (let trial = 1; trial <= trials; trial++) assignments.push({ listener, trial, excerpt: excerpts[(trial - 1) % Math.max(1, excerpts.length)] ?? null, presentationOrder: shuffle(systems.map(system => system.id), random) });
  const hiddenReference = systems.find(system => system.role === "hidden-reference"), anchor = systems.find(system => system.role === "anchor");
  return { claimLevel: `ITU-R ${method}-inspired research plan`, method, assignments, seed, blinded: true, hiddenReferencePresent: Boolean(hiddenReference), anchorPresent: Boolean(anchor), ready: Boolean(hiddenReference) && (method === "BS.1116" || Boolean(anchor)), requiredControls: ["level matching", "controlled monitoring chain", "listener training and screening", "randomized concealed identity", "repeat trials", "documented exclusions"], boundary: "ITU conformity requires the complete current Recommendation, prescribed conditions, programme material, listener panel, training, and statistical procedure." };
}

export function laboratoryListeningReport(plan, responses) {
  if (!plan?.method || !Array.isArray(responses) || responses.length === 0) throw new Error("Plan and responses are required");
  const systems = [...new Set(responses.map(response => response.systemId))], bySystem = {};
  for (const systemId of systems) {
    const rows = responses.filter(response => response.systemId === systemId), scores = rows.map(row => Number(row.score)).filter(Number.isFinite);
    bySystem[systemId] = { observations: scores.length, mean: mean(scores), standardDeviation: Math.sqrt(variance(scores)), confidenceInterval95: scores.length ? [mean(scores) - 1.96 * Math.sqrt(variance(scores) / scores.length), mean(scores) + 1.96 * Math.sqrt(variance(scores) / scores.length)] : null };
  }
  const screening = responses.filter(response => typeof response.correct === "boolean"), successes = screening.filter(response => response.correct).length;
  return { claimLevel: `${plan.claimLevel || "laboratory listening"} analysis`, systems: bySystem, listenerScreening: screening.length ? { trials: screening.length, successes, fraction: successes / screening.length, confidenceInterval95: wilson(successes, screening.length) } : null, repeatability: responses.filter(row => row.repeatGroup).reduce((groups, row) => { (groups[row.repeatGroup] ||= []).push(row.score); return groups; }, {}), boundary: "Descriptive statistics do not establish perceptual equivalence or preference without adequate power, valid controls, and the prespecified inferential analysis." };
}

export function spatialLayoutAssessment({ channels, listener = { x: 0, y: 0, z: 0 }, headPositionMetadata = null }) {
  if (!Array.isArray(channels) || channels.length < 2) throw new Error("At least two channels are required");
  const labels = new Set(), issues = [], normalized = channels.map(channel => {
    if (labels.has(channel.label)) issues.push(`duplicate channel label: ${channel.label}`); labels.add(channel.label);
    if (channel.azimuthDeg < -180 || channel.azimuthDeg > 180) issues.push(`invalid azimuth: ${channel.label}`);
    if (channel.elevationDeg < -90 || channel.elevationDeg > 90) issues.push(`invalid elevation: ${channel.label}`);
    const radiusM = channel.radiusM ?? 1, azimuth = channel.azimuthDeg * Math.PI / 180, elevation = channel.elevationDeg * Math.PI / 180;
    return { ...channel, radiusM, coordinatesM: { x: listener.x + radiusM * Math.cos(elevation) * Math.sin(azimuth), y: listener.y + radiusM * Math.cos(elevation) * Math.cos(azimuth), z: listener.z + radiusM * Math.sin(elevation) } };
  });
  return { claimLevel: "BS.2051-metadata screening", valid: issues.length === 0, issues, channels: normalized, headPositionMetadata, boundary: "Layout labels and coordinates are checked for consistency only; BS.2051 compliance requires validation against the normative system definitions and reproduction conditions." };
}

export function sofaMetadataAssessment(metadata) {
  const required = ["SOFAConventions", "DataType", "RoomType", "SourcePosition", "ReceiverPosition", "DataIR", "SamplingRate"], missing = required.filter(key => metadata[key] === undefined), dimensions = {
    sourcePositions: Array.isArray(metadata.SourcePosition) ? metadata.SourcePosition.length : 0,
    receiverPositions: Array.isArray(metadata.ReceiverPosition) ? metadata.ReceiverPosition.length : 0,
    measurements: Array.isArray(metadata.DataIR) ? metadata.DataIR.length : 0
  };
  return { claimLevel: "SOFA metadata preflight", valid: missing.length === 0, missing, dimensions, convention: metadata.SOFAConventions ?? null, boundary: "This preflight does not parse HDF5, validate a convention-specific schema, or certify SOFA conformance; use a maintained SOFA API for import/export." };
}

export function evaluationCorpusManifest({ synthetic = [], external = [], loopbacks = [], crossTool = [] }) {
  const classify = item => ({ id: item.id, sha256: item.sha256 ?? null, license: item.license ?? null, provenance: item.provenance ?? null, independent: Boolean(item.independent), regressionTolerance: item.regressionTolerance ?? null });
  const sections = { synthetic: synthetic.map(classify), external: external.map(classify), loopbacks: loopbacks.map(classify), crossTool: crossTool.map(classify) }, independentCount = [...sections.external, ...sections.loopbacks, ...sections.crossTool].filter(item => item.independent && item.sha256 && item.provenance).length;
  return { schemaVersion: 1, sections, gates: { everyArtifactHasHash: Object.values(sections).flat().every(item => Boolean(item.sha256)), everyExternalArtifactHasLicense: sections.external.every(item => Boolean(item.license)), independentReferenceCount: independentCount, interLabReady: independentCount >= 2 }, boundary: "Synthetic fixtures test algorithms but are not independent validation. Inter-laboratory reproducibility needs separately produced, traceable measurements." };
}

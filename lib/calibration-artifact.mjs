export const CALIBRATION_ARTIFACT_VERSION = 1;
const DEVICE_CLASSES = new Set(["general", "car", "laptop"]);
const SENSITIVE_KEY = /(user(name)?|home|path|host(name)?|ip(address)?|mac(address)?|serial|device.?id|room.?name|coordinates?|location)/i;
const RAW_TRACE_KEY = /^(frequencies?|magnitude|phase|impulse|samples?|frequencyResponse|groupDelay|distortion|rt60)$/i;

const plain = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safeString = value => String(value).replace(/(?:[A-Za-z]:\\|\/home\/|\/Users\/)[^\s"']+/g, "[REDACTED_PATH]").replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]").replace(/\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi, "[REDACTED_MAC]");

export function validateCalibrationArtifact(value) {
  const errors = [], warnings = [];
  if (!plain(value)) return { valid: false, errors: ["Artifact must be a plain JSON object"], warnings };
  if (value.schemaVersion !== CALIBRATION_ARTIFACT_VERSION) errors.push(`Unsupported schemaVersion ${value.schemaVersion}`);
  if (value.kind !== "audio-calibration-session") errors.push("kind must be audio-calibration-session");
  if (!Number.isFinite(Date.parse(value.createdAt))) errors.push("createdAt must be an ISO timestamp");
  if (!plain(value.session)) errors.push("session is required");
  else {
    if (typeof value.session.id !== "string" || !value.session.id) errors.push("session.id is required");
    if (!DEVICE_CLASSES.has(value.session.deviceClass)) errors.push("session.deviceClass is invalid");
    if (!value.session.algorithmVersion) warnings.push("algorithmVersion is missing; replay may not be reproducible");
  }
  if (!Array.isArray(value.sweeps) || value.sweeps.length > 256) errors.push("sweeps must be an array with at most 256 entries");
  else for (const [index, sweep] of value.sweeps.entries()) {
    if (!plain(sweep) || typeof sweep.id !== "string") errors.push(`sweeps[${index}].id is required`);
    if (!plain(sweep?.fingerprints)) errors.push(`sweeps[${index}].fingerprints is required`);
    else for (const key of ["control", "preset", "microphone"]) if (typeof sweep.fingerprints[key] !== "string" || sweep.fingerprints[key].length < 8) errors.push(`sweeps[${index}].fingerprints.${key} is required`);
  }
  try { if (Buffer.byteLength(JSON.stringify(value)) > 5_000_000) errors.push("Artifact exceeds the 5 MB metadata limit"); } catch { errors.push("Artifact is not JSON serializable"); }
  return { valid: errors.length === 0, errors, warnings, schemaVersion: value.schemaVersion };
}

export function createCalibrationArtifact({ session, sweeps = [], analyses = {}, filters = [], verification = null, provenance = {} }) {
  const artifact = {
    schemaVersion: CALIBRATION_ARTIFACT_VERSION, kind: "audio-calibration-session",
    createdAt: new Date().toISOString(), session, sweeps, analyses, filters, verification,
    provenance: { software: "audio-calibration-mcp", ...provenance }
  };
  const validation = validateCalibrationArtifact(artifact);
  if (!validation.valid) throw new Error(`Invalid calibration artifact: ${validation.errors.join("; ")}`);
  return artifact;
}

export function migrateCalibrationArtifact(value) {
  if (value?.schemaVersion === CALIBRATION_ARTIFACT_VERSION) return { artifact: value, migrated: false, fromVersion: value.schemaVersion };
  if (!plain(value) || ![undefined, 0].includes(value.schemaVersion)) throw new Error("Unsupported artifact version");
  const legacySession = value.session || value;
  const artifact = {
    schemaVersion: 1, kind: "audio-calibration-session", createdAt: value.createdAt || new Date().toISOString(),
    session: {
      id: String(legacySession.id || legacySession.name || "legacy-session"),
      deviceClass: DEVICE_CLASSES.has(legacySession.deviceClass) ? legacySession.deviceClass : "general",
      algorithmVersion: legacySession.algorithmVersion || "legacy-unknown",
      targetId: legacySession.targetId || null
    },
    sweeps: Array.isArray(value.sweeps) ? value.sweeps : [], analyses: value.analyses || {},
    filters: value.filters || [], verification: value.verification || null,
    provenance: { software: "audio-calibration-mcp", migratedFrom: value.schemaVersion ?? 0 }
  };
  return { artifact, migrated: true, fromVersion: value.schemaVersion ?? 0, validation: validateCalibrationArtifact(artifact) };
}

export function sanitizeSupportData(value, { maxDepth = 12, maxArray = 100 } = {}, depth = 0, key = "") {
  if (depth > maxDepth) return "[OMITTED_DEPTH]";
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (RAW_TRACE_KEY.test(key)) return Array.isArray(value) ? { omitted: true, sampleCount: value.length } : "[OMITTED_RAW_TRACE]";
  if (typeof value === "string") return safeString(value).slice(0, 2000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, maxArray).map(item => sanitizeSupportData(item, { maxDepth, maxArray }, depth + 1, key));
  if (!plain(value)) return String(value).slice(0, 200);
  const out = Object.create(null);
  for (const [childKey, childValue] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(childKey)) continue;
    out[childKey] = sanitizeSupportData(childValue, { maxDepth, maxArray }, depth + 1, childKey);
  }
  return out;
}

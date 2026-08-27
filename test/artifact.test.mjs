import test from "node:test";
import assert from "node:assert/strict";
import { createCalibrationArtifact, migrateCalibrationArtifact, sanitizeSupportData, validateCalibrationArtifact } from "../lib/calibration-artifact.mjs";

const hash = char => char.repeat(64);
const sweep = { id: "L-1", fingerprints: { control: hash("a"), preset: hash("b"), microphone: hash("c"), sweep: hash("d") }, traceHash: hash("e"), measurementFileHash: hash("f"), measurementFile: "measurements/session.mdat" };

test("versioned calibration artifacts validate and preserve reproducibility identity", () => {
  const artifact = createCalibrationArtifact({ session: { id: "s1", deviceClass: "laptop", algorithmVersion: "0.1.0", targetId: "nearfield" }, sweeps: [sweep], provenance: { softwareVersion: "0.1.0" } });
  assert.equal(validateCalibrationArtifact(artifact).valid, true); assert.equal(artifact.kind, "audio-calibration-session");
  assert.equal(migrateCalibrationArtifact(artifact).migrated, false);
});

test("legacy migration is explicit and invalid fingerprints are rejected", () => {
  const migrated = migrateCalibrationArtifact({ name: "old", deviceClass: "car", sweeps: [] });
  assert.equal(migrated.migrated, true); assert.equal(migrated.artifact.schemaVersion, 1);
  assert.equal(validateCalibrationArtifact({ ...migrated.artifact, sweeps: [{ id: "x", fingerprints: {} }] }).valid, false);
});

test("support sanitization removes identifiers and raw trace arrays", () => {
  const sanitized = sanitizeSupportData({ username: "private-user", path: "/home/example/private/file", ipAddress: "192.0.2.10", magnitude: [1, 2, 3], note: "open /Users/example/file at 198.51.100.4", nested: { constructor: "bad", safe: true } });
  assert.equal(sanitized.username, "[REDACTED]"); assert.equal(sanitized.path, "[REDACTED]"); assert.deepEqual(sanitized.magnitude, { omitted: true, sampleCount: 3 });
  assert.match(sanitized.note, /REDACTED/); assert.equal(sanitized.nested.constructor, undefined); assert.equal(sanitized.nested.safe, true);
});

test("corrupt artifact fuzzing is bounded and never executes prototype keys", () => {
  for (let i = 0; i < 500; i++) {
    const artifact = { schemaVersion: Math.floor(Math.random() * 4), kind: String(Math.random()), createdAt: "bad", session: { id: "x", deviceClass: "general" }, sweeps: Array.from({ length: i % 8 }, (_, n) => ({ id: String(n), fingerprints: { __proto__: { polluted: true } } })) };
    const result = validateCalibrationArtifact(artifact); assert.equal(typeof result.valid, "boolean"); assert.equal({}.polluted, undefined);
  }
});

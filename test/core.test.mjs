import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindPlan, crossoverMetrics, decodeJamesDspState, eqProposal, frequencyAxis, hashFile, hostInventory, jamesDspAdapter, jamesDspStatus, measurementEntries, multiseatMetrics, parseJamesDspConfig, parseSeries,
  safeMeasurementSettings, safeWorkspacePath, stableToken, verifyPlan, workspaceRoot
} from "../core.mjs";

test("confirmation token binds every plan field", () => {
  const plan = bindPlan({ kind: "route", requested: { sink: "a" } });
  assert.equal(verifyPlan(plan, plan.confirmationToken).requested.sink, "a");
  assert.throws(() => verifyPlan({ ...plan, requested: { sink: "b" } }, plan.confirmationToken), /mismatch/);
  assert.throws(() => verifyPlan(plan, ""), /mismatch/);
  assert.notEqual(stableToken({ a: 1 }), stableToken({ a: 2 }));
});

test("laptop sweep guard blocks low frequencies and excessive level", () => {
  assert.equal(safeMeasurementSettings("laptop", {}).startHz, 120);
  assert.throws(() => safeMeasurementSettings("laptop", { startHz: 20 }), /120 Hz/);
  assert.throws(() => safeMeasurementSettings("laptop", { levelDbfs: -12 }), /-30 dBFS/);
  assert.throws(() => safeMeasurementSettings("laptop", { maxSplDb: 90 }), /75 dB/);
});

test("workspace guard rejects traversal, wrong extensions, and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-cal-")); await mkdir(join(root, "measurements"));
  assert.match(await safeWorkspacePath(root, "measurements/a.mdat", [".mdat"]), /a\.mdat$/);
  await assert.rejects(safeWorkspacePath(root, "../escape.mdat", [".mdat"]), /escapes/);
  await assert.rejects(safeWorkspacePath(root, "measurements/a.exe", [".mdat"]), /extension/);
  await symlink(tmpdir(), join(root, "measurements", "link"));
  await assert.rejects(safeWorkspacePath(root, "measurements/link/a.mdat", [".mdat"]), /Symlink/);
  await assert.rejects(safeWorkspacePath(root, "C:\\private\\a.mdat", [".mdat"]), /workspace-relative/);
  await assert.rejects(safeWorkspacePath(root, "\\\\server\\share\\a.mdat", [".mdat"]), /workspace-relative/);
  const outside = join(tmpdir(), `audio-hardlink-${Date.now()}.mdat`), linked = join(root, "measurements", "hard.mdat"); await writeFile(outside, "private"); await link(outside, linked);
  await assert.rejects(safeWorkspacePath(root, "measurements/hard.mdat", [".mdat"]), /Hard-linked/);
});

test("series parser rejects resource-exhaustion inputs", () => {
  assert.throws(() => parseSeries("1 ".repeat(9_000_000)), /input limit/);
});

test("file hashes, workspace roots, measurement maps, and optional host adapters are inspectable", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-core-")), file = join(root, "a.bin"); await writeFile(file, "abc");
  const hashed = await hashFile(file); assert.equal(hashed.bytes, 3); assert.equal(hashed.sha256.length, 64); assert.equal(await workspaceRoot(root), await realpath(root));
  assert.deepEqual(measurementEntries([{ id: "a", title: "A" }]).map(x => x[0]), ["a"]); assert.deepEqual(measurementEntries({ b: { title: "B" } }).map(x => x[0]), ["b"]);
  const host = await hostInventory(); assert.equal(host.platform, process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform);
  const adapter = await jamesDspAdapter(), status = await jamesDspStatus(); assert.equal(Boolean(adapter), status.available);
});

test("corrupt numeric series is bounded and non-executable", () => {
  assert.deepEqual(parseSeries("1, nope; 2 Infinity 3; process.exit()"), [1, 2, 3]);
  for (let i = 0; i < 250; i++) {
    const fuzz = Array.from({ length: 80 }, () => String.fromCharCode(32 + Math.floor(Math.random() * 95))).join("");
    const result = parseSeries(fuzz); assert.ok(Array.isArray(result)); assert.ok(result.every(Number.isFinite));
  }
});

test("REW base64 float traces decode on a logarithmic PPO axis", () => {
  const bytes = Buffer.alloc(12);
  [60.5, 61.25, 59.75].forEach((value, index) => bytes.writeFloatBE(value, index * 4));
  assert.deepEqual(parseSeries(bytes.toString("base64")), [60.5, 61.25, 59.75]);
  const axis = frequencyAxis({ startFreq: 100, ppo: 1 }, 3);
  assert.deepEqual(axis.map(Math.round), [100, 200, 400]);
});

test("crossover analysis reports constructive and destructive phase cases", () => {
  const base = { frequencies: [80, 100, 120], magnitude: [70, 70, 70] };
  const good = crossoverMetrics({ ...base, phase: [0, 0, 0] }, { ...base, phase: [0, 0, 0] }, 100, 0.25);
  const bad = crossoverMetrics({ ...base, phase: [0, 0, 0] }, { ...base, phase: [180, 180, 180] }, 100, 0.25);
  assert.ok(good.atCrossover.summationDb > 5.5); assert.ok(bad.atCrossover.summationDb < -100);
});

test("multi-seat and EQ analysis surface outliers without boosting nulls", () => {
  const a = { frequencies: [20, 40, 80, 160, 320], magnitude: [70, 70, 70, 70, 70] };
  const b = { frequencies: [20, 40, 80, 160, 320], magnitude: [70, 55, 70, 70, 70] };
  const multi = multiseatMetrics([a, b], 20, 300, 50, 0.4);
  assert.ok(multi.schroederHz > 0); assert.ok(multi.modalCandidates.length > 0);
  assert.ok(eqProposal(b, { lowHz: 20, highHz: 300, maxBoostDb: 0 }).every(x => x.gainDb <= 0));
});

test("JamesDSP snapshot distinguishes processing, bypass, EQ modules, and exact preset identity", () => {
  const config = "master_enable=true\ngraphiceq_enable=true\ntone_enable=false\nreverb_enable=false\ngraphiceq_param=GraphicEQ: 500 -3; 1000 -2\n";
  assert.equal(parseJamesDspConfig(config).graphiceq_enable, "true");
  const state = decodeJamesDspState({
    configText: config,
    statusText: "Is processing:\tenabled",
    connectedText: "true",
    liveValues: { master_enable: "true", graphiceq_enable: "true", tone_enable: "false", reverb_enable: "false" },
    presetConfigs: { Refined: config, Different: config.replace("500 -3", "500 -1") }
  });
  assert.equal(state.stateVerified, true);
  assert.equal(state.effectiveProcessing, true);
  assert.equal(state.equalizationActive, true);
  assert.equal(state.bypass.active, false);
  assert.deepEqual(state.enabledEqModules, ["graphiceq"]);
  assert.equal(state.presetIdentity.status, "exact");
  assert.equal(state.presetIdentity.activePreset, "Refined");
});

test("JamesDSP snapshot refuses exact preset claims when runtime and disk state drift", () => {
  const config = "master_enable=true\ngraphiceq_enable=true\ntone_enable=false\n";
  const state = decodeJamesDspState({
    configText: config,
    statusText: "Is processing: enabled",
    connectedText: "true",
    liveValues: { master_enable: "false", graphiceq_enable: "true", tone_enable: "false" },
    presetConfigs: { Saved: config }
  });
  assert.equal(state.stateVerified, false);
  assert.equal(state.runtimeConfigSynchronized, false);
  assert.deepEqual(state.runtimeDriftKeys, ["master_enable"]);
  assert.equal(state.bypass.active, true);
  assert.equal(state.equalizationActive, false);
  assert.equal(state.presetIdentity.status, "no-exact-match");
  assert.equal(state.presetIdentity.activePreset, null);
});

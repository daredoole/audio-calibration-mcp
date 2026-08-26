import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { access, copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  REW_BASE, DEVICE_LIMITS, audioSnapshot, bindPlan, crossoverMetrics, eqProposal,
  hashFile, hostAudioEnv, hostInventory, jamesDspAdapter, jamesDspBackup, jamesDspStatus, measurementEntries, multiseatMetrics,
  rew, safeMeasurementSettings, safeWorkspacePath, stableToken, verifyPlan, waitForMeasurement, workspaceRoot
} from "./core.mjs";
import {
  EVIDENCE_REGISTRY, TARGET_REGISTRY, compressionMetrics, exportFilters, guidedSessionPlan, humanListeningAssessment,
  listeningTestPlan, listeningTestReport, measurementQuality, perceptualEqProposal, renderHumanReport
} from "./human-listening.mjs";
import {
  directLateWindowAnalysis, engineeringTraceSummary, erbSmooth, frequencyDependentSmooth, linkedStereoEqProposal,
  measuredPostEqVerification, measurementStateFingerprint, multiResolutionEqProposal, speakerProtectionAssessment, traceViewRows
} from "./advanced-calibration.mjs";
import { registerReleaseTools } from "./tool-domains/release-tools.mjs";
import { createCalibrationArtifact } from "./lib/calibration-artifact.mjs";
import { registerAnalysisTools } from "./tool-domains/analysis-tools.mjs";

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: "audio-calibration", version: "0.1.0-beta.1" });
const ok = (data, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError });
const guarded = fn => async args => { try { return await fn(args); } catch (error) { return ok({ error: error.message }, true); } };
const planSchema = { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) };
const pathExists = path => access(path).then(() => true, () => false);
const writeAtomicSet = async (entries, token) => {
  for (const [path] of entries) if (await pathExists(path)) throw new Error(`Refusing to overwrite existing artifact: ${path}`);
  const temporaries = entries.map(([path, content], i) => [`${path}.tmp-${token.slice(0, 12)}-${i}`, path, content]), committed = [];
  try {
    for (const [temporary, , content] of temporaries) await writeFile(temporary, content, { flag: "wx" });
    for (const [temporary, path] of temporaries) { await rename(temporary, path); committed.push(path); }
  } catch (error) {
    await Promise.all([...temporaries.map(([temporary]) => temporary), ...committed].map(path => unlink(path).catch(() => {})));
    throw error;
  }
};
const audioStateIdentity = audio => ({ driver: audio?.driver, sampleRate: audio?.sampleRate, inputCal: audio?.inputCal, inputDevice: audio?.inputDevice, outputDevice: audio?.outputDevice, input: audio?.input, output: audio?.output, inputChannel: audio?.inputChannel });
const hostStateSnapshot = async () => { const host = await hostInventory(); return { platform: host.platform, defaultSink: host.defaultSink ?? null, defaultSource: host.defaultSource ?? null, defaultSinkMuted: host.defaultSinkMuted ?? null, defaultSourceMuted: host.defaultSourceMuted ?? null, defaultSinkVolume: host.defaultSinkVolume ?? null, defaultSourceVolume: host.defaultSourceVolume ?? null }; };
const jamesStateSnapshot = async () => { const status = await jamesDspStatus(); if (!status.available) return { available: false, reason: status.reason }; return { available: true, connected: status.connected, engineProcessing: status.engineProcessing, masterEnabled: status.masterEnabled, equalizationActive: status.equalizationActive, bypass: status.bypass, moduleStates: status.moduleStates, runtimeConfigSynchronized: status.runtimeConfigSynchronized, activePreset: status.presetIdentity?.activePreset ?? null, presetIdentityStatus: status.presetIdentity?.status, configurationHash: status.configurationHash, effectiveConfigurationFingerprint: status.effectiveConfigurationFingerprint }; };
const assertStableMeasurementState = async (plan, expectedOutputChannel) => {
  const [audio, host, james] = await Promise.all([audioSnapshot(), hostStateSnapshot(), jamesStateSnapshot()]);
  if (JSON.stringify(audioStateIdentity(audio)) !== JSON.stringify(plan.audioIdentity)) throw new Error("REW audio or microphone-calibration state drifted after planning");
  if (expectedOutputChannel !== undefined && !JSON.stringify(audio.outputChannel).includes(String(expectedOutputChannel))) throw new Error("REW output channel drifted during measurement");
  if (JSON.stringify(host) !== JSON.stringify(plan.hostState)) throw new Error("Host audio route or mute state drifted during measurement");
  if (JSON.stringify(james) !== JSON.stringify(plan.jamesDspState)) throw new Error("JamesDSP state drifted during measurement");
  return { audio, host, james };
};
const capturedMeasurementState = (audio, host, james, sweep) => measurementStateFingerprint({
  route: { sink: host.defaultSink, source: host.defaultSource, sinkMuted: host.defaultSinkMuted, sourceMuted: host.defaultSourceMuted },
  volume: { sink: host.defaultSinkVolume, source: host.defaultSourceVolume, sweepLevelDbfs: sweep?.levelDbfs },
  dsp: james,
  microphone: { calibrationHash: audio?.inputCal ? stableToken(audio.inputCal) : null, inputDevice: audio?.inputDevice, inputChannel: audio?.inputChannel },
  preset: james?.configurationHash ? { configurationHash: james.configurationHash, effectiveConfigurationFingerprint: james.effectiveConfigurationFingerprint, activePreset: james.activePreset, equalizationActive: james.equalizationActive, bypass: james.bypass } : null,
  rew: audioStateIdentity(audio),
  sweep
});
const GUIDED_STAGE_TOOLS = Object.freeze({
  inventory: ["audio_host_inventory", "rew_audio_inventory", "speaker_profile_get"],
  "route-and-dsp-snapshot": ["audio_route_plan", "jamesdsp_snapshot"],
  "microphone-calibration-and-level-check": ["rew_input_level_check"],
  "protected-repeated-measurements": ["rew_repeated_session_plan", "rew_level_ladder_plan", "rew_measurement_execute"],
  "quality-gate": ["rew_measurement_quality"],
  "human-listening-assessment": ["rew_dual_resolution_analysis", "rew_direct_late_analysis", "rew_human_listening_assessment"],
  "physical-fix-review": ["rew_crossover_analysis", "rew_multiseat_analysis", "speaker_profile_get"],
  "cross-validated-eq-proposal": ["audio_eq_design_plan", "audio_linked_stereo_eq_plan", "audio_speaker_protection_assessment"],
  "hash-bound-dsp-apply": ["audio_filter_export_plan", "jamesdsp_key_plan", "jamesdsp_preset_plan"],
  "post-change-measurement": ["rew_repeated_session_plan", "rew_measurement_execute", "rew_measurement_quality", "audio_post_eq_verification"],
  "level-matched-listening-test": ["audio_listening_test_plan", "audio_listening_test_report"],
  report: ["audio_report_plan", "audio_report_execute"]
});

registerReleaseTools(server, { ok, guarded, bindPlan, verifyPlan, stableToken, workspaceRoot, safeWorkspacePath, writeAtomicSet, exportFilters, rew });

server.tool("audio_capabilities", "Report platform, safety limits, REW endpoint, targets, and optional integration support.", {}, guarded(async () => ok({ platform: process.platform, arch: process.arch, version: "0.1.0-beta.1", rewUrl: REW_BASE, deviceLimits: DEVICE_LIMITS, workflows: ["laptop", "car", "general"], modes: ["guided", "expert"], targets: Object.values(TARGET_REGISTRY), evidenceRegistryVersion: 1, calibrationArtifactSchemaVersion: 1, filterExports: ["rew-generic", "equalizer-apo", "camilladsp-yaml", "minidsp-rew", "json"], adapters: ["JamesDSP", "Equalizer APO", "CamillaDSP"], operationalFeatures: ["cross-platform REW discovery and confirmed launch", "REW capability negotiation", "asynchronous cancellable analyses", "environment doctor", "redacted support artifacts", "versioned offline replay artifacts"], advancedAnalysis: ["separate 4-6 trace L/R/combined sessions", "route/volume/DSP/microphone/preset fingerprints", "native-linear unsmoothed plus derived 192-PPO engineering analysis", "1/48, adaptive modal-to-perceptual, and ERB views", "cross-resolution repeated and held-out EQ acceptance", "overlaid multi-resolution HTML/JSON reports", "direct versus late impulse windows", "protected level ladders", "regularized linked-stereo EQ", "speaker protection gating", "measured post-EQ verification", "fingerprinted level-matched AB/ABX", "JamesDSP engine/master/module/bypass and exact-preset fingerprints"], jamesDsp: await jamesDspStatus(), guarantees: ["hash-bound mutations", "workspace path containment", "microphone calibration preservation", "clipping and SPL guards", "repeatability and state quality gates", "withheld-trace EQ validation", "post-change verification", "objective and preference evidence separation"] })));

server.tool("audio_workspace_scan", "Inventory profiles, sessions, measurements, backups, and reports in the AudioCalibration workspace.", { home: z.string().optional() }, guarded(async ({ home }) => {
  const root = await workspaceRoot(home), groups = {};
  for (const name of ["profiles", "sessions", "measurements", "backups", "reports", "filters", "support"]) {
    const dir = join(root, name); await mkdir(dir, { recursive: true });
    groups[name] = (await readdir(dir, { withFileTypes: true })).filter(x => x.isFile()).map(x => x.name).slice(0, 200);
  }
  return ok({ root, groups });
}));

server.tool("audio_host_inventory", "Read host audio devices and defaults without changing routing.", {}, guarded(async () => ok(await hostInventory())));

server.tool("audio_route_plan", "Create a hash-bound host audio routing plan. Native mutation is currently supported only through pactl on Linux.", { sink: z.string().min(1).max(300).optional(), source: z.string().min(1).max(300).optional(), sinkMuted: z.boolean().optional(), sourceMuted: z.boolean().optional() }, guarded(async ({ sink, source, sinkMuted, sourceMuted }) => {
  const before = await hostInventory(); if (process.platform !== "linux" || !before.routingWritable) throw new Error("Writable host routing adapter is unavailable on this platform");
  const allowedSinks = String(before.sinks || "").split("\n").map(x => x.split("\t")[1]).filter(Boolean), allowedSources = String(before.sources || "").split("\n").map(x => x.split("\t")[1]).filter(Boolean);
  if (sink && !allowedSinks.includes(sink)) throw new Error("Requested sink is not in the current inventory");
  if (source && !allowedSources.includes(source)) throw new Error("Requested source is not in the current inventory");
  return ok(bindPlan({ kind: "audio-route", createdAt: new Date().toISOString(), before: { defaultSink: before.defaultSink, defaultSource: before.defaultSource, defaultSinkMuted: before.defaultSinkMuted, defaultSourceMuted: before.defaultSourceMuted }, requested: { sink, source, sinkMuted, sourceMuted } }));
}));

server.tool("audio_route_execute", "Apply an exact host routing plan, verify it, and return rollback values.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation is required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "audio-route" || process.platform !== "linux") throw new Error("Invalid or unsupported route plan");
  const current = await hostInventory(), currentIdentity = { defaultSink: current.defaultSink, defaultSource: current.defaultSource, defaultSinkMuted: current.defaultSinkMuted, defaultSourceMuted: current.defaultSourceMuted }; if (JSON.stringify(currentIdentity) !== JSON.stringify(p.before)) throw new Error("Host route changed after planning");
  const applyState = async state => {
    if (state.defaultSink) await execFileAsync("pactl", ["set-default-sink", state.defaultSink], { timeout: 5000, env: hostAudioEnv() });
    if (state.defaultSource) await execFileAsync("pactl", ["set-default-source", state.defaultSource], { timeout: 5000, env: hostAudioEnv() });
    if (typeof state.defaultSinkMuted === "boolean" && state.defaultSink) await execFileAsync("pactl", ["set-sink-mute", state.defaultSink, state.defaultSinkMuted ? "1" : "0"], { timeout: 5000, env: hostAudioEnv() });
    if (typeof state.defaultSourceMuted === "boolean" && state.defaultSource) await execFileAsync("pactl", ["set-source-mute", state.defaultSource, state.defaultSourceMuted ? "1" : "0"], { timeout: 5000, env: hostAudioEnv() });
  };
  try {
    await applyState({ defaultSink: p.requested.sink || p.before.defaultSink, defaultSource: p.requested.source || p.before.defaultSource, defaultSinkMuted: p.requested.sinkMuted ?? p.before.defaultSinkMuted, defaultSourceMuted: p.requested.sourceMuted ?? p.before.defaultSourceMuted });
    const after = await hostInventory();
    if (p.requested.sink && after.defaultSink !== p.requested.sink) throw new Error("Sink verification failed");
    if (p.requested.source && after.defaultSource !== p.requested.source) throw new Error("Source verification failed");
    if (typeof p.requested.sinkMuted === "boolean" && after.defaultSinkMuted !== p.requested.sinkMuted) throw new Error("Sink mute verification failed");
    if (typeof p.requested.sourceMuted === "boolean" && after.defaultSourceMuted !== p.requested.sourceMuted) throw new Error("Source mute verification failed");
    return ok({ applied: true, before: p.before, after: { defaultSink: after.defaultSink, defaultSource: after.defaultSource, defaultSinkMuted: after.defaultSinkMuted, defaultSourceMuted: after.defaultSourceMuted }, rollback: p.before });
  } catch (error) {
    await applyState(p.before); const restored = await hostInventory(), restoredIdentity = { defaultSink: restored.defaultSink, defaultSource: restored.defaultSource, defaultSinkMuted: restored.defaultSinkMuted, defaultSourceMuted: restored.defaultSourceMuted }; if (JSON.stringify(restoredIdentity) !== JSON.stringify(p.before)) throw new Error(`${error.message}; route rollback verification failed`); throw new Error(`${error.message}; original route restored`);
  }
}));

server.tool("rew_probe", "Check the local REW API and inventory live measurements.", { timeoutMs: z.number().int().min(200).max(15000).default(3000) }, guarded(async ({ timeoutMs }) => {
  const [measurements, commands] = await Promise.all([rew("/measurements", { timeoutMs }), rew("/measurements/commands", { timeoutMs })]);
  return ok({ online: true, url: REW_BASE, measurementCount: measurementEntries(measurements).length, commands });
}));
server.tool("rew_audio_inventory", "Inspect REW driver, devices, channels, sample rate, and microphone calibration without changing anything.", {}, guarded(async () => ok(await audioSnapshot())));

server.tool("rew_audio_configure_plan", "Create a hash-bound REW input/output configuration plan while preserving the current microphone calibration.", {
  driver: z.enum(["Java", "ASIO"]).default("Java"), inputDevice: z.string().optional(), input: z.string().optional(), inputChannel: z.string().optional(), outputDevice: z.string().optional(), output: z.string().optional(), outputChannel: z.string().optional(), sampleRateHz: z.number().int().min(44100).max(192000).default(48000)
}, guarded(async args => ok(bindPlan({ kind: "rew-audio-config", createdAt: new Date().toISOString(), before: await audioSnapshot(), requested: args }))));

server.tool("rew_audio_configure_execute", "Apply and verify an exact REW audio configuration plan; restore the microphone calibration if REW clears it.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation is required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-audio-config") throw new Error("Wrong plan kind");
  const r = p.requested, family = r.driver.toLowerCase(), base = `/audio/${family}`;
  await rew("/audio/driver", { method: "POST", body: { driver: r.driver } });
  const audioSelections = [
    ["input-device", r.inputDevice, "device"],
    ["input", r.input, "input"],
    ["input-channel", r.inputChannel, "channel"],
    ["output-device", r.outputDevice, "device"],
    ["output", r.output, "output"],
    ["output-channel", r.outputChannel, "channel"]
  ];
  for (const [key, value, field] of audioSelections) {
    if (value === undefined || value === null || value === "") continue;
    const normalized = field === "channel" && /^\d+$/.test(String(value)) ? Number(value) : value;
    await rew(`${base}/${key}`, { method: "POST", body: { [field]: normalized } });
  }
  await rew("/audio/samplerate", { method: "POST", body: { value: r.sampleRateHz, unit: "Hz" } });
  if (p.before.inputCal) await rew("/audio/input-cal", { method: "PUT", body: p.before.inputCal });
  return ok({ applied: true, before: p.before, after: await audioSnapshot() });
}));

server.tool("rew_input_level_check", "Capture microphone input levels for a bounded period. This emits no sweep.", { durationMs: z.number().int().min(1000).max(15000).default(4000), confirm: z.boolean().default(false) }, guarded(async ({ durationMs, confirm }) => {
  if (!confirm) throw new Error("Confirmation is required before activating microphone capture");
  await rew("/input-levels/command", { method: "POST", body: { command: "Start" } }); await new Promise(r => setTimeout(r, durationMs));
  const levels = await rew("/input-levels/last-levels"); await rew("/input-levels/command", { method: "POST", body: { command: "Stop" } }).catch(() => {});
  const rms = (Array.isArray(levels?.rms) ? levels.rms : []).map(Number).filter(Number.isFinite), peak = (Array.isArray(levels?.peak) ? levels.peak : []).map(Number).filter(Number.isFinite);
  const telemetryPlausible = rms.length > 0 && peak.length > 0 && Math.max(...rms) > -200 && Math.max(...peak) > -200 && Math.max(...peak) >= Math.max(...rms);
  return ok({ levels, inputSignalPresent: telemetryPlausible, readyForSweep: telemetryPlausible, warning: telemetryPlausible ? null : "Input-level telemetry is digital zero or implausible. Verify the physical microphone, selected source, gain, and permissions before any sweep.", interpretation: "A calibrated SPL reading requires a sensitivity-calibrated microphone and known gain path." });
}));

server.tool("rew_measurement_plan", "Create a guarded generic REW sweep plan for laptop, car, or general speakers.", {
  deviceClass: z.enum(["laptop", "car", "general"]), targetId: z.string().optional(), titlePrefix: z.string().min(1).max(80), outputChannels: z.array(z.string().min(1).max(100)).min(1).max(32), startHz: z.number().min(5).max(1000).optional(), endHz: z.number().min(1000).max(24000).optional(), levelDbfs: z.number().min(-60).max(-3).optional(), maxSplDb: z.number().min(60).max(105).optional(), repetitions: z.number().int().min(1).max(8).default(1), sweepLength: z.enum(["64k", "128k", "256k", "512k", "1M", "2M", "4M"]).default("256k"), timingReference: z.enum(["None", "Acoustic", "Loopback"]).default("Acoustic"), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/), home: z.string().optional()
}, guarded(async args => {
  if (args.targetId && !TARGET_REGISTRY[args.targetId]) throw new Error("Unknown targetId");
  const root = await workspaceRoot(args.home), defaults = DEVICE_LIMITS[args.deviceClass], settings = safeMeasurementSettings(args.deviceClass, { startHz: args.startHz ?? defaults.startHz, endHz: args.endHz ?? defaults.endHz, levelDbfs: args.levelDbfs ?? defaults.levelDbfs, maxSplDb: args.maxSplDb ?? defaults.maxSplDb });
  const [audio, hostState, jamesDspState] = await Promise.all([audioSnapshot(), hostStateSnapshot(), jamesStateSnapshot()]), savePath = await safeWorkspacePath(root, join("measurements", args.saveFile), [".mdat"]);
  const sweep = { ...settings, repetitions: args.repetitions, sweepLength: args.sweepLength, timingReference: args.timingReference };
  return ok(bindPlan({ kind: "rew-measurement", mode: "standard", createdAt: new Date().toISOString(), deviceClass: args.deviceClass, targetId: args.targetId || null, home: args.home, audio, audioIdentity: audioStateIdentity(audio), hostState, jamesDspState, stateFingerprint: capturedMeasurementState(audio, hostState, jamesDspState, sweep), settings: sweep, runs: args.outputChannels.map((outputChannel, i) => ({ outputChannel, title: `${args.titlePrefix} ${i + 1}` })), savePath }));
}));

server.tool("rew_repeated_session_plan", "Plan 4-6 separately retained left, right, and combined traces with a complete route, volume, DSP, microphone, preset, and sweep fingerprint.", {
  deviceClass: z.enum(["laptop", "car", "general"]), targetId: z.string().optional(), titlePrefix: z.string().min(1).max(80), channels: z.array(z.object({ outputChannel: z.string().min(1).max(100), role: z.enum(["left", "right", "combined"]) })).min(3).max(3), repeats: z.number().int().min(4).max(6).default(4), startHz: z.number().min(5).max(1000).optional(), endHz: z.number().min(1000).max(24000).optional(), levelDbfs: z.number().min(-60).max(-3).optional(), maxSplDb: z.number().min(60).max(105).optional(), sweepLength: z.enum(["256k", "512k", "1M"]).default("512k"), timingReference: z.enum(["Acoustic", "Loopback"]).default("Acoustic"), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/), home: z.string().optional()
}, guarded(async args => {
  if (args.targetId && !TARGET_REGISTRY[args.targetId]) throw new Error("Unknown targetId"); const roles = new Set(args.channels.map(x => x.role)); if (!["left", "right", "combined"].every(x => roles.has(x))) throw new Error("Exactly one left, right, and combined channel mapping is required");
  const root = await workspaceRoot(args.home), defaults = DEVICE_LIMITS[args.deviceClass], settings = safeMeasurementSettings(args.deviceClass, { startHz: args.startHz ?? defaults.startHz, endHz: args.endHz ?? defaults.endHz, levelDbfs: args.levelDbfs ?? defaults.levelDbfs, maxSplDb: args.maxSplDb ?? defaults.maxSplDb });
  const [audio, hostState, jamesDspState] = await Promise.all([audioSnapshot(), hostStateSnapshot(), jamesStateSnapshot()]), sweep = { ...settings, repetitions: 1, evidenceRepeats: args.repeats, sweepLength: args.sweepLength, timingReference: args.timingReference }, savePath = await safeWorkspacePath(root, join("measurements", args.saveFile), [".mdat"]), runs = [];
  for (let repeat = 1; repeat <= args.repeats; repeat++) for (const channel of args.channels) runs.push({ ...channel, repeat, title: `${args.titlePrefix} ${channel.role} R${repeat}`, levelDbfs: settings.levelDbfs });
  return ok(bindPlan({ kind: "rew-measurement", mode: "separate-repeated-evidence", createdAt: new Date().toISOString(), deviceClass: args.deviceClass, targetId: args.targetId || null, home: args.home, audio, audioIdentity: audioStateIdentity(audio), hostState, jamesDspState, stateFingerprint: capturedMeasurementState(audio, hostState, jamesDspState, sweep), settings: sweep, runs, savePath }));
}));

server.tool("rew_level_ladder_plan", "Plan protected separately retained distortion/compression sweeps at several levels for one channel.", {
  deviceClass: z.enum(["laptop", "car", "general"]), targetId: z.string().optional(), titlePrefix: z.string().min(1).max(80), outputChannel: z.string().min(1).max(100), role: z.string().min(1).max(80), levelsDbfs: z.array(z.number().min(-60).max(-3)).min(3).max(6), startHz: z.number().min(5).max(1000).optional(), endHz: z.number().min(1000).max(24000).optional(), maxSplDb: z.number().min(60).max(105).optional(), sweepLength: z.enum(["256k", "512k", "1M"]).default("512k"), timingReference: z.enum(["Acoustic", "Loopback"]).default("Acoustic"), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/), home: z.string().optional()
}, guarded(async args => {
  if (args.targetId && !TARGET_REGISTRY[args.targetId]) throw new Error("Unknown targetId"); const levels = [...new Set(args.levelsDbfs)].sort((a, b) => a - b); if (levels.length !== args.levelsDbfs.length) throw new Error("Sweep levels must be unique");
  const root = await workspaceRoot(args.home), defaults = DEVICE_LIMITS[args.deviceClass]; for (const levelDbfs of levels) safeMeasurementSettings(args.deviceClass, { startHz: args.startHz ?? defaults.startHz, endHz: args.endHz ?? defaults.endHz, levelDbfs, maxSplDb: args.maxSplDb ?? defaults.maxSplDb });
  const settings = { startHz: args.startHz ?? defaults.startHz, endHz: args.endHz ?? defaults.endHz, levelDbfs: levels[0], maxSplDb: args.maxSplDb ?? defaults.maxSplDb, repetitions: 1, sweepLength: args.sweepLength, timingReference: args.timingReference, levelsDbfs: levels }, [audio, hostState, jamesDspState] = await Promise.all([audioSnapshot(), hostStateSnapshot(), jamesStateSnapshot()]), savePath = await safeWorkspacePath(root, join("measurements", args.saveFile), [".mdat"]);
  return ok(bindPlan({ kind: "rew-measurement", mode: "protected-level-ladder", createdAt: new Date().toISOString(), deviceClass: args.deviceClass, targetId: args.targetId || null, home: args.home, audio, audioIdentity: audioStateIdentity(audio), hostState, jamesDspState, stateFingerprint: capturedMeasurementState(audio, hostState, jamesDspState, settings), settings, runs: levels.map(levelDbfs => ({ outputChannel: args.outputChannel, role: args.role, levelDbfs, title: `${args.titlePrefix} ${levelDbfs}dBFS` })), savePath }));
}));

server.tool("rew_measurement_execute", "Run an exact protected sweep plan, label and save results, then restore REW state. Audible confirmation and physical readiness flags are mandatory.", {
  ...planSchema, micPlaced: z.boolean().default(false), areaClear: z.boolean().default(false)
}, guarded(async ({ plan, confirmationToken, confirm, micPlaced, areaClear }) => {
  if (!confirm || !micPlaced || !areaClear) throw new Error("Fresh audible-sweep confirmation, microphone placement, and clear-area confirmation are required");
  const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-measurement") throw new Error("Wrong plan kind");
  await assertStableMeasurementState(p);
  const initialTiming = await rew("/measure/timing/reference").catch(() => null), base = `/audio/${p.audio.family}`; const completed = [];
  const sampleCounts = { "64k": 65536, "128k": 131072, "256k": 262144, "512k": 524288, "1M": 1048576, "2M": 2097152, "4M": 4194304 };
  const sampleRate = Number(p.audio?.sampleRate?.value) || 48000;
  const measurementTimeoutMs = Math.max(60000, Math.ceil((sampleCounts[p.settings.sweepLength] / sampleRate) * p.settings.repetitions * 1000 + 60000));
  await rew("/application/blocking", { method: "POST", body: true });
  try {
    await rew("/measure/sweep/configuration", { method: "POST", body: { startFrequency: p.settings.startHz, endFrequency: p.settings.endHz, length: p.settings.sweepLength, fillSilenceWithDither: true } });
    await rew("/measure/sweep/repetitions", { method: "POST", body: p.settings.repetitions }); await rew("/measure/level", { method: "POST", body: { value: p.settings.levelDbfs, unit: "dBFS" } });
    await rew("/measure/timing/reference", { method: "POST", body: p.settings.timingReference });
    const appliedTiming = await rew("/measure/timing/reference");
    if (JSON.stringify(appliedTiming) !== JSON.stringify(p.settings.timingReference)) throw new Error("REW did not apply the requested timing reference");
    const currentProtection = await rew("/measure/protection-options").catch(() => ({}));
    const protection = { ...currentProtection, splLimitAbort: true, clippingAbort: true, dBSPLLimit: p.settings.maxSplDb, warnForLowLevels: false };
    await rew("/measure/protection-options", { method: "POST", body: protection });
    const appliedProtection = await rew("/measure/protection-options");
    if (!appliedProtection?.splLimitAbort || !appliedProtection?.clippingAbort || Number(appliedProtection?.dBSPLLimit) !== Number(p.settings.maxSplDb)) throw new Error("REW did not apply the requested protection limits");
    try { await rew("/measure/command", { method: "POST", body: { command: "Check levels" }, timeoutMs: 60000 }); }
    catch (error) { if (!/REW 501:[\s\S]*not implemented/i.test(error.message)) throw error; }
    // /measure/sequential-channels lists the channels available to REW; it does
    // not indicate that sequential capture is enabled. Drive every requested
    // output explicitly so L, R, and L+R each produce exactly one trace.
    for (const run of p.runs) {
      const runLevelDbfs = run.levelDbfs ?? p.settings.levelDbfs;
      await rew(`${base}/output-channel`, { method: "POST", body: { channel: run.outputChannel } });
      await rew("/measure/level", { method: "POST", body: { value: runLevelDbfs, unit: "dBFS" } });
      const runEvidence = { mode: p.mode || "standard", role: run.role || null, repeat: run.repeat || null, levelDbfs: runLevelDbfs, stateFingerprint: p.stateFingerprint?.fingerprint || null, controlFingerprint: p.stateFingerprint?.controlFingerprint || null, presetFingerprint: p.jamesDspState?.configurationHash || null, microphoneCalibrationHash: p.stateFingerprint?.state?.microphone?.calibrationHash || null };
      await rew("/measure/notes", { method: "POST", body: JSON.stringify(runEvidence) });
      await assertStableMeasurementState(p, run.outputChannel);
      const before = new Set(measurementEntries(await rew("/measurements")).map(([id]) => id));
      let driftError = null, monitoring = false;
      const monitor = setInterval(async () => { if (monitoring || driftError) return; monitoring = true; try { const [host, james] = await Promise.all([hostStateSnapshot(), jamesStateSnapshot()]); if (JSON.stringify(host) !== JSON.stringify(p.hostState)) driftError = new Error("Host audio state changed during sweep"); else if (JSON.stringify(james) !== JSON.stringify(p.jamesDspState)) driftError = new Error("JamesDSP state changed during sweep"); if (driftError) await rew("/measure/command", { method: "POST", body: { command: "Cancel" }, timeoutMs: 5000 }).catch(() => {}); } catch (error) { driftError = error; } finally { monitoring = false; } }, 1500);
      try { await rew("/measure/command", { method: "POST", body: { command: "SPL" }, timeoutMs: 180000 }); } finally { clearInterval(monitor); }
      if (driftError) throw driftError;
      const [id] = await waitForMeasurement(before, measurementTimeoutMs); await rew(`/measurements/${encodeURIComponent(id)}`, { method: "PUT", body: { title: run.title, notes: JSON.stringify(runEvidence) } }); completed.push({ id, title: run.title, outputChannel: run.outputChannel, role: run.role || null, repeat: run.repeat || null, levelDbfs: runLevelDbfs, stateFingerprint: p.stateFingerprint?.fingerprint || null, controlFingerprint: p.stateFingerprint?.controlFingerprint || null, presetFingerprint: p.jamesDspState?.configurationHash || stableToken({ jamesDsp: p.jamesDspState }), microphoneCalibrationHash: p.stateFingerprint?.state?.microphone?.calibrationHash || stableToken({ calibration: "unknown" }), microphoneCalibrationKnown: Boolean(p.stateFingerprint?.state?.microphone?.calibrationHash), sweepFingerprint: stableToken({ settings: p.settings, outputChannel: run.outputChannel, role: run.role || null, repeat: run.repeat || null, levelDbfs: runLevelDbfs }) });
      await assertStableMeasurementState(p, run.outputChannel);
      // REW publishes the completed measurement before its sweep engine has fully
      // released the audio line. Give it a bounded settle interval so the next
      // channel does not fail with "There is already a measurement in progress".
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    await mkdir(dirname(p.savePath), { recursive: true }); await rew("/measurements/command", { method: "POST", body: { command: "Save all", parameters: [p.savePath, `${p.deviceClass} protected calibration session`] }, timeoutMs: 120000 });
    const root = await workspaceRoot(p.home), artifact = createCalibrationArtifact({ session: { id: confirmationToken.slice(0, 16), deviceClass: p.deviceClass, algorithmVersion: "0.1.0-beta.1", targetId: p.targetId || null, targetVersion: p.targetId ? TARGET_REGISTRY[p.targetId]?.version || null : null, mode: p.mode, sourcePlanHash: confirmationToken }, sweeps: completed.map(run => ({ id: run.id, role: run.role, repeat: run.repeat, levelDbfs: run.levelDbfs, outputChannel: run.outputChannel, fingerprints: { control: run.controlFingerprint || stableToken({ control: "unknown" }), preset: run.presetFingerprint, microphone: run.microphoneCalibrationHash, sweep: run.sweepFingerprint }, measurementFile: relative(root, p.savePath), traceHash: stableToken({ id: run.id, title: run.title, stateFingerprint: run.stateFingerprint }) })), provenance: { softwareVersion: "0.1.0-beta.1", rewUrl: REW_BASE, platform: process.platform, arch: process.arch } }), artifactPath = await safeWorkspacePath(root, join("sessions", `${basename(p.savePath, ".mdat")}-${confirmationToken.slice(0, 12)}.calibration.json`), [".json"]);
    await mkdir(dirname(artifactPath), { recursive: true }); await writeAtomicSet([[artifactPath, JSON.stringify(artifact, null, 2) + "\n"]], confirmationToken);
    return ok({ completed, saved: p.savePath, calibrationArtifact: artifactPath, settings: p.settings, stateEvidence: { verified: true, sourcePlanHash: confirmationToken, fingerprint: p.stateFingerprint, audioIdentity: p.audioIdentity, hostState: p.hostState, jamesDspState: p.jamesDspState, monitorIntervalMs: 1500, verifiedAt: new Date().toISOString() }, skippedRequestedChannels: p.runs.map(x => x.outputChannel).filter(x => !completed.some(y => y.outputChannel === x)), next: "Run rew_measurement_quality with this protected-session state evidence before interpretation or EQ." });
  } finally {
    if (initialTiming !== null) await rew("/measure/timing/reference", { method: "POST", body: initialTiming }).catch(() => {});
    await rew("/application/blocking", { method: "POST", body: false }).catch(() => {});
  }
}));

server.tool("rew_measurement_cancel", "Cancel a live REW measurement.", { confirm: z.boolean().default(false) }, guarded(async ({ confirm }) => { if (!confirm) throw new Error("Confirmation required"); const commands = await rew("/measure/commands"), cancel = Array.isArray(commands) ? commands.find(x => /^cancel$/i.test(String(x))) || commands.find(x => /cancel/i.test(String(x))) : "Cancel"; return ok({ response: await rew("/measure/command", { method: "POST", body: { command: cancel || "Cancel" } }) }); }));
const rewSaveAllPlan = async ({ home, saveFile, note = "Audio calibration measurements" }) => { const root = await workspaceRoot(home), path = await safeWorkspacePath(root, join("measurements", saveFile), [".mdat"]); if (await pathExists(path)) throw new Error("Refusing to overwrite an existing MDAT"); const entries = measurementEntries(await rew("/measurements")); return bindPlan({ kind: "rew-save-all", createdAt: new Date().toISOString(), home, path, note, measurementSetHash: stableToken(entries.map(([id, value]) => [id, value?.title || null])) }); };
server.tool("rew_save_all", "Compatibility alias: create a hash-bound Save-all plan; execute with rew_save_all_execute.", { home: z.string().optional(), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/), note: z.string().max(500).default("Audio calibration measurements") }, guarded(async args => ok(await rewSaveAllPlan(args))));
server.tool("rew_save_all_plan", "Create a hash-bound plan to save all live REW measurements into a new workspace MDAT.", { home: z.string().optional(), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/), note: z.string().max(500).default("Audio calibration measurements") }, guarded(async args => ok(await rewSaveAllPlan(args))));
server.tool("rew_save_all_execute", "Execute and verify an exact REW Save-all plan without overwriting an existing artifact.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => { if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-save-all") throw new Error("Wrong plan kind"); const root = await workspaceRoot(p.home), path = await safeWorkspacePath(root, relative(root, p.path), [".mdat"]); if (path !== p.path || await pathExists(path)) throw new Error("Save target changed or already exists"); const entries = measurementEntries(await rew("/measurements")); if (stableToken(entries.map(([id, value]) => [id, value?.title || null])) !== p.measurementSetHash) throw new Error("REW measurement set changed after planning"); await mkdir(dirname(path), { recursive: true }); await rew("/measurements/command", { method: "POST", body: { command: "Save all", parameters: [path, p.note] }, timeoutMs: 120000 }); const file = await hashFile(path); return ok({ saved: path, ...file }); }));
const rewLoadPlan = async ({ home, file }) => { const root = await workspaceRoot(home), path = await safeWorkspacePath(root, file, [".mdat"]), source = await hashFile(path); return bindPlan({ kind: "rew-load-file", createdAt: new Date().toISOString(), home, file, path, source }); };
server.tool("rew_load_file", "Compatibility alias: create a hash-bound workspace MDAT load plan; execute with rew_load_file_execute.", { home: z.string().optional(), file: z.string() }, guarded(async args => ok(await rewLoadPlan(args))));
server.tool("rew_load_file_plan", "Create a hash-bound plan to load a workspace-contained MDAT into REW.", { home: z.string().optional(), file: z.string() }, guarded(async args => ok(await rewLoadPlan(args))));
server.tool("rew_load_file_execute", "Load the exact hashed MDAT into REW after explicit confirmation.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => { if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-load-file") throw new Error("Wrong plan kind"); const root = await workspaceRoot(p.home), path = await safeWorkspacePath(root, p.file, [".mdat"]), current = await hashFile(path); if (path !== p.path || current.sha256 !== p.source.sha256 || current.bytes !== p.source.bytes) throw new Error("MDAT changed after planning"); return ok({ path, source: current, response: await rew("/measurements/command", { method: "POST", body: { command: "Load", parameters: [path] }, timeoutMs: 30000 }) }); }));

server.tool("rew_trace", "Fetch a bounded REW magnitude/phase, group-delay, distortion, RT60, or impulse trace.", { id: z.string(), kind: z.enum(["frequency-response", "group-delay", "distortion", "rt60", "impulse-response"]), ppo: z.number().int().min(1).max(192).default(48), smoothing: z.string().default("1/12") }, guarded(async ({ id, kind, ppo, smoothing }) => ok(await rew(`/measurements/${encodeURIComponent(id)}/${kind}?ppo=${ppo}&smoothing=${encodeURIComponent(smoothing)}`))));
const generatedTraceSchema = { processName: z.enum(["Vector sum", "Vector average", "RMS average", "dB average", "Magn plus phase average", "dB plus phase average", "Arithmetic", "Smooth", "Time align", "Cross corr align"]), measurementIndices: z.array(z.number().int().positive()).min(1).max(30), parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}) };
const rewGenerateTracePlan = async args => { const entries = measurementEntries(await rew("/measurements")); return bindPlan({ kind: "rew-generate-trace", createdAt: new Date().toISOString(), ...args, measurementSetHash: stableToken(entries.map(([id, value]) => [id, value?.title || null])) }); };
server.tool("rew_generate_trace", "Compatibility alias: create an allowlisted hash-bound derived-trace plan; execute with rew_generate_trace_execute.", generatedTraceSchema, guarded(async args => ok(await rewGenerateTracePlan(args))));
server.tool("rew_generate_trace_plan", "Create an allowlisted hash-bound REW derived-trace plan.", generatedTraceSchema, guarded(async args => ok(await rewGenerateTracePlan(args))));
server.tool("rew_generate_trace_execute", "Execute an exact derived-trace plan after rechecking the REW measurement set.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => { if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-generate-trace") throw new Error("Wrong plan kind"); const entries = measurementEntries(await rew("/measurements")); if (stableToken(entries.map(([id, value]) => [id, value?.title || null])) !== p.measurementSetHash) throw new Error("REW measurement set changed after planning"); return ok(await rew("/measurements/process-measurements", { method: "POST", body: { processName: p.processName, measurementIndices: p.measurementIndices, parameters: p.parameters }, timeoutMs: 30000 })); }));
server.tool("rew_crossover_analysis", "Analyze phase agreement and predicted summation around a crossover. Verify the conclusion with a measured combined trace.", { mainId: z.string(), subId: z.string(), crossoverHz: z.number().min(20).max(500), spanOctaves: z.number().min(0.25).max(2).default(1) }, guarded(async ({ mainId, subId, crossoverHz, spanOctaves }) => { const [main, sub] = await Promise.all([rew(`/measurements/${encodeURIComponent(mainId)}/frequency-response?ppo=96&smoothing=1%2F24`), rew(`/measurements/${encodeURIComponent(subId)}/frequency-response?ppo=96&smoothing=1%2F24`)]); return ok({ ...crossoverMetrics(main, sub, crossoverHz, spanOctaves), verificationRequired: "Measure main+sub together before accepting polarity, delay, or crossover changes." }); }));
server.tool("rew_multiseat_analysis", "Analyze multi-seat consistency, modal candidates, seat outliers, and optional Schroeder frequency.", { ids: z.array(z.string()).min(2).max(30), lowHz: z.number().min(10).max(500).default(20), highHz: z.number().min(30).max(1000).default(300), roomVolumeM3: z.number().positive().optional(), rt60Seconds: z.number().positive().optional() }, guarded(async ({ ids, lowHz, highHz, roomVolumeM3, rt60Seconds }) => { const traces = await Promise.all(ids.map(id => rew(`/measurements/${encodeURIComponent(id)}/frequency-response?ppo=48&smoothing=1%2F12`))); return ok(multiseatMetrics(traces, lowHz, highHz, roomVolumeM3, rt60Seconds)); }));
server.tool("audio_eq_proposal", "Create conservative cut-first parametric EQ suggestions from a live REW trace; this never applies filters.", { id: z.string(), deviceClass: z.enum(["laptop", "car", "general"]), lowHz: z.number().min(10).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), maxCutDb: z.number().min(0).max(12).default(6), maxBoostDb: z.number().min(0).max(6).optional(), bands: z.number().int().min(3).max(20).default(10) }, guarded(async args => { const trace = await rew(`/measurements/${encodeURIComponent(args.id)}/frequency-response?ppo=96&smoothing=1%2F12`), lim = DEVICE_LIMITS[args.deviceClass]; const filters = eqProposal(trace, { lowHz: args.lowHz ?? lim.startHz, highHz: args.highHz ?? Math.min(lim.endHz, 16000), maxCutDb: args.maxCutDb, maxBoostDb: Math.min(args.maxBoostDb ?? 0, lim.maxBoostDb), bands: args.bands }); return ok({ filters, status: "proposal-only", warnings: ["Do not boost narrow nulls.", "Reserve preamp headroom for any positive gain.", "Re-measure after application."] }); }));

const liveEntrySchema = z.object({ id: z.string().min(1).max(120), role: z.string().max(80).optional(), seat: z.string().max(80).optional(), snrDb: z.number().optional(), peakDbfs: z.number().optional(), clipped: z.boolean().optional(), stateFingerprint: z.string().max(128).optional(), controlFingerprint: z.string().max(128).optional(), presetFingerprint: z.string().max(128).optional() });
const filterSchema = z.object({ type: z.literal("PK"), frequencyHz: z.number().positive(), gainDb: z.number().min(-24).max(12), q: z.number().positive().max(30), evidence: z.record(z.any()).optional() });
const fetchTraceBundle = async entry => {
  const id = encodeURIComponent(entry.id), optional = (...paths) => paths.reduce((promise, path) => promise.catch(() => rew(path)), Promise.reject(new Error("unavailable"))).catch(() => null);
  const [frequencyResponse, groupDelay, distortion, rt60] = await Promise.all([
    rew(`/measurements/${id}/frequency-response?ppo=96&smoothing=1%2F48`),
    optional(`/measurements/${id}/group-delay?smoothing=None&unit=ms`, `/measurements/${id}/group-delay?ppo=96&smoothing=1%2F48&unit=ms`),
    optional(`/measurements/${id}/distortion?ppo=24&smoothing=1%2F12&unit=Percent`),
    optional(`/measurements/${id}/rt60?ppo=12&smoothing=1%2F3`)
  ]);
  return { ...entry, frequencyResponse, groupDelay, distortion, rt60 };
};

server.tool("rew_dual_resolution_analysis", "Return raw/minimally smoothed and ERB-perceptual views so narrow engineering defects remain separate from broad listening interpretation.", {
  id: z.string(), lowHz: z.number().min(5).max(1000).default(20), highHz: z.number().min(1000).max(24000).default(20000), stepErb: z.number().min(0.1).max(2).default(0.5), widthErb: z.number().min(0.25).max(3).default(1), modalBoundaryHz: z.number().min(20).max(500).default(200), smoothingTransitionHz: z.number().min(100).max(4000).default(1000)
}, guarded(async ({ id, lowHz, highHz, stepErb, widthErb, modalBoundaryHz, smoothingTransitionHz }) => {
  const encoded = encodeURIComponent(id), raw = await rew(`/measurements/${encoded}/frequency-response?smoothing=None`).catch(() => null), minimal = await rew(`/measurements/${encoded}/frequency-response?ppo=96&smoothing=1%2F48`), rawUsable = raw && raw.smoothing === "None" && Number.isFinite(Number(raw.freqStep || raw.frequencyStep)), source = rawUsable ? raw : minimal;
  return ok({ measurementId: id, rawAvailable: Boolean(rawUsable), engineering: { ...engineeringTraceSummary(source, { lowHz, highHz }), smoothing: rawUsable ? "None" : "1/48 fallback", spacing: rawUsable ? "native-linear" : "96-PPO logarithmic", derivedAnalysisGridPpo: rawUsable ? 192 : 96 }, minimallySmoothed: { ...engineeringTraceSummary(minimal, { lowHz, highHz }), smoothing: "1/48", ppo: 96 }, adaptive: frequencyDependentSmooth(source, { lowHz, highHz, modalBoundaryHz, transitionHz: smoothingTransitionHz, ppo: 24 }), perceptual: erbSmooth(source, { lowHz, highHz, stepErb, widthErb }), rawTracePreservedInRew: true, use: { engineering: "phase, timing, resonances, narrow defects, and quality checks", adaptive: "modal-resolution below the boundary with progressively perceptual smoothing above it", perceptual: "broad tonal balance and audibility-oriented EQ decisions" } });
}));

server.tool("rew_direct_late_analysis", "Separate direct-window and later reflected impulse energy without treating the chosen gate as universal.", {
  id: z.string(), sampleRateHz: z.number().int().min(44100).max(192000).default(48000), prePeakMs: z.number().min(0).max(10).default(1), directWindowMs: z.number().min(1).max(30).default(5), lateWindowMs: z.number().min(20).max(500).default(80), lowHz: z.number().min(5).max(1000).default(20), highHz: z.number().min(1000).max(24000).default(20000), ppo: z.number().int().min(6).max(48).default(12)
}, guarded(async args => { const trace = await rew(`/measurements/${encodeURIComponent(args.id)}/impulse-response`); return ok({ measurementId: args.id, ...directLateWindowAnalysis(trace, args) }); }));

server.tool("audio_target_registry", "List versioned, evidence-labelled listening target starting points.", { deviceClass: z.enum(["laptop", "car", "general"]).optional() }, guarded(async ({ deviceClass }) => ok(Object.values(TARGET_REGISTRY).filter(x => !deviceClass || x.deviceClasses.includes(deviceClass)))));
server.tool("audio_evidence_registry", "List authoritative sources and exact claim boundaries used by the analysis engine.", {}, guarded(async () => ok({ schemaVersion: 1, sources: EVIDENCE_REGISTRY })));

server.tool("audio_guided_session_plan", "Create a hash-bound guided or expert calibration workflow without changing audio state.", {
  name: z.string().min(1).max(80), deviceClass: z.enum(["laptop", "car", "general"]), mode: z.enum(["guided", "expert"]).default("guided"), measurementProfile: z.enum(["quick", "standard", "reference"]).default("standard"), targetId: z.string().optional(), outputChannels: z.array(z.string().min(1).max(100)).max(32).default([]), home: z.string().optional()
}, guarded(async args => ok(guidedSessionPlan(args))));

server.tool("audio_guided_session_execute", "Open an exact guided session record and return its safe next step; this does not emit audio.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "guided-audio-session") throw new Error("Wrong plan kind");
  const root = await workspaceRoot(p.home), slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "session", stamp = p.createdAt.replace(/[:.]/g, "-");
  const path = await safeWorkspacePath(root, join("sessions", `${slug}-${stamp}.json`), [".json"]); await mkdir(dirname(path), { recursive: true });
  const session = { ...p, state: "active", currentStage: p.stages[0], completedStages: [], nextTools: GUIDED_STAGE_TOOLS[p.stages[0]], sourcePlanHash: confirmationToken, updatedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(session, null, 2) + "\n", { flag: "wx" }); return ok({ sessionFile: relative(root, path), session, audibleAction: false });
}));

server.tool("audio_session_status", "Read a workspace-contained guided calibration session.", { home: z.string().optional(), sessionFile: z.string() }, guarded(async ({ home, sessionFile }) => { const root = await workspaceRoot(home), path = await safeWorkspacePath(root, sessionFile, [".json"]); return ok(JSON.parse(await readFile(path, "utf8"))); }));

const sessionEvidenceSchema = z.object({ accepted: z.boolean(), summary: z.string().min(1).max(1000), artifactRefs: z.array(z.string().min(1).max(300)).max(20).default([]) });
server.tool("audio_session_advance_plan", "Bind completion of the current guided stage to concise evidence without changing the session.", { home: z.string().optional(), sessionFile: z.string(), completedStage: z.string().min(1).max(100), evidence: sessionEvidenceSchema }, guarded(async args => {
  const root = await workspaceRoot(args.home), path = await safeWorkspacePath(root, args.sessionFile, [".json"]), raw = await readFile(path, "utf8"), session = JSON.parse(raw); if (session.state !== "active") throw new Error("Session is not active"); if (session.currentStage !== args.completedStage) throw new Error(`Current stage is ${session.currentStage}`); if (!args.evidence.accepted) throw new Error("A rejected stage cannot advance; resolve it and submit new evidence");
  return ok(bindPlan({ kind: "guided-session-advance", createdAt: new Date().toISOString(), home: args.home, sessionFile: args.sessionFile, path, sessionHash: stableToken(raw), completedStage: args.completedStage, evidence: args.evidence }));
}));

server.tool("audio_session_advance_execute", "Advance one exact guided stage, preserving a recoverable session backup and returning the next tools.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "guided-session-advance") throw new Error("Wrong plan kind"); const root = await workspaceRoot(p.home), path = await safeWorkspacePath(root, p.sessionFile, [".json"]); if (path !== p.path) throw new Error("Session path changed after planning");
  const raw = await readFile(path, "utf8"); if (stableToken(raw) !== p.sessionHash) throw new Error("Session changed after planning"); const session = JSON.parse(raw); if (session.currentStage !== p.completedStage) throw new Error("Session stage changed after planning"); const index = session.stages.indexOf(p.completedStage), nextStage = session.stages[index + 1] || null;
  const updated = { ...session, state: nextStage ? "active" : "complete", currentStage: nextStage, completedStages: [...session.completedStages, { stage: p.completedStage, evidence: p.evidence, completedAt: new Date().toISOString() }], nextTools: nextStage ? GUIDED_STAGE_TOOLS[nextStage] : [], updatedAt: new Date().toISOString() };
  const backup = await safeWorkspacePath(root, join("backups", `${basename(path, ".json")}-before-${p.completedStage}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), [".json"]); await mkdir(dirname(backup), { recursive: true }); await copyFile(path, backup);
  try { await writeFile(path, JSON.stringify(updated, null, 2) + "\n"); const verified = JSON.parse(await readFile(path, "utf8")); if (verified.currentStage !== nextStage || verified.completedStages.length !== updated.completedStages.length) throw new Error("Session advance verification failed"); return ok({ sessionFile: p.sessionFile, backup, state: verified.state, currentStage: verified.currentStage, nextTools: verified.nextTools }); }
  catch (error) { await copyFile(backup, path); throw new Error(`${error.message}; session restored from backup`); }
}));

registerAnalysisTools(server, { ok, guarded, liveEntrySchema, fetchTraceBundle, rew, measurementQuality, humanListeningAssessment, bindPlan, multiResolutionEqProposal, linkedStereoEqProposal, speakerProtectionAssessment, compressionMetrics, measuredPostEqVerification });

server.tool("rew_diagnostic_capabilities", "Read the live REW SPL, RTA, stepped-measurement, and generator command surfaces without running them.", {}, guarded(async () => { const endpoints = ["spl-meter", "rta", "stepped-measurement", "generator"], values = await Promise.all(endpoints.map(async endpoint => [endpoint, await rew(`/${endpoint}/commands`).catch(error => ({ unavailable: error.message }))])); return ok(Object.fromEntries(values)); }));

server.tool("rew_diagnostic_plan", "Bind an exact command exposed by the live REW diagnostic API.", { endpoint: z.enum(["spl-meter", "rta", "stepped-measurement", "generator"]), command: z.string().min(1).max(120), parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}) }, guarded(async args => {
  const available = await rew(`/${args.endpoint}/commands`), names = Array.isArray(available) ? available.map(String) : Object.keys(available || {}); if (!names.includes(args.command)) throw new Error("Command is not exposed by this REW instance");
  return ok(bindPlan({ kind: "rew-diagnostic", createdAt: new Date().toISOString(), ...args, audible: /start|measure|record|play|sweep/i.test(args.command) }));
}));

server.tool("rew_diagnostic_execute", "Execute an exact live REW diagnostic plan; audible operations require physical-readiness confirmation.", { ...planSchema, audibleReady: z.boolean().default(false) }, guarded(async ({ plan, confirmationToken, confirm, audibleReady }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-diagnostic") throw new Error("Wrong plan kind"); if (p.audible && !audibleReady) throw new Error("Audible diagnostic readiness confirmation required");
  const available = await rew(`/${p.endpoint}/commands`), names = Array.isArray(available) ? available.map(String) : Object.keys(available || {}); if (!names.includes(p.command)) throw new Error("REW command availability changed after planning");
  return ok({ executed: true, endpoint: p.endpoint, command: p.command, response: await rew(`/${p.endpoint}/command`, { method: "POST", body: { command: p.command, parameters: p.parameters }, timeoutMs: 120000 }) });
}));

server.tool("audio_filter_export_plan", "Create a hash-bound cross-platform filter export plan.", { filters: z.array(filterSchema).max(40), format: z.enum(["rew-generic", "equalizer-apo", "camilladsp-yaml", "minidsp-rew", "json"]), file: z.string().regex(/^[A-Za-z0-9._-]+$/), home: z.string().optional() }, guarded(async args => {
  const extension = args.format === "json" ? ".json" : args.format === "camilladsp-yaml" ? ".yaml" : ".txt"; if (!args.file.toLowerCase().endsWith(extension)) throw new Error(`Export file must end with ${extension}`);
  const root = await workspaceRoot(args.home), path = await safeWorkspacePath(root, join("filters", args.file), [extension]); return ok(bindPlan({ kind: "filter-export", createdAt: new Date().toISOString(), format: args.format, filters: args.filters, path, home: args.home }));
}));

server.tool("audio_filter_export_execute", "Write and verify an exact cross-platform filter export.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "filter-export") throw new Error("Wrong plan kind");
  const root = await workspaceRoot(p.home); if (p.path !== await safeWorkspacePath(root, relative(root, p.path), [p.format === "json" ? ".json" : p.format === "camilladsp-yaml" ? ".yaml" : ".txt"])) throw new Error("Export path verification failed");
  const content = exportFilters(p.filters, p.format); await mkdir(dirname(p.path), { recursive: true }); await writeAtomicSet([[p.path, content]], confirmationToken); const verified = await readFile(p.path, "utf8"); if (verified !== content) throw new Error("Filter export verification failed"); return ok({ exported: p.path, format: p.format, bytes: Buffer.byteLength(content), contentHash: bindPlan({ content }).confirmationToken });
}));

server.tool("audio_listening_test_plan", "Create a fingerprinted, measured-level-matched randomized A/B or ABX listening-test plan.", { presetA: z.string().min(1).max(100), presetB: z.string().min(1).max(100), presetFingerprintA: z.string().min(8).max(128).optional(), presetFingerprintB: z.string().min(8).max(128).optional(), mode: z.enum(["AB", "ABX"]).default("ABX"), trials: z.number().int().min(4).max(40).default(8), levelMatchedWithinDb: z.number().min(0.05).max(1).default(0.2), measuredLevelDifferenceDb: z.number().min(-12).max(12).optional(), programExcerpts: z.array(z.string().min(1).max(160)).max(12).default([]), playbackChainFingerprint: z.string().min(8).max(128).optional(), seed: z.string().max(200).optional() }, guarded(async args => ok(listeningTestPlan(args))));
server.tool("audio_listening_test_report", "Summarize a completed listening test while keeping preference separate from objective quality.", { plan: z.record(z.any()), responses: z.array(z.object({ trial: z.number().int().positive(), choice: z.enum(["A", "B", "same"]), confidence: z.number().min(0).max(100).optional(), note: z.string().max(300).optional() })).max(40) }, guarded(async ({ plan, responses }) => ok(listeningTestReport(plan, responses))));

server.tool("audio_report_plan", "Create a hash-bound Markdown, HTML, and JSON report plan with optional overlaid raw, 1/48, ERB, and frequency-dependent curves.", { baseName: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), title: z.string().max(120).default("Audio Calibration Report"), assessment: z.record(z.any()), eq: z.record(z.any()).optional(), listening: z.record(z.any()).optional(), resolutionMeasurementId: z.string().max(120).optional(), resolutionLowHz: z.number().min(5).max(1000).default(20), resolutionHighHz: z.number().min(1000).max(24000).default(20000), modalBoundaryHz: z.number().min(20).max(500).default(200), smoothingTransitionHz: z.number().min(100).max(4000).default(1000), home: z.string().optional() }, guarded(async args => {
  let resolutionViews = null;
  if (args.resolutionMeasurementId) { const id = encodeURIComponent(args.resolutionMeasurementId), raw = await rew(`/measurements/${id}/frequency-response?smoothing=None`).catch(() => null), minimal = await rew(`/measurements/${id}/frequency-response?ppo=96&smoothing=1%2F48`), source = raw?.smoothing === "None" ? raw : minimal, range = { lowHz: args.resolutionLowHz, highHz: args.resolutionHighHz }; resolutionViews = { raw: traceViewRows(source, range), minimal: traceViewRows(minimal, range), perceptual: erbSmooth(source, range).rows.map(x => ({ frequencyHz: x.frequencyHz, levelDb: x.levelDb })), adaptive: frequencyDependentSmooth(source, { ...range, modalBoundaryHz: args.modalBoundaryHz, transitionHz: args.smoothingTransitionHz }).rows.map(x => ({ frequencyHz: x.frequencyHz, levelDb: x.levelDb })) }; }
  const reportArgs = { ...args, resolutionViews }; renderHumanReport(reportArgs); const root = await workspaceRoot(args.home), paths = {}; for (const ext of [".md", ".html", ".json"]) paths[ext] = await safeWorkspacePath(root, join("reports", `${args.baseName}${ext}`), [ext]); return ok(bindPlan({ kind: "audio-report", createdAt: new Date().toISOString(), ...reportArgs, paths }));
}));

server.tool("audio_report_execute", "Write and verify an exact human-readable and machine-readable calibration report set.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "audio-report") throw new Error("Wrong plan kind"); const report = renderHumanReport(p), root = await workspaceRoot(p.home); await mkdir(join(root, "reports"), { recursive: true });
  const values = { ".md": report.markdown, ".html": report.html, ".json": JSON.stringify(report.json, null, 2) + "\n" }, entries = []; for (const [ext, path] of Object.entries(p.paths)) { if (path !== await safeWorkspacePath(root, relative(root, path), [ext])) throw new Error("Report path verification failed"); entries.push([path, values[ext]]); } await writeAtomicSet(entries, confirmationToken);
  const parsed = JSON.parse(await readFile(p.paths[".json"], "utf8")); if (parsed.schemaVersion !== 2) throw new Error("Report verification failed"); return ok({ written: p.paths, schemaVersion: parsed.schemaVersion });
}));

const profileSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), deviceClass: z.enum(["laptop", "car", "general"]), manufacturer: z.string().max(100).optional(), model: z.string().max(150).optional(), role: z.string().max(80), f3Hz: z.number().positive().optional(), sensitivityDb: z.number().optional(), nominalImpedanceOhm: z.number().positive().optional(), maxSplDb: z.number().positive().optional(), listeningDistanceM: z.number().positive().optional(), coordinatesM: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), source: z.string().max(300).optional(), notes: z.string().max(1000).optional() });
const speakerProfilePlan = async ({ home, profile }) => { const root = await workspaceRoot(home), path = await safeWorkspacePath(root, join("profiles", `${profile.id}.json`), [".json"]), before = await readFile(path, "utf8").catch(error => error.code === "ENOENT" ? null : Promise.reject(error)), content = JSON.stringify({ ...profile, updatedAt: new Date().toISOString(), uncertainty: profile.source ? "user_or_source_supplied" : "unverified_user_profile" }, null, 2) + "\n"; return bindPlan({ kind: "speaker-profile-save", createdAt: new Date().toISOString(), home, profile, path, beforeHash: before === null ? null : stableToken(before), content }); };
server.tool("speaker_profile_save", "Deprecated compatibility alias: create a hash-bound speaker-profile save plan; execute it with speaker_profile_save_execute.", { home: z.string().optional(), profile: profileSchema }, guarded(async args => ok(await speakerProfilePlan(args))));
server.tool("speaker_profile_save_plan", "Create a hash-bound evidence-tagged speaker-profile save/update plan.", { home: z.string().optional(), profile: profileSchema }, guarded(async args => ok(await speakerProfilePlan(args))));
server.tool("speaker_profile_save_execute", "Save an exact speaker profile with pre-change backup, verification, and rollback.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "speaker-profile-save") throw new Error("Wrong plan kind"); const root = await workspaceRoot(p.home), path = await safeWorkspacePath(root, join("profiles", `${p.profile.id}.json`), [".json"]); if (path !== p.path) throw new Error("Profile path changed after planning");
  const current = await readFile(path, "utf8").catch(error => error.code === "ENOENT" ? null : Promise.reject(error)); if ((current === null ? null : stableToken(current)) !== p.beforeHash) throw new Error("Profile changed after planning"); await mkdir(dirname(path), { recursive: true });
  const backup = current === null ? null : await safeWorkspacePath(root, join("backups", `${p.profile.id}-profile-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), [".json"]); if (backup) { await mkdir(dirname(backup), { recursive: true }); await writeFile(backup, current, { flag: "wx" }); }
  try { if (current === null) await writeAtomicSet([[path, p.content]], confirmationToken); else await writeFile(path, p.content); const verified = await readFile(path, "utf8"); if (verified !== p.content) throw new Error("Profile verification failed"); return ok({ saved: path, backup, contentHash: stableToken(verified), profile: p.profile }); }
  catch (error) { if (backup) await copyFile(backup, path); else await unlink(path).catch(() => {}); throw new Error(`${error.message}; profile state restored`); }
}));
server.tool("speaker_profile_get", "Read a workspace speaker profile.", { home: z.string().optional(), id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/) }, guarded(async ({ home, id }) => { const root = await workspaceRoot(home), path = await safeWorkspacePath(root, join("profiles", `${id}.json`), [".json"]); return ok(JSON.parse(await readFile(path, "utf8"))); }));

server.tool("car_channel_map_validate", "Validate a car-audio DSP channel map and flag missing protective crossovers, duplicate outputs, and invalid passbands.", {
  channels: z.array(z.object({ output: z.string().min(1).max(80), role: z.string().min(1).max(80), driverType: z.enum(["tweeter", "midrange", "midbass", "subwoofer", "fullrange"]), highPassHz: z.number().nonnegative().optional(), lowPassHz: z.number().positive().optional(), polarityInverted: z.boolean().default(false), amplifier: z.string().max(120).optional(), coordinatesM: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() })).min(1).max(32)
}, guarded(async ({ channels }) => {
  const issues = [], outputs = new Set();
  for (const c of channels) { if (outputs.has(c.output)) issues.push({ severity: "error", output: c.output, issue: "duplicate output mapping" }); outputs.add(c.output); if (c.driverType === "tweeter" && !c.highPassHz) issues.push({ severity: "error", output: c.output, issue: "tweeter has no documented protective high-pass" }); if (c.highPassHz && c.lowPassHz && c.highPassHz >= c.lowPassHz) issues.push({ severity: "error", output: c.output, issue: "high-pass is not below low-pass" }); }
  return ok({ valid: !issues.some(x => x.severity === "error"), issues, channels, measurementOrder: ["mute all unmeasured outputs", "verify each output at very low level", "measure individual drivers", "measure each crossover pair combined", "measure primary and secondary seat positions"] });
}));
server.tool("car_geometric_delay_advisor", "Calculate a geometry-only initial delay map for car speakers. Acoustic measurements supersede this estimate.", { listener: z.object({ x: z.number(), y: z.number(), z: z.number() }), speakers: z.array(z.object({ id: z.string(), x: z.number(), y: z.number(), z: z.number() })).min(2).max(32), speedOfSoundMps: z.number().min(330).max(355).default(343) }, guarded(async ({ listener, speakers, speedOfSoundMps }) => { const rows = speakers.map(s => ({ id: s.id, distanceM: Math.hypot(s.x - listener.x, s.y - listener.y, s.z - listener.z) })), farthest = Math.max(...rows.map(x => x.distanceM)); return ok({ basis: "geometry-only initial estimate", referenceDistanceM: farthest, channels: rows.map(x => ({ ...x, delayMs: (farthest - x.distanceM) / speedOfSoundMps * 1000 })), warning: "Verify with acoustic timing and crossover summation; cabin reflections and DSP latency are not represented." }); }));

server.tool("jamesdsp_status", "Detect JDSP4Linux and decode engine, master-bypass, EQ-module, runtime-sync, and active-preset identity state.", {}, guarded(async () => ok(await jamesDspStatus())));
server.tool("jamesdsp_snapshot", "Fingerprint the live JamesDSP configuration and identify the exact active preset and effective EQ/bypass state without changing anything.", {}, guarded(async () => { const status = await jamesDspStatus(); if (!status.available) throw new Error(status.reason); const config = await readFile(status.configPath, "utf8"); const keys = config.split("\n").filter(x => /^[a-z0-9_]+=/.test(x)).map(x => x.slice(0, x.indexOf("="))); return ok({ ...status, configurationKeys: keys, configurationBytes: Buffer.byteLength(config) }); }));
server.tool("jamesdsp_preset_plan", "Create a hash-bound JamesDSP preset operation with an automatic configuration backup.", { action: z.enum(["load", "save"]), presetName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/), home: z.string().optional() }, guarded(async args => { const status = await jamesDspStatus(); if (!status.available) throw new Error(status.reason); return ok(bindPlan({ kind: "jamesdsp-preset", createdAt: new Date().toISOString(), status, action: args.action, presetName: args.presetName, home: args.home })); }));
server.tool("jamesdsp_preset_execute", "Back up JamesDSP, execute an exact preset load/save plan, verify status, and automatically restore the active configuration on failure.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "jamesdsp-preset") throw new Error("Wrong plan kind");
  const status = await jamesDspStatus(), adapter = await jamesDspAdapter(); if (!status.available || !adapter) throw new Error(status.reason); const root = await workspaceRoot(p.home), backup = await jamesDspBackup(root), flag = p.action === "load" ? "--load-preset" : "--save-preset"; let commandWarning = null;
  try {
    try { await execFileAsync(adapter.command, [...adapter.prefix, flag, p.presetName], { timeout: 10000, env: hostAudioEnv() }); } catch (error) { commandWarning = `JamesDSP CLI exited nonzero: ${error.code ?? "unknown"}`; }
    const verified = await jamesDspStatus(); if (p.action === "save" && !String(verified.presets || "").split(/\r?\n/).includes(p.presetName)) throw new Error("JamesDSP preset save verification failed");
    if (p.action === "load") { const presetPath = join(dirname(status.configPath), "presets", `${p.presetName}.conf`), [active, preset] = await Promise.all([readFile(status.configPath, "utf8"), readFile(presetPath, "utf8")]); if (active.trim() !== preset.trim()) throw new Error("JamesDSP preset load verification failed"); }
    return ok({ applied: true, action: p.action, presetName: p.presetName, backup, commandWarning, verified, rollback: { activeConfigurationBackup: backup } });
  } catch (error) { await copyFile(backup, status.configPath); const restored = await readFile(status.configPath, "utf8"), source = await readFile(backup, "utf8"); if (restored !== source) throw new Error(`${error.message}; automatic rollback verification also failed`); throw new Error(`${error.message}; active JamesDSP configuration restored from backup`); }
}));
server.tool("jamesdsp_key_plan", "Create a hash-bound change for one JamesDSP key after verifying that the installed version exposes it.", { key: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/), value: z.string().min(1).max(1000), home: z.string().optional() }, guarded(async ({ key, value, home }) => { const status = await jamesDspStatus(), adapter = await jamesDspAdapter(); if (!status.available || !adapter) throw new Error(status.reason); const listed = (await execFileAsync(adapter.command, [...adapter.prefix, "--list-keys"], { timeout: 10000, env: hostAudioEnv() })).stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean); if (!listed.includes(key)) throw new Error("Key is not exposed by this JamesDSP version"); const before = (await execFileAsync(adapter.command, [...adapter.prefix, "--get", key], { timeout: 10000, env: hostAudioEnv() })).stdout.trim(); return ok(bindPlan({ kind: "jamesdsp-key", createdAt: new Date().toISOString(), key, value, before, home, configPath: status.configPath })); }));
server.tool("jamesdsp_key_execute", "Back up JamesDSP, apply one exact key change, verify it, and automatically restore the active configuration on failure.", planSchema, guarded(async ({ plan, confirmationToken, confirm }) => {
  if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "jamesdsp-key") throw new Error("Wrong plan kind"); const adapter = await jamesDspAdapter(); if (!adapter) throw new Error("JamesDSP unavailable"); const root = await workspaceRoot(p.home), backup = await jamesDspBackup(root); let commandWarning = null;
  try { try { await execFileAsync(adapter.command, [...adapter.prefix, "--set", `${p.key}=${p.value}`], { timeout: 10000, env: hostAudioEnv() }); } catch (error) { commandWarning = `JamesDSP CLI exited nonzero: ${error.code ?? "unknown"}`; } const after = (await execFileAsync(adapter.command, [...adapter.prefix, "--get", p.key], { timeout: 10000, env: hostAudioEnv() })).stdout.trim(); if (!after.includes(p.value)) throw new Error("JamesDSP key verification failed"); return ok({ applied: true, key: p.key, before: p.before, after, backup, commandWarning, rollback: { key: p.key, value: p.before, activeConfigurationBackup: backup } }); }
  catch (error) { await copyFile(backup, p.configPath); const restored = await readFile(p.configPath, "utf8"), source = await readFile(backup, "utf8"); if (restored !== source) throw new Error(`${error.message}; automatic rollback verification also failed`); throw new Error(`${error.message}; active JamesDSP configuration restored from backup`); }
}));

export { server };
if (process.env.NODE_ENV !== "test") await server.connect(new StdioServerTransport());

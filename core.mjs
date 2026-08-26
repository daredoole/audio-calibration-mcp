import { createHash } from "node:crypto";
import { access, lstat, mkdir, realpath, copyFile, readFile, readdir, stat } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const REW_BASE = process.env.AUDIO_REW_URL || "http://127.0.0.1:4735";
export const DEVICE_LIMITS = Object.freeze({
  general: { startHz: 20, endHz: 20000, levelDbfs: -24, maxSplDb: 85, maxBoostDb: 3 },
  car: { startHz: 20, endHz: 20000, levelDbfs: -24, maxSplDb: 85, maxBoostDb: 3 },
  laptop: { startHz: 120, endHz: 20000, levelDbfs: -30, maxSplDb: 75, maxBoostDb: 0 }
});
const MAX_SERIES_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_SERIES_SAMPLES = 2_000_000;
const MAX_REW_RESPONSE_BYTES = 64 * 1024 * 1024;

export function stableToken(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export async function hashFile(path, maxBytes = 2 * 1024 * 1024 * 1024) {
  const info = await stat(path); if (!info.isFile()) throw new Error("Artifact is not a regular file"); if (info.size > maxBytes) throw new Error("Artifact exceeds the file-size limit");
  const hash = createHash("sha256"); await new Promise((resolveStream, reject) => { const stream = createReadStream(path); stream.on("data", chunk => hash.update(chunk)); stream.on("end", resolveStream); stream.on("error", reject); }); return { sha256: hash.digest("hex"), bytes: info.size, modifiedMs: info.mtimeMs };
}
export function bindPlan(unsigned) { return { ...unsigned, confirmationToken: stableToken(unsigned) }; }
export function verifyPlan(plan, supplied) {
  const { confirmationToken: _ignored, ...unsigned } = plan || {};
  if (!supplied || supplied !== stableToken(unsigned) || plan.confirmationToken !== supplied) throw new Error("Plan or confirmation token mismatch");
  return unsigned;
}
export function safeMeasurementSettings(deviceClass, requested = {}) {
  const limits = DEVICE_LIMITS[deviceClass];
  if (!limits) throw new Error("Unsupported device class");
  const q = { ...limits, ...requested };
  if (q.startHz < limits.startHz) throw new Error(`${deviceClass} sweeps must start at or above ${limits.startHz} Hz`);
  if (q.endHz > limits.endHz || q.endHz <= q.startHz) throw new Error("Unsafe or invalid sweep range");
  if (q.levelDbfs > limits.levelDbfs) throw new Error(`${deviceClass} sweep level may not exceed ${limits.levelDbfs} dBFS`);
  if (q.maxSplDb > limits.maxSplDb) throw new Error(`${deviceClass} SPL guard may not exceed ${limits.maxSplDb} dB`);
  return q;
}
export function parseSeries(value) {
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
export function frequencyAxis(trace, n) {
  const direct = parseSeries(trace?.frequencies || trace?.frequency);
  if (direct.length === n) return direct;
  const start = Number(trace?.startFreq || trace?.startFrequency || 10), ppo = Number(trace?.ppo);
  if (Number.isFinite(ppo) && ppo > 0) return Array.from({ length: n }, (_, i) => start * 2 ** (i / ppo));
  const step = Number(trace?.freqStep || trace?.frequencyStep || 1);
  return Array.from({ length: n }, (_, i) => start + i * step);
}
export function interpolate(xs, ys, x) {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0]; if (x >= xs.at(-1)) return ys.at(-1);
  let low = 1, high = xs.length - 1; while (low < high) { const middle = (low + high) >> 1; if (xs[middle] < x) low = middle + 1; else high = middle; } const i = low;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}
export function circularDelta(a, b) { return Math.abs((((a - b) + 540) % 360) - 180); }
export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : NaN;
}
export function crossoverMetrics(main, sub, crossoverHz, spanOctaves = 1) {
  const am = parseSeries(main.magnitude), ap = parseSeries(main.phase), bm = parseSeries(sub.magnitude), bp = parseSeries(sub.phase);
  const ax = frequencyAxis(main, am.length), bx = frequencyAxis(sub, bm.length), lo = crossoverHz / 2 ** spanOctaves, hi = crossoverHz * 2 ** spanOctaves, rows = [];
  for (let f = lo; f <= hi; f *= 2 ** (1 / 24)) {
    const ma = interpolate(ax, am, f), mb = interpolate(bx, bm, f), pa = interpolate(ax, ap, f), pb = interpolate(bx, bp, f);
    if (![ma, mb, pa, pb].every(Number.isFinite)) continue;
    const va = 10 ** (ma / 20), vb = 10 ** (mb / 20), d = (pa - pb) * Math.PI / 180;
    const sum = 20 * Math.log10(Math.sqrt(va * va + vb * vb + 2 * va * vb * Math.cos(d)));
    rows.push({ frequencyHz: Math.round(f * 10) / 10, phaseDeltaDeg: circularDelta(pa, pb), predictedSumDb: sum, betterInputDb: Math.max(ma, mb), summationDb: sum - Math.max(ma, mb) });
  }
  return { crossoverHz, medianPhaseDeltaDeg: median(rows.map(x => x.phaseDeltaDeg)), medianSummationDb: median(rows.map(x => x.summationDb)), atCrossover: rows.reduce((a, b) => Math.abs(b.frequencyHz - crossoverHz) < Math.abs(a.frequencyHz - crossoverHz) ? b : a, rows[0] || null), rows };
}
export function multiseatMetrics(traces, lowHz = 20, highHz = 300, roomVolumeM3, rt60Seconds) {
  const rows = [];
  for (let f = lowHz; f <= highHz; f *= 2 ** (1 / 12)) {
    const levels = traces.map(t => interpolate(frequencyAxis(t, parseSeries(t.magnitude).length), parseSeries(t.magnitude), f)).filter(Number.isFinite);
    if (levels.length < 2) continue;
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length, med = median(levels);
    const sd = Math.sqrt(levels.reduce((s, x) => s + (x - mean) ** 2, 0) / levels.length);
    rows.push({ frequencyHz: Math.round(f * 10) / 10, meanDb: mean, spreadDb: Math.max(...levels) - Math.min(...levels), standardDeviationDb: sd, outlierSeatIndices: levels.map((x, i) => Math.abs(x - med) > 6 ? i : -1).filter(i => i >= 0) });
  }
  const schroederHz = roomVolumeM3 && rt60Seconds ? 2000 * Math.sqrt(rt60Seconds / roomVolumeM3) : null;
  return { schroederHz, medianSpreadDb: median(rows.map(x => x.spreadDb)), modalCandidates: rows.filter(x => x.spreadDb >= 8 || x.standardDeviationDb >= 3).sort((a, b) => b.spreadDb - a.spreadDb).slice(0, 12), seatOutlierCounts: traces.map((_, i) => rows.filter(r => r.outlierSeatIndices.includes(i)).length), rows };
}
export function eqProposal(trace, { lowHz = 40, highHz = 16000, maxCutDb = 6, maxBoostDb = 0, bands = 10 } = {}) {
  const mag = parseSeries(trace.magnitude), xs = frequencyAxis(trace, mag.length);
  const anchors = Array.from({ length: bands }, (_, i) => lowHz * (highHz / lowHz) ** (i / Math.max(1, bands - 1))), baseline = median(anchors.map(f => interpolate(xs, mag, f)));
  return anchors.map(f => { const measured = interpolate(xs, mag, f), correction = Math.max(-maxCutDb, Math.min(maxBoostDb, baseline - measured)); return { type: "PK", frequencyHz: Math.round(f), gainDb: Math.round(correction * 10) / 10, q: 1.2, measuredDb: Math.round(measured * 10) / 10 }; }).filter(x => Math.abs(x.gainDb) >= 0.5);
}
export async function rew(path, options = {}) {
  const controller = new AbortController(), timeoutMs = options.timeoutMs || 8000, timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${REW_BASE}${path}`, { method: options.method || "GET", headers: options.body === undefined ? {} : { "content-type": "application/json" }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal });
    const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_REW_RESPONSE_BYTES) throw new Error("REW response exceeds the 64 MB limit");
    const reader = response.body?.getReader(), chunks = []; let bytes = 0;
    if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_REW_RESPONSE_BYTES) { await reader.cancel(); throw new Error("REW response exceeds the 64 MB limit"); } chunks.push(value); } }
    const text = reader ? Buffer.concat(chunks.map(x => Buffer.from(x)), bytes).toString("utf8") : await response.text(); if (!response.ok) throw new Error(`REW ${response.status}: ${text.slice(0, 300)}`);
    if (!text) return null; try { return JSON.parse(text); } catch { return text; }
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`REW request timeout after ${timeoutMs} ms`);
    throw error;
  } finally { clearTimeout(timeout); }
}
export function measurementEntries(value) { return Array.isArray(value) ? value.map((v, i) => [String(v.id ?? v.uuid ?? i + 1), v]) : Object.entries(value || {}); }
export async function waitForMeasurement(beforeIds, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const now = measurementEntries(await rew("/measurements")), fresh = now.find(([id]) => !beforeIds.has(id)); if (fresh) return fresh; await new Promise(r => setTimeout(r, 350)); }
  throw new Error("Timed out waiting for REW measurement");
}
export async function audioSnapshot() {
  const [status, configuration, driver, sampleRate, inputCal] = await Promise.all([rew("/audio/status"), rew("/audio/configuration"), rew("/audio/driver"), rew("/audio/samplerate"), rew("/audio/input-cal")]);
  const driverName = String(driver?.driver || driver?.value || driver), family = driverName.toLowerCase().includes("asio") ? "asio" : "java", base = `/audio/${family}`, get = p => rew(`${base}/${p}`).catch(() => null);
  const [inputDevices, outputDevices, inputs, outputs, inputChannels, outputChannels, inputDevice, outputDevice, input, output, inputChannel, outputChannel] = await Promise.all([get("input-devices"), get("output-devices"), get("inputs"), get("outputs"), get("input-channels"), get("output-channels"), get("input-device"), get("output-device"), get("input"), get("output"), get("input-channel"), get("output-channel")]);
  return { status, configuration, driver: driverName, family, sampleRate, inputCal, inputDevices, outputDevices, inputs, outputs, inputChannels, outputChannels, inputDevice, outputDevice, input, output, inputChannel, outputChannel };
}
export async function workspaceRoot(value) { const root = resolve(value || process.env.AUDIO_CALIBRATION_HOME || process.cwd()); await mkdir(root, { recursive: true }); return await realpath(root); }
export async function safeWorkspacePath(root, relative, allowed = []) {
  if (!relative || isAbsolute(relative) || relative.includes("\0") || /^[A-Za-z]:[\\/]/.test(relative) || /^\\\\|^\/\//.test(relative)) throw new Error("Path must be workspace-relative");
  if (allowed.length && !allowed.includes(extname(relative).toLowerCase())) throw new Error("File extension is not allowed");
  const candidate = resolve(root, relative); if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error("Path escapes workspace");
  let probe = candidate; while (probe !== root) { try { const st = await lstat(probe); if (st.isSymbolicLink()) throw new Error("Symlink path is not allowed"); if (probe === candidate && st.isFile() && st.nlink > 1) throw new Error("Hard-linked files are not allowed"); } catch (e) { if (e.code !== "ENOENT") throw e; } probe = dirname(probe); }
  return candidate;
}
export function hostAudioEnv() {
  if (process.platform !== "linux") return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`, PULSE_SERVER: process.env.PULSE_SERVER || `unix:${runtime}/pulse/native` };
}
async function run(cmd, args) { try { return (await execFileAsync(cmd, args, { timeout: 5000, maxBuffer: 256000, env: hostAudioEnv() })).stdout.trim(); } catch { return null; } }
export async function hostInventory() {
  if (process.platform === "linux") {
    const defaultSink = await run("pactl", ["get-default-sink"]), defaultSource = await run("pactl", ["get-default-source"]);
    const sinkMuteRaw = defaultSink ? await run("pactl", ["get-sink-mute", defaultSink]) : null;
    const sourceMuteRaw = defaultSource ? await run("pactl", ["get-source-mute", defaultSource]) : null;
    const sinkVolume = defaultSink ? await run("pactl", ["get-sink-volume", defaultSink]) : null;
    const sourceVolume = defaultSource ? await run("pactl", ["get-source-volume", defaultSource]) : null;
    return { platform: "linux", backend: await run("pactl", ["info"]), sinks: await run("pactl", ["list", "short", "sinks"]), sources: await run("pactl", ["list", "short", "sources"]), defaultSink, defaultSource, defaultSinkMuted: sinkMuteRaw === null ? null : /yes/i.test(sinkMuteRaw), defaultSourceMuted: sourceMuteRaw === null ? null : /yes/i.test(sourceMuteRaw), defaultSinkVolume: sinkVolume, defaultSourceVolume: sourceVolume, routingWritable: Boolean(await run("sh", ["-lc", "command -v pactl"])) };
  }
  if (process.platform === "darwin") return { platform: "macos", devices: await run("system_profiler", ["SPAudioDataType", "-json"]), routingWritable: false, note: "Inventory is native; route mutation requires an explicitly installed adapter." };
  if (process.platform === "win32") return { platform: "windows", devices: await run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_SoundDevice | Select-Object Name,Status,PNPDeviceID | ConvertTo-Json"]), routingWritable: false, note: "Inventory is native; route mutation requires an explicitly installed adapter." };
  return { platform: process.platform, routingWritable: false };
}
export async function jamesDspAdapter() {
  if (process.platform !== "linux") return null;
  try { await access("/usr/bin/jamesdsp", constants.X_OK); return { packaging: "native", command: "/usr/bin/jamesdsp", prefix: ["--silent", "--no-color"], configPath: join(process.env.HOME || "", ".config", "jamesdsp", "audio.conf") }; } catch {}
  try {
    await access("/usr/bin/flatpak", constants.X_OK); const app = "me.timschneeberger.jdsp4linux";
    if (await run("/usr/bin/flatpak", ["info", app]) !== null) return { packaging: "flatpak", command: "/usr/bin/flatpak", prefix: ["run", app, "--silent", "--no-color"], configPath: join(process.env.HOME || "", ".var", "app", app, "config", "jamesdsp", "audio.conf") };
  } catch {}
  return null;
}
export function parseJamesDspConfig(text) {
  const entries = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("=")).map(line => { const split = line.indexOf("="); return [line.slice(0, split).trim(), line.slice(split + 1).trim()]; });
  return Object.fromEntries(entries.filter(([key]) => /^[a-z][a-z0-9_]*$/.test(key)));
}
const jamesBoolean = value => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
};
const canonicalJamesConfig = config => Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
export function decodeJamesDspState({ configText, statusText, connectedText, liveValues = {}, presetConfigs = {} }) {
  const diskConfig = parseJamesDspConfig(configText), effectiveConfig = { ...diskConfig };
  for (const [key, value] of Object.entries(liveValues)) if (value !== null && value !== undefined) effectiveConfig[key] = String(value).trim();
  const runtimeDriftKeys = Object.keys(liveValues).filter(key => liveValues[key] !== null && liveValues[key] !== undefined && String(liveValues[key]).trim() !== diskConfig[key]);
  const enableKeys = Object.keys(effectiveConfig).filter(key => key.endsWith("_enable")), moduleStates = {};
  for (const key of enableKeys.filter(key => key !== "master_enable")) moduleStates[key.slice(0, -7)] = jamesBoolean(effectiveConfig[key]);
  const engineMatch = String(statusText || "").match(/Is processing:\s*(enabled|disabled)/i), engineProcessing = engineMatch ? jamesBoolean(engineMatch[1]) : null;
  const connected = jamesBoolean(connectedText), masterEnabled = jamesBoolean(effectiveConfig.master_enable);
  const globallyBypassed = engineProcessing === false || masterEnabled === false;
  const effectiveProcessing = connected === false || globallyBypassed ? false : connected === true && engineProcessing === true && masterEnabled === true ? true : null;
  const eqModuleNames = ["graphiceq", "tone", "ddc", "convolver", "liveprog"], enabledEqModules = eqModuleNames.filter(name => moduleStates[name] === true);
  const equalizationActive = effectiveProcessing === false ? false : effectiveProcessing === true ? enabledEqModules.length > 0 : null;
  const effectiveCanonical = canonicalJamesConfig(effectiveConfig), exactMatches = [], candidates = [];
  for (const [name, text] of Object.entries(presetConfigs)) {
    const preset = parseJamesDspConfig(text), keys = new Set([...Object.keys(effectiveConfig), ...Object.keys(preset)]), differingKeys = [...keys].filter(key => effectiveConfig[key] !== preset[key]).sort();
    const exact = JSON.stringify(effectiveCanonical) === JSON.stringify(canonicalJamesConfig(preset));
    if (exact) exactMatches.push(name);
    candidates.push({ name, exact, differingKeyCount: differingKeys.length, differingKeys });
  }
  candidates.sort((a, b) => a.differingKeyCount - b.differingKeyCount || a.name.localeCompare(b.name));
  const presetIdentity = exactMatches.length === 1 ? { status: "exact", activePreset: exactMatches[0], exactMatches, closestCandidate: candidates[0] || null } : exactMatches.length > 1 ? { status: "ambiguous-exact", activePreset: null, exactMatches, closestCandidate: candidates[0] || null } : { status: "no-exact-match", activePreset: null, exactMatches: [], closestCandidate: candidates[0] || null };
  return {
    connected, engineProcessing, masterEnabled, effectiveProcessing, equalizationActive,
    bypass: { active: globallyBypassed, engineBypassed: engineProcessing === false, masterBypassed: masterEnabled === false, reason: engineProcessing === false ? "JamesDSP engine processing is disabled" : masterEnabled === false ? "JamesDSP master processing is disabled" : null },
    moduleStates, enabledModules: Object.entries(moduleStates).filter(([, enabled]) => enabled === true).map(([name]) => name), enabledEqModules,
    runtimeConfigSynchronized: runtimeDriftKeys.length === 0, runtimeDriftKeys,
    stateVerified: connected !== null && engineProcessing !== null && masterEnabled !== null && runtimeDriftKeys.length === 0,
    configurationHash: stableToken(String(configText || "")), effectiveConfigurationFingerprint: stableToken(effectiveCanonical), configurationKeyCount: Object.keys(effectiveConfig).length,
    presetIdentity
  };
}
export async function jamesDspStatus() {
  const adapter = await jamesDspAdapter();
  if (!adapter) return { available: false, platform: process.platform, reason: process.platform === "linux" ? "JamesDSP native or Flatpak installation not found" : "JDSP4Linux supports Linux PipeWire/PulseAudio" };
  const invoke = args => run(adapter.command, [...adapter.prefix, ...args]);
  const [connectedText, statusText, devices, presets, presetRules, configText] = await Promise.all([invoke(["--is-connected"]), invoke(["--status"]), invoke(["--list-devices"]), invoke(["--list-presets"]), invoke(["--list-preset-rules"]), readFile(adapter.configPath, "utf8")]);
  const parsed = parseJamesDspConfig(configText), runtimeKeys = Object.keys(parsed).filter(key => key === "master_enable" || key.endsWith("_enable"));
  const liveEntries = await Promise.all(runtimeKeys.map(async key => [key, await invoke(["--get", key])]));
  const presetDirectory = join(dirname(adapter.configPath), "presets"), presetConfigs = {};
  for (const file of await readdir(presetDirectory).catch(() => [])) if (/^[^/\\]+\.conf$/i.test(file)) { const name = file.slice(0, -5); presetConfigs[name] = await readFile(join(presetDirectory, file), "utf8").catch(() => ""); }
  const decoded = decodeJamesDspState({ configText, statusText, connectedText, liveValues: Object.fromEntries(liveEntries), presetConfigs });
  return { available: true, platform: "linux", packaging: adapter.packaging, connected: connectedText, status: statusText, devices, presets, presetRules, configPath: adapter.configPath, ...decoded };
}
export async function jamesDspBackup(root, label = "jamesdsp") {
  const adapter = await jamesDspAdapter(); if (!adapter) throw new Error("JamesDSP is unavailable"); const source = adapter.configPath; await access(source, constants.R_OK);
  const target = await safeWorkspacePath(root, join("backups", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.conf`), [".conf"]); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); return target;
}
export const internals = { stableToken, bindPlan, verifyPlan, safeMeasurementSettings, parseSeries, frequencyAxis, interpolate, circularDelta, crossoverMetrics, multiseatMetrics, eqProposal, parseJamesDspConfig, decodeJamesDspState, safeWorkspacePath, hostAudioEnv };

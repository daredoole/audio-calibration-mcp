import { createHash } from "node:crypto";
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = value => String(value || "").trim();

function conventionalCandidates(platform, env, home) {
  const p = platform === "win32" ? win32 : posix, candidates = [];
  if (platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(p.join(base, "REW", "roomeqwizard.exe"), p.join(base, "Programs", "REW", "roomeqwizard.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push("/Applications/REW.app", p.join(home, "Applications", "REW.app"));
  } else {
    candidates.push("/opt/REW/roomeqwizard", "/usr/local/bin/rew", "/usr/local/bin/roomeqwizard", p.join(home, "REW", "roomeqwizard"), p.join(home, ".local", "bin", "rew"));
  }
  return [...new Set(candidates)];
}

async function pathCommands(platform, env) {
  const names = platform === "win32" ? ["roomeqwizard.exe", "rew.exe"] : ["roomeqwizard", "rew"];
  const found = [];
  for (const name of names) {
    try {
      const command = platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(command, [name], { timeout: 2000, windowsHide: true, env });
      found.push(...String(stdout).split(/\r?\n/).map(clean).filter(Boolean));
    } catch {}
  }
  return found;
}

async function inspectCandidate(path, { platform, source }) {
  const requestedPath = clean(path);
  if (!requestedPath || requestedPath.length > 1000 || requestedPath.includes("\0")) return null;
  try {
    await access(requestedPath, constants.R_OK);
    const canonicalPath = await realpath(requestedPath), details = await stat(canonicalPath);
    const appBundle = platform === "darwin" && details.isDirectory() && requestedPath.toLowerCase().endsWith(".app");
    if (!details.isFile() && !appBundle) return null;
    if (!appBundle && platform !== "win32") await access(canonicalPath, constants.X_OK);
    const identity = { canonicalPath, size: details.size, mtimeMs: details.mtimeMs, mode: details.mode, appBundle };
    return { path: canonicalPath, requestedPath, source, appBundle, identityHash: hash(identity), identity };
  } catch { return null; }
}

export async function discoverRewInstall({ explicitPath, platform = process.platform, env = process.env, home = homedir(), pathLookup = pathCommands, inspect = inspectCandidate } = {}) {
  const requested = clean(explicitPath || env.AUDIO_REW_EXECUTABLE), raw = [];
  if (requested) raw.push([requested, explicitPath ? "user" : "environment"]);
  for (const value of await pathLookup(platform, env)) raw.push([value, "PATH"]);
  for (const value of conventionalCandidates(platform, env, home)) raw.push([value, "conventional"]);
  const candidates = [], seen = new Set();
  for (const [value, source] of raw) {
    const candidate = await inspect(value, { platform, source });
    if (candidate && !seen.has(candidate.path)) { seen.add(candidate.path); candidates.push(candidate); }
  }
  return {
    schemaVersion: 1, platform, found: candidates.length > 0, selected: candidates[0] || null, candidates,
    explicitPathAccepted: Boolean(requested && candidates.some(x => x.requestedPath === requested)),
    needsUserPath: candidates.length === 0,
    userAction: candidates.length ? null : "Provide the absolute REW executable path (or REW.app on macOS) to rew_install_discover or rew_launch_plan. AUDIO_REW_EXECUTABLE is also supported."
  };
}

export function rewLaunchCommand(candidate, platform = process.platform) {
  if (!candidate?.path) throw new Error("A discovered REW candidate is required");
  return candidate.appBundle && platform === "darwin"
    ? { command: "/usr/bin/open", args: [candidate.path] }
    : { command: candidate.path, args: [] };
}

export async function revalidateRewCandidate(candidate, platform = process.platform) {
  const current = await inspectCandidate(candidate.path, { platform, source: candidate.source });
  if (!current || current.identityHash !== candidate.identityHash) throw new Error("REW executable changed after planning");
  return current;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function launchRew({ candidate, platform = process.platform, timeoutMs = 20_000, probe, spawnImpl = nodeSpawn }) {
  const current = await revalidateRewCandidate(candidate, platform);
  try { const version = await probe(); return { launched: false, alreadyRunning: true, apiReady: true, version, executable: current.path }; } catch {}
  const launch = rewLaunchCommand(current, platform), child = spawnImpl(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  let launchError = null; child.once?.("error", error => { launchError = error; });
  child.unref?.();
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 45_000); let lastError = null;
  while (Date.now() < deadline) {
    if (launchError) return { launched: false, alreadyRunning: false, apiReady: false, executable: current.path, warning: `REW could not be started: ${String(launchError.message).slice(0, 240)}`, nextAction: "Provide a different absolute executable path to rew_launch_plan." };
    try { const version = await probe(); return { launched: true, alreadyRunning: false, apiReady: true, version, executable: current.path, pid: child.pid ?? null }; }
    catch (error) { lastError = error; await delay(350); }
  }
  return { launched: true, alreadyRunning: false, apiReady: false, executable: current.path, pid: child.pid ?? null, warning: `REW started but its API did not become ready: ${String(lastError?.message || "timeout").slice(0, 240)}`, nextAction: "In REW, enable the API server on port 4735, then run rew_probe or rew_capability_negotiate." };
}

export const rewLauncherInternals = { conventionalCandidates, inspectCandidate };

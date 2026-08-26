import { access, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { stableToken } from "../core.mjs";

const specs = Object.freeze({
  "equalizer-apo": { platforms: ["win32"], env: "AUDIO_EQUALIZER_APO_CONFIG", extensions: [".txt"], format: "equalizer-apo", description: "Equalizer APO managed configuration file" },
  camilladsp: { platforms: ["linux", "darwin", "win32"], env: "AUDIO_CAMILLADSP_FILTER_PATH", extensions: [".yaml", ".yml"], format: "camilladsp-yaml", description: "Dedicated CamillaDSP filter include file" }
});

async function noSymlinkComponents(path) {
  let cursor = resolve(path), root = parse(cursor).root;
  const trustedRoots = new Set([resolve(homedir()), resolve(tmpdir())]);
  while (cursor !== root && !trustedRoots.has(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Configured DSP path contains a symlink"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = dirname(cursor);
  }
}

export async function dspAdapterCapabilities(env = process.env, platform = process.platform) {
  const adapters = [];
  for (const [id, spec] of Object.entries(specs)) {
    const configuredPath = env[spec.env] || null, supportedPlatform = spec.platforms.includes(platform);
    let readable = false;
    if (configuredPath) readable = await access(configuredPath, constants.R_OK).then(() => true, () => false);
    adapters.push({ id, description: spec.description, supportedPlatform, configured: Boolean(configuredPath), configuredPath, readable, writableApply: supportedPlatform && Boolean(configuredPath), format: spec.format, configurationEnvironmentVariable: spec.env });
  }
  return { platform, adapters, exportOnly: ["rew-generic", "minidsp-rew", "json"], note: platform === "darwin" ? "macOS has no universal system-EQ apply target; use a supported host application's import format." : undefined };
}

export async function inspectDspTarget(adapterId, env = process.env) {
  const spec = specs[adapterId]; if (!spec) throw new Error("Unsupported DSP adapter");
  if (!spec.platforms.includes(process.platform)) throw new Error("DSP adapter is unavailable on this platform");
  const configured = env[spec.env]; if (!configured || !isAbsolute(configured)) throw new Error(`${spec.env} must be an explicit absolute path`);
  if (!spec.extensions.includes(extname(configured).toLowerCase())) throw new Error("Configured DSP path has an invalid extension");
  await noSymlinkComponents(configured);
  const current = await readFile(configured, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
  return { adapterId, path: resolve(configured), current, currentHash: stableToken(current), format: spec.format };
}

export async function applyDspTarget({ target, content, backupRoot, token }) {
  const latest = await inspectDspTarget(target.adapterId);
  if (latest.path !== target.path || latest.currentHash !== target.currentHash) throw new Error("DSP target changed after planning");
  const backup = join(backupRoot, `${target.adapterId}-${new Date().toISOString().replace(/[:.]/g, "-")}${extname(target.path)}.backup`);
  await mkdir(dirname(backup), { recursive: true }); await writeFile(backup, latest.current, { flag: "wx" });
  const temporary = `${target.path}.audio-calibration-${token.slice(0, 12)}.tmp`;
  try {
    await mkdir(dirname(target.path), { recursive: true }); await writeFile(temporary, content, { flag: "wx" }); await rename(temporary, target.path);
    const verified = await readFile(target.path, "utf8"); if (verified !== content) throw new Error("DSP adapter verification failed");
    return { applied: true, adapterId: target.adapterId, path: target.path, backup, contentHash: stableToken(verified), rollback: { backup, target: target.path } };
  } catch (error) {
    await unlink(temporary).catch(() => {}); await copyFile(backup, target.path);
    const restored = await readFile(target.path, "utf8"); if (restored !== latest.current) throw new Error(`${error.message}; rollback verification failed`);
    throw new Error(`${error.message}; original DSP file restored`);
  }
}

export const dspAdapterInternals = { noSymlinkComponents };

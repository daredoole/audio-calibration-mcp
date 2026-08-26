import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRewInstall, launchRew, revalidateRewCandidate, rewLauncherInternals } from "../lib/rew-launcher.mjs";

const syntheticInspect = async (path, { source }) => ({ path, requestedPath: path, source, appBundle: path.endsWith(".app"), identityHash: path, identity: { canonicalPath: path } });

test("REW discovery prioritizes user input and covers conventional paths on every platform", async () => {
  const linux = await discoverRewInstall({ explicitPath: "/custom/rew", platform: "linux", home: "/home/example", pathLookup: async () => ["/usr/bin/rew"], inspect: syntheticInspect });
  assert.equal(linux.selected.path, "/custom/rew"); assert.equal(linux.selected.source, "user"); assert.equal(linux.explicitPathAccepted, true);
  const mac = await discoverRewInstall({ platform: "darwin", home: "/Users/example", pathLookup: async () => [], inspect: syntheticInspect });
  assert.ok(mac.candidates.some(x => x.path === "/Applications/REW.app" && x.appBundle));
  const windows = rewLauncherInternals.conventionalCandidates("win32", { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" }, "C:\\Users\\Example");
  assert.ok(windows.some(x => /Program Files\\REW\\roomeqwizard\.exe$/i.test(x)));
});

test("REW discovery explicitly requests user input when no candidate is usable", async () => {
  const result = await discoverRewInstall({ platform: "linux", pathLookup: async () => [], inspect: async () => null });
  assert.equal(result.found, false); assert.equal(result.needsUserPath, true); assert.match(result.userAction, /absolute REW executable path/);
});

test("REW launch revalidates the executable, detaches safely, and waits for API readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "rew-launcher-")), executable = join(root, "rew"); await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o700);
  const discovery = await discoverRewInstall({ explicitPath: executable, platform: "linux", pathLookup: async () => [] });
  let probes = 0, spawnCall = null, unref = false;
  const result = await launchRew({ candidate: discovery.selected, platform: "linux", timeoutMs: 1500, probe: async () => { if (++probes < 2) throw new Error("offline"); return { version: "test" }; }, spawnImpl: (command, args, options) => { spawnCall = { command, args, options }; return { pid: 1234, unref: () => { unref = true; } }; } });
  assert.equal(result.apiReady, true); assert.equal(result.launched, true); assert.equal(spawnCall.command, executable); assert.equal(spawnCall.options.shell, false); assert.equal(unref, true);
  await writeFile(executable, "#!/bin/sh\necho changed\n"); await assert.rejects(revalidateRewCandidate(discovery.selected, "linux"), /changed after planning/);
});

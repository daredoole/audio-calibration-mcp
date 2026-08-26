import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindPlan, safeWorkspacePath, stableToken, verifyPlan } from "../core.mjs";
import { exportFilters } from "../human-listening.mjs";
import { analysisJobs, registerReleaseTools } from "../tool-domains/release-tools.mjs";
import { audioDoctor } from "../lib/diagnostics.mjs";

const terminal = async id => { for (let i = 0; i < 50; i++) { const job = analysisJobs.status(id); if (["complete", "failed", "cancelled"].includes(job.status)) return job; await new Promise(r => setTimeout(r, 2)); } throw new Error("timeout"); };

test("release tool domain validates artifacts, support redaction, jobs, negotiation, and DSP apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-release-tools-")), handlers = new Map(), server = { tool: (name, _description, _schema, handler) => handlers.set(name, handler) }, ok = data => data;
  const writeAtomicSet = async entries => { for (const [path, content] of entries) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp`; await writeFile(temporary, content, { flag: "wx" }); await rename(temporary, path); } };
  registerReleaseTools(server, { ok, guarded: fn => fn, bindPlan, verifyPlan, stableToken, workspaceRoot: async () => root, safeWorkspacePath, writeAtomicSet, exportFilters, rew: async path => path === "/version" ? { version: "test" } : [] });
  assert.ok(handlers.size >= 13);
  const job = analysisJobs.submit("release-test", async () => ({ done: true })); assert.equal((await terminal(job.id)).result.done, true); assert.equal((await handlers.get("audio_job_status")({ jobId: job.id, includeResult: true })).status, "complete");
  const cancelJob = analysisJobs.submit("cancel-test", async context => { await new Promise(r => setTimeout(r, 10)); context.throwIfCancelled(); }); assert.equal((await handlers.get("audio_job_cancel")({ jobId: cancelJob.id, confirm: true })).status, "cancelled");
  const capabilities = await handlers.get("rew_capability_negotiate")({}); assert.equal(capabilities.capabilities.version.available, true);
  const artifact = await handlers.get("audio_artifact_create")({ session: { id: "s", deviceClass: "general", algorithmVersion: "test", targetId: "general" }, sweeps: [{ id: "1", fingerprints: { control: "control-1", preset: "preset-1", microphone: "microphone-1" } }], analyses: {}, filters: [], provenance: { softwareVersion: "test" } });
  assert.equal((await handlers.get("audio_artifact_validate")({ artifact })).valid, true); assert.equal((await handlers.get("audio_artifact_migrate")({ artifact })).migrated, false); assert.equal((await handlers.get("audio_session_replay_validate")({ artifact: { ...artifact, sweeps: artifact.sweeps.map(s => ({ ...s, traceHash: "trace-hash" })) } })).replayable, true);
  await mkdir(join(root, "sessions")); await writeFile(join(root, "sessions", "source.json"), JSON.stringify({ username: "private", magnitude: [1, 2, 3], safe: true }));
  const supportPlan = await handlers.get("audio_support_bundle_plan")({ sourceFile: "sessions/source.json", outputName: "case.support.json" }); const support = await handlers.get("audio_support_bundle_execute")({ plan: supportPlan, confirmationToken: supportPlan.confirmationToken, confirm: true }); assert.equal(support.reviewBeforeSharing, true); assert.match(await readFile(support.written, "utf8"), /REDACTED/);
  const target = join(root, "camilla.yaml"); await writeFile(target, "old: true\n"); process.env.AUDIO_CAMILLADSP_FILTER_PATH = target;
  const dspPlan = await handlers.get("audio_dsp_apply_plan")({ adapter: "camilladsp", filters: [{ type: "PK", frequencyHz: 1000, gainDb: -2, q: 1 }] }); const applied = await handlers.get("audio_dsp_apply_execute")({ plan: dspPlan, confirmationToken: dspPlan.confirmationToken, confirm: true }); assert.equal(applied.applied, true); assert.match(await readFile(target, "utf8"), /1000/);
});

test("audio doctor returns readiness dimensions without throwing on optional integrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-doctor-")), result = await audioDoctor({ root, rewProbe: async () => ({ ready: true }) });
  assert.ok(["ready", "ready-with-warnings"].includes(result.status)); assert.ok(result.checks.some(x => x.id === "rew" && x.status === "pass"));
});

test("REW launch planning accepts a user executable but execution cannot bypass confirmation", async t => {
  const root = await mkdtemp(join(tmpdir(), "audio-rew-launch-")), executable = join(root, process.platform === "win32" ? "roomeqwizard.exe" : "rew"); await writeFile(executable, "test"); if (process.platform !== "win32") await chmod(executable, 0o700);
  const previous = process.env.AUDIO_REW_EXECUTABLE; process.env.AUDIO_REW_EXECUTABLE = executable; t.after(() => { if (previous === undefined) delete process.env.AUDIO_REW_EXECUTABLE; else process.env.AUDIO_REW_EXECUTABLE = previous; });
  const handlers = new Map(), server = { tool: (name, _description, _schema, handler) => handlers.set(name, handler) }, ok = data => data;
  registerReleaseTools(server, { ok, guarded: fn => fn, bindPlan, verifyPlan, stableToken, workspaceRoot: async () => root, safeWorkspacePath, writeAtomicSet: async () => {}, exportFilters, rew: async () => { throw new Error("offline"); } });
  const discovered = await handlers.get("rew_install_discover")({}); assert.equal(discovered.found, true); assert.equal(discovered.selected.path, await realpath(executable));
  const plan = await handlers.get("rew_launch_plan")({ startupTimeoutSeconds: 1 }); assert.equal(plan.kind, "rew-launch"); assert.equal(plan.alreadyRunning, false);
  await assert.rejects(handlers.get("rew_launch_execute")({ plan, confirmationToken: plan.confirmationToken, confirm: false }), /confirmation required/);
});

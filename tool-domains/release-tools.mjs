import { z } from "zod";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createJobStore } from "../lib/jobs.mjs";
import { createCalibrationArtifact, migrateCalibrationArtifact, sanitizeSupportData, validateCalibrationArtifact } from "../lib/calibration-artifact.mjs";
import { applyDspTarget, dspAdapterCapabilities, inspectDspTarget } from "../lib/dsp-adapters.mjs";
import { audioDoctor } from "../lib/diagnostics.mjs";
import { discoverRewInstall, launchRew } from "../lib/rew-launcher.mjs";

export const analysisJobs = createJobStore();

const filterSchema = z.object({ type: z.literal("PK"), frequencyHz: z.number().positive(), gainDb: z.number().min(-24).max(12), q: z.number().positive().max(30), evidence: z.record(z.any()).optional() });

export function registerReleaseTools(server, deps) {
  const { ok, guarded, bindPlan, verifyPlan, stableToken, workspaceRoot, safeWorkspacePath, writeAtomicSet, exportFilters, rew } = deps;

  server.tool("audio_job_status", "Poll an asynchronous analysis job without holding an MCP request open.", { jobId: z.string().uuid(), includeResult: z.boolean().default(true) }, guarded(async ({ jobId, includeResult }) => ok(analysisJobs.status(jobId, includeResult))));
  server.tool("audio_job_cancel", "Cancel or suppress the result of an asynchronous analysis job.", { jobId: z.string().uuid(), confirm: z.boolean().default(false) }, guarded(async ({ jobId, confirm }) => { if (!confirm) throw new Error("Explicit cancellation confirmation required"); return ok(analysisJobs.cancel(jobId)); }));

  server.tool("audio_doctor", "Check Node, workspace, REW, host audio, JamesDSP, and configured DSP adapters without changing state.", { home: z.string().optional() }, guarded(async ({ home }) => {
    const root = await workspaceRoot(home);
    return ok(await audioDoctor({ root, rewProbe: async () => ({ measurements: await rew("/measurements", { timeoutMs: 3000 }), commands: await rew("/measure/commands", { timeoutMs: 3000 }) }), rewDiscovery: discoverRewInstall }));
  }));
  server.tool("rew_install_discover", "Find a local REW installation across Windows, macOS, and Linux. An explicit absolute executable path can be supplied when automatic discovery fails.", { executablePath: z.string().min(1).max(1000).optional() }, guarded(async ({ executablePath }) => {
    let api = null; try { api = { online: true, version: await rew("/version", { timeoutMs: 1200 }) }; } catch (error) { api = { online: false, error: String(error.message).slice(0, 240) }; }
    return ok({ api, ...(await discoverRewInstall({ explicitPath: executablePath })) });
  }));
  server.tool("rew_launch_plan", "Create a hash-bound plan to start REW when its local API is offline. Uses automatic discovery or an explicit user-supplied executable path.", { executablePath: z.string().min(1).max(1000).optional(), startupTimeoutSeconds: z.number().int().min(1).max(45).default(20) }, guarded(async ({ executablePath, startupTimeoutSeconds }) => {
    try {
      const version = await rew("/version", { timeoutMs: 1200 });
      return ok(bindPlan({ kind: "rew-launch", createdAt: new Date().toISOString(), alreadyRunning: true, version, timeoutMs: startupTimeoutSeconds * 1000 }));
    } catch {}
    const discovery = await discoverRewInstall({ explicitPath: executablePath });
    if (!discovery.selected) return ok({ planReady: false, ...discovery });
    return ok(bindPlan({ kind: "rew-launch", createdAt: new Date().toISOString(), alreadyRunning: false, candidate: discovery.selected, timeoutMs: startupTimeoutSeconds * 1000 }));
  }));
  server.tool("rew_launch_execute", "Start the exact discovered REW executable after explicit confirmation, then verify that the API becomes ready on port 4735.", { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) }, guarded(async ({ plan, confirmationToken, confirm }) => {
    const p = verifyPlan(plan, confirmationToken); if (p.kind !== "rew-launch") throw new Error("Wrong plan kind");
    if (p.alreadyRunning) return ok({ launched: false, alreadyRunning: true, apiReady: true, version: await rew("/version", { timeoutMs: 2000 }) });
    if (!confirm) throw new Error("Explicit confirmation required to start REW");
    return ok(await launchRew({ candidate: p.candidate, timeoutMs: p.timeoutMs, probe: () => rew("/version", { timeoutMs: 1200 }) }));
  }));
  server.tool("rew_capability_negotiate", "Detect the live REW API/version and supported read-only command surfaces before a workflow uses them.", {}, guarded(async () => {
    const probes = [
      ["version", "/version"], ["measurements", "/measurements"], ["measurementCommands", "/measure/commands"],
      ["audioStatus", "/audio/status"], ["generator", "/generator/commands"], ["rta", "/rta/commands"],
      ["splMeter", "/spl-meter/commands"], ["steppedMeasurement", "/stepped-measurement/commands"]
    ];
    const entries = await Promise.all(probes.map(async ([name, path]) => { try { const value = await rew(path, { timeoutMs: 3000 }); return [name, { available: true, shape: Array.isArray(value) ? "array" : typeof value, count: Array.isArray(value) ? value.length : undefined, version: name === "version" ? value : undefined }]; } catch (error) { return [name, { available: false, error: String(error.message).slice(0, 300) }]; } }));
    return ok({ schemaVersion: 1, negotiatedAt: new Date().toISOString(), capabilities: Object.fromEntries(entries), rule: "Only tools whose required capability is available should run." });
  }));

  server.tool("audio_artifact_validate", "Validate a versioned calibration artifact and report reproducibility gaps.", { artifact: z.record(z.any()) }, guarded(async ({ artifact }) => ok(validateCalibrationArtifact(artifact))));
  server.tool("audio_artifact_migrate", "Migrate a legacy calibration artifact to the current schema without writing files.", { artifact: z.record(z.any()) }, guarded(async ({ artifact }) => ok(migrateCalibrationArtifact(artifact))));
  server.tool("audio_artifact_create", "Create and validate a versioned, replayable calibration artifact from supplied evidence.", {
    session: z.record(z.any()), sweeps: z.array(z.record(z.any())).max(256).default([]), analyses: z.record(z.any()).default({}), filters: z.array(z.record(z.any())).max(80).default([]), verification: z.record(z.any()).nullable().optional(), provenance: z.record(z.any()).default({})
  }, guarded(async args => ok(createCalibrationArtifact(args))));
  server.tool("audio_session_replay_validate", "Validate whether a calibration artifact has enough immutable evidence for deterministic offline replay.", { artifact: z.record(z.any()) }, guarded(async ({ artifact }) => {
    const validation = validateCalibrationArtifact(artifact), missing = [];
    if (!artifact?.session?.algorithmVersion) missing.push("session.algorithmVersion");
    if (!artifact?.session?.targetId) missing.push("session.targetId");
    if (!artifact?.provenance?.softwareVersion) missing.push("provenance.softwareVersion");
    if (!artifact?.sweeps?.every(s => s.artifactHash || s.traceHash)) missing.push("sweep trace/artifact hashes");
    return ok({ replayable: validation.valid && missing.length === 0, validation, missing, stages: ["validate hashes", "reconstruct raw/light/perceptual views", "re-run deterministic analysis", "compare stored results"], hardwareRequired: false });
  }));

  server.tool("audio_support_bundle_plan", "Create a hash-bound plan for a redacted JSON support artifact; raw traces and identifying metadata are omitted.", {
    home: z.string().optional(), sourceFile: z.string().min(1).max(300), outputName: z.string().regex(/^[A-Za-z0-9._-]{1,80}\.support\.json$/)
  }, guarded(async ({ home, sourceFile, outputName }) => {
    const root = await workspaceRoot(home), sourcePath = await safeWorkspacePath(root, sourceFile, [".json"]), raw = await readFile(sourcePath, "utf8");
    if (Buffer.byteLength(raw) > 5_000_000) throw new Error("Source artifact exceeds the 5 MB support-bundle limit");
    const parsed = JSON.parse(raw), sanitized = sanitizeSupportData(parsed), outputPath = await safeWorkspacePath(root, join("support", outputName), [".json"]), content = JSON.stringify({ schemaVersion: 1, kind: "audio-calibration-support", createdAt: new Date().toISOString(), sourceHash: stableToken(raw), data: sanitized }, null, 2) + "\n";
    return ok(bindPlan({ kind: "support-bundle", createdAt: new Date().toISOString(), home, sourceFile, sourcePath, sourceHash: stableToken(raw), outputPath, content }));
  }));
  server.tool("audio_support_bundle_execute", "Write an exact redacted support artifact after rechecking its source hash.", { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) }, guarded(async ({ plan, confirmationToken, confirm }) => {
    if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "support-bundle") throw new Error("Wrong plan kind");
    const root = await workspaceRoot(p.home), sourcePath = await safeWorkspacePath(root, p.sourceFile, [".json"]), raw = await readFile(sourcePath, "utf8"); if (sourcePath !== p.sourcePath || stableToken(raw) !== p.sourceHash) throw new Error("Support source changed after planning");
    if (p.outputPath !== await safeWorkspacePath(root, relative(root, p.outputPath), [".json"])) throw new Error("Support output path changed");
    await mkdir(dirname(p.outputPath), { recursive: true }); await writeAtomicSet([[p.outputPath, p.content]], confirmationToken); return ok({ written: p.outputPath, contentHash: stableToken(p.content), reviewBeforeSharing: true });
  }));

  server.tool("audio_dsp_adapter_capabilities", "Inspect cross-platform DSP export/apply adapters and the explicit configuration needed for each.", {}, guarded(async () => ok(await dspAdapterCapabilities())));
  server.tool("audio_dsp_apply_plan", "Preview and hash-bind an exact Equalizer APO or dedicated CamillaDSP filter-file change.", { adapter: z.enum(["equalizer-apo", "camilladsp"]), filters: z.array(filterSchema).max(40) }, guarded(async ({ adapter, filters }) => {
    const target = await inspectDspTarget(adapter), content = exportFilters(filters, target.format);
    return ok(bindPlan({ kind: "dsp-adapter-apply", createdAt: new Date().toISOString(), adapter, target, filters, content, contentHash: stableToken(content) }));
  }));
  server.tool("audio_dsp_apply_execute", "Back up, apply, verify, and roll back an exact configured DSP filter-file plan.", { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) }, guarded(async ({ plan, confirmationToken, confirm }) => {
    if (!confirm) throw new Error("Explicit confirmation required"); const p = verifyPlan(plan, confirmationToken); if (p.kind !== "dsp-adapter-apply") throw new Error("Wrong plan kind"); if (stableToken(p.content) !== p.contentHash) throw new Error("DSP content hash mismatch");
    const root = await workspaceRoot(), backupRoot = await safeWorkspacePath(root, "backups", []);
    return ok(await applyDspTarget({ target: p.target, content: p.content, backupRoot, token: confirmationToken }));
  }));
}

import { z } from "zod";
import { analysisJobs } from "./release-tools.mjs";

export function registerAnalysisTools(server, deps) {
  const {
    ok, guarded, liveEntrySchema, fetchTraceBundle, traceBundleHash, issueEvidence, verifyEvidence, runAnalysisWorker, rew, measurementQuality, humanListeningAssessment,
    bindPlan, multiResolutionEqProposal, linkedStereoEqProposal, speakerProtectionAssessment,
    compressionMetrics, measuredBroadbandLevelDifference, measuredPostEqVerification
  } = deps;

  const verifiedInputs = async (entries, signedToken, kind) => {
    const evidence = verifyEvidence(signedToken, kind);
    if (evidence.accepted === false) throw new Error("Measurement quality evidence was rejected");
    if (!Array.isArray(evidence.entries) || evidence.entries.length !== entries.length) throw new Error("Evidence entry count mismatch");
    const byId = new Map(evidence.entries.map(entry => [String(entry.id), entry]));
    const trustedEntries = entries.map(entry => {
      const trusted = byId.get(String(entry.id));
      if (!trusted) throw new Error(`Measurement ${entry.id} is not bound to the supplied evidence`);
      for (const key of ["role", "controlFingerprint", "presetFingerprint", "microphoneCalibrationHash", "traceHash"]) if (entry[key] !== undefined && entry[key] !== trusted[key]) throw new Error(`Measurement ${entry.id} ${key} does not match protected evidence`);
      return { ...entry, ...trusted };
    });
    const traces = await Promise.all(trustedEntries.map(fetchTraceBundle));
    for (let i = 0; i < traces.length; i++) if (traceBundleHash(traces[i]) !== trustedEntries[i].traceHash) throw new Error(`Measurement ${trustedEntries[i].id} trace bytes changed after evidence capture`);
    return { evidence, entries: trustedEntries, traces };
  };

  server.tool("rew_measurement_quality", "Gate live REW traces on coverage, clipping, SNR, repeatability, route state, DSP state, and microphone-calibration identity.", {
    entries: z.array(liveEntrySchema).min(1).max(32), protectedEvidenceToken: z.string().min(40), lowHz: z.number().min(5).max(1000).default(20), highHz: z.number().min(1000).max(24000).default(20000), minSnrDb: z.number().min(5).max(60).default(15), requireSnr: z.boolean().default(true), requireMicrophoneCalibration: z.boolean().default(false), expectedTraceCount: z.number().int().positive().optional()
  }, guarded(async args => {
    const verified = await verifiedInputs(args.entries, args.protectedEvidenceToken, "protected-measurement-evidence"), controls = new Set(verified.entries.map(x => x.controlFingerprint)), presets = new Set(verified.entries.map(x => x.presetFingerprint)), microphones = new Set(verified.entries.map(x => x.microphoneCalibrationHash)), snrs = verified.entries.map(x => Number(x.snrDb)).filter(Number.isFinite), quality = measurementQuality(verified.traces, { ...args, snrDb: snrs.length ? Math.min(...snrs) : undefined, routeStable: controls.size === 1, dspStable: presets.size === 1, stateVerified: true, microphoneCalibrationHash: microphones.size === 1 ? [...microphones][0] : undefined });
    const fingerprintEvidence = { controlMatched: controls.size === 1, presetMatched: presets.size === 1, microphoneMatched: microphones.size === 1, sourcePlanHash: verified.evidence.sourcePlanHash };
    const evidenceArtifact = bindPlan({ kind: "measurement-quality-evidence", createdAt: new Date().toISOString(), inputIds: args.entries.map(entry => entry.id), accepted: quality.accepted, metrics: quality.metrics, reasons: quality.reasons, fingerprintEvidence });
    const qualityEvidenceToken = issueEvidence({ kind: "accepted-measurement-quality", accepted: quality.accepted, entries: verified.entries, metrics: quality.metrics, reasons: quality.reasons, sourcePlanHash: verified.evidence.sourcePlanHash });
    return ok({ ...quality, fingerprintEvidence, evidenceArtifact, qualityEvidenceToken });
  }));

  server.tool("rew_human_listening_assessment", "Start a cancellable asynchronous multidimensional listening assessment; poll audio_job_status for the result.", {
    entries: z.array(liveEntrySchema).min(1).max(32), qualityEvidenceToken: z.string().min(40), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), crossoverHz: z.number().min(20).max(500).optional(), minSnrDb: z.number().min(5).max(60).optional(), requireSnr: z.boolean().default(true), requireMicrophoneCalibration: z.boolean().default(false)
  }, guarded(async args => {
    const job = analysisJobs.submit("rew-human-listening-assessment", async context => {
      const verified = await verifiedInputs(args.entries, args.qualityEvidenceToken, "accepted-measurement-quality");
      context.throwIfCancelled(); context.progress(90, "Calculating listening dimensions"); return runAnalysisWorker("human-listening", { traces: verified.traces, args: { ...args, stateVerified: true, routeStable: true, dspStable: true, snrDb: Math.min(...verified.entries.map(x => Number(x.snrDb)).filter(Number.isFinite)) } }, { signal: context.signal });
    }, { entryCount: args.entries.length, deviceClass: args.deviceClass, targetId: args.targetId || null });
    return ok({ ...job, pollingTool: "audio_job_status", cancellationTool: "audio_job_cancel", resultInline: false });
  }));

  server.tool("audio_eq_design_plan", "Create a hash-bound, cut-only EQ proposal trained on stable traces and checked against withheld traces.", {
    entries: z.array(liveEntrySchema).min(1).max(32), qualityEvidenceToken: z.string().min(40), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), maxCutDb: z.number().min(0.5).max(12).default(6), maxFilters: z.number().int().min(1).max(20).default(10), validationCount: z.number().int().min(0).max(8).default(1), minCorrectionDb: z.number().min(0.5).max(6).default(1.25), maxSpatialSpreadDb: z.number().min(0.5).max(8).default(2.5), maxQ: z.number().min(0.5).max(12).default(4), minValidationImprovementDb: z.number().min(0.05).max(3).default(0.25), sampleRateHz: z.number().int().min(44100).max(192000).default(48000)
  }, guarded(async args => {
    const roles = new Set(args.entries.map(x => x.role || "unspecified")); if (roles.size > 1) throw new Error("Design one EQ plan per channel role; do not average different speakers into one filter set");
    const verified = await verifiedInputs(args.entries, args.qualityEvidenceToken, "accepted-measurement-quality"), minimal = verified.traces, raw = await Promise.all(verified.entries.map(async entry => { const id = encodeURIComponent(entry.id), candidate = await rew(`/measurements/${id}/frequency-response?smoothing=None`).catch(() => null), frequencyResponse = candidate?.smoothing === "None" ? candidate : await rew(`/measurements/${id}/frequency-response?ppo=96&smoothing=1%2F48`); return { ...entry, frequencyResponse }; })), proposal = multiResolutionEqProposal(raw, minimal, args);
    return ok(bindPlan({ kind: "audio-eq-design", createdAt: new Date().toISOString(), inputIds: args.entries.map(x => x.id), role: [...roles][0], proposal }));
  }));

  server.tool("audio_linked_stereo_eq_plan", "Create regularized per-channel EQ with linked filter centers and bounded left/right gain differences; each channel must pass held-out validation independently.", {
    leftEntries: z.array(liveEntrySchema).min(2).max(12), rightEntries: z.array(liveEntrySchema).min(2).max(12), leftQualityEvidenceToken: z.string().min(40), rightQualityEvidenceToken: z.string().min(40), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), maxCutDb: z.number().min(0.5).max(12).default(6), maxFilters: z.number().int().min(1).max(12).default(8), validationCount: z.number().int().min(1).max(4).default(1), minCorrectionDb: z.number().min(0.5).max(6).default(1.25), maxSpatialSpreadDb: z.number().min(0.5).max(8).default(2.5), maxQ: z.number().min(0.5).max(8).default(4), minValidationImprovementDb: z.number().min(0.05).max(3).default(0.25), regularization: z.number().min(0).max(1).default(0.75), maxInterchannelGainDeltaDb: z.number().min(0).max(3).default(1), sampleRateHz: z.number().int().min(44100).max(192000).default(48000)
  }, guarded(async args => {
    if (args.leftEntries.some(x => !/left/i.test(x.role || "")) || args.rightEntries.some(x => !/right/i.test(x.role || ""))) throw new Error("Entries must be explicitly labelled left and right");
    const fetchRaw = async entry => { const id = encodeURIComponent(entry.id), candidate = await rew(`/measurements/${id}/frequency-response?smoothing=None`).catch(() => null), frequencyResponse = candidate?.smoothing === "None" ? candidate : await rew(`/measurements/${id}/frequency-response?ppo=96&smoothing=1%2F48`); return { ...entry, frequencyResponse }; };
    const [leftVerified, rightVerified] = await Promise.all([verifiedInputs(args.leftEntries, args.leftQualityEvidenceToken, "accepted-measurement-quality"), verifiedInputs(args.rightEntries, args.rightQualityEvidenceToken, "accepted-measurement-quality")]);
    const [leftRaw, rightRaw] = await Promise.all([Promise.all(leftVerified.entries.map(fetchRaw)), Promise.all(rightVerified.entries.map(fetchRaw))]), left = leftVerified.traces, right = rightVerified.traces, leftProposal = multiResolutionEqProposal(leftRaw, left, args), rightProposal = multiResolutionEqProposal(rightRaw, right, args), proposal = linkedStereoEqProposal(left, right, { ...args, leftProposal, rightProposal, leftRawTraces: leftRaw, rightRawTraces: rightRaw });
    return ok(bindPlan({ kind: "linked-stereo-eq-design", createdAt: new Date().toISOString(), inputIds: { left: args.leftEntries.map(x => x.id), right: args.rightEntries.map(x => x.id) }, proposal }));
  }));

  server.tool("audio_speaker_protection_assessment", "Derive correction floor and permitted boost only from supplied capability, headroom, compression, and limiter evidence.", {
    measuredF3Hz: z.number().positive().optional(), manufacturerF3Hz: z.number().positive().optional(), minimumCorrectionHz: z.number().positive().optional(), continuousSplDb: z.number().optional(), measuredMaxCleanSplDb: z.number().optional(), headroomDb: z.number().optional(), maximumBoostDb: z.number().min(0).max(12).default(0), compressionDb: z.number().min(0).max(30).default(0), limiterObserved: z.boolean().default(false)
  }, guarded(async args => ok(speakerProtectionAssessment(args))));

  server.tool("rew_compression_analysis", "Analyze a matched REW sweep-level ladder for frequency-dependent output compression.", { entries: z.array(liveEntrySchema).min(2).max(12), levelsDbfs: z.array(z.number().min(-60).max(-3)).min(2).max(12) }, guarded(async ({ entries, levelsDbfs }) => { const traces = await Promise.all(entries.map(fetchTraceBundle)); return ok(compressionMetrics(traces, levelsDbfs)); }));

  server.tool("audio_post_eq_verification", "Accept or reject an EQ using separately measured before/after traces, matched state fingerprints, level match, quality gates, and repeatability.", {
    beforeEntries: z.array(liveEntrySchema).min(2).max(16), afterEntries: z.array(liveEntrySchema).min(2).max(16), beforeQualityEvidenceToken: z.string().min(40), afterQualityEvidenceToken: z.string().min(40), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), levelMatchLowHz: z.number().min(20).max(2000).default(500), levelMatchHighHz: z.number().min(1000).max(20000).default(8000), levelMatchToleranceDb: z.number().min(0.05).max(1).default(0.2), minimumTonalImprovementDb: z.number().min(0.05).max(3).default(0.25), maximumRepeatabilityRegressionDb: z.number().min(0).max(3).default(0.25), requireMicrophoneCalibration: z.boolean().default(false)
  }, guarded(async args => {
    const job = analysisJobs.submit("audio-post-eq-verification", async context => {
      const beforeVerified = await verifiedInputs(args.beforeEntries, args.beforeQualityEvidenceToken, "accepted-measurement-quality"), afterVerified = await verifiedInputs(args.afterEntries, args.afterQualityEvidenceToken, "accepted-measurement-quality"), beforeTraces = beforeVerified.traces, afterTraces = afterVerified.traces;
      const beforeControls = new Set(beforeVerified.entries.map(x => x.controlFingerprint)), afterControls = new Set(afterVerified.entries.map(x => x.controlFingerprint)), beforePresets = new Set(beforeVerified.entries.map(x => x.presetFingerprint)), afterPresets = new Set(afterVerified.entries.map(x => x.presetFingerprint));
      const controlsMatched = beforeControls.size === 1 && afterControls.size === 1 && [...beforeControls][0] === [...afterControls][0], presetChanged = beforePresets.size === 1 && afterPresets.size === 1 && [...beforePresets][0] !== [...afterPresets][0];
      const assessmentArgs = { deviceClass: args.deviceClass, targetId: args.targetId, lowHz: args.lowHz, highHz: args.highHz, microphoneCalibrationHash: beforeVerified.entries[0].microphoneCalibrationHash, requireMicrophoneCalibration: args.requireMicrophoneCalibration, requireSnr: true, routeStable: true, dspStable: true, stateVerified: true };
      context.throwIfCancelled(); context.progress(88, "Calculating measured level match and verification");
      const worked = await runAnalysisWorker("post-eq", { beforeTraces, afterTraces, assessmentArgs, levelRange: { lowHz: args.levelMatchLowHz, highHz: args.levelMatchHighHz }, verificationArgs: { minimumTonalImprovementDb: args.minimumTonalImprovementDb, maximumRepeatabilityRegressionDb: args.maximumRepeatabilityRegressionDb, stateMatched: controlsMatched && presetChanged, levelMatchToleranceDb: args.levelMatchToleranceDb } }, { signal: context.signal });
      return { ...worked.verification, before: worked.before, after: worked.after, measuredLevel: worked.measuredLevel, fingerprints: { controlsMatched, presetChanged }, boundary: "Fingerprints and trace hashes were verified from server-signed quality evidence. Level match is calculated from measured traces." };
    }, { beforeTraceCount: args.beforeEntries.length, afterTraceCount: args.afterEntries.length, deviceClass: args.deviceClass });
    return ok({ ...job, pollingTool: "audio_job_status", cancellationTool: "audio_job_cancel", resultInline: false });
  }));
}

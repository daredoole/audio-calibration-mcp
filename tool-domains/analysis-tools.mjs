import { z } from "zod";
import { analysisJobs } from "./release-tools.mjs";

export function registerAnalysisTools(server, deps) {
  const {
    ok, guarded, liveEntrySchema, fetchTraceBundle, rew, measurementQuality, humanListeningAssessment,
    bindPlan, multiResolutionEqProposal, linkedStereoEqProposal, speakerProtectionAssessment,
    compressionMetrics, measuredBroadbandLevelDifference, measuredPostEqVerification
  } = deps;

  server.tool("rew_measurement_quality", "Gate live REW traces on coverage, clipping, SNR, repeatability, route state, DSP state, and microphone-calibration identity.", {
    entries: z.array(liveEntrySchema).min(1).max(32), lowHz: z.number().min(5).max(1000).default(20), highHz: z.number().min(1000).max(24000).default(20000), snrDb: z.number().optional(), minSnrDb: z.number().min(5).max(60).default(15), requireSnr: z.boolean().default(true), routeStable: z.boolean().default(true), dspStable: z.boolean().default(true), stateVerified: z.boolean().default(false), expectedControlFingerprint: z.string().max(128).optional(), expectedPresetFingerprint: z.string().max(128).optional(), microphoneCalibrationHash: z.string().max(128).optional(), requireMicrophoneCalibration: z.boolean().default(false), expectedTraceCount: z.number().int().positive().optional()
  }, guarded(async args => {
    const controlMatched = !args.expectedControlFingerprint || args.entries.every(x => x.controlFingerprint === args.expectedControlFingerprint), presetMatched = !args.expectedPresetFingerprint || args.entries.every(x => x.presetFingerprint === args.expectedPresetFingerprint), traces = await Promise.all(args.entries.map(fetchTraceBundle)), quality = measurementQuality(traces, { ...args, routeStable: args.routeStable && controlMatched, dspStable: args.dspStable && presetMatched, stateVerified: args.stateVerified || Boolean(args.expectedControlFingerprint && args.expectedPresetFingerprint && controlMatched && presetMatched) });
    const fingerprintEvidence = { controlMatched, presetMatched, expectedControlFingerprint: args.expectedControlFingerprint || null, expectedPresetFingerprint: args.expectedPresetFingerprint || null };
    const evidenceArtifact = bindPlan({ kind: "measurement-quality-evidence", createdAt: new Date().toISOString(), inputIds: args.entries.map(entry => entry.id), accepted: quality.accepted, metrics: quality.metrics, reasons: quality.reasons, fingerprintEvidence });
    return ok({ ...quality, fingerprintEvidence, evidenceArtifact });
  }));

  server.tool("rew_human_listening_assessment", "Start a cancellable asynchronous multidimensional listening assessment; poll audio_job_status for the result.", {
    entries: z.array(liveEntrySchema).min(1).max(32), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), crossoverHz: z.number().min(20).max(500).optional(), snrDb: z.number().optional(), minSnrDb: z.number().min(5).max(60).optional(), requireSnr: z.boolean().default(true), routeStable: z.boolean().default(true), dspStable: z.boolean().default(true), stateVerified: z.boolean().default(false), microphoneCalibrationHash: z.string().max(128).optional(), requireMicrophoneCalibration: z.boolean().default(false)
  }, guarded(async args => {
    const job = analysisJobs.submit("rew-human-listening-assessment", async context => {
      const traces = [];
      for (const [index, entry] of args.entries.entries()) { context.throwIfCancelled(); traces.push(await fetchTraceBundle(entry, { signal: context.signal })); context.progress(5 + 80 * (index + 1) / args.entries.length, `Fetched ${index + 1}/${args.entries.length} trace bundles`); }
      context.throwIfCancelled(); context.progress(90, "Calculating listening dimensions"); return humanListeningAssessment(traces, args);
    }, { entryCount: args.entries.length, deviceClass: args.deviceClass, targetId: args.targetId || null });
    return ok({ ...job, pollingTool: "audio_job_status", cancellationTool: "audio_job_cancel", resultInline: false });
  }));

  server.tool("audio_eq_design_plan", "Create a hash-bound, cut-only EQ proposal trained on stable traces and checked against withheld traces.", {
    entries: z.array(liveEntrySchema).min(1).max(32), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), maxCutDb: z.number().min(0.5).max(12).default(6), maxFilters: z.number().int().min(1).max(20).default(10), validationCount: z.number().int().min(0).max(8).default(1), minCorrectionDb: z.number().min(0.5).max(6).default(1.25), maxSpatialSpreadDb: z.number().min(0.5).max(8).default(2.5), maxQ: z.number().min(0.5).max(12).default(4), minValidationImprovementDb: z.number().min(0.05).max(3).default(0.25), sampleRateHz: z.number().int().min(44100).max(192000).default(48000)
  }, guarded(async args => {
    const roles = new Set(args.entries.map(x => x.role || "unspecified")); if (roles.size > 1) throw new Error("Design one EQ plan per channel role; do not average different speakers into one filter set");
    const minimal = await Promise.all(args.entries.map(fetchTraceBundle)), raw = await Promise.all(args.entries.map(async entry => { const id = encodeURIComponent(entry.id), candidate = await rew(`/measurements/${id}/frequency-response?smoothing=None`).catch(() => null), frequencyResponse = candidate?.smoothing === "None" ? candidate : await rew(`/measurements/${id}/frequency-response?ppo=96&smoothing=1%2F48`); return { ...entry, frequencyResponse }; })), proposal = multiResolutionEqProposal(raw, minimal, args);
    return ok(bindPlan({ kind: "audio-eq-design", createdAt: new Date().toISOString(), inputIds: args.entries.map(x => x.id), role: [...roles][0], proposal }));
  }));

  server.tool("audio_linked_stereo_eq_plan", "Create regularized per-channel EQ with linked filter centers and bounded left/right gain differences; each channel must pass held-out validation independently.", {
    leftEntries: z.array(liveEntrySchema).min(2).max(12), rightEntries: z.array(liveEntrySchema).min(2).max(12), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), maxCutDb: z.number().min(0.5).max(12).default(6), maxFilters: z.number().int().min(1).max(12).default(8), validationCount: z.number().int().min(1).max(4).default(1), minCorrectionDb: z.number().min(0.5).max(6).default(1.25), maxSpatialSpreadDb: z.number().min(0.5).max(8).default(2.5), maxQ: z.number().min(0.5).max(8).default(4), minValidationImprovementDb: z.number().min(0.05).max(3).default(0.25), regularization: z.number().min(0).max(1).default(0.75), maxInterchannelGainDeltaDb: z.number().min(0).max(3).default(1), sampleRateHz: z.number().int().min(44100).max(192000).default(48000)
  }, guarded(async args => {
    if (args.leftEntries.some(x => !/left/i.test(x.role || "")) || args.rightEntries.some(x => !/right/i.test(x.role || ""))) throw new Error("Entries must be explicitly labelled left and right");
    const fetchRaw = async entry => { const id = encodeURIComponent(entry.id), candidate = await rew(`/measurements/${id}/frequency-response?smoothing=None`).catch(() => null), frequencyResponse = candidate?.smoothing === "None" ? candidate : await rew(`/measurements/${id}/frequency-response?ppo=96&smoothing=1%2F48`); return { ...entry, frequencyResponse }; };
    const [left, right, leftRaw, rightRaw] = await Promise.all([Promise.all(args.leftEntries.map(fetchTraceBundle)), Promise.all(args.rightEntries.map(fetchTraceBundle)), Promise.all(args.leftEntries.map(fetchRaw)), Promise.all(args.rightEntries.map(fetchRaw))]), leftProposal = multiResolutionEqProposal(leftRaw, left, args), rightProposal = multiResolutionEqProposal(rightRaw, right, args), proposal = linkedStereoEqProposal(left, right, { ...args, leftProposal, rightProposal, leftRawTraces: leftRaw, rightRawTraces: rightRaw });
    return ok(bindPlan({ kind: "linked-stereo-eq-design", createdAt: new Date().toISOString(), inputIds: { left: args.leftEntries.map(x => x.id), right: args.rightEntries.map(x => x.id) }, proposal }));
  }));

  server.tool("audio_speaker_protection_assessment", "Derive correction floor and permitted boost only from supplied capability, headroom, compression, and limiter evidence.", {
    measuredF3Hz: z.number().positive().optional(), manufacturerF3Hz: z.number().positive().optional(), minimumCorrectionHz: z.number().positive().optional(), continuousSplDb: z.number().optional(), measuredMaxCleanSplDb: z.number().optional(), headroomDb: z.number().optional(), maximumBoostDb: z.number().min(0).max(12).default(0), compressionDb: z.number().min(0).max(30).default(0), limiterObserved: z.boolean().default(false)
  }, guarded(async args => ok(speakerProtectionAssessment(args))));

  server.tool("rew_compression_analysis", "Analyze a matched REW sweep-level ladder for frequency-dependent output compression.", { entries: z.array(liveEntrySchema).min(2).max(12), levelsDbfs: z.array(z.number().min(-60).max(-3)).min(2).max(12) }, guarded(async ({ entries, levelsDbfs }) => { const traces = await Promise.all(entries.map(fetchTraceBundle)); return ok(compressionMetrics(traces, levelsDbfs)); }));

  server.tool("audio_post_eq_verification", "Accept or reject an EQ using separately measured before/after traces, matched state fingerprints, level match, quality gates, and repeatability.", {
    beforeEntries: z.array(liveEntrySchema).min(2).max(16), afterEntries: z.array(liveEntrySchema).min(2).max(16), deviceClass: z.enum(["general", "car", "laptop"]), targetId: z.string().optional(), lowHz: z.number().min(5).max(1000).optional(), highHz: z.number().min(1000).max(24000).optional(), levelMatchLowHz: z.number().min(20).max(2000).default(500), levelMatchHighHz: z.number().min(1000).max(20000).default(8000), beforeControlFingerprint: z.string().min(8).max(128), afterControlFingerprint: z.string().min(8).max(128), beforePresetFingerprint: z.string().min(8).max(128), afterPresetFingerprint: z.string().min(8).max(128), levelMatchToleranceDb: z.number().min(0.05).max(1).default(0.2), minimumTonalImprovementDb: z.number().min(0.05).max(3).default(0.25), maximumRepeatabilityRegressionDb: z.number().min(0).max(3).default(0.25), microphoneCalibrationHash: z.string().max(128).optional(), requireMicrophoneCalibration: z.boolean().default(false)
  }, guarded(async args => {
    const job = analysisJobs.submit("audio-post-eq-verification", async context => {
      const fetchGroup = async (entries, label, start, span) => {
        const traces = [];
        for (const [index, entry] of entries.entries()) {
          context.throwIfCancelled();
          traces.push(await fetchTraceBundle(entry, { signal: context.signal, optionalMetrics: false }));
          context.progress(start + span * (index + 1) / entries.length, `Fetched ${label} trace ${index + 1}/${entries.length}`);
        }
        return traces;
      };
      const beforeTraces = await fetchGroup(args.beforeEntries, "before", 5, 38), afterTraces = await fetchGroup(args.afterEntries, "after", 45, 38);
      const assessmentArgs = { deviceClass: args.deviceClass, targetId: args.targetId, lowHz: args.lowHz, highHz: args.highHz, microphoneCalibrationHash: args.microphoneCalibrationHash, requireMicrophoneCalibration: args.requireMicrophoneCalibration, requireSnr: true, routeStable: true, dspStable: true, stateVerified: true };
      context.throwIfCancelled(); context.progress(88, "Calculating measured level match and verification");
      const before = humanListeningAssessment(beforeTraces, assessmentArgs), after = humanListeningAssessment(afterTraces, assessmentArgs), measuredLevel = measuredBroadbandLevelDifference(beforeTraces, afterTraces, { lowHz: args.levelMatchLowHz, highHz: args.levelMatchHighHz }), verification = measuredPostEqVerification(before, after, { minimumTonalImprovementDb: args.minimumTonalImprovementDb, maximumRepeatabilityRegressionDb: args.maximumRepeatabilityRegressionDb, stateMatched: args.beforeControlFingerprint === args.afterControlFingerprint && args.beforePresetFingerprint !== args.afterPresetFingerprint, measuredLevelDifferenceDb: measuredLevel.differenceDb, levelMatchToleranceDb: args.levelMatchToleranceDb });
      return { ...verification, before, after, measuredLevel, fingerprints: { controlsMatched: args.beforeControlFingerprint === args.afterControlFingerprint, presetChanged: args.beforePresetFingerprint !== args.afterPresetFingerprint }, boundary: "Control fingerprints represent the same route, microphone, geometry, and sweep settings. Level match is calculated from the measured traces; preset fingerprints document the intentional DSP difference." };
    }, { beforeTraceCount: args.beforeEntries.length, afterTraceCount: args.afterEntries.length, deviceClass: args.deviceClass });
    return ok({ ...job, pollingTool: "audio_job_status", cancellationTool: "audio_job_cancel", resultInline: false });
  }));
}

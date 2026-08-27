import { parentPort, workerData } from "node:worker_threads";
import { humanListeningAssessment } from "../human-listening.mjs";
import { engineeringTraceSummary, erbSmooth, frequencyDependentSmooth, measuredBroadbandLevelDifference, measuredPostEqVerification } from "../advanced-calibration.mjs";

function execute(kind, payload) {
  if (kind === "human-listening") return humanListeningAssessment(payload.traces, payload.args);
  if (kind === "dual-resolution") {
    const { source, minimal, rawUsable, args } = payload;
    return { measurementId: args.id, rawAvailable: Boolean(rawUsable), engineering: { ...engineeringTraceSummary(source, args), smoothing: rawUsable ? "None" : "1/48 fallback", spacing: rawUsable ? "native-linear" : "96-PPO logarithmic", derivedAnalysisGridPpo: rawUsable ? 192 : 96 }, minimallySmoothed: { ...engineeringTraceSummary(minimal, args), smoothing: "1/48", ppo: 96 }, adaptive: frequencyDependentSmooth(source, { lowHz: args.lowHz, highHz: args.highHz, modalBoundaryHz: args.modalBoundaryHz, transitionHz: args.smoothingTransitionHz, ppo: 24 }), perceptual: erbSmooth(source, args), rawTracePreservedInRew: true, use: { engineering: "phase, timing, resonances, narrow defects, and quality checks", adaptive: "modal-resolution below the boundary with progressively perceptual smoothing above it", perceptual: "broad tonal balance and audibility-oriented EQ decisions" } };
  }
  if (kind === "post-eq") {
    const { beforeTraces, afterTraces, assessmentArgs, verificationArgs, levelRange } = payload;
    const before = humanListeningAssessment(beforeTraces, assessmentArgs), after = humanListeningAssessment(afterTraces, assessmentArgs), measuredLevel = measuredBroadbandLevelDifference(beforeTraces, afterTraces, levelRange), verification = measuredPostEqVerification(before, after, { ...verificationArgs, measuredLevelDifferenceDb: measuredLevel.differenceDb });
    return { before, after, measuredLevel, verification };
  }
  throw new Error(`Unknown analysis worker task: ${kind}`);
}

try { parentPort.postMessage({ ok: true, result: execute(workerData.kind, workerData.payload) }); }
catch (error) { parentPort.postMessage({ ok: false, error: String(error?.message || error).slice(0, 2000) }); }

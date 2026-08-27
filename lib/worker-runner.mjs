import { Worker } from "node:worker_threads";

const maximumWorkers = Math.max(1, Math.min(4, Number.parseInt(process.env.AUDIO_ANALYSIS_WORKERS || "2", 10) || 2));
let active = 0;
const queue = [];

function drain() {
  while (active < maximumWorkers && queue.length) {
    const item = queue.shift();
    if (item.signal?.aborted) { item.reject(Object.assign(new Error("Analysis cancelled"), { code: "JOB_CANCELLED" })); continue; }
    active += 1;
    const worker = new Worker(new URL("./analysis-worker.mjs", import.meta.url), { workerData: { kind: item.kind, payload: item.payload } });
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; item.signal?.removeEventListener("abort", abort); active -= 1; fn(value); drain(); };
    const abort = () => { worker.terminate(); finish(item.reject, Object.assign(new Error("Analysis cancelled"), { code: "JOB_CANCELLED" })); };
    item.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", message => { worker.terminate(); message.ok ? finish(item.resolve, message.result) : finish(item.reject, new Error(message.error)); });
    worker.once("error", error => finish(item.reject, error));
    worker.once("exit", code => { if (!settled && code !== 0) finish(item.reject, new Error(`Analysis worker exited with code ${code}`)); });
  }
}

export function runAnalysisWorker(kind, payload, { signal } = {}) {
  return new Promise((resolve, reject) => { queue.push({ kind, payload, signal, resolve, reject }); drain(); });
}

export function workerPoolStatus() { return { active, queued: queue.length, maximumWorkers }; }

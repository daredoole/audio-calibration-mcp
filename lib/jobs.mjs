import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

export function createJobStore({ maxJobs = 32, ttlMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const jobs = new Map();
  const prune = () => {
    for (const [id, job] of jobs) if (TERMINAL.has(job.status) && now() - job.updatedAtMs > ttlMs) jobs.delete(id);
    while (jobs.size >= maxJobs) {
      const removable = [...jobs.values()].find(job => TERMINAL.has(job.status));
      if (!removable) throw new Error("Too many analysis jobs are active");
      jobs.delete(removable.id);
    }
  };
  const publicJob = (job, includeResult = false) => ({
    id: job.id, kind: job.kind, status: job.status, progress: job.progress,
    message: job.message, createdAt: job.createdAt, updatedAt: job.updatedAt,
    metadata: job.metadata, ...(includeResult && job.status === "complete" ? { result: job.result } : {}),
    ...(job.status === "failed" ? { error: job.error } : {})
  });
  const update = (job, patch) => {
    Object.assign(job, patch, { updatedAtMs: now(), updatedAt: new Date(now()).toISOString() });
  };
  const submit = (kind, task, metadata = {}) => {
    prune();
    const at = now(), job = {
      id: randomUUID(), kind, status: "queued", progress: 0, message: "Queued",
      createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
      createdAtMs: at, updatedAtMs: at, metadata, cancelled: false, result: undefined, error: undefined
    };
    job.controller = new AbortController();
    jobs.set(job.id, job);
    setImmediate(async () => {
      if (job.cancelled) return;
      update(job, { status: "running", progress: 1, message: "Analysis started" });
      const context = {
        signal: job.controller.signal,
        isCancelled: () => job.cancelled,
        throwIfCancelled: () => { if (job.cancelled) throw Object.assign(new Error("Job cancelled"), { code: "JOB_CANCELLED" }); },
        progress: (progress, message = job.message) => update(job, { progress: Math.max(1, Math.min(99, Math.round(progress))), message })
      };
      try {
        const result = await task(context);
        if (job.cancelled) return update(job, { status: "cancelled", progress: job.progress, message: "Cancelled", result: undefined });
        update(job, { status: "complete", progress: 100, message: "Complete", result });
      } catch (error) {
        if (job.cancelled || error?.code === "JOB_CANCELLED") update(job, { status: "cancelled", message: "Cancelled", result: undefined });
        else update(job, { status: "failed", message: "Failed", error: String(error?.message || error).slice(0, 1000), result: undefined });
      }
    });
    return publicJob(job);
  };
  const status = (id, includeResult = true) => {
    prune(); const job = jobs.get(id); if (!job) throw new Error("Unknown or expired job"); return publicJob(job, includeResult);
  };
  const cancel = id => {
    const job = jobs.get(id); if (!job) throw new Error("Unknown or expired job");
    if (TERMINAL.has(job.status)) return publicJob(job);
    job.cancelled = true;
    job.controller.abort();
    update(job, { status: "cancelled", message: "Cancellation requested", result: undefined });
    return publicJob(job);
  };
  return { submit, status, cancel, size: () => jobs.size };
}

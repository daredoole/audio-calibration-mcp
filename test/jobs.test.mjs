import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createJobStore } from "../lib/jobs.mjs";

const waitTerminal = async (store, id) => {
  for (let i = 0; i < 100; i++) { const job = store.status(id); if (["complete", "failed", "cancelled"].includes(job.status)) return job; await delay(5); }
  throw new Error("job did not finish");
};

test("asynchronous jobs return results without holding the caller", async () => {
  const store = createJobStore();
  const submitted = store.submit("analysis", async context => { context.progress(50, "half"); await delay(5); return { answer: 42 }; });
  assert.match(submitted.id, /^[0-9a-f-]{36}$/); assert.ok(["queued", "running"].includes(submitted.status));
  const complete = await waitTerminal(store, submitted.id); assert.equal(complete.status, "complete"); assert.deepEqual(complete.result, { answer: 42 });
});

test("jobs can be cancelled and failures expose bounded messages", async () => {
  const store = createJobStore();
  let releaseStarted, signalAborted = false; const started = new Promise(resolve => { releaseStarted = resolve; });
  const cancellable = store.submit("slow", async context => { releaseStarted(); await new Promise((resolve, reject) => { context.signal.addEventListener("abort", () => { signalAborted = true; reject(Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" })); }, { once: true }); }); return true; });
  await started;
  assert.equal(store.cancel(cancellable.id).status, "cancelled"); assert.equal((await waitTerminal(store, cancellable.id)).status, "cancelled");
  assert.equal(signalAborted, true);
  const failed = store.submit("bad", async () => { throw new Error("x".repeat(2000)); });
  const result = await waitTerminal(store, failed.id); assert.equal(result.status, "failed"); assert.equal(result.error.length, 1000);
});

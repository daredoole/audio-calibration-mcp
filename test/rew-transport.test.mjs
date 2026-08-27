import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

test("REW transport bounds concurrency and aborts queued work", async () => {
  let active = 0;
  let maximumActive = 0;
  const server = createServer((_request, response) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    setTimeout(() => {
      active -= 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    }, 35);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const priorUrl = process.env.AUDIO_REW_URL;
  const priorConcurrency = process.env.AUDIO_REW_MAX_CONCURRENCY;
  process.env.AUDIO_REW_URL = `http://127.0.0.1:${address.port}`;
  process.env.AUDIO_REW_MAX_CONCURRENCY = "2";
  try {
    const { rew } = await import(`../core.mjs?transport-test=${Date.now()}`);
    await Promise.all(Array.from({ length: 6 }, (_, index) => rew(`/measurement/${index}`)));
    assert.equal(maximumActive, 2);

    const blockerA = rew("/slow-a");
    const blockerB = rew("/slow-b");
    const controller = new AbortController();
    const queued = rew("/cancelled", { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, error => error.code === "REW_CANCELLED");
    await Promise.all([blockerA, blockerB]);
  } finally {
    if (priorUrl === undefined) delete process.env.AUDIO_REW_URL; else process.env.AUDIO_REW_URL = priorUrl;
    if (priorConcurrency === undefined) delete process.env.AUDIO_REW_MAX_CONCURRENCY; else process.env.AUDIO_REW_MAX_CONCURRENCY = priorConcurrency;
    server.close();
    await once(server, "close");
  }
});

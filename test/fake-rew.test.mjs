import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("fake REW handles JSON, corrupt payloads, timeout, bounded responses, and reconnect", async t => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ready: true })); }
    if (req.url === "/corrupt") return res.end("{not-json");
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 250);
    if (req.url === "/oversized") { res.setHeader("content-length", String(70 * 1024 * 1024)); return res.end("too large"); }
    if (req.url === "/disconnect") return req.socket.destroy();
    res.statusCode = 404; res.end("missing");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  process.env.AUDIO_REW_URL = `http://127.0.0.1:${server.address().port}`;
  const { rew } = await import(`../core.mjs?fake=${Date.now()}`);
  assert.deepEqual(await rew("/ok"), { ready: true });
  assert.equal(await rew("/corrupt"), "{not-json");
  await assert.rejects(rew("/slow", { timeoutMs: 30 }), /abort|timeout/i);
  await assert.rejects(rew("/oversized"), /64 MB limit/);
  await assert.rejects(rew("/disconnect"), /fetch|socket|other side/i);
  assert.deepEqual(await rew("/ok"), { ready: true });
  await assert.rejects(rew("/missing"), /404/);
});

test("fake REW accepts POST JSON and reports server failures without leaking unbounded bodies", async t => {
  let posted = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/command" && req.method === "POST") { let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => { posted = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ accepted: true })); }); return; }
    res.statusCode = 500; res.end("x".repeat(2000));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); process.env.AUDIO_REW_URL = `http://127.0.0.1:${server.address().port}`;
  const { rew } = await import(`../core.mjs?post=${Date.now()}`);
  assert.deepEqual(await rew("/command", { method: "POST", body: { command: "safe" } }), { accepted: true }); assert.deepEqual(posted, { command: "safe" });
  await assert.rejects(rew("/failure"), error => error.message.length < 400 && /500/.test(error.message));
});

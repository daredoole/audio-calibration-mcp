import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("plugin manifest and MCP launch target are coherent", async () => {
  const plugin = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url)));
  const mcp = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url)));
  assert.equal(plugin.name, "audio-calibration"); assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcpServers["audio-calibration"].args[0], "./dist/server.mjs");
});

test("server module imports without starting stdio in test mode", async () => {
  process.env.NODE_ENV = "test"; const mod = await import(`../server.mjs?test=${Date.now()}`); assert.ok(mod.server);
});

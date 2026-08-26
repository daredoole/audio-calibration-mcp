import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("plugin manifest and MCP launch target are coherent", async () => {
  const plugin = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url)));
  const mcp = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url)));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(plugin.name, "audio-calibration"); assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcpServers["audio-calibration"].args[0], "./dist/server.mjs");
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.bin["audio-calibration"], "./dist/cli.cjs");
  assert.ok(Object.values(pkg.devDependencies).every(version => /^\d+\.\d+\.\d+$/.test(version)));
  assert.ok(pkg.description.includes("Room EQ Wizard"));
  assert.ok(["model-context-protocol", "room-eq-wizard", "audio-calibration"].every(keyword => pkg.keywords.includes(keyword)));
  assert.equal(pkg.funding.url, "https://buymeacoffee.com/daredoole");
  assert.ok(plugin.interface.longDescription.includes(pkg.funding.url));
});

test("README introduces the project with searchable product names and no hype", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const introduction = readme.slice(0, 900);
  assert.match(introduction, /Model Context Protocol/);
  assert.match(introduction, /Room EQ Wizard \(REW\)/);
  assert.doesNotMatch(introduction, /\b(best|magic|revolutionary|world[- ]class|industry[- ]leading)\b/i);
});

test("server module imports without starting stdio in test mode", async () => {
  process.env.NODE_ENV = "test"; const mod = await import(`../server.mjs?test=${Date.now()}`); assert.ok(mod.server);
});

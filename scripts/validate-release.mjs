#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const requiredMetadata = ["license", "repository", "bugs", "homepage", "files"];
const requiredFiles = [
  "dist/server.mjs", "dist/cli.cjs", ".mcp.json", ".codex-plugin/plugin.json", "LICENSE",
  "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"
];

const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const key of requiredMetadata) if (!pkg[key]) throw new Error(`package.json missing ${key}`);
for (const file of requiredFiles) await access(file);

const plugin = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
if (plugin.mcpServers !== "./.mcp.json") throw new Error("Plugin MCP path mismatch");
if (mcp.mcpServers?.["audio-calibration"]?.args?.[0] !== "./dist/server.mjs") throw new Error("MCP launch target mismatch");
if (pkg.bin?.["audio-calibration"] !== "./dist/cli.cjs") throw new Error("CLI launch target must use the bundled artifact");
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error("Published package must not install runtime dependencies");
if (!plugin.version.startsWith(pkg.version)) throw new Error("Plugin and package versions differ");

const child = spawn(process.execPath, [resolve("dist/server.mjs")], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "", stderr = ""; const pending = new Map();
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
child.stdout.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const split = buffer.indexOf("\n"), line = buffer.slice(0, split).trim(); buffer = buffer.slice(split + 1); if (!line) continue;
    let message; try { message = JSON.parse(line); } catch { for (const { reject } of pending.values()) reject(new Error(`Non-JSON stdout from MCP: ${line.slice(0, 200)}`)); pending.clear(); continue; }
    if (message.id !== undefined && pending.has(message.id)) { const waiter = pending.get(message.id); pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
  }
});
const send = (message, wait = true) => {
  child.stdin.write(JSON.stringify(message) + "\n"); if (!wait) return Promise.resolve();
  return new Promise((resolveRequest, reject) => { const timer = setTimeout(() => { pending.delete(message.id); reject(new Error(`MCP request ${message.id} timed out; stderr: ${stderr.slice(0, 500)}`)); }, 5000); pending.set(message.id, { resolve: value => { clearTimeout(timer); resolveRequest(value); }, reject: error => { clearTimeout(timer); reject(error); } }); });
};
try {
  const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-validator", version: pkg.version } } });
  if (!initialized?.serverInfo?.name || !initialized?.capabilities?.tools) throw new Error("MCP initialize response is incomplete");
  await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
  const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); if (!Array.isArray(listed?.tools) || listed.tools.length < 60) throw new Error("Bundled MCP tool list is incomplete");
} finally { child.kill(); }

console.log(`release validation passed for ${pkg.name}@${pkg.version}`);

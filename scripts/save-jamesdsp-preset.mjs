#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

if (!process.argv.includes("--confirmed")) throw new Error("Pass --confirmed only after explicit preset-save confirmation");
const presetName = process.argv.find(x => x.startsWith("--name="))?.slice(7);
if (!presetName) throw new Error("Pass --name=<preset name>");
const workspace = resolve(new URL("../../..", import.meta.url).pathname);
const server = resolve(new URL("../dist/server.mjs", import.meta.url).pathname);
const transport = new StdioClientTransport({ command: "node", args: [server], env: { ...process.env, AUDIO_CALIBRATION_HOME: workspace } });
const client = new Client({ name: "save-jamesdsp-preset", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content[0].text);
  if (result.isError || body.error) throw new Error(`${name}: ${body.error || "failed"}`);
  return body;
};
try {
  const plan = await call("jamesdsp_preset_plan", { action: "save", presetName, home: workspace });
  const result = await call("jamesdsp_preset_execute", { plan, confirmationToken: plan.confirmationToken, confirm: true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}

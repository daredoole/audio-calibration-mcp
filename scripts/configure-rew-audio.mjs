#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

if (!process.argv.includes("--confirmed")) throw new Error("Pass --confirmed only after explicit REW route confirmation");
const arg = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const requested = {
  driver: "Java",
  inputDevice: arg("input-device", "ZXQDRE [plughw:2,0]"),
  input: arg("input", "Mic (Mic)"),
  inputChannel: arg("input-channel", "1"),
  outputDevice: arg("output-device", "PCM: pipewire"),
  output: arg("output", "Default Output"),
  outputChannel: arg("output-channel", "L+R"),
  sampleRateHz: Number(arg("sample-rate", "48000"))
};
const workspace = resolve(new URL("../../..", import.meta.url).pathname);
const server = resolve(new URL("../dist/server.mjs", import.meta.url).pathname);
const transport = new StdioClientTransport({ command: "node", args: [server], env: { ...process.env, AUDIO_CALIBRATION_HOME: workspace } });
const client = new Client({ name: "configure-rew-audio", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const body = JSON.parse(result.content[0].text);
  if (result.isError || body.error) throw new Error(`${name}: ${body.error || "failed"}`);
  return body;
};
try {
  const plan = await call("rew_audio_configure_plan", requested);
  const result = await call("rew_audio_configure_execute", { plan, confirmationToken: plan.confirmationToken, confirm: true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}

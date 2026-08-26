import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { hostInventory as directHostInventory } from "../core.mjs";

const transport = new StdioClientTransport({ command: "node", args: [resolve("dist/server.mjs")], env: { ...process.env, AUDIO_CALIBRATION_HOME: resolve("../..") } });
const client = new Client({ name: "audio-calibration-live-smoke", version: "1.0.0" }); await client.connect(transport);
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return JSON.parse(r.content[0].text); };
try {
  const listed = await client.listTools(), capabilities = await call("audio_capabilities"), host = await call("audio_host_inventory"), directHost = await directHostInventory(), rewProbe = await call("rew_probe"), rewAudio = rewProbe.error ? null : await call("rew_audio_inventory");
  const compactHost = x => ({ backendOnline: Boolean(x.backend), defaultSink: x.defaultSink, defaultSource: x.defaultSource, sinkLines: String(x.sinks || "").split("\n").filter(Boolean).length, sourceLines: String(x.sources || "").split("\n").filter(Boolean).length });
  console.log(JSON.stringify({ toolCount: listed.tools.length, platform: capabilities.platform, jamesDsp: capabilities.jamesDsp, host: compactHost(host), directHost: compactHost(directHost), rew: rewProbe, rewAudio: rewAudio && { driver: rewAudio.driver, inputDevice: rewAudio.inputDevice, input: rewAudio.input, outputDevice: rewAudio.outputDevice, output: rewAudio.output, inputChannel: rewAudio.inputChannel, outputChannel: rewAudio.outputChannel, sampleRate: rewAudio.sampleRate, inputCal: rewAudio.inputCal } }, null, 2));
} finally { await client.close(); }

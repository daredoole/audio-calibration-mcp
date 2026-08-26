#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (!process.argv.includes("--confirmed")) throw new Error("Pass --confirmed only after fresh audible-sweep confirmation");
const label = process.argv.find(x => x.startsWith("--label="))?.slice(8) || "Laptop Baseline";
const saveFile = process.argv.find(x => x.startsWith("--save="))?.slice(7) || "laptop-baseline.mdat";
const repetitions = Number(process.argv.find(x => x.startsWith("--repetitions="))?.slice(14) || 1);
const sweepLength = process.argv.find(x => x.startsWith("--length="))?.slice(9) || "256k";
const outputChannels = (process.argv.find(x => x.startsWith("--channels="))?.slice(11) || "L,R,L+R").split(",").map(x => x.trim()).filter(Boolean);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 8) throw new Error("--repetitions must be an integer from 1 to 8");
if (!["64k", "128k", "256k", "512k", "1M", "2M", "4M"].includes(sweepLength)) throw new Error("--length must be one of 64k, 128k, 256k, 512k, 1M, 2M, or 4M");
if (!outputChannels.length || outputChannels.some(x => !["L", "R", "L+R"].includes(x))) throw new Error("--channels must be a comma-separated subset of L,R,L+R");
const workspace = resolve(new URL("../../..", import.meta.url).pathname);
const transport = new StdioClientTransport({ command: "node", args: [resolve(new URL("../dist/server.mjs", import.meta.url).pathname)], env: { ...process.env, AUDIO_CALIBRATION_HOME: workspace } });
const client = new Client({ name: "protected-laptop-sweeps", version: "1.0.0" }); await client.connect(transport);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 1200000 }); const body = JSON.parse(r.content[0].text); if (r.isError || body.error) throw new Error(`${name}: ${body.error || "failed"}`); return body; };
try {
  const plan = await call("rew_measurement_plan", { deviceClass: "laptop", titlePrefix: label, outputChannels, startHz: 120, endHz: 20000, levelDbfs: -30, maxSplDb: 75, repetitions, sweepLength, timingReference: "None", saveFile });
  const sessionPath = join(workspace, "sessions", `${saveFile.replace(/\.mdat$/i, "")}-plan.json`); await mkdir(join(workspace, "sessions"), { recursive: true }); await writeFile(sessionPath, JSON.stringify(plan, null, 2) + "\n");
  const result = await call("rew_measurement_execute", { plan, confirmationToken: plan.confirmationToken, confirm: true, micPlaced: true, areaClear: true });
  console.log(JSON.stringify({ sessionPath, ...result }, null, 2));
} finally { await client.close(); }

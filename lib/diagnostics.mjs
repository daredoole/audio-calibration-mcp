import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { REW_BASE, audioSnapshot, hostInventory, jamesDspStatus } from "../core.mjs";
import { dspAdapterCapabilities } from "./dsp-adapters.mjs";

const check = async (id, task, required = false) => {
  try { return { id, status: "pass", required, detail: await task() }; }
  catch (error) { return { id, status: required ? "fail" : "warn", required, detail: String(error?.message || error).slice(0, 500) }; }
};

export async function audioDoctor({ root, rewProbe, rewDiscovery = async () => ({ found: false, needsUserPath: true }) }) {
  const checks = await Promise.all([
    check("node", async () => ({ version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 20 }), true),
    check("workspace", async () => { await access(root, constants.R_OK | constants.W_OK); return { root, readable: true, writable: true }; }, true),
    check("rew", rewProbe, true),
    check("rew-install", rewDiscovery, false),
    check("rew-audio", audioSnapshot, false),
    check("host-audio", hostInventory, false),
    check("jamesdsp", jamesDspStatus, false),
    check("dsp-adapters", dspAdapterCapabilities, false)
  ]);
  return {
    schemaVersion: 1, platform: process.platform, arch: process.arch, node: process.version, rewUrl: REW_BASE,
    status: checks.some(x => x.status === "fail") ? "not-ready" : checks.some(x => x.status === "warn") ? "ready-with-warnings" : "ready",
    checks,
    nextActions: checks.filter(x => x.status !== "pass").map(x => ({ check: x.id, action: x.required ? "Resolve before measurement" : "Review if this integration is needed" }))
  };
}

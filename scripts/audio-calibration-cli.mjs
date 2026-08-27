#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";

const aliases = {
  capabilities: "audio_capabilities", host: "audio_host_inventory", workspace: "audio_workspace_scan", rew: "rew_probe", "rew-audio": "rew_audio_inventory", jamesdsp: "jamesdsp_status",
  targets: "audio_target_registry", evidence: "audio_evidence_registry", guided: "audio_guided_session_plan", session: "audio_session_status", "session-next": "audio_session_advance_plan", quality: "rew_measurement_quality", assess: "rew_human_listening_assessment",
  "repeat-plan": "rew_repeated_session_plan", "ladder-plan": "rew_level_ladder_plan", "dual-analysis": "rew_dual_resolution_analysis", "direct-late": "rew_direct_late_analysis",
  "eq-design": "audio_eq_design_plan", "stereo-eq": "audio_linked_stereo_eq_plan", protection: "audio_speaker_protection_assessment", verify: "audio_post_eq_verification", compression: "rew_compression_analysis", diagnostics: "rew_diagnostic_capabilities", "listen-plan": "audio_listening_test_plan", "report-plan": "audio_report_plan", "filter-plan": "audio_filter_export_plan", "jamesdsp-ab-plan": "jamesdsp_ab_plan", "jamesdsp-ab-present": "jamesdsp_ab_present_execute", "jamesdsp-ab-restore": "jamesdsp_ab_restore_execute",
  doctor: "audio_doctor", "rew-capabilities": "rew_capability_negotiate", job: "audio_job_status", "job-cancel": "audio_job_cancel", "artifact-validate": "audio_artifact_validate", "artifact-migrate": "audio_artifact_migrate", "artifact-create": "audio_artifact_create", "replay-validate": "audio_session_replay_validate", "support-plan": "audio_support_bundle_plan", "support-write": "audio_support_bundle_execute", adapters: "audio_dsp_adapter_capabilities", "adapter-plan": "audio_dsp_apply_plan", "adapter-apply": "audio_dsp_apply_execute"
};
const [command = "help", json = "{}"] = process.argv.slice(2);
if (command === "help") { console.log(`Usage: audio-calibration <${Object.keys(aliases).sort().join("|")}|tool-name> ['{"arg":"value"}']`); process.exit(0); }
let args; try { args = JSON.parse(json); } catch { console.error("Arguments must be a JSON object"); process.exit(2); }
async function main() {
  const cliDir = dirname(resolve(process.argv[1])), serverPath = resolve(cliDir, "server.mjs"), defaultWorkspace = resolve(cliDir, "../../..");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, AUDIO_CALIBRATION_HOME: process.env.AUDIO_CALIBRATION_HOME || defaultWorkspace } });
  const client = new Client({ name: "audio-calibration-cli", version: "0.1.0-beta.1" }); await client.connect(transport);
  try { const response = await client.callTool({ name: aliases[command] || command, arguments: args }); console.log(response.content?.[0]?.text || JSON.stringify(response)); if (response.isError) process.exitCode = 1; }
  finally { await client.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

test("bundled MCP lists the generic audio toolset", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "audio-cal-mcp-"));
  const transport = new StdioClientTransport({ command: "node", args: [resolve("dist/server.mjs")], env: { ...process.env, AUDIO_CALIBRATION_HOME: workspace } });
  const client = new Client({ name: "audio-calibration-test", version: "1.0.0" }); await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map(x => x.name);
    for (const expected of ["rew_measurement_plan", "rew_repeated_session_plan", "rew_level_ladder_plan", "rew_dual_resolution_analysis", "rew_direct_late_analysis", "rew_crossover_analysis", "rew_multiseat_analysis", "rew_measurement_quality", "rew_human_listening_assessment", "audio_eq_design_plan", "audio_linked_stereo_eq_plan", "audio_speaker_protection_assessment", "audio_post_eq_verification", "audio_guided_session_plan", "audio_session_advance_plan", "audio_evidence_registry", "audio_listening_test_plan", "audio_report_plan", "rew_diagnostic_plan", "jamesdsp_preset_plan", "speaker_profile_save", "audio_job_status", "audio_doctor", "rew_install_discover", "rew_launch_plan", "rew_launch_execute", "rew_capability_negotiate", "audio_artifact_validate", "audio_support_bundle_plan", "audio_dsp_apply_plan"]) assert.ok(names.includes(expected), expected);
    assert.ok(names.length >= 70);
    const caps = JSON.parse((await client.callTool({ name: "audio_capabilities", arguments: {} })).content[0].text);
    assert.equal(caps.deviceLimits.laptop.startHz, 120); assert.equal(caps.deviceLimits.laptop.maxBoostDb, 0);
    assert.deepEqual(caps.modes, ["guided", "expert"]); assert.equal(caps.targets.length, 3);
    const planned = JSON.parse((await client.callTool({ name: "audio_guided_session_plan", arguments: { name: "Test", deviceClass: "laptop" } })).content[0].text);
    const opened = JSON.parse((await client.callTool({ name: "audio_guided_session_execute", arguments: { plan: planned, confirmationToken: planned.confirmationToken, confirm: true } })).content[0].text);
    assert.equal(opened.session.currentStage, "inventory");
    const advance = JSON.parse((await client.callTool({ name: "audio_session_advance_plan", arguments: { sessionFile: opened.sessionFile, completedStage: "inventory", evidence: { accepted: true, summary: "Inventory captured", artifactRefs: [] } } })).content[0].text);
    const advanced = JSON.parse((await client.callTool({ name: "audio_session_advance_execute", arguments: { plan: advance, confirmationToken: advance.confirmationToken, confirm: true } })).content[0].text);
    assert.equal(advanced.currentStage, "route-and-dsp-snapshot"); assert.ok(advanced.nextTools.includes("jamesdsp_snapshot"));
    const validArtifact = { schemaVersion: 1, kind: "audio-calibration-session", createdAt: new Date().toISOString(), session: { id: "test", deviceClass: "laptop", algorithmVersion: "test", targetId: "nearfield" }, sweeps: [{ id: "1", fingerprints: { control: "control-1", preset: "preset-1", microphone: "microphone-1" }, traceHash: "trace-1" }], provenance: { softwareVersion: "test" } };
    const artifactResult = JSON.parse((await client.callTool({ name: "audio_artifact_validate", arguments: { artifact: validArtifact } })).content[0].text); assert.equal(artifactResult.valid, true);
    const replay = JSON.parse((await client.callTool({ name: "audio_session_replay_validate", arguments: { artifact: validArtifact } })).content[0].text); assert.equal(replay.replayable, true);
    const supportPlan = JSON.parse((await client.callTool({ name: "audio_support_bundle_plan", arguments: { sourceFile: opened.sessionFile, outputName: "test.support.json" } })).content[0].text);
    const support = JSON.parse((await client.callTool({ name: "audio_support_bundle_execute", arguments: { plan: supportPlan, confirmationToken: supportPlan.confirmationToken, confirm: true } })).content[0].text); assert.equal(support.reviewBeforeSharing, true);
    for (const tool of (await client.listTools()).tools.filter(x => x.name.endsWith("_execute"))) {
      const result = await client.callTool({ name: tool.name, arguments: { plan: {}, confirmationToken: "invalid", confirm: false } });
      assert.equal(result.isError, true, `${tool.name} must reject confirmation bypass`);
    }
  } finally { await client.close(); }
});

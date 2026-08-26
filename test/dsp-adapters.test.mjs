import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDspTarget, inspectDspTarget } from "../lib/dsp-adapters.mjs";

test("CamillaDSP dedicated-file adapter backs up, applies, and verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-dsp-")), targetPath = join(root, "filters.yaml"), backups = join(root, "backups");
  await writeFile(targetPath, "old: true\n"); process.env.AUDIO_CAMILLADSP_FILTER_PATH = targetPath;
  const target = await inspectDspTarget("camilladsp"), result = await applyDspTarget({ target, content: "new: true\n", backupRoot: backups, token: "a".repeat(64) });
  assert.equal(result.applied, true); assert.equal(await readFile(targetPath, "utf8"), "new: true\n"); assert.equal(await readFile(result.backup, "utf8"), "old: true\n");
});

test("DSP adapter refuses stale plans and symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-dsp-")), targetPath = join(root, "filters.yaml"), real = join(root, "real.yaml");
  await writeFile(targetPath, "one\n"); process.env.AUDIO_CAMILLADSP_FILTER_PATH = targetPath; const target = await inspectDspTarget("camilladsp"); await writeFile(targetPath, "two\n");
  await assert.rejects(applyDspTarget({ target, content: "three\n", backupRoot: join(root, "backups"), token: "b".repeat(64) }), /changed after planning/);
  await writeFile(real, "real\n"); const linked = join(root, "linked.yaml"); await symlink(real, linked); process.env.AUDIO_CAMILLADSP_FILTER_PATH = linked;
  await assert.rejects(inspectDspTarget("camilladsp"), /symlink/);
});

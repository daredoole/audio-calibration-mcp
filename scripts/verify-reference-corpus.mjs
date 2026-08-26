#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationCorpusManifest } from "../lib/listening-spatial.mjs";
import { readDatasetCatalog, validateDatasetCatalog } from "../lib/dataset-catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "reference"), manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
for (const section of ["synthetic", "external", "loopbacks", "crossTool"]) {
  for (const item of manifest[section] || []) {
    if (!/^[A-Za-z0-9._-]+$/.test(item.path)) throw new Error(`Unsafe corpus path: ${item.path}`);
    const actual = createHash("sha256").update(await readFile(join(root, item.path))).digest("hex");
    if (actual !== item.sha256) throw new Error(`Hash mismatch: ${item.id}`);
  }
}
const assessment = evaluationCorpusManifest(manifest);
if (!assessment.gates.everyLocalArtifactHasHash || !assessment.gates.everyExternalArtifactHasLicense) throw new Error("Corpus evidence gate failed");
const catalog = validateDatasetCatalog(await readDatasetCatalog()); if (!catalog.valid) throw new Error(`Dataset catalog failed: ${catalog.issues.join("; ")}`);
console.log(JSON.stringify({ verified: true, artifacts: Object.values(assessment.sections).flat().length, verifiedIndependentReferences: assessment.gates.verifiedIndependentReferenceCount, interLabReady: assessment.gates.interLabReady, catalogedRemoteDatasets: catalog.datasetCount }));

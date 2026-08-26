import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const catalogUrl = new URL("../fixtures/reference/catalog.json", import.meta.url);
const exists = path => access(path).then(() => true, () => false);

export async function readDatasetCatalog() {
  const catalog = JSON.parse(await readFile(catalogUrl, "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.datasets)) throw new Error("Unsupported dataset catalog schema");
  return catalog;
}

export function validateDatasetCatalog(catalog) {
  const issues = [], ids = new Set();
  for (const dataset of catalog.datasets || []) {
    if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(dataset.id || "")) issues.push(`${dataset.id || "unknown"}: invalid id`);
    if (ids.has(dataset.id)) issues.push(`${dataset.id}: duplicate id`); ids.add(dataset.id);
    if (!dataset.doi || !dataset.recordUrl || !dataset.license?.spdx || !dataset.license?.url) issues.push(`${dataset.id}: incomplete citation or license`);
    if (!dataset.independent || !dataset.institutions?.length) issues.push(`${dataset.id}: independence provenance incomplete`);
    const artifact = dataset.artifact || {};
    if (!/^[A-Za-z0-9._-]+$/.test(artifact.fileName || "")) issues.push(`${dataset.id}: unsafe artifact filename`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) issues.push(`${dataset.id}: invalid artifact size`);
    if (artifact.checksum?.algorithm !== "md5" || !/^[a-f0-9]{32}$/.test(artifact.checksum?.value || "")) issues.push(`${dataset.id}: invalid pinned checksum`);
    try { const url = new URL(artifact.url); if (url.protocol !== "https:" || url.hostname !== "zenodo.org") issues.push(`${dataset.id}: untrusted artifact host`); } catch { issues.push(`${dataset.id}: invalid artifact URL`); }
  }
  return { valid: issues.length === 0, issues, datasetCount: catalog.datasets?.length || 0, reviewedAt: catalog.reviewedAt || null };
}

export async function downloadDatasetArtifact({ artifact, outputPath, receiptPath, maximumBytes, timeoutMs = 300000, fetchImpl = fetch }) {
  if (await exists(outputPath) || await exists(receiptPath)) throw new Error("Refusing to overwrite an existing dataset or receipt");
  if (artifact.bytes > maximumBytes) throw new Error("Pinned artifact exceeds the confirmed maximum download size");
  const temporary = `${outputPath}.partial-${randomUUID()}`, controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const response = await fetchImpl(artifact.url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Dataset download failed with HTTP ${response.status}`);
    const finalUrl = new URL(response.url || artifact.url);
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "zenodo.org") throw new Error("Dataset download redirected to an untrusted host");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Server-declared dataset size exceeds the confirmed maximum");
    const md5 = createHash("md5"), sha256 = createHash("sha256"); let bytes = 0;
    const verifier = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > maximumBytes || bytes > artifact.bytes) return callback(new Error("Dataset exceeded its pinned size")); md5.update(chunk); sha256.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags: "wx" }));
    const upstreamChecksum = md5.digest("hex"), localSha256 = sha256.digest("hex");
    if (bytes !== artifact.bytes) throw new Error(`Dataset size mismatch: expected ${artifact.bytes}, received ${bytes}`);
    if (upstreamChecksum !== artifact.checksum.value) throw new Error("Dataset checksum mismatch");
    await link(temporary, outputPath); await unlink(temporary);
    const receipt = { schemaVersion: 1, downloadedAt: new Date().toISOString(), sourceUrl: artifact.url, finalUrl: finalUrl.href, bytes, upstreamChecksum: artifact.checksum, sha256: localSha256, fileName: artifact.fileName };
    try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }); } catch (error) { await unlink(outputPath).catch(() => {}); throw error; }
    return receipt;
  } finally { clearTimeout(timer); await unlink(temporary).catch(() => {}); }
}

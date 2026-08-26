import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadDatasetArtifact, readDatasetCatalog, validateDatasetCatalog } from "../lib/dataset-catalog.mjs";

test("curated dataset catalog pins licenses, institutions, sizes, and checksums", async () => {
  const catalog = await readDatasetCatalog(), validation = validateDatasetCatalog(catalog);
  assert.equal(validation.valid, true);
  assert.equal(validation.datasetCount, 4);
  assert.ok(catalog.datasets.every(item => item.independent && item.institutions.length && item.license.redistributable));
  assert.ok(catalog.datasets.some(item => item.domain === "sofa-brir"));
  assert.ok(catalog.datasets.filter(item => item.domain === "room-rir").length >= 2);
});

test("dataset download streams, enforces identity, and writes SHA-256 receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-dataset-")), body = Buffer.from("independent acoustic fixture"), md5 = createHash("md5").update(body).digest("hex"), artifact = { fileName: "fixture.bin", url: "https://zenodo.org/fixture.bin", bytes: body.length, checksum: { algorithm: "md5", value: md5 } }, outputPath = join(root, "fixture.bin"), receiptPath = join(root, "fixture.dataset.json"), fetchImpl = async url => new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  const receipt = await downloadDatasetArtifact({ artifact, outputPath, receiptPath, maximumBytes: body.length, fetchImpl });
  assert.deepEqual(await readFile(outputPath), body);
  assert.equal(receipt.sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).upstreamChecksum.value, md5);
  await assert.rejects(downloadDatasetArtifact({ artifact, outputPath, receiptPath, maximumBytes: body.length, fetchImpl }), /overwrite/);
});

test("dataset download rejects size and checksum drift without leaving artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-dataset-bad-")), body = Buffer.from("too much"), artifact = { fileName: "bad.bin", url: "https://zenodo.org/bad.bin", bytes: body.length, checksum: { algorithm: "md5", value: "0".repeat(32) } }, fetchImpl = async () => new Response(body, { status: 200 });
  await assert.rejects(downloadDatasetArtifact({ artifact, outputPath: join(root, "bad.bin"), receiptPath: join(root, "bad.json"), maximumBytes: body.length, fetchImpl }), /checksum mismatch/);
  await assert.rejects(downloadDatasetArtifact({ artifact, outputPath: join(root, "small.bin"), receiptPath: join(root, "small.json"), maximumBytes: body.length - 1, fetchImpl }), /exceeds/);
  assert.deepEqual(await readdir(root), []);
});

test("dataset download rejects redirects outside the pinned host", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-dataset-host-")), body = Buffer.from("untrusted"), artifact = { fileName: "host.bin", url: "https://zenodo.org/host.bin", bytes: body.length, checksum: { algorithm: "md5", value: createHash("md5").update(body).digest("hex") } };
  const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  const response = await fetchImpl(); Object.defineProperty(response, "url", { value: "https://evil.example/host.bin" });
  await assert.rejects(downloadDatasetArtifact({ artifact, outputPath: join(root, "host.bin"), receiptPath: join(root, "host.json"), maximumBytes: body.length, fetchImpl: async () => response }), /redirected to an untrusted host/);
  assert.deepEqual(await readdir(root), []);
});

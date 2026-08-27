import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createEvidenceAuthority({ key = randomBytes(32), now = () => Date.now(), ttlMs = 24 * 60 * 60_000 } = {}) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error("Evidence authority requires at least 256 bits of key material");
  const issue = payload => {
    const at = now(), envelope = { ...payload, issuedAt: new Date(at).toISOString(), expiresAt: new Date(at + ttlMs).toISOString() };
    const body = Buffer.from(JSON.stringify(envelope)).toString("base64url"), signature = createHmac("sha256", key).update(body).digest("base64url");
    return `${body}.${signature}`;
  };
  const verify = (signed, kind) => {
    if (typeof signed !== "string" || !signed.includes(".")) throw new Error("Protected evidence token is required");
    const [body, signature, extra] = signed.split(".");
    if (extra !== undefined) throw new Error("Malformed protected evidence token");
    const expected = createHmac("sha256", key).update(body).digest("base64url");
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Protected evidence signature mismatch");
    let payload; try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("Malformed protected evidence payload"); }
    if (payload.kind !== kind) throw new Error(`Expected ${kind} evidence`);
    if (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) < now()) throw new Error("Protected evidence token expired");
    return payload;
  };
  return { issue, verify };
}

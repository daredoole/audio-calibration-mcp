# Security policy

## Supported versions

Security fixes are provided for the latest beta or stable release. Pre-release
interfaces may change while preserving calibration-artifact migrations.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not attach
real measurement sessions, microphone files, host paths, IP/MAC addresses,
device serials, or DSP presets. Use `audio_support_bundle_plan` and its confirmed
executor to create a redacted diagnostic artifact.

## Security model

The MCP is local-first. REW defaults to `http://127.0.0.1:4735`. State-changing
operations require a hash-bound plan, explicit confirmation, a pre-change
snapshot or backup, and post-change verification. Files are constrained to the
AudioCalibration workspace unless an explicitly configured DSP adapter path is
used. Audible measurements add physical-readiness and clipping/SPL guards.

External dataset downloads are disabled until a hash-bound plan is explicitly
confirmed with license acknowledgement and a byte ceiling. The catalog pins HTTPS
Zenodo hosts, filenames, exact sizes, and checksums. Downloads never overwrite
existing files, are removed on verification failure, and receive a local SHA-256
provenance receipt. The catalog contains no credentials and downloads send none.

No telemetry is collected. Generated artifacts can still contain sensitive room,
route, device, and filesystem metadata; keep them private unless sanitized.

## npm and release supply chain

Release archives contain bundled server and CLI artifacts and declare zero runtime
npm dependencies, so installing the package does not fetch or execute transitive
dependency code. Build dependencies are exact-pinned by `package-lock.json`, clean
installs disable lifecycle scripts, CI verifies registry signatures and available
provenance attestations, and releases include an SBOM, SHA-256 checksums, and a
GitHub build-provenance attestation. GitHub vulnerability alerts, Dependabot security
updates, secret scanning with push protection, and immutable releases are enabled.

These controls reduce registry substitution and compromised-install-script risk;
they cannot guarantee that bundled code contains no undiscovered vulnerability.
Security advisories require a rebuilt, re-tested release and user upgrade.

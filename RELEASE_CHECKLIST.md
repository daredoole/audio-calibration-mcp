# Release checklist

## Automated gates

- [x] Cross-platform-safe Node test command
- [x] Linux, Windows, macOS, x64, and ARM64 CI matrix
- [x] Pinned GitHub Action commits and minimal workflow permissions
- [x] MCP initialize/tool-list clean-archive smoke test
- [x] 80% line/statement, 70% function, and 60% branch coverage gates
- [x] Fake REW corrupt/timeout/disconnect/size-limit tests
- [x] Path traversal, UNC/drive, symlink, hardlink, and parser fuzz tests
- [x] Confirmation-bypass, backup, stale-plan, verification, and rollback tests
- [x] Package dry-run, license/notices, SBOM, checksums, and build attestation
- [x] Zero-runtime-dependency package with bundled server and CLI
- [x] Scriptless clean install plus npm registry-signature/provenance verification
- [x] Vulnerability alerts, Dependabot security updates, and immutable releases
- [x] Plugin and skill validators
- [x] No raw measurements, sessions, backups, profiles, reports, or filters in git

## Maintainer checks before tagging

- [ ] Confirm the tag exactly matches `package.json` and the plugin base version.
- [ ] Confirm every CI job succeeds on GitHub-hosted runners.
- [ ] Download the Actions-produced archive and run `node scripts/validate-release.mjs`.
- [ ] Review release notes and retain the beta/known-limitations language.
- [ ] Review `THIRD_PARTY_NOTICES.md` after dependency changes.
- [ ] Test one opt-in real REW session on each materially changed audio backend.

## One-time GitHub repository settings

- [ ] Enable private vulnerability reporting and secret scanning.
- [ ] Protect `main`; require reviews and all CI/security checks.
- [ ] Enable Dependabot security updates and dependency graph.
- [ ] Restrict workflow token defaults to read-only.
- [ ] Require signed commits/tags if that matches the maintainer policy.
- [ ] Add repository topics, description, license detection, and support links.

These settings require the GitHub repository to exist and cannot be completed by
source changes alone.

# Changelog

## 0.2.0-beta.1 - 2026-08-27

- Bound protected measurement and quality evidence to actual trace and `.mdat` bytes using server-issued, expiring HMAC evidence tokens.
- Isolated expensive analysis in bounded, cancellable worker threads and added lifecycle-safe JamesDSP measurement identity checks.
- Added adversarial evidence, artifact, worker, network, and opt-in REW hardware-loop tests plus MCPB and official MCP Registry release metadata.
- This remains a prerelease until the opt-in hardware-in-loop matrix passes with calibrated loopback and representative REW hosts.

- Made post-EQ verification asynchronous and cancellable, bounded concurrent
  REW API traffic, propagated abort signals into active requests, and added a
  short-lived trace-bundle cache.
- Changed post-EQ acceptance to calculate level difference from the measured
  before/after traces instead of trusting a caller-supplied match claim.
- Made SNR evidence mandatory by default for measurement-quality acceptance and
  bound guided quality-stage advancement to the quality tool's evidence artifact.
- Added transactional, randomized, level-compensated JamesDSP A/B presentation
  with exact preset/runtime verification and host-volume restoration.
- Hardened JamesDSP key apply/rollback with exact value equality, runtime-sync
  checks, and detection/restoration of host-volume side effects.
- Added repeated-trace before/after report groups with 1/12-octave averaging,
  ±1 SD bands, standalone SVG output, and README-ready Markdown.
- Added cross-platform REW installation discovery, explicit executable-path
  fallback, hash-bound confirmed launch, and API startup verification.
- Added GUM-style linear, Monte Carlo, and bootstrap uncertainty analysis.
- Added coherence, phase-confidence, clock-drift, excitation, and harmonic-contamination quality gates.
- Added room, polar/output, held-out multi-source, FIR, controlled-listening, immersive/SOFA, and evaluation-corpus modules with explicit standards claim levels.
- Added a licensed independent-dataset catalog and confirmed, size-bounded, checksum-verified acquisition with provenance receipts and domain-specific readiness gates.
- Reordered user-facing workflows, targets, prompts, and documentation so general, room, and car calibration precede the laptop-specific workflow.
- Hardened the npm supply chain with zero runtime dependencies, bundled server/CLI artifacts, exact-pinned build inputs, scriptless installs, signature checks, current pinned Actions, immutable releases, and automated security alerts.
- Added focused GitHub, npm, and Codex discovery metadata using accurate product and workflow names, with regression checks against missing terms and hype claims.
- Added a simple calibration-bunny identity with listening ears and a frequency-response trace for GitHub, package, and Codex surfaces.
- Added GitHub's native sponsor button and a restrained Buy Me a Coffee link for optional project support.
- Exposed the same optional support link in Codex-facing plugin copy and standard npm funding metadata.

## 0.1.0-beta.1 — 2026-08-26

- Added guarded REW measurement and multidimensional listening analysis.
- Added repeated/held-out EQ validation and measured post-EQ verification.
- Added exact JamesDSP state/preset decoding with backup and rollback.
- Added cross-platform filter exports, versioned artifacts, diagnostics, and CI.
- Marked the first public release as beta pending broader hardware validation.

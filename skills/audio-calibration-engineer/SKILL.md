---
name: audio-calibration-engineer
description: Run guided or expert REW measurement, human-listening assessment, conservative cross-validated EQ, reporting, and optional JamesDSP workflows for general, powered-speaker, car, and laptop audio systems. Do not use for A1 Evo or Denon-specific calibration transfers.
---

# Audio Calibration Engineer

Use measured evidence and separate observations from interpretation. Never invent speaker specifications, microphone calibration, SPL accuracy, routing state, or expected improvement.

## Workflow

1. Start with `audio_doctor`. If the REW API is offline, call `rew_install_discover`; when no candidate is found, ask for an absolute executable path and pass it to `rew_launch_plan`. Start REW only through the matching confirmed `rew_launch_execute`, then run `rew_capability_negotiate`. Use `audio_guided_session_plan` for an end-to-end guided workflow; use individual tools in Expert mode. After each accepted guided stage, use `audio_session_advance_plan` and its confirmed executor so the session retains evidence, backups, and an explicit next-tool list. Inventory the host, REW, microphone calibration, output path, profiles, and existing measurements.
2. Identify the device class. Read [general-speakers.md](references/general-speakers.md), [car-audio.md](references/car-audio.md), or [laptop.md](references/laptop.md) as applicable.
3. Preserve the current route, REW configuration, measurement file, and DSP preset before changes.
4. Build a hash-bound plan. Immediately before audible output, obtain explicit confirmation that the microphone is placed, the area is clear, and the selected output is safe.
5. Begin at the class-specific conservative level and frequency range. Require clipping and SPL abort guards. Stop on unexpected routing, silence, clipping, overload, or device distress.
6. Save raw measurements before analysis. For reference work, use `rew_repeated_session_plan` so left, right, and combined outputs retain 4–6 separate traces and complete control/preset fingerprints. Run `rew_measurement_quality`; reject clipping, route/DSP drift, incomplete traces, poor repeatability, or inadequate SNR before interpreting sound.
7. Use `rew_dual_resolution_analysis`, `rew_direct_late_analysis`, and `rew_human_listening_assessment` for distinct engineering, perceptual, direct/late, tonal, channel-match, extension, crossover, decay, distortion/compression, timing, and confidence dimensions. The human-listening assessment is asynchronous: poll `audio_job_status`, and cancel with explicit confirmation through `audio_job_cancel`. Never synthesize dimensions into an unsupported universal sound-quality score.
8. For crossover changes, analyze magnitude and phase and verify with a measured combined trace. For output limits, use a protected level ladder and `rew_compression_analysis`.
9. Prefer placement, polarity, delay, crossover, and stable cut-first EQ. Use `audio_eq_design_plan` for one role or `audio_linked_stereo_eq_plan` for independently validated left/right evidence. Gate correction through `audio_speaker_protection_assessment`. Do not boost narrow/spatial nulls or claim a visually flat trace is optimal.
10. Apply only an exact confirmed DSP plan with backup and rollback, then re-measure at matched level. Use `audio_post_eq_verification`; predicted filter response alone never accepts a change. Export filters through a hash-bound export plan. Equalizer APO and CamillaDSP file adapters require explicit configured paths; other systems remain export-only until an adapter is proven.
11. Use `audio_listening_test_plan` for level-matched randomized A/B or ABX validation and `audio_report_plan` for the final evidence-labelled report.

Use [rew-safety.md](references/rew-safety.md) for all live measurements. Read [jamesdsp.md](references/jamesdsp.md) before any JamesDSP operation.
Read [human-listening.md](references/human-listening.md) before interpreting listening relevance, selecting a target, proposing EQ, or reporting preference.
Read [advanced-analysis.md](references/advanced-analysis.md) for separate repeated traces, state fingerprints, dual-resolution analysis, direct/late windows, linked stereo EQ, speaker protection, measured verification, or controlled listening tests.
Read [measurement-science.md](references/measurement-science.md) before uncertainty propagation, coherence rejection, room metrics, polar scans, multi-source optimization, FIR design, laboratory listening, immersive/SOFA work, or reference-corpus evaluation.
Read [artifacts-and-integrations.md](references/artifacts-and-integrations.md) before sharing diagnostics, replaying sessions, or applying a cross-platform DSP adapter.

## Boundaries

- REW and host inventory are read-only. Starting REW, routing, sweeps, file loading, and DSP changes require the relevant confirmation tool. Never launch an inferred executable that was not returned by discovery or explicitly supplied by the user.
- Physical microphone placement and speaker condition cannot be detected reliably; prompt for them.
- Treat acoustic timing offsets as alignment values, not tape-measure distances.
- Do not transfer a correction designed for one output path, seat, vehicle, or speaker to another without measurement.
- Report uncertainty when source data, calibrated SPL, combined response, or post-change verification is missing.
- Built-in targets are versioned preference starting points, not standards. Preserve target identity in every proposal and report.
- Scores belong to individual dimensions and must include raw metrics, coverage, and confidence. Leave a dimension unscored when evidence is absent.
- Keep A1 Evo/Denon transfer work in the dedicated A1/Denon plugin; exchange only versioned, validated artifacts across that boundary.

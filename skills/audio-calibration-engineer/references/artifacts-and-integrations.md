# Artifacts, privacy, and DSP integrations

Use the versioned `audio-calibration-session` JSON artifact for replay or exchange.
Each sweep needs control, preset, microphone, and sweep fingerprints plus an
artifact/trace hash. Preserve algorithm, software, and target versions. A missing
identity makes replay non-deterministic; report it instead of inventing one.

Validate with `audio_artifact_validate` and `audio_session_replay_validate` before
replay. Use migrations only through `audio_artifact_migrate`, retain the original,
and label migrated unknowns. Never treat a migrated artifact as stronger evidence
than its source.

Support artifacts may contain sensitive paths, devices, addresses, serials, room
data, or raw traces. Use the hash-bound support-bundle plan/executor, then review
the JSON manually before sharing it. Sanitization omits raw trace arrays and
redacts identifying keys and common path/address forms; it is a safety layer, not
a guarantee against sensitive free-form notes.

Inspect `audio_dsp_adapter_capabilities` before applying DSP. JamesDSP is Linux
only and uses its CLI/config workflow. Equalizer APO apply is Windows-only and
requires `AUDIO_EQUALIZER_APO_CONFIG`. CamillaDSP file apply requires a dedicated
filter include path in `AUDIO_CAMILLADSP_FILTER_PATH`; do not point it at an
unrelated full configuration. Both adapters must preview, hash-bind, back up,
verify, and roll back. macOS and miniDSP remain export-only unless a separately
validated adapter is present.

A successful file or CLI apply is not acoustic acceptance. Capture the new preset
fingerprint, repeat the same measurement controls, and use measured post-EQ
verification before keeping the change.

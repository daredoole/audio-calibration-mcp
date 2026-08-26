# Optional JamesDSP integration

JDSP4Linux is a Linux effects processor designed for PipeWire; PulseAudio support is maintained for compatibility. Do not present it as a Windows or macOS integration.

Use the official `jamesdsp` CLI only after capability detection. Supported remote operations include status, device and key listing, key get/set, and preset load/save/delete/list. The canonical audio configuration is `~/.config/jamesdsp/audio.conf`.

Before any preset or key mutation:

1. Capture status, active device, preset list, and current configuration.
2. Copy `audio.conf` into the workspace backup directory.
3. Produce an exact hash-bound proposal and require confirmation.
4. Apply through the CLI, verify the resulting status and values, and retain the rollback path.
5. Re-measure at matched level. A successful CLI response is not acoustic verification.

Do not write unknown keys, fabricate a config schema, enable enhancement effects as calibration, or apply an REW proposal without adequate preamp headroom.

## Measurement-state identity

Before every reference sweep, use `jamesdsp_snapshot` and retain its complete DSP fingerprint with the trace. Do not treat the application being connected or reporting `Is processing: enabled` as proof that EQ is active. Require all applicable layers:

- the JamesDSP service is connected and its engine is processing;
- `master_enable` is true, so master bypass is not active;
- the intended EQ module, such as `graphiceq_enable`, is true;
- runtime key values match the active configuration file;
- `presetIdentity.status` is `exact` and `activePreset` is the intended named preset, or else record the configuration fingerprint as an unnamed/custom state.

An exact preset identity means every parsed active setting matches the saved preset, independent of line order or whitespace. If no preset matches exactly, `closestCandidate` is diagnostic only; never claim that candidate was loaded. Store the engine, master, module, bypass, preset-identity, configuration-hash, and effective-configuration fingerprint fields with every sweep. Any change separates traces into different DSP-state groups and blocks repeatability or held-out validation across those groups.

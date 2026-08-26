# Advanced measurement and validation

Use `rew_repeated_session_plan` to retain 4–6 separate traces for left, right, and combined output. Do not substitute REW's internally averaged repetitions when training/validation separation is required. Each trace must retain its role, repeat number, sweep level, route/volume control fingerprint, microphone-calibration hash, and preset fingerprint.

Use `rew_dual_resolution_analysis` for two distinct questions:

- Unsmoothed or minimally smoothed high-resolution data: timing, phase, polarity, resonances, narrow defects, and measurement integrity.
- ERB-smoothed data with frequency-dependent workflow thresholds: broad tonal interpretation and perceptual EQ candidacy.

Never erase or overwrite the source trace. A feature visible only in one display is evidence to investigate, not automatic proof of audibility or a reason to equalize it.

REW's logarithmic frequency-response API accepts PPO values that are factors of 96 and automatically smooths log-spaced output to PPO/2 to prevent sampling artifacts. Do not label a requested 192-PPO log trace as native raw data. Request `smoothing=None` without forcing PPO to obtain the native unsmoothed linear response, preserve its returned spacing metadata, and derive a 192-PPO internal analysis grid when that density is useful. Always verify the returned `smoothing`, `ppo`/`freqStep`, and message fields instead of trusting requested query values.

Frequency-dependent smoothing must keep the modal region high-resolution, transition explicitly, use ERB-oriented bandwidth through the principal perceptual range, and broaden high-frequency display where fine comb structure is not a reliable tonal target. Record the modal boundary and transition frequency; neither is a universal constant.

An EQ feature is eligible only when it exceeds the configured threshold in at least 75% of repeated training traces and in the held-out trace for raw-derived, 1/48-octave, and ERB-perceptual representations. The complete candidate filter set must also improve training and held-out error in every representation. A failure in any layer rejects automatic EQ.

Use `rew_direct_late_analysis` to separate an explicitly chosen direct window from later energy. Window duration depends on source distance, geometry, sample rate, and nearby reflections. Report the window and treat it as an analysis choice, not a universal direct-sound boundary.

For output capability, use `rew_level_ladder_plan` and `rew_compression_analysis`. Keep route, volume, microphone, and DSP state fixed. Stop on clipping, limiter activity, rattling, abnormal distortion, or distress. `audio_speaker_protection_assessment` disables positive EQ when headroom or capability is unknown and sets the correction floor to the highest defensible boundary.

Use `audio_linked_stereo_eq_plan` only with repeated left and right traces. Each channel must independently pass held-out validation. Linked centers, regularization, and bounded gain differences protect imaging; they do not prove acoustic improvement.

After applying a confirmed preset, repeat the same measurement controls under the new preset. `audio_post_eq_verification` requires matching control fingerprints, different preset fingerprints, accepted before/after quality, no material repeatability regression, and measured level match within 0.2 dB.

Listening comparison is a separate preference layer. `audio_listening_test_plan` is ready only when the preset fingerprints differ, the playback chain and excerpts are recorded, and measured level difference is within the declared bound. ABX tests discrimination; randomized AB records preference.

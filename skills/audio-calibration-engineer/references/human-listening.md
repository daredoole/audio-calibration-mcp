# Human-listening calibration

## Evidence layers

Keep four layers explicit in every result:

1. **Facts:** raw REW data, route/DSP state, calibration identity, sweep settings, and captured metadata.
2. **Calculations:** deterministic interpolation, smoothing, error, phase, decay, distortion, compression, and repeatability metrics.
3. **Interpretation:** likely audible effects, with confidence and missing-evidence warnings.
4. **Preference:** target choice and level-matched listening responses. Never present preference as an objective law.

Do not report one overall sound-quality number. Report tonal balance, imaging/channel match, bass extension, crossover integration, decay/resonance, distortion/compression, timing, seat consistency, and measurement confidence separately. A dimension without suitable evidence remains unscored.

## Measurement profiles

- **Quick:** two 256k repetitions for routing and gross-problem screening.
- **Standard:** four 512k repetitions for ordinary tuning and withheld-trace validation.
- **Reference:** six 1M repetitions when the environment is stable and additional precision is useful.

Use unsmoothed or minimally smoothed data for timing, polarity, phase, resonances, and distortion. Use perceptual or fractional-octave views for broad tonal interpretation. Preserve the original trace regardless of the displayed smoothing.

Quality-gate coverage, clipping, SNR, repeatability, route stability, DSP stability, expected trace count, and microphone-calibration identity. The session minimum SNR is configurable: 20 dB is the room/car default and 15 dB the conservative laptop default; below 25 dB lowers confidence even when the minimum passes. These are workflow thresholds, not universal audibility laws. Unknown calibrated SPL or SNR lowers confidence but must not be fabricated. A failed gate blocks automatic tuning.

## Targets and EQ

The built-in room, nearfield, and vehicle targets are conservative, versioned preference starting points. Their slopes and bass balance are not universal standards. Change them when verified device capability, listening level, program material, placement, or listener preference justifies it.

Before EQ, consider placement, listener position, polarity, timing, crossover, and output capability. Design filters only from repeatable peaks that remain stable across training traces. Reserve at least one repetition or seat for validation when possible. Reject a proposal that fails to improve the held-out response.

Default EQ constraints are cut-only, no narrow-null filling, limited filter count, limited Q, bounded correction frequency, and no transfer to an unmeasured route. A predicted trace is not verification; remeasure with the same routing, DSP state, level, microphone position, and target identity.

## Listening validation

Level-match before comparing presets; a louder presentation can bias preference. Keep program excerpts, position, and playback chain fixed. Randomize A/B order for preference; use ABX only when identity discrimination matters. ABX does not identify which preset is preferred. Record trial count, choice, confidence, and notes without coaching.

Treat a short or split result as inconclusive. Even a repeatable preference applies only to the tested listener, material, level, room/vehicle, and equipment until replicated.

## Source discipline

- REW API and Help define available measurements and processing semantics.
- ITU-R BS.1116 and BS.1534 inform controlled subjective-comparison structure; this workflow is inspired by them and does not claim laboratory conformance.
- ITU-R BS.1770 is relevant to programme loudness and true-peak handling, not a room-response target.
- Published loudspeaker and automotive preference research can motivate starting targets but cannot replace measurement or listener validation.

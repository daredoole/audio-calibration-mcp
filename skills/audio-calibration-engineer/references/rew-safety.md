# REW measurement safety

- Verify the selected input and output names immediately before a sweep. A UI-visible route is not proof that the test signal reaches the intended driver.
- Preserve and re-check the microphone calibration after changing the REW driver or PCM device; REW may clear it.
- Run a silent input-level check first. A calibrated SPL reading requires a sensitivity-calibrated microphone and gain path.
- Use REW clipping and maximum-SPL abort options. Start low and increase only when signal-to-noise requires it.
- Save raw measurements to a workspace-contained `.mdat`. Record output channel, position, gain, sample rate, sweep range, timing reference, DSP state, and date.
- Acoustic timing is required when comparing independently measured drivers. Confirm crossover conclusions with a measured combined response.
- Level-match A/B comparisons; louder commonly biases preference.
- Cancel immediately on unexpected output, rattling, compression, clipping, or distress.

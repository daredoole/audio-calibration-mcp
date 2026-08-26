# Measurement Science and Laboratory Modes

Use these modes only when the evidence supports them. A calculation marked `standards-aligned` or `inspired` is not a conformity claim.

## Uncertainty and trace validity

- Build a named uncertainty budget with calibration, position, noise, repeatability, interpolation, routing, and clock terms. Preserve units and sensitivity coefficients.
- Use `audio_uncertainty_budget` for first-order propagation and `audio_uncertainty_monte_carlo` when distributions or nonlinear effects make linear propagation questionable. Bootstrap repeated observations separately.
- Reject transfer bins through `audio_transfer_quality` when excitation, magnitude-squared coherence, phase confidence, harmonic contamination, or clock stability fails. Do not interpolate rejected bins into apparently valid evidence.

## Room and loudspeaker work

- Use `audio_room_metrics` only on a sufficiently long, calibrated impulse response with documented source/receiver geometry and noise conditions. Aggregate positions with `audio_room_spatial_summary`.
- Treat results as ISO-3382-aligned screening unless the complete licensed procedure and instrumentation evidence are present. STI is not inferred from decay metrics.
- Use `audio_polar_characterization` for guided angular scans and `audio_maximum_clean_output` for protected ascending level ladders. Their CTA-2034/AES75 labels describe design intent, not certification.

## Optimization and FIR

- `audio_multisource_optimize` requires separate training and held-out seats. Its per-frequency complex weights are a research solution, never directly deployable coefficients.
- Use `audio_multisource_physical_optimize` when the solution must be expressed as bounded source gain, delay, polarity, and fixed high/low-pass controls. Its crossover model remains an approximation that must be replaced by the measured device response.
- Realize only bounded solutions through `audio_fir_design`. Review latency, causality, pre-ringing, quantization, headroom, limiter interaction, and true-peak risk. A measured protected hardware verification is mandatory.

## Listening, spatial, and corpus evidence

- Use `audio_laboratory_listening_plan` and `audio_laboratory_listening_report` for MUSHRA/BS.1116-inspired research. Require level matching, concealment, hidden references, anchors where applicable, listener screening, repeat trials, and adequate power.
- `audio_spatial_layout_assessment` and `audio_sofa_metadata_assessment` are metadata preflights. A maintained SOFA HDF5 implementation remains necessary for actual import/export.
- Audit evaluation artifacts with `audio_evaluation_corpus_manifest`. Synthetic fixtures prove regression behavior, not independent accuracy. Inter-laboratory claims require separately produced, traceable datasets.

## Authoritative references

- [JCGM measurement uncertainty publications](https://www.bipm.org/en/committees/jc/jcgm/publications)
- [ISO 3382-1](https://www.iso.org/standard/40979.html) and [ISO 3382-2](https://www.iso.org/standard/36201.html)
- [IEC 60268-16](https://webstore.iec.ch/en/publication/26771)
- [ANSI/CTA-2034-B](https://www.cta.tech/standards/ansicta-2034-b/) and [AES75](https://aes.org/standards/AES75/)
- [ITU-R BS.1116](https://www.itu.int/rec/R-REC-BS.1116/en), [BS.1534](https://www.itu.int/rec/R-REC-BS.1534/en), and [BS.2051](https://www.itu.int/rec/R-REC-BS.2051/en)
- [SOFA APIs and software](https://www.sofaconventions.org/mediawiki/index.php/Software_and_APIs)

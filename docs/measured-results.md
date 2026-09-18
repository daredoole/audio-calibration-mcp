# Measured results: what the example shows

## Laptop speakers with a JamesDSP preset

This is the project's published before/after example. It compares the factory
laptop-speaker state with a cut-only JamesDSP preset. It is a measured response
comparison, rather than a predicted EQ curve.

![REW frequency-response comparison: factory laptop speakers in amber and the JamesDSP preset in cyan](../assets/laptop-before-after.svg)

| Detail | Documented in the public example |
|---|---|
| Measurement date | 26 August 2026, as labelled on the figure |
| Baseline | Factory laptop-speaker state, shown in amber |
| Changed state | Cut-only JamesDSP preset, shown in cyan |
| Repetitions | Four separate REW sweeps per state, averaged for the plot |
| Display | 1/12-octave smoothing, with measured SPL preserved |
| Bass treatment | No boost in the shaded protection-limited region below 500 Hz |
| Listening | The README records a separate level-matched listening comparison; it does not publish a preference score or trial result |

The two traces show how the measured response changed with this preset. The
cut-only correction can lower peaks; it does not add bass output the small
speakers cannot deliver. A lower trace is not automatically an improvement,
because changes in overall level also affect the comparison.

## What this example does not establish

This is a laptop example. It does not demonstrate a repaired home-theater null,
a speaker/subwoofer crossover improvement, or a Denon/Marantz calibration result.
Those need measurements from the relevant system.

The public figure also omits device, microphone, and preset identifiers. It does
not include the raw traces, complete filter settings, microphone-position record,
or listening-trial results. It therefore illustrates a measured change but is
not a complete reproducible case study. No exact peak-reduction numbers or
claims of audible preference are added here without those records.

The software's simulated tests check calculations and safeguards. They do not
substitute for before/after measurements on a real room or receiver.

## How to make a useful comparison on your system

1. **State the problem.** Identify the peak, dip, channel mismatch, or crossover
   behaviour you are investigating, rather than aiming for a generally flatter
   graph.
2. **Record the setup.** Note the speakers, microphone and calibration, placement,
   input/output devices, timing reference, sweep settings, and DSP state.
3. **Keep repeated raw traces.** Collect four to six sweeps per state and check
   clipping, noise, and repeatability before interpreting the result.
4. **Record one change.** Save the original settings and describe the placement,
   delay, polarity, crossover, or filter change exactly.
5. **Remeasure under comparable conditions.** Keep the microphone and settings
   consistent, calculate the level difference from the traces, and display both
   states using the same axes and smoothing. If measuring another seat, label it
   separately and use it to check whether the change holds beyond the first seat.
6. **Report the tradeoffs.** Include any worsening, uncertainty, and the measured
   combined response for crossover work. Keep filter predictions separate from
   actual remeasurements.
7. **Describe listening separately.** Match playback levels and use randomized
   A/B or ABX where practical. A response change does not, on its own, prove a
   listening preference.

For a narrow dip that changes substantially with microphone position, investigate
placement and cancellation before considering EQ. For a crossover question,
collect separate speaker, subwoofer, and combined measurements with consistent
timing. A magnitude trace alone is not enough to identify the cause.

Ask the assistant to prepare a comparison report using the repeated before and
after groups. The report tools can preserve variability and measured level
differences. Review personal paths and device information before sharing a report
on a forum.

[Start the written walkthrough](getting-started.md) · [Back to README](../README.md)

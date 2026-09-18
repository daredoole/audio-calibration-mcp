# Getting started with Audio Calibration MCP

This guide takes you from installation to an explanation of one of your REW
measurements. Start there, then decide whether you want help planning changes.
You do not need to automate measurements or apply EQ to try the analysis tools.

## 1. Understand what each part does

There are three pieces:

- **Room EQ Wizard (REW)** measures your system and holds the measurement data.
- **Audio Calibration MCP** gives an assistant tools for working with that data.
- **Your assistant** is where you ask questions and review the results. This guide
  covers Codex, Claude Code, and Cursor. Choose one; you do not need all three.

For example, you can ask the assistant to compare measurements made before and
after moving a subwoofer. It can inspect the data and explain the difference.
That does not mean it has changed your receiver or applied a filter.

For A1 Evo AcoustiX, Audyssey files, or Denon/Marantz receiver control, use
[EvoBurrow MCP](https://github.com/daredoole/evoburrow-mcp). This guide covers the
general REW tools. You can use REW with a home-theater system here, but receiver
control belongs to EvoBurrow.

## 2. Check what you need

| Item | For this first analysis |
|---|---|
| Computer | Windows, macOS, or Linux, running both REW and the assistant |
| REW | A version with the API preferences tab; see the [REW download page](https://www.roomeqwizard.com/) |
| Assistant | One installed locally, with an account or API access as required by its provider |
| Node.js | Version 22 is a supported choice; version 20 is also covered by this project's compatibility checks |
| Measurement | An existing REW measurement, normally saved in an `.mdat` file |
| Measurement microphone | Needed when making new acoustic measurements; use its calibration file where available |
| DSP software | Needed only when applying a supported correction, not for analysing a measurement |

The MCP itself is free and open source. Assistant subscriptions or API usage are
separate. REW's API allows reading existing measurements; **automated sweep
control requires a REW Pro license**. You can make measurements manually in REW
and use these tools to analyse them. See the [official REW API guide](https://www.roomeqwizard.com/help/help/html/api.html).

If you do not have measurements yet, use REW's
[measurement setup guide](https://www.roomeqwizard.com/betahelp/help/html/calsoundcard.html)
first. The [published laptop example](measured-results.md) shows the kind of
comparison available, but its public figure is not a measurement file you can
load into REW.

## 3. Install and connect the tools

Follow [Installation](installation.md). Use the Codex CLI path if you are starting
from scratch and are comfortable entering commands in a terminal. If you already
use Claude Code or Cursor, follow that application's section instead.

When finished, the assistant should list an MCP server named `audio-calibration`.
That confirms registration. The connection check below confirms that the server
can actually start and communicate with REW.

Use a local assistant session. A cloud coding session cannot reach REW running
on your computer through `127.0.0.1`.

## 4. Open REW and check the connection

1. Start REW on the same computer as your assistant.
2. Open **Preferences**, select **API**, and use the button to start the server.
   Leave the port at **4735** for this walkthrough. You can also select
   **Start the API when REW starts** if you want REW to remember this choice.
3. Open `http://127.0.0.1:4735` in your browser. You should see REW's API
   documentation. This is a connection check; do not execute measurement commands
   from that page.
4. In the assistant, send this prompt:

   > Check the Audio Calibration MCP connection using audio_doctor and
   > rew_capability_negotiate. Tell me whether REW is reachable, which checks
   > failed, and whether those failures matter for analysing existing measurements.
   > Do not start sweeps or change audio settings.

Expect a tool result showing the REW connection and detected capabilities.
`audio_doctor` reports `ready`, `ready-with-warnings`, or `not-ready`. An optional
JamesDSP warning may be irrelevant if you do not use JamesDSP. A failed REW
connection needs attention. Some API versions or permissions can limit individual
checks; ask the assistant to explain the actual failure before proceeding.

If the assistant only gives general advice and never calls a tool, the MCP
connection has not been demonstrated. Check the server status in your assistant
and use [Troubleshooting](#troubleshooting).

## 5. Analyse your first measurement

1. In REW, open an existing `.mdat` file. Loading it yourself makes it clear which
   measurements the assistant will see. Keep a copy of the original file.
2. Give the traces meaningful names, such as `Left speaker - listening seat` or
   `Subwoofer - original position`. Note where the microphone was placed and
   which speaker or combination was measured.
3. Send this prompt, replacing the description with your own:

   > Use the Audio Calibration MCP tools to inspect the measurements currently
   > open in REW. I measured [speaker or subwoofer] at [microphone position]. List
   > the available traces and ask me which to use if the choice is unclear. Check
   > measurement quality, then explain the main peaks, dips, and any missing data
   > that affects your conclusions. Separate what the measurements show from
   > possible causes. Do not apply EQ, run sweeps, or change settings.

The useful result is an explanation tied to your actual traces: which measurement
was inspected, where a feature appears, whether the evidence is repeatable, and
what to measure next. Missing noise or repeatability data can prevent the quality
gate from accepting a trace. That is a reason to collect better evidence, not to
silently bypass the check.

A dip in one frequency-response trace does not, by itself, identify a crossover
problem or prove that a boost will help. For speaker/subwoofer integration, the
assistant may need separate speaker, subwoofer, and combined measurements made
with a consistent timing reference.

## 6. Plan one change

Once the initial analysis makes sense, try:

> Help me plan one change based on these measurements. Explain why you chose it,
> what additional measurements you need, and how I can compare the result. Prefer
> placement, polarity, timing, or crossover checks where appropriate. Show any EQ
> proposal before applying it, and explain how to restore the original state.

Keep the first experiment small enough to understand. Change one variable and
record it. Save the original measurement and any settings or preset you will
change. Narrow dips that vary with microphone position are not candidates for
large EQ boosts.

If you want automated measurements, first establish the microphone position,
microphone calibration, exact input and output devices, channel, frequency range,
and a suitable starting level. The assistant should show the measurement plan and
ask for confirmation before audible output. Stop on an unexpected output route,
clipping, rattling, or other distress. The MCP cannot inspect the physical room
or speaker condition for you.

## 7. Measure again and judge the result

Repeat the measurement with the same microphone position, routing, measurement
settings, and a controlled level. Keep the raw traces from both states. For a
repeatable comparison, collect four to six separate sweeps per state rather than
keeping only one average.

> Compare my before and after traces using the MCP tools. Check quality and
> repeatability, calculate the measured level difference, and use the same axes
> and smoothing for both states. Tell me what improved, what became worse, and
> what remains uncertain. Label predicted filter responses separately from actual
> remeasurements.

For crossover work, include the measured combined response. For listening,
compare at matched playback levels and, where practical, use randomized A/B or
ABX. A smoother graph and a preferred sound are different findings; report each
on its own evidence. See [Measured results](measured-results.md).

## Troubleshooting

| What you see | What to check |
|---|---|
| `node` is not recognized or the server cannot start | Install a supported Node.js version, reopen the terminal and assistant, and check `node --version`. A desktop app may need the full path to the Node executable. |
| `Cannot find module` or a missing `dist/server.mjs` | Point to the extracted release's `package/dist/server.mjs`. A GitHub source-code archive must be built first; see [Installation](installation.md#install-from-source). |
| The server is registered but no tools appear | Restart the assistant, check its MCP status and logs, and confirm that the server is enabled. In Cursor, use an Agent conversation with the tools enabled. |
| The browser cannot open `127.0.0.1:4735` | Start REW's API server and check the port. If there is no API tab, use an API-capable REW version from the official downloads. |
| REW works in the browser but the assistant cannot reach it | Confirm that both run on the same computer and operating-system environment. WSL, containers, virtual machines, and cloud sessions have their own loopback addresses. Start with native local apps. |
| No measurements are listed | Open the `.mdat` file in REW and ask the assistant to list the traces again. Having a file on disk is not the same as loading it into REW. |
| An automated sweep is unavailable | Check the negotiated capabilities and REW license. You can still measure manually and analyse existing traces. |
| A quality check fails | Review clipping, noise, calibration, timing, and repeatability. Keep the failed check visible; do not present an exploratory result as verified correction. |

For help, open a [GitHub issue](https://github.com/daredoole/audio-calibration-mcp/issues)
with your operating system, assistant and version, REW version, Node version, the
step that failed, and the exact error. Share redacted diagnostics and review them
for personal paths or device names before posting. Do not upload your entire
session or backup directory.

[Back to README](../README.md) · [Installation](installation.md) · [Measured results](measured-results.md)

# Forum reply draft

Thanks for pointing this out. The original instructions assumed you already knew
how to connect an MCP tool to an assistant, and that made the starting point unclear.

I've added a [written walkthrough](https://github.com/daredoole/audio-calibration-mcp/blob/main/docs/getting-started.md)
with installation steps for Codex, Claude Code, and Cursor, a connection check,
and prompts for analysing your first REW measurement. You only need one of those
assistants. REW still does the measuring; these tools let the assistant work with
the measurement data. You can start with an existing `.mdat` file without applying
EQ or automating sweeps.

There is also a [measured laptop before/after example](https://github.com/daredoole/audio-calibration-mcp/blob/main/docs/measured-results.md),
using four sweeps per state and a cut-only JamesDSP preset. I've explained the
method and its limits. It isn't a home-theater crossover or null-fixing example,
and I don't have a published case study demonstrating those results yet.

For A1 Evo and Denon/Marantz receiver work, the separate project is
[EvoBurrow](https://github.com/daredoole/evoburrow-mcp).

If you tell me your operating system and whether you're using REW alone or
A1 Evo with a receiver, I can point you toward the right starting point.

---

Posting note: publish the documentation changes before using this reply, so the
new links are available. This is a draft; it has not been posted to the forum.

# Installation

Install the assistant and the audio tools on the same computer as REW. This page
uses a downloaded release and explicit file paths, so the server does not depend
on whichever folder your assistant happens to open.

## 1. Install Node.js

Install **Node.js 22** for your operating system from the
[official Node.js downloads](https://nodejs.org/en/download). The project also
checks compatibility with Node.js 20; other versions may work but are not covered
by that compatibility matrix.

Open a new terminal after installation. On Windows, PowerShell is suitable; on
macOS or Linux, use Terminal. Run:

```text
node --version
```

You should see a version beginning with `v22.` if you installed version 22. If
the command is not found, resolve the Node installation before continuing.

## 2. Download and extract Audio Calibration MCP

1. Open [GitHub Releases](https://github.com/daredoole/audio-calibration-mcp/releases).
2. Choose a release and download the **`audio-calibration-mcp-<version>.tgz`**
   attachment under **Assets**. The version number varies by release.
3. Extract it into a permanent folder you own, such as `AudioCalibration` in your
   home folder. If your archive tool opens a second `.tar` archive, extract that
   too. Do not leave the files inside the archive.
4. Find **`package/dist/server.mjs`** inside the extracted files. This is the
   server you will register. Keep the rest of the package beside it, including
   `dist/analysis-worker.mjs`.

If your archive application cannot extract `.tgz`, create the destination folder
first, then use `tar` in your terminal. Replace both paths with your own:

```text
tar -xzf "PATH_TO_DOWNLOADED_ARCHIVE.tgz" -C "PATH_TO_EXISTING_DESTINATION_FOLDER"
```

The `.tgz` contains the built server. You do not need to run `npm install` inside
it. The **Source code (zip)** and **Source code (tar.gz)** links are different:
those are source checkouts and need the [build steps below](#install-from-source).

Releases also include an `.mcpb` desktop-extension bundle. It is not the `.tgz`
used in these instructions; installation depends on a client's desktop-extension
support. Follow one of the explicit connection methods below for this guide.

## 3. Choose one assistant

If you already use one of these applications, keep using it. If you are starting
from scratch and are comfortable with a terminal, the Codex CLI steps below give
you one complete path. The assistant's account, plan, and usage costs are separate
from this free MCP server; check its official setup page for current requirements.

### Codex CLI

1. Follow the [official Codex CLI installation and sign-in guide](https://developers.openai.com/codex/cli).
   With Node.js installed, its npm installation option is:

   ```text
   npm install -g @openai/codex
   ```

2. Register the audio server in your terminal. Replace the quoted placeholder
   with the **full path** to your extracted `dist/server.mjs`:

   ```text
   codex mcp add audio-calibration -- node "ABSOLUTE_PATH_TO_DIST/server.mjs"
   ```

   For example, if you extracted the package to `C:\AudioCalibration` on Windows:

   ```text
   codex mcp add audio-calibration -- node "C:/AudioCalibration/package/dist/server.mjs"
   ```

   On macOS, the path might be
   `/Users/YOUR_NAME/AudioCalibration/package/dist/server.mjs`; on Linux it might
   be `/home/YOUR_NAME/AudioCalibration/package/dist/server.mjs`. Replace
   `YOUR_NAME` and the folder names with your actual path. Keep the quotes,
   especially if the path contains spaces.

3. Run `codex mcp list` and check that `audio-calibration` is listed. Start a new
   `codex` session, complete sign-in if needed, and use `/mcp` to check the active
   server and tools.

Codex stores MCP settings in `config.toml`. Simply downloading the repository's
`.mcp.json` does not register the server with the Codex CLI. You do not need to
edit TOML by hand for the command above. See [official Codex MCP configuration](https://developers.openai.com/codex/mcp).

### Claude Code

These steps are for **Claude Code**, not the Claude website or Claude Desktop.

1. Follow the [official Claude Code installation and sign-in guide](https://code.claude.com/docs/en/quickstart).
2. In your terminal, register the server with a full path:

   ```text
   claude mcp add --transport stdio --scope user audio-calibration -- node "ABSOLUTE_PATH_TO_DIST/server.mjs"
   ```

   Use the same path conventions shown in the Codex section. `--scope user` makes
   the connection available across your local Claude Code projects.
3. Run `claude mcp list`, then start a new `claude` session. Use `/mcp` to check
   the connection and review any permission prompts.

See [official Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
if your installation or organization restricts custom servers.

### Cursor

1. Install Cursor from [its official download page](https://cursor.com/downloads)
   and complete its account setup.
2. Open Cursor's MCP configuration using its settings. The global configuration
   file is `~/.cursor/mcp.json` in your home folder, including on Windows. A
   project-specific configuration uses `.cursor/mcp.json` in that project.
3. Add the following server entry. If you already have `mcpServers` entries,
   merge this entry into that object instead of replacing the existing file.

   ```json
   {
     "mcpServers": {
       "audio-calibration": {
         "type": "stdio",
         "command": "node",
         "args": ["ABSOLUTE_PATH_TO_DIST/server.mjs"]
       }
     }
   }
   ```

   Replace the placeholder with your full server path. On Windows, forward
   slashes avoid JSON backslash escaping, for example
   `C:/AudioCalibration/package/dist/server.mjs`.
4. Save the file, enable the server in Cursor's MCP settings, and start a new
   Agent conversation. Check that the server's tools are available. If necessary,
   restart Cursor after installing Node.js or changing the configuration.

See [official Cursor MCP configuration](https://cursor.com/docs/context/mcp)
for the current settings interface and configuration options.

## 4. Verify the connection to REW

Registration alone does not check the REW connection. Continue with
[Open REW and check the connection](getting-started.md#4-open-rew-and-check-the-connection),
then analyse a measurement before planning any changes.

The default REW address is `http://127.0.0.1:4735`. No API key is needed for this
local server connection. Your assistant's own sign-in or API credentials are a
separate matter.

If the assistant cannot find `node`, use the absolute path to the Node executable
as the command instead. If you deliberately use a different REW API port, set
`AUDIO_REW_URL` in the server environment using your assistant's official MCP
configuration instructions. Keep REW local for this walkthrough.

## Install from source

Use this route if you want to develop the project or downloaded a source-code
archive instead of a built release. In the directory containing `package.json`,
run:

```text
npm ci --ignore-scripts
npm run build
npm run validate:release
```

Then register the full path to that checkout's `dist/server.mjs` using your
assistant's section above. Developers can also run `npm test`; it uses simulated
fixtures and does not perform live acoustic measurements.

## Update or remove the connection

For an update, extract the new release into its own folder and update your MCP
entry to the new full path. Restart the assistant and repeat the connection check
before using it. Keep your existing measurements, presets, and backups.

To remove the connection, use `codex mcp remove audio-calibration`,
`claude mcp remove audio-calibration`, or remove just the `audio-calibration` entry
from Cursor's MCP settings. Disconnecting the tools does not undo a DSP change;
restore the saved preset or backup separately if needed.

These instructions follow the linked provider documentation. Menu labels and
account requirements can change. A documented connection method does not mean
every assistant and operating-system combination has been tested on physical
audio hardware.

[Back to walkthrough](getting-started.md) · [Troubleshooting](getting-started.md#troubleshooting)

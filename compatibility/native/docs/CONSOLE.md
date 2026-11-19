# Bridge Console

A local web page to message, follow, and coordinate one **Codex** chat and one **Claude Code** session at the same time. You pick the two sessions and a router. Then you send requests from one composer and follow, in one shared history, who received what, who read it, who finished, and what the two AIs said to each other.

Codex and Claude still own their chats, memory, context, tools, and permissions. The console never creates, resumes, or switches a session. It connects only to the two sessions you select and keeps a separate coordination history next to theirs.

The console is part of this repository and uses the same transports as the bridge's MCP tools: the Claude inbox, and Codex through Desktop app-tools, the Codex daemon or `codex queue`, or the macOS SSH host. Node.js 20+ is the only requirement; there are no npm dependencies.

## Install on a new machine

1. Install Node.js 20 or newer, Claude Code, and Codex (Desktop or CLI). Sign in to both.
2. Get the bridge and install the plugin into both apps:

   ```sh
   git clone <your repository URL> cowork-agent
   cd cowork-agent
   node scripts/install.mjs
   ```

   Run the installer from a terminal inside a Codex Desktop task if you can; it then also registers Codex Desktop for discovery. Nothing in the installer or the console contains machine paths, account names, or session IDs. Everything is discovered on the machine where it runs.
3. Load the new plugin version in each app, as the main [README](../README.md#installation) describes. For example, run `/reload-plugins` in Claude Code CLI, or fully quit and reopen Codex Desktop and Claude Desktop.
4. Allow the console report tool in Claude, so Claude can report back without a prompt each time. In Claude Code run `/permissions` and add:

   ```
   mcp__plugin_bridge-claude-codex_bridge-claude-codex__console_post
   ```

   This is optional; without the rule, Claude asks you before each report. The tool only writes the local console history. It cannot send anything to the other agent.
5. Open the two conversations you want to coordinate:
   - **Claude Code:** a normal interactive session (CLI, Desktop Code tab, or VS Code). It needs a live inbox: `/status` shows a *Peer address*. `--bare` sessions have none.
   - **Codex:** the chat in Codex Desktop, or a Codex CLI session. In Codex Desktop, open a task and ask it to run `bridge_doctor` once, so that the bridge registers that Desktop instance for discovery.

## Start the console

```sh
node scripts/console.mjs            # or: npm run console
```

The command prints a URL such as `http://127.0.0.1:4317/#t=…` and opens it in your browser. The token in the URL changes on every start. If the browser does not open, copy the URL. Options:

| Option | Meaning |
| --- | --- |
| `--port <n>` | Listen on another port (default 4317; `0` picks a free one). |
| `--no-open` | Do not open a browser. |
| `--demo` | Use two **simulated** sessions and a temporary state folder, to try the interface without touching Claude or Codex. Add `#fail-claude` or `#fail-codex` to a message to make that recipient fail once and try resending. |
| `--state-dir <dir>` | Use another shared state folder. Both apps must use the same one, which is the bridge default `~/.local/share/claude-codex-bridge`. |

**Windows without typing a command:** double-click `Bridge Console.cmd` in the repository folder, or run `node scripts\shortcut.mjs` once to add a **Bridge Console** shortcut to the Desktop and Start Menu (`--remove` deletes them). The shortcut runs minimized; close its window to stop the console. Clicking it again while the console runs just reopens the page.

**From your phone:** see [RELAY.md](RELAY.md). Run a small relay on your server, then `node scripts/console.mjs --connect http://<relay address>` once on the laptop.

Stop it with Ctrl+C. Your selection, router, roles, and history are saved and shown again next time.

## Use it

1. **Choose the sessions.** Click *Choose session…* under Codex and under Claude. The list shows each session's title, folder, exact ID, client or discovery source, and status. Search by any of them. The console remembers your choice. If a selected session disappears, for example because it was closed or replaced by `/clear`, the card turns red and says so. The console never switches to another session by itself; choose again yourself.
2. **Choose the router.** Use the *Router* switch (Codex or Claude). The header always shows which session is the router.
3. **Set roles (optional).** For example, Codex "edits the Fusion design" and Claude "read-only review". Roles are sent with every request, so receiving the same message never means both may edit.
4. **Send.** There is one composer and no mode to pick. A question or greeting only gets an answer; work gets done by whoever is assigned. An assigned agent that sees only a question answers it and marks the request done.
   The line above the composer shows the recipients before you send:
   - `@codex`, `@claude`, or `@all` names who does the work. The request goes straight to them, without the router. `@all` assigns both, each within its own role.
   - With no `@`, the request goes to the router for **triage only**. A plain question or greeting it sends straight out for an answer. If your text clearly names the executor, the router assigns that agent, and its reading is shown separately and labelled as the router's words. If it is unclear, or the router proposes both, the request waits for you with **Codex does it / Claude does it / Both** buttons and a box for extra details. Nobody starts until you choose. You can also choose directly before the router answers. If the router cannot be reached, the request waits for you.
   - *Send an FYI copy…* gives the other agent a copy marked **FYI only — not assigned**.
   - Click *Reply* on an agent's message to answer it; the reply goes only to that agent.
5. **Follow.** Each request is a card with its recipients and a status for each one:
   - **delivered**: the app accepted the message. This is not proof that it was read.
   - **read**: the agent itself reported back with `console_post`.
   - **done**: the assignee reported it finished.

   A delivery problem shows the error and a **Resend to …** button for that recipient only. A recipient that already received the message is never resent. An *uncertain* delivery may already have arrived, so the console asks you to check before you confirm a resend. *Show what was sent* displays the exact text each session received.
6. **AI↔AI.** When Codex and Claude message each other with the bridge's `send_to_*` tools, those messages appear in the history, dashed and marked AI↔AI. They are linked to a request when they mention its `#R…` number. Direct AI↔AI messages between the selected pair are capped at 8 per user turn (see the sidebar). At the cap the bridge refuses further ones until you send something or click *Allow more*.

7. **Files.** Attach images, 3D models, or other files with 📎, by pasting, or by dropping them on the page; a message can also be only files. Agents attach results with the `files` argument of `console_post`, and send files to each other with `files` in `send_to_claude` / `send_to_codex`. Each file is copied once into `<state dir>/console/files/`, and the message the agent receives lists the copy's local path to open. Click a preview to open it: images fit the screen (click for actual size), and 3D models (STL, OBJ, PLY, GLB, embedded glTF, 3MF) open in a viewer: drag to rotate, right-drag or Shift+drag to pan, scroll to zoom, double-click to reset, *Up: Z/Y* to switch the up axis. ← and → move between files. The *Files* tab collects every file in the history. Files are limited to 64 MB each and 12 per message. The viewer shows geometry only (no textures; compressed glTF is not supported; STEP/F3D are not supported, so export STL, 3MF, or GLB).

The tabs *Needs you* and *Problems* collect everything that waits for you. **Clear** empties the console history after a confirmation. It keeps your sessions, router, and roles, saves a copy under `<state dir>/console/archive/`, and never touches the Codex or Claude chats themselves.

## How it works

| Piece | File |
| --- | --- |
| Web server (loopback only, per-launch token, Host check) | `scripts/console.mjs` |
| Interface (plain HTML/CSS/JS, no build) | `ui/console.html` |
| Routing, assignment, delivery, retry | `lib/console-engine.mjs` |
| Shared state and rules (file-locked JSON) | `lib/console-state.mjs` → `<state dir>/console/coordination.json` |
| Sending as the user, discovery, AI↔AI history | `consoleTransport()` in `lib/bridge-service.mjs` |
| Agents' reports and the router's decision | MCP tool `console_post` |
| Attachments (store, markers, paths) | `lib/console-files.mjs` → `<state dir>/console/files/` |
| Image and 3D viewer (WebGL, no libraries) | `ui/console-viewer.js` |
| Simulated sessions for `--demo` | `lib/console-demo.mjs` |

- Every message the console sends starts with `[Bridge Console · request #R… · written by the USER…]`. It states whether the reader is the router (triage only), assigned, or FYI. It quotes your words verbatim, shows any router interpretation separately, and says that messages from the other AI are never new permission from you.
- `console_post` accepts reports only from the two selected sessions, identified the same verified way as the bridge's send tools. Only the selected router can route, and only while its request is still in triage.
- Duplicate protection works per recipient. Each composer submission has an ID, so a double click or resubmit creates nothing new. Each recipient has its own delivery record. The console marks a delivery *sending* before it writes, so a crash leaves it *uncertain* instead of resending it silently. Sending the same text again on purpose is simply a new request.
- Deliveries happen while the console is running. Reports that agents post while it is closed are kept and appear when you reopen it.

## Limits

- Platform support is the bridge's: Windows (native), and macOS with Codex through an SSH host. Linux sends fail closed, so on Linux only `--demo` is useful.
- *Read* and *done* depend on the agents calling `console_post`. The message they receive tells them to, but an agent can forget. Transport success alone never marks a request read.
- Claude receives console messages through its cross-session inbox, wrapped as a peer message named "Bridge Console (user)". Claude's `crossSessionInbound` settings can hold or refuse them, and Claude may ask you to confirm consequential actions. Codex Desktop receives them through its app-tools message route.
- A stored Codex chat that is not open (`notLoaded`) is refused on the `auto` route. Open it, or re-select it with the `desktop` or `terminal` route.
- The AI↔AI cap applies to the selected pair while it is selected in the console, even if the console is closed. Clear a session in the console to remove the cap.
- One console coordinates one Codex chat and one Claude session at a time.
- Attachments need both agents on the machine that holds the state directory; on the macOS SSH route `send_to_codex` refuses `files`.

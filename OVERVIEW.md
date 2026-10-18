# paseo-sugiere — the next message, one tap away

After an agent finishes a turn and the session stays quiet for a minute, a small model reads the conversation and proposes the
message you would most likely send next. It shows up as a pill above the composer; one tap puts the text in that agent's
prompt, ready to edit and send with Enter.

![The pill above the composer](docs/media/pill.png)

![One tap later, the text is in the prompt](docs/media/prompt.png)

## How it works

- When a turn ends completed and nothing happens for 60 s (15 to 600 s in the plugin's settings), one call with the
  conversation goes to the model. Finished work, optional offers and decisions that are yours to make get no suggestion, so
  no pill appears. The answer is capped at 48 tokens.
- The pill is per agent. Tapping it **appends** the text to that agent's prompt, a line below what you already typed, and
  never replaces it; **Ctrl+Z** takes it back. Where it cannot reach the prompt (phones, narrow layouts, or a prompt it cannot
  tell apart from another pane's), the pill opens a small editable card instead, with a send button.
- A new turn drops the pending suggestion. Nothing is ever sent for you: sending is always your tap or Enter.
- Settings (plugin settings screen): on/off, and the quiet window.

## Requirements — read this first

This plugin was built for one setup and is published as it runs there:

- **Claude agents only.** It finds the agent's Claude Code transcript; an agent of another provider gets no suggestion.
- **A local, Anthropic-compatible endpoint at `127.0.0.1:18791`** (`POST /v1/messages`) that serves a model alias called
  `qwen38-off`. Without it no pill ever appears (`paseo plugin logs paseo-sugiere` says "the local router did not answer").
  Host, port and alias are plain constants (`ROUTER` in `server/session.ts`, `SUGGEST_MODEL` in `shared/suggest.ts`).
- Paseo `>=0.11.2 <0.12.0`.

## What it reads, sends and writes

- **Reads** the agent's transcript (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session>.jsonl`, located through the Claude
  providers in `$PASEO_HOME/config.json`), and, optionally, `~/.local/state/paseo-sugiere/prompt.txt`, a file that replaces
  the built-in instruction.
- **Sends** the flattened transcript (every tool call reduced to one line, never its content) to `127.0.0.1:18791` and nowhere
  else, with a placeholder bearer token. From `$PASEO_HOME/config.json` it uses only each Claude provider's `CLAUDE_CONFIG_DIR`; it reads no account token.
- **Writes**, in the Paseo client on web and desktop, into the composer's text box: it types the text into it (`execCommand`
  `insertText`, with an `input` event as the fallback), so Paseo's own handlers store the draft as if you had typed it. It
  looks for the box of the pane the pill sits in and does nothing if it finds none or more than one.
- **Self-update, on the author's machine only.** `index.server.ts` spawns `scripts/autodeploy.sh` at start and every five
  minutes, but only if `~/.local/share/paseo-sugiere/paseo-plugin/current/scripts/autodeploy.sh` exists. `scripts/deploy.sh`
  creates that folder, and neither the registry nor `paseo plugin add` ever runs it, so on an installed copy the check fails
  (one warning line in the plugin log) and nothing else happens. Where it does exist, the script runs `git ls-remote` against
  `https://github.com/pocharlies-org/paseo-sugiere` and, when `main` has a commit that is not deployed yet, shallow-clones it
  and runs that clone's `scripts/deploy.sh`: it copies the files listed in `package.json` into
  `~/.local/share/paseo-sugiere/paseo-plugin/<version>-<sha>/`, points `current` at that folder and calls `paseo plugin
  reload` (or `install`). It logs to `~/.local/state/paseo-sugiere/autodeploy.log` and sends no data, only the git request.

## Retirement

The client side works by writing into Paseo's DOM because the plugin SDK has no API for the composer's draft. It is one small
module (`client/composer-bridge.ts`), marked as a shortcut, and is deleted the day the SDK exposes the draft.

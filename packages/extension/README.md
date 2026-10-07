# Agent Monitor

Watch a long-running Claude Code or Codex session while it is still running, and tell it
something without interrupting it.

A ten-minute task is a task you cannot supervise. You either sit and read a scrolling
terminal, or you come back at the end and find out the agent spent that time on the wrong
thing. Agent Monitor gives you the middle: milestones as they happen, and a comment box
that reaches the agent on its next step.

## What you get

**A feed of milestones.** The agent reports when something is actually finished — a module
split, a plan ready, tests green — with the artefact attached: a diff, a plan, a table. The
diff opens in your editor, not in a cramped panel.

**Comments that arrive.** Type `do not touch legacy/`, mark it `steer`, and it lands in the
agent's context during its next tool call. No interruption, no repeated prompt, no waiting
for the turn to end. Pick `stop` instead and the agent halts and waits for you.

**A pulse, even with nothing set up.** Before any configuration, the sidebar reads the
agent's own transcript and shows what it is doing right now and which files it has touched.
That alone answers "is it stuck?".

## Getting started

1. Install the extension.
2. Run **Agent Monitor: Set Up Workspace** from the command palette.
3. Start your agent as usual.

Setup is idempotent and merges rather than overwrites. It writes:

- `.agent-monitor/` for the session files, and a line in `.gitignore`;
- `.mcp.json` and `.claude/settings.json` for Claude Code — the MCP server and the hooks;
- `~/.codex/config.toml` for Codex — the MCP server and the turn-complete notification,
  with a backup of the file beside it;
- a short block in `CLAUDE.md` / `AGENTS.md`, between markers, telling the agent when to
  report.

Everything it needs ships inside the extension. There is no `npm install`, no `npx`, and no
separate server to keep running.

Run the setup again after upgrading from a build that had the `ask_user` tool: the block in
`CLAUDE.md` / `AGENTS.md` is rewritten in place, and an older one still tells the agent to
call a tool the server no longer offers.

## How it works

The extension and the agent talk through append-only files in your workspace, not through a
socket. That survives a restart of either side, works in Remote-SSH and devcontainers, and
leaves a session you can read with `cat` when something looks wrong.

Feedback travels two ways at once, because one is not enough: the agent's own reporting tool
returns your comments in its result, and a hook injects them after a tool call whether or
not the agent thought to look.

## Settings

| Setting                                 | Default  | What it does                                                         |
| --------------------------------------- | -------- | -------------------------------------------------------------------- |
| `agentMonitor.pollIntervalMs`           | `1000`   | How often to re-read session files when the watcher misses a change. |
| `agentMonitor.staleAfterMs`             | `600000` | A session quiet for this long is shown as stale.                     |
| `agentMonitor.keepSessionsForDays`      | `14`     | Delete sessions untouched for this many days. `0` keeps everything.  |
| `agentMonitor.archiveSessionsAfterDays` | `0`      | Archive sessions untouched for this many days. `0` turns it off.     |
| `agentMonitor.sessionLabelExtras`       | `[]`     | Show agent, start time and/or last activity before session titles.   |

The gear button on the Sessions list edits the title prefix and both timers without
leaving the sidebar; it writes the same settings. Both timers count from a session's last
activity, or from the moment you restored it from the archive, whichever is later. They
run on start and then hourly, and a change made from the gear button applies at once —
after naming the sessions a shorter delete deadline would remove.

## Privacy

Everything stays on your machine. `.agent-monitor/` holds whatever the agent publishes —
summaries, diffs, files — in plain text, and is added to `.gitignore` so it does not reach a
remote by accident. Nothing is encrypted, so treat it like any other build directory: do not
publish artefacts you would not paste into a terminal.

## Status

Early. The session file format is stable; the user interface is not. Bug reports with a copy
of the session directory are the most useful thing you can send.

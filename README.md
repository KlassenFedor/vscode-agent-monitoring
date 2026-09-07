# Agent Monitor

VS Code extension for watching long-running AI coding sessions (Claude Code, Codex)
while they are still running: intermediate reports, artifacts, and comments that the
agent picks up without being interrupted.

Status: early development. The protocol layer is the only package with a stable shape.

## Layout

| Path                  | What                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/protocol`   | Session file format: schemas, atomic JSONL append, incremental readers. Zero runtime dependencies. |
| `packages/mcp-server` | The stdio MCP server the agents call to publish progress and read feedback.                        |
| `packages/hook`       | Hook CLI for Claude Code: pushes comments into a running agent without interrupting it.            |
| `packages/extension`  | The VS Code extension. All logic lives in `src/core`, which never imports `vscode`.                |
| `packages/testkit`    | Scripted stand-ins for the agent and the human, so tests need no language model.                   |
| `docs/`               | Versioned documentation for users of the extension.                                                |
| `docs-local/`         | Git-ignored: architecture and test specs (`DESIGN.md`, `TESTS.md`), personal notes, captured logs. |

## Development

```bash
npm install
npm run typecheck
npm test
```

## Running your build

The extension the editor loads is the installed VSIX, not the working tree, so a change
is invisible until it is packaged and installed again:

```bash
npm run reinstall -w agent-monitor
```

That builds the three bundles, packages `agent-monitor.vsix` at the repository root and
installs it over whatever is there. Then reload the window (`Developer: Reload Window`)
— VS Code keeps the old copy of an extension running until it does.

`--force` is in the script because the version in `package.json` rarely changes between
builds, and VS Code refuses to reinstall a version it already has without it. In
Remote-SSH or WSL the `code` on `PATH` is the remote CLI, so the extension lands on the
machine the agents actually run on, which is where it has to be.

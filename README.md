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

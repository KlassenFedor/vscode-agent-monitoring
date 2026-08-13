# Agent Monitor

VS Code extension for watching long-running AI coding sessions (Claude Code, Codex)
while they are still running: intermediate reports, artifacts, and comments that the
agent picks up without being interrupted.

Status: early development. The protocol layer is the only package with a stable shape.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Session file format: schemas, atomic JSONL append, incremental readers. Zero runtime dependencies. |
| `docs/` | Versioned documentation. `DESIGN.md` (architecture) and `TESTS.md` (test registry) are the specs development follows. |
| `docs-local/` | Git-ignored scratch space: personal notes, throwaway analysis, captured logs. Never referenced from code or versioned docs. |

## Conventions

- Code, comments, docstrings, commit messages and public documentation are in English.
- Developer-only documentation under `docs/` may be written in Russian.

## Development

```bash
npm install
npm run typecheck
npm test
```

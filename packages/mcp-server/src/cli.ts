#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';
import { resolveSessionContext } from './session-env.js';

/**
 * Entry point registered with Claude Code (`.mcp.json`) and Codex
 * (`~/.codex/config.toml`).
 *
 * Nothing may be written to stdout other than the MCP protocol itself, so diagnostics
 * go to stderr.
 */
async function main(): Promise<void> {
  const context = resolveSessionContext(process.env, process.cwd());
  const { server } = createServer({
    root: context.root,
    sessionId: context.sessionId,
    agent: context.agent,
    cwd: context.cwd,
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `agent-monitor: session ${context.sessionId} (${context.agent}${context.generated ? ', generated id' : ''}) in ${context.root}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-monitor: fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

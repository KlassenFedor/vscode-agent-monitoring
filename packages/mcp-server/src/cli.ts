#!/usr/bin/env node
import { claimCurrentSession } from '@agent-monitor/protocol';
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

  // The hook may already have registered the agent's real session id for this
  // workspace. Adopting it is what keeps both channels writing to one session
  // directory; a generated id never displaces a real one.
  const claim = await claimCurrentSession(context.root, context.agent, context.sessionId, {
    authoritative: !context.generated,
  });

  const { server } = createServer({
    root: context.root,
    sessionId: claim.session_id,
    agent: context.agent,
    cwd: context.cwd,
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `agent-monitor: session ${claim.session_id} (${context.agent}${context.generated ? ', generated id' : ''}) in ${context.root}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-monitor: fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

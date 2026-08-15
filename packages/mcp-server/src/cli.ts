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

  const { server, runtime } = createServer({
    root: context.root,
    sessionId: claim.session_id,
    agent: context.agent,
    cwd: context.cwd,
  });

  // Register the session now, rather than on the first tool call.
  //
  // Claude Code has a SessionStart hook that does this the moment the agent starts,
  // which is why its sessions are visible and can be commented on straight away.
  // Codex has no such hook: waiting for the model to call a tool left the session with
  // no directory at all, so the sidebar could only show the transcript pulse — a row
  // with nothing behind it to open and nowhere to put a comment.
  //
  // A failure here is not fatal: the agent's own work matters more than monitoring it,
  // and each tool retries this anyway (TESTS.md MCP-13).
  await runtime.ensureSession().catch((error: unknown) => {
    process.stderr.write(
      `agent-monitor: could not register the session: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

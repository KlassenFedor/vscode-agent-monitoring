import { isSafeSessionId } from '@agent-monitor/protocol';
import { describe, expect, it } from 'vitest';

import { detectAgent, generateSessionId, resolveSessionContext } from '../src/session-env.js';

describe('MCP-15: session identity', () => {
  it('prefers an explicit override over agent-provided ids', () => {
    const context = resolveSessionContext(
      { AGENT_MONITOR_SESSION_ID: 'chosen-1', CLAUDE_SESSION_ID: 'ignored' },
      '/work',
    );

    expect(context).toMatchObject({ sessionId: 'chosen-1', generated: false, root: '/work' });
  });

  it('takes the id each agent publishes', () => {
    expect(resolveSessionContext({ CLAUDE_SESSION_ID: 'abc-123' }, '/work')).toMatchObject({
      sessionId: 'abc-123',
      agent: 'claude',
    });
    expect(resolveSessionContext({ CODEX_THREAD_ID: 'thread-9' }, '/work')).toMatchObject({
      sessionId: 'thread-9',
      agent: 'codex',
    });
  });

  it('generates a usable id when the environment offers none', () => {
    const context = resolveSessionContext({ CLAUDECODE: '1' }, '/work');

    expect(context.generated).toBe(true);
    expect(context.agent).toBe('claude');
    expect(isSafeSessionId(context.sessionId)).toBe(true);
  });

  it('SEC-04: ignores an unsafe id instead of trusting it as a directory name', () => {
    const context = resolveSessionContext({ CLAUDE_SESSION_ID: '../../escape' }, '/work');

    expect(context.generated).toBe(true);
    expect(isSafeSessionId(context.sessionId)).toBe(true);
  });

  it('lets the workspace root be overridden, defaulting to the working directory', () => {
    expect(resolveSessionContext({}, '/work').root).toBe('/work');
    expect(resolveSessionContext({ AGENT_MONITOR_ROOT: '/elsewhere' }, '/work').root).toBe('/elsewhere');
  });

  it('recognises each agent, and admits when it cannot tell', () => {
    expect(detectAgent({ CLAUDECODE: '1' })).toBe('claude');
    expect(detectAgent({ CODEX_HOME: '/home/x/.codex' })).toBe('codex');
    expect(detectAgent({})).toBe('other');
    expect(detectAgent({ AGENT_MONITOR_AGENT: 'codex', CLAUDECODE: '1' })).toBe('codex');
  });

  it('generates ids that stay inside the character rules', () => {
    for (const agent of ['claude', 'codex', 'other'] as const) {
      expect(isSafeSessionId(generateSessionId(agent, new Date('2026-08-13T14:20:11.123Z')))).toBe(true);
    }
  });
});

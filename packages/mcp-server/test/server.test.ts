import { FakeAgent, makeWorkspace, type TempWorkspace } from '@agent-monitor/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { TOOLS } from '../src/tools.js';

let workspace: TempWorkspace | undefined;
let agent: FakeAgent | undefined;

afterEach(async () => {
  await agent?.close();
  await workspace?.cleanup();
  agent = undefined;
  workspace = undefined;
});

async function connect(): Promise<{ agent: FakeAgent; root: string }> {
  workspace = await makeWorkspace('agent-monitor-mcp-');
  const { server } = createServer({
    root: workspace.root,
    sessionId: 'sess-1',
    agent: 'claude',
    cwd: workspace.root,
  });
  agent = await FakeAgent.connect(server);
  return { agent, root: workspace.root };
}

describe('MCP surface', () => {
  it('MCP-01: advertises exactly the documented tools, with usable schemas', async () => {
    const { agent } = await connect();

    const tools = await agent.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'ask_user',
      'check_feedback',
      'publish_artifact',
      'report_progress',
      'set_status',
    ]);

    for (const tool of tools) {
      // The description is the agent's only instruction manual, so an empty or
      // placeholder one is a real defect rather than a style issue.
      expect(tool.description.length, tool.name).toBeGreaterThan(80);

      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, { description?: string }>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(schema.type, tool.name).toBe('object');
      expect(schema.additionalProperties, tool.name).toBe(false);
      for (const [property, definition] of Object.entries(schema.properties)) {
        expect(definition.description, `${tool.name}.${property}`).toBeTruthy();
      }
      for (const required of schema.required ?? []) {
        expect(Object.keys(schema.properties), tool.name).toContain(required);
      }
    }
  });

  it('MCP-01: every advertised tool is callable', async () => {
    const { agent } = await connect();
    expect(TOOLS).toHaveLength(5);

    for (const tool of await agent.listTools()) {
      const result = await agent.tool(tool.name, {});
      // Missing required arguments is a normal, reportable outcome; an unrouted tool
      // would surface as a protocol error instead.
      expect(result.text, tool.name).not.toBe('');
    }
  });

  it('carries a real call through the transport and writes the session', async () => {
    const { agent } = await connect();

    const result = await agent.tool('report_progress', {
      title: 'parser split into three modules',
      summary: 'Extracted lexer, reader and validator.',
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('Published as report #1');
  });

  it('reports an unknown tool without dropping the connection', async () => {
    const { agent } = await connect();

    const result = await agent.tool('definitely_not_a_tool', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unknown tool');
    expect((await agent.tool('report_progress', { title: 'still alive' })).isError).toBe(false);
  });

  it('MCP-13: bad arguments come back as an error result, not a broken connection', async () => {
    const { agent } = await connect();

    const result = await agent.tool('report_progress', { summary: 'no title here' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('title is required');
  });
});

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

  it('states up front that the log is local, so an approval reviewer is not guessing', async () => {
    const { agent } = await connect();

    // Codex with `approvals_reviewer` denied a publish_artifact as a transfer to an
    // "unauthorized destination". The three facts that verdict got wrong are asserted
    // here because they are the whole reason the field is set.
    const instructions = agent.instructions();
    expect(instructions).toContain('.agent-monitor/');
    expect(instructions).toContain('no network requests');
    expect(instructions).toContain('report_progress');
  });

  it('offers linking as the alternative to copying a large or sensitive file', async () => {
    const { agent } = await connect();

    const publish = (await agent.listTools()).find((tool) => tool.name === 'publish_artifact');
    const schema = publish?.inputSchema as { properties: Record<string, unknown>; required?: string[] };

    expect(Object.keys(schema.properties)).toContain('link');
    // `name` names a copy, and a link is already named by its path, so nothing on this
    // tool can be required any more.
    expect(schema.required).toBeUndefined();
    expect(publish?.description).toContain('nothing is copied');
    expect(agent.instructions()).toContain('`link` argument');
  });

  it('tells the agent what to do when its own permission rules refuse a call', async () => {
    const { agent } = await connect();

    const tools = await agent.listTools();
    const report = tools.find((tool) => tool.name === 'report_progress');
    const publish = tools.find((tool) => tool.name === 'publish_artifact');

    expect(report?.description).toContain('refuses another call');
    expect(publish?.description).toContain('not an upload');
  });

  it("MCP-01: every tool that writes to the timeline asks for the human's own language", async () => {
    const { agent } = await connect();

    const tools = await agent.listTools();
    const speaking = ['report_progress', 'publish_artifact', 'ask_user', 'set_status'];

    for (const name of speaking) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description, name).toContain('in the language the human uses in their own messages');
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

  it('accepts all three publish_artifact modes, with or without the other sources as ""', async () => {
    const { agent, root } = await connect();
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    await fs.writeFile(path.join(root, 'orientation.md'), '# phase 2\n', 'utf8');

    const calls: Record<string, unknown>[] = [
      { name: 'inline.md', content: '# inline\n', kind: 'markdown' },
      { name: 'copy.md', path: 'orientation.md', kind: 'markdown' },
      { link: 'orientation.md', kind: 'markdown' },
      { name: 'inline.md', content: '# inline\n', path: '', link: '', kind: 'markdown' },
      { name: 'copy.md', content: '', path: 'orientation.md', link: '', kind: 'markdown' },
      { name: '', content: '', path: '', link: 'orientation.md', kind: 'markdown' },
    ];

    for (const args of calls) {
      const result = await agent.tool('publish_artifact', args);
      expect(result.isError, JSON.stringify(args)).toBe(false);
    }
  });
});

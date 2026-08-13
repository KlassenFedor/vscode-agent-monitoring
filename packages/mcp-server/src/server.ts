import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MonitorRuntime, type RuntimeOptions } from './runtime.js';
import { findTool, TOOLS } from './tools.js';

export const SERVER_NAME = 'agent-monitor';
export const SERVER_VERSION = '0.0.0';

export interface CreateServerResult {
  server: Server;
  runtime: MonitorRuntime;
}

/**
 * Wire the tool definitions to an MCP server.
 *
 * The transport is chosen by the caller: stdio for the real agents, an in-memory
 * pair for tests.
 */
export function createServer(options: RuntimeOptions): CreateServerResult {
  const runtime = new MonitorRuntime(options);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    // The runtime already converts failures into readable results; anything escaping
    // it is a bug in this package, and is still reported rather than crashing the
    // agent's connection.
    const result = await tool.run(runtime, request.params.arguments);
    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  });

  return { server, runtime };
}

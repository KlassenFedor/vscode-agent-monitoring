import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface ToolCallResult {
  /** Concatenated text content of the reply, which is what an agent actually reads. */
  text: string;
  isError: boolean;
  raw: unknown;
}

export interface ToolSummary {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Anything that can be connected to a transport — an MCP `Server`, structurally. */
export interface Connectable {
  connect(transport: Transport): Promise<void>;
}

/**
 * A scripted agent speaking real MCP.
 *
 * Deliberately not a language model: the suite must be deterministic, free and fast
 * (TESTS.md §1.1). Two flavours, both driving the same client:
 * in-memory for behaviour, a spawned process for the wiring an agent actually uses.
 */
export class FakeAgent {
  readonly #client: Client;
  readonly #transport: Transport;

  private constructor(client: Client, transport: Transport) {
    this.#client = client;
    this.#transport = transport;
  }

  /** Connect to a server object inside this process. Fast; no serialisation of code paths skipped. */
  static async connect(server: Connectable, name = 'fake-agent'): Promise<FakeAgent> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name, version: '0.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return new FakeAgent(client, clientTransport);
  }

  /** Launch the server as a child process over stdio, the way Claude Code and Codex do. */
  static async spawn(options: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<FakeAgent> {
    const transport = new StdioClientTransport({
      command: options.command,
      args: options.args ?? [],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...(process.env as Record<string, string>), ...options.env },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'fake-agent', version: '0.0.0' });
    await client.connect(transport);
    return new FakeAgent(client, transport);
  }

  async listTools(): Promise<ToolSummary[]> {
    const result = await this.#client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const result = (await this.#client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };

    const text = (result.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');

    return { text, isError: result.isError === true, raw: result };
  }

  async close(): Promise<void> {
    await this.#client.close();
    await this.#transport.close();
  }
}

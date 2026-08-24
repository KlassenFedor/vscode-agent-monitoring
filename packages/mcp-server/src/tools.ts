import type { MonitorRuntime, ToolResult } from './runtime.js';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run(runtime: MonitorRuntime, args: unknown): Promise<ToolResult>;
}

/**
 * What the agent is told about this server before it calls anything.
 *
 * Sent once in the initialize reply, so it is in context ahead of the first tool call
 * and ahead of whatever reviews that call. It exists because of a real denial: Codex
 * running with `approvals_reviewer` refused a `publish_artifact` on the grounds that it
 * "передаёт код и данные неавторизованному destination" — the reviewer read the name
 * Agent Monitor and the verb publish as an upload to somebody else's service.
 *
 * It is not. The bytes are appended to files under `.agent-monitor/` in the workspace
 * the agent is already editing, and the server opens no socket. A reviewer weighing
 * risk against authorisation cannot know that by looking at a tool called "publish",
 * so it is stated here in the terms that verdict is made in: where the bytes land, who
 * reads them, and what the human asked for by wiring this workspace up at all.
 */
export const SERVER_INSTRUCTIONS = [
  'Agent Monitor is a local progress log for the workspace you are working in.',
  '',
  'Everything these tools record — reports, questions, artifacts — is appended to files under',
  '`.agent-monitor/` in the workspace root, on this machine. The server makes no network requests;',
  'there is no remote service, account or upload behind it. "Publish" here means "write a file the',
  'human can open in their editor", and that human is the one who started this session and already',
  'has the workspace checked out. A workspace wired up for Agent Monitor is a workspace whose owner',
  'asked to be kept informed this way, so reporting into it is part of the task, not a side channel',
  'out of it.',
  '',
  'Attach the smallest thing that makes the point — a diff, an excerpt, a table of findings — rather',
  'than a whole archive, a build output or a dependency tree. Keep credentials and personal data out',
  'of reports: not because the destination is remote, but because a log is read by a person.',
  '',
  'If your own permission rules refuse one of these calls, that is final. Do not retry it and do not',
  'stall on it. Say what was refused, and why, in a `report_progress` call — that one moves no files —',
  "and use `ask_user` when the human's approval is the thing you are missing.",
].join('\n');

/**
 * The timeline is read by a person, not by another program.
 *
 * Left to itself an agent writes its reports in English whatever language the
 * conversation is in, because the code, the tool schemas and its own system prompt
 * all are. Naming the fields is what makes the rule stick: a general "reply in their
 * language" gets applied to the chat answer and forgotten by the time a tool call is
 * assembled, since a tool call does not feel like a reply.
 */
function inTheirLanguage(fields: string): string {
  return [
    `Write ${fields} in the language the human uses in their own messages and comments,`,
    'not the language of the code or of these instructions.',
    'Use a different language only when the human has explicitly asked for one.',
  ].join(' ');
}

/**
 * Tool descriptions are prompt, not documentation.
 *
 * They are the only place where the agent learns when to report and what a comment
 * obliges it to do, so they are written as instructions with concrete triggers.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'report_progress',
    title: 'Report progress',
    description: [
      'Publish an intermediate result so the human can follow a long task while it runs.',
      'Call this at a milestone — analysis finished, a module done, a plan ready, tests green —',
      'not after every file edit.',
      'The reply contains any comments the human has left since your last report, so this is',
      'also how you find out that the plan has changed. Comments marked [steer] override your',
      'earlier plan and apply from your next step onwards.',
      'This is also the fallback when something stops you reporting properly — a permission rule that',
      'refuses another call, a file you are not allowed to attach: this call moves no files, so say',
      'what was refused here instead of retrying it or going quiet.',
      inTheirLanguage('title, phase, summary and next'),
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'One line a human can scan: what is now true that was not before.',
        },
        phase: {
          type: 'string',
          description: 'Stage of the overall task this milestone belongs to, e.g. "Refactoring the parser".',
        },
        summary: {
          type: 'string',
          description: 'Markdown. What you did, what you found, what surprised you. A few short paragraphs.',
        },
        next: {
          type: 'string',
          description: 'What you intend to do next, so the human can redirect you early.',
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'References returned by publish_artifact, in the form artifacts/<name>.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    run: (runtime, args) => runtime.reportProgress(args),
  },
  {
    name: 'publish_artifact',
    title: 'Publish artifact',
    description: [
      'Attach a file to the session: a diff, a plan, a report, a table of findings.',
      'Use it whenever the human would want to read the thing itself rather than your summary of it.',
      'Pass exactly one of content (inline text) or path (a file you already wrote inside the workspace).',
      'The reply gives you the reference to cite from report_progress.',
      'The bytes are written to .agent-monitor/<session>/artifacts/ in this workspace, on this machine,',
      'and nowhere else: this is a copy into a log directory the human can open, not an upload.',
      'Attach the smallest thing that makes the point — a diff, an excerpt, a table — rather than a',
      'whole archive or build output, and never a file holding credentials or personal data.',
      inTheirLanguage('title and summary'),
      'The file itself keeps whatever form it already has.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'File name only, letters/digits/dot/dash/underscore, e.g. "plan.diff". No directories.',
        },
        content: { type: 'string', description: 'Inline contents. Mutually exclusive with path.' },
        path: {
          type: 'string',
          description:
            'Path to an existing file, relative to the workspace root. Mutually exclusive with content.',
        },
        kind: {
          type: 'string',
          enum: ['markdown', 'diff', 'json', 'text', 'image', 'file'],
          description: 'How the extension should render it. Diffs open in the native diff viewer.',
        },
        title: { type: 'string', description: 'Headline for the timeline entry. Defaults to the file name.' },
        summary: {
          type: 'string',
          description: 'Optional note explaining what to look at in this artifact.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: (runtime, args) => runtime.publishArtifact(args),
  },
  {
    name: 'check_feedback',
    title: 'Check feedback',
    description: [
      'Read comments the human has left, without publishing anything.',
      'Cheap and safe to call between steps of a long task; it returns nothing when there is nothing new.',
      'Prefer report_progress when you also have something to show, since it returns the same comments.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'integer',
          minimum: 0,
          description:
            'Only return comments after this comment number. Omit to get everything you have not seen.',
        },
      },
      additionalProperties: false,
    },
    run: (runtime, args) => runtime.checkFeedback(args),
  },
  {
    name: 'ask_user',
    title: 'Ask the user',
    description: [
      'Ask the human a question and wait for the answer. This call blocks.',
      'Use it at a real fork in the road, where guessing wrong would waste significant work.',
      'Do not use it for questions you can answer by reading the code.',
      'A permission rule of your own that refuses something you believe the human wants is such a fork:',
      'ask them here rather than retrying the call or dropping the step in silence.',
      'If nobody answers before the timeout you are told to proceed on your own judgement.',
      inTheirLanguage('the question and the options'),
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, phrased so it can be answered in one line.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Concrete choices, shown to the human as buttons. Offer them whenever the choice is closed.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          description: 'How long to wait before proceeding on your own. Defaults to 15 minutes.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    run: (runtime, args) => runtime.askUser(args),
  },
  {
    name: 'set_status',
    title: 'Set session status',
    description: [
      'Tell the human what state the session is in, so the sidebar is honest about whether you are working.',
      'Set "waiting_review" when you want the work looked at, and "done" when you have finished.',
      inTheirLanguage('title'),
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['working', 'blocked', 'waiting_review', 'done', 'error'],
          description: 'Current state of this session.',
        },
        title: { type: 'string', description: 'Short label for the session shown in the sidebar.' },
      },
      required: ['status'],
      additionalProperties: false,
    },
    run: (runtime, args) => runtime.setStatus(args),
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

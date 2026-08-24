import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { UnsafeNameError } from '../src/errors.js';
import {
  artifactFileName,
  artifactsDir,
  assertArtifactName,
  assertSessionId,
  eventsPath,
  isSafeArtifactName,
  resolveArtifactPath,
  resolveWorkspaceLink,
  assertWorkspaceLink,
  uniqueArtifactName,
} from '../src/paths.js';

describe('artifact names', () => {
  it('PROTO-40: accepts ordinary file names', () => {
    for (const name of ['report.md', '0007-plan.diff', 'a', 'A1-x.json']) {
      expect(isSafeArtifactName(name)).toBe(true);
      expect(assertArtifactName(name)).toBe(name);
    }
  });

  it('SEC-01: rejects every shape of path traversal', () => {
    const attacks = [
      '../../../etc/passwd',
      '..',
      '../x.md',
      'sub/dir.md',
      'sub\\dir.md',
      '/etc/passwd',
      'C:\\Windows\\system32',
      'report.md\0.txt',
      '.hidden',
      '',
    ];
    for (const name of attacks) {
      expect(() => assertArtifactName(name), name).toThrow(UnsafeNameError);
    }
  });

  it('SEC-01: rejects Windows device names and trailing dots', () => {
    for (const name of ['CON', 'nul.txt', 'COM1', 'lpt9.md', 'report.']) {
      expect(() => assertArtifactName(name), name).toThrow(UnsafeNameError);
    }
  });

  it('SEC-04: resolves only inside the session artifacts directory', () => {
    const root = path.resolve('/tmp/ws');
    const resolved = resolveArtifactPath(root, 'sess-1', 'report.md');

    expect(resolved.startsWith(path.resolve(artifactsDir(root, 'sess-1')) + path.sep)).toBe(true);
    expect(() => resolveArtifactPath(root, 'sess-1', '../../escape.md')).toThrow(UnsafeNameError);
  });

  it('MCP-07: picks a free name instead of overwriting', () => {
    expect(uniqueArtifactName([], 'report.md')).toBe('report.md');
    expect(uniqueArtifactName(['report.md'], 'report.md')).toBe('report-2.md');
    expect(uniqueArtifactName(['report.md', 'report-2.md'], 'report.md')).toBe('report-3.md');
    expect(uniqueArtifactName(['plan'], 'plan')).toBe('plan-2');
  });

  it('prefixes artifact files with a zero-padded sequence number', () => {
    expect(artifactFileName(7, 'report.md')).toBe('0007-report.md');
    expect(artifactFileName(1234, 'report.md')).toBe('1234-report.md');
  });
});

describe('session ids', () => {
  it('SEC-04: rejects ids that would escape the sessions directory', () => {
    for (const id of ['..', '../evil', 'a/b', 'a\\b', '', '.hidden', 'x'.repeat(200)]) {
      expect(() => assertSessionId(id), id).toThrow(UnsafeNameError);
    }
  });

  it('accepts the id shapes the agents actually produce', () => {
    for (const id of ['cb80ff2c-6b84-438e-93c2-3d70992ea969', 'codex.2026-08-13T14-20-11', 'sess-1']) {
      expect(assertSessionId(id)).toBe(id);
    }
  });

  it('builds paths under the workspace monitor directory', () => {
    const events = eventsPath('/work', 'sess-1');
    expect(events).toBe(path.join('/work', '.agent-monitor', 'sessions', 'sess-1', 'events.jsonl'));
  });
});

describe('workspace links', () => {
  it('canonicalises a path to POSIX form the machine that opens it can use', () => {
    expect(assertWorkspaceLink('src/parser.ts')).toBe('src/parser.ts');
    expect(assertWorkspaceLink('./src/parser.ts')).toBe('src/parser.ts');
    expect(assertWorkspaceLink('src\\core\\parser.ts')).toBe('src/core/parser.ts');
    expect(assertWorkspaceLink('src//core///parser.ts')).toBe('src/core/parser.ts');
  });

  it('SEC-04: refuses anything that does not stay inside the workspace', () => {
    const bad = [
      '',
      '.',
      '/etc/passwd',
      'C:\\Windows\\system.ini',
      '../secrets.env',
      'src/../../secrets.env',
      '..\\secrets.env',
      'src/pars\u0000er.ts',
      `${'a'.repeat(1025)}`,
    ];

    for (const value of bad) {
      expect(() => assertWorkspaceLink(value), JSON.stringify(value)).toThrow(UnsafeNameError);
    }
  });

  it('SEC-04: resolves only inside the workspace root', () => {
    const root = path.join(path.sep, 'work', 'project');

    expect(resolveWorkspaceLink(root, 'src/parser.ts')).toBe(path.join(root, 'src', 'parser.ts'));
    expect(() => resolveWorkspaceLink(root, '../other/secrets.env')).toThrow(UnsafeNameError);
  });

  it('does not mistake a sibling directory with the same prefix for the workspace', () => {
    const root = path.join(path.sep, 'work', 'project');

    // `/work/project-2` starts with `/work/project`, and only the separator in the
    // containment check keeps it out.
    expect(() => resolveWorkspaceLink(root, '../project-2/secrets.env')).toThrow(UnsafeNameError);
  });
});

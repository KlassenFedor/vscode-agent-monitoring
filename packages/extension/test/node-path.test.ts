import { describe, expect, it } from 'vitest';

import { isEphemeralNode, looksLikeNode, resolveNodePath } from '../src/core/node-path.js';

const SERVER_NODE = '/home/u/.vscode-server/bin/a5b500951314efd502d07465bd138dfbd714a960/node';
const ELECTRON = '/usr/share/code/code';

/** Only the listed files exist. */
function only(...present: string[]): (file: string) => Promise<boolean> {
  return async (file) => present.includes(file);
}

/** Every candidate reports the same version. */
function version(major: number | null): (file: string) => Promise<number | null> {
  return async () => major;
}

describe('EXT-37: choosing the node the agents will run', () => {
  it('recognises the binary that VS Code replaces on every update', () => {
    expect(isEphemeralNode(SERVER_NODE)).toBe(true);
    expect(isEphemeralNode('C:\\Users\\u\\.vscode-server\\bin\\abc123\\node.exe')).toBe(true);
    expect(isEphemeralNode('/usr/bin/node')).toBe(false);
    expect(isEphemeralNode('/home/u/projects/node/bin/node')).toBe(false);
  });

  it('recognises VS Code itself, which is not a node at all', () => {
    expect(looksLikeNode(ELECTRON)).toBe(false);
    expect(looksLikeNode('/usr/bin/node')).toBe(true);
    expect(looksLikeNode('C:\\Program Files\\nodejs\\node.exe')).toBe(true);
  });

  it('prefers a node on PATH over the extension host that will disappear', async () => {
    const resolved = await resolveNodePath({
      execPath: SERVER_NODE,
      pathEnv: '/usr/local/bin:/usr/bin',
      platform: 'linux',
      exists: only('/usr/bin/node', SERVER_NODE),
      majorVersion: version(20),
    });

    expect(resolved.path).toBe('/usr/bin/node');
    expect(resolved.source).toBe('path');
    expect(resolved.warning).toBeUndefined();
  });

  it('prefers a node on PATH over the desktop Electron binary', async () => {
    const resolved = await resolveNodePath({
      execPath: ELECTRON,
      pathEnv: '/usr/bin',
      platform: 'linux',
      exists: only('/usr/bin/node', ELECTRON),
      majorVersion: version(22),
    });

    expect(resolved.path).toBe('/usr/bin/node');
  });

  it('keeps a stable host node ahead of PATH', async () => {
    const resolved = await resolveNodePath({
      execPath: '/opt/node/bin/node',
      pathEnv: '/usr/bin',
      platform: 'linux',
      exists: only('/opt/node/bin/node', '/usr/bin/node'),
      majorVersion: version(20),
    });

    expect(resolved.path).toBe('/opt/node/bin/node');
    expect(resolved.warning).toBeUndefined();
  });

  it('skips a node that is too old for the bundles', async () => {
    const resolved = await resolveNodePath({
      execPath: SERVER_NODE,
      pathEnv: '/old/bin:/usr/bin',
      platform: 'linux',
      exists: only('/old/bin/node', '/usr/bin/node'),
      majorVersion: async (file) => (file === '/old/bin/node' ? 18 : 20),
    });

    expect(resolved.path).toBe('/usr/bin/node');
  });

  it('says so when the only node it can find is too old', async () => {
    const resolved = await resolveNodePath({
      execPath: SERVER_NODE,
      pathEnv: '/old/bin',
      platform: 'linux',
      exists: only('/old/bin/node'),
      majorVersion: version(18),
    });

    expect(resolved.path).toBe('/old/bin/node');
    expect(resolved.warning).toContain('Node 18');
  });

  it('falls back to the host binary and warns that it will not last', async () => {
    // Setup must still produce a working configuration: the alternative is refusing to
    // set the workspace up at all, which helps nobody.
    const resolved = await resolveNodePath({
      execPath: SERVER_NODE,
      pathEnv: '/usr/bin',
      platform: 'linux',
      exists: only(SERVER_NODE),
      majorVersion: version(null),
    });

    expect(resolved.path).toBe(SERVER_NODE);
    expect(resolved.source).toBe('execPath');
    expect(resolved.warning).toMatch(/update/);
  });

  it('looks for node.exe and splits PATH with a semicolon on Windows', async () => {
    const resolved = await resolveNodePath({
      execPath: 'C:\\Users\\u\\.vscode-server\\bin\\abc\\node.exe',
      pathEnv: 'C:\\Windows;C:\\Program Files\\nodejs',
      platform: 'win32',
      exists: only('C:\\Program Files\\nodejs\\node.exe'),
      majorVersion: version(20),
    });

    expect(resolved.path).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('survives an environment with no PATH at all', async () => {
    const resolved = await resolveNodePath({
      execPath: SERVER_NODE,
      platform: 'linux',
      exists: only(SERVER_NODE),
      majorVersion: version(20),
    });

    expect(resolved.path).toBe(SERVER_NODE);
    expect(resolved.warning).toBeDefined();
  });
});

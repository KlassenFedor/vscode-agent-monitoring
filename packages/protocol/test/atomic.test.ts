import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJsonFile, writeFileAtomic, writeJsonAtomic } from '../src/atomic.js';
import { CorruptFileError } from '../src/errors.js';
import { makeRoot, writeText } from './helpers.js';

describe('writeJsonAtomic', () => {
  it('PROTO-04: a concurrent reader never observes a partial file', async () => {
    const file = path.join(await makeRoot(), 'meta.json');
    await writeJsonAtomic(file, { version: 0 });

    const payload = { blob: 'x'.repeat(200_000) };
    let stop = false;
    const observed: unknown[] = [];

    const reader = (async () => {
      while (!stop) {
        const value = await readJsonFile(file);
        observed.push(value);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    for (let version = 1; version <= 20; version += 1) {
      await writeJsonAtomic(file, { version, ...payload });
    }
    stop = true;
    await reader;

    expect(observed.length).toBeGreaterThan(5);
    for (const value of observed) {
      // Every observation is a whole document: either the seed or one full write.
      expect(value).not.toBeNull();
      const record = value as { version: number; blob?: string };
      if (record.version === 0) continue;
      expect(record.blob).toHaveLength(200_000);
    }
  });

  it('PROTO-04: leaves no temporary files behind', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'meta.json');

    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });

    expect((await fs.readdir(root)).sort()).toEqual(['meta.json']);
    expect(await readJsonFile(file)).toEqual({ a: 2 });
  });

  it('creates missing parent directories', async () => {
    const file = path.join(await makeRoot(), 'deep', 'nested', 'meta.json');
    await writeJsonAtomic(file, { ok: true });
    expect(await readJsonFile(file)).toEqual({ ok: true });
  });

  it('writes arbitrary payloads through the same path', async () => {
    const file = path.join(await makeRoot(), 'artifact.bin');
    await writeFileAtomic(file, Buffer.from([0, 1, 2, 255]));
    expect([...(await fs.readFile(file))]).toEqual([0, 1, 2, 255]);
  });
});

describe('readJsonFile', () => {
  it('PROTO-13: answers null for a missing file or directory', async () => {
    const root = await makeRoot();
    expect(await readJsonFile(path.join(root, 'meta.json'))).toBeNull();
    expect(await readJsonFile(path.join(root, 'nope', 'meta.json'))).toBeNull();
  });

  it('PROTO-10: reports corrupt content instead of pretending the file is empty', async () => {
    const file = path.join(await makeRoot(), 'meta.json');
    await writeText(file, '{ truncated');
    await expect(readJsonFile(file)).rejects.toThrow(CorruptFileError);
  });

  it('PROTO-15: tolerates a byte order mark', async () => {
    const file = path.join(await makeRoot(), 'meta.json');
    await writeText(file, '﻿{"a":1}');
    expect(await readJsonFile(file)).toEqual({ a: 1 });
  });
});

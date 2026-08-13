import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { RecordTooLargeError } from './errors.js';
import { ensureDir, statOrNull } from './fsutil.js';
import { withFileLock } from './lock.js';
import { lockPathFor } from './paths.js';

const NEWLINE = 0x0a;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Cap on one serialised line.
 *
 * The lock makes appends atomic for well-behaved writers; the cap is the second
 * defence, keeping a line small enough that a single `write` syscall lands whole
 * even if something appends without taking the lock (a shell script, a future
 * writer in another language). Anything bigger belongs in `artifacts/`.
 */
export const MAX_RECORD_BYTES = 4096;

export interface JsonlChunk<T> {
  records: T[];
  /** Offset to pass to the next read. Stops before an unterminated trailing line. */
  nextOffset: number;
  /** Lines that were skipped because they did not parse or did not validate. */
  skipped: number;
  /** The file shrank or vanished, so reading restarted from the beginning. */
  reset: boolean;
}

/**
 * Read the records appended after `offset`.
 *
 * Only whole lines are consumed: a trailing fragment (a writer killed mid-append,
 * TESTS.md PROTO-11) is left unread, and `nextOffset` stops in front of it. The
 * next append heals the file by starting on a fresh line, at which point the
 * fragment becomes a complete but unparsable line and is reported as skipped.
 */
export async function readJsonl<T>(
  filePath: string,
  offset: number,
  parse: (raw: unknown) => T,
): Promise<JsonlChunk<T>> {
  const stats = await statOrNull(filePath);
  if (!stats) return { records: [], nextOffset: 0, skipped: 0, reset: offset > 0 };

  let start = offset;
  let reset = false;
  if (start > stats.size) {
    // Truncated or replaced underneath us; the safe move is to re-read from zero.
    start = 0;
    reset = true;
  }
  if (start === stats.size) return { records: [], nextOffset: start, skipped: 0, reset };

  const buffer = await readRange(filePath, start, stats.size);
  const lastNewline = buffer.lastIndexOf(NEWLINE);
  if (lastNewline === -1) return { records: [], nextOffset: start, skipped: 0, reset };

  const consumedBytes = lastNewline + 1;
  const dataStart = start === 0 && buffer.subarray(0, 3).equals(BOM) ? 3 : 0;
  const text = buffer.subarray(dataStart, consumedBytes).toString('utf8');

  const records: T[] = [];
  let skipped = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;
    try {
      records.push(parse(JSON.parse(line)));
    } catch {
      skipped += 1;
    }
  }

  return { records, nextOffset: start + consumedBytes, skipped, reset };
}

async function readRange(filePath: string, start: number, end: number): Promise<Buffer> {
  const length = end - start;
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface JsonlAppenderOptions {
  maxRecordBytes?: number;
  lockTimeoutMs?: number;
}

/**
 * Append-only writer that assigns each record its `seq` under the file lock.
 *
 * The line count is tracked incrementally: only the bytes appended since the last
 * append are re-read, so a session with hundreds of events does not degrade into
 * re-reading the whole file on every write (TESTS.md PROTO-03).
 */
export class JsonlAppender {
  readonly filePath: string;

  readonly #lockPath: string;
  readonly #maxRecordBytes: number;
  readonly #lockTimeoutMs: number | undefined;

  /** Bytes already accounted for in `#lines`. */
  #scanned = 0;
  /** Newlines seen in the first `#scanned` bytes. */
  #lines = 0;
  /** The file ends with a line that was never terminated. */
  #partial = false;

  constructor(filePath: string, options: JsonlAppenderOptions = {}) {
    this.filePath = filePath;
    this.#lockPath = lockPathFor(filePath);
    this.#maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
    this.#lockTimeoutMs = options.lockTimeoutMs;
  }

  /**
   * Append one record. `build` receives the sequence number, which is only known
   * once the lock is held and the current line count is known.
   */
  async append<T>(build: (seq: number) => T): Promise<T> {
    const lockOptions = this.#lockTimeoutMs === undefined ? {} : { timeoutMs: this.#lockTimeoutMs };
    return withFileLock(
      this.#lockPath,
      async () => {
        const seq = await this.#nextSeq();
        const record = build(seq);
        const line = JSON.stringify(record);
        if (line === undefined) throw new TypeError('record is not JSON-serialisable');

        const payload = Buffer.from(`${line}\n`, 'utf8');
        if (payload.byteLength > this.#maxRecordBytes) {
          throw new RecordTooLargeError(payload.byteLength, this.#maxRecordBytes);
        }
        await this.#writeLine(payload);
        return record;
      },
      lockOptions,
    );
  }

  /** Forget cached counters, e.g. after the file was replaced out of band. */
  reset(): void {
    this.#scanned = 0;
    this.#lines = 0;
    this.#partial = false;
  }

  async #nextSeq(): Promise<number> {
    const stats = await statOrNull(this.filePath);
    if (!stats) {
      this.reset();
      return 1;
    }
    if (stats.size < this.#scanned) this.reset();

    if (stats.size > this.#scanned) {
      const delta = await readRange(this.filePath, this.#scanned, stats.size);
      for (const byte of delta) if (byte === NEWLINE) this.#lines += 1;
      this.#partial = delta.length > 0 && delta[delta.length - 1] !== NEWLINE;
      this.#scanned = stats.size;
    }

    // A trailing fragment becomes its own (unparsable) line once we heal the file,
    // so it consumes a sequence number. Gaps are fine; monotonicity is what matters.
    return this.#lines + (this.#partial ? 1 : 0) + 1;
  }

  async #writeLine(payload: Buffer): Promise<void> {
    const buffer = this.#partial ? Buffer.concat([Buffer.from([NEWLINE]), payload]) : payload;

    await ensureDir(path.dirname(this.filePath));
    const handle = await fs.open(this.filePath, 'a');
    try {
      const { bytesWritten } = await handle.write(buffer);
      if (bytesWritten !== buffer.byteLength) {
        throw new Error(`short write: ${bytesWritten} of ${buffer.byteLength} bytes`);
      }
    } catch (error) {
      // The cached counters can no longer be trusted after a failed write.
      this.reset();
      throw error;
    } finally {
      await handle.close();
    }

    this.#lines += this.#partial ? 2 : 1;
    this.#scanned += buffer.byteLength;
    this.#partial = false;
  }
}

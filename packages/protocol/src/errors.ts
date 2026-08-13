/**
 * Errors thrown on purpose by the protocol layer.
 *
 * Every one of them carries a stable `code`, because these errors cross process
 * boundaries: the MCP server turns them into tool results the agent reads, and the
 * hook CLI turns them into exit codes. Matching on message text would be fragile.
 */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A record, or one of its fields, does not match the schema. */
export class ValidationError extends ProtocolError {
  readonly field: string;

  constructor(field: string, message: string) {
    super('E_VALIDATION', `${field}: ${message}`);
    this.field = field;
  }
}

/**
 * A single JSONL line exceeded the size limit.
 *
 * Large payloads belong in `artifacts/`, referenced from the event by path. See
 * {@link ../../../docs/DESIGN.md} §2 for why the line size is capped.
 */
export class RecordTooLargeError extends ProtocolError {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(
      'E_RECORD_TOO_LARGE',
      `record is ${bytes} bytes, limit is ${limit}; write the payload to artifacts/ and reference it from the event instead`,
    );
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** Could not acquire the file lock before the deadline. */
export class LockTimeoutError extends ProtocolError {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super('E_LOCK_TIMEOUT', `could not acquire lock ${lockPath} within ${timeoutMs}ms`);
    this.lockPath = lockPath;
  }
}

/** A caller-supplied name would have escaped the directory it belongs to. */
export class UnsafeNameError extends ProtocolError {
  readonly value: string;

  constructor(value: string, reason: string) {
    super('E_UNSAFE_NAME', `unsafe name ${JSON.stringify(value)}: ${reason}`);
    this.value = value;
  }
}

/** A file that must hold JSON could not be parsed. */
export class CorruptFileError extends ProtocolError {
  readonly filePath: string;

  constructor(filePath: string, cause?: unknown) {
    super('E_CORRUPT_FILE', `file is not valid JSON: ${filePath}`, { cause });
    this.filePath = filePath;
  }
}

/**
 * Argument checking for tool calls.
 *
 * Tool arguments arrive from a language model, so "wrong shape" is an everyday event
 * rather than a bug. Each failure names the field and says what was expected, because
 * that message goes straight back into the agent's context and is the only thing it
 * can act on.
 */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgumentError('arguments must be an object');
  }
  return raw as Record<string, unknown>;
}

export function requiredString(
  args: Record<string, unknown>,
  field: string,
  options: { maxLength?: number } = {},
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArgumentError(`${field} is required and must be a non-empty string`);
  }
  const maxLength = options.maxLength ?? 10_000;
  if (value.length > maxLength) {
    throw new ArgumentError(`${field} is ${value.length} characters, limit is ${maxLength}`);
  }
  return value;
}

/**
 * A string field the caller may leave out.
 *
 * `blankIsAbsent` is for fields that pick a mode, like the three sources of
 * `publish_artifact`. Some clients fill every property of the schema, sending `""`
 * for the ones the model did not choose; read strictly, the unchosen field is then
 * "given and empty", and the agent is told a field it deliberately left out is
 * required. For a mode switch an empty value can only mean "not this one".
 */
export function optionalString(
  args: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; blankIsAbsent?: boolean } = {},
): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') {
    if (options.blankIsAbsent) return undefined;
    throw new ArgumentError(`${field} is optional, but when given must be a non-empty string`);
  }
  return requiredString(args, field, options);
}

export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ArgumentError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function requiredEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = optionalEnum(args, field, allowed);
  if (value === undefined) throw new ArgumentError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function optionalStringArray(
  args: Record<string, unknown>,
  field: string,
  options: { maxItems?: number } = {},
): string[] | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ArgumentError(`${field} must be an array of strings`);
  const maxItems = options.maxItems ?? 20;
  if (value.length > maxItems) {
    throw new ArgumentError(`${field} has ${value.length} entries, limit is ${maxItems}`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ArgumentError(`${field}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

export function optionalInt(
  args: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ArgumentError(`${field} must be an integer`);
  }
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw new ArgumentError(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

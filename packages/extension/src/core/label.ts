/**
 * What may be shown in front of a session's title in the list.
 *
 * The order here is the order on screen, whatever order the setting lists them in:
 * a column of rows whose prefixes are assembled differently cannot be read down.
 */
export const SESSION_LABEL_EXTRAS = ['agent', 'created', 'updated'] as const;

export type SessionLabelExtra = (typeof SESSION_LABEL_EXTRAS)[number];

/** The setting is user input: anything unknown in it is dropped, never thrown over. */
export function parseLabelExtras(raw: unknown): SessionLabelExtra[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((value): value is string => typeof value === 'string'));
  return SESSION_LABEL_EXTRAS.filter((extra) => wanted.has(extra));
}

export interface LabelFacts {
  /** `claude`, `codex`. */
  agent?: string | null | undefined;
  /** When the session started, ISO-8601. */
  createdAt?: string | null | undefined;
  /** When it was last active, ISO-8601. */
  updatedAt?: string | null | undefined;
}

/**
 * Put the chosen extras in front of a title.
 *
 * Bracketed and prefixed rather than appended: the title is written by a language
 * model and is routinely long enough to be cut off by the sidebar, which would take
 * the extras with it. A fact that is not known is left out rather than shown empty —
 * a transcript-only session has no start time, and `[]` in its place says nothing.
 */
export function decorateLabel(
  title: string,
  facts: LabelFacts,
  extras: readonly SessionLabelExtra[],
  nowMs: number,
  offsetMinutes?: number,
): string {
  if (extras.length === 0) return title;

  const parts: string[] = [];
  for (const extra of SESSION_LABEL_EXTRAS) {
    if (!extras.includes(extra)) continue;

    if (extra === 'agent') {
      if (facts.agent) parts.push(`[${facts.agent}]`);
      continue;
    }
    const ts = extra === 'created' ? facts.createdAt : facts.updatedAt;
    if (ts) parts.push(`[${formatStamp(ts, nowMs, offsetMinutes)}]`);
  }

  return parts.length === 0 ? title : `${parts.join(' ')} ${title}`;
}

/**
 * `14:32` today, `21.08 14:32` on any other day, on the reader's own clock.
 *
 * Seconds are deliberately absent: this sits in front of a title in a narrow sidebar,
 * where every character costs the title one, and nobody reads a list of sessions to
 * the second. The date appears only when it changes the answer — without it a row
 * from last week is indistinguishable from one from this morning.
 *
 * @param offsetMinutes Minutes east of UTC. Defaults to the machine's own offset;
 *   named explicitly by tests, which must not depend on where they run.
 */
export function formatStamp(ts: string, nowMs: number, offsetMinutes?: number): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;

  const offset = offsetMinutes ?? -new Date(parsed).getTimezoneOffset();
  const local = new Date(parsed + offset * 60_000).toISOString();
  const nowOffset = offsetMinutes ?? -new Date(nowMs).getTimezoneOffset();
  const localNow = new Date(nowMs + nowOffset * 60_000).toISOString();

  const time = local.slice(11, 16);
  if (local.slice(0, 10) === localNow.slice(0, 10)) return time;
  return `${local.slice(8, 10)}.${local.slice(5, 7)} ${time}`;
}

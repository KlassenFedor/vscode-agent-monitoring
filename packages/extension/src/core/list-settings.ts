import { SESSION_LABEL_EXTRAS, type SessionLabelExtra } from './label.js';

/**
 * The words and numbers behind the Sessions list's own settings menu.
 *
 * The menu itself is VS Code quick picks (`ui/list-settings.ts`); everything it has to
 * decide — what a typed number means, how a value reads back, when two settings fight —
 * lives here, where a test can reach it.
 */

export const DAY_MS = 24 * 60 * 60_000;

/** Choices offered before "Custom…", in days. `0` is "off". */
export const ARCHIVE_PRESETS = [0, 1, 3, 7, 14, 30] as const;
export const DELETE_PRESETS = [0, 7, 14, 30, 90] as const;

export const LABEL_EXTRA_NAMES: Record<SessionLabelExtra, string> = {
  agent: 'Agent',
  created: 'Created',
  updated: 'Updated',
};

export const LABEL_EXTRA_DETAILS: Record<SessionLabelExtra, string> = {
  agent: 'The agent that owns the session, as [claude] or [codex].',
  created: 'When the session started.',
  updated: 'When the session was last active.',
};

/**
 * A day count from a setting.
 *
 * The setting is user input like any other: a negative, a string or `NaN` in it is
 * not a reason to archive or delete anything, so it falls back to the default.
 */
export function readDays(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function daysToMs(days: number): number {
  return days * DAY_MS;
}

/**
 * A day count as typed into the input box, or null when it is not one.
 *
 * A decimal comma is accepted: this is typed by people whose keyboards put one there.
 */
export function parseDays(input: string): number | null {
  const text = input.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const days = Number(text);
  return Number.isFinite(days) ? days : null;
}

/** `off`, `after 1 day`, `after 14 days`. */
export function describeDays(days: number): string {
  if (days <= 0) return 'off';
  return `after ${days} day${days === 1 ? '' : 's'}`;
}

/** What the list puts in front of a title, in the order it is shown. */
export function describeLabelExtras(extras: readonly SessionLabelExtra[]): string {
  const shown = SESSION_LABEL_EXTRAS.filter((extra) => extras.includes(extra));
  if (shown.length === 0) return 'title only';
  return shown.map((extra) => LABEL_EXTRA_NAMES[extra].toLowerCase()).join(', ');
}

/**
 * Said when the two timers are set so that one of them can never fire.
 *
 * Both count from the same moment, so a session deleted after 7 days is never there to
 * be archived after 14. Not refused: turning deletion up or archiving down is a
 * reasonable next step, and the menu should not stand in the way of either — but the
 * human should know which of the two is doing nothing.
 */
export function retentionConflict(archiveDays: number, deleteDays: number): string | undefined {
  if (archiveDays <= 0 || deleteDays <= 0 || archiveDays < deleteDays) return undefined;
  return `Sessions are deleted after ${deleteDays} day(s), before they are old enough to be archived.`;
}

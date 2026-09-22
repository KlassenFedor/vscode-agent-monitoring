import * as vscode from 'vscode';

import { parseLabelExtras, SESSION_LABEL_EXTRAS } from '../core/label.js';
import {
  ARCHIVE_PRESETS,
  DELETE_PRESETS,
  describeDays,
  describeLabelExtras,
  LABEL_EXTRA_DETAILS,
  LABEL_EXTRA_NAMES,
  parseDays,
  readDays,
  retentionConflict,
} from '../core/list-settings.js';

export interface ListSettingsDeps {
  /** `context.extension.id`, for the "all settings" entry. */
  extensionId: string;
  /** Redraw the list, so a changed label shows at once. */
  refresh: () => Promise<void>;
  /** Archive and delete by the settings as they are now. */
  applyRetention: () => Promise<void>;
  /** Titles of the visible sessions a delete deadline of `days` would remove right now. */
  previewDeletion: (days: number) => Promise<string[]>;
}

type Choice = 'labels' | 'archive' | 'delete' | 'all';

/**
 * The Sessions list's settings, from the list itself.
 *
 * The same `agentMonitor.*` settings as the Settings editor — one source of truth, so a
 * value changed here reads back there and the other way round. Written wherever the
 * value in effect already comes from: a workspace that overrides a setting keeps
 * overriding it, rather than having a user-level write silently lose to it.
 *
 * The menu comes back after every change, with the new value in it, until dismissed:
 * it is a handful of settings that are usually adjusted together.
 */
export async function configureSessionList(deps: ListSettingsDeps): Promise<void> {
  for (;;) {
    const choice = await pickSetting();
    if (choice === undefined) return;
    if (choice === 'all') {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${deps.extensionId}`);
      return;
    }

    try {
      if (choice === 'labels') await editLabels(deps);
      else if (choice === 'archive') await editArchive(deps);
      else await editDelete(deps);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Agent Monitor could not save the setting: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  }
}

interface Current {
  labels: ReturnType<typeof parseLabelExtras>;
  archiveDays: number;
  deleteDays: number;
}

function current(): Current {
  const config = vscode.workspace.getConfiguration('agentMonitor');
  return {
    labels: parseLabelExtras(config.get('sessionLabelExtras')),
    archiveDays: readDays(config.get('archiveSessionsAfterDays'), 0),
    deleteDays: readDays(config.get('keepSessionsForDays'), 14),
  };
}

async function pickSetting(): Promise<Choice | undefined> {
  const now = current();
  const conflict = retentionConflict(now.archiveDays, now.deleteDays);

  const items: (vscode.QuickPickItem & { choice?: Choice })[] = [
    {
      label: '$(tag) Session titles',
      description: describeLabelExtras(now.labels),
      detail: 'What is shown in front of each title: agent, start time, last activity.',
      choice: 'labels',
    },
    {
      label: '$(archive) Auto-archive',
      description: describeDays(now.archiveDays),
      detail: conflict ?? 'Move sessions with no activity for a while into the Archived folder.',
      choice: 'archive',
    },
    {
      label: '$(trash) Auto-delete',
      description: describeDays(now.deleteDays),
      detail: 'Delete sessions with no activity for a while, archived or not. Cannot be undone.',
      choice: 'delete',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(settings-gear) All Agent Monitor settings', choice: 'all' },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Sessions list settings',
    placeHolder: 'Press Escape when done',
    ignoreFocusOut: true,
  });
  return picked?.choice;
}

async function editLabels(deps: ListSettingsDeps): Promise<void> {
  const { labels } = current();
  const picked = await vscode.window.showQuickPick(
    SESSION_LABEL_EXTRAS.map((extra) => ({
      label: LABEL_EXTRA_NAMES[extra],
      detail: LABEL_EXTRA_DETAILS[extra],
      picked: labels.includes(extra),
      extra,
    })),
    {
      title: 'Show in front of session titles',
      placeHolder: 'Tick any combination; none shows the title on its own',
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picked) return;

  const next = parseLabelExtras(picked.map((item) => item.extra));
  if (next.join() === labels.join()) return;

  await updateSetting('sessionLabelExtras', next);
  await deps.refresh();
}

async function editArchive(deps: ListSettingsDeps): Promise<void> {
  const { archiveDays } = current();
  const days = await pickDays({
    title: 'Archive sessions with no activity for…',
    current: archiveDays,
    presets: ARCHIVE_PRESETS,
  });
  if (days === undefined || days === archiveDays) return;

  // Nothing to confirm: archiving is one click from undone, per session.
  await updateSetting('archiveSessionsAfterDays', days);
  await deps.applyRetention();
}

async function editDelete(deps: ListSettingsDeps): Promise<void> {
  const { deleteDays } = current();
  const days = await pickDays({
    title: 'Delete sessions with no activity for…',
    current: deleteDays,
    presets: DELETE_PRESETS,
  });
  if (days === undefined || days === deleteDays) return;

  // The new deadline applies as soon as it is saved, so what it takes with it is said
  // first, by name — the same courtesy the delete button extends to a single session.
  if (days > 0) {
    const doomed = await deps.previewDeletion(days);
    if (doomed.length > 0) {
      const remove = 'Delete and Save';
      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${doomed.length} session(s) now?`,
        {
          modal: true,
          detail: [
            `They have had no activity for more than ${days} day(s):`,
            ...doomed.slice(0, 8).map((title) => `• ${title}`),
            doomed.length > 8 ? `…and ${doomed.length - 8} more.` : '',
            '\nTheir reports, comments and artefacts are removed from .agent-monitor/. This cannot be undone.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        remove,
      );
      if (confirmed !== remove) return;
    }
  }

  await updateSetting('keepSessionsForDays', days);
  await deps.applyRetention();
}

/** A preset, or a number typed in; `undefined` when the human backed out. */
async function pickDays(options: {
  title: string;
  current: number;
  presets: readonly number[];
}): Promise<number | undefined> {
  const custom = 'custom';
  const items: (vscode.QuickPickItem & { days: number | typeof custom })[] = [
    ...options.presets.map((days) => ({
      label: days === 0 ? 'Off' : `${days} day${days === 1 ? '' : 's'}`,
      ...(days === options.current ? { description: '$(check) current' } : {}),
      days,
    })),
    {
      label: 'Custom…',
      ...(options.presets.includes(options.current)
        ? {}
        : { description: `$(check) current: ${describeDays(options.current)}` }),
      days: custom,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, { title: options.title, ignoreFocusOut: true });
  if (!picked) return undefined;
  if (picked.days !== custom) return picked.days;

  const typed = await vscode.window.showInputBox({
    title: options.title,
    prompt: 'Number of days; fractions are fine. 0 turns it off.',
    value: String(options.current),
    ignoreFocusOut: true,
    validateInput: (value) => (parseDays(value) === null ? 'Enter a number of days, 0 or more.' : undefined),
  });
  return typed === undefined ? undefined : (parseDays(typed) ?? undefined);
}

/**
 * Save where the value in effect comes from.
 *
 * A user-level write under a workspace override changes nothing the human can see —
 * the menu would show the old value straight back.
 */
async function updateSetting(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration('agentMonitor');
  const where = config.inspect(key);
  // No folder-level target: these settings are window-scoped, and VS Code refuses a
  // folder-level write to one.
  const target =
    where?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

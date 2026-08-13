/**
 * How an artifact should be opened.
 *
 * VS Code already has good viewers for all of these, so the extension routes to them
 * instead of rendering anything itself inside the webview (TESTS.md EXT-05).
 */
export type ArtifactOpenKind = 'diff' | 'markdown' | 'image' | 'text';

const EXTENSIONS: Record<string, ArtifactOpenKind> = {
  '.diff': 'diff',
  '.patch': 'diff',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
};

const DECLARED: Record<string, ArtifactOpenKind> = {
  diff: 'diff',
  markdown: 'markdown',
  image: 'image',
  json: 'text',
  text: 'text',
  file: 'text',
};

/**
 * The file name wins over the agent's declared kind: the agent may call a file
 * "markdown" out of habit, but a `.diff` opens best in the diff viewer regardless.
 */
export function openKindFor(ref: string, declaredKind?: unknown): ArtifactOpenKind {
  const lower = ref.toLowerCase();
  for (const [extension, kind] of Object.entries(EXTENSIONS)) {
    if (lower.endsWith(extension)) return kind;
  }
  if (typeof declaredKind === 'string' && declaredKind in DECLARED) {
    return DECLARED[declaredKind] as ArtifactOpenKind;
  }
  return 'text';
}

/** File name shown on an artifact chip. */
export function artifactLabel(ref: string): string {
  const slash = ref.lastIndexOf('/');
  return slash === -1 ? ref : ref.slice(slash + 1);
}

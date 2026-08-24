export interface TreeRefresh {
  /** Redraw the whole tree: rows appeared, vanished, or changed places. */
  all: boolean;
  /** Rows to redraw on their own, in list order. Empty when `all` is set. */
  keys: string[];
}

/**
 * What the sessions list actually has to redraw.
 *
 * The list is rebuilt on every watcher tick — about once a second — and almost every
 * tick finds the same rows saying the same thing. Redrawing regardless is not merely
 * wasteful: a redrawn row loses its hover, so the tooltip on a session name appeared
 * and vanished within the second, and the tooltip on an inline button flickered as
 * the button was rebuilt under the pointer.
 *
 * Membership and order are handled together because VS Code has no narrower way to
 * say either: an element-scoped change event redraws that row's subtree and nothing
 * else, so a row that moved has to be described as "the whole tree".
 *
 * @param previous Row key to its rendered signature, as of the last refresh.
 * @param next The same for now.
 */
export function planTreeRefresh(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): TreeRefresh {
  if (previous.size !== next.size) return { all: true, keys: [] };

  const before = [...previous.keys()];
  const after = [...next.keys()];
  if (!before.every((key, index) => key === after[index])) return { all: true, keys: [] };

  const keys: string[] = [];
  for (const [key, signature] of next) {
    if (previous.get(key) !== signature) keys.push(key);
  }
  return { all: false, keys };
}

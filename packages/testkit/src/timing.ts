/**
 * Fastest of several runs, in milliseconds.
 *
 * A budget test asks "is this operation cheap", but a single wall-clock sample taken
 * while the rest of the suite saturates the machine answers "was a core free just
 * now". The fastest run is the one that got scheduled promptly, so it is the sample
 * that actually measures the code.
 *
 * Use it for sub-100ms budgets. Coarse ones do not need it, and hiding a real
 * regression behind a best-of-N is only possible when the margin is already thin.
 */
export async function bestOf(runs: number, operation: () => Promise<void> | void): Promise<number> {
  let best = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < runs; attempt += 1) {
    const started = performance.now();
    await operation();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

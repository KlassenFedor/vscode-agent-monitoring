/**
 * Read the hook payload from stdin.
 *
 * Bounded twice: by a byte cap, and by a timeout for the case where stdin is a
 * terminal or a pipe nobody ever closes. A hook that hangs stalls the agent, so
 * giving up and running with an empty payload is the right failure.
 */
export async function readStdin(
  stream: NodeJS.ReadStream,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const maxBytes = options.maxBytes ?? 1_000_000;

  if (stream.isTTY) return '';

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('error', finish);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    stream.on('data', onData);
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

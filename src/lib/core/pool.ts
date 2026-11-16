/**
 * Run `worker` over `items` with at most `concurrency` tasks in flight.
 * Items are started in order (so priority ordering is respected). Starting new
 * items stops as soon as `signal` aborts; in-flight tasks are not awaited past
 * that point by callers that race against their own deadline.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}

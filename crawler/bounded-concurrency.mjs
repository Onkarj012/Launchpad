export async function mapProviderSafe(items, {
  concurrency = 1,
  providerKey = (item) => item?.provider ?? 'unknown',
} = {}, worker) {
  if (typeof worker !== 'function') throw new TypeError('mapProviderSafe requires a worker');
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return [];
  const groups = new Map();
  values.forEach((item, index) => {
    const key = String(providerKey(item) ?? 'unknown').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, index });
  });
  const queues = [...groups.values()];
  const results = new Array(values.length);
  let next = 0;
  const runGroup = async () => {
    while (next < queues.length) {
      const queue = queues[next];
      next += 1;
      for (const entry of queue) results[entry.index] = await worker(entry.item, entry.index);
    }
  };
  const width = Math.max(1, Math.min(Number(concurrency) || 1, queues.length));
  await Promise.all(Array.from({ length: width }, runGroup));
  return results;
}

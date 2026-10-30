export function createMapFilter() {
  let nodes = new Map(), previous = null;
  const changes = new Map();
  const details = node => node.kind === 'pr' ? { ...nodes.get(`job:${node.details.job_id}`)?.details, ...node.details } : node.details;
  const signature = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  function alpha(node, query) {
    const term = query.trim().toLowerCase(), data = details(node);
    const pr = data.pr_number ?? data.pr ?? String(data.pr_url ?? data.prUrl ?? data.url ?? '').match(/\/(?:pull|pr)\/(\d+)(?:[/?#]|$)/)?.[1];
    return !term || [node.id, node.lane, data.job_id, data.id, data.repo, data.repository, pr, pr == null ? '' : `#${pr}`]
      .some(value => ['string', 'number'].includes(typeof value) && String(value).toLowerCase().includes(term)) ? 1 : .15;
  }
  function apply(list, now) {
    nodes = new Map(list.map(node => [node.id, node]));
    const next = new Map(list.map(node => [node.id, signature({ ...node, details: details(node) })]));
    for (const [id, value] of next) if (previous && previous.get(id) !== value) changes.set(id, now);
    for (const [id, start] of changes) if (!next.has(id) || now - start >= 1000) changes.delete(id);
    previous = next;
  }
  return { apply, alpha, details, pulse: (id, now) => changes.has(id) ? Math.max(0, 1 - (now - changes.get(id)) / 1000) : 0 };
}

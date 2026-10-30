import { sessionLinks } from './session-panel.js';
export function mountMobileSession(doc, { fetcher = fetch, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const el = id => doc.getElementById(id), dialog = el('detail');
  let selected, timer, request, generation = 0;
  function pause() { generation++; cancel(timer); request?.abort(); }
  function update(nodes) {
    if (!selected) return;
    const node = nodes.find(node => node.id === selected.id);
    el('detail-title').textContent = node ? String(node.details.job_id ?? node.id) : 'Job no longer in snapshot';
    el('detail-state').textContent = node ? String(node.details.state ?? node.details.status ?? 'Unknown') : 'State unavailable';
    el('detail-links').replaceChildren(...sessionLinks(node?.details).map(link => {
      const a = doc.createElement('a'); a.textContent = link.name + ' session'; a.href = link.href;
      a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
    }));
  }
  async function poll() {
    if (!selected || !dialog.open || doc.hidden) return;
    const active = generation, id = String(selected.details.job_id ?? selected.details.id ?? selected.id.replace(/^job:/, ''));
    request = new AbortController();
    try {
      const response = await fetcher('/api/log-tail?job=' + encodeURIComponent(id) + '&limit=200',
        { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw Error('Unavailable');
      const data = await response.json();
      if (!Array.isArray(data.lines)) throw Error('Invalid tail');
      if (active !== generation) return;
      // The endpoint returns a complete bounded tail, not incremental events.
      el('detail-body').textContent = data.lines.map(line => JSON.stringify(line)).join('\n') || 'No events yet.';
      el('detail-status').textContent = Object.keys(data.errors ?? {}).length ? 'Partial log data · retrying…' : 'Live';
    } catch {
      if (active !== generation) return;
      el('detail-status').textContent = 'Disconnected · retrying…';
    }
    if (active === generation) timer = schedule(poll, 1500);
  }
  function close() { selected = null; pause(); }
  const visibility = () => { pause(); if (!doc.hidden) void poll(); };
  doc.addEventListener('visibilitychange', visibility);
  el('close').onclick = () => { close(); dialog.close(); };
  dialog.onclose = () => { if (!dialog.open) close(); };
  return {
    open(node) {
      pause(); selected = node; update([node]);
      el('detail-body').textContent = ''; el('detail-status').textContent = 'Connecting…';
      if (!dialog.open) dialog.showModal();
      return poll();
    },
    update,
    stop() { close(); doc.removeEventListener('visibilitychange', visibility); },
  };
}

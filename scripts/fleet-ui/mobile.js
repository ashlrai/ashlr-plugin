// Serve these assets on the same origin as the existing /api/graph endpoint.
import { mountMobileActions } from './mobile-actions.js';
import { mountMobileSession } from './mobile-session.js';
export function mountMobile(doc, { fetcher = fetch, schedule = setTimeout, cancel = clearTimeout, now = () => new Date(), onSnapshot } = {}) {
  const el = id => doc.getElementById(id);
  const view = doc.defaultView;
  const online = () => view?.navigator.onLine !== false;
  const disabled = new Map();
  function availability(available) {
    el('mobile-content').inert = el('remote').inert = !available;
    el('detail').inert = !available;
    for (const control of doc.querySelectorAll?.('button, input') ?? []) {
      if (!available && !disabled.has(control)) disabled.set(control, control.disabled);
      control.disabled = available ? (disabled.get(control) ?? control.disabled) : true;
    }
    if (available) disabled.clear();
  }
  function offline() {
    availability(false);
    if (el('detail').open) el('detail').close();
    el('stale').hidden = false;
    el('stale').textContent = 'Offline · stale data. All actions disabled until a fresh connection is verified.';
  }
  const session = mountMobileSession(doc, { fetcher, schedule, cancel });
  let snapshot = null, timer, pending = false, stopped = false, updated = '';
  const jobs = () => snapshot.nodes.filter(node => node.kind === 'job');
  const running = node => ['running', 'started', 'in_progress'].includes(node.details.state ?? node.details.status);
  const merged = node => node.details.state === 'merged' || node.details.status === 'merged' || Boolean(node.details.merged_at);
  function list(id, nodes, render, empty) {
    const items = nodes.map(node => {
      const li = doc.createElement('li'); render(li, node); return li;
    });
    if (!items.length) { const li = doc.createElement('li'); li.textContent = empty; items.push(li); }
    el(id).replaceChildren(...items);
  }
  function render() {
    const all = jobs();
    list('lane-list', snapshot.nodes.filter(node => node.kind === 'lane'), (li, node) => {
      li.textContent = `${node.lane}: ${all.filter(job => job.lane === node.lane && running(job)).length} running · target ${node.details.target ?? 'unknown'}`;
      const hold = doc.createElement('small');
      hold.textContent = node.details.hold ? `Held · ${typeof node.details.hold === 'string' ? node.details.hold : JSON.stringify(node.details.hold)}` : 'Open';
      li.append(hold);
    }, 'No lanes reported.');
    const jobCard = (li, node) => {
      const button = doc.createElement('button'); button.type = 'button';
      button.textContent = `${node.details.job_id ?? node.id} · ${node.lane ?? 'unassigned'}${node.details.title ? ' · ' + node.details.title : ''}`;
      button.onclick = () => { if (online() && !el('mobile-content').inert) return session.open(node); };
      li.append(button);
    };
    list('running-list', all.filter(running), jobCard, 'No running jobs.');
    list('merge-list', all.filter(merged).reverse().sort((a, b) => (Date.parse(b.details.merged_at) || 0) - (Date.parse(a.details.merged_at) || 0)).slice(0, 10), jobCard, 'No merges in the latest fleet records.');
    session.update(all);
  }
  async function poll() {
    if (stopped || doc.hidden) return;
    if (!online()) { offline(); return; }
    if (pending) return;
    cancel(timer); pending = true;
    try {
      const response = await fetcher('/api/graph', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Unavailable');
      const next = await response.json();
      if (!Array.isArray(next.nodes) || next.nodes.some(node => !node || typeof node.id !== 'string' || !node.details || typeof node.details !== 'object')) throw Error('Invalid state');
      if (stopped || doc.hidden) return;
      if (!online()) { offline(); return; }
      snapshot = next; updated = now().toLocaleTimeString(); render();
      try { onSnapshot?.(next); } catch { /* remote panel must not break polling */ }
      availability(true);
      const errors = Object.keys(next.errors ?? {});
      el('status').textContent = `Updated ${updated}`;
      el('stale').hidden = errors.length === 0;
      el('stale').textContent = errors.length ? `Partial fleet data · unavailable: ${errors.join(', ')}. Retrying…` : '';
    } catch {
      if (stopped || doc.hidden) return;
      availability(false);
      if (!online()) { offline(); return; }
      el('stale').hidden = false;
      el('stale').textContent = snapshot ? `Stale · showing last update at ${updated}. Retrying…` : 'Fleet unavailable · retrying…';
    } finally {
      pending = false;
      if (!stopped && !doc.hidden) timer = schedule(poll, 5000);
    }
  }
  el('refresh').onclick = poll;
  const visibility = () => { cancel(timer); if (!doc.hidden) void poll(); };
  doc.addEventListener('visibilitychange', visibility);
  availability(false);
  const reconnect = () => { void poll(); };
  view?.addEventListener('offline', offline);
  view?.addEventListener('online', reconnect);
  const ready = poll();
  return { ready, poll, stop() { stopped = true; view?.removeEventListener('offline', offline); view?.removeEventListener('online', reconnect); cancel(timer); session.stop(); doc.removeEventListener('visibilitychange', visibility); } };
}
if (typeof document !== 'undefined') {
  const mobile = mountMobile(document, { onSnapshot: mountMobileActions(document).update });
  window.addEventListener('pagehide', () => mobile.stop(), { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}

// Serve these assets on the same origin as the existing /api/graph endpoint.
import { mountMobileActions } from './mobile-actions.js';
import { mountMobileSession } from './mobile-session.js';
export function mountMobile(doc, { fetcher = fetch, schedule = setTimeout, cancel = clearTimeout, now = () => new Date(), onSnapshot } = {}) {
  const el = id => doc.getElementById(id);
  const view = doc.defaultView;
  const online = () => view?.navigator.onLine !== false;
  const disabled = new Map();
  function availability(available) {
    if (!available) alerts.clear();
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
  const alerts = mountMobileAlerts(doc, node => { if (online() && !el('mobile-content').inert) return session.open(node); }, () => now().getTime());
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
    alerts.update(snapshot);
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
  const visibility = () => { cancel(timer); alerts.clear(); if (!doc.hidden) void poll(); };
  doc.addEventListener('visibilitychange', visibility);
  availability(false);
  const reconnect = () => { void poll(); };
  view?.addEventListener('offline', offline);
  view?.addEventListener('online', reconnect);
  const ready = poll();
  return { ready, poll, stop() { stopped = true; alerts.clear(); view?.removeEventListener('offline', offline); view?.removeEventListener('online', reconnect); cancel(timer); session.stop(); doc.removeEventListener('visibilitychange', visibility); } };
}
if (typeof document !== 'undefined') {
  const mobile = mountMobile(document, { onSnapshot: mountMobileActions(document).update });
  window.addEventListener('pagehide', () => mobile.stop(), { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
}

// BEGIN generated mobile-alerts.js (static route allowlist; sync checked in tests)
// Graph passes leader_event through unchanged. Optional observations use
// {ts, main: {status, job_id}, lanes: {name: {launches_30m, job_id}}}.
// Never infer zero launches from the graph's truncated job history.
function mountMobileAlerts(doc, open, now = Date.now) {
  const el = id => doc.getElementById(id), dismissed = new Set();
  let active = [];
  const fresh = ts => { const age = now() - Date.parse(ts); return age >= 0 && age <= 300000; };
  function render() {
    const visible = active.filter(alert => !dismissed.has(alert.id));
    el('mobile-alerts').hidden = visible.length === 0;
    el('alert-count').textContent = String(visible.length);
    el('alert-list').replaceChildren(...visible.map(alert => {
      const li = doc.createElement('li'), link = doc.createElement('button'), dismiss = doc.createElement('button');
      link.type = dismiss.type = 'button'; link.textContent = alert.label + ' · View session';
      link.onclick = () => { if (active.includes(alert) && fresh(alert.ts)) return open(alert.node); };
      dismiss.textContent = 'Dismiss ' + alert.label;
      dismiss.onclick = () => { dismissed.add(alert.id); render(); };
      li.append(link); li.append(dismiss); return li;
    }));
  }
  return {
    clear() { active = []; render(); },
    update(snapshot) {
      active = [];
      if (!snapshot || snapshot.stale || Object.keys(snapshot.errors ?? {}).length) { render(); return; }
      const jobs = snapshot.nodes.filter(node => node.kind === 'job'), event = snapshot.leader_event;
      const add = (id, label, jobId, ts, lane) => {
        const node = jobs.find(job => String(job.details.job_id ?? job.id.replace(/^job:/, '')) === jobId && (lane === undefined || job.lane === lane));
        if (node && fresh(ts)) active.push({ id, label, node, ts });
      };
      if (fresh(event?.ts)) {
        if (event.main?.status === 'red') add('main:' + event.main.job_id, 'Main is red', event.main.job_id, event.ts);
        for (const [lane, report] of Object.entries(event.lanes ?? {})) {
          if (report?.launches_30m === 0) add('lane:' + lane, lane + ': 0 launches in 30 min', report.job_id, event.ts, lane);
        }
      }
      for (const job of jobs) {
        if ((job.details.state ?? job.details.status) === 'stalled')
          add('stalled:' + job.id, String(job.details.job_id ?? job.id) + ' stalled', String(job.details.job_id ?? job.id.replace(/^job:/, '')), job.details.updated_at);
      }
      // A stale/missing observation cannot prove a dismissed incident resolved.
      for (const id of dismissed) {
        const resolved = id.startsWith('main:') ? fresh(event?.ts) && event.main?.status === 'green' : id.startsWith('lane:')
          ? fresh(event?.ts) && Number.isFinite(event.lanes?.[id.slice(5)]?.launches_30m) && event.lanes[id.slice(5)].launches_30m > 0
          : jobs.some(job => 'stalled:' + job.id === id && fresh(job.details.updated_at) && ['running', 'merged', 'done', 'completed'].includes(job.details.state ?? job.details.status));
        if (resolved) dismissed.delete(id);
      }
      render();
    },
  };
}
// END generated mobile-alerts.js

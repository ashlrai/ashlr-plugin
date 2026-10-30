// Graph passes leader_event through unchanged. Optional observations use
// {ts, main: {status, job_id}, lanes: {name: {launches_30m, job_id}}}.
// Never infer zero launches from the graph's truncated job history.
export function mountMobileAlerts(doc, open, now = Date.now) {
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

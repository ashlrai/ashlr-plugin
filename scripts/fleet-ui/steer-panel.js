export function mountSteerPanel(doc, fetcher = fetch, confirm = message => globalThis.confirm(message)) {
  const el = id => doc.querySelector('#steer-' + id), buttons = [...doc.querySelectorAll('[data-steer]')];
  let node, busy = false, generation = 0;
  async function request(options) {
    const response = await fetcher('/api/steer', options);
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? 'Steering unavailable');
    return data;
  }
  async function refresh() {
    const active = ++generation;
    el('pending').textContent = 'Loading proposals…';
    try {
      const data = await request();
      if (active !== generation) return;
      const pending = data.proposals.filter(p => !['applied', 'rejected', 'withdrawn', 'superseded'].includes(p.status));
      el('pending').textContent = (data.skipped ? `${data.skipped} unreadable journal records.\n` : '') +
        (pending.length ? pending.map(p => JSON.stringify(p, null, 2)).join('\n') : 'No pending proposals.');
    } catch { if (active === generation) el('pending').textContent = 'Proposals unavailable. Refresh to retry.'; }
  }
  function update() {
    buttons.forEach(button => { button.disabled = busy || !['job', 'lane'].includes(node?.kind) || (button.dataset.steer === 'reassign' && node.kind !== 'job'); });
  }
  for (const button of buttons) button.onclick = async () => {
    if (button.disabled || busy) return;
    busy = true; update();
    try {
      const action = button.dataset.steer;
      const proposal = { action, lane: el('lane').value, author: el('author').value, reason: el('reason').value };
      if (action === 'reassign') proposal.job_id = String(node.details.job_id ?? node.details.id ?? node.id.slice(4));
      else {
        if (!el('slots').value.trim()) throw Error('Enter a slot count (0–1024).');
        proposal.slots = Number(el('slots').value);
      }
      if (!await confirm('Submit proposal for review? No changes are applied.\n' + JSON.stringify(proposal, null, 2))) {
        el('status').textContent = 'Proposal cancelled.'; return;
      }
      const data = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, ...proposal }) });
      el('status').textContent = 'Proposed · ' + data.proposal.id + ' · awaiting review';
      await refresh();
    } catch (error) { el('status').textContent = 'Proposal refused · ' + error.message; }
    finally { busy = false; update(); }
  };
  el('refresh').onclick = refresh;
  return { async open(value) { node = value; el('lane').value = node.lane ?? ''; update(); await refresh(); } };
}

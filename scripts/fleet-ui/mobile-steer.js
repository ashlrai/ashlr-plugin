// Embedded verbatim in mobile.html: the server has a fixed asset allowlist.
export function mountMobileSteer(doc, { fetcher = fetch, confirm = message => globalThis.confirm(message) } = {}) {
  const section = doc.createElement('section');
  section.id = 'mobile-steer';
  section.innerHTML = `<h2>Steering proposals</h2><small>Proposals await review; no changes are applied immediately.</small>
    <button id="mobile-steer-refresh" type="button">Refresh steering</button><pre id="mobile-steer-lanes" aria-label="Steering lanes"></pre>
    <label>Destination lane <input id="mobile-steer-lane" maxlength="128" required></label><label>Job ID (reassign only) <input id="mobile-steer-job" maxlength="128"></label>
    <label>Slots (0–1024) <input id="mobile-steer-slots" type="number" min="0" max="1024" step="1"></label><label>Author <input id="mobile-steer-author" maxlength="200" required></label>
    <label>Proposal reason <input id="mobile-steer-reason" maxlength="512" required></label><button id="mobile-steer-reassign" type="button">Propose reassignment</button><button id="mobile-steer-set-slots" type="button">Propose slot count</button>
    <p id="mobile-steer-status" role="status"></p><h3>Pending proposals</h3><pre id="mobile-steer-pending" aria-live="polite"></pre>`;
  doc.getElementById('remote').append(section);
  const el = id => doc.getElementById('mobile-steer-' + id), value = id => el(id).value.trim();
  const blocked = () => doc.defaultView?.navigator.onLine === false || doc.getElementById('remote').inert;
  let busy = false, generation = 0;
  async function request(path, options) {
    const response = await fetcher(path, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? `Request rejected (${response.status})`);
    return data;
  }
  async function refresh() {
    const active = ++generation;
    try {
      const [data, graph] = await Promise.all([request('/api/steer'), request('/api/graph')]);
      if (active !== generation) return;
      // /api/steer currently exposes only the journal; lanes come from the graph.
      el('lanes').textContent = (Object.keys(graph.errors ?? {}).length ? 'Partial lane data.\n' : '') + (graph.nodes.filter(n => n.kind === 'lane').map(n => `${n.lane ?? n.id}: ${JSON.stringify(n.details)}`).join('\n') || 'No lanes reported.');
      el('pending').textContent = (data.skipped ? `${data.skipped} unreadable journal records.\n` : '') + (data.proposals.filter(p => !['applied', 'rejected', 'withdrawn', 'superseded'].includes(p.status)).map(p => JSON.stringify(p, null, 2)).join('\n') || 'No pending proposals.');
    } catch { if (active === generation) { el('lanes').textContent = 'Lanes unavailable. Refresh to retry.'; el('pending').textContent = 'Proposals unavailable. Refresh to retry.'; } }
  }
  for (const action of ['reassign', 'set-slots']) el(action).onclick = async () => {
    if (busy) return;
    // Use inert so mobile.js never snapshots a temporary disabled button state.
    busy = true; section.inert = true;
    try {
      if (blocked()) throw Error('Offline or stale connection');
      const proposal = { action, lane: value('lane'), author: value('author'), reason: value('reason') };
      if (action === 'reassign') proposal.job_id = value('job'); else proposal.slots = Number(value('slots'));
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(proposal.lane) || !proposal.author || proposal.author.length > 200 || /[\x00-\x1f\x7f]/.test(proposal.author) || !proposal.reason || proposal.reason.length > 512 ||
        (action === 'reassign' ? !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(proposal.job_id) : !/^\d+$/.test(value('slots')) || !Number.isSafeInteger(proposal.slots) || proposal.slots > 1024)) throw Error('Check lane, job/slots, author and reason.');
      if (!await confirm('Submit proposal for review? No changes are applied.\n' + JSON.stringify(proposal, null, 2))) { el('status').textContent = 'Proposal cancelled.'; return; }
      if (blocked()) throw Error('Offline or stale connection');
      const data = await request('/api/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, ...proposal }) });
      el('status').textContent = 'Proposed · ' + data.proposal.id + ' · awaiting review';
      await refresh();
    } catch (error) { el('status').textContent = 'Proposal refused · ' + error.message; }
    finally { busy = false; section.inert = false; }
  };
  el('refresh').onclick = refresh;
  return { ready: refresh(), refresh };
}
if (typeof document !== 'undefined') mountMobileSteer(document);

// Phone remote for fleet pause/resume/kill. Same confirmed /api/actions
// contract as the desktop control panel; only kill prompts, since pause and
// resume are reversible. Every attempt leaves a visible result line.
export function createMobileActions(send, confirm, announce) {
  let busy = false;
  return async (action, target, reason) => {
    if (busy) return;
    busy = true;
    try {
      const payload = { action, requested_by: 'fleet-ui-mobile', reason: String(reason ?? ''), dry_run: false };
      if (['pause', 'resume'].includes(action)) payload.lane = target?.lane;
      if (action === 'kill') payload.job_id = target?.job_id;
      if (!['pause', 'resume', 'kill'].includes(action) ||
        !payload.reason.trim() || payload.reason.length > 512 ||
        ['lane', 'job_id'].some(key => key in payload &&
          (typeof payload[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(payload[key]))))
        throw Error('Check the target and reason.');
      if (action === 'kill' && !await confirm(`Kill job ${payload.job_id}?\n${JSON.stringify(payload, null, 2)}`)) {
        announce('kill: cancelled');
        return;
      }
      const result = await send({ confirmed: true, action: payload });
      announce(`${action}: ${result.status} · ${result.id} (controller request)`);
    } catch (error) {
      announce(`${action}: failed · ${error.message}`);
    } finally {
      busy = false;
    }
  };
}
export function mountMobileActions(doc, { send, confirm, announce } = {}) {
  const el = id => doc.getElementById(id);
  const run = createMobileActions(
    send ?? (async body => {
      const response = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw Error('Request rejected (' + response.status + ')');
      return response.json();
    }),
    confirm ?? (message => globalThis.confirm(message)),
    announce ?? (message => {
      const log = el('remote-log');
      if (log) log.textContent = [...log.textContent.split('\n').filter(Boolean), new Date().toISOString() + ' ' + message].slice(-100).join('\n');
    }));
  let controls = [];
  const control = (label, action, target) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = async () => {
      controls.forEach(item => { item.disabled = true; });
      await run(action, target, el('remote-reason')?.value);
      controls.forEach(item => { item.disabled = false; });
    };
    controls.push(button);
    return button;
  };
  const fill = (id, items, empty) => {
    if (!items.length) { const li = doc.createElement('li'); li.textContent = empty; items.push(li); }
    el(id).replaceChildren(...items);
  };
  function update(snapshot) {
    controls = [];
    const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const running = node => ['running', 'started', 'in_progress'].includes(node?.details?.state ?? node?.details?.status);
    fill('remote-lanes', nodes.filter(node => node?.kind === 'lane').map(node => {
      const lane = String(node.lane ?? node.id ?? ''), li = doc.createElement('li');
      li.textContent = lane;
      li.append(control(`Pause ${lane}`, 'pause', { lane }));
      li.append(control(`Resume ${lane}`, 'resume', { lane }));
      return li;
    }), 'No lanes reported.');
    fill('remote-jobs', nodes.filter(node => node?.kind === 'job' && running(node)).map(node => {
      const job_id = String(node.details?.job_id ?? node.details?.id ?? String(node.id ?? '').slice(4)), li = doc.createElement('li');
      li.textContent = job_id;
      li.append(control(`Kill ${job_id}`, 'kill', { job_id }));
      return li;
    }), 'No running jobs.');
  }
  return { run, update };
}

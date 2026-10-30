// Only the confirmed, captured payload is submitted; repeated clicks cannot queue duplicates.
export function createControlPanel(send, confirm, log) {
  let busy = false;
  return async (action, node, lane, slots, reason) => {
    if (busy) return;
    busy = true;
    try {
      const payload = { action, requested_by: 'fleet-ui', reason, dry_run: false };
      if (['pause', 'resume', 'reassign', 'slots'].includes(action)) payload.lane = lane;
      if (['kill', 'reassign'].includes(action)) payload.job_id = String(node.details.job_id ?? node.details.id ?? node.id.slice(4));
      if (action === 'slots') payload.slots = Number(slots);
      if (!['pause', 'resume', 'kill', 'reassign', 'slots'].includes(action) ||
        !reason.trim() || reason.length > 512 ||
        ('job_id' in payload && node.kind !== 'job') ||
        ['lane', 'job_id'].some(key => key in payload && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(payload[key])) ||
        (action === 'slots' && (!String(slots).trim() || !Number.isInteger(payload.slots) || payload.slots < 0 || payload.slots > 1024))) throw Error('Check target, reason and slots (0–1024).');
      if (!await confirm(JSON.stringify(payload, null, 2))) { log(action + ': cancelled'); return; }
      const result = await send({ confirmed: true, action: payload });
      log(action + ': ' + result.status + ' · ' + result.id + ' (controller request)');
    } catch (error) { log(action + ': failed · ' + error.message); }
    finally { busy = false; }
  };
}
export function mountControlPanel(doc) {
  let node;
  const log = doc.querySelector('#action-log');
  const run = createControlPanel(async body => {
    const response = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Error('Request rejected (' + response.status + ')');
    return response.json();
  }, message => globalThis.confirm('Queue this fleet action?\n' + message), message => {
    log.textContent = [...log.textContent.split('\n').filter(Boolean), new Date().toISOString() + ' ' + message].slice(-100).join('\n');
  });
  const buttons = [...doc.querySelectorAll('[data-fleet-action]')];
  for (const button of buttons) button.onclick = async () => {
    buttons.forEach(button => { button.disabled = true; });
    await run(button.dataset.fleetAction, node, doc.querySelector('#action-lane').value, doc.querySelector('#action-slots').value, doc.querySelector('#action-reason').value);
    update(node);
  };
  function update(value) {
    node = value;
    doc.querySelector('#action-lane').value = node.lane;
    buttons.forEach(button => { button.disabled = ['kill', 'reassign'].includes(button.dataset.fleetAction) && node.kind !== 'job'; });
  }
  return { open: update };
}

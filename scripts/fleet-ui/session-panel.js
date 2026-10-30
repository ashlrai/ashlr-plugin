// One in-flight poll per window; late responses cannot update a different node.
export function createSessionPanel(load, render) {
  const offsets = new Map(), tails = new Map();
  let generation = 0, timer;
  function close() { generation++; clearTimeout(timer); }
  async function open(node) {
    close();
    const active = generation, id = String(node.details.job_id ?? node.details.id ?? node.id.slice(4));
    render({ node, lines: tails.get(id) ?? [], links: [], state: 'Connecting…' });
    async function poll() {
      try {
        const data = await load('/api/session?job=' + encodeURIComponent(id) + '&offset=' + (offsets.get(id) ?? 0));
        if (active !== generation) return;
        const lines = [...(data.reset ? [] : tails.get(id) ?? []), ...(data.logs ?? [])].slice(-300);
        offsets.set(id, data.offset); tails.set(id, lines);
        render({ node, lines, links: sessionLinks(data.job), state: String(data.job?.state ?? data.job?.status ?? 'Unknown') + (Object.keys(data.errors).length ? ' · ' + JSON.stringify(data.errors) : '') });
      } catch {
        if (active !== generation) return;
        render({ node, lines: tails.get(id) ?? [], links: [], state: 'Disconnected · retrying' });
      }
      if (active === generation) timer = setTimeout(poll, 1500);
    }
    if (node.kind === 'job') await poll();
    else render({ node, lines: [JSON.stringify(node.details, null, 2)], links: [], state: 'Lane · select a job for session logs' });
  }
  return { open, close };
}
export function sessionLinks(job) {
  const hosts = { Codex: ['chatgpt.com'], Claude: ['claude.ai'], Devin: ['app.devin.ai'] };
  return Object.entries(hosts).flatMap(([name, allowed]) => {
    try {
      const value = job?.[name.toLowerCase() + '_session_url'] ?? job?.[name.toLowerCase() + '_url'] ?? job?.session_url;
      const url = new URL(value);
      return url.protocol === 'https:' && allowed.includes(url.hostname) && !url.username && !url.password && !url.port ? [{ name, href: url.href }] : [];
    } catch { return []; }
  });
}
export function mountSessionPanel(doc) {
  const dialog = doc.querySelector('#session');
  const panel = createSessionPanel(async path => {
    const response = await fetch(path);
    if (!response.ok) throw Error('Session unavailable');
    return response.json();
  }, view => {
    doc.querySelector('#session-title').textContent = view.node.id;
    doc.querySelector('#session-state').textContent = view.state;
    doc.querySelector('#session-log').textContent = view.lines.join('\n');
    doc.querySelector('#session-links').replaceChildren(...view.links.map(link => {
      const anchor = doc.createElement('a');
      anchor.textContent = link.name + ' session '; anchor.href = link.href;
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return anchor;
    }));
    if (!dialog.open) dialog.showModal();
  });
  doc.querySelector('#close-session').onclick = () => dialog.close();
  dialog.addEventListener('close', panel.close);
  return panel;
}

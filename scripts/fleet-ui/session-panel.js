// One in-flight poll per window; late responses cannot update a different node.
export function createSessionPanel(load, render) {
  const offsets = new Map(), tails = new Map(), browsers = new Map();
  let generation = 0, timer;
  function close() { generation++; clearTimeout(timer); }
  // Pages the job's live browser frames through the opaque cursor; a rejected or
  // unreachable endpoint clears the stored cursor so the next poll restarts.
  async function browserOf(id) {
    const known = browsers.get(id);
    try {
      const page = await load('/api/browser?job=' + encodeURIComponent(id) + '&limit=200' +
        (known ? '&cursor=' + encodeURIComponent(known.cursor) : ''));
      if (!page || !Array.isArray(page.frames) || typeof page.cursor !== 'string' ||
        page.frames.some(frame => typeof frame?.path !== 'string')) throw Error('invalid browser view');
      const view = {
        cursor: page.cursor,
        frames: [...known?.frames ?? [], ...page.frames.map(frame => frame.path)].slice(-300),
        url: page.current_url ?? null, latest: page.latest_frame_path ?? null,
      };
      browsers.set(id, view);
      return view;
    } catch {
      browsers.delete(id);
      return known ?? null;
    }
  }
  async function open(node) {
    close();
    const active = generation, id = String(node.details.job_id ?? node.details.id ?? node.id.slice(4));
    render({ node, lines: tails.get(id) ?? [], links: [], state: 'Connecting…', browser: browsers.get(id) ?? null });
    async function poll() {
      try {
        const [data, browser] = await Promise.all([
          load('/api/session?job=' + encodeURIComponent(id) + '&offset=' + (offsets.get(id) ?? 0)),
          browserOf(id)]);
        if (active !== generation) return;
        const lines = [...(data.reset ? [] : tails.get(id) ?? []), ...(data.logs ?? [])].slice(-300);
        offsets.set(id, data.offset); tails.set(id, lines);
        render({ node, lines, links: sessionLinks(data.job), state: String(data.job?.state ?? data.job?.status ?? 'Unknown') + (Object.keys(data.errors).length ? ' · ' + JSON.stringify(data.errors) : ''), browser });
      } catch {
        if (active !== generation) return;
        render({ node, lines: tails.get(id) ?? [], links: [], state: 'Disconnected · retrying', browser: browsers.get(id) ?? null });
      }
      if (active === generation) timer = setTimeout(poll, 1500);
    }
    if (node.kind === 'job') await poll();
    else render({ node, lines: [JSON.stringify(node.details, null, 2)], links: [], state: 'Lane · select a job for session logs', browser: null });
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
    const section = doc.querySelector('#session-browser'), browser = view.browser;
    if (section) {
      const visible = browser && (browser.url || browser.latest || browser.frames.length);
      section.hidden = !visible;
      if (visible) {
        // The reported URL is text unless it is a plain http(s) link.
        let href = null;
        try { if (['http:', 'https:'].includes(new URL(browser.url).protocol)) href = browser.url; } catch { /* not a URL */ }
        const anchor = doc.querySelector('#browser-url');
        anchor.textContent = browser.url ? 'Current URL: ' + browser.url : 'Current URL unknown';
        if (href) anchor.href = href; else anchor.removeAttribute('href');
        doc.querySelector('#browser-frames').textContent = browser.frames.join('\n');
      }
    }
    if (!dialog.open) dialog.showModal();
  });
  doc.querySelector('#close-session').onclick = () => dialog.close();
  dialog.addEventListener('close', panel.close);
  return panel;
}

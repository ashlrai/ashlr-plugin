import { sessionLinks } from './session-panel.js';
export function mountMobileSession(doc, { fetcher = fetch, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const el = id => doc.getElementById(id), dialog = el('detail');
  const browser = mountMobileBrowser(doc, { fetcher });
  const jobId = node => String(node.details.job_id ?? node.details.id ?? node.id.replace(/^job:/, ''));
  let selected, timer, request, generation = 0;
  function pause() { generation++; cancel(timer); request?.abort(); browser.pause(); }
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
    const active = generation, id = jobId(selected);
    request = new AbortController();
    const tail = (async () => {
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
    })();
    await Promise.all([tail, browser.poll()]);
    if (active === generation) timer = schedule(poll, 1500);
  }
  function close() { selected = null; pause(); browser.close(); }
  const visibility = () => { pause(); if (!doc.hidden) void poll(); };
  doc.addEventListener('visibilitychange', visibility);
  el('close').onclick = () => { close(); dialog.close(); };
  dialog.onclose = () => { if (!dialog.open) close(); };
  return {
    open(node) {
      pause(); selected = node; update([node]);
      el('detail-body').textContent = ''; el('detail-status').textContent = 'Connecting…';
      browser.open(jobId(node));
      if (!dialog.open) dialog.showModal();
      return poll();
    },
    update,
    stop() { close(); doc.removeEventListener('visibilitychange', visibility); },
  };
}

// BEGIN generated mobile-browser.js (static route allowlist; sync checked in tests)
// Live agent browser view inside the mobile session sheet. The host session
// loop drives poll() on its cadence and calls pause() when hidden or closed, so
// at most one request is ever in flight. Pages the job's frames through the
// endpoint's opaque cursor; any failed poll drops the stored cursor so the next
// poll re-syncs from the start (stale cursors are rejected after rewrites).
function mountMobileBrowser(doc, { fetcher = fetch } = {}) {
  const el = id => doc.getElementById(id);
  let job, cursor, view, request, generation = 0;
  function pause() { generation++; request?.abort(); }
  function render(status) {
    el('detail-browser').hidden = false;
    el('browser-status').textContent = status;
    const anchor = el('browser-url'), url = view?.url ?? null;
    let href = null;
    // The reported URL is text unless it is a plain http(s) link.
    try { if (url && ['http:', 'https:'].includes(new URL(url).protocol)) href = url; } catch { /* not a URL */ }
    anchor.hidden = !url;
    anchor.textContent = url ? 'Current URL: ' + url : '';
    if (href) anchor.href = href; else anchor.removeAttribute?.('href');
    const frame = el('browser-frame'), latest = view?.latest ?? null;
    frame.hidden = !latest;
    frame.textContent = latest ? 'Latest frame: ' + latest : '';
  }
  return {
    open(id) {
      pause(); view = null; cursor = undefined;
      // The endpoint only accepts a bounded job id; anything else has no view.
      const value = String(id);
      job = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null;
      render(job ? 'Connecting…' : 'No live browser view for this job.');
    },
    async poll() {
      if (!job || doc.hidden) return;
      const active = generation;
      request = new AbortController();
      try {
        const response = await fetcher('/api/browser?job=' + encodeURIComponent(job) + '&limit=200' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
          { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
        if (active !== generation) return;
        if (response.status === 404) {
          cursor = undefined; view = null;
          render('No live browser view for this job.');
          return;
        }
        if (!response.ok) throw Error('Unavailable');
        const page = await response.json();
        if (active !== generation) return;
        if (!page || !Array.isArray(page.frames) || typeof page.cursor !== 'string' ||
          page.frames.some(frame => typeof frame?.path !== 'string')) throw Error('Invalid browser view');
        cursor = page.cursor;
        view = {
          latest: typeof page.latest_frame_path === 'string' ? page.latest_frame_path : null,
          url: typeof page.current_url === 'string' ? page.current_url : null,
        };
        render(view.latest || view.url ? 'Live' : 'No browser frames yet.');
      } catch {
        if (active !== generation) return;
        cursor = undefined;
        render('Browser view unavailable · retrying…');
      }
    },
    pause,
    close() {
      job = null; view = null; pause();
      el('detail-browser').hidden = true;
      el('browser-status').textContent = '';
      el('browser-url').hidden = true;
      el('browser-frame').hidden = true;
    },
  };
}
// END generated mobile-browser.js

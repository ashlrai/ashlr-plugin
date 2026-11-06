// Live agent browser view inside the mobile session sheet. The host session
// loop drives poll() on its cadence and calls pause() when hidden or closed, so
// at most one request is ever in flight. Pages the job's frames through the
// endpoint's opaque cursor; any failed poll drops the stored cursor so the next
// poll re-syncs from the start (stale cursors are rejected after rewrites).
export function mountMobileBrowser(doc, { fetcher = fetch } = {}) {
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

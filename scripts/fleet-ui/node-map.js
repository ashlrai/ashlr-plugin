// Delta pages merge into one fleet state; nodes and screen points rebuild deterministically per page.
const RESOURCES = ['targets.json', 'holds.json', 'jobs.jsonl', 'leader-events.jsonl'];
const COLLECTIONS = ['lanes', 'jobs', 'prs'];
const RADIUS = { leader: 9, lane: 7, job: 6, pr: 5, resource: 4 };
const COLOR = { leader: '#a78bfa', lane: '#67e8f9', job: '#fbbf24', pr: '#34d399', resource: '#94a3b8' };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const laneOf = job => String(job.pool ?? job.lane ?? 'unassigned');
const nodeKey = node => node.id.slice(node.id.indexOf(':') + 1);

export function createNodeMap() {
  const collections = { lanes: null, jobs: null, prs: null };
  let leader = null, errors = {}, cursor;
  function apply(page) {
    if (!isRecord(page) || page.schema_version !== 1 || typeof page.cursor !== 'string' ||
      (page.removed !== undefined && !isRecord(page.removed)) ||
      (page.errors !== undefined && !isRecord(page.errors))) throw Error('Invalid snapshot');
    for (const key of COLLECTIONS) {
      const value = page[key], gone = page.removed?.[key];
      if (value !== undefined && value !== null && (!isRecord(value) || Object.values(value).some(entry => !isRecord(entry)))) throw Error('Invalid snapshot');
      if (gone !== undefined && (!Array.isArray(gone) || gone.some(id => typeof id !== 'string'))) throw Error('Invalid snapshot');
    }
    for (const key of COLLECTIONS) {
      const value = page[key], gone = page.removed?.[key];
      if (Object.hasOwn(page, key)) collections[key] = value === null ? null : { ...collections[key], ...value };
      if (gone && collections[key]) for (const id of gone) delete collections[key][id];
    }
    if (Object.hasOwn(page, 'leader')) leader = page.leader;
    if (Object.hasOwn(page, 'errors')) errors = page.errors;
    cursor = page.cursor;
  }
  function graph() {
    const lanes = collections.lanes ?? {}, jobs = collections.jobs ?? {}, prs = collections.prs ?? {};
    const nodes = [{ id: 'leader', kind: 'leader', lane: '', details: isRecord(leader) ? leader : { event: leader ?? 'unknown' } }];
    const links = [];
    for (const [id, details] of Object.entries(lanes).sort(([a], [b]) => a.localeCompare(b))) {
      nodes.push({ id: `lane:${id}`, kind: 'lane', lane: id, details });
      links.push({ source: 'leader', target: `lane:${id}` });
    }
    for (const [id, job] of Object.entries(jobs).sort(([a], [b]) => a.localeCompare(b))) {
      const lane = laneOf(job);
      nodes.push({ id: `job:${id}`, kind: 'job', lane, details: job });
      links.push({ source: `lane:${lane}`, target: `job:${id}` });
    }
    for (const [id, pr] of Object.entries(prs).sort(([a], [b]) => a.localeCompare(b))) {
      const jobId = String(pr.job_id ?? id), parent = jobs[jobId];
      nodes.push({ id: `pr:${id}`, kind: 'pr', lane: parent ? laneOf(parent) : '', details: pr });
      links.push({ source: `job:${jobId}`, target: `pr:${id}` });
    }
    for (const name of [...new Set([...RESOURCES, ...Object.keys(errors)])].sort()) {
      nodes.push({ id: `resource:${name}`, kind: 'resource', lane: '', details: { source: name, status: errors[name] ?? 'ok' } });
      links.push({ source: `resource:${name}`, target: 'leader' });
    }
    return { nodes, links, leader, errors };
  }
  return { apply, graph, resetCursor() { cursor = undefined; }, get cursor() { return cursor; }, get leader() { return leader; }, get errors() { return errors; } };
}

// Leader at the hub; lanes orbit above, jobs fan around their lane, PRs trail jobs, resources below.
export function layout(nodes) {
  const lanes = nodes.filter(node => node.kind === 'lane');
  const jobs = nodes.filter(node => node.kind === 'job');
  const laneAngle = new Map(lanes.map((node, i) => [node.lane, i * 2 * Math.PI / Math.max(1, lanes.length) - Math.PI / 2]));
  const groups = new Map();
  for (const job of jobs) groups.set(job.lane, [...groups.get(job.lane) ?? [], job]);
  const jobAngle = new Map(), position = new Map();
  let orphans = 0, resources = 0;
  const resourceCount = nodes.filter(node => node.kind === 'resource').length;
  for (const node of nodes) {
    if (node.kind === 'leader') position.set(node, { x: 0, y: 0, z: 0 });
    else if (node.kind === 'lane') {
      const angle = laneAngle.get(node.lane);
      position.set(node, { x: Math.cos(angle) * .62, y: -.45, z: Math.sin(angle) * .62 });
    } else if (node.kind === 'job') {
      const group = groups.get(node.lane) ?? [node], base = laneAngle.get(node.lane);
      const angle = base === undefined ? ++orphans * 2.39996 : base + (group.indexOf(node) - (group.length - 1) / 2) * .3;
      jobAngle.set(node.id, angle);
      position.set(node, { x: Math.cos(angle), y: 0, z: Math.sin(angle) });
    }
  }
  for (const node of nodes) {
    if (node.kind === 'pr') {
      const angle = (jobAngle.get(`job:${node.details.job_id ?? nodeKey(node)}`) ?? ++orphans * 2.39996) + .22;
      position.set(node, { x: Math.cos(angle) * 1.24, y: -.08, z: Math.sin(angle) * 1.24 });
    } else if (node.kind === 'resource') {
      const angle = resources++ * 2 * Math.PI / Math.max(1, resourceCount) + Math.PI / 4;
      position.set(node, { x: Math.cos(angle) * .5, y: .55, z: Math.sin(angle) * .5 });
    }
  }
  return nodes.map(node => ({ node, ...position.get(node) ?? { x: 0, y: 0, z: 0 } }));
}

export function project(items, camera, width, height) {
  const { angle, tilt, zoom } = camera;
  return items.map(({ node, x, y, z }) => {
    const rx = x * Math.cos(angle) - z * Math.sin(angle), rz = x * Math.sin(angle) + z * Math.cos(angle);
    const ry = y * Math.cos(tilt) - rz * Math.sin(tilt), depth = y * Math.sin(tilt) + rz * Math.cos(tilt);
    const scale = Math.min(width, height) * .3 * zoom / (1 + depth * .25);
    return { node, x: width / 2 + rx * scale, y: height / 2 + ry * scale, depth };
  });
}

export function pick(points, x, y, radius = 16) {
  let best = null, nearest = radius;
  for (const point of points) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < nearest || (distance === nearest && best && point.depth < best.depth)) { nearest = distance; best = point; }
  }
  return best?.node ?? null;
}

const labelOf = node => node.kind === 'leader' ? 'leader' : node.kind === 'job' ? String(node.details.job_id ?? node.details.id ?? nodeKey(node)) :
  node.kind === 'pr' ? `PR ${node.details.job_id ?? nodeKey(node)}` : nodeKey(node);
const colorOf = node => node.kind === 'resource' && node.details.status !== 'ok' ? '#f87171' : COLOR[node.kind] ?? '#e2e8f0';

export function mountNodeMap(doc, { open = () => {}, fetcher = fetch, schedule = setTimeout, cancel = clearTimeout, interval = 1500, frame } = {}) {
  const map = createNodeMap(), el = selector => doc.querySelector(selector);
  const canvas = el('canvas'), ctx = canvas.getContext('2d'), selector = el('#nodes');
  const camera = { angle: .4, tilt: .3, zoom: 1 };
  const step = frame ?? (callback => globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(callback) : 0);
  let selected = '', drag = null, moved = false, points = [], timer, pending = false, stopped = false, detailsGen = 0;
  const show = (id, value) => { el(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  async function get(path) {
    const response = await fetcher(path, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('Request failed');
    return response.json();
  }
  const nodes = () => map.graph().nodes;
  const jobOf = node => node && ['job', 'pr'].includes(node.kind) ? String(node.details.job_id ?? node.details.id ?? nodeKey(node)) : '';
  async function details() {
    const generation = ++detailsGen, node = nodes().find(node => node.id === selected);
    show('#details', node ? node.details : { leader: map.leader, errors: map.errors });
    try {
      const tail = await get('/api/log-tail' + (jobOf(node) ? '?job=' + encodeURIComponent(jobOf(node)) : ''));
      if (generation === detailsGen) show('#logs', tail);
    } catch { if (generation === detailsGen) show('#logs', 'Unavailable'); }
  }
  function select(id) {
    const node = nodes().find(node => node.id === id);
    selected = node ? id : '';
    selector.value = selected;
    if (node) open(node);
    void details();
  }
  selector.onchange = () => select(selector.value);
  async function poll() {
    if (pending || stopped) return;
    pending = true;
    try {
      map.apply(await get('/api/snapshot' + (map.cursor ? '?since=' + encodeURIComponent(map.cursor) : '')));
      const list = nodes(), option = (value, text) => { const item = doc.createElement('option'); item.value = value; item.textContent = text; return item; };
      selector.replaceChildren(option('', 'Fleet'), ...list.map(node => option(node.id, node.id)));
      if (![...selector.children].some(item => item.value === selected)) selected = '';
      selector.value = selected;
      el('#status').textContent = Object.keys(map.errors).length ? 'Some sources unavailable · retrying' : `Live · ${list.length} nodes`;
      await details();
    } catch {
      map.resetCursor();
      if (!stopped) el('#status').textContent = 'Disconnected · retrying';
    } finally {
      pending = false;
      if (!stopped) timer = schedule(poll, interval);
    }
  }
  function draw() {
    const width = canvas.clientWidth, height = canvas.clientHeight, density = globalThis.devicePixelRatio || 1;
    if (canvas.width !== width * density || canvas.height !== height * density) { canvas.width = width * density; canvas.height = height * density; }
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const graph = map.graph();
    points = project(layout(graph.nodes), camera, width, height);
    ctx.strokeStyle = '#52627d';
    for (const link of graph.links) {
      const a = points.find(point => point.node.id === link.source), b = points.find(point => point.node.id === link.target);
      if (a && b) {
        ctx.globalAlpha = .2 + Math.max(0, .5 - (a.depth + b.depth) * .25);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.font = '11px system-ui';
    for (const point of [...points].sort((a, b) => b.depth - a.depth)) {
      ctx.fillStyle = colorOf(point.node);
      ctx.beginPath(); ctx.arc(point.x, point.y, (RADIUS[point.node.kind] ?? 5) + (point.node.id === selected ? 3 : 0), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e2e8f0'; ctx.fillText(labelOf(point.node), point.x + 10, point.y + 4);
    }
    if (!stopped) step(draw);
  }
  canvas.onpointerdown = event => { drag = { x: event.clientX, y: event.clientY }; moved = false; canvas.setPointerCapture?.(event.pointerId); };
  canvas.onpointermove = event => {
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      camera.angle += dx * .01; camera.tilt += dy * .01;
      drag = { x: event.clientX, y: event.clientY };
    }
  };
  canvas.onpointerup = event => {
    if (drag && !moved) {
      const box = canvas.getBoundingClientRect(), node = pick(points, event.clientX - box.left, event.clientY - box.top);
      if (node) select(node.id);
    }
    drag = null;
  };
  canvas.onpointercancel = () => { drag = null; };
  canvas.onwheel = event => { event.preventDefault(); camera.zoom = Math.max(.3, Math.min(2, camera.zoom - event.deltaY * .001)); };
  const ready = poll();
  step(draw);
  return {
    ready, poll, draw, select, map,
    get points() { return points; }, get selected() { return selected; },
    stop() { stopped = true; cancel(timer); },
  };
}

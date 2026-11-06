// Renders the live fleet from whole /api/graph pages; a dropped response retries at the next interval.
import { mountControlPanel } from './control-panel.js';
import { mountSessionPanel } from './session-panel.js';
import { mountSteerPanel } from './steer-panel.js';

// BEGIN map-filter.js — embedded because the server serves a fixed asset allowlist.
function createMapFilter() {
  let nodes = new Map(), previous = null;
  const changes = new Map();
  const details = node => node.kind === 'pr' ? { ...nodes.get(`job:${node.details.job_id}`)?.details, ...node.details } : node.details;
  const signature = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(key => [key, item[key]])) : item);
  function alpha(node, query) {
    const term = query.trim().toLowerCase(), data = details(node);
    const pr = data.pr_number ?? data.pr ?? String(data.pr_url ?? data.prUrl ?? data.url ?? '').match(/\/(?:pull|pr)\/(\d+)(?:[/?#]|$)/)?.[1];
    return !term || [node.id, node.lane, data.job_id, data.id, data.repo, data.repository, pr, pr == null ? '' : `#${pr}`]
      .some(value => ['string', 'number'].includes(typeof value) && String(value).toLowerCase().includes(term)) ? 1 : .15;
  }
  function apply(list, now) {
    nodes = new Map(list.map(node => [node.id, node]));
    const next = new Map(list.map(node => [node.id, signature({ ...node, details: details(node) })]));
    for (const [id, value] of next) if (previous && previous.get(id) !== value) changes.set(id, now);
    for (const [id, start] of changes) if (!next.has(id) || now - start >= 1000) changes.delete(id);
    previous = next;
  }
  return { apply, alpha, details, pulse: (id, now) => changes.has(id) ? Math.max(0, 1 - (now - changes.get(id)) / 1000) : 0 };
}
// END map-filter.js — source equality is enforced by fleet-map-filter.test.ts.

const RESOURCES = ['targets.json', 'holds.json', 'jobs.jsonl', 'leader-events.jsonl'];
const RADIUS = { leader: 9, lane: 7, job: 6, pr: 5, resource: 4 };
const COLOR = { leader: '#a78bfa', lane: '#67e8f9', job: '#fbbf24', pr: '#fbbf24', resource: '#94a3b8' };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nodeKey = node => node.id.slice(node.id.indexOf(':') + 1);

export function createNodeMap() {
  let leader = null, errors = {}, nodes = [];
  function apply(page) {
    if (!isRecord(page) || !Array.isArray(page.nodes) ||
      page.nodes.some(node => !isRecord(node) || typeof node.id !== 'string' || typeof node.kind !== 'string' ||
        (node.lane !== undefined && typeof node.lane !== 'string') || !isRecord(node.details)) ||
      (page.errors !== undefined &&
        (!isRecord(page.errors) || Object.values(page.errors).some(value => typeof value !== 'string')))) {
      throw Error('Invalid graph');
    }
    // Last record wins per node id, mirroring the server's job semantics.
    nodes = [...new Map(page.nodes.map(node =>
      [node.id, { id: node.id, kind: node.kind, lane: node.lane ?? '', details: node.details }])).values()];
    leader = page.leader_event ?? null;
    errors = page.errors ?? {};
  }
  // Links are re-derived locally so the drawn edges always match the drawn nodes.
  function graph() {
    const lanes = nodes.filter(node => node.kind === 'lane').sort(byId);
    const jobs = nodes.filter(node => node.kind === 'job').sort(byId);
    const laneNames = new Set(lanes.map(node => (node.lane === '' ? nodeKey(node) : node.lane)));
    const list = [{ id: 'leader', kind: 'leader', lane: '', details: isRecord(leader) ? leader : { event: leader ?? 'unknown' } }];
    const links = [];
    for (const node of lanes) {
      list.push(node);
      links.push({ source: 'leader', target: node.id });
    }
    for (const node of jobs) {
      const lane = node.lane === '' ? 'unassigned' : node.lane;
      list.push({ ...node, lane });
      links.push({ source: laneNames.has(lane) ? `lane:${lane}` : 'leader', target: node.id });
    }
    for (const node of jobs) {
      const url = node.details.pr_url ?? node.details.prUrl;
      if (typeof url !== 'string' || url === '') continue;
      const jobId = String(node.details.job_id ?? node.details.id ?? nodeKey(node));
      list.push({ id: `pr:${jobId}`, kind: 'pr', lane: node.lane === '' ? 'unassigned' : node.lane, details: { job_id: jobId, url } });
      links.push({ source: node.id, target: `pr:${jobId}` });
    }
    const names = [...new Set([...RESOURCES, ...Object.keys(errors)])].sort(byName);
    for (const name of names) {
      list.push({ id: `resource:${name}`, kind: 'resource', lane: '', details: { source: name, status: errors[name] ?? 'ok' } });
      links.push({ source: `resource:${name}`, target: 'leader' });
    }
    return { nodes: list, links, leader, errors };
  }
  return { apply, graph, get leader() { return leader; }, get errors() { return errors; } };
}

// Leader at the hub; lanes orbit above, jobs fan around their lane, PRs trail jobs, resources below.
export function layout(nodes) {
  const lanes = nodes.filter(node => node.kind === 'lane');
  const jobs = nodes.filter(node => node.kind === 'job');
  const laneAngle = new Map(lanes.map((node, index) =>
    [node.lane === '' ? nodeKey(node) : node.lane, index * 2 * Math.PI / Math.max(1, lanes.length) - Math.PI / 2]));
  const groups = new Map();
  for (const job of jobs) groups.set(job.lane, [...groups.get(job.lane) ?? [], job]);
  const jobAngle = new Map(), position = new Map();
  let orphans = 0, resources = 0;
  const resourceCount = nodes.filter(node => node.kind === 'resource').length;
  const orphanAngle = () => {
    orphans += 1;
    return orphans * 2.39996;
  };
  for (const node of nodes) {
    if (node.kind === 'leader') position.set(node, { x: 0, y: 0, z: 0 });
    else if (node.kind === 'lane') {
      const angle = laneAngle.get(node.lane === '' ? nodeKey(node) : node.lane) ?? 0;
      position.set(node, { x: Math.cos(angle) * .62, y: -.45, z: Math.sin(angle) * .62 });
    } else if (node.kind === 'job') {
      const group = groups.get(node.lane) ?? [node], base = laneAngle.get(node.lane);
      const angle = base === undefined ? orphanAngle() : base + (group.indexOf(node) - (group.length - 1) / 2) * .3;
      jobAngle.set(node.id, angle);
      position.set(node, { x: Math.cos(angle), y: 0, z: Math.sin(angle) });
    }
  }
  for (const node of nodes) {
    if (node.kind === 'pr') {
      const parent = jobAngle.get(`job:${node.details.job_id ?? nodeKey(node)}`);
      const angle = (parent === undefined ? orphanAngle() : parent) + .22;
      position.set(node, { x: Math.cos(angle) * 1.24, y: -.08, z: Math.sin(angle) * 1.24 });
    } else if (node.kind === 'resource') {
      const angle = resources * 2 * Math.PI / Math.max(1, resourceCount) + Math.PI / 4;
      resources += 1;
      position.set(node, { x: Math.cos(angle) * .5, y: .55, z: Math.sin(angle) * .5 });
    }
  }
  return nodes.map(node => ({ node, ...(position.get(node) ?? { x: 0, y: 0, z: 0 }) }));
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
    if (distance < nearest || (distance === nearest && best !== null && point.depth < best.depth)) {
      nearest = distance;
      best = point;
    }
  }
  return best === null ? null : best.node;
}

function labelOf(node) {
  if (node.kind === 'leader') return 'leader';
  if (node.kind === 'pr') return `PR ${String(node.details.job_id ?? nodeKey(node))}`;
  if (node.kind === 'job') return String(node.details.job_id ?? node.details.id ?? nodeKey(node));
  return nodeKey(node);
}
function colorOf(node, data) {
  if (node.kind === 'job' || node.kind === 'pr') {
    const state = String(data.state ?? data.status ?? '').toLowerCase();
    if (state === 'merged' || data.merged_at) return '#34d399';
    if (['running', 'started', 'in_progress'].includes(state)) return '#60a5fa';
    if (['failed', 'error'].includes(state)) return '#f87171';
    if (state === 'empty' || !state) return '#94a3b8';
  }
  if (node.kind === 'resource' && node.details.status !== 'ok') return '#f87171';
  return COLOR[node.kind] ?? '#e2e8f0';
}

export function mountNodeMap(doc, { open, fetcher = fetch, schedule = setTimeout, cancel = clearTimeout, interval = 1500, frame, now = Date.now } = {}) {
  const map = createNodeMap(), el = selector => doc.querySelector(selector);
  const canvas = el('canvas'), ctx = canvas.getContext('2d'), selector = el('#nodes');
  const live = createMapFilter(), filter = doc.createElement('input'), label = doc.createElement('label'), count = doc.createElement('output');
  filter.type = 'search'; filter.id = 'map-filter'; filter.placeholder = 'Job ID, lane, repo or PR #';
  label.textContent = 'Filter map '; label.append(filter, count);
  const header = el('header'), help = header.lastChild;
  if (help?.nodeType === 3) help.textContent = 'Drag to rotate · scroll to zoom · select a node for details. Violet: leader · cyan: lanes · gray/red: resources.';
  const legend = doc.createElement('p');
  legend.textContent = 'Job state: blue running · gray empty · red failed · green merged · amber other. Rings mark updates.';
  header.append(legend, label);
  const updateCount = () => {
    const list = nodes();
    count.textContent = ` ${list.filter(node => live.alpha(node, filter.value) === 1).length}/${list.length} matching`;
  };
  filter.oninput = updateCount;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const camera = { angle: .4, tilt: .3, zoom: 1 };
  const step = frame ?? (callback => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(callback) : 0));
  let selected = '', drag = null, moved = false, points = [], timer, pending = false, stopped = false, detailsGen = 0;
  const show = (id, value) => {
    el(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  };
  async function get(path) {
    const response = await fetcher(path, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('Request failed');
    return response.json();
  }
  const nodes = () => map.graph().nodes;
  const jobOf = node => (!node || !['job', 'pr'].includes(node.kind) ? '' : String(node.details.job_id ?? node.details.id ?? nodeKey(node)));
  async function details() {
    detailsGen += 1;
    const generation = detailsGen, node = nodes().find(item => item.id === selected);
    show('#details', node ? node.details : { leader: map.leader, errors: map.errors });
    try {
      const tail = await get('/api/log-tail' + (jobOf(node) === '' ? '' : '?job=' + encodeURIComponent(jobOf(node))));
      if (generation === detailsGen) show('#logs', tail);
    } catch {
      if (generation === detailsGen) show('#logs', 'Unavailable');
    }
  }
  function select(id) {
    const node = nodes().find(item => item.id === id);
    selected = node ? id : '';
    selector.value = selected;
    if (node) open?.(node);
    void details();
  }
  selector.onchange = () => select(selector.value);
  async function poll() {
    if (pending || stopped) return;
    pending = true;
    try {
      map.apply(await get('/api/graph'));
      const list = nodes();
      live.apply(list, now());
      updateCount();
      const option = (value, text) => {
        const item = doc.createElement('option');
        item.value = value;
        item.textContent = text;
        return item;
      };
      selector.replaceChildren(option('', 'Fleet'), ...list.map(node => option(node.id, node.id)));
      if (![...selector.children].some(item => item.value === selected)) selected = '';
      selector.value = selected;
      el('#status').textContent = Object.keys(map.errors).length ? 'Some sources unavailable · retrying' : `Live · ${list.length} nodes`;
      await details();
    } catch {
      if (!stopped) el('#status').textContent = 'Disconnected · retrying';
    } finally {
      pending = false;
      if (!stopped) timer = schedule(poll, interval);
    }
  }
  function draw() {
    const width = canvas.clientWidth, height = canvas.clientHeight, density = globalThis.devicePixelRatio || 1;
    if (canvas.width !== width * density || canvas.height !== height * density) {
      canvas.width = width * density;
      canvas.height = height * density;
    }
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const graph = map.graph();
    points = project(layout(graph.nodes), camera, width, height);
    const opacity = new Map(graph.nodes.map(node => [node.id, live.alpha(node, filter.value)])), time = now();
    ctx.strokeStyle = '#52627d';
    for (const link of graph.links) {
      const a = points.find(point => point.node.id === link.source), b = points.find(point => point.node.id === link.target);
      if (a && b) {
        ctx.globalAlpha = (.2 + Math.max(0, .5 - (a.depth + b.depth) * .25)) * Math.min(opacity.get(link.source), opacity.get(link.target));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.font = '11px system-ui';
    for (const point of [...points].sort((a, b) => b.depth - a.depth)) {
      ctx.globalAlpha = opacity.get(point.node.id);
      ctx.fillStyle = colorOf(point.node, live.details(point.node));
      const pulse = reducedMotion ? 0 : live.pulse(point.node.id, time);
      if (pulse > 0) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.globalAlpha *= pulse;
        ctx.beginPath();
        ctx.arc(point.x, point.y, (RADIUS[point.node.kind] ?? 5) + 4 + (1 - pulse) * 16, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = opacity.get(point.node.id);
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, (RADIUS[point.node.kind] ?? 5) + (point.node.id === selected ? 3 : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(labelOf(point.node), point.x + 10, point.y + 4);
    }
    ctx.globalAlpha = 1;
    if (!stopped) step(draw);
  }
  canvas.onpointerdown = event => {
    drag = { x: event.clientX, y: event.clientY };
    moved = false;
    canvas.setPointerCapture?.(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      camera.angle += dx * .01;
      camera.tilt += dy * .01;
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
  canvas.onpointercancel = () => {
    drag = null;
  };
  canvas.onwheel = event => {
    event.preventDefault();
    camera.zoom = Math.max(.3, Math.min(2, camera.zoom - event.deltaY * .001));
  };
  const ready = poll();
  step(draw);
  return {
    ready, poll, draw, select, map,
    get points() { return points; },
    get selected() { return selected; },
    stop() { stopped = true; cancel(timer); },
  };
}

if (typeof document !== 'undefined') {
  const controls = mountControlPanel(document);
  const sessions = mountSessionPanel(document);
  const steering = mountSteerPanel(document);
  const view = mountNodeMap(document, {
    open(node) {
      controls.open(node);
      void steering.open(node); // refresh handles failures inside the steering panel
      void sessions.open(node).catch(() => { /* session failures stay inside the dialog */ });
    },
  });
  window.addEventListener('pagehide', () => view.stop(), { once: true });
}

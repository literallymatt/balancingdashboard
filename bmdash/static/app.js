/* GB Balancing Mechanism dashboard. Vanilla JS + ECharts; all state lives in the URL hash. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => new Date(s.slice(0, 10) + 'T00:00:00Z');
const addDays = (s, n) => iso(new Date(parseDay(s).getTime() + n * DAY));

// ------------------------------------------------------------------ state

const DIM_LABEL = { direction: 'Direction', tech: 'Technology', fuel: 'Fuel type (Elexon)', party: 'Lead party',
  unit: 'BM unit', unit_type: 'BMU type', gsp: 'GSP group', pair: 'Bid-offer pair', so: 'SO flag' };
const DIMS = Object.keys(DIM_LABEL);
const state = { view: 'overview', unit: null, from: null, to: null, bucket: 'auto',
  metric: 'net', split: 'tech', bdim: 'party', filters: {}, day: null, bnd: null, cmetric: 'bind', cview: 'boundary', rkind: 'production', rsplit: 'gsp', rt: null, rgsp: null, rlong: null, rmsg: null,
  ic: null, icp: null, imetric: 'net', isplit: 'ic', ibd: 'party', imap: 'volume', ipdir: 'buy', it: null, iheat: 'clear', rvd: null, rvic: null, rvm: 'over', rvt: 'over',
  dmetric: 'proc', dsplit: 'none', dbd: 'party', dp: null, dev: null, ddir: null, dtag: null, dtest: null, dz: null, dzm: 'proc', dzev: null, dbin: null };
let META = { days: [] };

function readHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/');
  state.view = parts[0] || 'overview';
  state.unit = state.view === 'unit' ? decodeURIComponent(parts[1] || '') : null;
  const unitView = state.view === 'unit';
  Object.assign(state, { bucket: 'auto', metric: 'net', split: unitView ? 'direction' : 'tech', bdim: unitView ? 'pair' : 'party', day: null,
    bnd: null, cmetric: 'bind', cview: 'boundary', rkind: 'production', rsplit: 'gsp', rt: null, rgsp: null, rlong: null, rmsg: null,
    ic: null, icp: null, imetric: 'net', isplit: 'ic', ibd: 'party', imap: 'volume', ipdir: 'buy', it: null, iheat: 'clear', rvd: null, rvic: null, rvm: 'over', rvt: 'over',
    dmetric: 'proc', dsplit: 'none', dbd: 'party', dp: null, dev: null, ddir: null, dtag: null, dtest: null, dz: null, dzm: 'proc', dzev: null, dbin: null });
  const p = new URLSearchParams(qs || '');
  state.filters = {};
  for (const [k, v] of p) {
    if (k.startsWith('f.')) state.filters[k.slice(2)] = v.split('|');
    else if (k in state) state[k] = v;
  }
}

function writeHash(replace = false) {
  const h = stateHash();
  if (replace) history.replaceState(null, '', h); else location.hash = h;
  if (replace) render();
}

/** The URL hash for the current state. */
function stateHash() {
  const p = new URLSearchParams();
  for (const k of ['from', 'to', 'bucket', 'metric', 'split', 'bdim']) if (state[k]) p.set(k, state[k]);
  if (state.view === 'unit' && state.day) p.set('day', state.day);
  if (state.view === 'constraints') for (const k of ['bnd', 'cmetric', 'cview']) if (state[k]) p.set(k, state[k]);
  if (state.view === 'remit') for (const k of ['rkind', 'rsplit', 'rt', 'rgsp', 'rlong', 'rmsg']) if (state[k]) p.set(k, state[k]);
  if (state.view === 'interconnectors') for (const k of ['ic', 'icp', 'imetric', 'isplit', 'ibd', 'imap', 'ipdir', 'it', 'iheat']) if (state[k]) p.set(k, state[k]);
  if (state.view === 'icrev') for (const k of ['rvd', 'rvic', 'rvm', 'rvt']) if (state[k]) p.set(k, state[k]);
  if (state.view === 'dfs') for (const k of ['dmetric', 'dsplit', 'dbd', 'dp', 'dev', 'ddir', 'dtag', 'dtest', 'dz', 'dzm', 'dzev', 'dbin']) if (state[k]) p.set(k, state[k]);
  for (const [k, v] of Object.entries(state.filters)) if (v.length) p.set('f.' + k, v.join('|'));
  const path = state.view === 'unit' ? `unit/${encodeURIComponent(state.unit)}` : state.view;
  return `#/${path}?${p}`;
}

function update(patch, replace = false) { Object.assign(state, patch); writeHash(replace); }

// ------------------------------------------------------------------ click-through trail
// Clicking a chart, map or table row drills in: to a shorter period, one interconnector, one boundary, one DFS
// event, one unit... Each click-through remembers where it came from, so the filter bar can show a "Back" button
// and a breadcrumb trail (e.g. "5 Nov – 14 Nov 2026 › Mon 9 Nov › IFA") to step back out. Esc also steps back.
// Kept in sessionStorage so a reload keeps the trail; the browser's Back button also still works.

let trailAt = -1;  // the trail position the bar was last drawn for (pages may fill in defaults after that)
let zoomTrail = (() => { try { return JSON.parse(sessionStorage.getItem('zoomTrail')) || []; } catch { return []; } })();
const saveTrail = () => { try { sessionStorage.setItem('zoomTrail', JSON.stringify(zoomTrail)); } catch { /* storage off */ } };
const fmtDay = (d) => { const x = parseDay(d); return `${DOW[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };

/** Short words for a range: "Wed 9 Oct 2026", or "1 Oct – 30 Oct 2026". */
function rangeLabel(r) {
  if (!r.from || !r.to) return 'previous view';
  if (r.from === r.to) return fmtDay(r.from);
  const a = parseDay(r.from), b = parseDay(r.to);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  return `${a.getUTCDate()} ${MON[a.getUTCMonth()]}${sameYear ? '' : ` ${a.getUTCFullYear()}`} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

/** A moment picked on a chart ("2026-11-09T14:30:00" or "2026-11-09") in words. */
function momentLabel(t) {
  const s = String(t);
  if (s.length <= 10 || s.slice(11, 16) === '00:00') return fmtDay(s);
  const d = new Date(s.slice(0, 19) + 'Z');
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// The selections each page lets you click into, and how to name them (set, and cleared).
const DRILL_FIELDS = {
  unit: { day: [(v) => `detail for ${fmtDay(v)}`, 'no day detail'] },
  constraints: { bnd: [(v) => bname(v), 'all boundaries'] },
  remit: { rgsp: [(v) => gspName(v), 'all regions'], rmsg: [(v) => `outage: ${remitName(v)}`, 'outage closed'] },
  interconnectors: { ic: [(v) => icName(v), 'all interconnectors'], icp: [(v) => v, 'all counterparties'], it: [(v) => `${momentLabel(v)} selected`, 'whole range'] },
  icrev: { rvd: [(v) => `${fmtDay(v)} in detail`, 'busiest day'], rvic: [(v) => icName(v), 'busiest link'] },
  dfs: { dev: [(v) => `event ${v}`, 'latest event'], dp: [(v) => v, 'all providers'], dz: [(v) => `zone ${v}`, 'all zones'] },
};
// Unit names of REMIT messages seen in the outage table, so the trail can name an opened outage (survives a reload).
const remitNames = (() => { try { return JSON.parse(sessionStorage.getItem('remitNames')) || {}; } catch { return {}; } })();
const remitName = (mrid) => remitNames[mrid] || 'details';
function noteRemitNames(rows) {
  for (const r of rows) if (r.mrid) remitNames[r.mrid] = `${r.name || r.asset}${r.start ? `, from ${+r.start.slice(8, 10)} ${MON[+r.start.slice(5, 7) - 1]}` : ''}`;
  try { sessionStorage.setItem('remitNames', JSON.stringify(remitNames)); } catch { /* storage off */ }
}
const VIEW_NAME = { overview: 'Overview', units: 'Units', constraints: 'Constraints', remit: 'REMIT', interconnectors: 'Interconnectors', icrev: 'IC reversals', dfs: 'DFS' };

/** What a click-through can change: the page, its range, filters and the selections that page has. */
function drillKey() {
  const k = { view: state.view, unit: state.unit || null, from: state.from, to: state.to, filters: JSON.stringify(state.filters || {}),
    bucket: state.bucket, split: state.split, bdim: state.bdim };  // last three are restored on the way back, not compared
  for (const f of Object.keys(DRILL_FIELDS[state.view] || {})) k[f] = state[f] ?? null;
  return k;
}
const COMPARED = (k) => ['view', 'unit', 'from', 'to', 'filters', ...Object.keys(DRILL_FIELDS[k.view] || {})];
const sameKey = (a, b) => COMPARED(a).every((f) => String(a[f] ?? '') === String(b[f] ?? '')) && COMPARED(b).every((f) => String(a[f] ?? '') === String(b[f] ?? ''));

/** The page a view is on, in words: "Overview", "Unit T_RYHPS-1". */
const pageName = (k) => (k.view === 'unit' ? `Unit ${k.unit}` : VIEW_NAME[k.view] || k.view);

/** The whole of a view in words: "Interconnectors · 5 Nov – 14 Nov 2026 · IFA". */
function describe(k) {
  const bits = [pageName(k), rangeLabel(k)];
  for (const [dim, vals] of Object.entries(JSON.parse(k.filters || '{}'))) if (vals.length) bits.push(vals.join(', '));
  for (const [f, [named]] of Object.entries(DRILL_FIELDS[k.view] || {})) if (k[f] != null && !(f === 'dev')) bits.push(named(k[f]));
  if (k.view === 'dfs' && k.dev != null) bits.push(DRILL_FIELDS.dfs.dev[0](k.dev));
  return bits.join(' · ');
}

/** What one click-through changed, in a few words: "Mon 9 Nov 2026", "IFA", "Lead party: X". */
function stepLabel(a, b) {
  if (a.view !== b.view || a.unit !== b.unit) return pageName(b);
  const bits = [];
  if (a.from !== b.from || a.to !== b.to) bits.push(rangeLabel(b));
  const fa = JSON.parse(a.filters || '{}'), fb = JSON.parse(b.filters || '{}');
  for (const dim of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (JSON.stringify(fa[dim] || []) === JSON.stringify(fb[dim] || [])) continue;
    bits.push(fb[dim]?.length ? `${DIM_LABEL[dim] || dim}: ${fb[dim].join(', ')}` : `any ${(DIM_LABEL[dim] || dim).toLowerCase()}`);
  }
  for (const [f, [named, none]] of Object.entries(DRILL_FIELDS[b.view] || {})) {
    if (String(a[f] ?? '') === String(b[f] ?? '')) continue;
    if (f === 'dev' && b[f] == null && bits.length) continue;  // a new range or provider resets the event; not worth saying
    bits.push(b[f] != null ? named(b[f]) : none);
  }
  return bits.join(' · ') || describe(b);
}

/** Where the current view sits in the trail: the index of the click-through that led here, or -1. */
const trailPos = () => { const k = drillKey(); for (let i = zoomTrail.length - 1; i >= 0; i--) if (sameKey(zoomTrail[i].to, k)) return i; return -1; };
/** As trailPos, but trusting the drawn bar when a page has since filled in a default (e.g. the unit page's day). */
const here = () => { const i = trailPos(); return i >= 0 ? i : trailAt; };

/**
 * Drill in from a click: apply `patch`, remembering the current view so it can be stepped back to.
 * Pass render: false when the page redraws itself (it only gets a new history entry and the trail).
 */
function drill(patch, { render = true, reveal = null } = {}) {
  const i = here();
  if (reveal) pendingReveal = reveal;
  zoomTrail = zoomTrail.slice(0, i + 1);  // drilling from somewhere not on the trail starts a fresh one
  const from = drillKey();
  Object.assign(state, patch);
  const to = drillKey();
  if (sameKey(from, to)) { if (render) writeHash(true); return; }
  zoomTrail.push({ from, to });
  saveTrail();
  if (render) writeHash();  // a real history entry, so the browser's Back button steps out too
  else { history.pushState(null, '', stateHash()); drawZoomTrail(); revealPending(); }
}
const zoomTo = (patch, opts) => drill(patch, opts);

// ------------------------------------------------------------------ show what a click changed
// Some clicks change a card further down the page (a unit's day detail, a boundary's detail, a DFS event's bids).
// After such a click, scroll that card into view if it is off-screen and flash its outline, so the click visibly does
// something. Cards already on screen are only flashed.
let pendingReveal = null;
function revealPending() {
  const sel = pendingReveal;
  pendingReveal = null;
  const el = sel && $(sel);
  if (!el) return;
  const stuck = Math.max($('.top')?.getBoundingClientRect().bottom || 0, $('#filterbar:not([hidden])')?.getBoundingClientRect().bottom || 0);
  const r = el.getBoundingClientRect();
  if (r.top < stuck || r.top > innerHeight - 120) {
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollTo({ top: scrollY + r.top - stuck - 12, behavior: smooth ? 'smooth' : 'auto' });
  }
  el.classList.remove('flash');
  void el.offsetWidth;  // restart the animation if it is already running
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/** For in-page changes that are not click-throughs (replay, slider): keep the trail pointing at where we are. */
function followTrail(fn) {
  const i = here();
  fn();
  if (i >= 0) { zoomTrail[i].to = drillKey(); saveTrail(); }
}

/** Step back out `steps` click-throughs, keeping display settings (measure, split...) changed since. */
function zoomOut(steps = 1) {
  const i = trailAt;
  if (i < 0) return;
  const r = zoomTrail[Math.max(0, i - steps + 1)].from;
  const patch = { view: r.view, unit: r.unit, from: r.from, to: r.to, bucket: r.bucket || 'auto', filters: JSON.parse(r.filters || '{}') };
  if (r.view !== state.view) Object.assign(patch, { split: r.split, bdim: r.bdim });
  for (const f of Object.keys(DRILL_FIELDS[r.view] || {})) patch[f] = r[f];
  update(patch);
}

function drawZoomTrail() {
  const el = $('#zoomTrail');
  if (!el) return;
  const i = trailAt = trailPos();
  if (i < 0) { el.hidden = true; el.innerHTML = ''; return; }
  const crumbs = zoomTrail.slice(0, i + 1), back = describe(crumbs[i].from);
  // Each crumb names the view it goes back to: the first in full ("Overview · 9 Nov – 15 Nov 2026"), later ones by what
  // that click changed ("Unit T_RYHPS-1", "Mon 9 Nov 2026"). The Back button uses the same short words as the last crumb.
  const label = (j) => (j === 0 ? describe(crumbs[0].from) : stepLabel(crumbs[j - 1].from, crumbs[j - 1].to));
  el.hidden = false;
  el.innerHTML = `<button type="button" class="btn zoom-back" title="Go back to ${esc(back)} (Esc)">← Back to ${esc(label(i))}</button>
    <nav class="crumbs small" aria-label="Where you have clicked through">${crumbs.map((z, j) => `<a href="#" data-steps="${i - j + 1}" title="Go back to ${esc(describe(z.from))}">${esc(label(j))}</a><span class="sep" aria-hidden="true">›</span>`).join('')}<b aria-current="page">${esc(stepLabel(crumbs[i].from, crumbs[i].to))}</b></nav>
    <span class="muted small hint">or press Esc</span>`;
  el.querySelector('.zoom-back').onclick = () => zoomOut(1);
  el.querySelectorAll('.crumbs a').forEach((a) => a.onclick = (e) => { e.preventDefault(); zoomOut(+a.dataset.steps); });
}

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.target.closest?.('input, select, textarea')) return;
  if ((!$('#tipbox') || $('#tipbox').hidden) && trailAt >= 0 && !$('#zoomTrail').hidden) zoomOut(1);
});

function queryParams(extra = {}) {
  const p = { from: state.from, to: state.to };
  for (const [k, v] of Object.entries(state.filters)) if (v.length) p[k] = v.join('|');
  if (state.view === 'unit') p.unit = state.unit;
  return { ...p, ...extra };
}

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const r = await fetch(`/api/${path}?${qs}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

// ------------------------------------------------------------------ formatting

const nf = (d) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
function gbp(v, compact = true) {
  if (v == null || isNaN(v)) return '–';
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (!compact || a < 1000) return `${s}£${nf(0).format(a)}`;
  if (a < 1e6) return `${s}£${nf(a < 1e4 ? 2 : 1).format(a / 1e3)}k`;
  if (a < 1e9) return `${s}£${nf(a < 1e7 ? 2 : 1).format(a / 1e6)}m`;
  return `${s}£${nf(2).format(a / 1e9)}bn`;
}
function mwh(v) {
  if (v == null || isNaN(v)) return '–';
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a < 1000) return `${s}${nf(a < 10 ? 1 : 0).format(a)} MWh`;
  if (a < 1e6) return `${s}${nf(a < 1e4 ? 2 : 1).format(a / 1e3)} GWh`;
  return `${s}${nf(2).format(a / 1e6)} TWh`;
}
const price = (v) => (v == null || !isFinite(v) ? '–' : `${v < 0 ? '−' : ''}£${nf(Math.abs(v) < 100 ? 2 : 0).format(Math.abs(v))}/MWh`);
const ratio = (a, b) => (b ? a / b : null);
const spTime = (sp) => `${String(Math.floor((sp - 1) / 2) % 24).padStart(2, '0')}:${sp % 2 ? '00' : '30'}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function bucketLabel(t, bucket) {
  if (bucket === 'tod') return spTime(t);
  const d = new Date(t + 'Z');
  const dm = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (bucket === 'sp' || bucket === 'hour') return `${dm} ${hm}`;
  if (bucket === 'day') return `${DOW[d.getUTCDay()]} ${dm}`;
  if (bucket === 'week') return `w/c ${dm}`;
  return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function resolveBucket() {
  if (state.bucket !== 'auto') return state.bucket;
  const n = (parseDay(state.to) - parseDay(state.from)) / DAY + 1;
  return n <= 2 ? 'sp' : n <= 10 ? 'hour' : n <= 180 ? 'day' : n <= 900 ? 'week' : 'month';
}

/** Every bucket in range, so periods with no accepted actions still show as gaps. */
function allBuckets(bucket, rows) {
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const a = parseDay(state.from).getTime(), b = parseDay(state.to).getTime() + DAY;
  const step = { sp: DAY / 48, hour: DAY / 24, day: DAY }[bucket];
  if (bucket === 'tod') return Array.from({ length: 48 }, (_, i) => i + 1);
  if (!step) return [...new Set(rows.map((r) => r.t))].sort();
  const out = [];
  for (let t = a; t < b; t += step) out.push(stamp(t));
  for (const r of rows) if (!out.includes(r.t) && bucket === 'sp') out.push(r.t); // clock-change SPs 49/50
  return out.sort();
}

// ------------------------------------------------------------------ colour (follows the entity)

const TECH_ORDER = ['Gas', 'Interconnector', 'Wind', 'Pumped storage', 'Biomass', 'Hydro', 'Battery', 'Nuclear', 'Coal', 'Other'];
const FIXED = {
  tech: { Gas: '--s1', Interconnector: '--s2', Wind: '--s3', 'Pumped storage': '--s4', Biomass: '--s5', Hydro: '--s6',
    Battery: '--s7', Nuclear: '--s8', Coal: '--other2', Other: '--other' },
  direction: { offer: '--s1', bid: '--s2' },
  so: { 'Not SO-flagged': '--s1', 'SO-flagged': '--s2' },
};
const sticky = {};
function colourVar(dim, name) {
  if (name === 'Other (rest)') return '--other';
  if (dim === 'none') return '--s1';
  if (FIXED[dim]?.[name]) return FIXED[dim][name];
  const m = (sticky[dim] ??= new Map());
  if (!m.has(name)) {
    if (m.size >= 8) m.clear(); // out of slots: start a fresh assignment rather than invent hues
    const used = new Set(m.values());
    m.set(name, [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `--s${i}`).find((s) => !used.has(s)));
  }
  return m.get(name);
}
const colour = (dim, name) => css(colourVar(dim, name));
function orderGroups(dim, groups) {
  if (dim === 'tech') return [...groups].sort((a, b) => TECH_ORDER.indexOf(a) - TECH_ORDER.indexOf(b));
  if (dim === 'direction') return [...groups].sort().reverse();
  return [...groups].sort((a, b) => parseInt(colourVar(dim, a).slice(3) || 99) - parseInt(colourVar(dim, b).slice(3) || 99));
}

// ------------------------------------------------------------------ metrics

const n0 = (v) => v || 0;
const METRICS = {
  net: { label: 'Net cost', fmt: gbp, parts: [{ f: (r) => n0(r.offer_cash) + n0(r.bid_cash) }],
    help: 'Offer plus bid cashflow: what NESO paid BM units, net of what units paid back on bids.' },
  offer_cash: { label: 'Offer payments', fmt: gbp, parts: [{ f: (r) => n0(r.offer_cash) }],
    help: 'Paid to units for accepted offers (turning up).' },
  bid_cash: { label: 'Bid cashflow', fmt: gbp, parts: [{ f: (r) => n0(r.bid_cash) }],
    help: 'Accepted bids (turning down). Negative: units pay NESO. Positive: NESO pays units, e.g. negative-priced wind bids.' },
  volume: { label: 'Accepted volume', fmt: mwh, parts: [{ f: (r) => n0(r.offer_vol), tag: 'offers' }, { f: (r) => n0(r.bid_vol), tag: 'bids' }],
    help: 'Accepted offers plotted upward, accepted bids downward.' },
  price: { label: 'Average accepted price', fmt: price, line: true,
    help: 'Volume-weighted price of accepted actions (cashflow ÷ volume).' },
};

// ------------------------------------------------------------------ charts

const charts = new Map();
function chart(el) {
  let c = charts.get(el);
  if (c && c.getDom() !== el) { c.dispose(); c = null; }
  if (!c) { c = echarts.init(el, null, { renderer: 'canvas' }); charts.set(el, c); }
  c.off('click');
  return c;
}
function pruneCharts() { for (const [el, c] of charts) if (!el.isConnected) { c.dispose(); charts.delete(el); } }
addEventListener('resize', () => charts.forEach((c) => c.resize()));

function baseOption() {
  const ink2 = css('--ink2'), muted = css('--muted'), grid = css('--grid'), axis = css('--axis');
  const axisCommon = { axisLine: { lineStyle: { color: axis } }, axisTick: { show: false },
    axisLabel: { color: muted, fontSize: 11 }, splitLine: { lineStyle: { color: grid } } };
  return {
    animation: false, textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { type: 'scroll', top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: ink2, fontSize: 12 },
      pageTextStyle: { color: muted }, pageIconColor: ink2, pageIconInactiveColor: grid },
    tooltip: { trigger: 'axis', backgroundColor: css('--surface'), borderColor: css('--axis'), textStyle: { color: css('--ink') },
      axisPointer: { type: 'line', lineStyle: { color: axis } }, confine: true },
    xAxis: { ...axisCommon, splitLine: { show: false } },
    yAxis: { ...axisCommon, axisLine: { show: false } },
  };
}

function tipHtml(title, items, fmt, total) {
  const rows = items.filter((i) => i.value != null && i.value !== 0)
    .map((i) => `<div class="r"><i style="background:${i.color}"></i><span>${esc(i.name)}</span><b>${esc(fmt(i.value))}</b></div>`);
  if (!rows.length) rows.push('<div class="r"><span>No accepted actions</span></div>');
  const tot = total != null && rows.length > 1 ? `<div class="r tot"><span>Total</span><b>${esc(fmt(total))}</b></div>` : '';
  return `<div class="tt"><div class="t">${esc(title)}</div>${rows.join('')}${tot}</div>`;
}

/** Footer line for a tooltip saying where a click goes. */
const clickHint = (text) => (text ? `<div class="tt-hint">${esc(text)}</div>` : '');

/** Where drillTime() takes you for one time bucket, in words; null when a click does nothing. */
function drillHint(t, bucket) {
  if (bucket === 'tod' || t == null) return null;
  const d = String(t).slice(0, 10), day = bucketLabel(d + 'T00:00:00', 'day');
  if (bucket === 'sp' || bucket === 'hour' || bucket === 'day') {
    if (state.view === 'unit') return `Click to zoom to ${day} and show this unit's half-hourly detail`;
    return bucket === 'day' || state.from !== d || state.to !== d ? `Click to zoom to ${day}` : null;
  }
  return bucket === 'week' ? `Click to zoom to the week starting ${day}` : `Click to zoom to ${bucketLabel(t, 'month')}`;
}

async function loading(el, fn) {
  el.classList.add('loading');
  try { await fn(); } catch (e) { console.error(e); el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; charts.delete(el); }
  el.classList.remove('loading');
}

/** Main time chart: stacked bars (or price lines) per bucket, optionally split by a dimension. */
async function timeChart(el, tableEl) {
  const bucket = resolveBucket(), m = METRICS[state.metric] || METRICS.net;
  const split = state.split;
  const data = await api('agg', queryParams({ bucket, group: split, rank: state.metric === 'volume' ? 'vol' : 'cash', top: 8 }));
  const cats = allBuckets(bucket, data.rows);
  const idx = new Map(cats.map((t, i) => [t, i]));
  const groups = orderGroups(split, data.groups);
  const byG = new Map(groups.map((g) => [g, new Array(cats.length).fill(null)]));
  for (const r of data.rows) if (byG.has(r.g) && idx.has(r.t)) byG.get(r.g)[idx.get(r.t)] = r;

  let series = [];
  const o = baseOption();
  if (m.line) {
    const bidOnly = (state.filters.direction || []).join() === 'bid';
    const defs = split === 'none'
      ? [['Offers', (r) => ratio(r.offer_cash, r.offer_vol), css('--s1')], ['Bids', (r) => ratio(r.bid_cash, r.bid_vol), css('--s2')]]
      : groups.map((g) => [g, (r) => (bidOnly ? ratio(r.bid_cash, r.bid_vol) : ratio(r.offer_cash, r.offer_vol)), colour(split, g)]);
    series = defs.map(([name, f, color], i) => ({
      name, type: 'line', color, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: cats.length > 60 ? 0 : 6, connectNulls: false,
      data: (split === 'none' ? byG.get('All') || [] : byG.get(name)).map((r) => (r ? f(r) : null)),
    }));
    $('#timeNote').textContent = split === 'none' ? m.help : `${m.help} Showing ${bidOnly ? 'bid' : 'offer'} prices per group.`;
  } else {
    const gap = cats.length <= 70;
    for (const g of groups) for (const part of m.parts) {
      series.push({
        name: split === 'none' ? (part.tag ? part.tag[0].toUpperCase() + part.tag.slice(1) : m.label) : g,
        type: 'bar', stack: 'a', barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%',
        color: split === 'none' ? (part.tag === 'bids' ? css('--s2') : css('--s1')) : colour(split, g),
        itemStyle: gap ? { borderColor: css('--surface'), borderWidth: 1 } : {},
        emphasis: { disabled: true }, _tag: part.tag,
        data: byG.get(g).map((r) => (r ? part.f(r) || null : null)),
      });
    }
    $('#timeNote').textContent = m.help;
  }
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', scale: !!m.line, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => m.fmt(v).replace(' MWh', '').replace('/MWh', '') } };
  o.legend.show = series.length > 1;
  o.tooltip.formatter = (ps) => {
    const items = ps.map((p) => ({ name: p.seriesName + (series[p.seriesIndex]._tag && split !== 'none' ? ` · ${series[p.seriesIndex]._tag}` : ''), value: p.value, color: p.color }));
    items.sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0));
    const total = m.line || m.parts.length > 1 ? null : items.reduce((s, i) => s + (i.value || 0), 0);
    return tipHtml(ps[0].axisValueLabel, items, m.fmt, total) + clickHint(drillHint(cats[ps[0].dataIndex], bucket));
  };
  o.series = series;
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = bucket === 'tod' ? 'default' : 'pointer';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {  // click anywhere in a bucket's column to drill into it
    const p = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
    const t = cats[p?.[0]];
    if (t == null || bucket === 'tod') return;
    drillTime(t, bucket);
  });

  // Table view of the same numbers.
  if (tableEl) {
    const rows = cats.map((t, i) => {
      const row = { t: bucketLabel(t, bucket) };
      series.forEach((s, j) => { row['s' + j] = s.data[i]; });
      return row;
    }).filter((r) => series.some((_, j) => r['s' + j] != null));
    table(tableEl, [{ key: 't', label: bucket === 'tod' ? 'Time of day' : 'Period' },
      ...series.map((s, j) => ({ key: 's' + j, label: s.name + (s._tag && split !== 'none' ? ` · ${s._tag}` : ''), num: true, fmt: m.fmt }))], rows, { limit: 400 });
  }
}

function drillTime(t, bucket) {
  const d = t.slice(0, 10);
  if (bucket === 'sp' || bucket === 'hour') {
    if (state.view === 'unit') zoomTo({ day: d }, { reveal: '#dayCard' });
    else if (state.from !== d || state.to !== d) zoomTo({ from: d, to: d, bucket: 'auto' });
    return;
  }
  const end = bucket === 'day' ? d : bucket === 'week' ? addDays(d, 6)
    : iso(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
  zoomTo({ from: d, to: end > META.max ? META.max : end, bucket: 'auto', day: state.view === 'unit' && bucket === 'day' ? d : state.day });
  if (state.view === 'unit' && bucket === 'day') pendingReveal = '#dayCard';
}

/** Horizontal ranked bars for one dimension; click a bar to filter by it. */
async function breakdownChart(el) {
  const dim = state.bdim, m = METRICS[state.metric] || METRICS.net;
  const data = await api('breakdown', queryParams({ group: dim, limit: 400 }));
  const val = (r) => (m.line ? ratio(r.offer_cash, r.offer_vol) : m.parts.length > 1 ? Math.abs(n0(r.offer_vol)) + Math.abs(n0(r.bid_vol)) : m.parts[0].f(r));
  const rows = data.rows.map((r) => ({ ...r, v: val(r) })).filter((r) => r.v != null)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 15).reverse();
  $('#bdNote').textContent = `${data.rows.length} ${DIM_LABEL[dim].toLowerCase()} values · top ${rows.length} by ${m.line ? 'offer price' : m.label.toLowerCase()} · click a bar to filter`;
  const o = baseOption();
  o.legend.show = m.parts?.length > 1;
  o.grid.top = o.legend.show ? 30 : 8;
  o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow', shadowStyle: { color: css('--wash') } },
    formatter: (ps) => {
      const r = rows[ps[0].dataIndex];
      return tipHtml(r.g, [
        { name: 'Net cost', value: n0(r.offer_cash) + n0(r.bid_cash), color: 'transparent', f: gbp },
        { name: 'Offer payments', value: r.offer_cash, color: css('--s1'), f: gbp },
        { name: 'Bid cashflow', value: r.bid_cash, color: css('--s2'), f: gbp },
      ].map((i) => ({ ...i, name: `${i.name}: ${i.f(i.value)}`, value: 1 })), () => '') +
        `<div class="tt"><div class="r"><span>Offers ${esc(mwh(r.offer_vol))} @ ${esc(price(ratio(r.offer_cash, r.offer_vol)))}</span></div>` +
        `<div class="r"><span>Bids ${esc(mwh(r.bid_vol))} @ ${esc(price(ratio(r.bid_cash, r.bid_vol)))}</span></div>` +
        `<div class="r"><span>${r.n_units} unit${r.n_units === 1 ? '' : 's'}</span></div></div>` +
        clickHint(dim === 'unit' ? `Click to open the unit page for ${r.g}` : `Click to filter everything to ${DIM_LABEL[dim]}: ${r.g}`);
    } };
  o.yAxis = { ...o.yAxis, type: 'category', data: rows.map((r) => r.g), splitLine: { show: false },
    axisLabel: { color: css('--ink2'), fontSize: 12, width: el.clientWidth < 560 ? 105 : 170, overflow: 'truncate' } };
  o.xAxis = { ...o.xAxis, type: 'value', splitLine: { lineStyle: { color: css('--grid') } },
    splitNumber: el.clientWidth < 560 ? 3 : 5,
    axisLabel: { color: css('--muted'), fontSize: 11, hideOverlap: true, formatter: (v) => m.fmt(v).replace(' MWh', '').replace('/MWh', '') } };
  const bar = { type: 'bar', barMaxWidth: 16, itemStyle: { borderRadius: 2 }, emphasis: { disabled: true } };
  o.series = m.parts?.length > 1
    ? [{ ...bar, name: 'Offers', stack: 'a', color: css('--s1'), data: rows.map((r) => r.offer_vol) },
       { ...bar, name: 'Bids', stack: 'a', color: css('--s2'), data: rows.map((r) => r.bid_vol) }]
    : [{ ...bar, name: m.label, color: css('--s1'), data: rows.map((r) => r.v),
         label: { show: true, position: 'right', color: css('--ink2'), fontSize: 11, formatter: (p) => m.fmt(p.value) } }];
  if (!o.legend.show) o.grid.right = 70;
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {
    const p = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
    const r = rows[p?.[1]];
    if (!r) return;
    if (dim === 'unit') return openUnit(r.g);
    drill({ filters: { ...state.filters, [dim]: [r.g] } });
  });
}

/** Settlement day x settlement period grid. */
async function heatmapChart(el) {
  const m = METRICS[state.metric] || METRICS.net;
  const data = await api('heatmap', queryParams());
  const val = (r) => (m.line ? ratio(r.offer_cash, r.offer_vol) : m.parts.length > 1 ? Math.abs(n0(r.offer_vol)) + Math.abs(n0(r.bid_vol)) : m.parts[0].f(r));
  const days = [];
  for (let d = state.from; d <= state.to; d = addDays(d, 1)) days.push(d);
  const di = new Map(days.map((d, i) => [d, i]));
  const pts = data.rows.filter((r) => di.has(r.d)).map((r) => [di.get(r.d), r.sp - 1, val(r)]).filter((p) => p[2] != null);
  const vals = pts.map((p) => p[2]).sort((a, b) => a - b);
  const qn = (q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))] ?? 0;
  const lo = qn(0.01), hi = qn(0.99), signed = lo < 0;
  const M = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  const o = baseOption();
  o.legend.show = false;
  o.grid = { left: 8, right: 16, top: 8, bottom: 44, containLabel: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
    const d = new Date(days[p.value[0]] + 'T00:00:00Z');
    return tipHtml(`${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} · SP ${p.value[1] + 1} (${spTime(p.value[1] + 1)})`,
      [{ name: m.line ? 'Avg offer price' : m.label, value: p.value[2], color: p.color }], m.fmt) +
      clickHint(drillHint(days[p.value[0]], 'day'));
  } };
  o.xAxis = { ...o.xAxis, type: 'category', data: days.map((d) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`), splitArea: { show: false } };
  o.yAxis = { ...o.yAxis, type: 'category', data: Array.from({ length: 50 }, (_, i) => spTime(i + 1)), inverse: true,
    axisLabel: { ...o.yAxis.axisLabel, interval: 5 }, splitLine: { show: false }, max: 47 };
  o.visualMap = { type: 'continuous', orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160,
    min: signed ? -M : Math.min(0, lo), max: signed ? M : hi || 1, calculable: false,
    text: [m.fmt(signed ? M : hi), m.fmt(signed ? -M : Math.min(0, lo))], textStyle: { color: css('--muted'), fontSize: 11 },
    inRange: { color: signed ? [css('--div-neg'), css('--div-mid'), css('--div-pos')] : [css('--seq-lo'), css('--seq-hi')] } };
  o.series = [{ type: 'heatmap', data: pts, progressive: 0,
    itemStyle: days.length <= 45 ? { borderColor: css('--surface'), borderWidth: 1 } : {},
    emphasis: { itemStyle: { borderColor: css('--ink'), borderWidth: 1 } } }];
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => {
    const d = days[p.value[0]];
    if (state.view === 'unit') zoomTo({ day: d }, { reveal: '#dayCard' });
    else zoomTo({ from: d, to: d, bucket: 'auto' });
  });
}

async function priceChart(el) {
  const bucket = resolveBucket();
  const data = await api('prices', { from: state.from, to: state.to, bucket });
  const o = baseOption();
  const cats = data.rows.map((r) => bucketLabel(r.t, bucket));
  o.xAxis = { ...o.xAxis, type: 'category', data: cats };
  o.yAxis = { ...o.yAxis, type: 'value', scale: true };
  const fine = bucket === 'sp';
  o.legend.show = !fine;
  o.tooltip.formatter = (ps) => {
    const r = data.rows[ps[0].dataIndex];
    const items = [{ name: fine ? 'System price' : 'Average', value: r.price, color: css('--s1') }];
    if (!fine) items.push({ name: 'Highest', value: r.price_max, color: css('--other') }, { name: 'Lowest', value: r.price_min, color: css('--other') });
    return tipHtml(ps[0].axisValueLabel, items, price);
  };
  const band = { type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, color: css('--other') };
  o.series = [{ name: fine ? 'System price' : 'Average', type: 'line', color: css('--s1'), lineStyle: { width: 2 }, symbol: 'none', data: data.rows.map((r) => r.price) }];
  if (!fine) o.series.push({ ...band, name: 'Highest / lowest in bucket', data: data.rows.map((r) => r.price_max) },
    { ...band, name: 'Highest / lowest in bucket', data: data.rows.map((r) => r.price_min) });
  chart(el).setOption(o, true);
}

async function nivChart(el) {
  const bucket = resolveBucket();
  const data = await api('prices', { from: state.from, to: state.to, bucket });
  const o = baseOption();
  o.legend.show = false; o.grid.top = 10;
  o.xAxis = { ...o.xAxis, type: 'category', data: data.rows.map((r) => bucketLabel(r.t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => mwh(v).replace(' MWh', '') } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, [{ name: ps[0].value >= 0 ? 'System short' : 'System long', value: ps[0].value, color: ps[0].color }], mwh);
  o.series = [{ type: 'bar', barMaxWidth: 20, barCategoryGap: data.rows.length > 200 ? '0%' : '25%', emphasis: { disabled: true },
    data: data.rows.map((r) => ({ value: r.niv, itemStyle: { color: r.niv >= 0 ? css('--div-pos') : css('--div-neg') } })) }];
  chart(el).setOption(o, true);
}

async function bsadChart(el) {
  const bucket = resolveBucket();
  const data = await api('bsad', { from: state.from, to: state.to, bucket });
  const cats = allBuckets(bucket, data.rows), idx = new Map(cats.map((t, i) => [t, i]));
  const names = ['Energy', 'System (SO-flagged)'];
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => gbp(v) } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), gbp,
    ps.reduce((s, p) => s + (p.value || 0), 0));
  o.series = names.map((n, i) => {
    const d = new Array(cats.length).fill(null);
    for (const r of data.rows) if (r.g === n && idx.has(r.t)) d[idx.get(r.t)] = r.cost;
    return { name: n, type: 'bar', stack: 'a', barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%', color: css(i ? '--s2' : '--s1'), emphasis: { disabled: true }, data: d };
  });
  chart(el).setOption(o, true);
}

// ------------------------------------------------------------------ tables

function table(el, cols, rows, { onRow, rowTip, rowCls, limit = 300, sort } = {}) {
  let s = sort || null;
  const draw = () => {
    const data = s ? [...rows].sort((a, b) => {
      const x = a[s.key], y = b[s.key];
      const c = typeof x === 'number' || typeof y === 'number' ? (x ?? -Infinity) - (y ?? -Infinity) : String(x ?? '').localeCompare(String(y ?? ''));
      return s.desc ? -c : c;
    }) : rows;
    const head = cols.map((c) => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}" data-k="${esc(c.key)}" title="Sort by ${esc(c.label)}">${esc(c.label)}${s?.key === c.key ? (s.desc ? ' ↓' : ' ↑') : ''}${c.tip ? tip(c.tip) : ''}</th>`).join('');
    const body = data.slice(0, limit).map((r, i) => `<tr data-i="${i}" class="${onRow ? 'click' : ''} ${rowCls ? rowCls(r) : ''}"${rowTip ? ` title="${esc(rowTip(r))}"` : ''}>${cols.map((c) =>
      `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key] ?? '')}</td>`).join('')}</tr>`).join('');
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (data.length > limit ? `<div class="muted small" style="margin-top:6px">Showing ${limit} of ${data.length} rows</div>` : '') +
      (data.length ? '' : '<div class="empty">No rows</div>');
    el.querySelectorAll('th').forEach((th) => th.onclick = () => {
      const k = th.dataset.k; s = s?.key === k ? { key: k, desc: !s.desc } : { key: k, desc: cols.find((c) => c.key === k).num }; draw();
    });
    if (onRow) el.querySelectorAll('tbody tr').forEach((tr) => tr.onclick = () => onRow(data[+tr.dataset.i], tr));
  };
  draw();
}

const techTag = (r) => `<span class="tag"><span class="dot" style="background:${colour('tech', r.tech)}"></span>${esc(r.tech)}</span>`;
function openUnit(id) { const filters = { ...state.filters }; delete filters.unit; drill({ view: 'unit', unit: id, split: 'direction', bdim: 'pair', day: null, filters }); }

// ------------------------------------------------------------------ views

function select(id, options, value) {
  return `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

// ------------------------------------------------------------------ glossary / info popovers
// Plain-English explanations behind the little "i" buttons. Tap/click one to read it; tap elsewhere to close.
const GLOSS = {
  net: ['Net BM cost', 'What NESO paid for balancing through the Balancing Mechanism (BM): offer payments plus bid cashflow. Bid cashflow is usually negative (units pay NESO), so it reduces the total.'],
  offer: ['Offer payments', 'Money NESO pays when it accepts an "offer": a request for a unit to produce more (or consume less), paid at the unit\'s offer price.'],
  bid: ['Bid cashflow', 'An accepted "bid" asks a unit to produce less (or consume more). Generators normally pay NESO to be turned down, so this is usually negative. It can be positive, for example for wind farms that bid negative prices.'],
  so: ['SO-flagged', 'NESO (the System Operator) accepts bids and offers for two kinds of reason. Energy balancing: the whole system has too much or too little power. System actions: a local need such as a congested line, voltage control or stability. Actions of the second kind carry the "SO flag". This tile shows what they cost and their share of accepted volume. A half-hour counts as flagged if any acceptance covering it carries the flag, so the split is approximate. A dash means there were no flagged actions in the selected range, so the cost was about the energy balance rather than network constraints.'],
  units: ['Units with actions', 'How many BM units had at least one accepted bid or offer in the selected range. A BM unit is a generator, battery, interconnector or demand site registered to trade in the Balancing Mechanism.'],
  activedays: ['Active days', 'Days in the selected range on which this unit had at least one accepted bid or offer.'],
  sysprice: ['System price', 'The imbalance price in £/MWh: what parties whose position is out of balance pay or receive for each half-hour. Shown as the buy price; the range is the lowest and highest half-hour.'],
  bsad: ['Non-BM actions (BSAD)', 'Balancing Services Adjustment Data: the cost of balancing actions NESO takes outside the Balancing Mechanism, such as trades and reserve contracts. Shown for context; the unit filters do not apply to it.'],
  niv: ['Net imbalance volume', 'The size and direction of the whole system\'s imbalance in each half-hour. Red: the system was short, so NESO bought energy. Blue: the system was long, so NESO sold energy or turned generation down.'],
  measure: ['Measure', 'What the chart plots: money (net cost, offer payments, bid cashflow), energy volume (MWh) or the average accepted price (£/MWh).'],
  splitby: ['Split by', 'Colours each bar by a category such as technology, lead party or "SO flag" (system-security actions versus energy-balancing ones). The biggest groups are shown and the rest are combined as "Other".'],
  breakdown: ['Breakdown', 'The top 15 values of the chosen category, ranked by the chosen measure. Tap a bar to filter the whole dashboard to it.'],
  heatmap: ['Day × settlement period', 'One small cell per half-hour. Red means NESO paid more than it received in that half-hour; blue means net receipts. Tap a day to open it.'],
  period: ['Settlement period (SP)', 'GB electricity is traded in 48 half-hour periods a day, numbered from 1 (starting at 00:00 local time). Clock-change days have 46 or 50.'],
  gran: ['Granularity', 'How the time axis is grouped, from single half-hours up to months. "Auto" picks a sensible level for the range.'],
  bmunits: ['BM units', 'Generators, batteries, interconnectors and demand sites registered to take part in the Balancing Mechanism. Totals are for the selected range and filters; tap a unit for its detail.'],
  tech: ['Technology', 'Taken from Elexon\'s fuel type where it exists. Batteries are inferred from the unit\'s name, and everything else is "Other", so treat it as a guide rather than an official classification.'],
  party: ['Lead party', 'The company responsible for the unit in the market.'],
  offervol: ['Offer volume', 'Energy NESO bought from the unit through accepted offers, in MWh.'],
  bidvol: ['Bid volume', 'Energy NESO asked the unit to take out (turn down) through accepted bids, in MWh. Shown as a negative number.'],
  avgoffer: ['Avg offer', 'Average accepted offer price: offer payments ÷ offer volume, in £/MWh.'],
  avgbid: ['Avg bid', 'Average accepted bid price: bid cashflow ÷ bid volume, in £/MWh. Usually the price a unit pays to be turned down.'],
  activeperiods: ['Active periods', 'The number of half-hour periods in which the unit had an accepted action.'],
  soperiods: ['SO-flagged periods', 'Of the active periods, how many were flagged by NESO as system (rather than energy-balancing) actions.'],
  daydetail: ['Day detail', 'For one day: the unit\'s planned output (Physical Notification), its maximum export and import limits (MEL / MIL), and the output NESO instructed. Acceptances often overlap, so the instructed output follows the newest-issued acceptance at each moment, and the unit\'s plan where none applies; this matches Elexon\'s settled volumes. Tick "Individual acceptances" in the legend to see each acceptance\'s own profile. Fetched live from Elexon.'],
  pairs: ['Bid-offer pairs', 'Each unit submits its prices in tiers called bid-offer pairs. Positive pairs (+1, +2…) are offers and negative pairs (−1, −2…) are bids; ±1 is the tier nearest the unit\'s planned output, and NESO generally works outward from there.'],
  paidprice: ['Paid price', 'Cashflow ÷ volume for that half-hour and pair, in £/MWh.'],
  pairbid: ['Pair bid price', 'The unit\'s submitted price for this tier when being turned down, in £/MWh.'],
  pairoffer: ['Pair offer price', 'The unit\'s submitted price for this tier when being turned up, in £/MWh.'],
  pairlevel: ['Pair level (MW)', 'The output level in MW that this price tier is attached to in the unit\'s submitted bid-offer data.'],
  acceptance: ['Acceptances (BOALF)', 'A Bid-Offer Acceptance is NESO\'s instruction to a unit to move to a new output level between two times. This lists every acceptance for the unit in the selected range, newest first, fetched live from Elexon.'],
  levels: ['Output profile (MW)', 'The output, in MW, that the unit was told to follow over the acceptance window, as the levels it passes through: "410 → 38 → 0 MW" means ramp from 410 MW to 38 MW, then to 0 MW. With "Show each point" ticked, each straight piece of the profile is its own row, with the level it starts and ends at.'],
  accpoints: ['Each point of the profile', 'Elexon publishes an acceptance as a series of points (time and MW), so one instruction can be several rows. Unticked, the table shows one row per acceptance with its whole profile; ticked, it shows every row as Elexon publishes it.'],
  stor: ['STOR', 'Short Term Operating Reserve: the acceptance relates to a reserve service NESO contracts for, rather than a normal energy action.'],
  rr: ['RR', 'Replacement Reserve: marks an acceptance that was instructed as replacement reserve.'],
  deemed: ['Deemed', 'A "deemed" bid-offer acceptance is one the settlement rules treat as accepted although it was not issued as a normal instruction.'],
  dbgcpu: ['App CPU', 'How much processor time this app is using, as a % of one core (100% means one core fully busy). It covers the app\'s own work: downloading, parsing and saving. Drawing the charts happens in a separate Android process and is not counted here.'],
  dbgthermal: ['Thermal status', 'Android\'s own verdict on how hot the phone is. "none" is normal; "light" or above means the system is starting to limit performance to cool down.'],
  dbgheadroom: ['Thermal headroom', 'The system\'s forecast of how close the phone is to throttling: 0.0 is cool, 1.0 is the point where throttling begins. Not every phone reports it.'],
  dbgtemp: ['Battery temperature', 'The battery sensor reading in °C. It lags behind the processor temperature but is the one reading every app is allowed to see. Normal use is roughly 25-35; above about 40 is warm.'],
  dbgpower: ['Power draw', 'Estimated power the whole phone is drawing from the battery right now (current × voltage). The screen and mobile radio are included, not just this app.'],
  dbgnet: ['Downloaded', 'Data this app has downloaded since the debug sampler started. Mobile radio activity is a big part of heat, so a large number here matters.'],
  replay: ['Replaying the instructions', 'NESO can send a unit a new instruction while an earlier one is still running or waiting to start. The newest instruction takes over for the times it covers, and when an instruction ends the unit goes back to its own plan (PN). This replays the day\'s acceptances in the order they were issued so you can watch the instructed output change. Played back this way, they reproduce the energy Elexon settles for the unit.'],
  costs: ['Total balancing costs', 'What it costs NESO each month to keep the grid balanced and secure, as system-level totals: there is no unit or asset behind these figures, so they sit apart from the unit-based tabs. See the notes below the chart for what is and is not included.'],
  costview: ['By source / By purpose', '"By source" shows where the money was spent (the Balancing Mechanism, non-BM actions, response and reserve availability). "By purpose" uses NESO\'s own tag for what each action was for, such as constraints or reserve. The two views cover different things, so their totals differ.'],
  bmderived: ['Balancing Mechanism (derived)', 'NESO\'s daily balancing cost total minus the non-BM actions (BSAD). NESO\'s total covers BM actions plus non-BM actions, and this difference matches the unit-level BM cashflows in the other tabs to within about 1% on the days we hold.'],
  bsadsrc: ['Non-BM actions (BSAD)', 'Trades and system actions NESO takes outside the Balancing Mechanism and reports to Elexon as Balancing Services Adjustment Data. Split here into energy trades and system actions.'],
  eac: ['Response and reserve availability (EAC)', 'Availability payments for frequency response (DC, DM, DR) and reserve (QR, SR, BR), bought in NESO\'s daily EAC auctions: cleared MW x clearing price x hours. This is only part of NESO\'s ancillary services, and it is not part of the BM or non-BM totals.'],
  purposes: ['Purposes', 'NESO tags each balancing action with its main reason. Constraints are network limits (for example moving power around a congested line); energy imbalance, positive and negative reserve cover the national supply and demand balance; frequency control keeps the grid at 50 Hz. Tagging is best-endeavours.'],
  partialmonth: ['Partial months', 'NESO publishes its daily cost data with a lag of a few days, and a day only counts once most of its settlement periods are in. A faded bar is a month where some days are not yet published, so it is lower than the full month will be.'],
  constraints: ['Network constraints', 'The transmission network can only carry so much power across certain lines, called boundaries. When more power wants to flow across one than it can safely carry, NESO has to "constrain": pay generators on the exporting side to turn down (often Scottish wind) and others on the importing side to turn up. This tab shows when and where that was expected, and what it cost.'],
  boundary: ['Boundaries', 'A boundary is a line across the map that the network\'s circuits cross, such as the Scotland-England border (SCOTEX, also called B6). NESO watches the power flowing across each one against a limit. Positions on the map are schematic, drawn from NESO\'s network diagrams.'],
  atlimit: ['At or over the limit', 'The share of half-hours in which the flow NESO forecast across a boundary the day before was at or above the boundary\'s limit, meaning NESO expected to need constraint actions there. Average loading is the forecast flow as a share of the limit; energy over the limit adds up how far the forecast exceeded it (MW x half an hour).'],
  loading: ['Average loading', 'Forecast flow divided by the limit, averaged over the half-hours. 100% means the boundary was forecast to be full; above 100% NESO expected to act. Negative means power was forecast to flow the other way.'],
  excess: ['Energy over the limit', 'How far the forecast flow exceeded the limit, added up over the half-hours, in MWh. A rough guide to how much generation NESO expected to have to move, not a measured volume.'],
  dayahead: ['Day-ahead forecast', 'NESO publishes, for each boundary, the limit and forecast flow for every half-hour of the next day. They are a snapshot taken the day before and are not updated afterwards, so they show where NESO expected trouble rather than metered flows. The latest day is usually tomorrow.'],
  constraintcost: ['Constraint costs', 'What NESO spent on constraint actions, per day, from its own published outturn. "Thermal cost" is broken down for NESO\'s main boundary groups, which are coarser than the boundaries on the map (for example SSE-SP covers SSE_SP2). Published per day, a few days late.'],
  reasons: ['Reasons for constraint actions', 'NESO splits its constraint costs by reason. Thermal: a line would overheat (the boundaries on this tab). Voltage: keeping voltage within limits in an area. System inertia: keeping enough spinning machines on to steady frequency. Largest loss: limiting the biggest single source that could trip.'],
  remit: ['REMIT outages', 'Under the REMIT rules, the owner of a generator or large demand site must publish any planned or unplanned change of 100 MW or more to what it can deliver, as soon as it knows. This tab adds those messages up to show how much capacity was unavailable, when, and in which part of the country.'],
  unavail: ['Unavailable capacity', 'A unit\'s normal capacity minus the capacity its REMIT message says is still available, averaged over the period (MW). An outage covering half of a period counts half. Planned outages are published ahead, so periods after today show what is already known to be coming.'],
  gspgroup: ['GSP groups', 'Great Britain\'s 14 distribution network regions, named after the Grid Supply Points through which each takes power from the transmission network. Elexon uses them to settle the market by region. A transmission-connected power station is shown in the region it sits in. The map\'s colour scale stays the same as you move through time, so periods can be compared.'],
  remitplace: ['Placing units in regions', 'Elexon\'s reference data names a GSP group for embedded units but not for transmission-connected ones. Elexon does set each unit\'s transmission loss factor by GSP-group zone, though, so units sharing a loss factor sit in the same zone: matching a unit\'s loss factor to those of units whose group is known places virtually all the capacity in REMIT, apart from some closed stations no longer in Elexon\'s list. Units that cannot be placed are counted as "not placed".'],
  remitadd: ['Overlapping messages', 'A unit can have more than one live message for the same time, for example a planned outage and a separate unplanned extension. Adding them would count the same megawatts twice, so the larger one counts. Only each message\'s latest revision is used, and messages the participant withdrew are left out.'],
  closures: ['Closures', 'Closed and mothballed stations often stay in REMIT as an "outage" with no real end, some running to 2050. Left in, they would add over 10 GW of retired plant to every period, so events longer than a year are hidden unless this is ticked.'],
  planned: ['Planned or unplanned', 'Each REMIT message says whether the outage was planned (maintenance, known in advance) or unplanned (a breakdown or trip). The unplanned share is the unplanned MW as a share of all unavailable MW, averaged over the range.'],
  ic: ['Interconnector balancing', 'Interconnectors are the cables to France, Belgium, the Netherlands, Denmark, Norway and Ireland. They do not take part in the Balancing Mechanism, so NESO balances across them with trades outside it: buying energy (more flow into GB, or less out) or selling it (the reverse) for delivery over a particular link. Net trade cost is what it paid for purchases less what it received for sales.'],
  icmap: ['The map', 'Each line runs from where an interconnector lands in GB to where it lands abroad. Its width is how much NESO traded over it (or the net cost, or the physical flow, depending on "Show"), and the arrows show which way the energy went. Landing points are approximate and the lines schematic.'],
  icprice: ['Bought and sold', 'Energy NESO bought over the interconnectors (positive MWh) and sold (negative MWh), with the volume-weighted price. Trades with the neighbouring system operator that are published without a cost count in the volume but not the price.'],
  icclear: ['Clearing price', 'NESO\'s interconnector trades are pay-as-bid: each trade is settled at its own price, so there is no single market clearing price. The nearest equivalent is the marginal trade, the most expensive one NESO had to accept in a half-hour when buying (or the cheapest when selling). That is shown as the clearing price, averaged over the half-hours with trades when a period is longer than one half-hour. Highest and lowest are single trades; the average is volume-weighted (cost ÷ volume).'],
  ictype: ['Trade types', 'Counterparty trades are with a trader holding capacity on the link. SO-SO trades are with the system operator on the other side (RTE in France, Statnett in Norway, EirGrid and SONI in Ireland). SO-flagged trades were for a system reason, such as relieving a constraint, rather than the national energy balance.'],
  iccp: ['Counterparties', 'Who NESO traded with: the trading company for counterparty trades, or the neighbouring system operator for SO-SO trades. Tap a bar to show only that counterparty.'],
  icflow: ['Physical flow', 'What actually flowed through each interconnector, from Elexon\'s half-hourly generation by fuel type: positive into GB (import), negative out of GB (export). NESO\'s trades change these flows from what the market scheduled.'],
  icrev: ['Flow reversals', 'NESO balances GB partly by buying and selling energy over the interconnectors. If a link is exporting and NESO buys more than the export, the flow turns round and GB imports instead (and the other way when it sells). A link-hour counts as reversed when the flow without NESO and the actual flow point opposite ways, each by at least 50 MW.'],
  icrevest: ['Estimated schedule', 'The day-ahead schedule on each link is not published, so it is estimated as the flow NESO did not cause: the metered flow minus NESO\'s net trades on that link in the hour. The interconnector units\' notifications already include NESO\'s trades, so they cannot be used instead. The estimate also includes the intraday market\'s trades. A trade is against the schedule when it points the other way to this estimate; hours where the estimate is under 50 MW either way are not counted, because the direction is unclear.'],
  icrevcap: ['The 300 MW / 1,500 MW limit', 'From 20 May 2026 NESO may trade at most 1,500 MW per hour within day against the day-ahead direction across IFA, IFA2, ElecLink, Viking Link, BritNed and Nemo Link, and at most 300 MW on any one of them (NESO market notice, 14 May 2026; a short-term measure until the end of 2026, agreed with the EU system operators). Trading with the day-ahead direction is not limited, and North Sea Link and the Irish links are not covered. Only counterparty trades are counted.'],
  dfs: ['Demand Flexibility Service', 'NESO pays households and businesses, through registered providers (suppliers and aggregators), to shift when they use electricity for set half-hours: to use less at busy times (turn down) or, since April 2026, more when there is spare wind (turn up). Each event, NESO states how much it needs; providers bid volumes at a price and NESO accepts them, cheapest first.'],
  dfstag: ['Direction and reason', 'Turn-down (Downwards) events ask for less demand, turn-up (Upwards) events for more. NESO tags each event Energy, when it is for the national balance between supply and demand, or System, when it is for a network reason such as a constraint. The 2025/26 archive does not say, so those events show as "Not stated".'],
  dfstest: ['Test events', 'NESO occasionally runs test events to check providers can respond. They are left out unless this is ticked.'],
  dfsfill: ['Share of requirement', 'Procured volume as a share of what NESO asked for. NESO often states a large requirement (500 MW or more) and accepts every bid under its price, so most events procure far less than the requirement.'],
  dfssettled: ['Delivered', 'After an event, each provider\'s delivery is measured against a baseline of what its customers would otherwise have used, and paid on that. Delivered is the settled volume as a share of what was procured, over events that have been settled; settlement follows weeks after the event.'],
  dfsstack: ['The bid stack', 'Every bid for one half-hour of the event, cheapest first. Each bar is one DFS unit\'s bid: its width is the MW offered and its height the price. Blue bids were accepted, grey were rejected; with a provider picked, other providers\' bids are faded. The dashed line is NESO\'s requirement, when it is near the volume offered.'],
  dfsprov: ['Providers', 'The suppliers and aggregators registered for DFS, who bid on behalf of their customers. Volume offered is split into what NESO accepted and what it rejected.'],
  dfszone: ['DFS zones', 'From April 2026 each DFS unit sits in one of 12 zones, numbered north (1, North Scotland) to south (12, London and the South East). For each event half-hour NESO caps how much it will take from each zone; a cap of 0 closes the zone, for example so that turning demand down there does not add to a network constraint. Earlier bids have no zone. NESO numbers the zones only: the area names here are approximate.'],
  dfsclear: ['Clearing price', 'Accepted bids are paid their own price (pay-as-bid), and NESO takes bids cheapest first: in no half-hour was a rejected bid cheaper than the dearest accepted one. So the clearing price of a half-hour is its highest accepted bid, the price NESO had to go to for the last megawatt it took. Over several half-hours it is averaged weighted by volume procured. The cheapest rejected bid shows where NESO stopped.'],
  dfsmarket: ['Market price', 'Elexon\'s market index price for the same half-hour: the volume-weighted price of short-term trades on the APX power exchange, a guide to the wholesale price at the time. For turn-down events a clearing price above the market means NESO paid more to cut demand than the energy was trading for.'],
  dfsdist: ['Bid prices', 'All the volume providers offered, by price band: blue was accepted, grey rejected. Accepted volume sits at the cheap end and rejected volume above the clearing price, because NESO takes bids in price order. Bids above about three times the clearing price (some are at £10,000/MWh) are folded into the last band.'],
  amendment: ['Amendment', 'Whether the record is the original acceptance (ORI) or a later change to an earlier one, for example an update or deletion.'],
};
const tip = (k) => (GLOSS[k] ? `<button type="button" class="info" data-tip="${k}" aria-label="What does ${esc(GLOSS[k][0])} mean?" title="Click for what ${esc(GLOSS[k][0])} means">i</button>` : '');

function showTip(btn) {
  const box = $('#tipbox');
  const [title, text] = GLOSS[btn.dataset.tip];
  box.replaceChildren();
  const h = document.createElement('b'); h.textContent = title;
  const p = document.createElement('div'); p.textContent = text;
  box.append(h, p);
  box.dataset.for = btn.dataset.tip;
  box.hidden = false;
  const r = btn.getBoundingClientRect(), w = box.offsetWidth, ht = box.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + ht > innerHeight - 8) top = Math.max(8, r.top - ht - 8);
  box.style.left = `${left}px`; box.style.top = `${top}px`;
}
{
  const box = document.createElement('div');
  box.id = 'tipbox'; box.className = 'tipbox'; box.hidden = true; box.setAttribute('role', 'tooltip');
  document.body.append(box);
  // Capture phase, so tapping an "i" inside a sortable table header explains instead of re-sorting.
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.info');
    if (b) {
      e.preventDefault(); e.stopPropagation();
      if (!box.hidden && box.dataset.for === b.dataset.tip) box.hidden = true; else showTip(b);
    } else if (!e.target.closest('#tipbox')) box.hidden = true;
  }, true);
  addEventListener('scroll', () => { box.hidden = true; }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') box.hidden = true; });
}

function kpi(label, value, note = '', help = '') {
  return `<div class="card kpi"><div class="label">${esc(label)}${tip(help)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;
}

async function kpis(el) {
  const s = await api('summary', queryParams());
  const net = n0(s.offer_cash) + n0(s.bid_cash);
  const gross = Math.abs(n0(s.offer_vol)) + Math.abs(n0(s.bid_vol));
  el.innerHTML = [
    kpi('Net BM cost', gbp(net), s.n_days ? `${gbp(net / s.n_days)} per day over ${s.n_days} day${s.n_days === 1 ? '' : 's'}` : '', 'net'),
    kpi('Offer payments', gbp(s.offer_cash), `${mwh(s.offer_vol)} @ ${price(ratio(s.offer_cash, s.offer_vol))}`, 'offer'),
    kpi('Bid cashflow', gbp(s.bid_cash), `${mwh(s.bid_vol)} @ ${price(ratio(s.bid_cash, s.bid_vol))}`, 'bid'),
    kpi('SO-flagged net cost', gbp(s.so_cash), s.so_cash == null ? 'no SO-flagged actions in this range' : `${gross ? nf(0).format(100 * n0(s.so_vol) / gross) : 0}% of accepted volume (approx.)`, 'so'),
    ...(state.view === 'unit' ? [kpi('Active days', nf(0).format(n0(s.n_days)), 'days with accepted actions', 'activedays')] : [
      kpi('Units with actions', nf(0).format(n0(s.n_units)), 'accepted bids or offers', 'units'),
      kpi('Avg system price', price(s.avg_price), `range ${price(s.min_price)} to ${price(s.max_price)}`, 'sysprice'),
      kpi('Non-BM actions (BSAD)', gbp(s.bsad_cost), `${mwh(s.bsad_vol)} outside the BM`, 'bsad')]),
  ].join('');
}

const METRIC_OPTS = Object.entries(METRICS).map(([k, m]) => [k, m.label]);
const splitOpts = () => [['none', 'No split'], ...DIMS.filter((d) => !(state.view === 'unit' && ['unit', 'tech', 'fuel', 'party', 'unit_type', 'gsp'].includes(d))).map((d) => [d, DIM_LABEL[d]])];

function explorerHtml() {
  const bd = splitOpts().slice(1);
  if (!bd.some(([d]) => d === state.bdim)) state.bdim = bd[0][0];
  if (!splitOpts().some(([d]) => d === state.split)) state.split = 'direction';
  return `
  <div class="grid kpis" id="kpis"></div>
  <div class="card">
    <div class="card-head">
      <div><h2>${esc((METRICS[state.metric] || METRICS.net).label)} over time</h2><div class="sub" id="timeNote"></div></div>
      <div class="controls">
        <label class="small muted">Measure ${select('metric', METRIC_OPTS, state.metric)}${tip('measure')}</label>
        <label class="small muted">Split by ${select('split', splitOpts(), state.split)}${tip('splitby')}</label>
        <button class="btn" id="toggleTable">Table</button>
      </div>
    </div>
    <div class="chart tall" id="timeChart"></div>
    <div id="timeTable" hidden></div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>Breakdown${tip('breakdown')}</h2><div class="sub" id="bdNote"></div></div>
        <div class="controls"><label class="small muted">By ${select('bdim', bd, state.bdim)}</label></div></div>
      <div class="chart tall" id="bdChart"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Day × settlement period${tip('heatmap')}</h2><div class="sub">Each cell is one half-hour; ${state.view === 'unit' ? 'click a day to show its detail below' : 'click a day to zoom to it'}.</div></div></div>
      <div class="chart tall" id="heatChart"></div>
    </div>
  </div>`;
}

function wireExplorer() {
  for (const k of ['metric', 'split', 'bdim']) $('#' + k).onchange = (e) => update({ [k]: e.target.value }, true);
  $('#toggleTable').onclick = () => { const t = $('#timeTable'); t.hidden = !t.hidden; $('#timeChart').hidden = !t.hidden; $('#toggleTable').textContent = t.hidden ? 'Table' : 'Chart'; if (t.hidden) charts.get($('#timeChart'))?.resize(); };
  const days = (parseDay(state.to) - parseDay(state.from)) / DAY + 1;
  loading($('#kpis'), () => kpis($('#kpis')));
  loading($('#timeChart'), () => timeChart($('#timeChart'), $('#timeTable')));
  loading($('#bdChart'), () => breakdownChart($('#bdChart')));
  if (days > 400) { $('#heatChart').innerHTML = '<div class="empty">Narrow the range to 400 days or fewer to see the half-hourly grid.</div>'; }
  else loading($('#heatChart'), () => heatmapChart($('#heatChart')));
}

function viewOverview(main) {
  main.innerHTML = explorerHtml() + `
  <div class="grid cols2">
    <div class="card"><div class="card-head"><div><h2>System price${tip('sysprice')}</h2><div class="sub">Imbalance price (£/MWh) for context.</div></div></div><div class="chart short" id="priceChart"></div></div>
    <div class="card"><div class="card-head"><div><h2>Net imbalance volume${tip('niv')}</h2><div class="sub">Red: system short (NESO buying). Blue: system long.</div></div></div><div class="chart short" id="nivChart"></div></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Balancing actions outside the BM${tip('bsad')}</h2><div class="sub">Balancing Services Adjustment Data cost (trades, non-BM reserve). Not affected by the unit filters.</div></div></div><div class="chart short" id="bsadChart"></div></div>`;
  wireExplorer();
  loading($('#priceChart'), () => priceChart($('#priceChart')));
  loading($('#nivChart'), () => nivChart($('#nivChart')));
  loading($('#bsadChart'), () => bsadChart($('#bsadChart')));
}

async function viewUnits(main) {
  main.innerHTML = `<div class="card"><div class="card-head"><div><h2>BM units${tip('bmunits')}</h2><div class="sub" id="unitsNote">Totals for the selected range and filters. Click a unit to drill in.</div></div>
    <div class="controls"><input id="search" type="search" placeholder="Search unit, name, party…" size="30"></div></div><div id="unitsTable"></div></div>`;
  const el = $('#unitsTable');
  await loading(el, async () => {
    const data = await api('units', queryParams());
    const rows = data.rows.map((r) => ({ ...r, net: n0(r.offer_cash) + n0(r.bid_cash),
      offer_price: ratio(r.offer_cash, r.offer_vol), bid_price: ratio(r.bid_cash, r.bid_vol) }));
    const cols = [
      { key: 'bm_unit', label: 'Unit' }, { key: 'name', label: 'Name' }, { key: 'tech', label: 'Technology', html: techTag, cls: 'hide-sm', tip: 'tech' },
      { key: 'party', label: 'Lead party', cls: 'hide-sm', tip: 'party' },
      { key: 'net', label: 'Net cost', num: true, fmt: (v) => gbp(v), tip: 'net' },
      { key: 'offer_cash', label: 'Offer payments', num: true, fmt: (v) => gbp(v), tip: 'offer' },
      { key: 'bid_cash', label: 'Bid cashflow', num: true, fmt: (v) => gbp(v), tip: 'bid' },
      { key: 'offer_vol', label: 'Offer volume', num: true, fmt: mwh, tip: 'offervol' }, { key: 'bid_vol', label: 'Bid volume', num: true, fmt: mwh, tip: 'bidvol' },
      { key: 'offer_price', label: 'Avg offer', num: true, fmt: price, tip: 'avgoffer' }, { key: 'bid_price', label: 'Avg bid', num: true, fmt: price, tip: 'avgbid' },
      { key: 'n_periods', label: 'Active periods', num: true, tip: 'activeperiods' }, { key: 'n_so_periods', label: 'SO-flagged periods', num: true, tip: 'soperiods' },
    ];
    const draw = () => {
      const s = $('#search').value.toLowerCase();
      const f = s ? rows.filter((r) => `${r.bm_unit} ${r.name} ${r.party} ${r.tech}`.toLowerCase().includes(s)) : rows;
      $('#unitsNote').textContent = `${f.length} units with accepted actions in the selected range. Click a unit to drill in.`;
      table(el, cols, f, { onRow: (r) => openUnit(r.bm_unit), rowTip: (r) => `Open the unit page for ${r.bm_unit}${r.name ? ` (${r.name})` : ''}`, sort: { key: 'net', desc: true }, limit: 500 });
    };
    $('#search').oninput = draw;
    draw();
  });
}

async function viewUnit(main) {
  const info = await api(`unit/${encodeURIComponent(state.unit)}`);
  const u = info.unit;
  const kv = (k, v) => (v == null || v === '' ? '' : `<span class="kv">${esc(k)} <b>${esc(v)}</b></span>`);
  main.innerHTML = `
  <div class="unit-head"><h1>${esc(u.name || u.bm_unit)}</h1>
    ${kv('BM unit', u.bm_unit)}${kv('NESO id', u.ngc_bm_unit)}${kv('Technology', u.tech)}${kv('Fuel', u.fuel_type)}${kv('Lead party', u.lead_party)}
    ${kv('Type', u.bm_unit_type)}${kv('GSP group', u.gsp_group)}${kv('Gen capacity', u.generation_capacity ? `${u.generation_capacity} MW` : '')}
    ${kv('Data held', info.first ? `${info.first} to ${info.last}` : 'none')}</div>
  ${explorerHtml()}
  <div class="card" id="dayCard" style="margin-top:14px">
    <div class="card-head"><div><h2>Day detail${tip('daydetail')}</h2><div class="sub" id="dayNote">What the unit planned (physical notification) and what NESO finally instructed it to do (the newest instruction at each moment), with its export and import limits. MW, local time, fetched live from Elexon.</div></div>
      <div class="controls"><label class="small muted">Settlement day <input type="date" id="day" min="${esc(state.from)}" max="${esc(state.to)}"></label></div></div>
    <div class="chart" id="dayChart"></div>
    <div class="replay" id="replay"></div>
    <h2 style="margin-top:14px">Accepted volume by period and pair${tip('pairs')}</h2>
    <div class="sub">Settled volume and cashflow per bid-offer pair, with the submitted pair prices.</div>
    <div id="dayTable" style="margin-top:8px"></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Acceptances (BOALF)${tip('acceptance')}</h2><div class="sub" id="accNote">Every instruction NESO issued to this unit in the selected range, newest first: one row per acceptance.</div></div>
    <div class="controls"><label class="small muted"><input type="checkbox" id="accRaw"> Show each point of the profile${tip('accpoints')}</label></div></div><div id="accTable"></div></div>`;
  wireExplorer();

  // Default the day detail to the most recent day with activity in range.
  if (!state.day || state.day < state.from || state.day > state.to) {
    const d = await api('agg', queryParams({ bucket: 'day', group: 'none' }));
    state.day = d.rows.length ? d.rows[d.rows.length - 1].t.slice(0, 10) : state.to;
  }
  $('#day').value = state.day;
  $('#day').onchange = (e) => update({ day: e.target.value }, true);
  loading($('#dayChart'), () => unitDay($('#dayChart'), $('#dayTable')));
  loading($('#accTable'), async () => {
    let a;
    try { a = await api('acceptances', { unit: state.unit, from: state.from, to: state.to }); } catch (e) {
      $('#accTable').innerHTML = `<div class="empty">Couldn't load acceptances (${esc(e.message)}). They are fetched live from Elexon, so check the connection.</div>`;
      return;
    }
    const ts = (v) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const hm = (v) => v ? new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const yn = (v) => (v ? 'Yes' : '');
    const flags = [{ key: 'so_flag', label: 'SO flag', fmt: yn, tip: 'so' }, { key: 'stor_flag', label: 'STOR', fmt: yn, tip: 'stor' },
      { key: 'rr_flag', label: 'RR', fmt: yn, tip: 'rr' }, { key: 'deemed_bo', label: 'Deemed', fmt: yn, tip: 'deemed' }];
    // Elexon lists an acceptance as one row per straight piece of its MW profile, so one instruction can be several rows.
    // Grouped: one row per acceptance, with its profile in words ("410 → 38 → 0 MW").
    const groups = new Map();
    for (const r of a.rows) (groups.get(r.acceptance_number) || groups.set(r.acceptance_number, []).get(r.acceptance_number)).push(r);
    const grouped = [...groups.entries()].map(([num, rs]) => {
      rs.sort((x, y) => String(x.time_from).localeCompare(String(y.time_from)));
      const lv = [rs[0].level_from];
      for (const r of rs) { if (r.level_from !== lv[lv.length - 1]) lv.push(r.level_from); if (r.level_to !== lv[lv.length - 1]) lv.push(r.level_to); }
      const first = rs[0], last = rs[rs.length - 1], sps = rs.map((r) => r.sp_from).filter((v) => v != null);
      const sameDay = String(first.time_from).slice(0, 10) === String(last.time_to).slice(0, 10);
      return { acceptance_number: num, acceptance_time: first.acceptance_time, time_from: first.time_from, time_to: last.time_to,
        window: `${ts(first.time_from)} – ${sameDay ? hm(last.time_to) : ts(last.time_to)}`, profile: `${lv.map((v) => nf(0).format(v)).join(' → ')} MW`,
        sp: sps.length ? (Math.min(...sps) === Math.max(...sps) ? String(Math.min(...sps)) : `${Math.min(...sps)}–${Math.max(...sps)}`) : '',
        points: rs.length, so_flag: rs.some((r) => r.so_flag), stor_flag: rs.some((r) => r.stor_flag), rr_flag: rs.some((r) => r.rr_flag),
        deemed_bo: rs.some((r) => r.deemed_bo), amendment_flag: [...new Set(rs.map((r) => r.amendment_flag).filter(Boolean))].join(', ') };
    }).sort((x, y) => String(y.acceptance_time).localeCompare(String(x.acceptance_time)) || y.acceptance_number - x.acceptance_number);
    const used = (rows) => flags.filter((f) => rows.some((r) => r[f.key]));  // flag columns that are blank all the way down say nothing
    const draw = () => {
      const raw = $('#accRaw').checked;
      $('#accNote').textContent = raw
        ? `Every point of every acceptance's MW profile in the selected range: ${nf(0).format(a.rows.length)} rows for ${nf(0).format(grouped.length)} acceptances.`
        : `Every instruction NESO issued to this unit in the selected range, newest first: ${nf(0).format(grouped.length)} acceptances, one row each.`;
      if (raw) table($('#accTable'), [
        { key: 'acceptance_number', label: 'Acceptance', num: true }, { key: 'acceptance_time', label: 'Issued', fmt: ts },
        { key: 'time_from', label: 'From', fmt: ts }, { key: 'time_to', label: 'To', fmt: ts },
        { key: 'level_from', label: 'Level from (MW)', num: true, tip: 'levels' }, { key: 'level_to', label: 'Level to (MW)', num: true },
        { key: 'sp_from', label: 'Period', num: true, tip: 'period' }, ...used(a.rows), { key: 'amendment_flag', label: 'Amendment', tip: 'amendment' },
      ], a.rows, { limit: 300 });
      else table($('#accTable'), [
        { key: 'acceptance_number', label: 'Acceptance', num: true }, { key: 'acceptance_time', label: 'Issued', fmt: ts },
        { key: 'window', label: 'Covers' }, { key: 'profile', label: 'Output profile', tip: 'levels' },
        { key: 'sp', label: 'Periods', tip: 'period' }, ...used(grouped), { key: 'amendment_flag', label: 'Amendment', tip: 'amendment' },
      ], grouped, { limit: 300 });
    };
    $('#accRaw').onchange = draw;
    draw();
  });
}

async function unitDay(el, tableEl) {
  const d = await api(`unit/${encodeURIComponent(state.unit)}/day`, { date: state.day });
  const seg = (rows) => {
    const pts = [];
    for (const r of [...rows].sort((a, b) => a.timeFrom.localeCompare(b.timeFrom))) pts.push([r.timeFrom, r.levelFrom], [r.timeTo, r.levelTo]);
    return pts;
  };
  const phys = (ds) => seg(d.physical.filter((r) => r.dataset === ds));
  const acc = [];
  const byNum = new Map();
  for (const a of d.acceptances) (byNum.get(a.acceptance_number) || byNum.set(a.acceptance_number, []).get(a.acceptance_number)).push(a);
  for (const rows of byNum.values()) { for (const a of rows) acc.push([a.time_from, a.level_from], [a.time_to, a.level_to]); acc.push([rows[rows.length - 1].time_to, null]); }
  // The instructed output: at each moment the newest-issued acceptance covering it, or the unit's own plan where none
  // does (the same model as the replay below). Drawing the raw acceptances instead gives a misleading saw-tooth, because
  // each one runs back down to where the unit would otherwise be; they stay available as a series switched off by default.
  const mdl = instructionModel(d);
  const instructed = mdl.list.length ? mdl.effAt(mdl.N).map((v, i) => [mdl.xs[i], v]) : [];
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'time' };
  o.yAxis = { ...o.yAxis, type: 'value', scale: true, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => `${nf(0).format(v)} MW` } };
  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  o.tooltip = { ...o.tooltip, trigger: 'axis', formatter: (ps) => tipHtml(hm(ps[0].value[0]),
    ps.filter((p) => p.value[1] != null).map((p) => ({ name: p.seriesName, value: p.value[1], color: p.color })), (v) => `${nf(0).format(v)} MW`) };
  const line = (name, data, c, extra = {}) => ({ name, type: 'line', data, color: css(c), symbol: 'circle', symbolSize: 4, showSymbol: false, lineStyle: { width: 2 }, connectNulls: false, ...extra });
  o.series = [
    line('Plan (physical notification)', phys('PN'), '--s1', { lineStyle: { width: 2, type: 'dashed' } }),
    line('Instructed output', instructed, '--s2', { lineStyle: { width: 2.5 }, z: 5 }),
    line('Individual acceptances', acc, '--s4', { showSymbol: true, lineStyle: { width: 1 } }),
    line('Max export limit', phys('MELS'), '--other', { lineStyle: { width: 1, type: 'dotted' } }),
    line('Max import limit', phys('MILS'), '--other2', { lineStyle: { width: 1, type: 'dotted' } }),
  ];
  o.legend.selected = { 'Individual acceptances': false };
  if (!d.physical.length && !acc.length) { el.innerHTML = '<div class="empty">No physical data or acceptances for this unit on this day.</div>'; charts.delete(el); }
  else chart(el).setOption(o, true);
  replay($('#replay'), d);

  const bod = new Map(d.bod.map((b) => [`${b.sp}|${b.pair}`, b]));
  const rows = d.periods.map((p) => { const b = bod.get(`${p.sp}|${p.pair}`) || {}; return { ...p, time: spTime(p.sp), px: ratio(p.cashflow, p.volume), bid: b.bid, offer: b.offer, level: b.levelFrom }; });
  table(tableEl, [
    { key: 'sp', label: 'SP', num: true, tip: 'period' }, { key: 'time', label: 'Start' }, { key: 'direction', label: 'Direction' }, { key: 'pair', label: 'Pair', num: true, tip: 'pairs' },
    { key: 'volume', label: 'Volume', num: true, fmt: mwh }, { key: 'cashflow', label: 'Cashflow', num: true, fmt: (v) => gbp(v, false) },
    { key: 'px', label: 'Paid price', num: true, fmt: price, tip: 'paidprice' }, { key: 'bid', label: 'Pair bid price', num: true, fmt: price, tip: 'pairbid' },
    { key: 'offer', label: 'Pair offer price', num: true, fmt: price, tip: 'pairoffer' }, { key: 'level', label: 'Pair level (MW)', num: true, tip: 'pairlevel' },
    { key: 'so_flag', label: 'SO flag', fmt: (v) => (v ? 'Yes' : ''), tip: 'so' },
  ], rows, { limit: 600 });
}


// ------------------------------------------------------------------ instruction replay
// Replays a unit's acceptances (BOALF) in the order NESO issued them. Model: at any moment the unit follows the
// newest-issued acceptance covering that moment, or its own plan (PN) if none does. Checked against Elexon's settled
// volumes (9 unit-days, hundreds of acceptances each): the energy matches to within 0.1 MWh.
let replayTimer = null;
/**
 * The instruction model for one unit-day, shared by the Day detail chart and the replay: each acceptance as a path over
 * a 30-second grid, the unit's plan (PN), and effAt(k), the output after the first k instructions (newest-issued
 * acceptance wins at each moment; the plan where none covers it). effAt(N) is what the unit was finally instructed to do.
 */
function instructionModel(d) {
  const ms = (s) => new Date(s).getTime();
  const byNum = new Map();
  for (const a of d.acceptances) (byNum.get(a.acceptance_number) || byNum.set(a.acceptance_number, []).get(a.acceptance_number)).push(a);
  const list = [...byNum.entries()].map(([num, rows]) => {
    rows.sort((x, y) => ms(x.time_from) - ms(y.time_from));
    const segs = rows.map((r) => [ms(r.time_from), r.level_from, ms(r.time_to), r.level_to]);
    return { num, issued: ms(rows[0].acceptance_time), segs, t0: segs[0][0], t1: segs[segs.length - 1][2],
      so: rows.some((r) => r.so_flag), stor: rows.some((r) => r.stor_flag), rr: rows.some((r) => r.rr_flag), deemed: rows.some((r) => r.deemed_bo) };
  }).sort((a, b) => a.issued - b.issued || a.num - b.num);
  if (!list.length) return { list };

  const pn = d.physical.filter((p) => p.dataset === 'PN').map((p) => [ms(p.timeFrom), p.levelFrom, ms(p.timeTo), p.levelTo]).sort((a, b) => a[0] - b[0]);
  const levelAt = (segs, t) => {
    for (const [t0, l0, t1, l1] of segs) if (t >= t0 && t <= t1) return t1 === t0 ? l0 : l0 + ((l1 - l0) * (t - t0)) / (t1 - t0);
    return null;
  };
  // Time grid over the settlement day, every 30 seconds.
  const STEP = 30000;
  const t0 = pn.length ? pn[0][0] : Math.min(...list.map((a) => a.t0));
  const t1 = pn.length ? pn[pn.length - 1][2] : Math.max(...list.map((a) => a.t1));
  const n = Math.max(2, Math.round((t1 - t0) / STEP) + 1);
  const xs = Array.from({ length: n }, (_, i) => t0 + i * STEP);
  const planned = xs.map((t) => levelAt(pn, t) ?? 0);
  const paths = list.map((a) => {
    const i0 = Math.max(0, Math.ceil((a.t0 - t0) / STEP)), i1 = Math.min(n - 1, Math.floor((a.t1 - t0) / STEP));
    const v = [];
    for (let i = i0; i <= i1; i++) v.push(levelAt(a.segs, xs[i]));
    return { i0, i1, v };
  });
  const N = list.length;
  const effAt = (k) => {
    const e = planned.slice();
    for (let j = 0; j < k; j++) { const p = paths[j]; for (let i = p.i0; i <= p.i1; i++) { const v = p.v[i - p.i0]; if (v != null) e[i] = v; } }
    return e;
  };
  return { ms, list, pn, levelAt, STEP, t0, t1, n, xs, planned, paths, N, effAt };
}

function replay(el, d) {
  clearInterval(replayTimer);
  const { ms, list, pn, levelAt, STEP, t0, t1, n, xs, planned, paths, N, effAt } = instructionModel(d);
  if (!list.length) { el.innerHTML = '<div class="empty">NESO issued no instructions to this unit on this day.</div>'; return; }
  const pts = (arr) => xs.map((x, i) => [x, arr[i]]);
  const hiPts = (k) => {
    if (k < 1) return [];
    const p = paths[k - 1];
    const out = xs.map((x) => [x, null]);
    for (let i = p.i0; i <= p.i1; i++) out[i][1] = p.v[i - p.i0];
    return out;
  };
  const allVals = [...planned, ...paths.flatMap((p) => p.v.filter((v) => v != null))];
  const lo = Math.min(...allVals), hi = Math.max(...allVals), pad = Math.max(5, (hi - lo) * 0.06);

  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dm = (t) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fps = N > 120 ? 12 : N > 40 ? 6 : 3;
  el.innerHTML = `
    <h2 style="margin-top:14px">Replay NESO's instructions${tip('replay')}</h2>
    <div class="sub">Step through the instructions in the order they were issued. A newer instruction takes over for the times it covers; when one ends, the unit returns to its own plan. Output in MW.</div>
    <div class="replay-bar">
      <button type="button" class="btn" id="rpStart">Restart</button><button type="button" class="btn" id="rpBack">‹ Back</button>
      <button type="button" class="btn primary" id="rpPlay">Play</button><button type="button" class="btn" id="rpFwd">Next ›</button>
      <label class="small muted"><input type="checkbox" id="rpLoop" checked> Loop</label>
      <label class="small muted">Speed <select id="rpSpeed">${[[1, 'Slow'], [3, 'Normal'], [6, 'Fast'], [12, 'Very fast']].map(([v, l]) => `<option value="${v}" ${v === fps ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <input type="range" class="rp-slider" id="rpSlider" min="0" max="${N}" value="${N}" aria-label="Instruction number">
    <div class="replay-status" id="rpStatus"></div>
    <div class="chart" id="rpChart"></div>`;

  let k = N, speed = fps, loop = true, hold = 0;
  const HOLD_MS = 1500; // pause on the last instruction before looping back to the start
  const o = baseOption();
  o.legend = { ...o.legend, type: 'plain', show: true, itemGap: 12, textStyle: { color: css('--ink2'), fontSize: 11 }, data: ['Plan (PN)', 'Instructed so far', 'Before this one', 'This instruction'] };
  o.grid = { left: 42, right: 12, top: 56, bottom: 26, containLabel: false };
  o.xAxis = { ...o.xAxis, type: 'time', min: t0, max: t1 };
  o.yAxis = { ...o.yAxis, type: 'value', min: lo - pad, max: hi + pad, axisLabel: { ...o.yAxis.axisLabel, showMinLabel: false, showMaxLabel: false } };
  o.tooltip = { ...o.tooltip, valueFormatter: (v) => (v == null ? '–' : `${nf(0).format(v)} MW`) };
  const ln = (name, color, width, extra = {}) => ({ name, type: 'line', color: css(color), showSymbol: false, lineStyle: { width, ...(extra.dash ? { type: 'dashed' } : {}) }, connectNulls: false, data: [], ...extra.s });
  o.series = [
    ln('Plan (PN)', '--s1', 1.6, { dash: true }),
    ln('Instructed so far', '--s2', 3, { s: { z: 4 } }),
    ln('Before this one', '--other', 1.4, { s: { z: 2 } }),
    ln('This instruction', '--s4', 5, { s: { z: 6 } }),
  ];
  o.series[0].data = pts(planned);
  const c = chart($('#rpChart'));
  c.setOption(o, true);
  const status = $('#rpStatus');

  function draw() {
    const cur = effAt(k), prev = k > 0 ? effAt(k - 1) : cur;
    const issued = k > 0 ? list[k - 1].issued : null;
    const mark = issued != null && issued >= t0 && issued <= t1
      ? { silent: true, symbol: 'none', lineStyle: { color: css('--s4'), type: 'dashed', width: 1.5 }, label: { formatter: `issued ${hm(issued)}`, color: css('--ink2'), fontSize: 11, position: 'insideEndTop' }, data: [{ xAxis: issued }] }
      : { data: [] };
    c.setOption({ series: [{}, { data: pts(cur) }, { data: k > 0 ? pts(prev) : [] }, { data: hiPts(k), markLine: mark }] });
    let moved = 0;
    for (let i = 0; i < n; i++) moved += cur[i] - planned[i];
    moved *= STEP / 3600000; // MW x hours
    const movedTxt = `Output versus its plan so far: ${moved >= 0 ? '+' : '−'}${nf(0).format(Math.abs(moved))} MWh${moved > 0.5 ? ' (turned up)' : moved < -0.5 ? ' (turned down)' : ''}.`;
    status.dataset.moved = String(moved);
    status.dataset.step = String(k);
    if (k === 0) { status.innerHTML = `<b>Before any instruction</b>: the unit follows its own plan (PN). ${esc(movedTxt)}`; }
    else {
      const a = list[k - 1];
      const overlaps = list.slice(0, k - 1).filter((b) => b.t0 < a.t1 && a.t0 < b.t1).length;
      const flags = [a.so && 'SO-flagged', a.stor && 'STOR', a.rr && 'RR', a.deemed && 'deemed'].filter(Boolean).join(', ');
      status.innerHTML = `<b>Instruction ${k} of ${N}</b> · acceptance ${esc(a.num)}${flags ? ` · ${esc(flags)}` : ''}<br>
        Issued ${esc(dm(a.issued))}${a.issued < t0 ? ' (before this day began)' : ''}. Sets the unit from ${esc(nf(0).format(a.segs[0][1]))} MW to ${esc(nf(0).format(a.segs[a.segs.length - 1][3]))} MW between ${esc(hm(a.t0))} and ${esc(hm(a.t1))}.
        ${overlaps ? `It overlaps ${overlaps} earlier instruction${overlaps === 1 ? '' : 's'}; for the times they share, this newer one takes over.` : 'No earlier instruction covered these times.'}<br>${esc(movedTxt)}`;
    }
    $('#rpSlider').value = String(k);
  }
  const pause = () => { clearInterval(replayTimer); replayTimer = null; $('#rpPlay').textContent = 'Play'; };
  const play = () => {
    if (k >= N) k = 0;
    hold = 0;
    draw();
    $('#rpPlay').textContent = 'Pause';
    clearInterval(replayTimer);
    replayTimer = setInterval(() => {
      if (!el.isConnected) { clearInterval(replayTimer); replayTimer = null; return; }
      if (k >= N) {
        if (!loop) { pause(); return; }
        if (++hold * (1000 / speed) < HOLD_MS) return;
        hold = 0; k = 0; draw(); return;
      }
      k++; draw();
    }, 1000 / speed);
  };
  $('#rpPlay').onclick = () => (replayTimer ? pause() : play());
  $('#rpStart').onclick = () => { pause(); k = 0; draw(); };
  $('#rpBack').onclick = () => { pause(); k = Math.max(0, k - 1); draw(); };
  $('#rpFwd').onclick = () => { pause(); k = Math.min(N, k + 1); draw(); };
  $('#rpSlider').oninput = (e) => { pause(); k = +e.target.value; draw(); };
  $('#rpSpeed').onchange = (e) => { speed = +e.target.value; if (replayTimer) play(); };
  $('#rpLoop').onchange = (e) => { loop = e.target.checked; };
  // Play and loop by default; people who ask for reduced motion get the static final state with Play available.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) draw();
  else { k = 0; play(); }
}


// ------------------------------------------------------------------ total costs (system-level, no unit detail)

const COST_LABEL = {
  bm_derived: 'Balancing Mechanism (derived)', bsad_total: 'Non-BM actions (BSAD)', eac_total: 'Response and reserve availability (EAC)',
  constraints: 'Constraints', energy_imbalance: 'Energy imbalance', positive_reserve: 'Positive reserve', negative_reserve: 'Negative reserve',
  frequency_control: 'Frequency control', other: 'Other',
};
const COST_COLOUR = { bm_derived: '--s1', bsad_total: '--s7', eac_total: '--s4', constraints: '--s1', energy_imbalance: '--s3', positive_reserve: '--s2',
  negative_reserve: '--s5', frequency_control: '--s7', other: '--other' };
let costView = 'source', costRange = '12';
const COST_SHORT = { bm_derived: 'BM (derived)', bsad_total: 'Non-BM (BSAD)', eac_total: 'EAC availability' };

async function viewCosts(main) {
  main.innerHTML = `
  <div class="grid kpis" id="costKpis"></div>
  <div class="card">
    <div class="card-head">
      <div><h2>Total balancing costs by month${tip('costs')}</h2><div class="sub" id="costNote"></div></div>
      <div class="controls">
        <label class="small muted">View ${select('costView', [['source', 'By source'], ['purpose', 'By purpose']], costView)}${tip('costview')}</label>
        <label class="small muted">Months ${select('costRange', [['12', 'Last 12'], ['all', 'All']], costRange)}</label>
        <button type="button" class="btn" id="costRefresh">Refresh data</button>
      </div>
    </div>
    <div class="chart tall" id="costChart"></div>
    <div id="costTable"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2>What is and is not included</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      <b style="color:var(--ink)">By source</b> adds the Balancing Mechanism (NESO's daily total minus non-BM actions), non-BM actions (Elexon BSAD) and response and reserve availability (EAC auctions).<br>
      <b style="color:var(--ink)">By purpose</b> is NESO's own split of the same daily total by what each action was for.<br>
      <b style="color:var(--ink)">Not included:</b> other ancillary services (reactive power, black start, stability and voltage contracts, reserve delivery), SO-SO trades with other system operators, and reconciliation adjustments. I could not find a public monthly figure for these, so NESO's own all-in monthly totals will be higher than these bars.<br>
      <b style="color:var(--ink)">Lag:</b> NESO publishes the daily cost data a few days late, so the latest month is usually partial (shown faded).
    </div>
    <div class="small muted" id="costMeta" style="margin-top:8px"></div>
  </div>`;
  $('#costView').onchange = (e) => { costView = e.target.value; drawCosts(); };
  $('#costRange').onchange = (e) => { costRange = e.target.value; drawCosts(); };
  $('#costRefresh').onclick = async () => {
    const btn = $('#costRefresh'); btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      await fetch('/api/costs/refresh');
      for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); const d = await (await fetch('/api/costs/monthly')).json(); if (!d.running) break; }
    } finally { btn.disabled = false; btn.textContent = 'Refresh data'; }
    await loadCosts();
  };
  await loadCosts();
}

let costData = null;
async function loadCosts() {
  const el = $('#costChart');
  if (!el) return;
  costData = await api('costs/monthly');
  drawCoverage();
  drawCosts();
}

function drawCosts() {
  if (!$('#costChart')) return;
  const d = costData, allMonths = d.months || [];
  // Last 12 months by default (as NESO's own chart does); a partial current month rides along as a 13th bar.
  const months = costRange === 'all' || !allMonths.length ? allMonths : allMonths.slice(-(allMonths[allMonths.length - 1].partial ? 13 : 12));
  const keys = costView === 'source' ? ['bm_derived', 'bsad_total', 'eac_total'] : ['constraints', 'energy_imbalance', 'positive_reserve', 'negative_reserve', 'frequency_control', 'other'];
  const val = (m, k) => (costView === 'source' ? m[k] : (m.purpose[k] ?? 0)) ?? 0;
  const total = (m) => keys.reduce((a, k) => a + val(m, k), 0);
  const lbl = (m) => new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const upd = d.updated_at ? new Date(d.updated_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('#costMeta').textContent = allMonths.length
    ? `NESO daily cost data published through ${d.through || 'n/a'}${upd ? ` · refreshed ${upd}` : ''}${d.error ? ` · some sources failed: ${d.error}` : ''}`
    : '';
  if (!allMonths.length) {
    $('#costChart').innerHTML = `<div class="empty">No cost data yet. Tap <b>Refresh data</b> to download it (about a minute).${d.error ? `<br>${esc(d.error)}` : ''}</div>`;
    charts.delete($('#costChart')); $('#costTable').innerHTML = ''; $('#costKpis').innerHTML = ''; $('#costNote').textContent = '';
    return;
  }
  $('#costNote').textContent = costView === 'source'
    ? 'Where the money was spent. Faded bars are months NESO has not fully published yet.'
    : 'What NESO tagged each action as being for (covers the BM and non-BM actions, not the EAC auctions). Faded bars are partial months.';

  // KPIs over complete months
  const full = allMonths.filter((m) => !m.partial);
  const last = full[full.length - 1], prev = full[full.length - 2];
  const t12 = full.slice(-12);
  const sum12 = (f) => t12.reduce((a, m) => a + f(m), 0);
  const cons12 = sum12((m) => m.purpose.constraints ?? 0), neso12 = sum12((m) => m.neso_total);
  const kp = [];
  if (last) {
    const tl = total(last), tp = prev ? total(prev) : null;
    kp.push(kpi(`${lbl(last)} total`, gbp(tl), tp ? `${tl >= tp ? '+' : '−'}${nf(0).format(Math.abs(100 * (tl - tp) / tp))}% on ${lbl(prev)}` : 'latest full month', 'costs'));
    kp.push(kpi(`Last ${t12.length} full months`, gbp(sum12(total)), `${gbp(sum12(total) / t12.length)} a month on average`));
    kp.push(kpi('Share that was constraints', neso12 ? `${nf(0).format(100 * cons12 / neso12)}%` : '–', 'of the BM plus non-BM total, same period', 'purposes'));
  }
  $('#costKpis').innerHTML = kp.join('');

  const o = baseOption();
  o.legend = { ...o.legend, type: 'plain', itemGap: 10, textStyle: { color: css('--ink2'), fontSize: 11 }, data: keys.map((k) => COST_LABEL[k]) };
  o.grid = { left: 8, right: 12, top: 62, bottom: 8, containLabel: true };
  o.xAxis = { ...o.xAxis, type: 'category', data: months.map(lbl), axisLabel: { color: css('--muted'), fontSize: 11, hideOverlap: true } };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => gbp(v) } };
  o.tooltip = { ...o.tooltip, formatter: (ps) => {
    const m = months[ps[0].dataIndex];
    const rows = ps.filter((p) => p.seriesName !== 'Total').map((p) => ({ name: p.seriesName, value: p.value?.value ?? p.value, color: p.color }));
    return tipHtml(`${lbl(m)}${m.partial ? ` · ${m.days} of ${m.calendar_days} days published` : ''}`, rows, gbp, total(m));
  } };
  o.series = [
    ...keys.map((k) => ({ name: COST_LABEL[k], type: 'bar', stack: 'cost', barMaxWidth: 34, color: css(COST_COLOUR[k]),
      data: months.map((m) => ({ value: val(m, k), itemStyle: { opacity: m.partial ? 0.45 : 1 } })) })),
    // An invisible zero-height bar on top of each stack carries the month's total as its label.
    { name: 'Total', type: 'bar', stack: 'cost', data: months.map(() => 0), itemStyle: { color: 'transparent' }, tooltip: { show: false }, silent: true,
      label: { show: true, position: 'top', color: css('--ink'), fontSize: 10, formatter: (p) => { const v = total(months[p.dataIndex]); return Math.abs(v) >= 1e8 ? `£${nf(0).format(v / 1e6)}m` : gbp(v); } },
      labelLayout: { hideOverlap: true } },
  ];
  chart($('#costChart')).setOption(o, true);

  const cols = [{ key: 'label', label: 'Month' }, ...keys.map((k) => ({ key: k, label: COST_SHORT[k] || COST_LABEL[k], num: true, fmt: (v) => gbp(v),
    tip: k === 'bm_derived' ? 'bmderived' : k === 'bsad_total' ? 'bsadsrc' : k === 'eac_total' ? 'eac' : undefined })),
    { key: 'total', label: 'Total', num: true, fmt: (v) => gbp(v) }, { key: 'days', label: 'Days', num: true, tip: 'partialmonth' }];
  const rows = months.map((m) => ({ ...Object.fromEntries(keys.map((k) => [k, val(m, k)])), key: m.month, label: lbl(m) + (m.partial ? ' (partial)' : ''),
    total: total(m), days: `${m.days}/${m.calendar_days}` })).reverse();
  table($('#costTable'), cols, rows, { limit: 40 });
}

// ------------------------------------------------------------------ network constraints (system-level, no unit detail)

// Transmission boundaries in NESO's day-ahead data, north to south. `line` is a schematic [lon, lat] path drawn from
// NESO's network diagrams: good enough to show which part of the country a boundary splits, not a survey.
const BOUNDARY = {
  SSEN_S: { name: 'SSEN South', region: 'North Scotland', line: [[-5.7, 56.9], [-4.6, 56.8], [-3.6, 56.68], [-2.55, 56.6]] },
  ERROEX: { name: 'Errochty export', region: 'North Scotland', line: [[-4.25, 56.85], [-4.0, 56.72], [-3.85, 56.62]] },
  SSE_SP: { name: 'SSE–SP (north–south Scotland)', region: 'Scotland', line: [[-5.6, 55.75], [-4.9, 56.15], [-4.0, 56.3], [-2.9, 56.45]] },
  SSE_GRMO: { name: 'SSE–Glasgow west', region: 'Central Scotland', line: [[-5.0, 55.85], [-4.4, 56.02], [-3.75, 56.02]] },
  NKILGRMO: { name: 'Central belt east', region: 'Central Scotland', line: [[-4.45, 56.06], [-4.05, 55.85], [-3.25, 55.85]] },
  GALLEX: { name: 'Galloway export', region: 'South West Scotland', line: [[-5.05, 55.12], [-4.4, 55.2], [-3.75, 55.05]] },
  SCOTEX: { name: 'Scotland–England (B6)', region: 'Anglo-Scottish border', line: [[-3.25, 54.95], [-2.65, 55.1], [-2.25, 55.45], [-2.03, 55.78]] },
  HARSPNBLY: { name: 'Harker–Blyth (North East)', region: 'North East England', line: [[-3.15, 54.75], [-2.3, 54.8], [-1.4, 54.72]] },
  SSHARN: { name: 'Scotland + north England (SSHARN)', region: 'Northern England', line: [[-3.05, 54.0], [-2.25, 53.9], [-1.55, 54.2], [-0.85, 54.5]] },
  SHARN: { name: 'Scotland + north England (SHARN)', region: 'Northern England', line: [[-3.05, 53.95], [-2.25, 53.85], [-1.55, 54.15], [-0.85, 54.45]] },
  GM_SNOW: { name: 'Heysham / north-west coast', region: 'North West England', line: [[-3.15, 54.2], [-2.75, 54.1], [-2.55, 53.85]] },
  DRESHEX: { name: 'Drax area export', region: 'Yorkshire', line: [[-1.45, 53.85], [-0.95, 53.7], [-0.6, 53.55]] },
  FLOWSTH: { name: 'Flow south (Midlands)', region: 'Midlands', line: [[-3.0, 52.75], [-1.8, 52.85], [-0.9, 52.9], [0.2, 52.85]] },
  SWALEX: { name: 'South Wales export', region: 'South Wales', line: [[-3.95, 51.78], [-3.3, 51.82], [-2.7, 51.66]] },
  SEIMP: { name: 'South East / London import', region: 'London and South East', line: [[-1.0, 51.3], [-0.8, 51.75], [0.1, 51.88], [0.75, 51.62]] },
  ESTEX: { name: 'Thames estuary / Kent export', region: 'South East', line: [[0.35, 51.58], [0.7, 51.36], [1.05, 51.22]] },
  ESTEX3: { name: 'Kent (Kemsley/Grain) export 3', region: 'South East', line: [[0.5, 51.5], [0.8, 51.32]] },
  ESTEX4: { name: 'Kent (Kemsley/Grain) export 4', region: 'South East', line: [[0.6, 51.52], [0.9, 51.34]] },
  CANDUNEX: { name: 'Canterbury–Dungeness export', region: 'Kent coast', line: [[1.15, 51.28], [0.95, 50.98]] },
  CANSELEX: { name: 'Canterbury–Sellindge export', region: 'Kent coast', line: [[1.25, 51.25], [1.0, 51.1]] },
  DUNSELEX: { name: 'Dungeness–Sellindge export', region: 'Kent coast', line: [[0.95, 50.95], [1.0, 51.1]] },
  NINSELEX: { name: 'Ninfield–Sellindge export', region: 'Kent coast', line: [[0.4, 50.88], [0.8, 51.05], [1.0, 51.1]] },
  BOLSELEX: { name: 'Bolney–Sellindge export', region: 'Kent coast', line: [[-0.2, 50.98], [0.4, 51.05], [1.0, 51.12]] },
};
const BOUNDARY_ORDER = Object.keys(BOUNDARY);
/** NESO renames boundaries as the network changes (SSE_SP2, SEIMPPR23, SSHARN3...): map a code to its family. */
function bfam(code) {
  const c = String(code).toUpperCase().replace(/-/g, '_');
  if (BOUNDARY[c]) return c;
  const s = c.replace(/PR\d+$/, '').replace(/\d+[A-Z]?$/, '');
  return BOUNDARY[s] ? s : c;
}
const bname = (code) => BOUNDARY[bfam(code)]?.name || code;
const bidx = (code) => { const i = BOUNDARY_ORDER.indexOf(bfam(code)); return i < 0 ? 99 : i; };
const pct = (v) => (v == null || !isFinite(v) ? '–' : `${nf(v < 0.1 && v > 0 ? 1 : 0).format(100 * v)}%`);
const mw = (v) => (v == null || !isFinite(v) ? '–' : `${nf(0).format(v)} MW`);

const CMETRICS = {
  bind: { label: 'Time at or over the limit', short: 'At limit', fmt: pct, f: (r) => ratio(r.n_bind, r.n) },
  load: { label: 'Average loading (flow ÷ limit)', short: 'Avg loading', fmt: pct, f: (r) => r.load_avg },
  excess: { label: 'Energy over the limit', short: 'Over limit', fmt: mwh, f: (r) => r.excess_mwh },
};
const CTYPE_LABEL = { thermal: 'Thermal', voltage: 'Voltage', inertia: 'System inertia', largest_loss: 'Largest loss' };
const CTYPE_COLOUR = { thermal: '--s1', voltage: '--s2', inertia: '--s3', largest_loss: '--s4' };
// NESO's thermal cost groups, coloured by entity so a group keeps its colour whatever else is in range.
const THERMAL_COLOUR = { SSE_SP: '--s1', SCOTEX: '--s2', SSHARN: '--s3', SWALEX: '--s4', SEIMP: '--s5', ESTEX: '--s6' };
let CMETA = { min: null, max: null }, GB_MAP = null;

async function loadCMeta() { CMETA = await api('constraints/meta'); }

const tipLines = (title, lines) => `<div class="tt"><div class="t">${esc(title)}</div>${lines.filter(Boolean).map((l) => `<div class="r"><span>${esc(l)}</span></div>`).join('')}</div>`;

/** Linear blend of two #rrggbb colours. */
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t)))).join(',')})`;
}

async function viewConstraints(main) {
  if (!CMETA.max) {
    main.innerHTML = `<div class="card"><h2>Network constraints${tip('constraints')}</h2>
      <div class="empty">No constraint data yet. <button type="button" class="btn" id="conRefresh">Download it</button> (about two minutes; it is fetched with the Total costs data).</div></div>`;
    wireConRefresh();
    return;
  }
  const m = CMETRICS[state.cmetric] ? state.cmetric : 'bind';
  main.innerHTML = `
  <div class="grid kpis" id="conKpis"></div>
  <div class="grid cols2" style="margin-top:0">
    <div class="card">
      <div class="card-head"><div><h2>Where the network was constrained${tip('boundary')}</h2><div class="sub" id="mapNote"></div></div>
        <div class="controls"><label class="small muted">Colour by ${select('cmetric', Object.entries(CMETRICS).map(([k, v]) => [k, v.label]), m)}${tip('atlimit')}</label></div></div>
      <div class="chart" id="conMap" style="height:560px"></div>
      <div id="mapKey" class="small muted" style="display:flex;align-items:center;gap:8px;justify-content:center"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Boundaries</h2><div class="sub">Totals for the selected range. Click a boundary to see it in detail.</div></div></div>
      <div id="conTable"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>${esc(CMETRICS[m].label)}, by boundary over time${tip('dayahead')}</h2><div class="sub">Day-ahead forecast, north at the top. Click a cell to zoom into that period.</div></div></div>
    <div class="chart tall" id="conHeat"></div>
  </div>
  <div class="card" id="conDetailCard" style="margin-top:14px">
    <div class="card-head"><div><h2 id="detailTitle">Boundary detail</h2><div class="sub" id="detailNote"></div></div>
      <div class="controls"><label class="small muted">Boundary <select id="bnd"></select></label></div></div>
    <div class="chart" id="conDetail"></div>
    <div class="small muted" style="margin:6px 0 0">Share of half-hours at or over the limit</div>
    <div class="chart short" id="conDetailBind" style="height:150px"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>Constraint costs${tip('constraintcost')}</h2><div class="sub" id="ccNote"></div></div>
      <div class="controls"><label class="small muted">View ${select('cview', [['boundary', 'By boundary (thermal only)'], ['type', 'By reason']], state.cview === 'type' ? 'type' : 'boundary')}${tip('reasons')}</label>
        <button class="btn" id="ccToggle">Table</button></div></div>
    <div class="chart" id="conCosts"></div>
    <div id="conCostsTable" hidden></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2>About this data</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      <b style="color:var(--ink)">Boundaries</b> are NESO's day-ahead constraint flows and limits: for each transmission boundary and half-hour, the most power the boundary can safely carry (limit) and the flow NESO forecast across it the day before. A forecast at or over the limit means NESO expected to have to act, typically turning generation down on the exporting side (often Scottish wind) and up on the other. These are forecasts, not metered flows, and NESO renames boundaries as the network changes (for example SSE_SP became SSE_SP2), so a boundary may only cover part of the range. Map positions are schematic, drawn from NESO's network diagrams.<br>
      <b style="color:var(--ink)">Costs</b> are NESO's daily outturn: thermal constraint cost for its main boundary groups, and total constraint cost split by reason. They are only published per day, a few days late.<br>
      <b style="color:var(--ink)">What actually happened</b>: the BM actions NESO took for constraints carry the SO flag. <a href="#" id="soLink" title="Opens the Overview filtered to SO-flagged actions, by technology and unit">See the SO-flagged BM actions by technology and unit</a> in the Overview (most are transmission-connected, so GSP group says little) (unit data held: ${esc(META.min || 'none')} to ${esc(META.max || '')}).
    </div>
    <div class="small muted" id="conMeta" style="margin-top:8px"></div>
    <button type="button" class="btn" id="conRefresh" style="margin-top:8px">Refresh data</button>
  </div>`;
  $('#cmetric').onchange = (e) => update({ cmetric: e.target.value }, true);
  $('#cview').onchange = (e) => update({ cview: e.target.value }, true);
  $('#ccToggle').onclick = () => { const t = $('#conCostsTable'); t.hidden = !t.hidden; $('#conCosts').hidden = !t.hidden; $('#ccToggle').textContent = t.hidden ? 'Table' : 'Chart'; if (t.hidden) charts.get($('#conCosts'))?.resize(); };
  $('#soLink').onclick = (e) => {
    e.preventDefault();
    const to = META.max && state.to > META.max ? META.max : state.to, from = META.min && state.from < META.min ? META.min : state.from;
    Object.assign(state, { view: 'overview', from, to: to < from ? from : to, split: 'tech', bdim: 'unit', filters: { so: ['SO-flagged'] } });
    writeHash();
  };
  const upd = CMETA.updated_at ? new Date(CMETA.updated_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('#conMeta').textContent = `Boundary data ${CMETA.min} to ${CMETA.max} (the last day is tomorrow's forecast once NESO publishes it) · costs through ${CMETA.costs_through || 'n/a'}${upd ? ` · refreshed ${upd}` : ''}${CMETA.error ? ` · some sources failed: ${CMETA.error}` : ''}`;
  wireConRefresh();

  const bucket = resolveBucket();
  const [tot, agg, cc] = await Promise.all([
    api('constraints/agg', { from: state.from, to: state.to, bucket: 'none' }),
    api('constraints/agg', { from: state.from, to: state.to, bucket }),
    api('constraints/costs', { from: state.from, to: state.to, bucket: 'none' }),
  ]);
  const totals = tot.rows.filter((r) => r.g !== '_any').map((r) => ({ ...r, fam: bfam(r.g) }));
  const any = tot.rows.find((r) => r.g === '_any');
  // Thermal cost per boundary family over the range (NESO's cost groups are coarser than the flow boundaries).
  const thermal = {};
  for (const r of cc.rows) if (r.source === 'thermal') thermal[bfam(r.category)] = (thermal[bfam(r.category)] || 0) + r.v;
  const ctype = Object.fromEntries(cc.rows.filter((r) => r.source === 'constraint_type').map((r) => [r.category, r.v]));
  const ctotal = Object.values(ctype).reduce((a, v) => a + (v || 0), 0);
  // Rank by hours at the limit, not share: a boundary published for one day can be "100% of the time".
  const ranked = [...totals].sort((a, b) => b.n_bind - a.n_bind);
  if (!state.bnd || !totals.some((r) => r.g === state.bnd)) state.bnd = ranked[0]?.g || null;

  const top = ranked[0], costDays = cc.rows.find((r) => r.source === 'constraint_type')?.n || 0;
  const topCost = Object.entries(thermal).sort((a, b) => b[1] - a[1])[0];
  $('#conKpis').innerHTML = [
    kpi('Constraint costs', gbp(ctotal), costDays ? `${pct(ratio(ctype.thermal, ctotal))} thermal · ${costDays} day${costDays === 1 ? '' : 's'} published` : 'none published for this range yet', 'constraintcost'),
    kpi('Biggest thermal cost', topCost ? bname(topCost[0]) : '–', topCost ? `${gbp(topCost[1])} in this range` : 'no thermal cost data in range', 'reasons'),
    kpi('Half-hours with a boundary at its limit', pct(any && ratio(any.n_bind, any.n)), any ? `${nf(0).format(any.n_bind)} of ${nf(0).format(any.n)} half-hours (forecast)` : '', 'atlimit'),
    kpi('Most often at its limit', top ? bname(top.g) : '–', top ? `${pct(ratio(top.n_bind, top.n))} of the time · ${nf(0).format(top.n_bind / 2)} hours` : '', 'boundary'),
  ].join('');

  const pick = (g) => drill({ bnd: g }, { reveal: '#conDetailCard' });
  loading($('#conMap'), () => conMap($('#conMap'), totals, m, pick));
  conTable($('#conTable'), totals, thermal, pick);
  loading($('#conHeat'), async () => conHeat($('#conHeat'), agg.rows, bucket, m));
  $('#bnd').innerHTML = [...totals].sort((a, b) => bidx(a.g) - bidx(b.g) || a.g.localeCompare(b.g))
    .map((r) => `<option value="${esc(r.g)}" ${r.g === state.bnd ? 'selected' : ''}>${esc(bname(r.g))} (${esc(r.g)})</option>`).join('');
  $('#bnd').onchange = (e) => pick(e.target.value);
  loading($('#conDetail'), async () => conDetail(agg.rows, bucket));
  loading($('#conCosts'), () => conCosts($('#conCosts'), $('#conCostsTable'), bucket));
}

function wireConRefresh() {  // one refresh fetches the costs, constraints, REMIT, interconnector and DFS data
  const btn = $('#conRefresh');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      await fetch('/api/costs/refresh');
      for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 2000)); const d = await api('constraints/meta'); if (!d.running) break; }
    } finally { btn.disabled = false; btn.textContent = 'Refresh data'; }
    await Promise.all([loadCMeta(), loadRMeta(), loadIMeta(), loadDMeta()].map((p) => p.catch((e) => console.error(e))));
    render();
  };
}

/** Schematic map of GB with each boundary coloured by the chosen measure over the selected range. */
async function conMap(el, totals, m, onPick) {
  if (!GB_MAP) { GB_MAP = await (await fetch('/static/vendor/gb.json')).json(); echarts.registerMap('gb', GB_MAP); }
  const M = CMETRICS[m];
  const byFam = new Map();
  for (const r of totals) {  // several published codes can share a family (renames): keep the one with most data
    const prev = byFam.get(r.fam);
    if (BOUNDARY[r.fam] && (!prev || r.n > prev.n)) byFam.set(r.fam, r);
  }
  const vals = [...byFam.values()].map((r) => M.f(r) ?? 0);
  const hi = m === 'excess' ? Math.max(1, ...vals) : m === 'load' ? Math.max(1, ...vals) : Math.max(0.05, ...vals);
  const lo = css('--seq-lo'), dark = css('--seq-hi');
  const lines = [], labels = [];
  for (const fam of BOUNDARY_ORDER) {
    const b = BOUNDARY[fam], r = byFam.get(fam);
    if (!r) continue;
    const v = M.f(r) ?? 0, t = v / hi;
    lines.push({ name: fam, coords: b.line, r, v, lineStyle: { color: mix(lo, dark, 0.15 + 0.85 * t), width: 3 + 5 * t, opacity: 1, cap: 'round' } });
    labels.push({ name: fam, value: [...b.line[b.line.length - 1], v], r });
  }
  // Selective direct labels: the four boundaries with the highest value.
  const topFams = new Set([...lines].sort((a, b) => b.v - a.v).slice(0, 4).filter((l) => l.v > 0).map((l) => l.name));
  $('#mapNote').textContent = `${M.label} over the selected range. ${lines.length} boundaries with data; positions are schematic.`;
  $('#mapKey').innerHTML = `<span>${esc(M.fmt(0))}</span><span style="width:160px;height:10px;border-radius:2px;background:linear-gradient(90deg,${mix(lo, dark, 0.15)},${dark})"></span><span>${esc(M.fmt(hi))}</span>`;
  const tipFor = (r) => tipLines(`${bname(r.g)} · ${r.g}`, [BOUNDARY[r.fam]?.region || '',
    `At or over the limit ${pct(ratio(r.n_bind, r.n))} of the time (${nf(0).format(r.n_bind / 2)} hours)`,
    `Average loading ${pct(r.load_avg)} · peak ${pct(r.load_max)}`, `Energy over the limit ${mwh(r.excess_mwh)}`]);
  const o = {
    animation: false,
    tooltip: { trigger: 'item', backgroundColor: css('--surface'), borderColor: css('--axis'), textStyle: { color: css('--ink') }, confine: true,
      formatter: (p) => (p.data?.r ? tipFor(p.data.r) + clickHint(`Click to show ${bname(p.data.r.g)}'s flow against its limit below`) : '') },
    geo: { map: 'gb', roam: false, silent: true, aspectScale: 0.6, top: 8, bottom: 8,
      itemStyle: { areaColor: css('--wash'), borderColor: css('--axis'), borderWidth: 0.6 } },
    series: [
      { type: 'lines', coordinateSystem: 'geo', polyline: true, data: lines, zlevel: 1, emphasis: { lineStyle: { width: 9 } } },
      { type: 'scatter', coordinateSystem: 'geo', data: labels, symbolSize: 0, silent: true, zlevel: 2, labelLayout: { hideOverlap: true },
        label: { show: true, position: 'right', fontSize: 10, color: css('--ink2'),
          formatter: (p) => (topFams.has(p.name) ? `${bname(p.data.r.g)} ${M.fmt(p.value[2])}` : '') } },
    ],
  };
  const c = chart(el);
  c.setOption(o, true);
  c.on('click', (p) => { if (p.data?.r) onPick(p.data.r.g); });
}

function conTable(el, totals, thermal, onPick) {
  const seenFam = new Set();
  const rows = [...totals].sort((a, b) => bidx(a.g) - bidx(b.g)).map((r) => {
    // Show a family's thermal cost once, against the code with the most data.
    const best = totals.filter((x) => x.fam === r.fam).sort((a, b) => b.n - a.n)[0] === r && !seenFam.has(r.fam);
    if (best) seenFam.add(r.fam);
    return { g: r.g, name: bname(r.g), region: BOUNDARY[r.fam]?.region || '', bind: ratio(r.n_bind, r.n), hours: r.n_bind / 2,
      load: r.load_avg, peak: r.flow_max, limit: r.limit_avg, excess: r.excess_mwh, cost: best ? thermal[r.fam] ?? null : null, order: bidx(r.g) };
  });
  table(el, [
    { key: 'name', label: 'Boundary', html: (r) => `${esc(r.name)} <span class="muted small">${esc(r.g)}</span>` },
    { key: 'region', label: 'Region', cls: 'hide-sm' },
    { key: 'bind', label: 'At limit', num: true, fmt: pct, tip: 'atlimit' },
    { key: 'hours', label: 'Hours', num: true, fmt: (v) => nf(0).format(v) },
    { key: 'load', label: 'Avg loading', num: true, fmt: pct, tip: 'loading', cls: 'hide-sm' },
    { key: 'limit', label: 'Avg limit', num: true, fmt: mw, cls: 'hide-sm' },
    { key: 'excess', label: 'Over limit', num: true, fmt: mwh, tip: 'excess' },
    { key: 'cost', label: 'Thermal cost', num: true, fmt: (v) => (v == null ? '–' : gbp(v)), tip: 'constraintcost' },
  ], rows, { onRow: (r) => onPick(r.g), rowTip: (r) => `Show ${r.name}'s flow against its limit below`, limit: 60 });
}

/** Boundary x time-bucket grid, one sequential hue. */
function conHeat(el, rows, bucket, m) {
  const M = CMETRICS[m];
  const data = rows.filter((r) => r.g !== '_any');
  const cats = allBuckets(bucket, data);
  const ci = new Map(cats.map((t, i) => [t, i]));
  const groups = [...new Set(data.map((r) => r.g))].sort((a, b) => bidx(a) - bidx(b) || a.localeCompare(b));
  const gi = new Map(groups.map((g, i) => [g, i]));
  const pts = data.filter((r) => ci.has(r.t)).map((r) => ({ value: [ci.get(r.t), gi.get(r.g), M.f(r)], r }));
  const vals = pts.map((p) => p.value[2]).filter((v) => v != null).sort((a, b) => a - b);
  const hi = m === 'bind' ? 1 : vals[Math.min(vals.length - 1, Math.floor(0.99 * vals.length))] || 1;
  const o = baseOption();
  o.legend.show = false;
  o.grid = { left: 8, right: 16, top: 8, bottom: 44, containLabel: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
    const r = p.data.r;
    return tipLines(`${bname(r.g)} · ${bucketLabel(r.t, bucket)}`, [
      `At or over the limit: ${nf(0).format(r.n_bind)} of ${nf(0).format(r.n)} half-hours (${pct(ratio(r.n_bind, r.n))})`,
      `Average loading ${pct(r.load_avg)} · peak ${pct(r.load_max)}`,
      `Flow ${mw(r.flow_avg)} average, ${mw(r.flow_max)} peak · limit ${mw(r.limit_avg)}`,
      `Energy over the limit ${mwh(r.excess_mwh)}`]) +
      clickHint(bucket === 'tod' ? null : `Click to zoom to ${bucketLabel(r.t, bucket)} and show ${bname(r.g)}'s detail`);
  } };
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)), splitArea: { show: false } };
  const dupe = (g) => groups.filter((x) => bname(x) === bname(g)).length > 1;
  o.yAxis = { ...o.yAxis, type: 'category', data: groups.map((g) => (dupe(g) ? `${bname(g)} (${g})` : bname(g))), inverse: true, splitLine: { show: false },
    axisLabel: { ...o.yAxis.axisLabel, width: el.clientWidth < 560 ? 110 : 200, overflow: 'truncate' } };
  o.visualMap = { type: 'continuous', orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160, min: 0, max: hi,
    calculable: false, dimension: 2, text: [M.fmt(hi), M.fmt(0)], textStyle: { color: css('--muted'), fontSize: 11 },
    inRange: { color: [css('--seq-lo'), css('--seq-hi')] } };
  o.series = [{ type: 'heatmap', data: pts, progressive: 0,
    itemStyle: cats.length <= 60 ? { borderColor: css('--surface'), borderWidth: 1 } : {},
    emphasis: { itemStyle: { borderColor: css('--ink'), borderWidth: 1 } } }];
  el.style.height = `${Math.max(260, groups.length * 22 + 80)}px`;
  const c = chart(el);
  c.resize();
  c.setOption(o, true);
  el.style.cursor = bucket === 'tod' ? 'default' : 'pointer';
  c.on('click', (p) => {
    if (bucket === 'tod') return;
    conDrill(p.data.r.t, bucket, { bnd: p.data.r.g });
  });
}

/** Zoom the Constraints tab into one time bucket (like drillTime, but within this tab's own data range). */
function conDrill(t, bucket, extra = {}) {
  const d = String(t).slice(0, 10);
  if (bucket === 'sp' || bucket === 'hour') return drill({ from: d, to: d, bucket: 'auto', ...extra });
  const end = bucket === 'day' ? d : bucket === 'week' ? addDays(d, 6) : iso(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
  drill({ from: d < CMETA.min ? CMETA.min : d, to: end > CMETA.max ? CMETA.max : end, bucket: 'auto', ...extra });
}

/** Forecast flow against the limit for one boundary, plus how often it was at the limit. One axis per chart. */
function conDetail(rows, bucket) {
  const g = state.bnd;
  const mine = rows.filter((r) => r.g === g);
  const cats = allBuckets(bucket, mine), idx = new Map(cats.map((t, i) => [t, i]));
  const at = new Array(cats.length).fill(null);
  for (const r of mine) if (idx.has(r.t)) at[idx.get(r.t)] = r;
  const fine = bucket === 'sp';
  $('#detailTitle').innerHTML = `${esc(bname(g))} <span class="muted small">${esc(g || '')}</span>`;
  $('#detailNote').textContent = fine
    ? 'Forecast flow and limit for each half-hour (day-ahead). Where the flow line is above the limit, NESO expected to constrain.'
    : `Average forecast flow and limit per ${bucket === 'tod' ? 'time of day' : bucket}, with the peak half-hour's flow. MW.`;
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => nf(0).format(v) } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), mw);
  const line = (name, color, f, ls = {}) => ({ name, type: 'line', color, symbol: 'circle', symbolSize: cats.length > 60 ? 3 : 6, showAllSymbol: false, step: fine ? 'start' : false,
    connectNulls: false, lineStyle: { width: 2, color, ...ls }, data: at.map((r) => (r ? f(r) : null)) });
  o.series = [
    line(fine ? 'Forecast flow' : 'Average forecast flow', css('--s1'), (r) => r.flow_avg),
    ...(fine ? [] : [line('Peak forecast flow', css('--s1'), (r) => r.flow_max, { type: 'dashed', width: 1.5, opacity: 0.7 })]),
    line(fine ? 'Limit' : 'Average limit', css('--s8'), (r) => r.limit_avg),
  ];
  chart($('#conDetail')).setOption(o, true);

  const b = baseOption();
  b.legend.show = false; b.grid = { ...b.grid, top: 8 };
  b.xAxis = { ...b.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  b.yAxis = { ...b.yAxis, type: 'value', max: 1, splitNumber: 2, axisLabel: { ...b.yAxis.axisLabel, formatter: (v) => pct(v) } };
  b.tooltip.formatter = (ps) => { const r = at[ps[0].dataIndex]; return tipHtml(ps[0].axisValueLabel, [{ name: r ? `At or over limit (${r.n_bind} of ${r.n} half-hours)` : 'No data', value: ps[0].value, color: ps[0].color }], pct); };
  b.series = [{ type: 'bar', barMaxWidth: 20, barCategoryGap: cats.length > 200 ? '0%' : '25%', color: css('--s1'), emphasis: { disabled: true },
    itemStyle: { borderRadius: [2, 2, 0, 0] }, data: at.map((r) => (r ? ratio(r.n_bind, r.n) : null)) }];
  chart($('#conDetailBind')).setOption(b, true);
}

/** Daily constraint costs, stacked by boundary group or by reason. */
async function conCosts(el, tableEl, bucket) {
  const view = state.cview === 'type' ? 'type' : 'boundary';
  const cb = ['sp', 'hour'].includes(bucket) ? 'day' : bucket;
  if (bucket === 'tod') {
    el.innerHTML = '<div class="empty">Constraint costs are only published per day, so there is no time-of-day profile. Pick another granularity.</div>';
    charts.delete(el); tableEl.innerHTML = ''; $('#ccNote').textContent = '';
    return;
  }
  const data = await api('constraints/costs', { from: state.from, to: state.to, bucket: cb });
  const src = view === 'type' ? 'constraint_type' : 'thermal';
  const rows = data.rows.filter((r) => r.source === src);
  const cats = allBuckets(cb, rows), idx = new Map(cats.map((t, i) => [t, i]));
  const keyTotals = {};
  for (const r of rows) keyTotals[r.category] = (keyTotals[r.category] || 0) + Math.abs(r.v);
  const keys = view === 'type' ? Object.keys(CTYPE_LABEL).filter((k) => keyTotals[k])
    : Object.keys(keyTotals).filter((k) => keyTotals[k]).sort((a, b) => bidx(a) - bidx(b));
  const label = (k) => (view === 'type' ? CTYPE_LABEL[k] : `${bname(k)} (${k})`);
  const col = (k) => css(view === 'type' ? CTYPE_COLOUR[k] : THERMAL_COLOUR[bfam(k)] || '--other');
  $('#ccNote').textContent = `${view === 'type' ? 'NESO\'s daily constraint cost, by reason.' : 'Outturn thermal constraint cost for NESO\'s main boundary groups.'} Published per day${cb !== bucket ? ', so shown per day' : ''}; NESO data through ${data.through || 'n/a'}.`;
  if (!keys.length) { el.innerHTML = '<div class="empty">No constraint costs published for this range yet.</div>'; charts.delete(el); tableEl.innerHTML = ''; return; }
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, cb)) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => gbp(v) } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), gbp,
    ps.reduce((s, p) => s + (p.value || 0), 0));
  const gap = cats.length <= 70;
  o.series = keys.map((k, i) => {
    const d = new Array(cats.length).fill(null);
    for (const r of rows) if (r.category === k && idx.has(r.t)) d[idx.get(r.t)] = r.v;
    return { name: label(k), type: 'bar', stack: 'a', barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%', color: col(k),
      itemStyle: gap ? { borderColor: css('--surface'), borderWidth: 1 } : {}, emphasis: { disabled: true }, data: d };
  });
  chart(el).setOption(o, true);
  const trows = cats.map((t, i) => ({ t: bucketLabel(t, cb), ...Object.fromEntries(o.series.map((s, j) => ['s' + j, s.data[i]])),
    total: o.series.reduce((a, s) => a + (s.data[i] || 0), 0) })).filter((r) => o.series.some((_, j) => r['s' + j] != null));
  table(tableEl, [{ key: 't', label: 'Period' }, ...o.series.map((s, j) => ({ key: 's' + j, label: s.name, num: true, fmt: (v) => gbp(v) })),
    { key: 'total', label: 'Total', num: true, fmt: (v) => gbp(v) }], trows, { limit: 400 });
}

// ------------------------------------------------------------------ REMIT outages (unavailable capacity by GSP group)

// GSP groups (Elexon ids) in the order the map and tables list them: north to south.
const GSP_ORDER = ['_P', '_N', '_F', '_G', '_M', '_D', '_B', '_E', '_A', '_K', '_C', '_J', '_H', '_L'];
const GSP_NAME = { _A: 'East England', _B: 'East Midlands', _C: 'London', _D: 'Merseyside and North Wales', _E: 'West Midlands',
  _F: 'North East England', _G: 'North West England', _H: 'Southern England', _J: 'South East England', _K: 'South Wales',
  _L: 'South West England', _M: 'Yorkshire', _N: 'South and Central Scotland', _P: 'North Scotland', Unknown: 'Not placed' };
const gspName = (g) => GSP_NAME[g] || g;
// REMIT fuel types, coloured like the technologies elsewhere in the dashboard.
const RFUEL_COLOUR = [[/gas/i, '--s1'], [/interconn/i, '--s2'], [/wind onshore/i, '--s6'], [/wind/i, '--s3'], [/pumped/i, '--s4'], [/biomass/i, '--s5'],
  [/hydro/i, '--s6'], [/storage|batter/i, '--s7'], [/nuclear/i, '--s8'], [/coal/i, '--other2']];
const RKINDS = [['production', 'Generation'], ['consumption', 'Demand (consumption)']];
const RSPLITS = [['gsp', 'GSP group'], ['fuel', 'Fuel type'], ['type', 'Planned or unplanned']];
const mwc = (v) => (v == null || !isFinite(v) ? '–' : Math.abs(v) >= 1000 ? `${nf(1).format(v / 1000)} GW` : `${nf(0).format(v)} MW`);
let RMETA = { min: null, max: null }, GSP_MAP = null, remitTimer = null;

async function loadRMeta() { RMETA = await api('remit/meta'); }

function rcolour(split, g, rank) {
  if (g === 'Other (rest)' || g === 'Unknown') return css('--other');
  if (split === 'type') return css(g === 'Planned' ? '--s1' : '--s2');
  if (split === 'fuel') return css(RFUEL_COLOUR.find(([re]) => re.test(g))?.[1] || '--other2');
  return css(`--s${(rank % 8) + 1}`);
}

async function viewRemit(main) {
  clearInterval(remitTimer); remitTimer = null;
  if (!RMETA.max) {
    main.innerHTML = `<div class="card"><h2>REMIT outages${tip('remit')}</h2>
      <div class="empty">No REMIT data yet. <button type="button" class="btn" id="conRefresh">Download it</button> (a few minutes the first time; it is fetched with the Total costs and Constraints data).</div></div>`;
    wireConRefresh(loadRMeta);
    return;
  }
  const kind = RKINDS.some(([k]) => k === state.rkind) ? state.rkind : 'production';
  const split = RSPLITS.some(([k]) => k === state.rsplit) ? state.rsplit : 'gsp';
  const bucket = resolveBucket();
  const long = state.rlong === '1';
  main.innerHTML = `
  <div class="grid kpis" id="rKpis"></div>
  <div class="grid cols2" style="margin-top:0">
    <div class="card">
      <div class="card-head"><div><h2>Unavailable capacity by GSP group${tip('gspgroup')}</h2><div class="sub" id="rMapNote"></div></div>
        <div class="controls"><label class="small muted">Show ${select('rkind', RKINDS, kind)}</label>
          <label class="small muted"><input type="checkbox" id="rlong" ${long ? 'checked' : ''}> Closures${tip('closures')}</label></div></div>
      <div class="replay-bar" style="margin:4px 0 0">
        <button type="button" class="btn" id="rBack" title="Previous period">‹</button>
        <button type="button" class="btn primary" id="rPlay" title="Step through the selected range">Play</button>
        <button type="button" class="btn" id="rFwd" title="Next period">›</button>
        <b id="rWhen" style="font-variant-numeric:tabular-nums"></b>
      </div>
      <input type="range" class="rp-slider" id="rSlider" min="0" max="0" value="0" aria-label="Period shown on the map">
      <div class="chart" id="rMap" style="height:540px"></div>
      <div id="rKey" class="small muted" style="display:flex;align-items:center;gap:8px;justify-content:center"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2 id="rTableTitle">Outages</h2><div class="sub" id="rTableNote"></div></div>
        <div class="controls"><button type="button" class="btn small" id="rClear" hidden>Show all regions</button></div></div>
      <div id="rTable"></div>
    </div>
  </div>
  <div class="card" id="rDetail" style="margin-top:14px" hidden></div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>Unavailable capacity over time${tip('unavail')}</h2><div class="sub">Average MW unavailable in each period. Click a bar to show that period on the map.</div></div>
      <div class="controls"><label class="small muted">Split by ${select('rsplit', RSPLITS, split)}</label></div></div>
    <div class="chart tall" id="rTime"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2>About this data</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      <b style="color:var(--ink)">REMIT messages</b> are published by the owners of generators (and large demand sites) whenever a unit's available capacity changes by 100 MW or more, planned or not, under the EU REMIT regulation as kept in GB law. Each gives the unit, its normal capacity, what is still available and when; many add a profile of the available capacity through the event. Messages are revised as an outage develops: only each message's latest revision counts, and messages the participant withdrew ("dismissed") are left out. Source: Elexon Insights (BMRS) REMIT data.<br>
      <b style="color:var(--ink)">Closures</b>: stations that have closed or been mothballed often stay in REMIT as open-ended outages running for decades (Ratcliffe, Fiddler's Ferry and Dungeness B, for example, run to 2050). Events longer than a year are left out unless you tick <i>Closures</i>, so the map shows outages rather than retired plant.<br>
      <b style="color:var(--ink)">Adding up</b>: a unit's unavailable capacity is its normal capacity minus what the message says is available, averaged over each half-hour. If two live messages cover the same unit at the same time (a planned outage and an unplanned extension, say) the larger counts, not both.${tip('remitadd')}<br>
      <b style="color:var(--ink)">GSP groups</b> are the 14 regions of the distribution networks. Elexon gives embedded units a GSP group directly; transmission-connected units, which carry most of the capacity, are placed by their transmission loss factor, which Elexon sets per GSP-group zone; that places virtually all the capacity outside closures.${tip('remitplace')} Region outlines: NESO, GB DNO licence areas (NESO Open Data Licence), simplified.
    </div>
    <div class="small muted" id="rMeta" style="margin-top:8px"></div>
    <button type="button" class="btn" id="conRefresh" style="margin-top:8px">Refresh data</button>
  </div>`;
  const upd = RMETA.updated_at ? new Date(RMETA.updated_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('#rMeta').textContent = `${nf(0).format(RMETA.n)} messages held, for events from ${RMETA.min} to ${RMETA.max} (planned outages are published ahead)${upd ? ` · refreshed ${upd}` : ''}${RMETA.error ? ` · some sources failed: ${RMETA.error}` : ''}`;
  wireConRefresh(loadRMeta);
  $('#rkind').onchange = (e) => update({ rkind: e.target.value }, true);
  $('#rsplit').onchange = (e) => update({ rsplit: e.target.value }, true);
  $('#rlong').onchange = (e) => update({ rlong: e.target.checked ? '1' : null }, true);

  const d = await api('remit/agg', { from: state.from, to: state.to, bucket, kind, long: long ? 'true' : null });
  const cats = d.slots.map((s) => s.t);
  const nAt = new Map(d.slots.map((s) => [s.t, s.n]));
  const idx = new Map(cats.map((t, i) => [String(t), i]));
  const sum = (rows) => { const v = new Array(cats.length).fill(0); for (const r of rows) v[idx.get(String(r.t))] += r.mw; return v; };
  const total = sum(d.type), unplanned = sum(d.type.filter((r) => r.g === 'Unplanned'));
  const byGsp = new Map();  // gsp -> MW per bucket
  for (const r of d.gsp) { if (!byGsp.has(r.g)) byGsp.set(r.g, new Array(cats.length).fill(0)); byGsp.get(r.g)[idx.get(String(r.t))] = r.mw; }
  const mapMax = Math.max(1, ...[...byGsp.entries()].filter(([g]) => g !== 'Unknown').flatMap(([, v]) => v));

  // The period shown: the one asked for, else the one containing now, else the last.
  const nowKey = (() => {
    const t = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    let best = null;
    for (const c of cats) if (bucket === 'tod' || bucket === 'none' || String(c) <= t) best = c;
    return best;
  })();
  let k = idx.has(String(state.rt)) ? idx.get(String(state.rt)) : idx.has(String(nowKey)) ? idx.get(String(nowKey)) : cats.length - 1;
  const label = (t) => (bucket === 'none' ? 'the whole range' : bucket === 'tod' ? `${spTime(t)} (average across the range)` : bucketLabel(t, bucket) + (bucket === 'sp' ? '' : ''));

  // KPIs
  const wsum = cats.reduce((a, t, i) => a + total[i] * nAt.get(t), 0), wn = cats.reduce((a, t) => a + nAt.get(t), 0);
  const peakI = total.reduce((b, v, i) => (v > total[b] ? i : b), 0);
  const uw = cats.reduce((a, t, i) => a + unplanned[i] * nAt.get(t), 0);
  const kpiAt = () => kpi(`Unavailable, ${label(cats[k])}`, mwc(total[k]), `${mwc(unplanned[k])} unplanned`, 'unavail');
  const drawKpis = () => {
    $('#rKpis').innerHTML = [kpiAt(),
      kpi('Average unavailable', mwc(wn ? wsum / wn : null), `over the selected range`, 'unavail'),
      kpi('Peak', mwc(total[peakI]), cats.length ? label(cats[peakI]) : '', 'unavail'),
      kpi('Unplanned share', pct(ratio(uw, wsum)), `${nf(0).format(d.units)} units with outages in range`, 'planned')].join('');
  };

  // Map
  if (!GSP_MAP) { GSP_MAP = await (await fetch('/static/vendor/gsp_groups.json')).json(); echarts.registerMap('gspg', GSP_MAP); }
  const lo = css('--seq-lo'), hi = css('--seq-hi');
  const mapChart = chart($('#rMap'));
  $('#rKey').innerHTML = `<span>0</span><span style="width:160px;height:10px;border-radius:2px;background:linear-gradient(90deg,${lo},${hi})"></span><span>${esc(mwc(mapMax))}</span>`;
  const drawMap = () => {
    const vals = GSP_ORDER.map((g) => ({ name: g, value: byGsp.get(g)?.[k] || 0 }));
    const unknown = byGsp.get('Unknown')?.[k] || 0;
    $('#rMapNote').textContent = `Average MW unavailable in ${label(cats[k])}. Colour scale fixed across the range, so periods compare.${unknown >= 1 ? ` ${mwc(unknown)} could not be placed.` : ''}`;
    $('#rWhen').textContent = label(cats[k]);
    mapChart.setOption({
      animation: false,
      tooltip: { trigger: 'item', backgroundColor: css('--surface'), borderColor: css('--axis'), textStyle: { color: css('--ink') }, confine: true,
        formatter: (p) => tipLines(`${gspName(p.name)} · ${p.name}`, [`${mwc(p.value)} unavailable on average`, label(cats[k])]) +
          clickHint(state.rgsp === p.name ? 'Click to show every region in the table' : `Click to list only ${gspName(p.name)}'s outages`) },
      visualMap: { show: false, min: 0, max: mapMax, inRange: { color: [lo, hi] } },
      series: [{ type: 'map', map: 'gspg', roam: false, aspectScale: 0.6, top: 8, bottom: 8, selectedMode: false, data: vals,
        itemStyle: { borderColor: css('--surface'), borderWidth: 1 },
        emphasis: { itemStyle: { areaColor: css('--s4') }, label: { color: css('--ink') } },
        label: { show: true, fontSize: 10, color: css('--ink'), textBorderColor: css('--surface'), textBorderWidth: 2,
          formatter: (p) => (p.value >= mapMax * 0.04 ? mwc(p.value) : '') },
        labelLayout: { hideOverlap: true },
        markPoint: undefined }],
    }, true);
    // Emphasise the region the table is filtered to.
    if (state.rgsp) mapChart.dispatchAction({ type: 'highlight', name: state.rgsp });
  };
  mapChart.on('click', (p) => drill({ rgsp: state.rgsp === p.name ? null : p.name }));

  // Outage table for the period shown (latest request wins).
  let ticket = 0;
  const drawTable = async () => {
    const my = ++ticket;
    const res = await api('remit/outages', { from: state.from, to: state.to, bucket, kind, t: cats[k], long: long ? 'true' : null });
    if (my !== ticket) return;
    const rows = res.rows.filter((r) => !state.rgsp || r.gsp === state.rgsp);
    $('#rTableTitle').textContent = `Outages${state.rgsp ? ` in ${gspName(state.rgsp)}` : ''}, ${label(cats[k])}`;
    $('#rTableNote').textContent = `${rows.length} unit${rows.length === 1 ? '' : 's'}, ${mwc(rows.reduce((a, r) => a + r.mw, 0))} unavailable on average. Click an outage for its details.`;
    noteRemitNames(rows);
    $('#rClear').hidden = !state.rgsp;
    const fmtT = (s) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    table($('#rTable'), [
      { key: 'asset', label: 'Unit', cls: 'wrap', html: (r) => `${esc(r.name || r.asset)} <span class="muted small">${esc(r.asset)}</span>` },
      { key: 'mw', label: 'Unavailable', num: true, fmt: mw, tip: 'unavail' },
      { key: 'normal_mw', label: 'Normal', num: true, fmt: mw, cls: 'hide-sm' },
      { key: 'planned', label: 'Type', fmt: (v) => (v ? 'Planned' : 'Unplanned'), tip: 'planned' },
      { key: 'gsp', label: 'GSP group', fmt: gspName, cls: 'hide-sm' },
      { key: 'fuel', label: 'Fuel', cls: 'hide-sm' },
      { key: 'end', label: 'Until', fmt: (v) => fmtT(v), cls: 'hide-sm' },
      { key: 'cause', label: 'Cause', cls: 'hide-sm' },
    ], rows, { onRow: (r, tr) => openOutage(r.mrid, tr), rowCls: (r) => (r.mrid === state.rmsg ? 'sel' : ''),
      rowTip: (r) => `${r.cause || ''}${r.cause ? ' · ' : ''}${fmtT(r.start)} to ${fmtT(r.end)} · click for this outage's details`, limit: 200 });
  };
  // Open an outage's details below the map without redrawing the tab (a trail step, so Back closes it again).
  const openOutage = (mrid, tr) => {
    if (!mrid || mrid === state.rmsg) { if (mrid) $('#rDetail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    drill({ rmsg: mrid }, { render: false });
    $('#rTable').querySelectorAll('tbody tr.sel').forEach((x) => x.classList.remove('sel'));
    if (tr && tr.closest('#rTable')) tr.classList.add('sel');
    remitDetail($('#rDetail'), openOutage, true).catch((e) => console.error(e));
  };
  if (state.rmsg) remitDetail($('#rDetail'), openOutage).catch((e) => console.error(e));
  $('#rClear').onclick = () => { state.rgsp = null; writeHash(true); };

  // Time chart
  const series = d[split];
  const totals = {};
  for (const r of series) totals[r.g] = (totals[r.g] || 0) + r.mw * nAt.get(r.t);
  let groups = Object.keys(totals).filter((g) => g !== 'Unknown').sort((a, b) => (split === 'gsp' ? GSP_ORDER.indexOf(a) - GSP_ORDER.indexOf(b) : totals[b] - totals[a]));
  if (split === 'type') groups = ['Planned', 'Unplanned'].filter((g) => totals[g]);
  const TOP = 7;
  const keep = new Set(split === 'type' ? groups : [...groups].sort((a, b) => totals[b] - totals[a]).slice(0, TOP));
  const shown = groups.filter((g) => keep.has(g));
  const rest = groups.length > shown.length || totals.Unknown ? (split === 'gsp' ? 'Other (rest)' : 'Other (rest)') : null;
  const name = (g) => (split === 'gsp' ? gspName(g) : g);
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => (bucket === 'none' ? 'Range' : bucketLabel(t, bucket))) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => mwc(v) } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), mwc,
    ps.reduce((a, p) => a + (p.value || 0), 0)) + clickHint(`Click to show ${ps[0].axisValueLabel} on the map`);
  const gap = cats.length <= 70;
  const bar = (nm, color, data) => ({ name: nm, type: 'bar', stack: 'a', barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%', color,
    itemStyle: gap ? { borderColor: css('--surface'), borderWidth: 1 } : {}, emphasis: { disabled: true }, data });
  o.series = shown.map((g, i) => bar(name(g), rcolour(split, g, i), sum(series.filter((r) => r.g === g))));
  if (rest) o.series.push(bar(split === 'gsp' ? 'Other regions and not placed' : 'Other', css('--other'), sum(series.filter((r) => !keep.has(r.g)))));
  const markOf = () => ({ silent: true, symbol: 'none', lineStyle: { color: css('--ink2'), type: 'dashed', width: 1.5 }, label: { show: false }, data: [{ xAxis: k }] });
  if (o.series.length) o.series[0].markLine = markOf();
  const timeChart = chart($('#rTime'));
  timeChart.setOption(o, true);
  timeChart.getZr().off('click');
  timeChart.getZr().on('click', (e) => {
    // convertFromPixel by axis returns null for a category axis; by series it gives [category index, value].
    const x = timeChart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY])?.[0];
    if (x == null || x < 0 || x >= cats.length) return;
    pause(); go(x);
  });
  $('#rTime').style.cursor = 'pointer';

  const slider = $('#rSlider');
  slider.max = String(Math.max(0, cats.length - 1));
  const go = (i, quiet = false) => {
    k = Math.max(0, Math.min(cats.length - 1, i));
    slider.value = String(k);
    state.rt = String(cats[k]);
    const [path, qs] = location.hash.split('?'), q = new URLSearchParams(qs || '');
    q.set('rt', state.rt);
    history.replaceState(null, '', `${path}?${q}`);
    drawMap(); drawKpis();
    if (o.series.length) timeChart.setOption({ series: [{ markLine: markOf() }] });
    if (!quiet) drawTable().catch((e) => console.error(e));
  };
  const pause = () => { clearInterval(remitTimer); remitTimer = null; $('#rPlay').textContent = 'Play'; drawTable().catch((e) => console.error(e)); };
  const play = () => {
    if (k >= cats.length - 1) go(0, true);
    $('#rPlay').textContent = 'Pause';
    clearInterval(remitTimer);
    remitTimer = setInterval(() => {
      if (!$('#rMap')?.isConnected) { clearInterval(remitTimer); remitTimer = null; return; }
      if (k >= cats.length - 1) { pause(); return; }
      go(k + 1);  // the table follows too; a slow reply is dropped once a newer step has asked
    }, cats.length > 200 ? 200 : cats.length > 60 ? 300 : 600);
  };
  $('#rPlay').onclick = () => (remitTimer ? pause() : play());
  $('#rBack').onclick = () => { if (remitTimer) pause(); go(k - 1); };
  $('#rFwd').onclick = () => { if (remitTimer) pause(); go(k + 1); };
  slider.oninput = () => { if (remitTimer) { clearInterval(remitTimer); remitTimer = null; $('#rPlay').textContent = 'Play'; } go(+slider.value, true); };
  slider.onchange = () => drawTable().catch((e) => console.error(e));
  if (!cats.length) { main.querySelector('#rMap').innerHTML = '<div class="empty">No periods in this range.</div>'; return; }
  go(k);
}

/** The outage panel on the REMIT tab: one REMIT message, its profile through the event, and the unit's other messages. */
async function remitDetail(el, onPick, scroll = false) {
  const mrid = state.rmsg;
  el.hidden = false;
  el.innerHTML = '<div class="empty">Loading outage…</div>';
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let m;
  try { m = await api('remit/message', { mrid }); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (state.rmsg !== mrid) return;  // another outage was opened meanwhile
  noteRemitNames([m]);
  drawZoomTrail();
  const when = (s) => new Date(s).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const short = (s) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const hours = (new Date(m.end) - new Date(m.start)) / 3600000;
  const dur = hours >= 48 ? `${nf(hours >= 240 ? 0 : 1).format(hours / 24)} days` : `${nf(hours >= 10 ? 0 : 1).format(hours)} hours`;
  const now = Date.now(), t0 = new Date(m.start).getTime(), t1 = new Date(m.end).getTime();
  const phase = now < t0 ? 'Not started yet' : now > t1 ? 'Ended' : 'Under way now';
  const peak = m.profile.reduce((a, p) => Math.max(a, p.mw || 0), 0) || m.unavailable_mw || 0;
  el.innerHTML = `<div class="card-head"><div><h2>${esc(m.name || m.asset)} <span class="muted small">${esc(m.asset)}</span></h2>
      <div class="sub">${[m.fuel, m.gsp && gspName(m.gsp), m.participant].filter(Boolean).map(esc).join(' · ')}</div></div>
      <div class="controls"><button type="button" class="btn small" id="rdUnit" title="Open ${esc(m.asset)}'s Balancing Mechanism page: its bids, offers and costs">Balancing Mechanism page</button>
        <button type="button" class="btn small" id="rdClose" title="Close the outage details (Esc)">Close</button></div></div>
    <div class="grid kpis" style="margin:12px 0">
      ${kpi('Unavailable at most', mw(peak), m.normal_mw ? `of ${mw(m.normal_mw)} normal capacity (${nf(0).format(100 * peak / m.normal_mw)}%)` : '', 'unavail')}
      ${kpi('Type', m.planned ? 'Planned' : 'Unplanned', m.cause || 'no cause given', 'planned')}
      ${kpi('Starts', short(m.start), phase)}
      ${kpi('Ends', short(m.end), dur)}
      ${kpi('Status', m.status === 'Dismissed' ? 'Withdrawn' : m.status || '–', `${m.status === 'Dismissed' ? 'not counted · ' : ''}revision ${m.revision}${m.published ? `, published ${short(m.published)}` : ''}`)}
    </div>
    <div class="sub" style="margin-bottom:4px">${m.profile.length > 1 ? 'Capacity unavailable through the outage, step by step as the message gives it.' : 'Capacity unavailable through the outage (the message gives one value for the whole event).'}${m.normal_mw ? ' The dashed line is the unit\'s normal capacity.' : ''}${m.status === 'Dismissed' ? ' <b>This message was withdrawn by the participant, so it is not counted in the totals above.</b>' : ''}</div>
    <div class="chart" id="rdChart" style="height:260px"></div>
    <h2 style="margin-top:14px">REMIT messages for this unit</h2>
    <div class="sub">${m.n_others} message${m.n_others === 1 ? '' : 's'} held for ${esc(m.asset)}, latest event first${m.n_others > m.others.length ? ` (showing ${m.others.length})` : ''}. Click one to show it above.</div>
    <div id="rdOthers"></div>
    <div class="small muted" style="margin-top:8px">Message ${esc(m.msg_id)} · mRID ${esc(m.mrid)} · from ${when(m.start)} to ${when(m.end)}</div>`;
  $('#rdUnit').onclick = () => openUnit(m.asset);
  $('#rdClose').onclick = () => (trailAt >= 0 && zoomTrail[trailAt]?.to.rmsg === mrid && !zoomTrail[trailAt].from.rmsg ? zoomOut(1) : update({ rmsg: null }));

  // Profile chart: available capacity as steps, the normal capacity dashed. One axis (MW).
  const normal = m.normal_mw;
  const pts = [];
  const segs = m.profile.length ? m.profile : [{ start: m.start, end: m.end, mw: m.unavailable_mw }];
  let last = null;
  for (const p of segs) {
    const a = new Date(p.start).getTime(), b = new Date(p.end).getTime(), v = p.mw || 0;
    if (last != null && a > last) pts.push([last, null]);  // a gap in the profile
    pts.push([a, v], [b, v]);
    last = b;
  }
  const o = baseOption();
  o.legend.show = false;
  o.grid.top = 24;
  o.xAxis = { ...o.xAxis, type: 'time', axisLabel: { ...o.xAxis.axisLabel, hideOverlap: true, formatter: { year: '{yyyy}', month: '{MMM} {yyyy}', day: '{d} {MMM}', hour: '{HH}:{mm}', minute: '{HH}:{mm}' } } };
  o.yAxis = { ...o.yAxis, type: 'value', min: 0, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => nf(0).format(v) } };
  o.tooltip.formatter = (ps) => tipHtml(short(new Date(ps[0].value[0]).toISOString()), ps.map((p) => ({ name: p.seriesName, value: p.value[1], color: p.color })), mw);
  o.series = [{ name: 'Unavailable', type: 'line', color: css('--s2'), symbol: 'none', connectNulls: false,
    lineStyle: { width: 2 }, areaStyle: { color: css('--s2'), opacity: 0.25 }, data: pts,
    markLine: now > t0 - 86400000 * 3 && now < t1 + 86400000 * 3 ? { silent: true, symbol: 'none', lineStyle: { color: css('--ink2'), type: 'dashed' },
      label: { formatter: 'now', color: css('--muted'), fontSize: 11 }, data: [{ xAxis: now }] } : undefined }];
  if (normal != null) o.series.push({ name: 'Normal capacity', type: 'line', color: css('--other2'), symbol: 'none', lineStyle: { width: 1.5, type: 'dashed' },
    data: [[pts[0][0], normal], [last, normal]] });
  chart($('#rdChart')).setOption(o, true);

  table($('#rdOthers'), [
    { key: 'start', label: 'From', fmt: short },
    { key: 'end', label: 'Until', fmt: short },
    { key: 'unavailable_mw', label: 'Unavailable', num: true, fmt: mw, tip: 'unavail' },
    { key: 'planned', label: 'Type', fmt: (v) => (v ? 'Planned' : 'Unplanned'), tip: 'planned' },
    { key: 'status', label: 'Status', cls: 'hide-sm' },
    { key: 'cause', label: 'Cause', cls: 'hide-sm wrap' },
  ], m.others, { onRow: (r) => onPick(r.mrid), rowCls: (r) => (r.mrid === mrid ? 'sel' : ''), rowTip: (r) => (r.mrid === mrid ? 'Shown above' : 'Click to show this message above'), limit: 100 });
}

// ------------------------------------------------------------------ data / ingest view

// ------------------------------------------------------------------ interconnector balancing (NESO trades over the links)

// GB interconnectors: landing points as [lon, lat] (GB end, far end). Approximate converter-station locations; the map is
// schematic. `bend` curves lines that would otherwise overlap (the Kent links). Colour follows the link.
const IC = {
  IFA: { name: 'IFA', country: 'France', mw: 2000, gb: [0.98, 51.11], far: [1.77, 50.88], gbSite: 'Sellindge, Kent', farSite: 'Bonningues-lès-Calais', bend: -0.35, col: '--s1' },
  IFA2: { name: 'IFA2', country: 'France', mw: 1000, gb: [-1.27, 50.84], far: [-0.2, 49.17], gbSite: 'Chilling, Hampshire', farSite: 'Tourbe, Normandy', bend: 0, col: '--s7' },
  ELEC: { name: 'ElecLink', country: 'France', mw: 1000, gb: [1.15, 51.09], far: [1.81, 50.95], gbSite: 'Folkestone, Kent', farSite: 'Coquelles', bend: 0.35, col: '--s3' },
  NEMO: { name: 'Nemo Link', country: 'Belgium', mw: 1000, gb: [1.34, 51.3], far: [3.21, 51.31], gbSite: 'Richborough, Kent', farSite: 'Zeebrugge', bend: 0.1, col: '--s4' },
  BRTN: { name: 'BritNed', country: 'Netherlands', mw: 1000, gb: [0.7, 51.45], far: [4.03, 51.96], gbSite: 'Isle of Grain, Kent', farSite: 'Maasvlakte', bend: -0.12, col: '--s2' },
  VKL: { name: 'Viking Link', country: 'Denmark', mw: 1400, gb: [-0.2, 52.93], far: [9.07, 55.53], gbSite: 'Bicker Fen, Lincolnshire', farSite: 'Revsing, Jutland', bend: -0.08, col: '--s8' },
  NSL: { name: 'North Sea Link', country: 'Norway', mw: 1400, gb: [-1.51, 55.13], far: [6.62, 59.52], gbSite: 'Blyth, Northumberland', farSite: 'Kvilldal', bend: -0.1, col: '--s6' },
  EWIC: { name: 'EWIC', country: 'Ireland', mw: 500, gb: [-3.07, 53.23], far: [-6.48, 53.47], gbSite: "Connah's Quay, Flintshire", farSite: 'Woodland, Co. Meath', bend: 0.1, col: '--s5' },
  GRNL: { name: 'Greenlink', country: 'Ireland', mw: 504, gb: [-4.99, 51.68], far: [-6.98, 52.25], gbSite: 'Pembroke', farSite: 'Great Island, Co. Wexford', bend: -0.1, col: '--other2' },
  MOYL: { name: 'Moyle', country: 'Northern Ireland', mw: 500, gb: [-4.93, 55.07], far: [-5.75, 54.83], gbSite: 'Auchencrosh, Ayrshire', farSite: 'Islandmagee, Co. Antrim', bend: 0.25, col: '--other2' },
};
const IC_ORDER = Object.keys(IC);
const icName = (k) => IC[k]?.name || k;
const IDIM_LABEL = { ic: 'Interconnector', direction: 'Direction', party: 'Counterparty', kind: 'Trade type', so: 'SO flag' };
const IFIXED = { direction: { 'NESO buys': '--div-pos', 'NESO sells': '--div-neg' },
  kind: { 'Counterparty trade': '--s1', 'SO-SO (system operator)': '--s4' }, so: { Energy: '--s1', 'System (SO-flagged)': '--s2' } };
const icColour = (dim, g) => (dim === 'ic' && IC[g] ? css(IC[g].col) : IFIXED[dim]?.[g] ? css(IFIXED[dim][g]) : colour('ic_' + dim, g));
const icLabel = (dim, g) => (dim === 'ic' ? icName(g) : g);
const icNet = (r) => n0(r.buy_cost) + n0(r.sell_cost);
const icGross = (r) => Math.abs(n0(r.buy_vol)) + Math.abs(n0(r.sell_vol));
const IMETRICS = {
  net: { label: 'Net trade cost', fmt: gbp, parts: [{ f: icNet }],
    help: 'What NESO paid for energy it bought over the interconnectors, less what it received for energy it sold.' },
  volume: { label: 'Traded volume', fmt: mwh, parts: [{ f: (r) => n0(r.buy_vol), tag: 'bought' }, { f: (r) => n0(r.sell_vol), tag: 'sold' }],
    help: 'Energy NESO bought (more flow into GB, or less out) plotted upward; energy it sold plotted downward.' },
  price: { label: 'Average trade price', fmt: price, line: true,
    help: 'Volume-weighted price of the trades (cost ÷ volume). SO-SO trades published without a cost are left out.' },
  clear: { label: 'Clearing price', fmt: price, line: true, clear: true,
    help: 'The marginal trade in each half-hour (the dearest NESO bought, or the cheapest it sold), averaged over the half-hours in each period.' },
};
const IMAP = [['volume', 'NESO traded volume'], ['net', 'Net trade cost'], ['clear', 'Clearing price'], ['flow', 'Physical flow']];
const IHEAT = [['clear', 'Clearing price'], ['vwap', 'Average price'], ['net', 'Net traded volume']];
let IMETA = { min: null, max: null }, NWE_MAP = null, icTimer = null;

async function loadIMeta() { IMETA = await api('ic/meta'); }

/** Query params for the interconnector endpoints: range plus the link and counterparty picked in the tab. */
const icParams = (extra = {}) => ({ from: state.from, to: state.to, ic: state.ic || '', party: state.icp || '', ...extra });

async function viewInterconnectors(main) {
  clearInterval(icTimer); icTimer = null;
  if (!IMETA.max) {
    main.innerHTML = `<div class="card"><h2>Interconnector balancing${tip('ic')}</h2>
      <div class="empty">No interconnector data yet. <button type="button" class="btn" id="conRefresh">Download it</button> (a few minutes the first time; it is fetched with the Total costs data).</div></div>`;
    wireConRefresh();
    return;
  }
  const metric = IMETRICS[state.imetric] ? state.imetric : 'net';
  const split = IDIM_LABEL[state.isplit] || state.isplit === 'none' ? state.isplit : 'ic';
  const bd = ['party', 'ic', 'kind'].includes(state.ibd) ? state.ibd : 'party';
  const mapBy = IMAP.some(([k]) => k === state.imap) ? state.imap : 'volume';
  const pdir = state.ipdir === 'sell' ? 'sell' : 'buy';
  const heatBy = IHEAT.some(([k]) => k === state.iheat) ? state.iheat : 'clear';
  const bucket = resolveBucket();
  const days = (parseDay(state.to) - parseDay(state.from)) / DAY + 1;
  const sel = [state.ic && `Interconnector: ${icName(state.ic)}`, state.icp && `Counterparty: ${state.icp}`].filter(Boolean);
  main.innerHTML = `
  ${sel.length ? `<div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="small muted">Showing</span>
    ${sel.map((s) => `<span class="chip"><span>${esc(s)}</span></span>`).join('')}<button type="button" class="btn small" id="icClear" title="Show every interconnector and counterparty again">Show all</button></div>` : ''}
  <div class="grid kpis" id="icKpis"></div>
  <div class="grid cols2" style="margin-top:0">
    <div class="card">
      <div class="card-head"><div><h2>Where NESO traded${tip('icmap')}</h2><div class="sub" id="icMapNote"></div></div>
        <div class="controls"><label class="small muted">Show ${select('imap', IMAP, mapBy)}</label></div></div>
      <div class="replay-bar" style="margin:4px 0 0">
        <button type="button" class="btn" id="icAll" title="Show totals for the whole selected range">Whole range</button>
        <button type="button" class="btn" id="icBack" title="Previous period">‹</button>
        <button type="button" class="btn primary" id="icPlay" title="Step through the selected range one period at a time">Play</button>
        <button type="button" class="btn" id="icFwd" title="Next period">›</button>
        <b id="icWhen" style="font-variant-numeric:tabular-nums"></b>
        <button type="button" class="btn small" id="icZoom" hidden>Zoom in</button>
      </div>
      <input type="range" class="rp-slider" id="icSlider" min="0" max="0" value="0" aria-label="Period shown on the map, in the table and in the price details">
      <div class="chart" id="icMap" style="height:520px"></div>
      <div id="icKey" class="small muted" style="display:flex;align-items:center;gap:14px;justify-content:center;flex-wrap:wrap"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2 id="icTableTitle">Interconnectors</h2><div class="sub">Click a link to show only its trades in the charts below.</div></div></div>
      <div id="icTable"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2 id="icHeatTitle">Day × settlement period</h2><div class="sub" id="icHeatNote"></div></div>
      <div class="controls"><label class="small muted">Colour by ${select('iheat', IHEAT, heatBy)}</label></div></div>
    <div class="chart tall" id="icHeat"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2 id="icWhoTitle">Who set the price</h2><div class="sub" id="icWhoNote"></div></div>
      <div class="controls"><label class="small muted">Trades ${select('ipdir', [['buy', 'NESO bought'], ['sell', 'NESO sold']], pdir)}${tip('icclear')}</label></div></div>
    <div class="grid cols2" style="margin-top:6px">
      <div class="chart tall" id="icLadder"></div>
      <div id="icWho"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head">
      <div><h2>${esc(IMETRICS[metric].label)} over time</h2><div class="sub" id="icTimeNote"></div></div>
      <div class="controls">
        <label class="small muted">Measure ${select('imetric', Object.entries(IMETRICS).map(([k, m]) => [k, m.label]), metric)}</label>
        <label class="small muted">Split by ${select('isplit', [['none', 'No split'], ...Object.entries(IDIM_LABEL)], split)}${tip('ictype')}</label>
        <button class="btn" id="icToggle">Table</button>
      </div>
    </div>
    <div class="chart tall" id="icTime"></div>
    <div id="icTimeTable" hidden></div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>Trade prices${tip('icclear')}</h2><div class="sub" id="icPriceNote"></div></div>
        <div class="controls"><label class="small muted">Trades ${select('ipdir2', [['buy', 'NESO bought'], ['sell', 'NESO sold']], pdir)}</label></div></div>
      <div class="chart tall" id="icPrice"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2 id="icPtTitle">Price details</h2><div class="sub" id="icPtNote"></div></div></div>
      <div id="icPriceTable"></div>
    </div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>Breakdown${tip('iccp')}</h2><div class="sub" id="icBdNote"></div></div>
        <div class="controls"><label class="small muted">By ${select('ibd', [['party', 'Counterparty'], ['ic', 'Interconnector'], ['kind', 'Trade type']], bd)}</label></div></div>
      <div class="chart tall" id="icBd"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Physical flow${tip('icflow')}</h2><div class="sub" id="icFlowNote"></div></div></div>
      <div class="chart tall" id="icFlow"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2>About this data</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      <b style="color:var(--ink)">Trades</b>: interconnectors do not take part in the Balancing Mechanism, so NESO balances across them with trades outside it, which Elexon publishes as Balancing Services Adjustment Data (BSAD). <i>Counterparty trades</i> buy or sell energy from a trader for delivery over one link (the trader's interconnector unit, such as IFG-DSKC1 for Danske Commodities on IFA, names the link). <i>SO-SO trades</i> are with the neighbouring system operator (RTE, Statnett, EirGrid, SONI) and are often published without a cost, so they count towards volumes but not prices. <i>SO-flagged</i> trades were for a system reason (for example a constraint) rather than the national energy balance.<br>
      <b style="color:var(--ink)">Prices</b>: each trade has its own price (pay as bid). The volume-weighted average is cost ÷ volume; highest and lowest are single trades; the clearing price is the marginal trade in each half-hour (the dearest NESO bought, or the cheapest it sold), averaged over the half-hours with trades.${tip('icclear')}<br>
      <b style="color:var(--ink)">Flows</b> are Elexon's half-hourly outturn per interconnector (generation by fuel type), positive into GB. Landing points on the map are approximate and the lines schematic (outline: Natural Earth, public domain).
    </div>
    <div class="small muted" id="icMeta" style="margin-top:8px"></div>
    <button type="button" class="btn" id="conRefresh" style="margin-top:8px">Refresh data</button>
  </div>`;
  for (const k of ['imetric', 'isplit', 'ibd', 'imap', 'ipdir', 'iheat']) $('#' + k).onchange = (e) => update({ [k]: e.target.value }, true);
  $('#ipdir2').onchange = (e) => update({ ipdir: e.target.value }, true);
  $('#icClear')?.addEventListener('click', () => update({ ic: null, icp: null }));
  $('#icToggle').onclick = () => { const t = $('#icTimeTable'); t.hidden = !t.hidden; $('#icTime').hidden = !t.hidden; $('#icToggle').textContent = t.hidden ? 'Table' : 'Chart'; if (t.hidden) charts.get($('#icTime'))?.resize(); };
  const upd = IMETA.updated_at ? new Date(IMETA.updated_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('#icMeta').textContent = `Trades through ${IMETA.trades_through || 'n/a'} · flows through ${IMETA.flows_through || 'n/a'}${upd ? ` · refreshed ${upd}` : ''}${IMETA.error ? ` · some sources failed: ${IMETA.error}` : ''}`;
  wireConRefresh();

  // The time slots of the current granularity: the slider steps through them and a click on any time chart picks one.
  // Clearing prices per group come from ic/prices (they are averages of half-hourly maxima, so cannot be folded into
  // "Other"): keep the 8 groups that traded most in the chosen direction.
  const timeData = IMETRICS[metric].clear
    ? api('ic/prices', icParams({ bucket, group: split })).then((d) => {
      const vol = {};
      for (const r of d.rows) vol[r.g] = (vol[r.g] || 0) + Math.abs(n0(r[pdir + '_pvol']));
      const ranked = Object.keys(vol).filter((g) => vol[g]).sort((a, b) => vol[b] - vol[a]);
      return { rows: d.rows, groups: ranked.slice(0, 8), n_groups: ranked.length };
    })
    : api('ic/agg', icParams({ bucket, group: split, top: 8, rank: metric === 'volume' ? 'vol' : 'cash' }));
  const [agg, prices, flow, hh, perIc] = await Promise.all([
    timeData,
    api('ic/prices', icParams({ bucket, group: 'none' })),
    api('ic/flow', { from: state.from, to: state.to, bucket, ic: state.ic || '' }),
    days > 400 ? null : bucket === 'sp' ? null : api('ic/prices', icParams({ bucket: 'sp', group: 'none' })),
    days > 62 ? null : api('ic/prices', icParams({ bucket: 'sp', group: 'ic' })),
  ]);
  // Half-hourly prices for the grid and the peak clearing price (the period prices already are, when half-hourly).
  const half = days > 400 ? null : (hh || prices).rows;
  // Which link set each half-hour's clearing price (ties: every link at that price), for ranges up to two months.
  const setters = new Map();
  if (perIc) {
    const bestAt = new Map();
    for (const r of perIc.rows) {
      const v = r[pdir + '_clear'];
      if (v == null) continue;
      const b = bestAt.get(r.t);
      if (b == null || (pdir === 'buy' ? v > b : v < b)) { bestAt.set(r.t, v); setters.set(r.t, [r.g]); } else if (v === b) setters.get(r.t).push(r.g);
    }
  }
  const peak = half ? half.filter((r) => r[pdir + '_clear'] != null).sort((a, b) => (pdir === 'buy' ? b.buy_clear - a.buy_clear : a.sell_clear - b.sell_clear))[0] : null;
  const cats = bucket === 'none' ? [] : allBuckets(bucket, [...agg.rows, ...prices.rows, ...flow.rows]);
  const idx = new Map(cats.map((t, i) => [String(t), i]));
  let k = state.it != null && idx.has(String(state.it)) ? idx.get(String(state.it)) : null;
  const when = () => (k == null ? 'the whole range' : bucket === 'tod' ? `${spTime(cats[k])}, every day in the range` : bucketLabel(cats[k], bucket));
  const pick = (code) => drill({ ic: state.ic === code ? null : code });
  const mark = () => (k == null ? { data: [] } : { silent: true, symbol: 'none', lineStyle: { color: css('--ink2'), type: 'dashed', width: 1.5 }, label: { show: false }, data: [{ xAxis: k }] });

  // Map, links table, KPIs and price details follow the period (latest request wins, so Play never shows a stale step).
  let ticket = 0;
  const drawSel = async () => {
    const my = ++ticket;
    const at = k == null ? {} : { at: String(cats[k]), at_bucket: bucket };
    const [links, byIc, all, who] = await Promise.all([
      api('ic/links', icParams({ ic: '', ...at })),
      api('ic/prices', icParams({ ic: '', bucket: 'none', group: 'ic', ...at })),
      api('ic/prices', icParams({ bucket: 'none', group: 'none', ...at })),
      api('ic/trades', icParams({ dir: pdir, ...at })),
    ]);
    if (my !== ticket || !$('#icMap')?.isConnected) return;
    icKpis($('#icKpis'), links.rows, all.rows[0] || {}, when(), peak, pdir, bucket);
    const peakCard = $('#icPeak');
    if (peakCard && peak) peakCard.onclick = () => (bucket === 'sp' && idx.has(String(peak.t)) ? choose(idx.get(String(peak.t)))
      : drill({ from: peak.t.slice(0, 10), to: peak.t.slice(0, 10), bucket: 'auto', it: peak.t }));
    icWho($('#icLadder'), $('#icWho'), who.rows, all.rows[0] || {}, pdir, when());
    await icMap($('#icMap'), links.rows, mapBy, pick, when(), { prices: byIc.rows, who: who.rows, dir: pdir });
    $('#icTableTitle').textContent = `Interconnectors, ${when()}`;
    icTable($('#icTable'), links.rows, pick);
    icPriceTable($('#icPriceTable'), byIc.rows, all.rows[0], pdir, when());
  };
  const markAll = () => { for (const id of ['#icTime', '#icPrice', '#icFlow', '#icHeat']) { if (id === '#icHeat' && !$(id).dataset.bars) continue; const c = charts.get($(id)); if (c?.getOption()?.series?.length) c.setOption({ series: [{ markLine: mark() }] }); } };
  const slider = $('#icSlider');
  slider.max = String(Math.max(0, cats.length - 1));
  const go = (i, quiet = false) => {
    k = i == null ? null : Math.max(0, Math.min(cats.length - 1, i));
    slider.value = String(k ?? cats.length - 1);
    followTrail(() => { state.it = k == null ? null : String(cats[k]); });
    history.replaceState(null, '', stateHash());
    drawZoomTrail();
    $('#icWhen').textContent = k == null ? 'Whole range' : when();
    $('#icAll').classList.toggle('primary', k == null);
    $('#icZoom').hidden = k == null || ['sp', 'tod'].includes(bucket);
    markAll();
    if (!quiet) drawSel().catch((e) => console.error(e));
  };
  const pause = () => { clearInterval(icTimer); icTimer = null; $('#icPlay').textContent = 'Play'; $('#icPlay').classList.add('primary'); };
  const play = () => {
    if (k == null || k >= cats.length - 1) go(0); else go(k + 1);
    $('#icPlay').textContent = 'Pause';
    clearInterval(icTimer);
    icTimer = setInterval(() => {
      if (!$('#icMap')?.isConnected) { clearInterval(icTimer); icTimer = null; return; }
      if (k >= cats.length - 1) { pause(); return; }
      go(k + 1);
    }, cats.length > 200 ? 300 : cats.length > 60 ? 450 : 800);
  };
  const choose = (i) => { pause(); const j = k === i ? null : i; drill({ it: j == null ? null : String(cats[j]) }, { render: false }); go(j); };  // clicking the period already shown goes back to the whole range
  $('#icPlay').onclick = () => (icTimer ? pause() : play());
  $('#icBack').onclick = () => { pause(); go(k == null ? cats.length - 1 : k - 1); };
  $('#icFwd').onclick = () => { pause(); go(k == null ? 0 : k + 1); };
  $('#icAll').onclick = () => { pause(); go(null); };
  $('#icZoom').onclick = () => { if (k != null) icDrill(cats[k], bucket); };
  slider.oninput = () => { pause(); go(+slider.value, true); };
  slider.onchange = () => drawSel().catch((e) => console.error(e));
  for (const id of ['#icAll', '#icBack', '#icPlay', '#icFwd']) $(id).disabled = !cats.length;
  slider.hidden = !cats.length;

  icTime($('#icTime'), $('#icTimeTable'), agg, cats, bucket, metric, split, choose, mark);
  icPrices($('#icPrice'), prices.rows, cats, bucket, pdir, choose, mark);
  icFlow($('#icFlow'), flow.rows, cats, bucket, choose, mark);
  loading($('#icBd'), () => icBreakdown($('#icBd'), bd, metric));
  if (days > 400) $('#icHeat').innerHTML = '<div class="empty">Narrow the range to 400 days or fewer to see the half-hourly grid.</div>';
  else loading($('#icHeat'), () => icHeat($('#icHeat'), bucket, heatBy, pdir, half, setters, (t) => (idx.has(t) ? choose(idx.get(t)) : null), mark));
  go(k);
}

function icKpis(el, links, all, when, peak, dir, bucket) {
  const mine = state.ic ? links.filter((r) => r.ic === state.ic) : links;
  const sum = (k) => mine.reduce((a, r) => a + n0(r[k]), 0);
  const busiest = [...links].sort((a, b) => icGross(b) - icGross(a))[0];
  const flowMwh = sum('import_mwh') + sum('export_mwh'), hh = mine.length ? Math.max(...mine.map((r) => n0(r.n))) : 0;
  const a = all || {};
  el.innerHTML = [
    kpi(`Net trade cost, ${when}`, gbp(icNet(a)), `${nf(0).format(n0(a.n_trades))} trade records`, 'ic'),
    kpi('NESO bought', mwh(a.buy_vol), a.buy_pvol ? `${gbp(a.buy_cost)} @ ${price(ratio(a.buy_cost, a.buy_pvol))} average` : 'no priced trades', 'icprice'),
    kpi(`Clearing price${a.buy_hh > 1 ? ' (average)' : ''}`, price(a.buy_clear), a.buy_max != null ? `highest trade ${price(a.buy_max)}` : 'no priced purchases', 'icclear'),
    kpi('NESO sold', mwh(a.sell_vol), a.sell_pvol ? `${gbp(a.sell_cost)} @ ${price(ratio(a.sell_cost, a.sell_pvol))} average` : 'no priced trades', 'icprice'),
    state.ic ? kpi('Share of all interconnector trades', pct(ratio(sum('buy_vol') - sum('sell_vol'), links.reduce((s, r) => s + icGross(r), 0))), 'of traded volume, both directions')
      : kpi('Busiest interconnector', busiest && icGross(busiest) ? icName(busiest.ic) : '–', busiest && icGross(busiest) ? `${mwh(icGross(busiest))} traded · ${IC[busiest.ic]?.country || ''}` : 'no trades', 'icmap'),
    kpi(state.ic ? 'Average physical flow' : 'Net physical import', hh ? mwc(flowMwh / (hh / 2)) : '–', hh ? `${mwh(sum('import_mwh'))} in, ${mwh(-sum('export_mwh'))} out` : 'no flow data', 'icflow'),
  ].join('');
  // The range's peak half-hour (for the direction picked): click to show it.
  if (peak) {
    el.insertAdjacentHTML('afterbegin', kpi(dir === 'buy' ? 'Peak clearing price' : 'Lowest clearing price (sales)', price(peak[dir + '_clear']),
      `${bucketLabel(peak.t, 'sp')} · click to show it`, 'icclear').replace('class="card kpi"', `class="card kpi click" id="icPeak" title="Show ${esc(bucketLabel(peak.t, 'sp'))} on the map and in Who set the price${bucket === 'sp' ? '' : ' (zooms to that day)'}"`));
  }
}

/** NW Europe with each interconnector drawn from its GB landing point to the far end. */
async function icMap(el, links, by, onPick, when = 'the selected range', px = {}) {
  if (!NWE_MAP) { NWE_MAP = await (await fetch('/static/vendor/nweurope.json')).json(); echarts.registerMap('nwe', NWE_MAP); }
  const byIc = new Map(links.map((r) => [r.ic, r]));
  const pos = css('--div-pos'), neg = css('--div-neg'), mid = css('--other');
  const dir = px.dir || 'buy', clearBy = new Map((px.prices || []).map((r) => [r.g, r[dir + '_clear']]));
  // How many half-hours each link set the clearing price in (ties count for each link).
  const setBy = new Map();
  for (const w of px.who || []) setBy.set(w.ic, (setBy.get(w.ic) || 0) + n0(w.n_marginal));
  const val = (r) => (by === 'clear' ? clearBy.get(r.ic) ?? 0 : by === 'flow' ? (r.n ? (n0(r.import_mwh) + n0(r.export_mwh)) / (r.n / 2) : 0) : by === 'net' ? icNet(r) : icGross(r));
  // Direction of each link: into GB when NESO bought more than it sold (or, for flows, when it imported).
  const into = (r) => (by === 'clear' ? dir === 'buy' : by === 'flow' ? val(r) >= 0 : n0(r.buy_vol) + n0(r.sell_vol) >= 0);
  const hi = Math.max(1e-9, ...IC_ORDER.map((k) => Math.abs(val(byIc.get(k) || { ic: k }))));
  const fmt = by === 'clear' ? price : by === 'flow' ? mwc : by === 'net' ? gbp : mwh;
  const setter = by === 'clear' ? [...setBy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : null;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lines = [], ends = [];
  for (const k of IC_ORDER) {
    const L = IC[k], r = byIc.get(k) || { ic: k }, v = val(r), t = Math.abs(v) / hi, dim = state.ic && state.ic !== k;
    const active = Math.abs(v) > 0;
    const inward = into(r);
    const color = !active ? mid : by === 'clear' ? mix(css('--seq-lo'), css('--seq-hi'), 0.25 + 0.75 * t) : by === 'net' ? (v >= 0 ? pos : neg) : inward ? pos : neg;
    lines.push({ name: k, r, v, coords: inward ? [L.far, L.gb] : [L.gb, L.far],
      lineStyle: { color, width: active ? 2 + 9 * Math.sqrt(t) : 1.5, opacity: dim ? 0.25 : 0.9, curveness: L.bend, type: active ? 'solid' : 'dashed', cap: 'round' } });
    ends.push({ name: k, r, v, value: L.far, itemStyle: { color: css(L.col), opacity: dim ? 0.35 : 1 } },
      { name: k, r, v, value: L.gb, gb: true, itemStyle: { color: css('--ink2'), opacity: dim ? 0.35 : 1 } });
  }
  const top = new Set([...lines].filter((l) => Math.abs(l.v) > 0).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, by === 'clear' ? 10 : 5).map((l) => l.name));
  if (state.ic) top.add(state.ic);
  const label = by === 'clear' ? `Clearing price of energy NESO ${dir === 'buy' ? 'bought' : 'sold'}` : by === 'flow' ? 'Average physical flow' : by === 'net' ? 'Net trade cost' : 'Volume NESO traded (bought + sold)';
  $('#icMapNote').textContent = by === 'clear'
    ? `${label} on each link, ${when}. Darker and wider is ${dir === 'buy' ? 'dearer' : 'higher'}${setter ? `; ★ ${icName(setter)} set the clearing price${setBy.get(setter) > 1 ? ` most often (${setBy.get(setter)} half-hours)` : ''}` : ''}.`
    : `${label}, ${when}. Line width is the size; ${by === 'net' ? 'red: NESO paid, blue: NESO received' : 'arrows point the way the energy went'}.`;
  const sw = (c, t) => `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:18px;height:4px;border-radius:2px;background:${c}"></span>${esc(t)}</span>`;
  const lo = Math.min(hi, ...[...clearBy.values()].filter((v) => v != null));
  $('#icKey').innerHTML = by === 'clear' ? `<span>${esc(price(lo))}</span><span style="width:160px;height:10px;border-radius:2px;background:linear-gradient(90deg,${mix(css('--seq-lo'), css('--seq-hi'), 0.25)},${css('--seq-hi')})"></span><span>${esc(price(hi))}</span>` + sw(mid, 'No priced trades')
    : by === 'net' ? sw(pos, 'NESO paid (net)') + sw(neg, 'NESO received (net)') + sw(mid, 'No trades')
    : by === 'flow' ? sw(pos, 'Net import into GB') + sw(neg, 'Net export from GB') : sw(pos, 'NESO mostly bought (into GB)') + sw(neg, 'NESO mostly sold (out of GB)') + sw(mid, 'No trades');
  const tipFor = (r) => {
    const L = IC[r.ic];
    return tipLines(`${L.name} · ${L.country} · ${nf(0).format(L.mw)} MW`, [`${L.gbSite} ↔ ${L.farSite}`,
      `NESO bought ${mwh(r.buy_vol)}${r.buy_pvol ? ` @ ${price(ratio(r.buy_cost, r.buy_pvol))}` : ''}`,
      `NESO sold ${mwh(r.sell_vol)}${r.sell_pvol ? ` @ ${price(ratio(r.sell_cost, r.sell_pvol))}` : ''}`,
      `Net trade cost ${gbp(icNet(r))} · ${nf(0).format(n0(r.n_trades))} trade records`,
      clearBy.get(r.ic) != null ? `Clearing price (${dir === 'buy' ? 'bought' : 'sold'}) ${price(clearBy.get(r.ic))}${setBy.get(r.ic) ? ` · set the overall clearing price in ${setBy.get(r.ic)} half-hour${setBy.get(r.ic) === 1 ? '' : 's'}` : ''}` : '',
      r.n ? `Physical flow ${mwc((n0(r.import_mwh) + n0(r.export_mwh)) / (r.n / 2))} on average (${mwh(r.import_mwh)} in, ${mwh(-n0(r.export_mwh))} out)` : 'No flow data']);
  };
  const o = {
    animation: false,
    tooltip: { trigger: 'item', backgroundColor: css('--surface'), borderColor: css('--axis'), textStyle: { color: css('--ink') }, confine: true,
      formatter: (p) => (p.data?.r ? tipFor(p.data.r) + clickHint(state.ic === p.data.r.ic ? 'Click to show every interconnector again' : `Click to show only ${icName(p.data.r.ic)} below`) : '') },
    geo: { map: 'nwe', roam: false, silent: true, aspectScale: 0.6, boundingCoords: [[-10.5, 60.6], [11.5, 48.6]], top: 4, bottom: 4, left: 4, right: 4,
      itemStyle: { areaColor: css('--wash'), borderColor: css('--axis'), borderWidth: 0.6 },
      regions: [{ name: 'United Kingdom', itemStyle: { areaColor: css('--grid') } }] },
    series: [
      { type: 'lines', coordinateSystem: 'geo', data: lines, zlevel: 1, symbol: ['none', reduce ? 'arrow' : 'none'], symbolSize: 9,
        effect: { show: !reduce, period: 5, trailLength: 0, symbol: 'arrow', symbolSize: 7, color: css('--surface') },
        emphasis: { focus: 'self' } },
      { type: 'scatter', coordinateSystem: 'geo', data: ends, zlevel: 2, symbolSize: (v, p) => (p.data.gb ? 5 : 9),
        itemStyle: { borderColor: css('--surface'), borderWidth: 2 }, labelLayout: { hideOverlap: true },
        label: { show: true, position: 'right', fontSize: 11, color: css('--ink2'),
          formatter: (p) => (!p.data.gb ? `${p.name === setter ? '★ ' : ''}${icName(p.name)}${top.has(p.name) ? ` ${fmt(p.data.v)}` : ''}` : '') } },
    ],
  };
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => { if (p.data?.r) onPick(p.data.r.ic); });
}

const pound = (v) => (v == null || !isFinite(v) ? '–' : `${v < 0 ? '−' : ''}£${nf(0).format(Math.abs(v))}`);
function icTable(el, links, onPick) {
  const byIc = new Map(links.map((r) => [r.ic, r]));
  const rows = IC_ORDER.map((k) => {
    const r = byIc.get(k) || {};
    return { ic: k, name: icName(k), country: IC[k].country, buy: r.buy_vol ?? null, bp: ratio(r.buy_cost, r.buy_pvol), sell: r.sell_vol ?? null,
      sp: ratio(r.sell_cost, r.sell_pvol), net: r.buy_vol != null || r.sell_vol != null ? icNet(r) : null, parties: r.n_parties ?? null,
      flow: r.n ? (n0(r.import_mwh) + n0(r.export_mwh)) / (r.n / 2) : null };
  });
  table(el, [
    { key: 'name', label: 'Interconnector', html: (r) => `<span class="tag"><span class="dot" style="background:${css(IC[r.ic].col)}"></span>${esc(r.name)}</span> <span class="muted small">${esc(r.country)}</span>${state.ic === r.ic ? ' <b class="small">(selected)</b>' : ''}` },
    { key: 'buy', label: 'Bought', num: true, fmt: (v) => (v == null ? '–' : mwh(v)), tip: 'icprice' },
    { key: 'bp', label: '£/MWh', num: true, fmt: pound, cls: 'hide-sm' },
    { key: 'sell', label: 'Sold', num: true, fmt: (v) => (v == null ? '–' : mwh(v)) },
    { key: 'sp', label: '£/MWh', num: true, fmt: pound, cls: 'hide-sm' },
    { key: 'net', label: 'Net cost', num: true, fmt: (v) => (v == null ? '–' : gbp(v)) },
    { key: 'flow', label: 'Avg flow', num: true, fmt: mwc, tip: 'icflow' },
  ], rows, { onRow: (r) => onPick(r.ic), rowTip: (r) => `${IC[r.ic].gbSite} ↔ ${IC[r.ic].farSite} · ${r.parties ?? 0} counterparties. ${state.ic === r.ic ? 'Click to show every interconnector again' : `Click to show only ${r.name}'s trades below`}`, limit: 20 });
}

/** Stacked bars (or price lines) per time bucket, split by one dimension. A click shows that period on the map. */
function icTime(el, tableEl, data, cats, bucket, metric, split, onPick, mark) {
  const m = IMETRICS[metric];
  const idx = new Map(cats.map((t, i) => [String(t), i]));
  const groups = split === 'ic' ? [...data.groups].sort((a, b) => (IC_ORDER.indexOf(a) + 1 || 99) - (IC_ORDER.indexOf(b) + 1 || 99)) : data.groups;
  const byG = new Map(groups.map((g) => [g, new Array(cats.length).fill(null)]));
  for (const r of data.rows) if (byG.has(r.g) && idx.has(String(r.t))) byG.get(r.g)[idx.get(String(r.t))] = r;
  if (!cats.length) { el.innerHTML = '<div class="empty">Pick a granularity to see this over time.</div>'; charts.delete(el); tableEl.innerHTML = ''; return; }
  const o = baseOption();
  let series = [];
  if (m.line) {
    const dir = state.ipdir === 'sell' ? 'sell' : 'buy';
    const buyP = m.clear ? (r) => r.buy_clear : (r) => ratio(r.buy_cost, r.buy_pvol), sellP = m.clear ? (r) => r.sell_clear : (r) => ratio(r.sell_cost, r.sell_pvol);
    const groupP = split === 'direction' ? (r) => buyP(r) ?? sellP(r) : m.clear && dir === 'sell' ? sellP : buyP;
    const defs = split === 'none' ? [['NESO bought', buyP, css('--div-pos'), 'All'], ['NESO sold', sellP, css('--div-neg'), 'All']]
      : groups.map((g) => [icLabel(split, g), groupP, icColour(split, g), g]);
    series = defs.map(([name, f, color, g]) => ({ name, type: 'line', color, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: cats.length > 60 ? 0 : 6,
      connectNulls: false, data: (byG.get(g) || []).map((r) => (r ? f(r) : null)) }));
    $('#icTimeNote').textContent = m.help + (split !== 'none' && split !== 'direction' ? ` Showing the price of energy NESO ${m.clear && dir === 'sell' ? 'sold' : 'bought'}, per group${m.clear ? ' ("Trades" picks bought or sold)' : ''}.` : '')
      + (m.clear && data.n_groups > 8 ? ` The 8 of ${data.n_groups} groups that traded most are shown.` : '') + ' Click a period to show it on the map.';
  } else {
    const gap = cats.length <= 70;
    for (const g of groups) for (const part of m.parts) {
      series.push({ name: split === 'none' ? (part.tag ? `NESO ${part.tag}` : m.label) : icLabel(split, g), _tag: part.tag,
        type: 'bar', stack: 'a', barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%',
        color: split === 'none' ? (part.tag === 'sold' ? css('--div-neg') : part.tag ? css('--div-pos') : css('--s1')) : icColour(split, g),
        itemStyle: gap ? { borderColor: css('--surface'), borderWidth: 1 } : {}, emphasis: { disabled: true },
        data: byG.get(g).map((r) => (r ? part.f(r) || null : null)) });
    }
    $('#icTimeNote').textContent = m.help + (data.n_groups > 8 ? ` The 8 largest of ${data.n_groups} groups are shown; the rest are combined.` : '') + ' Click a period to show it on the map.';
  }
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', scale: !!m.line, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => m.fmt(v).replace(' MWh', '').replace('/MWh', '') } };
  o.legend.show = series.length > 1;
  // Volume split by a dimension: one legend entry per group (bought and sold bars share it).
  if (!m.line && split !== 'none' && m.parts.length > 1) o.legend.data = groups.map((g) => icLabel(split, g));
  o.tooltip.formatter = (ps) => {
    const items = ps.map((p) => ({ name: p.seriesName + (series[p.seriesIndex]._tag && split !== 'none' ? ` · ${series[p.seriesIndex]._tag}` : ''), value: p.value, color: p.color }));
    items.sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0));
    const total = m.line || m.parts.length > 1 ? null : items.reduce((s, i) => s + (i.value || 0), 0);
    return tipHtml(ps[0].axisValueLabel, items, m.fmt, total).replace('No accepted actions', 'No trades') + clickHint(icPickHint(ps[0].axisValueLabel, ps[0].dataIndex));
  };
  o.series = series;
  if (series.length) series[0].markLine = mark();
  icClickable(el, o, cats, onPick);
  const rows = cats.map((t, i) => ({ t: bucketLabel(t, bucket), ...Object.fromEntries(series.map((s, j) => ['s' + j, s.data[i]])) }))
    .filter((r) => series.some((_, j) => r['s' + j] != null));
  table(tableEl, [{ key: 't', label: bucket === 'tod' ? 'Time of day' : 'Period' },
    ...series.map((s, j) => ({ key: 's' + j, label: s.name + (s._tag && split !== 'none' ? ` · ${s._tag}` : ''), num: true, fmt: m.fmt }))], rows, { limit: 400 });
}

/** Hover hint for the time charts: what a click does to the period shown on the map. */
function icPickHint(label, i) {
  const cur = state.it != null && $('#icSlider') ? +$('#icSlider').value : null;
  return cur === i ? 'Click to go back to the whole range' : `Click to show ${label} on the map and in the price details`;
}

/** Draw a time chart and make a click anywhere in a period's column pick that period. */
function icClickable(el, o, cats, onPick) {
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {
    const x = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY])?.[0];
    if (x == null || x < 0 || x >= cats.length) return;
    onPick(x);
  });
}

/** Zoom the tab into one time bucket, within its own data range. */
function icDrill(t, bucket) {
  const d = String(t).slice(0, 10);
  const end = bucket === 'sp' || bucket === 'hour' || bucket === 'day' ? d : bucket === 'week' ? addDays(d, 6) : iso(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
  zoomTo({ from: d < IMETA.min ? IMETA.min : d, to: end > IMETA.max ? IMETA.max : end, bucket: 'auto', it: null });
}

const PRICE_LINES = [
  ['vwap', 'Volume-weighted average', '--s1', 'solid', (r, d) => ratio(r[d + '_cost'], r[d + '_pvol'])],
  ['clear', 'Clearing price (half-hourly marginal)', '--s2', 'solid', (r, d) => r[d + '_clear']],
  ['max', 'Highest trade', '--s4', 'dashed', (r, d) => r[d + '_max']],
  ['min', 'Lowest trade', '--s3', 'dashed', (r, d) => r[d + '_min']],
];

/** Trade prices over time for one direction: average, clearing, highest and lowest. One axis (£/MWh). */
function icPrices(el, rows, cats, bucket, dir, onPick, mark) {
  const idx = new Map(cats.map((t, i) => [String(t), i]));
  const at = new Array(cats.length).fill(null);
  for (const r of rows) if (idx.has(String(r.t))) at[idx.get(String(r.t))] = r;
  const word = dir === 'buy' ? 'bought' : 'sold';
  $('#icPriceNote').textContent = `Prices of energy NESO ${word}${state.ic ? ` on ${icName(state.ic)}` : ''}${state.icp ? ` with ${state.icp}` : ''}, per ${bucket === 'tod' ? 'time of day' : bucket === 'sp' ? 'half-hour' : bucket}. `
    + (dir === 'buy' ? 'Clearing price: the dearest trade in each half-hour, averaged.' : 'Clearing price: the cheapest sale in each half-hour, averaged.') + ' Click a period to show it on the map.';
  if (!cats.length || !rows.some((r) => r[dir + '_pvol'])) { el.innerHTML = `<div class="empty">No priced trades where NESO ${word} energy in this range.</div>`; charts.delete(el); return; }
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', scale: true, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => price(v).replace('/MWh', '') } };
  o.tooltip.formatter = (ps) => {
    const r = at[ps[0].dataIndex];
    const extra = r ? `<div class="tt"><div class="r"><span>${esc(mwh(r[dir + '_vol']))} ${word}${r[dir + '_hh'] ? ` in ${r[dir + '_hh']} half-hour${r[dir + '_hh'] === 1 ? '' : 's'}` : ''}</span></div></div>` : '';
    return tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), price).replace('No accepted actions', 'No priced trades')
      + extra + clickHint(icPickHint(ps[0].axisValueLabel, ps[0].dataIndex));
  };
  // At half-hour granularity the clearing price is the highest (or lowest) trade itself, so it is not drawn twice.
  const lines = PRICE_LINES.filter(([key]) => !(bucket === 'sp' && key === (dir === 'buy' ? 'max' : 'min')));
  o.series = lines.map(([, name, col, type, f]) => ({ name, type: 'line', color: css(col), symbol: 'circle', symbolSize: cats.length > 60 ? 0 : 5,
    connectNulls: false, lineStyle: { width: type === 'solid' ? 2 : 1.5, type }, data: at.map((r) => (r ? f(r, dir) : null)) }));
  o.series[0].markLine = mark();
  icClickable(el, o, cats, onPick);
}

/** Price details per link (and for all links) for the period shown on the map. */
function icPriceTable(el, rows, all, dir, when) {
  const word = dir === 'buy' ? 'bought' : 'sold';
  $('#icPtTitle').textContent = `Price details, ${when}`;
  $('#icPtNote').textContent = `Energy NESO ${word}, per interconnector. Follows the period on the map; switch direction with "Trades".`;
  const row = (r, name, code) => ({ code, name, vol: r?.[dir + '_vol'] ?? null, vwap: r ? ratio(r[dir + '_cost'], r[dir + '_pvol']) : null,
    clear: r?.[dir + '_clear'] ?? null, max: r?.[dir + '_max'] ?? null, min: r?.[dir + '_min'] ?? null, hh: r?.[dir + '_hh'] || null });
  const byIc = new Map(rows.map((r) => [r.g, r]));
  const data = [row(all, 'All interconnectors', null), ...IC_ORDER.filter((k) => byIc.get(k)?.[dir + '_vol']).map((k) => row(byIc.get(k), icName(k), k))];
  table(el, [
    { key: 'name', label: 'Interconnector', html: (r) => (r.code ? `<span class="tag"><span class="dot" style="background:${css(IC[r.code].col)}"></span>${esc(r.name)}</span>` : `<b>${esc(r.name)}</b>`) },
    { key: 'vol', label: word[0].toUpperCase() + word.slice(1), num: true, fmt: (v) => (v == null ? '–' : mwh(v)) },
    { key: 'vwap', label: 'Average', num: true, fmt: pound, tip: 'icprice' },
    { key: 'clear', label: 'Clearing', num: true, fmt: pound, tip: 'icclear' },
    { key: 'max', label: 'Highest', num: true, fmt: pound },
    { key: 'min', label: 'Lowest', num: true, fmt: pound },
    { key: 'hh', label: 'Half-hours', num: true, fmt: (v) => (v == null ? '–' : nf(0).format(v)), cls: 'hide-sm' },
  ], data, { onRow: (r) => r.code && drill({ ic: state.ic === r.code ? null : r.code }),
    rowTip: (r) => (r.code ? `${r.name}: prices in £/MWh. Click to show only ${r.name} in the charts` : 'All interconnectors together: prices in £/MWh'), limit: 20 });
  if (data.length === 1 && data[0].vol == null) el.insertAdjacentHTML('beforeend', `<div class="empty">NESO ${word} no energy over the interconnectors for ${esc(when)}.</div>`);
}

/** Ranked horizontal bars: who NESO traded with (or which link / trade type). Click to filter. */
async function icBreakdown(el, dim, metric) {
  const m = IMETRICS[metric];
  const data = await api('ic/agg', icParams({ bucket: 'none', group: dim, top: 400, rank: metric === 'volume' ? 'vol' : 'cash' }));
  const val = (r) => (m.line ? ratio(r.buy_cost, r.buy_pvol) ?? ratio(r.sell_cost, r.sell_pvol) : m.parts.length > 1 ? icGross(r) : icNet(r));
  const rows = data.rows.map((r) => ({ ...r, v: val(r) })).filter((r) => r.v != null).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 15).reverse();
  $('#icBdNote').textContent = `${data.rows.length} ${IDIM_LABEL[dim].toLowerCase()} value${data.rows.length === 1 ? '' : 's'} · top ${rows.length} by ${m.line ? 'price' : m.label.toLowerCase()} · click a bar to ${dim === 'kind' ? 'split the chart above by it' : 'filter to it'}`;
  if (!rows.length) { el.innerHTML = '<div class="empty">No trades in this range.</div>'; charts.delete(el); return; }
  const o = baseOption();
  const vol = !m.line && m.parts.length > 1;
  o.legend.show = vol;
  o.grid.top = vol ? 30 : 8;
  o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow', shadowStyle: { color: css('--wash') } }, formatter: (ps) => {
    const r = rows[ps[0].dataIndex];
    return tipLines(icLabel(dim, r.g), [`Net trade cost ${gbp(icNet(r))}`,
      `NESO bought ${mwh(r.buy_vol)}${r.buy_pvol ? ` @ ${price(ratio(r.buy_cost, r.buy_pvol))}` : ''}`,
      `NESO sold ${mwh(r.sell_vol)}${r.sell_pvol ? ` @ ${price(ratio(r.sell_cost, r.sell_pvol))}` : ''}`,
      `${nf(0).format(n0(r.n_trades))} trade records`]) +
      clickHint(dim === 'party' ? `Click to show only trades with ${r.g}` : dim === 'ic' ? `Click to show only ${icName(r.g)}` : 'Click to split the chart above by trade type');
  } };
  o.yAxis = { ...o.yAxis, type: 'category', data: rows.map((r) => icLabel(dim, r.g)), splitLine: { show: false },
    axisLabel: { color: css('--ink2'), fontSize: 12, width: el.clientWidth < 560 ? 105 : 170, overflow: 'truncate' } };
  o.xAxis = { ...o.xAxis, type: 'value', splitLine: { lineStyle: { color: css('--grid') } }, splitNumber: el.clientWidth < 560 ? 3 : 5,
    axisLabel: { color: css('--muted'), fontSize: 11, hideOverlap: true, formatter: (v) => m.fmt(v).replace(' MWh', '').replace('/MWh', '') } };
  const bar = { type: 'bar', barMaxWidth: 16, itemStyle: { borderRadius: 2 }, emphasis: { disabled: true } };
  o.series = vol
    ? [{ ...bar, name: 'NESO bought', stack: 'a', color: css('--div-pos'), data: rows.map((r) => r.buy_vol) },
       { ...bar, name: 'NESO sold', stack: 'a', color: css('--div-neg'), data: rows.map((r) => r.sell_vol) }]
    : [{ ...bar, name: m.label, color: css('--s1'), data: rows.map((r) => ({ value: r.v, itemStyle: dim === 'ic' && IC[r.g] ? { color: css(IC[r.g].col) } : {} })),
         label: { show: true, position: 'right', color: css('--ink2'), fontSize: 11, formatter: (p) => m.fmt(p.value) } }];
  if (!vol) o.grid.right = 70;
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {
    const p = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
    const r = rows[p?.[1]];
    if (!r) return;
    if (dim === 'party') drill({ icp: r.g });
    else if (dim === 'ic') drill({ ic: r.g });
    else update({ isplit: 'kind' }, true);
  });
}

/** Average physical flow per link, imports stacked above zero and exports below. One axis (MW). */
function icFlow(el, rows, cats, bucket, onPick, mark) {
  const idx = new Map(cats.map((t, i) => [String(t), i]));
  const present = new Set(rows.map((r) => r.g));
  const keys = IC_ORDER.filter((k) => present.has(k));
  $('#icFlowNote').textContent = `${state.ic ? icName(state.ic) : 'Every interconnector'}: average flow per ${bucket === 'tod' ? 'time of day' : bucket === 'sp' ? 'half-hour' : bucket} in MW. Above zero into GB, below zero out of GB.`;
  if (!keys.length || !cats.length) { el.innerHTML = '<div class="empty">No flow data for this range.</div>'; charts.delete(el); return; }
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => nf(0).format(v) } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), mwc,
    ps.reduce((s, p) => s + (p.value || 0), 0)).replace('No accepted actions', 'No flow').replace('>Total<', '>Net import<') + clickHint(icPickHint(ps[0].axisValueLabel, ps[0].dataIndex));
  const gap = cats.length <= 70;
  o.series = keys.map((k) => {
    const d = new Array(cats.length).fill(null);
    for (const r of rows) if (r.g === k && idx.has(String(r.t))) d[idx.get(String(r.t))] = r.flow_avg;
    return { name: icName(k), type: 'bar', stack: 'f', barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%', color: css(IC[k].col),
      itemStyle: gap ? { borderColor: css('--surface'), borderWidth: 1 } : {}, emphasis: { disabled: true }, data: d };
  });
  o.series[0].markLine = mark();
  o.legend.show = keys.length > 1;
  icClickable(el, o, cats, onPick);
}

/** Day x settlement period grid, coloured by the half-hour's clearing price, average price or net traded volume. A click
 *  shows that half-hour on the map: directly when the tab is already half-hourly, otherwise by zooming to the day first. */
async function icHeat(el, bucket, by, dir, half, setters, onSelect, mark) {
  const word = dir === 'buy' ? 'bought' : 'sold';
  const isPrice = by !== 'net';
  const rows = isPrice ? half : (await api('ic/agg', icParams({ bucket: 'sp', group: 'none' }))).rows;
  const val = by === 'clear' ? (r) => r[dir + '_clear'] : by === 'vwap' ? (r) => ratio(r[dir + '_cost'], r[dir + '_pvol']) : (r) => n0(r.buy_vol) + n0(r.sell_vol) || null;
  const who = (t) => (setters.get(t) || []).map(icName).join(' and ');
  delete el.dataset.bars;
  if (by === 'clear' && bucket === 'sp') return icClearBars(el, rows, dir, setters, onSelect, mark);
  $('#icHeatTitle').textContent = `${by === 'clear' ? 'Clearing price' : by === 'vwap' ? 'Average price' : 'Net traded volume'}, day × settlement period`;
  $('#icHeatNote').textContent = (isPrice ? `Energy NESO ${word}${state.ic ? ` on ${icName(state.ic)}` : ''}; darker is ${dir === 'buy' ? 'dearer' : 'higher'}, blank means no priced trades. `
    : 'Red: NESO bought (into GB); blue: NESO sold. ') + 'Click a half-hour to see who set the price and show it on the map.';
  const days = [];
  for (let d = state.from; d <= state.to; d = addDays(d, 1)) days.push(d);
  const di = new Map(days.map((d, i) => [d, i]));
  // The sp bucket is the settlement date plus 30 minutes per period, so the time of day gives the period back.
  const pts = rows.map((r) => [di.get(r.t.slice(0, 10)), (+r.t.slice(11, 13)) * 2 + (+r.t.slice(14, 16) >= 30 ? 1 : 0), val(r), r])
    .filter((p) => p[0] != null && p[2] != null);
  const vals = pts.map((p) => (isPrice ? p[2] : Math.abs(p[2]))).sort((a, b) => a - b);
  const q = (f) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(f * vals.length)))];
  const lo = isPrice ? q(0.02) ?? 0 : null, hi = isPrice ? q(0.98) ?? 1 : q(0.98) || 1;
  const key = (p) => new Date(Date.parse(days[p[0]] + 'T00:00:00Z') + p[1] * 1800000).toISOString().slice(0, 19);
  const o = baseOption();
  o.legend.show = false;
  o.grid = { left: 8, right: 16, top: 8, bottom: 44, containLabel: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
    const d = new Date(days[p.value[0]] + 'T00:00:00Z'), r = p.data.r;
    const title = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} · SP ${p.value[1] + 1} (${spTime(p.value[1] + 1)})`;
    const lines = isPrice ? [`Clearing price ${price(r[dir + '_clear'])}${who(r.t) ? `, set on ${who(r.t)}` : ''}`, `Average ${price(ratio(r[dir + '_cost'], r[dir + '_pvol']))} · lowest ${price(r[dir + '_min'])}`,
      `${mwh(r[dir + '_vol'])} ${word}`] : [`${p.value[2] >= 0 ? 'NESO bought (net)' : 'NESO sold (net)'} ${mwh(p.value[2])}`];
    return tipLines(title, lines) + clickHint(bucket === 'sp' ? 'Click to see who set the price in this half-hour' : 'Click to zoom to this day and see who set the price in this half-hour');
  } };
  o.xAxis = { ...o.xAxis, type: 'category', data: days.map((d) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`), splitArea: { show: false } };
  o.yAxis = { ...o.yAxis, type: 'category', data: Array.from({ length: 50 }, (_, i) => spTime(i + 1)), inverse: true,
    axisLabel: { ...o.yAxis.axisLabel, interval: 5 }, splitLine: { show: false }, max: 47 };
  o.visualMap = isPrice
    ? { type: 'continuous', orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160, min: lo, max: Math.max(hi, lo + 1), calculable: false, dimension: 2,
      text: [price(hi), price(lo)], textStyle: { color: css('--muted'), fontSize: 11 }, inRange: { color: [css('--seq-lo'), css('--seq-hi')] } }
    : { type: 'continuous', orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160, min: -hi, max: hi, calculable: false, dimension: 2,
      text: [`${mwh(hi)} bought`, `${mwh(hi)} sold`], textStyle: { color: css('--muted'), fontSize: 11 },
      inRange: { color: [css('--div-neg'), css('--div-mid'), css('--div-pos')] } };
  o.series = [{ type: 'heatmap', data: pts.map((p) => ({ value: p.slice(0, 3), r: p[3] })), progressive: 0,
    itemStyle: days.length <= 45 ? { borderColor: css('--surface'), borderWidth: 1 } : {},
    emphasis: { itemStyle: { borderColor: css('--ink'), borderWidth: 1 } } }];
  if (!pts.length) { el.innerHTML = `<div class="empty">No ${isPrice ? `priced trades where NESO ${word} energy` : 'trades'} in this range.</div>`; charts.delete(el); return; }
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => {
    const t = key(p.value);
    if (bucket === 'sp') onSelect(t);
    else drill({ from: days[p.value[0]], to: days[p.value[0]], bucket: 'auto', it: t });
  });
}

/** One or two days: the half-hourly clearing price as bars, each coloured by the link that set it. Click a bar to see who
 *  set the price in that half-hour. */
function icClearBars(el, rows, dir, setters, onSelect, mark) {
  const word = dir === 'buy' ? 'bought' : 'sold';
  $('#icHeatTitle').textContent = 'Clearing price per half-hour';
  $('#icHeatNote').textContent = `Energy NESO ${word}${state.ic ? ` on ${icName(state.ic)}` : ''}. Each bar is coloured by the interconnector that set the price. Click a half-hour to see who set it and show it on the map.`;
  const cats = allBuckets('sp', rows), idx = new Map(cats.map((t, i) => [String(t), i]));
  const at = new Array(cats.length).fill(null);
  for (const r of rows) if (idx.has(String(r.t)) && r[dir + '_clear'] != null) at[idx.get(String(r.t))] = r;
  if (!at.some(Boolean)) { el.innerHTML = `<div class="empty">No priced trades where NESO ${word} energy in this range.</div>`; charts.delete(el); return; }
  // One series per setting link so the legend names them; a tie is drawn in the first link's colour.
  const links = IC_ORDER.filter((k) => cats.some((t) => setters.get(String(t))?.[0] === k));
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, 'sp')) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => price(v).replace('/MWh', '') } };
  o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow', shadowStyle: { color: css('--wash') } }, formatter: (ps) => {
    const i = ps[0].dataIndex, r = at[i];
    if (!r) return tipLines(ps[0].axisValueLabel, ['No priced trades']);
    const ics = setters.get(String(cats[i])) || [];
    return tipLines(ps[0].axisValueLabel, [`Clearing price ${price(r[dir + '_clear'])}${ics.length ? `, set on ${ics.map(icName).join(' and ')}` : ''}`,
      `Average ${price(ratio(r[dir + '_cost'], r[dir + '_pvol']))} · ${dir === 'buy' ? 'lowest' : 'highest'} ${price(r[dir === 'buy' ? 'buy_min' : 'sell_max'])}`, `${mwh(r[dir + '_vol'])} ${word}`])
      + clickHint(icPickHint(ps[0].axisValueLabel, i));
  } };
  const gap = cats.length <= 70;
  o.series = links.map((k) => ({ name: icName(k), type: 'bar', stack: 'c', barMaxWidth: 22, color: css(IC[k].col), emphasis: { disabled: true },
    itemStyle: { borderRadius: [2, 2, 0, 0], ...(gap ? { borderColor: css('--surface'), borderWidth: 1 } : {}) },
    data: at.map((r, i) => (r && setters.get(String(cats[i]))?.[0] === k ? r[dir + '_clear'] : null)) }));
  if (!o.series.length) o.series = [{ name: 'Clearing price', type: 'bar', barMaxWidth: 22, color: css('--s1'), data: at.map((r) => r?.[dir + '_clear'] ?? null) }];
  o.legend.show = o.series.length > 1;
  o.series[0].markLine = mark();
  el.dataset.bars = '1';
  icClickable(el, o, cats, (i) => onSelect(String(cats[i])));
}

/** Who set the price in the period shown: priced trades per link x counterparty, as a ladder (dearest first when NESO
 *  bought, cheapest first when it sold) and a table. The marginal ones, which set a half-hour's clearing price, are marked. */
function icWho(chartEl, tableEl, rows, all, dir, when) {
  const word = dir === 'buy' ? 'bought' : 'sold';
  const best = dir === 'buy' ? 'price_max' : 'price_min';
  const hh = all[dir + '_hh'] || 0;
  $('#icWhoTitle').textContent = `Who set the price, ${when}`;
  const setters = rows.filter((r) => r.n_marginal > 0).sort((a, b) => b.n_marginal - a.n_marginal);
  const nameOf = (r) => `${icName(r.ic)} · ${r.party}`;
  if (!rows.length) {
    $('#icWhoNote').textContent = `NESO ${word} no energy at a published price for ${when}.`;
    chartEl.innerHTML = '<div class="empty">No priced trades.</div>'; charts.delete(chartEl); tableEl.innerHTML = '';
    return;
  }
  $('#icWhoNote').textContent = hh <= 1
    ? `Clearing price ${price(all[dir + '_clear'])}, set by ${setters.map((r) => `${r.party} on ${icName(r.ic)}`).join(' and ')}. Every trade NESO ${word}, ${dir === 'buy' ? 'dearest' : 'cheapest'} first.`
    : `${setters[0] ? `${setters[0].party} on ${icName(setters[0].ic)} set the clearing price most often: ${setters[0].n_marginal} of ${hh} half-hours. ` : ''}Each link and counterparty's ${dir === 'buy' ? 'dearest' : 'cheapest'} trade, ranked. Click a half-hour in the grid above to see one at a time.`;
  // Ladder: the 15 most extreme groups, the marginal end at the top.
  const top = rows.slice(0, 15).reverse();
  const o = baseOption();
  o.legend.show = false;
  o.grid = { left: 8, right: 70, top: 8, bottom: 8, containLabel: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', axisPointer: { type: 'none' }, formatter: (p) => {
    const r = top[p.dataIndex];
    return tipLines(nameOf(r), [`${r.kind} · ${r.so}`, `${dir === 'buy' ? 'Dearest' : 'Cheapest'} trade ${price(r[best])} · average ${price(ratio(r.cost, r.vol))}`,
      `${mwh(r.vol)} ${word} in ${r.n_hh} half-hour${r.n_hh === 1 ? '' : 's'}`,
      r.n_marginal ? `Set the clearing price in ${r.n_marginal} half-hour${r.n_marginal === 1 ? '' : 's'}` : 'Never the marginal trade']) + clickHint(`Click to show only trades with ${r.party}`);
  } };
  o.yAxis = { ...o.yAxis, type: 'category', data: top.map(nameOf), splitLine: { show: false },
    axisLabel: { color: css('--ink2'), fontSize: 11, width: chartEl.clientWidth < 560 ? 130 : 210, overflow: 'truncate' } };
  const vals = top.map((r) => r[best]);
  o.xAxis = { ...o.xAxis, type: 'value', scale: true, min: (v) => Math.min(0, v.min), splitLine: { lineStyle: { color: css('--grid') } }, splitNumber: 4,
    axisLabel: { color: css('--muted'), fontSize: 11, hideOverlap: true, formatter: (v) => price(v).replace('/MWh', '') } };
  o.series = [{ type: 'bar', barMaxWidth: 16, emphasis: { disabled: true },
    data: top.map((r, i) => ({ value: vals[i], itemStyle: { color: css(IC[r.ic]?.col || '--other'), borderRadius: 2, opacity: r.n_marginal ? 1 : 0.55 } })),
    label: { show: true, position: 'right', fontSize: 11, color: css('--ink2'), formatter: (p) => `${top[p.dataIndex].n_marginal ? '★ ' : ''}${price(p.value).replace('/MWh', '')}` } }];
  const c = chart(chartEl);
  c.setOption(o, true);
  chartEl.style.cursor = 'pointer';
  c.on('click', (p) => drill({ icp: top[p.dataIndex].party }));
  table(tableEl, [
    { key: 'ic', label: 'Interconnector', html: (r) => `<span class="tag"><span class="dot" style="background:${css(IC[r.ic]?.col || '--other')}"></span>${esc(icName(r.ic))}</span>` },
    { key: 'party', label: 'Counterparty', cls: 'wrap' },
    { key: best, label: dir === 'buy' ? 'Dearest' : 'Cheapest', num: true, fmt: pound, tip: 'icclear' },
    { key: 'avg', label: 'Average', num: true, fmt: pound },
    { key: 'vol', label: word[0].toUpperCase() + word.slice(1), num: true, fmt: mwh, cls: 'hide-sm' },
    { key: 'n_marginal', label: 'Set price', num: true, fmt: (v, r) => (v ? `★ ${v}${r.n_hh > 1 || hh > 1 ? ` of ${r.n_hh}` : ''}` : '–') },
    { key: 'so', label: 'Type', cls: 'hide-sm', fmt: (v, r) => `${r.kind === 'Counterparty trade' ? '' : 'SO-SO · '}${v === 'Energy' ? 'Energy' : 'System'}` },
  ], rows.map((r) => ({ ...r, avg: ratio(r.cost, r.vol) })), { onRow: (r) => drill({ icp: r.party }),
    rowTip: (r) => `${r.kind} · ${r.so} · ${r.n_hh} half-hour${r.n_hh === 1 ? '' : 's'} with trades. Click to show only trades with ${r.party}`, limit: 60 });
}

// ------------------------------------------------------------------ interconnector flow reversals (the 300 MW / 1,500 MW limit)
// From 20 May 2026 NESO may trade at most 1,500 MW per hour within day against the day-ahead direction across the continental
// links, and at most 300 MW on any one of them. /api/ic/reversals estimates the schedule as the flow without NESO's trades and
// checks each hour; see the comment above REV_LINKS in api.py.

const RVM = { over: 'Hours over the 300 MW link limit', flip: 'Hours NESO reversed the flow', against: 'Energy traded against the schedule' };
const RVT = [['over', 'Over the 300 MW link limit'], ['flip', 'Flow reversed'], ['all', 'Every hour traded against the schedule']];
const hourLabel = (d, h) => `${fmtDay(d)} ${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
const signedMw = (v) => (v == null ? '–' : `${mwc(Math.abs(v))} ${v >= 0 ? 'in' : 'out'}`);

async function viewReversals(main) {
  if (!IMETA.max) {
    main.innerHTML = `<div class="card"><h2>Interconnector flow reversals${tip('icrev')}</h2>
      <div class="empty">No interconnector data yet. <button type="button" class="btn" id="conRefresh">Download it</button> (a few minutes the first time; it is fetched with the Total costs data).</div></div>`;
    wireConRefresh();
    return;
  }
  const measure = RVM[state.rvm] ? state.rvm : 'over';
  const only = RVT.some(([k]) => k === state.rvt) ? state.rvt : 'over';
  const days = (parseDay(state.to) - parseDay(state.from)) / DAY + 1;
  const b0 = resolveBucket();
  const bucket = ['sp', 'hour'].includes(b0) ? (days <= 3 ? 'hour' : 'day') : b0 === 'tod' ? 'day' : b0;
  main.innerHTML = `
  <div class="card" style="margin-bottom:14px">
    <h2>When NESO turns the interconnectors round${tip('icrev')}</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      NESO buys and sells energy over the interconnectors to balance GB. Buy enough while a link is exporting and the flow reverses: GB imports instead.
      Since <b style="color:var(--ink)">20 May 2026</b>, NESO's trades <i>against</i> the day-ahead direction on the links to France, Belgium, the Netherlands and Denmark are limited to
      <b style="color:var(--ink)">300 MW per link</b> and <b style="color:var(--ink)">1,500 MW in total</b> in any hour. Trades in the same direction as the day-ahead flow are not limited.
      The day-ahead schedule is not published, so it is estimated as the flow without NESO's trades${tip('icrevest')}: treat the breaches below as <i>likely</i> rather than certain.
    </div>
  </div>
  <div class="grid kpis" id="rvKpis"></div>
  <div class="card">
    <div class="card-head"><div><h2>Trading against the schedule, day × hour${tip('icrevcap')}</h2><div class="sub" id="rvHeatNote"></div></div></div>
    <div class="chart tall" id="rvHeat"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2 id="rvDayTitle">One day, one link</h2><div class="sub" id="rvDayNote"></div></div>
      <div class="controls"><label class="small muted">Link <select id="rvic"></select></label></div></div>
    <div class="chart tall" id="rvDay"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>${esc(RVM[measure])}, by link</h2><div class="sub" id="rvTimeNote"></div></div>
      <div class="controls"><label class="small muted">Measure ${select('rvm', Object.entries(RVM), measure)}</label></div></div>
    <div class="chart" id="rvTime"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>The hours</h2><div class="sub" id="rvTableNote"></div></div>
      <div class="controls"><label class="small muted">Show ${select('rvt', RVT, only)}</label></div></div>
    <div id="rvTable"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2>How this is worked out</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      <b style="color:var(--ink)">The rule</b>: NESO market notice <i>Interconnector trading restrictions for NESO</i> (14 May 2026, NESO Data Portal): from 20 May 2026, within-day trading in the opposite direction to the day-ahead schedule is limited to 1,500 MW per hour across IFA, IFA2, ElecLink, Viking Link, BritNed and Nemo Link, with at most 300 MW on any one of them, as a short-term measure until the end of 2026. North Sea Link and the Irish links are not covered, so they show reversals but never breaches.<br>
      <b style="color:var(--ink)">Each hour, each link</b>: the metered flow (Elexon FUELHH, averaged over the hour's two half-hours) minus NESO's net trades on the link (Elexon BSAD, MWh over the hour = average MW) gives the flow without NESO, the estimated schedule. NESO <i>reversed</i> the flow when the two point opposite ways and both are at least 50 MW. A counterparty trade is <i>against the schedule</i> when it points the other way to the estimated schedule; SO-SO trades are agreed with the neighbouring operator, so they are not counted. A link is <i>over the limit</i> when its trades against the schedule exceed 300 MW (1 MW is allowed for rounding); an hour is over the total limit when they exceed 1,500 MW across the six links.<br>
      <b style="color:var(--ink)">Limits of the estimate</b>: the flow without NESO also contains the intraday market's own trades, so it is not exactly the day-ahead schedule; hours where it is under 50 MW either way are never counted. The hourly volumes match NESO's published interconnector auction results, and NESO's trades stop at exactly 300 MW on the links this method marks as running against the schedule, which supports it.
    </div>
  </div>`;
  for (const k of ['rvm', 'rvt']) $('#' + k).onchange = (e) => update({ [k]: e.target.value }, true);
  const data = await api('ic/reversals', { from: state.from, to: state.to, bucket });
  const rules = data.rules, s = data.summary;
  const before = state.to < rules.from;
  $('#rvKpis').innerHTML = [
    kpi('Hours NESO reversed a link', nf(0).format(s.flip_hours), `${nf(0).format(s.flip_link_hours)} link-hours, of ${nf(0).format(s.hours)} hours`, 'icrev'),
    kpi('Traded against the schedule', mwh(s.against_mwh), 'on the six continental links', 'icrevest'),
    kpi('Hours over 300 MW on a link', before ? 'n/a' : nf(0).format(s.over_hours), before ? 'the limit started on 20 May 2026'
      : `${nf(0).format(s.over_link_hours)} link-hours · worst ${mwc(s.max_link_against)}`, 'icrevcap'),
    kpi('Hours over 1,500 MW in total', before ? 'n/a' : nf(0).format(s.total_over_hours), before ? 'the limit started on 20 May 2026'
      : `of ${nf(0).format(s.restricted_hours)} hours under the limit · worst ${mwc(s.max_against)}`, 'icrevcap'),
  ].join('');

  // The day shown in detail: the one picked, else the day of the worst hour in range.
  const worst = [...data.hours].sort((a, b) => b.n_over - a.n_over || b.against - a.against || b.flips - a.flips)[0];
  const day = state.rvd && state.rvd >= state.from && state.rvd <= state.to ? state.rvd : worst?.d || state.to;
  const pickDay = (d, ic) => drill({ rvd: d, ...(ic ? { rvic: ic } : {}) });
  rvHeat($('#rvHeat'), data, day, pickDay);
  rvTime($('#rvTime'), data.series, bucket, measure);
  rvTable($('#rvTable'), data, only, pickDay);
  await loading($('#rvDay'), () => rvDay($('#rvDay'), day, worst));
}

/** Day x clock-hour grid coloured by the MW NESO traded against the schedule across the six links; a dot marks an hour
 *  with a link over 300 MW. Click a cell to show that day below. */
function rvHeat(el, data, day, onPick) {
  const rules = data.rules;
  const ds = [];
  for (let d = state.from; d <= state.to; d = addDays(d, 1)) ds.push(d);
  if (ds.length > 400) { el.innerHTML = '<div class="empty">Narrow the range to 400 days or fewer to see the hourly grid.</div>'; charts.delete(el); return; }
  const di = new Map(ds.map((d, i) => [d, i]));
  const pts = data.hours.filter((h) => di.has(h.d) && h.against > 0).map((h) => ({ value: [di.get(h.d), Math.min(h.hour, 23), h.against], h }));
  const dots = data.hours.filter((h) => di.has(h.d) && h.n_over).map((h) => ({ value: [di.get(h.d), Math.min(h.hour, 23)], h }));
  $('#rvHeatNote').textContent = `Each cell is one hour: the MW NESO traded against the estimated day-ahead direction across the six continental links. Darker red goes over the 1,500 MW total; a dot marks an hour with at least one link over 300 MW. The limit applies from ${fmtDay(rules.from)}. Click an hour to see that day below.`;
  if (!pts.length && !dots.length) { el.innerHTML = '<div class="empty">NESO did not trade against the schedule in this range.</div>'; charts.delete(el); return; }
  const o = baseOption();
  o.legend.show = false;
  o.grid = { left: 8, right: 16, top: 8, bottom: 48, containLabel: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
    const h = p.data.h;
    const lines = [`${mwc(h.against)} against the schedule${h.d >= rules.from ? (h.total_over ? ' (over the 1,500 MW total)' : ` of ${mwc(rules.total_cap)} allowed`) : ' (before the limit)'}`,
      h.n_over ? `${h.n_over} link${h.n_over === 1 ? '' : 's'} over 300 MW` : '', h.flips ? `${h.flips} link${h.flips === 1 ? '' : 's'} reversed` : '',
      h.links.length ? `Links: ${h.links.map(icName).join(', ')}` : ''];
    return tipLines(hourLabel(h.d, h.hour), lines) + clickHint('Click to see this day link by link');
  } };
  o.xAxis = { ...o.xAxis, type: 'category', data: ds.map((d) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`), splitArea: { show: false } };
  o.yAxis = { ...o.yAxis, type: 'category', data: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`), inverse: true,
    axisLabel: { ...o.yAxis.axisLabel, interval: 3 }, splitLine: { show: false } };
  o.visualMap = { type: 'piecewise', orient: 'horizontal', left: 'center', bottom: 0, dimension: 2, seriesIndex: 0, itemWidth: 14, itemHeight: 10,
    textStyle: { color: css('--muted'), fontSize: 11 },
    pieces: [{ min: 0, max: 300, label: 'up to 300 MW', color: css('--seq-lo') }, { min: 300, max: 1000, label: '300 MW–1 GW', color: css('--s4') },
      { min: 1000, max: rules.total_cap + 1, label: `1–${nf(1).format(rules.total_cap / 1000)} GW`, color: css('--s2') },
      { min: rules.total_cap + 1, label: `over ${nf(1).format(rules.total_cap / 1000)} GW`, color: css('--critical') }] };
  const start = di.get(rules.from), sel = di.get(day);
  o.series = [
    { type: 'heatmap', data: pts, progressive: 0, itemStyle: ds.length <= 45 ? { borderColor: css('--surface'), borderWidth: 1 } : {},
      emphasis: { itemStyle: { borderColor: css('--ink'), borderWidth: 1 } },
      markLine: { silent: true, symbol: 'none', label: { show: true, formatter: '{b}', color: css('--ink2'), fontSize: 11, position: 'insideEndTop' },
        data: [...(start != null && start > 0 ? [{ xAxis: start, name: 'Limit starts', lineStyle: { color: css('--ink2'), type: 'dashed' } }] : []),
          ...(sel != null ? [{ xAxis: sel, name: '', lineStyle: { color: css('--ink'), width: 1, type: 'dotted' } }] : [])] } },
    { type: 'scatter', data: dots, symbolSize: ds.length > 120 ? 3 : ds.length > 45 ? 4 : 6, itemStyle: { color: css('--ink') }, z: 3 },
  ];
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => {
    const h = p.data?.h;
    if (!h) return;
    const top = data.events.filter((e) => e.d === h.d && e.hour === h.hour).sort((a, b) => b.against - a.against)[0];
    onPick(h.d, top?.ic);
  });
}

/** One day for one link, hour by hour: the metered flow, the estimated schedule (flow without NESO) and NESO's trades,
 *  red where they ran against the schedule by more than 300 MW. */
async function rvDay(el, day, worst) {
  const d = await api('ic/reversals', { from: day, to: day, bucket: 'hour' });
  const rules = d.rules;
  const byIc = new Map();
  for (const r of d.detail) (byIc.get(r.ic) || byIc.set(r.ic, []).get(r.ic)).push(r);
  const score = (ic) => (byIc.get(ic) || []).reduce((a, r) => a + r.over * 1e6 + r.against + (r.flipped ? 1e3 : 0), 0);
  const links = IC_ORDER.filter((k) => byIc.has(k));
  const ic = state.rvic && byIc.has(state.rvic) ? state.rvic : [...links].sort((a, b) => score(b) - score(a))[0];
  const sel = $('#rvic');
  sel.innerHTML = links.map((k) => `<option value="${k}" ${k === ic ? 'selected' : ''}>${esc(icName(k))}${rules.links.includes(k) ? '' : ' (not limited)'}</option>`).join('');
  sel.onchange = (e) => update({ rvic: e.target.value, rvd: day }, true);
  if (!ic) { el.innerHTML = '<div class="empty">No flow data for this day.</div>'; charts.delete(el); return; }
  const rows = byIc.get(ic).sort((a, b) => a.hour - b.hour);
  const limited = rules.links.includes(ic) && day >= rules.from;
  const nOver = rows.filter((r) => r.over).length, nFlip = rows.filter((r) => r.flipped).length;
  $('#rvDayTitle').textContent = `${icName(ic)}, ${fmtDay(day)}`;
  $('#rvDayNote').textContent = `Solid line: what flowed. Dashed line: the flow without NESO's trades (the estimated schedule). Shaded: hours NESO reversed the flow. Bars: NESO's net trades, `
    + `grey with the schedule, amber against it${limited ? ', red over 300 MW against it' : ''}. Above zero is into GB. `
    + `${nFlip ? `NESO reversed the flow in ${nFlip} hour${nFlip === 1 ? '' : 's'}` : 'No reversals'}${limited ? `; ${nOver ? `${nOver} hour${nOver === 1 ? '' : 's'} over the 300 MW limit` : 'no hours over the limit'}` : rules.links.includes(ic) ? ' (before the limit started)' : ' (this link is not covered by the limit)'}.`;
  const cats = rows.map((r) => `${String(Math.min(r.hour, 23)).padStart(2, '0')}:00`);
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => `${nf(0).format(v)} MW` } };
  o.tooltip.formatter = (ps) => {
    const r = rows[ps[0].dataIndex];
    return tipLines(hourLabel(day, r.hour), [`Flowed: ${signedMw(r.flow)}`, `Without NESO (schedule): ${signedMw(r.pre)}`,
      `NESO net trades: ${r.neso >= 0 ? 'bought' : 'sold'} ${mwc(Math.abs(r.neso))}${r.cp !== r.neso ? ` (counterparty ${mwc(Math.abs(r.cp))})` : ''}`,
      r.against ? `Against the schedule: ${mwc(r.against)}${r.over ? ' (over the 300 MW limit)' : ''}` : 'With the schedule (not limited)',
      r.flipped ? 'NESO reversed the flow' : '']);
  };
  // NESO's trades as three overlapping bar series (one per colour) so each colour gets its own legend entry.
  const kind = (r) => (r.over ? 'over' : r.against ? 'against' : 'with');
  const tradeBars = (name, k, col) => ({ name, type: 'bar', color: col, barWidth: '55%', barMaxWidth: 26, barGap: '-100%',
    data: rows.map((r) => (kind(r) === k ? r.neso : null)) });
  const kinds = new Set(rows.filter((r) => r.neso).map(kind));
  const trades = [['NESO trades with the schedule', 'with', css('--other')], ['NESO trades against it', 'against', css('--s4')],
    ['Over 300 MW against', 'over', css('--critical')]].filter(([, k]) => kinds.has(k));
  o.series = [
    ...trades.map(([n, k, c]) => tradeBars(n, k, c)),
    { name: 'Flowed', type: 'line', step: 'middle', symbol: 'none', lineStyle: { width: 2.5 }, color: css(IC[ic]?.col || '--s1'), data: rows.map((r) => r.flow),
      markLine: limited ? { silent: true, symbol: 'none', lineStyle: { color: css('--critical'), type: 'dotted' }, label: { formatter: '{b}', position: 'insideEndTop', color: css('--muted'), fontSize: 10 },
        data: [{ yAxis: rules.link_cap, name: '+300 MW' }, { yAxis: -rules.link_cap, name: '−300 MW' }] } : undefined },
    { name: 'Without NESO (schedule)', type: 'line', step: 'middle', symbol: 'none', lineStyle: { width: 2, type: 'dashed' }, color: css('--ink2'), data: rows.map((r) => r.pre) },
  ];
  // Reversed hours: a pale full-height band behind the bars (a markArea has no width on a single category).
  const top = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.flow), Math.abs(r.pre), Math.abs(r.neso)])) * 1.05;
  const bandCol = 'rgba(237, 161, 0, 0.18)';
  const band = (sign) => ({ name: 'NESO reversed the flow', type: 'bar', silent: true, barWidth: '100%', barGap: '-100%', z: 0, tooltip: { show: false },
    color: bandCol, itemStyle: { color: bandCol }, data: rows.map((r) => (r.flipped ? sign * top : null)) });
  if (nFlip) o.series.unshift(band(1), band(-1));
  o.legend.data = [...trades.map(([n]) => n), 'Flowed', 'Without NESO (schedule)', ...(nFlip ? ['NESO reversed the flow'] : [])];
  chart(el).setOption(o, true);
}

/** Stacked bars per period, one colour per link: hours over 300 MW, hours reversed, or MWh traded against the schedule. */
function rvTime(el, series, bucket, measure) {
  const key = { over: 'over_hours', flip: 'flip_hours', against: 'against_mwh' }[measure];
  const fmt = measure === 'against' ? mwh : (v) => `${nf(0).format(v)} h`;
  const cats = allBuckets(bucket, series);
  const idx = new Map(cats.map((t, i) => [String(t), i]));
  const present = new Set(series.filter((r) => r[key]).map((r) => r.ic));
  const keys = IC_ORDER.filter((k) => present.has(k));
  $('#rvTimeNote').textContent = `Per ${bucket}${measure === 'over' ? ': link-hours over the 300 MW limit (from 20 May 2026)' : measure === 'flip' ? ': hours in which NESO\'s trades turned the link\'s flow round' : ': MWh of counterparty trades against the estimated schedule'}. Click a bar to zoom in.`;
  if (!keys.length) { el.innerHTML = '<div class="empty">Nothing to show for this range.</div>'; charts.delete(el); return; }
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', minInterval: measure === 'against' ? 0 : 1, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => (measure === 'against' ? mwh(v) : nf(0).format(v)) } };
  o.tooltip.formatter = (ps) => tipHtml(ps[0].axisValueLabel, ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })), fmt,
    ps.reduce((a, p) => a + (p.value || 0), 0)).replace('No accepted actions', 'None') + clickHint(drillHint(cats[ps[0].dataIndex], bucket));
  o.series = keys.map((k) => {
    const v = new Array(cats.length).fill(null);
    for (const r of series) if (r.ic === k && idx.has(String(r.t))) v[idx.get(String(r.t))] = r[key] || null;
    return { name: icName(k), type: 'bar', stack: 'a', barMaxWidth: 28, color: css(IC[k].col), emphasis: { disabled: true }, data: v };
  });
  o.legend.show = keys.length > 1;
  const c = chart(el);
  c.setOption(o, true);
  c.getZr().off('click');
  c.getZr().on('click', (e) => {
    const [i] = c.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
    if (i >= 0 && i < cats.length) drillTime(String(cats[i]), bucket);
  });
}

/** The hours behind it all, worst first; click one to show its day and link above. */
function rvTable(el, data, only, onPick) {
  const rows = data.events.filter((e) => (only === 'over' ? e.over : only === 'flip' ? e.flipped : e.against > 0))
    .map((e) => ({ ...e, when: `${e.d}T${String(e.hour).padStart(2, '0')}`, name: icName(e.ic) }));
  $('#rvTableNote').textContent = `${nf(0).format(rows.length)} link-hours${data.n_events > data.events.length ? ` among the worst ${nf(0).format(data.events.length)}` : ''}. The further the schedule is from zero, the surer the call. Click a row to see that day above.`;
  table(el, [
    { key: 'when', label: 'Hour', html: (r) => esc(hourLabel(r.d, r.hour)) },
    { key: 'name', label: 'Link', html: (r) => `<span class="tag"><span class="dot" style="background:${css(IC[r.ic]?.col || '--other')}"></span>${esc(r.name)}</span>` },
    { key: 'pre', label: 'Schedule (est.)', num: true, fmt: signedMw, tip: 'icrevest' },
    { key: 'cp', label: 'NESO traded', num: true, fmt: (v, r) => `${r.neso >= 0 ? 'bought' : 'sold'} ${mwc(Math.abs(r.neso))}` },
    { key: 'flow', label: 'Flowed', num: true, fmt: signedMw },
    { key: 'against', label: 'Against schedule', num: true, fmt: (v) => (v ? mwc(v) : '–'), tip: 'icrevcap' },
    { key: 'flipped', label: 'Reversed', fmt: (v) => (v ? 'yes' : '') },
    { key: 'over', label: 'Over 300 MW', html: (r) => (r.over ? '<b style="color:var(--critical)">yes</b>' : r.d < data.rules.from && r.against > data.rules.link_cap && data.rules.links.includes(r.ic) ? '<span class="muted small">before limit</span>' : '') },
  ], rows, { onRow: (r) => onPick(r.d, r.ic), rowTip: (r) => `Show ${r.name} on ${fmtDay(r.d)}`, limit: 300 });
}

// ------------------------------------------------------------------ Demand Flexibility Service

const DIR_LABEL = { Downwards: 'Turn down (use less)', Upwards: 'Turn up (use more)' };
const DFIXED = { direction: { Downwards: '--s1', Upwards: '--s2' }, tag: { Energy: '--s3', System: '--s7', 'Not stated': '--other' } };
const dColour = (dim, g) => (DFIXED[dim]?.[g] ? css(DFIXED[dim][g]) : colour('dfs_' + dim, g));
const dLabel = (dim, g) => (dim === 'direction' ? DIR_LABEL[g] || g : g);
const DSPLIT = { none: 'No split', direction: 'Direction', tag: 'Reason (energy or system)', party: 'Provider', zone: 'Zone' };
// `ev`: the measure needs the event half-hours (requirement, settlement), which have no provider or zone.
const DMETRICS = {
  proc: { label: 'Procured volume', fmt: mwh, f: (r) => r.proc_mwh,
    help: 'Volume NESO accepted from providers\' bids (MW held for each half-hour, as MWh).' },
  cost: { label: 'Accepted cost', fmt: gbp, f: (r) => r.cost,
    help: 'What NESO agreed to pay for the accepted bids (volume × each bid\'s price). Settlement later pays for what was delivered.' },
  price: { label: 'Average accepted price', fmt: price, line: true, f: (r) => ratio(r.cost, r.proc_mwh),
    help: 'Volume-weighted price of the accepted bids (accepted cost ÷ procured volume).' },
  fill: { label: 'Share of requirement procured', fmt: (v) => pct(v), line: true, ev: true, f: (r) => ratio(r.proc_mwh, r.req_mwh),
    help: 'Procured volume as a share of the volume NESO asked for. Requirements are often far larger than what providers offer.' },
  settled: { label: 'Delivered (settled) volume', fmt: mwh, ev: true, f: (r) => r.settled_mwh,
    help: 'Volume providers were found to have delivered once the event was settled, against what NESO procured. Settlement lags the event by weeks.' },
};
let DMETA = { min: null, max: null };

async function loadDMeta() { DMETA = await api('dfs/meta'); }

const dParams = (extra = {}) => ({ from: state.from, to: state.to, direction: state.ddir || '', tag: state.dtag || '', test: state.dtest ? 'true' : '', ...extra });
const evLabel = (e) => (/^\d+$/.test(e) ? `#${e}` : e);
const evWindow = (r) => `${spTime(r.sp_from)}–${spTime(r.sp_to + 1)}`;

// The 12 DFS zones, numbered north to south. NESO publishes the zones by number only; the area names are ours and approximate.
const DZONE = { 1: 'North Scotland', 2: 'Central Scotland', 3: 'South Scotland', 4: 'North East and Cumbria', 5: 'North West and North Wales',
  6: 'Pennines and Midlands', 7: 'East Yorkshire and Lincolnshire', 8: 'South Wales', 9: 'South West', 10: 'Central southern England',
  11: 'East of England', 12: 'London and South East' };
const zoneName = (z) => `Zone ${z}${DZONE[z] ? ` · ${DZONE[z]}` : ''}`;
const DZMAP = { proc: 'Procured volume', cost: 'Accepted cost', price: 'Average accepted price', clear: 'Highest accepted price',
  accept: 'Share of offered volume accepted', closed: 'Share of event half-hours closed' };
let DZ_MAP = null;

async function viewDfs(main) {
  if (!DMETA.max) {
    main.innerHTML = `<div class="card"><h2>Demand Flexibility Service${tip('dfs')}</h2>
      <div class="empty">No DFS data yet. <button type="button" class="btn" id="conRefresh">Download it</button> (fetched with the Total costs data).</div></div>`;
    wireConRefresh();
    return;
  }
  const metric = DMETRICS[state.dmetric] ? state.dmetric : 'proc';
  const m = DMETRICS[metric];
  let split = DSPLIT[state.dsplit] ? state.dsplit : 'none';
  const bySplitBids = split === 'party' || split === 'zone';
  const evOnly = m.ev && (bySplitBids || state.dp || state.dz);
  if (m.ev && bySplitBids) split = 'none';
  const bd = ['party', 'zone', 'unit'].includes(state.dbd) ? state.dbd : 'party';
  const zm = DZMAP[state.dzm] ? state.dzm : 'proc';
  const bucket = resolveBucket();
  const days = (parseDay(state.to) - parseDay(state.from)) / DAY + 1;
  const sel = [state.dp && `Provider: ${state.dp}`, state.dz && zoneName(state.dz), state.ddir && `Direction: ${DIR_LABEL[state.ddir] || state.ddir}`, state.dtag && `Reason: ${state.dtag}`].filter(Boolean);
  main.innerHTML = `
  ${sel.length ? `<div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="small muted">Showing</span>
    ${sel.map((s) => `<span class="chip"><span>${esc(s)}</span></span>`).join('')}<button type="button" class="btn small" id="dClear" title="Show every provider, zone, direction and reason again">Show all</button></div>` : ''}
  <div class="grid kpis" id="dKpis"></div>
  <div class="card">
    <div class="card-head">
      <div><h2>Clearing prices${tip('dfsclear')}</h2><div class="sub" id="dPxNote"></div></div>
      <div class="controls"><button class="btn" id="dPxToggle">Table</button></div>
    </div>
    <div class="chart tall" id="dPx"></div>
    <div id="dPxTable" hidden></div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>Bid prices${tip('dfsdist')}</h2><div class="sub" id="dDistNote"></div></div>
        <div class="controls"><label class="small muted">Band ${select('dbin', [['5', '£5'], ['10', '£10'], ['25', '£25'], ['50', '£50']], String(state.dbin || '10'))}</label>
          <label class="small muted">Direction <select id="dDistDir"></select></label></div></div>
      <div class="chart tall" id="dDist"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Clearing price against the market${tip('dfsmarket')}</h2><div class="sub" id="dScNote"></div></div></div>
      <div class="chart tall" id="dSc"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head">
      <div><h2>${esc(m.label)} over time${tip('dfs')}</h2><div class="sub" id="dTimeNote"></div></div>
      <div class="controls">
        <label class="small muted">Measure ${select('dmetric', Object.entries(DMETRICS).map(([k, v]) => [k, v.label]), metric)}</label>
        <label class="small muted">Split by ${select('dsplit', Object.entries(DSPLIT), split)}${tip('dfstag')}</label>
        <label class="small muted">Direction ${select('ddir', [['', 'Both'], ['Downwards', 'Turn down'], ['Upwards', 'Turn up']], state.ddir || '')}</label>
        <label class="small muted">Reason ${select('dtag', [['', 'Any'], ['Energy', 'Energy'], ['System', 'System'], ['Not stated', 'Not stated']], state.dtag || '')}</label>
        <label class="small muted"><input type="checkbox" id="dtest" ${state.dtest ? 'checked' : ''}> Test events${tip('dfstest')}</label>
        <button class="btn" id="dToggle">Table</button>
      </div>
    </div>
    <div class="chart tall" id="dTime"></div>
    <div id="dTimeTable" hidden></div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>Events</h2><div class="sub" id="dEvNote">Newest first. Click an event to see its bids and put it on the zone map.</div></div></div>
      <div id="dEvents"></div>
    </div>
    <div class="card" id="dStackCard">
      <div class="card-head"><div><h2>Bids in event <span id="dEvName"></span>${tip('dfsstack')}</h2><div class="sub" id="dStackNote"></div></div>
        <div class="controls"><label class="small muted">Half-hour <select id="dSp"></select></label></div></div>
      <div class="chart tall" id="dStack"></div>
    </div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>DFS zones${tip('dfszone')}</h2><div class="sub" id="dZoneNote"></div></div>
        <div class="controls"><label class="small muted">Show ${select('dzm', Object.entries(DZMAP), zm)}</label>
          <label class="small muted">For ${select('dzev', [['', 'Selected range'], ['1', 'Selected event']], state.dzev || '')}</label></div></div>
      <div class="chart" id="dZone" style="height:560px"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Providers${tip('dfsprov')}</h2><div class="sub" id="dBdNote"></div></div>
        <div class="controls"><label class="small muted">By ${select('dbd', [['party', 'Provider'], ['zone', 'Zone'], ['unit', 'DFS unit']], bd)}</label></div></div>
      <div class="chart" id="dBd" style="height:560px"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>When events ran</h2><div class="sub">Volume procured per half-hour, day × settlement period. Click a day to zoom to it.</div></div></div>
    <div class="chart tall" id="dHeat"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2>About this data</h2>
    <div class="small muted" style="line-height:1.55;margin-top:6px">
      <b style="color:var(--ink)">The service</b>: in a Demand Flexibility Service event NESO asks households and businesses, through registered providers (energy suppliers and aggregators), to shift their demand for set half-hours. <i>Turn-down</i> (Downwards) events ask them to use less at busy times; <i>turn-up</i> (Upwards) events, offered from April 2026, ask them to use more, for example when wind would otherwise be curtailed. NESO tags each event <i>Energy</i> (the national balance) or <i>System</i> (for example a network constraint). Providers bid a volume per DFS unit and half-hour at a price, and NESO accepts bids, cheapest first, up to its requirement.<br>
      <b style="color:var(--ink)">Prices</b>: accepted bids are paid their own price (pay-as-bid), and NESO takes bids in price order: in no half-hour was a rejected bid cheaper than the dearest accepted one. So the <i>clearing price</i> of a half-hour is its highest accepted bid, and the cheapest rejected bid marks where NESO stopped. Over several half-hours the clearing price is averaged weighted by the volume procured. The <i>market price</i> is Elexon's market index price (the APX half-hourly price) for the same half-hours. NESO also states a guaranteed acceptance price per event (bids at or below it are always taken); it is £0 for almost every event.<br>
      <b style="color:var(--ink)">Zones</b>: from April 2026 each DFS unit sits in one of 12 zones, and for each event half-hour NESO sets a cap per zone; a cap of 0 closes the zone to that event (often to avoid adding to a network constraint). Map: NESO's DFS 12-zone map (February 2026), simplified. NESO numbers the zones only; the area names are approximate.<br>
      <b style="color:var(--ink)">Source</b>: NESO Data Portal, <i>Demand Flexibility Service</i>: the utilisation report summary (one row per event half-hour), the utilisation report (one row per bid) and the service requirement (guaranteed price and zone caps), for the current year and the 2025/26 archive (from November 2024); Elexon <i>MID</i> for market prices. Volumes are MW held for a half-hour, shown as MWh. Accepted bids add up exactly to NESO's procured volume and cost per half-hour. Settled (delivered) volumes appear weeks later. The 2025/26 archive has no event numbers, types, reasons or zones: there was one turn-down event a day, so its events are named by date with the reason "Not stated". Provider names are tidied (upper case, without "Limited"), because NESO spells some differently from file to file.
    </div>
    <div class="small muted" id="dMeta" style="margin-top:8px"></div>
    <button type="button" class="btn" id="conRefresh" style="margin-top:8px">Refresh data</button>
  </div>`;
  for (const k of ['dmetric', 'dsplit', 'dbd', 'ddir', 'dtag', 'dzm', 'dzev', 'dbin']) $('#' + k).onchange = (e) => update({ [k]: e.target.value || null }, true);
  $('#dtest').onchange = (e) => update({ dtest: e.target.checked ? '1' : null }, true);
  $('#dClear')?.addEventListener('click', () => update({ dp: null, dz: null, ddir: null, dtag: null }));
  const toggle = (btn, ch, tb) => { $(btn).onclick = () => { const t = $(tb); t.hidden = !t.hidden; $(ch).hidden = !t.hidden; $(btn).textContent = t.hidden ? 'Table' : 'Chart'; if (t.hidden) charts.get($(ch))?.resize(); }; };
  toggle('#dToggle', '#dTime', '#dTimeTable');
  toggle('#dPxToggle', '#dPx', '#dPxTable');
  const upd = DMETA.updated_at ? new Date(DMETA.updated_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('#dMeta').textContent = `Events ${DMETA.min} to ${DMETA.max} (${nf(0).format(n0(DMETA.n_events))} live events) · settled through ${DMETA.settled_through || 'n/a'}${upd ? ` · refreshed ${upd}` : ''}${DMETA.error ? ` · some sources failed: ${DMETA.error}` : ''}`;
  wireConRefresh();

  const [events, prov, allEv] = await Promise.all([api('dfs/events', dParams({ party: state.dp || '', zone: state.dz || '' })),
    api('dfs/providers', dParams({ group: 'party', party: state.dp || '', zone: state.dz || '' })),
    state.dp || state.dz ? api('dfs/events', dParams()) : null]);
  dKpis($('#dKpis'), events.rows, prov.rows, (allEv || events).rows);
  const pickEv = (e) => drill({ dev: e, dzev: state.dzev || '1' }, { reveal: '#dStackCard' });
  dEvents($('#dEvents'), events.rows, pickEv);
  const ev = events.rows.find((r) => r.event === state.dev) || events.rows[0];
  if (ev) loading($('#dStack'), () => dStack($('#dStack'), ev));
  else { $('#dStack').innerHTML = '<div class="empty">No events in this range.</div>'; $('#dSp').disabled = true; }
  loading($('#dPx'), () => dPrices($('#dPx'), $('#dPxTable'), bucket));
  loading($('#dDist'), () => dDist($('#dDist'), (allEv || events).rows));
  loading($('#dSc'), () => dScatter($('#dSc'), (allEv || events).rows));
  loading($('#dTime'), () => dTime($('#dTime'), $('#dTimeTable'), bucket, metric, split, evOnly));
  loading($('#dZone'), () => dZoneMap($('#dZone'), zm, state.dzev ? ev : null));
  loading($('#dBd'), () => dBreakdown($('#dBd'), bd, metric));
  if (days > 400) $('#dHeat').innerHTML = '<div class="empty">Narrow the range to 400 days or fewer to see the half-hourly grid.</div>';
  else loading($('#dHeat'), () => dHeat($('#dHeat')));
}

/** `all`: every event in range, ignoring a provider or zone pick (prices are set by the whole stack). */
function dKpis(el, events, prov, all) {
  const sum = (k, rows = events) => rows.reduce((a, r) => a + n0(r[k]), 0);
  const down = events.filter((r) => r.direction === 'Downwards').length;
  const picked = state.dp || state.dz;
  const who = state.dp || (state.dz ? `zone ${state.dz}` : '');
  const proc = picked ? sum('party_mwh') : sum('proc_mwh'), cost = picked ? sum('party_cost') : sum('cost');
  const settledProc = sum('proc_settled_mwh'), settled = sum('settled_mwh');
  const nSettled = events.filter((r) => r.settled_mwh != null).length;
  const acc = prov.filter((r) => n0(r.n_accepted) > 0);
  const top = [...prov].sort((a, b) => n0(b.proc_mwh) - n0(a.proc_mwh))[0];
  // Clearing price for turn-down events (the bulk of the service), weighted by volume procured; against the market.
  const dn = all.filter((r) => r.direction === 'Downwards' && r.clr_avg != null);
  const w = dn.reduce((a, r) => a + n0(r.proc_mwh), 0);
  const clr = w ? dn.reduce((a, r) => a + r.clr_avg * n0(r.proc_mwh), 0) / w : null;
  const wm = dn.filter((r) => r.mip_w != null).reduce((a, r) => a + n0(r.proc_mwh), 0);
  const mkt = wm ? dn.filter((r) => r.mip_w != null).reduce((a, r) => a + r.mip_w * n0(r.proc_mwh), 0) / wm : null;
  el.innerHTML = [
    kpi(picked ? 'Events with its bids' : 'Events', nf(0).format(events.length), events.length ? `${down} turn-down, ${events.length - down} turn-up · ${nf(0).format(sum('n_hh'))} half-hours` : 'none in this range', 'dfs'),
    picked ? kpi(`Procured from ${who}`, mwh(proc), `${pct(ratio(proc, sum('proc_mwh')))} of all procured in those events`, 'dfsprov')
      : kpi('Procured', mwh(proc), sum('req_mwh') ? `${pct(ratio(proc, sum('req_mwh')))} of the ${mwh(sum('req_mwh'))} requested` : '', 'dfsfill'),
    kpi(picked ? 'Paid for accepted bids' : 'Accepted cost', gbp(cost), proc ? `@ ${price(ratio(cost, proc))} on average (pay-as-bid)` : 'no accepted bids'),
    kpi('Turn-down clearing price', clr != null ? price(clr) : '–', clr != null ? `${mkt != null ? `${clr >= mkt ? '+' : '−'}£${nf(0).format(Math.abs(clr - mkt))} vs market ${pound(mkt)} · ` : ''}range ${pound(Math.min(...dn.map((r) => r.clr_min)))} to ${pound(Math.max(...dn.map((r) => r.clr_max)))}` : 'no accepted turn-down bids', 'dfsclear'),
    kpi(picked ? 'Delivered in those events' : 'Delivered (settled)', settledProc ? pct(ratio(settled, settledProc)) : '–',
      settledProc ? `${picked ? 'all providers: ' : ''}${mwh(settled)} of ${mwh(settledProc)} procured · ${nSettled} of ${events.length} events settled` : 'no settled events in this range yet', 'dfssettled'),
    picked ? kpi('Bids accepted', pct(ratio(prov.reduce((a, r) => a + n0(r.n_accepted), 0), prov.reduce((a, r) => a + n0(r.n_bids), 0))), `${nf(0).format(prov.reduce((a, r) => a + n0(r.n_units), 0))} DFS units`, 'dfsstack')
      : kpi('Providers', nf(0).format(acc.length), top && top.proc_mwh ? `with accepted bids · largest ${top.g} (${pct(ratio(top.proc_mwh, proc))})` : `${prov.length} bid`, 'dfsprov'),
  ].join('');
}

function dEvents(el, rows, onPick) {
  const sel = (rows.find((r) => r.event === state.dev) || rows[0])?.event;
  const data = rows.map((r) => ({ ...r, when: `${r.date} ${r.sp_from}`, fill: ratio(r.proc_mwh, r.req_mwh), avg: ratio(r.cost, r.proc_mwh),
    del: ratio(r.settled_mwh, r.proc_settled_mwh), prem: r.clr_avg != null && r.mip_w != null ? r.clr_avg - r.mip_w : null }));
  table(el, [
    { key: 'when', label: 'Event', html: (r) => `<b>${esc(evLabel(r.event))}</b>${r.event === sel ? ' <span class="small">(shown)</span>' : ''}<div class="small muted">${esc(bucketLabel(r.date + 'T00:00:00', 'day'))} ${esc(evWindow(r))}</div>` },
    { key: 'direction', label: 'Type', html: (r) => `<span class="tag"><span class="dot" style="background:${dColour('direction', r.direction)}"></span>${r.direction === 'Upwards' ? 'Up' : 'Down'}</span><div class="small muted">${esc(r.tag || 'Not stated')}${r.live ? '' : ' · test'}</div>` },
    { key: 'proc_mwh', label: 'Procured', num: true, fmt: mwh },
    { key: 'fill', label: 'Of ask', num: true, fmt: pct, cls: 'hide-sm', tip: 'dfsfill' },
    { key: 'cost', label: 'Cost', num: true, fmt: gbp, cls: 'hide-sm' },
    { key: 'clr_max', label: 'Clearing', num: true, fmt: pound, tip: 'dfsclear' },
    { key: 'mip_avg', label: 'Market', num: true, fmt: pound, cls: 'hide-sm', tip: 'dfsmarket' },
    { key: 'prem', label: '+/−', num: true, fmt: (v) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}£${nf(0).format(Math.abs(v))}`), cls: 'hide-sm' },
    { key: 'del', label: 'Deliv.', num: true, fmt: pct, tip: 'dfssettled' },
  ], data, { onRow: (r) => onPick(r.event), limit: 200,
    rowTip: (r) => `Asked for ${mwc(r.req_mw)}. ${nf(0).format(n0(r.n_parties))} providers bid ${mwh(r.offered_mwh)} from ${nf(0).format(n0(r.n_units))} units; ${nf(0).format(n0(r.n_accepted))} of ${nf(0).format(n0(r.n_bids))} bids accepted. ` +
      `Clearing price ${pound(r.clr_min)} to ${pound(r.clr_max)} (volume-weighted ${pound(r.clr_avg)}); paid ${pound(ratio(r.cost, r.proc_mwh))} on average; cheapest rejected bid ${pound(r.rej_min)}. Click to see the bids.` });
}

/** One event's bids for one half-hour, cheapest first: each bar is a bid, as wide as its MW and as tall as its price. */
async function dStack(el, ev) {
  const data = await api('dfs/bids', { event: ev.event });
  $('#dEvName').textContent = evLabel(ev.event);
  const spSel = $('#dSp');
  const busiest = [...data.hh].sort((a, b) => n0(b.procured_mw) - n0(a.procured_mw))[0];
  let sp = busiest?.sp ?? data.hh[0]?.sp;
  spSel.innerHTML = data.hh.map((h) => `<option value="${h.sp}" ${h.sp === sp ? 'selected' : ''}>${spTime(h.sp)} (SP ${h.sp})</option>`).join('');
  spSel.disabled = false;
  const draw = () => {
    const hh = data.hh.find((h) => h.sp === sp) || {};
    const bids = data.bids.filter((b) => b.sp === sp).sort((a, b) => a.price - b.price || b.accepted - a.accepted);
    const closed = data.caps.filter((c) => c.sp === sp && c.cap_mw === 0).map((c) => c.zone);
    let x = 0;
    const items = bids.map((b) => { const r = { ...b, x0: x, x1: x + b.mw }; x += b.mw; return r; });
    const offered = x, acc = items.filter((b) => b.accepted).reduce((a, b) => a + b.mw, 0);
    $('#dStackNote').textContent = `${bucketLabel(ev.date + 'T00:00:00', 'day')} ${spTime(sp)}: ${DIR_LABEL[ev.direction] || ev.direction}, ${ev.tag || 'reason not stated'}. NESO asked for ${mwc(hh.req_mw)}; ${items.length} bids offered ${mwc(offered)}, ${mwc(acc)} accepted${hh.settled_mw != null ? `, ${mwc(hh.settled_mw)} delivered` : ''}. ` +
      `Clearing price ${hh.clr != null ? price(hh.clr) : 'none (no bid accepted)'}${hh.rej != null ? `; cheapest rejected ${price(hh.rej)}` : ''}; market ${price(hh.mip)}.` +
      (closed.length ? ` Zones closed: ${closed.join(', ')}.` : '') + (hh.gap ? ` Guaranteed acceptance price ${price(hh.gap)}.` : '');
    if (!items.length) { charts.get(el)?.clear(); el.innerHTML = '<div class="empty">No bids published for this half-hour.</div>'; charts.delete(el); return; }
    const accC = css('--s1'), rejC = css('--other');
    const o = baseOption();
    o.legend.show = false;
    o.grid.top = 16;
    o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
      const b = items[p.dataIndex];
      if (!b) return '';
      return tipLines(`${b.unit} · ${b.party}`, [`${mwc(b.mw)} at ${price(b.price)}`, b.zone != null ? zoneName(b.zone) : '', b.accepted ? 'Accepted' : 'Rejected']);
    } };
    const top = Math.max(...items.map((b) => b.price));
    o.xAxis = { ...o.xAxis, type: 'value', min: 0, max: Math.max(offered, hh.req_mw && hh.req_mw <= 3 * offered ? hh.req_mw : 0) || 1, name: 'MW offered, cheapest first', nameLocation: 'middle', nameGap: 26,
      nameTextStyle: { color: css('--muted'), fontSize: 11 }, axisLabel: { ...o.xAxis.axisLabel, formatter: (v) => nf(v < 10 ? 1 : 0).format(v) } };
    o.grid.bottom = 28;
    o.grid.right = 90;
    // Very dear bids (some are £10,000/MWh) would flatten the rest; cap the axis near the market and clearing prices.
    const ymax = Math.min(top, Math.max(2.5 * Math.max(n0(hh.clr), n0(hh.mip)), n0(hh.rej) * 1.15, 50));
    o.yAxis = { ...o.yAxis, type: 'value', max: Math.ceil(ymax / 50) * 50, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => `£${nf(0).format(v)}` } };
    const hl = (y, name, color, type) => ({ yAxis: y, name, lineStyle: { color, type, width: 1.5 }, label: { formatter: `${name} £${nf(0).format(y)}`, color, fontSize: 11, position: 'end' } });
    const lines = [hh.clr != null && hl(hh.clr, 'Clearing', css('--ink2'), 'solid'), hh.mip != null && hl(hh.mip, 'Market', css('--s2'), 'dashed')].filter(Boolean);
    o.series = [{ type: 'custom', data: items.map((b) => [b.x0, b.x1, Math.min(b.price, o.yAxis.max), b.accepted, b.party]),
      dimensions: ['x0', 'x1', 'price', 'accepted', { name: 'party', type: 'ordinal' }], encode: { x: [0, 1], y: 2 },
      renderItem: (params, api2) => {
        const p0 = api2.coord([api2.value(0), api2.value(2)]), p1 = api2.coord([api2.value(1), 0]);
        return { type: 'rect', shape: { x: p0[0], y: p0[1], width: Math.max(1, p1[0] - p0[0] - (items.length < 80 ? 1 : 0)), height: p1[1] - p0[1] },
          style: { fill: api2.value(3) ? accC : rejC, opacity: state.dp && api2.value(4) !== state.dp ? 0.35 : 1 } };
      },
      markLine: { symbol: 'none', silent: true, data: [...lines,
        ...(hh.req_mw && hh.req_mw <= 3 * offered ? [{ xAxis: hh.req_mw, lineStyle: { color: css('--ink2'), type: 'dotted' }, label: { formatter: 'Requirement', color: css('--ink2'), fontSize: 11 } }] : [])] } }];
    chart(el).setOption(o, true);
  };
  spSel.onchange = () => { sp = +spSel.value; draw(); };
  draw();
}

/** Clearing price per time bucket, by direction, against the market price for the same half-hours. Ignores a provider
 *  or zone pick: the clearing price is set by the whole stack. */
async function dPrices(el, tableEl, bucket) {
  const data = await api('dfs/agg', dParams({ bucket, group: 'direction', top: 8 }));
  const cats = allBuckets(bucket, data.rows), idx = new Map(cats.map((t, i) => [t, i]));
  const dirs = ['Downwards', 'Upwards'].filter((d) => data.groups.includes(d));
  const series = [];
  const byDir = {};
  for (const d of dirs) {
    const arr = new Array(cats.length).fill(null);
    for (const r of data.rows) if (r.g === d && idx.has(r.t)) arr[idx.get(r.t)] = r;
    byDir[d] = arr;
    const col = dColour('direction', d), short = d === 'Upwards' ? 'Turn up' : 'Turn down';
    const sym = cats.length > 60 ? 3 : 6;
    series.push({ name: `${short}: clearing price`, type: 'line', color: col, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: sym, connectNulls: false, data: arr.map((r) => r?.clr_avg ?? null), _d: d, _k: 'clr' });
    series.push({ name: `${short}: highest clearing`, type: 'scatter', color: col, symbol: 'triangle', symbolSize: sym + 2, itemStyle: { opacity: 0.55 }, data: arr.map((r) => (r && r.clr_max !== r.clr_avg ? r.clr_max : null)), _d: d, _k: 'max' });
    series.push({ name: `${short}: market price`, type: 'line', color: col, lineStyle: { width: 1.5, type: 'dashed' }, symbol: 'none', connectNulls: false, data: arr.map((r) => (r && r.n_cleared ? r.mip_w : r?.mip_avg ?? null)), _d: d, _k: 'mip' });
  }
  $('#dPxNote').textContent = 'Clearing price: the highest accepted bid in each half-hour, averaged over the bucket weighted by volume procured. Triangles: the highest clearing price in the bucket. Dashed: the market index price for the same half-hours. Accepted bids are paid their own price, so the average paid is lower than the clearing price.'
    + (state.dp || state.dz ? ' The provider or zone pick does not apply here: every bid sets the price.' : '');
  if (!dirs.length) { el.innerHTML = '<div class="empty">No events in this range.</div>'; charts.delete(el); return; }
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', scale: true, axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => `£${nf(0).format(v)}` } };
  o.tooltip.formatter = (ps) => {
    const i = ps[0].dataIndex;
    const lines = [];
    for (const d of dirs) {
      const r = byDir[d][i];
      if (!r) continue;
      const short = d === 'Upwards' ? 'Turn up' : 'Turn down';
      lines.push(r.n_cleared ? `${short}: clearing ${price(r.clr_avg)}${r.clr_max !== r.clr_min ? ` (${price(r.clr_min)} to ${price(r.clr_max)})` : ''} · paid ${price(ratio(r.cost, r.proc_mwh))} · market ${price(r.mip_w)}${r.rej_min != null ? ` · cheapest rejected ${price(r.rej_min)}` : ''}`
        : `${short}: no bid accepted${r.rej_min != null ? ` (cheapest bid ${price(r.rej_min)})` : ''} · market ${price(r.mip_avg)}`);
    }
    return tipLines(ps[0].axisValueLabel, lines.length ? lines : ['No event']) + clickHint(dDrillHint(cats[i], bucket));
  };
  o.series = series;
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = bucket === 'tod' ? 'default' : 'pointer';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {
    const p = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
    const t = cats[p?.[0]];
    if (t != null && bucket !== 'tod') dDrill(t, bucket);
  });
  const rows = [];
  cats.forEach((t, i) => { for (const d of dirs) { const r = byDir[d][i]; if (r) rows.push({ t: bucketLabel(t, bucket), d: d === 'Upwards' ? 'Turn up' : 'Turn down', clr: r.clr_avg, lo: r.clr_min, hi: r.clr_max, paid: ratio(r.cost, r.proc_mwh), rej: r.rej_min, mip: r.n_cleared ? r.mip_w : r.mip_avg, mwh: r.proc_mwh }); } });
  table(tableEl, [{ key: 't', label: bucket === 'tod' ? 'Time of day' : 'Period' }, { key: 'd', label: 'Direction' },
    { key: 'clr', label: 'Clearing (weighted)', num: true, fmt: price }, { key: 'lo', label: 'Lowest', num: true, fmt: pound, cls: 'hide-sm' }, { key: 'hi', label: 'Highest', num: true, fmt: pound },
    { key: 'paid', label: 'Paid (avg)', num: true, fmt: pound }, { key: 'rej', label: 'Cheapest rejected', num: true, fmt: pound, cls: 'hide-sm' },
    { key: 'mip', label: 'Market', num: true, fmt: pound }, { key: 'mwh', label: 'Procured', num: true, fmt: mwh, cls: 'hide-sm' }], rows, { limit: 400 });
}

/** Bid volume by price band, accepted and rejected, for one direction, with the clearing and market prices marked. */
async function dDist(el, events) {
  const binW = +(state.dbin || 10);
  const data = await api('dfs/prices', dParams({ party: state.dp || '', zone: state.dz || '', bin: binW }));
  const dirs = ['Downwards', 'Upwards'].filter((d) => data.rows.some((r) => r.direction === d));
  const dsel = $('#dDistDir');
  let dir = state.ddir && dirs.includes(state.ddir) ? state.ddir : dirs[0];
  dsel.innerHTML = dirs.map((d) => `<option value="${d}" ${d === dir ? 'selected' : ''}>${d === 'Upwards' ? 'Turn up' : 'Turn down'}</option>`).join('');
  dsel.disabled = dirs.length < 2;
  const draw = () => {
    const rows = data.rows.filter((r) => r.direction === dir);
    if (!rows.length) { el.innerHTML = '<div class="empty">No bids in this range.</div>'; charts.delete(el); $('#dDistNote').textContent = ''; return; }
    // Fold the long tail (bids up to £10,000/MWh) into one last band so the body of the curve stays readable.
    const ev = events.filter((r) => r.direction === dir && r.clr_avg != null);
    const w = ev.reduce((a, r) => a + n0(r.proc_mwh), 0);
    const clr = w ? ev.reduce((a, r) => a + r.clr_avg * n0(r.proc_mwh), 0) / w : null;
    const tot = rows.reduce((a, r) => a + r.acc_mwh + r.rej_mwh, 0);
    let cum = 0, cut = rows[rows.length - 1].p;
    for (const r of rows) { cum += r.acc_mwh + r.rej_mwh; if (cum >= 0.99 * tot) { cut = r.p; break; } }
    cut = Math.max(rows[0].p, Math.min(cut, Math.floor(Math.max(3 * n0(clr), 300) / binW) * binW));
    const bands = [];
    for (let p = rows[0].p; p <= cut; p += binW) bands.push({ p, acc: 0, rej: 0, na: 0, nr: 0, tail: false });
    for (const r of rows) {
      const b = r.p > cut ? bands[bands.length - 1] : bands[Math.round((r.p - rows[0].p) / binW)];
      if (r.p > cut) b.tail = true;
      b.acc += r.acc_mwh; b.rej += r.rej_mwh; b.na += r.n_acc; b.nr += r.n_rej;
    }
    const evm = ev.filter((r) => r.mip_w != null), wm = evm.reduce((a, r) => a + n0(r.proc_mwh), 0);
    const mkt = wm ? evm.reduce((a, r) => a + r.mip_w * n0(r.proc_mwh), 0) / wm : null;
    const label = (b) => `£${nf(0).format(b.p)}${b.tail ? '+' : ''}`;
    $('#dDistNote').textContent = `Volume offered in each £${binW} price band${state.dp ? ` by ${state.dp}` : state.dz ? ` in zone ${state.dz}` : ''}, accepted and rejected. Lines: average clearing price${clr != null ? ` ${price(clr)}` : ''} and market price${mkt != null ? ` ${price(mkt)}` : ''} for these events, weighted by volume procured.`;
    const o = baseOption();
    o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow', shadowStyle: { color: css('--wash') } }, formatter: (ps) => {
      const b = bands[ps[0].dataIndex];
      return tipLines(`${label(b)}${b.tail ? '' : ` to £${nf(0).format(b.p + binW)}`} per MWh`, [`Accepted ${mwh(b.acc)} (${nf(0).format(b.na)} bids)`, `Rejected ${mwh(b.rej)} (${nf(0).format(b.nr)} bids)`]);
    } };
    o.xAxis = { ...o.xAxis, type: 'category', data: bands.map(label), axisLabel: { ...o.xAxis.axisLabel, hideOverlap: true } };
    o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => mwh(v).replace(' MWh', '') } };
    const at = (v) => (v == null ? null : Math.max(0, Math.min(bands.length - 1, Math.floor((v - bands[0].p) / binW))));
    const ml = [clr != null && { xAxis: at(clr), name: 'Clearing', lineStyle: { color: css('--ink2'), type: 'solid' }, label: { formatter: `Clearing ${price(clr).replace('/MWh', '')}`, color: css('--ink2'), fontSize: 11 } },
      mkt != null && { xAxis: at(mkt), name: 'Market', lineStyle: { color: css('--s2'), type: 'dashed' }, label: { formatter: `Market ${price(mkt).replace('/MWh', '')}`, color: css('--s2'), fontSize: 11, position: 'end', distance: 18 } }].filter(Boolean);
    o.grid.top = 64;
    const bar = { type: 'bar', stack: 'a', barCategoryGap: '10%', emphasis: { disabled: true } };
    o.series = [{ ...bar, name: 'Accepted', color: css('--s1'), data: bands.map((b) => b.acc || null), markLine: { symbol: 'none', silent: true, data: ml } },
      { ...bar, name: 'Rejected', color: css('--other'), data: bands.map((b) => b.rej || null) }];
    chart(el).setOption(o, true);
  };
  dsel.onchange = () => { dir = dsel.value; draw(); };
  draw();
}

/** One dot per event: its volume-weighted clearing price against the market price in its half-hours. */
async function dScatter(el, events) {
  const pts = events.filter((r) => r.clr_avg != null && r.mip_w != null);
  const above = pts.filter((r) => r.clr_avg > r.mip_w).length;
  $('#dScNote').textContent = pts.length ? `Each dot is an event: its clearing price (volume-weighted) against the market price in the same half-hours. Above the line NESO paid more than the market; ${above} of ${pts.length} events cleared above it. Dot size: volume procured. Click a dot to see its bids.` : '';
  if (!pts.length) { el.innerHTML = '<div class="empty">No events with accepted bids in this range.</div>'; charts.delete(el); return; }
  const hi = Math.max(...pts.map((r) => Math.max(r.clr_avg, r.mip_w))), lo = Math.min(...pts.map((r) => Math.min(r.clr_avg, r.mip_w)));
  const maxV = Math.max(...pts.map((r) => n0(r.proc_mwh))) || 1;
  const o = baseOption();
  o.grid = { ...o.grid, bottom: 30, left: 12 };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
    const r = p.data.r;
    return tipLines(`${evLabel(r.event)} · ${bucketLabel(r.date + 'T00:00:00', 'day')} ${evWindow(r)}`, [`${DIR_LABEL[r.direction] || r.direction}, ${r.tag || 'reason not stated'}`,
      `Clearing ${price(r.clr_avg)} · market ${price(r.mip_w)}`, `Procured ${mwh(r.proc_mwh)} · paid ${price(ratio(r.cost, r.proc_mwh))} on average`]) + clickHint('Click to see this event\'s bids');
  } };
  const pad = (hi - lo) * 0.05 || 10;
  const ax = (name) => ({ type: 'value', min: Math.floor((lo - pad) / 10) * 10, max: Math.ceil((hi + pad) / 10) * 10, name, nameLocation: 'middle', nameGap: name.startsWith('Market') ? 24 : 44,
    nameTextStyle: { color: css('--muted'), fontSize: 11 }, axisLabel: { color: css('--muted'), fontSize: 11, formatter: (v) => `£${nf(0).format(v)}` }, splitLine: { lineStyle: { color: css('--grid') } }, axisLine: { show: false }, axisTick: { show: false } });
  o.xAxis = ax('Market price (£/MWh)');
  o.yAxis = ax('Clearing price (£/MWh)');
  o.legend.show = true;
  const dirs = ['Downwards', 'Upwards'].filter((d) => pts.some((r) => r.direction === d));
  o.series = dirs.map((d, i) => ({ name: d === 'Upwards' ? 'Turn up' : 'Turn down', type: 'scatter', color: dColour('direction', d),
    symbolSize: (v, p) => 5 + 16 * Math.sqrt(n0(p.data.r.proc_mwh) / maxV), itemStyle: { opacity: 0.75 },
    data: pts.filter((r) => r.direction === d).map((r) => ({ value: [r.mip_w, r.clr_avg], r })),
    ...(i === 0 ? { markLine: { symbol: 'none', silent: true, lineStyle: { color: css('--axis'), type: 'dashed' }, label: { show: false },
      data: [[{ coord: [o.xAxis.min, o.xAxis.min] }, { coord: [o.xAxis.max, o.xAxis.max] }]] } } : {}) }));
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => { if (p.data?.r) drill({ dev: p.data.r.event, dzev: state.dzev || '1' }, { reveal: '#dStackCard' }); });
}

/** The 12 DFS zones coloured by a measure over the range, or for the selected event (zones it was closed to in grey). */
async function dZoneMap(el, by, ev) {
  if (!DZ_MAP) { DZ_MAP = await (await fetch('/static/vendor/dfs_zones.json')).json(); echarts.registerMap('dfsz', DZ_MAP); }
  const data = await api('dfs/zones', ev ? { from: state.from, to: state.to, event: ev.event, party: state.dp || '' } : dParams({ party: state.dp || '' }));
  const byZ = new Map(data.rows.map((r) => [r.zone, r]));
  const VAL = { proc: (r) => r.proc_mwh, cost: (r) => r.cost, price: (r) => ratio(r.cost, r.proc_mwh), clear: (r) => r.price_max,
    accept: (r) => ratio(r.proc_mwh, r.offered_mwh), closed: (r) => ratio(r.n_closed, r.n_cap_hh) };
  const FMT = { proc: mwh, cost: gbp, price, clear: price, accept: pct, closed: pct };
  const fmt = FMT[by];
  const closedAll = (r) => r && r.n_cap_hh && r.n_closed === r.n_cap_hh;
  const vals = [];
  const series = [];
  for (let z = 1; z <= 12; z++) {
    const r = byZ.get(z);
    const v = r ? VAL[by](r) : null;
    if (ev && closedAll(r) && by !== 'closed') { series.push({ name: String(z), value: null, r, closed: true, itemStyle: { areaColor: css('--wash'), decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: css('--grid') } } }); continue; }
    if (v != null && isFinite(v)) vals.push(v);
    series.push({ name: String(z), value: v ?? null, r });
  }
  const lo = by === 'accept' || by === 'closed' ? 0 : Math.min(0, ...vals), hi = by === 'accept' || by === 'closed' ? 1 : Math.max(1e-9, ...vals);
  const nClosed = series.filter((s) => s.closed).length;
  $('#dZoneNote').textContent = (ev ? `Event ${evLabel(ev.event)}, ${bucketLabel(ev.date + 'T00:00:00', 'day')} ${evWindow(ev)} (${ev.direction === 'Upwards' ? 'turn up' : 'turn down'}, ${ev.tag || 'reason not stated'})${nClosed ? `: closed to ${nClosed} zone${nClosed === 1 ? '' : 's'} (hatched)` : ''}.`
    : `${DZMAP[by]} over the selected range.`) + (state.dp ? ` ${state.dp}'s bids only.` : '') + ' Zones exist from April 2026. Click a zone to show only its bids.';
  const tipFor = (z, r) => {
    if (!r) return tipLines(zoneName(z), ['No bids or caps in this selection']);
    return tipLines(zoneName(z), [
      r.n_bids ? `Offered ${mwh(r.offered_mwh)} in ${nf(0).format(r.n_bids)} bids from ${nf(0).format(n0(r.n_parties))} providers` : 'No bids',
      r.n_bids ? `Accepted ${mwh(r.proc_mwh)} (${pct(ratio(r.proc_mwh, r.offered_mwh))}) for ${gbp(r.cost)}` : '',
      r.proc_mwh ? `Paid ${price(ratio(r.cost, r.proc_mwh))} on average; accepted ${price(r.price_min)} to ${price(r.price_max)}` : '',
      r.rej_min != null ? `Cheapest rejected bid ${price(r.rej_min)}` : '',
      r.n_cap_hh ? (r.n_closed === r.n_cap_hh ? 'Closed (cap 0) in every half-hour' : `Closed in ${nf(0).format(r.n_closed)} of ${nf(0).format(r.n_cap_hh)} event half-hours${r.cap_max ? `; cap up to ${mwc(r.cap_max)}` : ''}`) : 'No zone caps published']);
  };
  const o = {
    animation: false,
    tooltip: { trigger: 'item', backgroundColor: css('--surface'), borderColor: css('--axis'), textStyle: { color: css('--ink') }, confine: true,
      formatter: (p) => tipFor(+p.name, p.data?.r) + clickHint(String(state.dz) === p.name ? 'Click to show every zone again' : `Click to show only zone ${p.name}'s bids`) },
    visualMap: { type: 'continuous', min: lo, max: hi, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160, calculable: false,
      text: [fmt(hi), fmt(lo)], textStyle: { color: css('--muted'), fontSize: 11 }, inRange: { color: [css('--seq-lo'), css('--seq-hi')] }, outOfRange: { color: css('--wash') }, seriesIndex: 0 },
    series: [{ type: 'map', map: 'dfsz', roam: false, aspectScale: 0.6, top: 8, bottom: 36, selectedMode: false, data: series,
      itemStyle: { borderColor: css('--surface'), borderWidth: 1, areaColor: css('--wash') },
      emphasis: { label: { show: true, color: css('--ink') }, itemStyle: { areaColor: null, borderColor: css('--ink'), borderWidth: 1.5 } },
      label: { show: true, fontSize: 11, color: css('--ink2'), formatter: (p) => `${p.name}${p.data?.closed ? '\nclosed' : ''}` },
      regions: state.dz ? [{ name: String(state.dz), itemStyle: { borderColor: css('--ink'), borderWidth: 2 } }] : [] }],
  };
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => drill({ dz: String(state.dz) === p.name ? null : p.name, dev: null }));
}

async function dTime(el, tableEl, bucket, metric, split, evOnly) {
  const m = DMETRICS[metric];
  const data = await api('dfs/agg', dParams({ bucket, group: split, top: 8, party: m.ev ? '' : state.dp || '', zone: m.ev ? '' : state.dz || '', rank: metric === 'cost' ? 'cash' : 'vol' }));
  const cats = allBuckets(bucket, data.rows), idx = new Map(cats.map((t, i) => [t, i]));
  const groups = split === 'direction' ? [...data.groups].sort() : data.groups;
  const byG = new Map(groups.map((g) => [g, new Array(cats.length).fill(null)]));
  for (const r of data.rows) if (byG.has(r.g) && idx.has(r.t)) byG.get(r.g)[idx.get(r.t)] = r;
  const o = baseOption();
  const gap = cats.length <= 70;
  const bar = (name, color, d, stack = 'a') => ({ name, type: 'bar', stack, barMaxWidth: 28, barCategoryGap: cats.length > 200 ? '0%' : '25%', color,
    itemStyle: gap ? { borderColor: css('--surface'), borderWidth: 1 } : {}, emphasis: { disabled: true }, data: d });
  let series;
  if (metric === 'settled' && split === 'none') {
    series = [bar('Procured (settled events)', css('--other'), byG.get('All').map((r) => r?.proc_settled_mwh ?? null), 'p'),
      bar('Delivered', css('--s1'), byG.get('All').map((r) => r?.settled_mwh ?? null), 'd')];
  } else if (m.line) {
    series = groups.map((g) => ({ name: split === 'none' ? m.label : dLabel(split, g), type: 'line', color: split === 'none' ? css('--s1') : dColour(split, g),
      lineStyle: { width: 2 }, symbol: 'circle', symbolSize: cats.length > 60 ? 3 : 6, connectNulls: false, data: byG.get(g).map((r) => (r ? m.f(r) ?? null : null)) }));
  } else {
    series = groups.map((g) => bar(split === 'none' ? m.label : dLabel(split, g), split === 'none' ? css('--s1') : dColour(split, g), byG.get(g).map((r) => (r ? m.f(r) || null : null))));
  }
  $('#dTimeNote').textContent = m.help + (evOnly ? ' Not available per provider or zone, so this shows every event.' : '')
    + (data.n_groups > 8 ? ` The 8 largest of ${data.n_groups} groups are shown; the rest are combined.` : '') + ' Buckets without an event are empty.';
  o.xAxis = { ...o.xAxis, type: 'category', data: cats.map((t) => bucketLabel(t, bucket)) };
  o.yAxis = { ...o.yAxis, type: 'value', axisLabel: { ...o.yAxis.axisLabel, formatter: (v) => m.fmt(v).replace(' MWh', '').replace('/MWh', '') } };
  o.legend.show = series.length > 1;
  o.tooltip.formatter = (ps) => {
    const items = ps.map((p) => ({ name: p.seriesName, value: p.value, color: p.color })).sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0));
    const stacked = !m.line && !(metric === 'settled' && split === 'none');
    return tipHtml(ps[0].axisValueLabel, items, m.fmt, stacked ? items.reduce((s, i) => s + (i.value || 0), 0) : null).replace('No accepted actions', 'No event') + clickHint(dDrillHint(cats[ps[0].dataIndex], bucket));
  };
  o.series = series;
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = bucket === 'tod' ? 'default' : 'pointer';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {
    const p = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
    const t = cats[p?.[0]];
    if (t != null && bucket !== 'tod') dDrill(t, bucket);
  });
  const rows = cats.map((t, i) => ({ t: bucketLabel(t, bucket), ...Object.fromEntries(series.map((s, j) => ['s' + j, s.data[i]])) }))
    .filter((r) => series.some((_, j) => r['s' + j] != null));
  table(tableEl, [{ key: 't', label: bucket === 'tod' ? 'Time of day' : 'Period' }, ...series.map((s, j) => ({ key: 's' + j, label: s.name, num: true, fmt: m.fmt }))], rows, { limit: 400 });
}

function dDrillHint(t, bucket) {
  if (bucket === 'tod' || t == null) return null;
  const d = String(t).slice(0, 10);
  if ((bucket === 'sp' || bucket === 'hour') && state.from === d && state.to === d) return null;
  return bucket === 'month' ? `Click to zoom to ${bucketLabel(t, 'month')}` : bucket === 'week' ? `Click to zoom to the week starting ${bucketLabel(d + 'T00:00:00', 'day')}`
    : `Click to zoom to ${bucketLabel(d + 'T00:00:00', 'day')}`;
}

function dDrill(t, bucket) {
  const d = String(t).slice(0, 10);
  const end = bucket === 'sp' || bucket === 'hour' || bucket === 'day' ? d : bucket === 'week' ? addDays(d, 6) : iso(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
  zoomTo({ from: d < DMETA.min ? DMETA.min : d, to: end > DMETA.max ? DMETA.max : end, bucket: 'auto', dev: null });
}

/** Ranked bars per provider, zone or unit: accepted and rejected volume (or cost, or price). Click a provider to filter. */
async function dBreakdown(el, dim, metric) {
  const data = await api('dfs/providers', dParams({ group: dim, party: dim === 'party' ? '' : state.dp || '', zone: dim === 'zone' ? '' : state.dz || '' }));
  const mode = metric === 'cost' ? 'cost' : metric === 'price' ? 'price' : 'vol';
  const val = (r) => (mode === 'cost' ? n0(r.cost) : mode === 'price' ? ratio(r.cost, r.proc_mwh) : n0(r.offered_mwh));
  const rows = data.rows.map((r) => ({ ...r, v: val(r) })).filter((r) => r.v).sort((a, b) => b.v - a.v).slice(0, 15).reverse();
  $('#dBdNote').textContent = `${data.rows.length} ${dim === 'party' ? 'providers' : dim === 'zone' ? 'zones' : 'DFS units'} bid in range · top ${rows.length} by ${mode === 'vol' ? 'volume offered' : mode === 'cost' ? 'accepted cost' : 'average accepted price'}${dim === 'party' ? ' · click a provider to show only its bids' : ''}`;
  if (!rows.length) { el.innerHTML = '<div class="empty">No bids in this range.</div>'; charts.delete(el); return; }
  const o = baseOption();
  const vol = mode === 'vol';
  o.legend.show = vol;
  o.grid.top = vol ? 30 : 8;
  o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow', shadowStyle: { color: css('--wash') } }, formatter: (ps) => {
    const r = rows[ps[0].dataIndex];
    return tipLines(r.g, [`Offered ${mwh(r.offered_mwh)} in ${nf(0).format(n0(r.n_bids))} bids across ${nf(0).format(n0(r.n_events))} events`,
      `Accepted ${mwh(r.proc_mwh)} (${pct(ratio(r.n_accepted, r.n_bids))} of bids)`,
      r.proc_mwh ? `Accepted cost ${gbp(r.cost)} @ ${price(ratio(r.cost, r.proc_mwh))} (${price(r.price_min)} to ${price(r.price_max)})` : '',
      dim === 'unit' ? r.party : `${nf(0).format(n0(r.n_units))} DFS units`]) + (dim === 'party' ? clickHint(state.dp === r.g ? 'Click to show every provider again' : `Click to show only ${r.g}`) : '');
  } };
  o.yAxis = { ...o.yAxis, type: 'category', data: rows.map((r) => r.g), splitLine: { show: false },
    axisLabel: { color: css('--ink2'), fontSize: 12, width: el.clientWidth < 560 ? 105 : 170, overflow: 'truncate' } };
  const fmt = mode === 'cost' ? gbp : mode === 'price' ? price : mwh;
  o.xAxis = { ...o.xAxis, type: 'value', splitLine: { lineStyle: { color: css('--grid') } }, splitNumber: el.clientWidth < 560 ? 3 : 5,
    axisLabel: { color: css('--muted'), fontSize: 11, hideOverlap: true, formatter: (v) => fmt(v).replace(' MWh', '').replace('/MWh', '') } };
  const bar = { type: 'bar', barMaxWidth: 16, itemStyle: { borderRadius: 2 }, emphasis: { disabled: true } };
  o.series = vol
    ? [{ ...bar, name: 'Accepted', stack: 'a', color: css('--s1'), data: rows.map((r) => n0(r.proc_mwh)) },
       { ...bar, name: 'Rejected', stack: 'a', color: css('--other'), data: rows.map((r) => n0(r.offered_mwh) - n0(r.proc_mwh)) }]
    : [{ ...bar, name: DMETRICS[metric].label, color: css('--s1'), data: rows.map((r) => r.v), label: { show: true, position: 'right', color: css('--ink2'), fontSize: 11, formatter: (p) => fmt(p.value) } }];
  if (!vol) o.grid.right = 80;
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = dim === 'party' ? 'pointer' : 'default';
  c.getZr().off('click');
  c.getZr().on('click', (ev) => {
    if (dim !== 'party') return;
    const p = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
    const r = rows[p?.[1]];
    if (r) drill({ dp: state.dp === r.g ? null : r.g, dev: null });
  });
}

async function dHeat(el) {
  const data = await api('dfs/agg', dParams({ bucket: 'sp', group: 'none', party: state.dp || '', zone: state.dz || '' }));
  const days = [];
  for (let d = state.from; d <= state.to; d = addDays(d, 1)) days.push(d);
  const di = new Map(days.map((d, i) => [d, i]));
  const pts = data.rows.map((r) => [di.get(r.t.slice(0, 10)), (+r.t.slice(11, 13)) * 2 + (+r.t.slice(14, 16) >= 30 ? 1 : 0), n0(r.proc_mwh)])
    .filter((p) => p[0] != null && p[2]);
  const vals = pts.map((p) => p[2]).sort((a, b) => a - b);
  const M = vals[Math.min(vals.length - 1, Math.floor(0.98 * vals.length))] || 1;
  const o = baseOption();
  o.legend.show = false;
  o.grid = { left: 8, right: 16, top: 8, bottom: 44, containLabel: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
    const d = new Date(days[p.value[0]] + 'T00:00:00Z');
    return tipHtml(`${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} · SP ${p.value[1] + 1} (${spTime(p.value[1] + 1)})`,
      [{ name: 'Procured', value: p.value[2], color: p.color }], mwh) + clickHint(`Click to zoom to ${bucketLabel(days[p.value[0]] + 'T00:00:00', 'day')}`);
  } };
  o.xAxis = { ...o.xAxis, type: 'category', data: days.map((d) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`), splitArea: { show: false } };
  o.yAxis = { ...o.yAxis, type: 'category', data: Array.from({ length: 50 }, (_, i) => spTime(i + 1)), inverse: true,
    axisLabel: { ...o.yAxis.axisLabel, interval: 5 }, splitLine: { show: false }, max: 47 };
  o.visualMap = { type: 'continuous', orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 160, min: 0, max: M, calculable: false, dimension: 2,
    text: [mwh(M), '0'], textStyle: { color: css('--muted'), fontSize: 11 }, inRange: { color: [css('--seq-lo'), css('--seq-hi')] } };
  o.series = [{ type: 'heatmap', data: pts, progressive: 0, itemStyle: days.length <= 45 ? { borderColor: css('--surface'), borderWidth: 1 } : {},
    emphasis: { itemStyle: { borderColor: css('--ink'), borderWidth: 1 } } }];
  const c = chart(el);
  c.setOption(o, true);
  el.style.cursor = 'pointer';
  c.on('click', (p) => { const d = days[p.value[0]]; drill({ from: d, to: d, bucket: 'auto', dev: null }); });
}

let pollTimer = null;
async function viewData(main) {
  const today = iso(new Date());
  const wasEmpty = !META.days.length;
  main.innerHTML = `
  <div class="card"><h2>Fetch data from Elexon</h2>
    <div class="sub">Downloads bid/offer volumes and cashflows (four whole-day requests per day), plus acceptance flags, system prices and BSAD. Individual acceptances are fetched live when you open a unit. Days already held are skipped unless they were fetched before the data settled.</div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:12px">
      <label class="small muted">From <input type="date" id="iFrom" value="${META.min ? addDays(META.min, -30) : addDays(today, -29)}"></label>
      <label class="small muted">To <input type="date" id="iTo" value="${today}"></label>
      <label class="small"><input type="checkbox" id="iForce"> Re-fetch days already held</label>
      <button class="btn primary" id="iGo">Fetch</button>
    </div>
    <div id="job" style="margin-top:10px"></div>
  </div>
  <div class="card" style="margin-top:14px"><h2>Coverage</h2><div class="sub" id="covNote"></div><div class="months" id="months"></div></div>
  <div class="small muted" id="buildInfo" style="margin-top:14px"></div>`;
  fetch('/api/version').then((r) => (r.ok ? r.json() : null)).then((v) => { if (v && $('#buildInfo')) $('#buildInfo').textContent = `App build: ${v.version}`; }).catch(() => {});
  const drawCoverage = () => {
    const held = new Set(META.days);
    $('#covNote').textContent = META.days.length ? `${META.days.length} settlement days held, ${META.min} to ${META.max}.` : 'No data yet.';
    if (!META.days.length) { $('#months').innerHTML = ''; return; }
    let html = '';
    const first = new Date(Date.UTC(+META.min.slice(0, 4), +META.min.slice(5, 7) - 1, 1));
    for (let m = new Date(Date.UTC(+META.max.slice(0, 4), +META.max.slice(5, 7) - 1, 1)); m >= first; m.setUTCMonth(m.getUTCMonth() - 1)) {
      const n = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
      let cells = '<div></div>'.repeat((m.getUTCDay() + 6) % 7), count = 0;
      for (let d = 1; d <= n; d++) {
        const k = iso(new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), d)));
        if (held.has(k)) count++;
        cells += `<div class="d ${held.has(k) ? 'held' : ''}" title="${k}${held.has(k) ? ' held' : ' missing'}">${d}</div>`;
      }
      html += `<div class="month"><b>${MON[m.getUTCMonth()]} ${m.getUTCFullYear()}</b> <span class="muted small">${count}/${n} days</span><div class="days">${cells}</div></div>`;
    }
    $('#months').innerHTML = html;
  };
  const drawJob = (j) => {
    if (!j.started_at) { $('#job').innerHTML = ''; return; }
    const pct = j.total ? Math.round(100 * j.done / j.total) : 100;
    $('#job').innerHTML = `<div class="progress"><div style="width:${pct}%"></div></div>
      <div class="small muted">${j.running ? 'Fetching' : 'Finished'} ${esc(j.start)} to ${esc(j.end)}: ${j.done}/${j.total} days, ${j.requests} requests, ${j.elapsed}s
      ${j.failed.length ? ` · ${j.failed.length} failed (${esc(j.error)})` : ''}${!j.total && !j.running ? ' · nothing to fetch, all days held' : ''}</div>`;
    $('#iGo').disabled = j.running;
  };
  const poll = async () => {
    clearTimeout(pollTimer);
    if (state.view !== 'data') return;
    const j = await (await fetch('/api/ingest')).json();
    drawJob(j);
    if (j.running || j.finished_at) { await loadMeta(); drawCoverage(); }
    if (wasEmpty && META.days.length && !j.running) { state.view = 'overview'; writeHash(); return; } // first download finished
    if (j.running) pollTimer = setTimeout(poll, 1500);
  };
  $('#iGo').onclick = async () => {
    const qs = new URLSearchParams({ start: $('#iFrom').value, end: $('#iTo').value, force: $('#iForce').checked ? '1' : '0' });
    const r = await fetch(`/api/ingest/start?${qs}`);
    if (!r.ok) { $('#job').innerHTML = `<div class="small" style="color:var(--critical)">${esc((await r.json()).detail)}</div>`; return; }
    poll();
  };
  drawCoverage();
  poll();
}


// ------------------------------------------------------------------ debug panel: CPU, heat and data while downloading
{
  const panel = document.createElement('div');
  panel.id = 'dbg'; panel.className = 'dbg'; panel.hidden = true;
  panel.innerHTML = `
    <div class="dbg-head"><b>Debug: CPU, heat and data</b><span class="spacer"></span>
      <button type="button" class="btn" id="dbgCopy">Copy log</button><button type="button" class="btn" id="dbgClose">Close</button></div>
    <div class="small muted" id="dbgNote">Loading…</div>
    <div class="dbg-tiles" id="dbgNow"></div>
    <div class="dbg-charts">
      <div><div class="small muted">App CPU (% of one core)</div><div class="chart dbgchart" id="dbgCpu"></div></div>
      <div><div class="small muted">Battery temperature (°C) and heat headroom (0 cool, 1 throttling)</div><div class="chart dbgchart" id="dbgTemp"></div></div>
      <div><div class="small muted">Phone power draw (W)</div><div class="chart dbgchart" id="dbgPower"></div></div>
      <div><div class="small muted">Downloaded (MB) and days finished</div><div class="chart dbgchart" id="dbgNet"></div></div>
    </div>
    <div class="small" id="dbgThreads"></div>`;
  document.body.append(panel);
  let timer = null, last = null;
  const f1 = (v, u = '') => (v == null || Number.isNaN(v) ? '–' : `${nf(1).format(v)}${u}`);
  const tile = (label, value, help = '') => `<div class="dbg-tile"><div class="small muted">${esc(label)}${tip(help)}</div><b>${esc(value)}</b></div>`;
  const hhmmss = (t) => new Date(t).toLocaleTimeString('en-GB');

  function line(el, h, series, extra = {}) {
    const o = baseOption();
    const recent = h.slice(-450);
    o.legend.show = false;
    o.grid = { left: 4, right: 10, top: 10, bottom: 4, containLabel: true };
    o.xAxis = { ...o.xAxis, type: 'category', data: recent.map((r) => hhmmss(r.t)), axisLabel: { color: css('--muted'), fontSize: 10, hideOverlap: true } };
    o.yAxis = extra.yAxis || { ...o.yAxis, type: 'value', scale: true };
    o.series = series.map(([name, key, color, area, yAxisIndex]) => ({ name, type: 'line', showSymbol: false, yAxisIndex: yAxisIndex || 0,
      lineStyle: { width: 1.6, color }, itemStyle: { color }, areaStyle: area ? { color, opacity: .12 } : undefined,
      data: recent.map((r) => (typeof key === 'function' ? key(r) : r[key]) ?? null) }));
    o.tooltip = { ...o.tooltip, valueFormatter: (v) => (v == null ? '–' : nf(2).format(v)) };
    chart(el).setOption(o, true);
  }

  function render(d) {
    last = d;
    const l = d.latest || {}, h = d.history || [];
    const cores = l.cores || 1;
    const note = [];
    if (l.charging) note.push('plugged in, so battery readings are skewed');
    if (l.cpu_mhz) note.push(`CPU MHz: ${l.cpu_mhz.map((m) => Math.round(m)).join(' / ')}`);
    if (l.zones) note.push(`Sensors: ${l.zones.map((z) => `${z.type} ${nf(1).format(z.c)}°C`).join(', ')}`);
    $('#dbgNote').textContent = note.join(' · ') || 'Updates every couple of seconds while this panel is open. Tap Copy log to share the readings.';
    $('#dbgNow').innerHTML = [
      tile('App CPU', l.cpu_pct == null ? '–' : `${nf(0).format(l.cpu_pct)}% (${f1(l.cpu_pct / cores, '%')} of ${cores} cores)`, 'dbgcpu'),
      tile('Thermal status', l.thermal_name || '–', 'dbgthermal'),
      tile('Thermal headroom', l.headroom == null ? 'n/a' : nf(2).format(l.headroom), 'dbgheadroom'),
      tile('Battery temp', l.batt_temp_c == null ? '–' : `${nf(1).format(l.batt_temp_c)} °C`, 'dbgtemp'),
      tile('Power draw', l.watts == null ? '–' : `${nf(2).format(l.watts)} W (${Math.round(Math.abs(l.batt_ma || 0))} mA)`, 'dbgpower'),
      tile('Downloaded', l.rx_mb == null ? '–' : `${nf(1).format(l.rx_mb)} MB`, 'dbgnet'),
      tile('Memory', `${Math.round(l.heap_used_mb || 0)} / ${Math.round(l.heap_max_mb || 0)} MB`),
      tile('Download', l.ingest_running ? `running ${l.ingest_done}/${l.ingest_total} days` : 'idle'),
    ].join('');
    line($('#dbgCpu'), h, [['CPU %', 'cpu_pct', css('--s1'), true]]);
    line($('#dbgTemp'), h, [['Battery °C', 'batt_temp_c', css('--s2'), false, 0], ['Headroom', 'headroom', css('--s7'), false, 1]], {
      yAxis: [{ ...baseOption().yAxis, type: 'value', scale: true }, { ...baseOption().yAxis, type: 'value', min: 0, max: 1.2, splitLine: { show: false } }] });
    line($('#dbgPower'), h, [['Watts', 'watts', css('--s4'), true]]);
    line($('#dbgNet'), h, [['MB', 'rx_mb', css('--s3'), true, 0], ['Days', 'ingest_done', css('--s5'), false, 1]], {
      yAxis: [{ ...baseOption().yAxis, type: 'value', scale: true }, { ...baseOption().yAxis, type: 'value', splitLine: { show: false } }] });
    const th = d.threads || [];
    $('#dbgThreads').innerHTML = th.length ? `<b>Busiest threads now:</b> ${th.map((t) => `${esc(t.name)} ${nf(0).format(t.cpu_pct)}%`).join(' · ')}` : '<span class="muted">No thread is using noticeable CPU right now.</span>';
  }

  async function poll() {
    clearTimeout(timer);
    if (panel.hidden) return;
    try {
      const r = await fetch('/api/debug');
      if (r.status === 404) { $('#dbgNote').textContent = 'Not available in this version: the debug panel only works in the Android app.'; return; }
      render(await r.json());
    } catch (e) { $('#dbgNote').textContent = `Couldn't read debug data: ${e.message}`; }
    timer = setTimeout(poll, 1500);
  }
  $('#dbgBtn').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) poll(); };
  $('#dbgClose').onclick = () => { panel.hidden = true; clearTimeout(timer); };
  $('#dbgCopy').onclick = async () => {
    if (!last) return;
    const l = last.latest || {};
    const head = `GB Balancing debug log. cores=${l.cores} thermal=${l.thermal_name} charging=${l.charging} interval=${last.interval_ms}ms`;
    const cols = ['time', 'cpu_pct', 'batt_temp_c', 'headroom', 'thermal_status', 'watts', 'batt_ma', 'rx_mb', 'heap_used_mb', 'ingest_running', 'ingest_done', 'ingest_total'];
    const rows = (last.history || []).map((r) => [hhmmss(r.t), ...cols.slice(1).map((c) => (r[c] == null ? '' : typeof r[c] === 'number' ? +r[c].toFixed(2) : r[c]))].join(','));
    const threads = (last.threads || []).map((t) => `${t.name} ${nf(0).format(t.cpu_pct)}%`).join('; ');
    const text = [head, `busiest threads now: ${threads || 'none'}`, cols.join(','), ...rows].join('\n');
    try { await navigator.clipboard.writeText(text); } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    $('#dbgNote').textContent = `Copied ${rows.length} readings. Paste them into the chat.`;
  };
}

// ------------------------------------------------------------------ shell

// While a download is running (started here or by the app on launch) show progress and refresh when it ends.
let watching = false;
async function watchIngest() {
  if (watching) return;
  watching = true;
  try {
    for (;;) {
      const j = await (await fetch('/api/ingest')).json();
      if (!j.running) break;
      $('#coverage').textContent = `Updating data… ${j.done}/${j.total} days`;
      await new Promise((r) => setTimeout(r, 2500));
    }
    const before = `${META.max}|${META.days.length}`;
    await loadMeta();
    if (before !== `${META.max}|${META.days.length}` && state.view !== 'data') render();
  } catch (e) { console.error(e); } finally { watching = false; }
}
setInterval(watchIngest, 5000);

async function loadMeta() {
  META = await api('meta');
  drawCoverage();
}

/** The header's "data held" note, for the data the current tab shows: each tab has its own source and coverage. */
function drawCoverage() {
  const el = $('#coverage');
  if (!el || watching && el.textContent.startsWith('Updating')) return;
  const span = (label, m, extra = '') => (m?.max ? `${label}: ${m.min} to ${m.max}${extra}` : `${label}: none held yet`);
  const v = state.view;
  const text = v === 'constraints' ? span('Boundary forecasts (NESO)', CMETA, CMETA.costs_through ? ` · costs to ${CMETA.costs_through}` : '')
    : v === 'remit' ? span('REMIT outages (Elexon)', RMETA, ' (incl. planned ahead)')
    : v === 'interconnectors' ? span('Interconnector trades (Elexon BSAD)', IMETA.trades_through ? { min: IMETA.min, max: IMETA.trades_through } : IMETA, IMETA.flows_through ? ` · flows to ${IMETA.flows_through}` : '')
    : v === 'dfs' ? span('DFS events (NESO)', DMETA)
    : v === 'costs' ? (costData?.through ? `Balancing costs (NESO, Elexon): to ${costData.through}` : 'Balancing costs (NESO, Elexon)')
    : META.days.length ? `BM data (Elexon): ${META.min} to ${META.max} (${META.days.length} days)` : 'No BM data held';
  el.textContent = text;
  el.title = 'What the current tab has data for. Each tab has its own source; the Data tab fetches more BM data, and Refresh data on the other tabs updates theirs.';
}

/** The date range the current tab has data for: the Constraints and REMIT tabs have their own, separate from the unit data. */
const extent = () => (state.view === 'constraints' ? CMETA : state.view === 'remit' ? RMETA : ['interconnectors', 'icrev'].includes(state.view) ? IMETA : state.view === 'dfs' ? DMETA : META);
const ownRange = () => ['constraints', 'remit', 'interconnectors', 'icrev', 'dfs'].includes(state.view);

function drawFilterBar() {
  const E = extent();
  const span = (n) => ({ from: n ? addDays(E.max, -(n - 1)) < E.min ? E.min : addDays(E.max, -(n - 1)) : E.min, to: E.max });
  const presets = [['1D', 1], ['7D', 7], ['30D', 30], ['90D', 90], ['1Y', 365], ['All', 0]];
  $('#presets').innerHTML = presets.map(([l, n]) => { const s = span(n); return `<button data-n="${n}" title="${n ? `Show the latest ${n === 1 ? 'day' : `${n} days`} of data` : 'Show all data held'}" class="${s.from === state.from && s.to === state.to ? 'on' : ''}">${l}</button>`; }).join('');
  $('#presets').querySelectorAll('button').forEach((b) => b.onclick = () => update({ ...span(+b.dataset.n), bucket: 'auto' }));
  for (const k of ['from', 'to']) { const i = $('#' + k); i.value = state[k]; i.min = E.min; i.max = E.max;
    i.onchange = () => { if (i.value) update({ [k]: i.value, ...(k === 'from' && i.value > state.to ? { to: i.value } : {}), ...(k === 'to' && i.value < state.from ? { from: i.value } : {}) }); }; }
  $('#bucket').value = state.bucket;
  $('#bucket').onchange = (e) => update({ bucket: e.target.value }, true);
  const chips = $('#chips');
  chips.innerHTML = '';
  chips.hidden = ownRange(); // unit filters do not apply to system-level constraint or REMIT data
  for (const [dim, vals] of Object.entries(state.filters)) for (const v of vals) {
    const c = document.createElement('span'); c.className = 'chip';
    c.innerHTML = `<span>${esc(DIM_LABEL[dim] || dim)}: <b></b></span><button aria-label="Remove filter">×</button>`;
    c.querySelector('b').textContent = v;
    c.querySelector('button').title = `Remove the ${DIM_LABEL[dim] || dim} filter (${v})`;
    c.querySelector('button').onclick = () => { const f = { ...state.filters }; f[dim] = f[dim].filter((x) => x !== v); if (!f[dim].length) delete f[dim]; update({ filters: f }); };
    chips.append(c);
  }
}

// ---------- Data sources footer ----------
// Every tab ends with where its numbers come from: a one-line summary, and a click-to-expand explanation.
const ELX = (code, label = code) => `<a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/${code}" target="_blank" rel="noopener">${label}</a>`;
const NESO_DP = (pkg, label) => `<a href="https://www.neso.energy/data-portal/${pkg}" target="_blank" rel="noopener">${label}</a>`;
const ELEXON_API = '<a href="https://bmrs.elexon.co.uk/api-documentation" target="_blank" rel="noopener">Elexon Insights Solution (BMRS) API</a>';
const BM_SOURCES = `
  <h3>Sources</h3>
  <ul>
    <li>${ELEXON_API}: indicative settlement volumes and cashflows per BM unit, settlement period, direction and bid-offer pair (whole-day <code>balancing/settlement/indicative</code> endpoints, the ${ELX('DISPTAV')} and ${ELX('EBOCF')} data).</li>
    <li>${ELX('BOALF')} acceptances: used to derive each unit-period's SO flag and acceptance count.</li>
    <li>${ELX('DISEBSP')} system prices: the imbalance price and net imbalance volume.</li>
    <li>${ELX('DISBSAD')}: balancing actions taken outside the BM (trades, non-BM reserve).</li>
    <li>Elexon BM unit reference data: names, lead parties and fuel types.</li>
  </ul>`;
const BM_NOTES = `
  <h3>How the figures are built</h3>
  <ul>
    <li>Net cost is offer cashflow plus bid cashflow (bid cashflow is negative when a unit pays NESO).</li>
    <li>Accepted volume takes the larger of Elexon's "Original" and "Tagged" series, because Original is zero for SO-flagged actions; it reconciles with the DISEBSP total accepted volume to within about 0.1%.</li>
    <li>The SO flag is approximate: a unit-period counts as flagged when any acceptance covering it carries the BOALF SO flag.</li>
    <li>Technology is Elexon's fuel type where given; batteries are inferred from the unit name, and anything else is "Other".</li>
    <li>Figures are indicative until Elexon's data settles: days fetched within 5 days of the settlement date are re-fetched later. Times are GB local (settlement) time.</li>
  </ul>
  <h3>Updating</h3>
  <p>The Data tab (or <code>bmdash ingest</code>) fetches more days; days already held and settled are skipped.</p>`;
const SHARED_REFRESH = '<h3>Updating</h3><p>Refreshed together with the Total costs data: the Refresh data button, <code>bmdash costs</code>, or the end of <code>bmdash ingest</code>.</p>';

const SOURCES = {
  overview: ['Elexon BMRS: BM settlement cashflows and volumes, BOALF acceptances, DISEBSP system prices, DISBSAD', BM_SOURCES + BM_NOTES],
  units: ['Elexon BMRS: BM settlement cashflows and volumes, BOALF acceptances, BM unit reference data', BM_SOURCES + BM_NOTES],
  unit: ['Elexon BMRS: BM settlement data, plus live PN, MEL/MIL, bid-offer prices and acceptances for the unit', `${BM_SOURCES}
    <h3>Unit day detail</h3>
    <ul>
      <li>Physical notifications and export/import limits (${ELX('PN')}, ${ELX('MELS')}, ${ELX('MILS')}) and the unit's bid-offer prices (${ELX('BOD')}) are fetched live from Elexon for the day shown, and cached once the day has settled.</li>
      <li>Acceptances (${ELX('BOALF')}) for the unit are fetched live too (not stored), and the instruction replay follows the newest-issued acceptance covering each moment, or the unit's own plan where none does. Checked against Elexon's settled volumes on 9 unit-days to within 0.1 MWh.</li>
    </ul>${BM_NOTES}`],
  costs: ['NESO Data Portal: daily balancing costs and EAC auction results; Elexon DISBSAD', `
    <h3>Sources</h3>
    <ul>
      <li>${NESO_DP('daily-balancing-costs-balancing-services-use-of-system', 'NESO Daily Balancing Costs (BSUoS)')}: NESO's daily cost total and its split by purpose (constraints, energy imbalance, reserve, frequency control, other).</li>
      <li>${NESO_DP('eac-auction-results', 'NESO EAC auction results')}: response and reserve availability costs (read through the portal's SQL endpoint).</li>
      <li>${ELX('DISBSAD')}: non-BM balancing actions.</li>
    </ul>
    <h3>How the figures are built</h3>
    <ul>
      <li>BM cost is NESO's daily total minus BSAD; on every complete day this matched Elexon's unit-level BM cashflows to within £0.4M (about 1%).</li>
      <li>EAC reserve products are half-hour windows and response products four-hour windows, so cost = price × MW × hours per product.</li>
      <li>NESO publishes the daily file a few days late: a day counts once it has 44 or more settlement periods, and the latest month is marked partial.</li>
      <li><b>Not included</b> (no public monthly actuals): other ancillary services (reactive, black start, stability, reserve delivery), SO-SO trades and reconciliation.</li>
    </ul>${SHARED_REFRESH}`],
  constraints: ['NESO Data Portal: day-ahead constraint flows and limits, thermal constraint costs, constraint breakdown', `
    <h3>Sources</h3>
    <ul>
      <li>${NESO_DP('day-ahead-constraint-flows-and-limits', 'NESO Day-Ahead Constraint Flows and Limits')}: per boundary and half-hour, the limit and the flow NESO forecast across it the day before.</li>
      <li>${NESO_DP('thermal-constraint-costs', 'NESO Thermal Constraint Costs')}: daily costs by boundary group.</li>
      <li>${NESO_DP('constraint-breakdown', 'NESO Constraint Breakdown')}: daily costs by reason (thermal, voltage, inertia, largest loss).</li>
      <li>Map outline: Natural Earth (public domain).</li>
    </ul>
    <h3>How the figures are built</h3>
    <ul>
      <li>A half-hour counts as "at the limit" when the forecast flow is at or above the limit. These are day-ahead forecasts, not metered flows.</li>
      <li>NESO renames boundaries as the network changes (SSE_SP became SSE_SP2), so codes are grouped into families for the map and costs. Boundary positions are schematic, drawn from NESO's network diagrams.</li>
      <li>Costs are published per day only, so they show per day at finer granularities.</li>
      <li>Days NESO published twice are de-duplicated, except the repeated hour at the autumn clock change.</li>
    </ul>${SHARED_REFRESH}`],
  remit: ['Elexon BMRS: REMIT outage messages; NESO GB DNO licence areas (map)', `
    <h3>Sources</h3>
    <ul>
      <li>${ELEXON_API}: REMIT messages (<code>remit/list</code> and <code>remit</code>), which owners must publish for any change in availability of 100 MW or more.</li>
      <li>Elexon BM unit reference data: GSP group and transmission loss factor per unit.</li>
      <li>Region outlines: NESO's GB DNO licence areas (NESO Open Data Licence), simplified.</li>
    </ul>
    <h3>How the figures are built</h3>
    <ul>
      <li>Only each message's latest revision counts, and withdrawn ("Dismissed") messages are ignored.</li>
      <li>Unavailable MW is the unit's normal capacity minus the outage profile's available capacity (or the message's own unavailable capacity when there is no profile), averaged over each half-hour; overlapping live messages for one unit count once (the larger).</li>
      <li>Events longer than a year are hidden unless <i>Closures</i> is ticked: closed and mothballed stations stay in REMIT as open-ended outages.</li>
      <li>Elexon gives a GSP group for embedded units only; transmission-connected units are placed by their transmission loss factor, which Elexon sets per GSP-group zone.</li>
      <li>Planned outages are published in advance, so the tab reaches 28 days ahead.</li>
    </ul>${SHARED_REFRESH}`],
  interconnectors: ['Elexon BMRS: DISBSAD interconnector trades, FUELHH physical flows', `
    <h3>Sources</h3>
    <ul>
      <li>${ELX('DISBSAD')}: NESO's trades on the interconnectors, which sit outside the Balancing Mechanism. Counterparty trades carry the trader's interconnector unit as the asset id (its prefix names the link); SO-SO trades are with the neighbouring system operator.</li>
      <li>${ELX('FUELHH')}: half-hourly physical flow per link (positive into GB).</li>
      <li>Map outline: Natural Earth (public domain); landing points are approximate.</li>
    </ul>
    <h3>How the figures are built</h3>
    <ul>
      <li>Positive volume is energy NESO bought (into GB). SO-SO trades are often published without a cost, so they count in volumes but not in average prices.</li>
      <li>Trades are pay-as-bid. Average price is cost / volume; the clearing price is the marginal trade in each half-hour (the dearest NESO bought, the cheapest it sold), averaged over the half-hours with trades.</li>
      <li>Trades are stored summed per settlement period, link, counterparty, kind, SO flag and direction, keeping each row's highest and lowest single-trade price.</li>
    </ul>${SHARED_REFRESH}`],
  icrev: ['Derived from the Interconnectors tab data (Elexon DISBSAD trades and FUELHH flows); NESO market notice of 14 May 2026', `
    <h3>Sources</h3>
    <ul>
      <li>${ELX('DISBSAD')} (NESO's interconnector trades) and ${ELX('FUELHH')} (metered flow), as stored for the Interconnectors tab; nothing extra is downloaded.</li>
      <li>The limits come from NESO's market notice <i>Interconnector trading restrictions for NESO</i> (14 May 2026): from 20 May 2026 to the end of 2026, at most 1,500 MW per hour within day against the day-ahead schedule across IFA, IFA2, ElecLink, Viking Link, BritNed and Nemo Link, and at most 300 MW on any one of them.</li>
    </ul>
    <h3>How the figures are built</h3>
    <ul>
      <li>Elexon does not publish the day-ahead schedule, so it is estimated per link and clock hour as the metered flow minus NESO's net trades. The estimate also includes intraday market trades.</li>
      <li>A link was <i>reversed</i> when the estimate and the metered flow point opposite ways, each by at least 50 MW. A counterparty trade is <i>against the schedule</i> when it points the other way to the estimate; SO-SO trades do not count towards the limit.</li>
      <li>A link-hour is over the limit above 300 MW (1 MW allowed for rounding); an hour above 1,500 MW across the six links.</li>
      <li>The hourly volumes match NESO's own interconnector auction results, but because the schedule is estimated, breaches are best read as likely rather than certain.</li>
    </ul>${SHARED_REFRESH}`],
  dfs: ['NESO Data Portal: Demand Flexibility Service utilisation reports and service requirements; Elexon MID market prices', `
    <h3>Sources</h3>
    <ul>
      <li>${NESO_DP('demand-flexibility', 'NESO Demand Flexibility Service')}: the <i>DFS Utilisation Report Summary</i> (per event half-hour: requirement, MW procured, accepted cost, settled volume and cost), the <i>DFS Utilisation Report</i> (every bid: provider, DFS unit, zone, MW, price, accepted or rejected) and the <i>DFS Service Requirement</i> (guaranteed acceptance price and zone caps), for the current year and the 2025/26 archive.</li>
      <li>${ELX('MID')}: Elexon's market index price (APX) for each event half-hour.</li>
      <li>Zone outlines: NESO's DFS 12-zone GeoJSON (February 2026), simplified; area names are approximate.</li>
    </ul>
    <h3>How the figures are built</h3>
    <ul>
      <li>Bids are paid their own price and accepted cheapest first, so a half-hour's clearing price is its highest accepted bid; over several half-hours it is averaged weighted by volume procured.</li>
      <li>Accepted bids add up exactly to NESO's procured MW and cost for every half-hour checked (3,130 event half-hours).</li>
      <li>The archive has no event numbers, types or tags, so its events are named by date with the reason "Not stated"; zones start in April 2026. Provider names are normalised because NESO spells some differently between files. Test events are left out unless ticked.</li>
    </ul>${SHARED_REFRESH}`],
  data: ['Elexon Insights Solution (BMRS) API', `
    <h3>Sources</h3>
    <p>This tab fetches Balancing Mechanism data from the ${ELEXON_API}: about seven requests per settlement day (indicative volumes and cashflows for bids and offers, ${ELX('BOALF')} acceptances, ${ELX('DISEBSP')} system prices and ${ELX('DISBSAD')}). Each dataset is stored as one file per settlement day.</p>
    <h3>Other tabs</h3>
    <p>The Total costs, Constraints, REMIT, Interconnectors, IC reversals and DFS tabs have their own sources (NESO Data Portal and other Elexon datasets), listed at the bottom of each tab and updated with their Refresh data button.</p>`],
};

let sourcesFor = null;
function drawSources() {
  const el = $('#sources');
  if (!el) return;
  const v = state.view in SOURCES ? state.view : 'overview';
  if (v === sourcesFor) return; // keep it open or closed while the same tab re-renders
  sourcesFor = v;
  const [summary, body] = SOURCES[v];
  el.innerHTML = `<details class="sources-box"><summary><span class="sources-label">Data sources</span> <span class="sources-sum"></span> <span class="sources-more">How this data is sourced</span></summary><div class="sources-body">${body}</div></details>`;
  el.querySelector('.sources-sum').textContent = summary;
}

let lastPage = null;
async function render() {
  readHash();
  if (!META.days.length && !['data', 'costs', 'constraints', 'remit', 'interconnectors', 'icrev', 'dfs'].includes(state.view)) { state.view = 'data'; }
  const E = extent();
  if (E.max) {
    // REMIT reaches weeks ahead (planned outages), so it opens on the weeks around today rather than at its far end.
    if (!state.to && state.view === 'remit') state.to = addDays(iso(new Date()), 7) > E.max ? E.max : addDays(iso(new Date()), 7);
    if (!state.to || state.to > E.max) state.to = E.max;
    if (ownRange() && state.from && state.from < E.min) state.from = E.min;
    if (!state.from || state.from > state.to) state.from = addDays(state.to, -29) < E.min ? E.min : addDays(state.to, -29);
  }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (state.view === 'unit' ? 'units' : state.view)));
  $('#nav a.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // phones: the tab row scrolls sideways
  const noFilters = state.view === 'data' || state.view === 'costs' || (state.view === 'constraints' && !CMETA.max) || (state.view === 'remit' && !RMETA.max) || (['interconnectors', 'icrev'].includes(state.view) && !IMETA.max) || (state.view === 'dfs' && !DMETA.max);
  $('#filterbar').hidden = noFilters;
  if (!noFilters) drawFilterBar();
  drawZoomTrail();
  drawCoverage();
  drawSources();
  const page = state.view === 'unit' ? `unit/${state.unit}` : state.view;
  if (page !== lastPage && lastPage != null && !pendingReveal) scrollTo(0, 0);  // a new page starts at its top
  lastPage = page;
  const main = $('#main');
  try {
    if (state.view === 'units') await viewUnits(main);
    else if (state.view === 'unit') await viewUnit(main);
    else if (state.view === 'costs') await viewCosts(main);
    else if (state.view === 'constraints') await viewConstraints(main);
    else if (state.view === 'remit') await viewRemit(main);
    else if (state.view === 'interconnectors') await viewInterconnectors(main);
    else if (state.view === 'icrev') await viewReversals(main);
    else if (state.view === 'dfs') await viewDfs(main);
    else if (state.view === 'data') await viewData(main);
    else viewOverview(main);
  } catch (e) { console.error(e); main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  pruneCharts();
  revealPending();
}

// Nav links keep the current range and filters.
document.querySelectorAll('#nav a').forEach((a) => a.onclick = (e) => {
  e.preventDefault();
  state.view = a.dataset.view; state.unit = null;
  if (state.view === 'overview') { state.split = 'tech'; state.bdim = 'party'; }
  writeHash();
});
addEventListener('hashchange', render);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
await loadMeta();
await loadCMeta().catch((e) => console.error(e));
await loadRMeta().catch((e) => console.error(e));
await loadIMeta().catch((e) => console.error(e));
await loadDMeta().catch((e) => console.error(e));
render();

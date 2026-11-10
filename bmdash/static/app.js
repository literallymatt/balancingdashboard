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
  metric: 'net', split: 'tech', bdim: 'party', filters: {}, day: null };
let META = { days: [] };

function readHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/');
  state.view = parts[0] || 'overview';
  state.unit = state.view === 'unit' ? decodeURIComponent(parts[1] || '') : null;
  const unitView = state.view === 'unit';
  Object.assign(state, { bucket: 'auto', metric: 'net', split: unitView ? 'direction' : 'tech', bdim: unitView ? 'pair' : 'party', day: null });
  const p = new URLSearchParams(qs || '');
  state.filters = {};
  for (const [k, v] of p) {
    if (k.startsWith('f.')) state.filters[k.slice(2)] = v.split('|');
    else if (k in state) state[k] = v;
  }
}

function writeHash(replace = false) {
  const p = new URLSearchParams();
  for (const k of ['from', 'to', 'bucket', 'metric', 'split', 'bdim']) if (state[k]) p.set(k, state[k]);
  if (state.view === 'unit' && state.day) p.set('day', state.day);
  for (const [k, v] of Object.entries(state.filters)) if (v.length) p.set('f.' + k, v.join('|'));
  const path = state.view === 'unit' ? `unit/${encodeURIComponent(state.unit)}` : state.view;
  const h = `#/${path}?${p}`;
  if (replace) history.replaceState(null, '', h); else location.hash = h;
  if (replace) render();
}

function update(patch, replace = false) { Object.assign(state, patch); writeHash(replace); }

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
    return tipHtml(ps[0].axisValueLabel, items, m.fmt, total);
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
    if (state.view === 'unit') update({ day: d }, true);
    else if (state.from !== d || state.to !== d) update({ from: d, to: d, bucket: 'auto' });
    return;
  }
  const end = bucket === 'day' ? d : bucket === 'week' ? addDays(d, 6)
    : iso(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
  update({ from: d, to: end > META.max ? META.max : end, bucket: 'auto', day: state.view === 'unit' && bucket === 'day' ? d : state.day });
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
        `<div class="r"><span>${r.n_units} unit${r.n_units === 1 ? '' : 's'}</span></div></div>`;
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
    update({ filters: { ...state.filters, [dim]: [r.g] } });
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
      [{ name: m.line ? 'Avg offer price' : m.label, value: p.value[2], color: p.color }], m.fmt);
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
    if (state.view === 'unit') update({ day: d }, true);
    else update({ from: d, to: d, bucket: 'auto' });
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

function table(el, cols, rows, { onRow, limit = 300, sort } = {}) {
  let s = sort || null;
  const draw = () => {
    const data = s ? [...rows].sort((a, b) => {
      const x = a[s.key], y = b[s.key];
      const c = typeof x === 'number' || typeof y === 'number' ? (x ?? -Infinity) - (y ?? -Infinity) : String(x ?? '').localeCompare(String(y ?? ''));
      return s.desc ? -c : c;
    }) : rows;
    const head = cols.map((c) => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}" data-k="${esc(c.key)}">${esc(c.label)}${s?.key === c.key ? (s.desc ? ' ↓' : ' ↑') : ''}</th>`).join('');
    const body = data.slice(0, limit).map((r, i) => `<tr data-i="${i}" class="${onRow ? 'click' : ''}">${cols.map((c) =>
      `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key] ?? '')}</td>`).join('')}</tr>`).join('');
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (data.length > limit ? `<div class="muted small" style="margin-top:6px">Showing ${limit} of ${data.length} rows</div>` : '') +
      (data.length ? '' : '<div class="empty">No rows</div>');
    el.querySelectorAll('th').forEach((th) => th.onclick = () => {
      const k = th.dataset.k; s = s?.key === k ? { key: k, desc: !s.desc } : { key: k, desc: cols.find((c) => c.key === k).num }; draw();
    });
    if (onRow) el.querySelectorAll('tbody tr').forEach((tr) => tr.onclick = () => onRow(data[+tr.dataset.i]));
  };
  draw();
}

const techTag = (r) => `<span class="tag"><span class="dot" style="background:${colour('tech', r.tech)}"></span>${esc(r.tech)}</span>`;
function openUnit(id) { state.view = 'unit'; state.unit = id; state.split = 'direction'; state.bdim = 'pair'; state.day = null; delete state.filters.unit; writeHash(); }

// ------------------------------------------------------------------ views

function select(id, options, value) {
  return `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function kpi(label, value, note = '') {
  return `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;
}

async function kpis(el) {
  const s = await api('summary', queryParams());
  const net = n0(s.offer_cash) + n0(s.bid_cash);
  const gross = Math.abs(n0(s.offer_vol)) + Math.abs(n0(s.bid_vol));
  el.innerHTML = [
    kpi('Net BM cost', gbp(net), s.n_days ? `${gbp(net / s.n_days)} per day over ${s.n_days} day${s.n_days === 1 ? '' : 's'}` : ''),
    kpi('Offer payments', gbp(s.offer_cash), `${mwh(s.offer_vol)} @ ${price(ratio(s.offer_cash, s.offer_vol))}`),
    kpi('Bid cashflow', gbp(s.bid_cash), `${mwh(s.bid_vol)} @ ${price(ratio(s.bid_cash, s.bid_vol))}`),
    kpi('SO-flagged net cost', gbp(s.so_cash), `${gross ? nf(0).format(100 * n0(s.so_vol) / gross) : 0}% of accepted volume (approx.)`),
    ...(state.view === 'unit' ? [kpi('Active days', nf(0).format(n0(s.n_days)), 'days with accepted actions')] : [
      kpi('Units with actions', nf(0).format(n0(s.n_units)), 'accepted bids or offers'),
      kpi('Avg system price', price(s.avg_price), `range ${price(s.min_price)} to ${price(s.max_price)}`),
      kpi('Non-BM actions (BSAD)', gbp(s.bsad_cost), `${mwh(s.bsad_vol)} outside the BM`)]),
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
        <label class="small muted">Measure ${select('metric', METRIC_OPTS, state.metric)}</label>
        <label class="small muted">Split by ${select('split', splitOpts(), state.split)}</label>
        <button class="btn" id="toggleTable">Table</button>
      </div>
    </div>
    <div class="chart tall" id="timeChart"></div>
    <div id="timeTable" hidden></div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <div class="card-head"><div><h2>Breakdown</h2><div class="sub" id="bdNote"></div></div>
        <div class="controls"><label class="small muted">By ${select('bdim', bd, state.bdim)}</label></div></div>
      <div class="chart tall" id="bdChart"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Day × settlement period</h2><div class="sub">Each cell is one half-hour; click a day to open it.</div></div></div>
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
    <div class="card"><div class="card-head"><div><h2>System price</h2><div class="sub">Imbalance price (£/MWh) for context.</div></div></div><div class="chart short" id="priceChart"></div></div>
    <div class="card"><div class="card-head"><div><h2>Net imbalance volume</h2><div class="sub">Red: system short (NESO buying). Blue: system long.</div></div></div><div class="chart short" id="nivChart"></div></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Balancing actions outside the BM</h2><div class="sub">Balancing Services Adjustment Data cost (trades, non-BM reserve). Not affected by the unit filters.</div></div></div><div class="chart short" id="bsadChart"></div></div>`;
  wireExplorer();
  loading($('#priceChart'), () => priceChart($('#priceChart')));
  loading($('#nivChart'), () => nivChart($('#nivChart')));
  loading($('#bsadChart'), () => bsadChart($('#bsadChart')));
}

async function viewUnits(main) {
  main.innerHTML = `<div class="card"><div class="card-head"><div><h2>BM units</h2><div class="sub" id="unitsNote">Totals for the selected range and filters. Click a unit to drill in.</div></div>
    <div class="controls"><input id="search" type="search" placeholder="Search unit, name, party…" size="30"></div></div><div id="unitsTable"></div></div>`;
  const el = $('#unitsTable');
  await loading(el, async () => {
    const data = await api('units', queryParams());
    const rows = data.rows.map((r) => ({ ...r, net: n0(r.offer_cash) + n0(r.bid_cash),
      offer_price: ratio(r.offer_cash, r.offer_vol), bid_price: ratio(r.bid_cash, r.bid_vol) }));
    const cols = [
      { key: 'bm_unit', label: 'Unit' }, { key: 'name', label: 'Name' }, { key: 'tech', label: 'Technology', html: techTag, cls: 'hide-sm' },
      { key: 'party', label: 'Lead party', cls: 'hide-sm' },
      { key: 'net', label: 'Net cost', num: true, fmt: (v) => gbp(v) },
      { key: 'offer_cash', label: 'Offer payments', num: true, fmt: (v) => gbp(v) },
      { key: 'bid_cash', label: 'Bid cashflow', num: true, fmt: (v) => gbp(v) },
      { key: 'offer_vol', label: 'Offer volume', num: true, fmt: mwh }, { key: 'bid_vol', label: 'Bid volume', num: true, fmt: mwh },
      { key: 'offer_price', label: 'Avg offer', num: true, fmt: price }, { key: 'bid_price', label: 'Avg bid', num: true, fmt: price },
      { key: 'n_periods', label: 'Active periods', num: true }, { key: 'n_so_periods', label: 'SO-flagged periods', num: true },
    ];
    const draw = () => {
      const s = $('#search').value.toLowerCase();
      const f = s ? rows.filter((r) => `${r.bm_unit} ${r.name} ${r.party} ${r.tech}`.toLowerCase().includes(s)) : rows;
      $('#unitsNote').textContent = `${f.length} units with accepted actions in the selected range. Click a unit to drill in.`;
      table(el, cols, f, { onRow: (r) => openUnit(r.bm_unit), sort: { key: 'net', desc: true }, limit: 500 });
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
  <div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>Day detail</h2><div class="sub">Physical notification, export/import limits and accepted levels (MW, local time), fetched live from Elexon.</div></div>
      <div class="controls"><label class="small muted">Settlement day <input type="date" id="day" min="${esc(state.from)}" max="${esc(state.to)}"></label></div></div>
    <div class="chart" id="dayChart"></div>
    <h2 style="margin-top:14px">Accepted volume by period and pair</h2>
    <div class="sub">Settled volume and cashflow per bid-offer pair, with the submitted pair prices.</div>
    <div id="dayTable" style="margin-top:8px"></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Acceptances (BOALF)</h2><div class="sub">Every acceptance issued to this unit in the selected range, newest first.</div></div></div><div id="accTable"></div></div>`;
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
    const a = await api('acceptances', { unit: state.unit, from: state.from, to: state.to });
    const ts = (v) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const yn = (v) => (v ? 'Yes' : '');
    table($('#accTable'), [
      { key: 'acceptance_number', label: 'Acceptance', num: true }, { key: 'acceptance_time', label: 'Accepted at', fmt: ts },
      { key: 'time_from', label: 'From', fmt: ts }, { key: 'time_to', label: 'To', fmt: ts },
      { key: 'level_from', label: 'Level from (MW)', num: true }, { key: 'level_to', label: 'Level to (MW)', num: true },
      { key: 'sp_from', label: 'SP', num: true }, { key: 'so_flag', label: 'SO flag', fmt: yn }, { key: 'stor_flag', label: 'STOR', fmt: yn },
      { key: 'rr_flag', label: 'RR', fmt: yn }, { key: 'deemed_bo', label: 'Deemed', fmt: yn }, { key: 'amendment_flag', label: 'Amendment' },
    ], a.rows, { limit: 300 });
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
  const o = baseOption();
  o.xAxis = { ...o.xAxis, type: 'time' };
  o.yAxis = { ...o.yAxis, type: 'value', scale: true };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => tipHtml(new Date(p.value[0]).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    [{ name: p.seriesName, value: p.value[1], color: p.color }], (v) => `${nf(0).format(v)} MW`) };
  const line = (name, data, c, extra = {}) => ({ name, type: 'line', data, color: css(c), symbol: 'circle', symbolSize: 4, showSymbol: false, lineStyle: { width: 2 }, connectNulls: false, ...extra });
  o.series = [
    line('Physical notification', phys('PN'), '--s1'),
    line('Accepted level', acc, '--s2', { showSymbol: true, z: 5 }),
    line('Max export limit', phys('MELS'), '--other', { lineStyle: { width: 1, type: 'dashed' } }),
    line('Max import limit', phys('MILS'), '--other2', { lineStyle: { width: 1, type: 'dashed' } }),
  ];
  if (!d.physical.length && !acc.length) { el.innerHTML = '<div class="empty">No physical data or acceptances for this unit on this day.</div>'; charts.delete(el); }
  else chart(el).setOption(o, true);

  const bod = new Map(d.bod.map((b) => [`${b.sp}|${b.pair}`, b]));
  const rows = d.periods.map((p) => { const b = bod.get(`${p.sp}|${p.pair}`) || {}; return { ...p, time: spTime(p.sp), px: ratio(p.cashflow, p.volume), bid: b.bid, offer: b.offer, level: b.levelFrom }; });
  table(tableEl, [
    { key: 'sp', label: 'SP', num: true }, { key: 'time', label: 'Start' }, { key: 'direction', label: 'Direction' }, { key: 'pair', label: 'Pair', num: true },
    { key: 'volume', label: 'Volume', num: true, fmt: mwh }, { key: 'cashflow', label: 'Cashflow', num: true, fmt: (v) => gbp(v, false) },
    { key: 'px', label: 'Paid price', num: true, fmt: price }, { key: 'bid', label: 'Pair bid price', num: true, fmt: price },
    { key: 'offer', label: 'Pair offer price', num: true, fmt: price }, { key: 'level', label: 'Pair level (MW)', num: true },
    { key: 'so_flag', label: 'SO flag', fmt: (v) => (v ? 'Yes' : '') },
  ], rows, { limit: 600 });
}

// ------------------------------------------------------------------ data / ingest view

let pollTimer = null;
async function viewData(main) {
  const today = iso(new Date());
  const wasEmpty = !META.days.length;
  main.innerHTML = `
  <div class="card"><h2>Fetch data from Elexon</h2>
    <div class="sub">Downloads bid/offer volumes and cashflows (four whole-day requests per day), plus acceptances, system prices and BSAD. Days already held are skipped unless they were fetched before the data settled.</div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:12px">
      <label class="small muted">From <input type="date" id="iFrom" value="${META.min ? addDays(META.min, -30) : addDays(today, -89)}"></label>
      <label class="small muted">To <input type="date" id="iTo" value="${today}"></label>
      <label class="small"><input type="checkbox" id="iForce"> Re-fetch days already held</label>
      <button class="btn primary" id="iGo">Fetch</button>
    </div>
    <div id="job" style="margin-top:10px"></div>
  </div>
  <div class="card" style="margin-top:14px"><h2>Coverage</h2><div class="sub" id="covNote"></div><div class="months" id="months"></div></div>`;
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
  $('#coverage').textContent = META.days.length ? `Data held: ${META.min} to ${META.max} (${META.days.length} days)` : 'No data held';
}

function drawFilterBar() {
  const span = (n) => ({ from: n ? addDays(META.max, -(n - 1)) < META.min ? META.min : addDays(META.max, -(n - 1)) : META.min, to: META.max });
  const presets = [['1D', 1], ['7D', 7], ['30D', 30], ['90D', 90], ['1Y', 365], ['All', 0]];
  $('#presets').innerHTML = presets.map(([l, n]) => { const s = span(n); return `<button data-n="${n}" class="${s.from === state.from && s.to === state.to ? 'on' : ''}">${l}</button>`; }).join('');
  $('#presets').querySelectorAll('button').forEach((b) => b.onclick = () => update({ ...span(+b.dataset.n), bucket: 'auto' }));
  for (const k of ['from', 'to']) { const i = $('#' + k); i.value = state[k]; i.min = META.min; i.max = META.max;
    i.onchange = () => { if (i.value) update({ [k]: i.value, ...(k === 'from' && i.value > state.to ? { to: i.value } : {}), ...(k === 'to' && i.value < state.from ? { from: i.value } : {}) }); }; }
  $('#bucket').value = state.bucket;
  $('#bucket').onchange = (e) => update({ bucket: e.target.value }, true);
  const chips = $('#chips');
  chips.innerHTML = '';
  for (const [dim, vals] of Object.entries(state.filters)) for (const v of vals) {
    const c = document.createElement('span'); c.className = 'chip';
    c.innerHTML = `<span>${esc(DIM_LABEL[dim] || dim)}: <b></b></span><button title="Remove filter" aria-label="Remove filter">×</button>`;
    c.querySelector('b').textContent = v;
    c.querySelector('button').onclick = () => { const f = { ...state.filters }; f[dim] = f[dim].filter((x) => x !== v); if (!f[dim].length) delete f[dim]; update({ filters: f }); };
    chips.append(c);
  }
}

async function render() {
  readHash();
  if (!META.days.length && state.view !== 'data') { state.view = 'data'; }
  if (META.days.length) {
    if (!state.to || state.to > META.max) state.to = META.max;
    if (!state.from || state.from > state.to) state.from = addDays(state.to, -29) < META.min ? META.min : addDays(state.to, -29);
  }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (state.view === 'unit' ? 'units' : state.view)));
  $('#filterbar').hidden = state.view === 'data';
  if (state.view !== 'data') drawFilterBar();
  const main = $('#main');
  try {
    if (state.view === 'units') await viewUnits(main);
    else if (state.view === 'unit') await viewUnit(main);
    else if (state.view === 'data') await viewData(main);
    else viewOverview(main);
  } catch (e) { console.error(e); main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  pruneCharts();
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
render();

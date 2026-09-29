// Outdoor strategy: search a course in OpenStreetMap, read holes and hazards, and simulate
// the player's own shot pattern (from TrackMan club profiles) to suggest the tee club and aim line.
// Everything runs in the browser. Course data is cached on the phone for use on the course.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const LS_PREFIX = 'mc_course_';
const LS_RECENT = 'mc_recent_courses';
const N_SAMPLES = 400;

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

// ------------------------------------------------------------------ geometry
function projector(lat0, lon0) {
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
  return { to: (p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }), from: (q) => ({ lat: lat0 + q.y / ky, lon: lon0 + q.x / kx }) };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
function pointAt(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (s <= d || i === pts.length - 1) { const t = d ? Math.min(1, s / d) : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; }
    s -= d;
  }
  return pts[pts.length - 1];
}
// arc position and signed lateral offset (+ = right of play direction) of point p relative to polyline
function project(pts, p) {
  let best = { d: Infinity, s: 0, side: 0 }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2));
    const cx = a.x + vx * t, cy = a.y + vy * t, d = Math.hypot(p.x - cx, p.y - cy);
    if (d < best.d) { const cross = vx * (p.y - a.y) - vy * (p.x - a.x); best = { d, s: acc + Math.sqrt(L2) * t, side: cross > 0 ? -1 : 1 }; }
    acc += Math.sqrt(L2);
  }
  return { s: best.s, lat: best.d * best.side, d: best.d };
}
function inPoly(poly, p) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function distToLine(pts, p) { return project(pts, p).d; }
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}
const inBox = (b, p, m = 0) => p.x >= b.x0 - m && p.x <= b.x1 + m && p.y >= b.y0 - m && p.y <= b.y1 + m;
const centroid = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

// ------------------------------------------------------------------ OSM loading
async function searchCourses(text) {
  const run = async (qq) => {
    const u = `${NOMINATIM}?format=jsonv2&limit=10&q=${encodeURIComponent(qq)}`;
    const r = await fetch(u, { headers: { 'Accept-Language': 'no,en' } });
    if (!r.ok) throw new Error('Søket feilet (' + r.status + ')');
    return (await r.json()).filter((x) => x.type === 'golf_course' && (x.osm_type === 'way' || x.osm_type === 'relation'));
  };
  let hits = await run(text);
  if (!hits.length && !/golf/i.test(text)) hits = await run(text + ' golf');
  return hits.map((h) => ({ id: h.osm_type[0] + h.osm_id, osm_type: h.osm_type, osm_id: h.osm_id, name: h.name || h.display_name.split(',')[0],
    place: h.display_name.split(',').slice(1, 4).join(',').trim(), lat: +h.lat, lon: +h.lon }));
}

function kindOf(t) {
  if (!t) return null;
  if (t.golf === 'hole') return 'hole';
  if (t.golf === 'fairway') return 'fairway';
  if (t.golf === 'green') return 'green';
  if (t.golf === 'tee') return 'tee';
  if (t.golf === 'bunker') return 'bunker';
  if (t.golf === 'rough') return 'rough';
  if (t.golf === 'water_hazard' || t.golf === 'lateral_water_hazard' || t.natural === 'water' || t.waterway || t.water) return 'water';
  if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest') return 'trees';
  if (t.golf === 'out_of_bounds') return 'oob';
  return null;
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const txt = await r.text();
      if (!r.ok || txt[0] !== '{') throw new Error('Kartserveren er opptatt. Prøv igjen om litt.');
      return JSON.parse(txt);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function loadCourse(c) {
  const cachedCourse = ls.get(LS_PREFIX + c.id);
  if (cachedCourse && cachedCourse.v === 2) return cachedCourse;
  const sel = `${c.osm_type}(${c.osm_id})`;
  const qy = `[out:json][timeout:40];${sel}->.c;.c map_to_area->.a;
    (way(area.a)["golf"];way(area.a)["natural"~"^(water|wood|scrub)$"];way(area.a)["landuse"="forest"];way(area.a)["waterway"];
     relation(area.a)["natural"~"^(water|wood)$"];relation(area.a)["golf"];relation(area.a)["landuse"="forest"];);out geom;`;
  const j = await overpass(qy);
  const feats = [];
  for (const el of j.elements) {
    const k = kindOf(el.tags); if (!k) continue;
    if (el.type === 'way' && el.geometry) feats.push({ k, tags: el.tags, g: el.geometry.map((p) => ({ lat: p.lat, lon: p.lon })) });
    if (el.type === 'relation' && el.members) for (const m of el.members) if (m.role !== 'inner' && m.geometry) feats.push({ k, tags: el.tags, g: m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })) });
  }
  const data = { v: 2, id: c.id, name: c.name, place: c.place, lat: c.lat, lon: c.lon, feats, loadedAt: new Date().toISOString() };
  ls.set(LS_PREFIX + c.id, data);
  const recent = (ls.get(LS_RECENT) || []).filter((x) => x.id !== c.id);
  recent.unshift({ id: c.id, osm_type: c.osm_type, osm_id: c.osm_id, name: c.name, place: c.place, lat: c.lat, lon: c.lon });
  ls.set(LS_RECENT, recent.slice(0, 8));
  return data;
}

// Build holes in local metres
function buildHoles(course) {
  const P = projector(course.lat, course.lon);
  const all = course.feats.map((f) => ({ ...f, pts: f.g.map(P.to) }));
  const polys = all.filter((f) => f.k !== 'hole').map((f) => {
    const closed = f.pts.length > 3 && dist(f.pts[0], f.pts[f.pts.length - 1]) < 1;
    return { k: f.k, pts: f.pts, closed, box: bbox(f.pts), tags: f.tags };
  });
  const tees = polys.filter((p) => p.k === 'tee');
  const holes = all.filter((f) => f.k === 'hole' && f.pts.length >= 2).map((f) => {
    let pts = f.pts;
    // play direction: the end closest to a tee box is the start
    if (tees.length) {
      const dStart = Math.min(...tees.map((t) => dist(centroid(t.pts), pts[0])));
      const dEnd = Math.min(...tees.map((t) => dist(centroid(t.pts), pts[pts.length - 1])));
      if (dEnd + 5 < dStart) pts = [...pts].reverse();
    }
    const ref = parseInt(f.tags.ref || (f.tags.name || '').replace(/\D/g, ''), 10);
    const len = polyLen(pts);
    const par = parseInt(f.tags.par, 10) || (len < 220 ? 3 : len < 430 ? 4 : 5);
    const hb = bbox(pts);
    const near = polys.filter((p) => p.box.x1 >= hb.x0 - 90 && p.box.x0 <= hb.x1 + 90 && p.box.y1 >= hb.y0 - 90 && p.box.y0 <= hb.y1 + 90);
    const green = near.filter((p) => p.k === 'green' && p.closed).sort((a, b) => dist(centroid(a.pts), pts[pts.length - 1]) - dist(centroid(b.pts), pts[pts.length - 1]))[0];
    const pin = green ? centroid(green.pts) : pts[pts.length - 1];
    return { ref: Number.isFinite(ref) ? ref : null, par, hcp: parseInt(f.tags.handicap, 10) || null, len, pts, pin, near, green, P };
  }).sort((a, b) => (a.ref ?? 99) - (b.ref ?? 99));
  return holes;
}

// ------------------------------------------------------------------ player model
// Seeded random numbers: every club is tested against the same sequence of "swings" (common random numbers),
// so differences between clubs are real and the advice does not change when the page is reloaded.
let rnd = Math.random;
function seed(n) { let a = n >>> 0; rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randn() { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function carryQuantile(c, u) {
  const p20 = +c.carry_p20, p50 = +c.carry_p50, p80 = +c.carry_p80, p90 = +(c.carry_p90 || c.carry_p80 * 1.03);
  const k = [[0.02, p20 - (p50 - p20) * 1.1], [0.2, p20], [0.5, p50], [0.8, p80], [0.9, p90], [0.99, p90 + (p90 - p80) * 0.9]];
  for (let i = 1; i < k.length; i++) if (u <= k[i][0]) { const [u0, v0] = k[i - 1], [u1, v1] = k[i]; return v0 + (v1 - v0) * (u - u0) / (u1 - u0); }
  return k[k.length - 1][1];
}
function sampleShot(c) {
  const mishit = rnd() < (+c.mishit_pct || 0) / 100;
  let carry = carryQuantile(c, 0.02 + rnd() * 0.97);
  const sd = Math.max(3, (+c.side_abs_p80 || 10) / 1.2816);
  let side = (+c.side_mean || 0) + randn() * sd;
  if (mishit) { carry *= 0.55 + rnd() * 0.25; side *= 1.4; }
  const roll = Math.max(0, (+c.total_p50 || +c.carry_p50) - +c.carry_p50) * (mishit ? 1.3 : 1);
  return { carry, side, roll };
}

// Expected strokes to hole out from a distance and lie (rough model for a mid-handicap player)
function E(d, lie) {
  const fw = d <= 20 ? 2.35 : 2.45 + 0.0055 * d;
  switch (lie) {
    case 'green': return 1.35 + 0.3 * Math.log1p(Math.max(0, d));
    case 'fairway': case 'tee': return fw;
    case 'rough': return fw + 0.22;
    case 'bunker': return d <= 40 ? 2.85 + 0.004 * d : fw + 0.45;
    case 'trees': return fw + 0.75;
    default: return fw + 0.22;
  }
}
function lieAt(hole, p) {
  let lie = null;
  for (const f of hole.near) {
    if (!inBox(f.box, p, f.closed ? 0 : 6)) continue;
    const hit = f.closed ? inPoly(f.pts, p) : distToLine(f.pts, p) < 4;
    if (!hit) continue;
    if (f.k === 'water') return 'water';
    if (f.k === 'oob') return 'oob';
    if (f.k === 'bunker') lie = 'bunker';
    else if (f.k === 'green' && lie !== 'bunker') lie = 'green';
    else if (f.k === 'trees' && !lie) lie = 'trees';
    else if ((f.k === 'fairway' || f.k === 'tee') && (!lie || lie === 'trees' || lie === 'rough')) lie = 'fairway';
    else if (f.k === 'rough' && !lie) lie = 'rough';
  }
  if (lie) return lie;
  return project(hole.pts, p).d > 65 ? 'wild' : 'rough';
}

// Simulate one club with one aim offset from a start point toward a target point
function simulate(hole, club, start, target, aimOff, n = N_SAMPLES) {
  const dx = target.x - start.x, dy = target.y - start.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, px = uy, py = -ux; // px,py = right-hand normal
  const tgt = { x: target.x + px * aimOff, y: target.y + py * aimOff };
  const ax = tgt.x - start.x, ay = tgt.y - start.y, AL = Math.hypot(ax, ay) || 1;
  const vx = ax / AL, vy = ay / AL, nx = vy, ny = -vx;
  seed(12345);
  let sumE = 0; const cnt = { fairway: 0, green: 0, rough: 0, bunker: 0, trees: 0, water: 0, wild: 0, oob: 0 };
  const rem = []; const dots = [];
  for (let i = 0; i < n; i++) {
    const s = sampleShot(club);
    const land = { x: start.x + vx * s.carry + nx * s.side, y: start.y + vy * s.carry + ny * s.side };
    let lie = lieAt(hole, land), end = land, pen = 0;
    if (lie === 'water') { pen = 1; lie = 'rough'; }
    else if (lie === 'oob') { pen = 2; lie = 'tee'; end = start; }
    else if (lie === 'fairway' || lie === 'rough') {
      const r = lie === 'fairway' ? s.roll : s.roll * 0.4;
      const e2 = { x: land.x + vx * r, y: land.y + vy * r };
      const lie2 = lieAt(hole, e2);
      if (lie2 === 'water') { pen = 1; lie = 'rough'; end = land; }
      else { end = e2; lie = lie2 === 'oob' ? 'rough' : lie2; }
    }
    let label = pen ? (pen === 2 ? 'oob' : 'water') : lie;
    if (lie === 'wild') { pen += 0.5; lie = 'trees'; }
    const d = dist(end, hole.pin);
    sumE += 1 + pen + E(d, lie);
    cnt[label] = (cnt[label] || 0) + 1; rem.push(d);
    if (i < 160) dots.push({ ...end, label });
  }
  rem.sort((a, b) => a - b);
  const pc = (k) => cnt[k] / n;
  return { club, aimOff, exp: sumE / n, p: { fairway: pc('fairway'), green: pc('green'), rough: pc('rough'), bunker: pc('bunker'),
    trees: pc('trees') + pc('wild'), water: pc('water') + pc('oob') }, remaining: rem[Math.floor(n / 2)], dots, target: tgt };
}

function planHole(hole, clubs, teeShift) {
  const start = pointAt(hole.pts, Math.max(0, teeShift));
  const L = hole.len - teeShift;
  const offsets = [-16, -8, 0, 8, 16];
  const opts = [];
  const cands = hole.par === 3
    ? clubs.filter((c) => +c.carry_p50 > L * 0.8 && +c.carry_p50 < L * 1.25)
    : clubs.filter((c) => c.category !== 'wedge' && +c.carry_p50 >= 120 && +c.carry_p50 < L + 20);
  for (const c of cands) {
    let best = null;
    const reach = hole.par === 3 ? L : Math.min(+c.total_p50 || +c.carry_p50, L - 5);
    const target = hole.par === 3 ? hole.pin : pointAt(hole.pts, teeShift + reach);
    for (const o of offsets) {
      const r = simulate(hole, c, start, target, o, 250);
      if (!best || r.exp < best.exp) best = r;
    }
    opts.push(simulate(hole, c, start, target, best.aimOff, N_SAMPLES));
  }
  opts.sort((a, b) => a.exp - b.exp);
  return { start, L, opts };
}

// hazards along the hole: along-distance from the tee and side
function hazardsOf(hole, teeShift) {
  const out = [];
  for (const f of hole.near) {
    if (!['water', 'bunker', 'trees'].includes(f.k)) continue;
    const pr = f.pts.map((p) => project(hole.pts, p));
    const lats = pr.map((x) => x.lat), ss = pr.map((x) => x.s - teeShift);
    const minAbs = Math.min(...lats.map(Math.abs));
    const crosses = Math.min(...lats) < 0 && Math.max(...lats) > 0;
    if (!crosses && minAbs > (f.k === 'trees' ? 25 : 35)) continue;
    const s0 = Math.max(0, Math.min(...ss)), s1 = Math.max(...ss);
    if (s1 < 60 || s0 > hole.len - teeShift + 10) continue;
    const side = crosses ? 'over' : (lats[0] < 0 ? 'venstre' : 'høyre');
    if (f.k === 'trees' && crosses) continue;
    out.push({ k: f.k, side, s0: Math.round(s0), s1: Math.round(s1), gap: Math.round(minAbs) });
  }
  return out.sort((a, b) => a.s0 - b.s0).slice(0, 8);
}

// ------------------------------------------------------------------ UI
const state = { course: null, holes: null, idx: 0, teeShift: 0, clubs: null, map: null, layers: null, plan: null, sel: 0 };
const K_NAME = { water: 'Vann', bunker: 'Bunker', trees: 'Skog' };
const LIE_COLOR = { fairway: '#4cc38a', green: '#7fe0a8', rough: '#c9d36a', bunker: '#e0c27f', trees: '#8a6d3b', water: '#2f6fb3', oob: '#b3261e', wild: '#b3261e' };

export async function renderStrategy(view, ctx) {
  const { esc, fmt, getProfile, toast, setTitle } = ctx;
  setTitle('Strategi');
  if (!state.clubs) {
    const d = new Date(); const from = new Date(d - 365 * 864e5).toISOString().slice(0, 10);
    const rows = await getProfile(from, d.toISOString().slice(0, 10), 'practice,map_my_bag,course_play');
    state.clubs = rows.filter((r) => r.in_bag && r.category !== 'putter' && r.carry_p50);
  }
  if (!state.course) return renderSearch();
  return renderHole();

  function renderSearch() {
    const recent = ls.get(LS_RECENT) || [];
    view.innerHTML = `<p class="small muted" style="margin-top:8px">Søk opp banen du skal spille. Hull, bunkere og vann hentes fra OpenStreetMap, og strategien bygger på dine egne lengder og spredning fra TrackMan.</p>
      <form id="sf" class="row"><input type="search" id="sq" placeholder="F.eks. Bærum Golfklubb" style="flex:1" autocomplete="off">
      <button class="btn primary" type="submit">Søk</button></form>
      <div id="sres"></div>
      ${recent.length ? `<h3>Nylig brukt</h3><ul class="list card">${recent.map((r, i) => `<li><a href="#/strategi" data-recent="${i}" class="rtitle">${esc(r.name)}</a><div class="small muted">${esc(r.place || '')}</div></li>`).join('')}</ul>` : ''}`;
    const sres = view.querySelector('#sres');
    view.querySelector('#sf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = view.querySelector('#sq').value.trim(); if (!text) return;
      sres.innerHTML = `<div class="loading">Søker…</div>`;
      try {
        const hits = await searchCourses(text);
        sres.innerHTML = hits.length ? `<ul class="list card">${hits.map((h, i) => `<li><a href="#/strategi" data-hit="${i}" class="rtitle">${esc(h.name)}</a><div class="small muted">${esc(h.place)}</div></li>`).join('')}</ul>`
          : `<div class="empty">Fant ingen golfbane med det navnet i OpenStreetMap.</div>`;
        sres.querySelectorAll('[data-hit]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); open(hits[+a.dataset.hit]); });
      } catch (err) { sres.innerHTML = `<div class="card warn">${esc(err.message)}</div>`; }
    });
    view.querySelectorAll('[data-recent]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); open(recent[+a.dataset.recent]); });
  }

  async function open(c) {
    view.innerHTML = `<div class="loading">Henter hull og hindre for ${esc(c.name)}…</div>`;
    try {
      const data = await loadCourse(c);
      const holes = buildHoles(data);
      if (!holes.length) {
        view.innerHTML = `<div class="card warn"><b>${esc(c.name)}</b> har ingen hull tegnet i OpenStreetMap ennå, så strategi kan ikke beregnes.
          <div class="small">Hvem som helst kan tegne hullene på openstreetmap.org. Da virker banen her dagen etter.</div></div>
          <button class="btn" id="back">Søk etter en annen bane</button>`;
        view.querySelector('#back').onclick = () => { state.course = null; renderSearch(); };
        return;
      }
      Object.assign(state, { course: data, holes, idx: 0, teeShift: 0, plan: null });
      renderHole();
    } catch (err) { view.innerHTML = `<div class="card warn">${esc(err.message)}</div><button class="btn" id="back">Tilbake</button>`; view.querySelector('#back').onclick = () => renderSearch(); }
  }

  function renderHole() {
    const h = state.holes[state.idx];
    const counts = { water: 0, bunker: 0, fairway: 0, green: 0 };
    h.near.forEach((f) => { if (counts[f.k] !== undefined) counts[f.k]++; });
    const thin = !counts.fairway && !counts.bunker && !counts.water;
    const plan = planHole(h, state.clubs, state.teeShift);
    state.plan = plan; state.sel = 0;
    const haz = hazardsOf(h, state.teeShift);
    view.innerHTML = `
      <div class="row" style="margin-top:6px"><b style="flex:1">${esc(state.course.name)}</b>
        <button class="btn sm ghost" id="chg">Bytt bane</button></div>
      <div class="hole-nav" id="hn">${state.holes.map((x, i) => `<button class="${i === state.idx ? 'on' : ''}" data-i="${i}">${x.ref ?? i + 1}</button>`).join('')}</div>
      <div class="kpis">
        <div class="kpi"><div class="v">${h.ref ?? state.idx + 1}</div><div class="l">Hull</div></div>
        <div class="kpi"><div class="v">${h.par}</div><div class="l">Par${h.hcp ? ' · hcp ' + h.hcp : ''}</div></div>
        <div class="kpi"><div class="v">${fmt(plan.L)} m</div><div class="l">Lengde (fra kartet)</div></div>
      </div>
      <div class="row small" style="margin-top:8px"><span class="muted">Utslag:</span>
        <div class="seg" id="ts">${[[0, 'Som kartet'], [20, '20 m frem'], [40, '40 m frem']].map(([v, l]) => `<button data-v="${v}" class="${state.teeShift === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div id="map"></div>
      <div class="card" id="opts"></div>
      ${haz.length ? `<div class="card"><b>Hindre</b><ul class="list">${haz.map((z) => `<li class="small">${K_NAME[z.k]} ${z.side === 'over' ? 'tvers over' : z.side} · ${z.s0}–${z.s1} m fra utslag${z.side === 'over' ? ` · <b>carry ${z.s1} m</b> for å gå over` : ` · ${z.gap} m fra midtlinjen`}</li>`).join('')}</ul></div>` : ''}
      ${thin ? `<div class="card warn small">Få detaljer er tegnet for dette hullet i OpenStreetMap (ingen fairway, bunkere eller vann). Forslaget bygger mest på lengden.</div>` : ''}
      <p class="small muted">Beregnet med ${N_SAMPLES} simulerte slag per kølle, fra dine TrackMan-data siste 12 måneder. Simulatorlengder kan avvike fra lengdene ute, særlig i kulde og vind. Kartdata © OpenStreetMap-bidragsytere.</p>`;
    view.querySelector('#hn').onclick = (e) => { const i = e.target.dataset.i; if (i !== undefined) { state.idx = +i; renderHole(); } };
    view.querySelector('#ts').onclick = (e) => { const v = e.target.dataset.v; if (v !== undefined) { state.teeShift = +v; renderHole(); } };
    view.querySelector('#chg').onclick = () => { state.course = null; renderSearch(); };
    drawOptions();
    drawMap();
  }

  function drawOptions() {
    const box = view.querySelector('#opts');
    const { opts } = state.plan;
    if (!opts.length) { box.innerHTML = `<div class="muted">Ingen kølle i bagen passer lengden på dette hullet.</div>`; return; }
    const best = opts[0];
    const aimTxt = (o) => Math.abs(o.aimOff) < 1 ? 'midt i' : `${Math.abs(o.aimOff)} m ${o.aimOff < 0 ? 'venstre' : 'høyre'} for midten`;
    const par3 = state.holes[state.idx].par === 3;
    const bar = (p) => `<div class="meter" aria-hidden="true">${['fairway', 'green', 'rough', 'bunker', 'trees', 'water'].map((k) => p[k] ? `<i style="width:${p[k] * 100}%;background:${LIE_COLOR[k]}"></i>` : '').join('')}</div>`;
    box.innerHTML = `<b>Forslag: ${esc(best.club.club)}</b>, sikt ${aimTxt(best)}.
      <div class="small muted" style="margin-bottom:6px">${par3 ? `Treffer green ${Math.round(best.p.green * 100)} %` : `Fairway ${Math.round(best.p.fairway * 100)} %`}${best.p.water > 0.01 ? ` · vann ${Math.round(best.p.water * 100)} %` : ''}${par3 ? '' : ` · igjen ca. ${fmt(best.remaining)} m`}.</div>` +
      opts.slice(0, 5).map((o, i) => `<div class="opt ${i === 0 ? 'best' : ''}" data-o="${i}" style="cursor:pointer">
        <div class="oname">${esc(o.club.club)}</div><div class="num small">${i === 0 ? 'forventet ' + fmt(o.exp, 2) + ' slag' : (o.exp - best.exp < 0.04 ? 'omtrent like bra' : '+' + fmt(o.exp - best.exp, 2) + ' slag')}</div>
        <div class="ometa">${bar(o.p)}<div style="margin-top:4px">${par3 ? `Green ${Math.round(o.p.green * 100)} %` : `Fairway ${Math.round(o.p.fairway * 100)} %`}
          · rough ${Math.round(o.p.rough * 100)} %${o.p.bunker > 0.01 ? ` · bunker ${Math.round(o.p.bunker * 100)} %` : ''}${o.p.trees > 0.01 ? ` · skog/utenfor ${Math.round(o.p.trees * 100)} %` : ''}${o.p.water > 0.01 ? ` · <b>vann ${Math.round(o.p.water * 100)} %</b>` : ''}
          ${par3 ? '' : ` · igjen ${fmt(o.remaining)} m`} · sikt ${aimTxt(o)}</div></div></div>`).join('') +
      `<div class="small muted" style="margin-top:6px">Trykk på en kølle for å se spredningen på kartet. «Forventet slag» er gjennomsnittlig antall slag på hullet med den køllen fra tee.</div>`;
    box.querySelectorAll('[data-o]').forEach((el) => el.onclick = () => { state.sel = +el.dataset.o; drawDots(); });
  }

  function drawMap() {
    const el = view.querySelector('#map');
    if (typeof L === 'undefined') { el.textContent = 'Kartet kunne ikke lastes.'; return; }
    if (state.map) { state.map.remove(); state.map = null; }
    const h = state.holes[state.idx], P = h.P;
    const map = L.map(el, { zoomControl: false, attributionControl: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 20, maxNativeZoom: 19, attribution: 'Bilder © Esri · Kart © OpenStreetMap' }).addTo(map);
    const ll = (p) => { const g = P.from(p); return [g.lat, g.lon]; };
    const style = { water: { color: '#2f6fb3', fillOpacity: .35 }, bunker: { color: '#e0c27f', fillOpacity: .5 }, green: { color: '#7fe0a8', fillOpacity: .35 },
      fairway: { color: '#4cc38a', fillOpacity: .15 }, tee: { color: '#ffffff', fillOpacity: .2 }, trees: { color: '#3b5d2c', fillOpacity: .15 } };
    for (const f of h.near) {
      const s = style[f.k]; if (!s) continue;
      const latlngs = f.pts.map(ll);
      (f.closed ? L.polygon(latlngs, { ...s, weight: 1 }) : L.polyline(latlngs, { color: s.color, weight: 3 })).addTo(map);
    }
    L.polyline(h.pts.map(ll), { color: '#ffffff', weight: 2, dashArray: '4 6' }).addTo(map);
    L.circleMarker(ll(h.pin), { radius: 5, color: '#fff', fillColor: '#b3261e', fillOpacity: 1, weight: 2 }).addTo(map);
    state.map = map; state.layers = L.layerGroup().addTo(map);
    const bounds = L.latLngBounds(h.pts.map(ll)).pad(0.15);
    map.fitBounds(bounds);
    drawDots();
  }

  function drawDots() {
    if (!state.map || !state.plan.opts.length) return;
    const h = state.holes[state.idx], P = h.P, o = state.plan.opts[state.sel];
    const ll = (p) => { const g = P.from(p); return [g.lat, g.lon]; };
    state.layers.clearLayers();
    L.polyline([ll(state.plan.start), ll(o.target)], { color: '#f2c94c', weight: 2 }).addTo(state.layers);
    for (const d of o.dots) L.circleMarker(ll(d), { radius: 2.5, weight: 0, fillOpacity: .9, fillColor: LIE_COLOR[d.label] || '#fff' }).addTo(state.layers);
    view.querySelectorAll('.opt').forEach((el) => el.style.background = +el.dataset.o === state.sel ? 'var(--accent-soft)' : '');
  }
}

// exported for tests
export const _internals = { projector, polyLen, pointAt, project, inPoly, buildHoles, planHole, hazardsOf, carryQuantile, E };

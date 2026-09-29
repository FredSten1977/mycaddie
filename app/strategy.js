import { catVar } from './charts.js';
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
    const r = await fetchT(u, { headers: { 'Accept-Language': 'no,en' } }, 15000);
    if (!r.ok) throw new Error('Søket feilet (' + r.status + ')');
    return (await r.json()).filter((x) => x.type === 'golf_course' && (x.osm_type === 'way' || x.osm_type === 'relation'));
  };
  let hits = await run(text);
  if (!hits.length && !/golf/i.test(text)) hits = await run(text + ' golf');
  return hits.map((h) => ({ id: h.osm_type[0] + h.osm_id, osm_type: h.osm_type, osm_id: h.osm_id, name: h.name || h.display_name.split(',')[0],
    place: h.display_name.split(',').slice(1, 4).join(',').trim(), lat: +h.lat, lon: +h.lon, bbox: h.boundingbox }));
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

// fetch with a time limit, so a busy map server never leaves the page hanging
async function fetchT(url, opts = {}, ms = 25000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Kartserveren svarte ikke i tide.' : 'Ingen kontakt med kartserveren.'); }
  finally { clearTimeout(t); }
}
async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetchT(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const txt = await r.text();
      if (!r.ok || txt[0] !== '{') throw new Error('Kartserveren er opptatt. Prøv igjen om litt.');
      return JSON.parse(txt);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

let SB = null; // Supabase client, set by renderStrategy
function remember(c, data) {
  ls.set(LS_PREFIX + c.id, data);
  const recent = (ls.get(LS_RECENT) || []).filter((x) => x.id !== c.id);
  recent.unshift({ id: c.id, osm_type: c.osm_type, osm_id: c.osm_id, name: c.name, place: c.place, lat: c.lat, lon: c.lon, bbox: c.bbox });
  ls.set(LS_RECENT, recent.slice(0, 8));
}
async function loadCourse(c, refresh = false) {
  const cachedCourse = ls.get(LS_PREFIX + c.id);
  if (!refresh && cachedCourse && cachedCourse.v === 3) return cachedCourse;
  // 1) the server fetches the course once and keeps it in the database
  if (SB) {
    const { data, error } = await SB.functions.invoke('osm-course', { body: { osm_type: c.osm_type, osm_id: c.osm_id, name: c.name, place: c.place, lat: c.lat, lon: c.lon, bbox: c.bbox, refresh } });
    if (!error && data && data.data) {
      const out = { v: 3, id: c.id, name: c.name || data.name, place: c.place || data.place, lat: c.lat || data.lat, lon: c.lon || data.lon, feats: data.data.feats, elev: data.data.elev || null, loadedAt: data.fetched_at };
      if (out.feats.some((f) => f.k === 'hole')) remember(c, out);
      return out;
    }
    console.warn('osm-course', error);
  }
  // 2) fallback: ask the public map servers directly from the phone
  const sel = c.bbox ? `(${+c.bbox[0] - 0.0015},${+c.bbox[2] - 0.0015},${+c.bbox[1] + 0.0015},${+c.bbox[3] + 0.0015})` : null;
  const qy = sel
    ? `[out:json][timeout:30];(way["golf"]${sel};way["natural"~"^(water|wood|scrub)$"]${sel};way["landuse"="forest"]${sel};way["waterway"]${sel};relation["natural"~"^(water|wood)$"]${sel};);out geom;`
    : `[out:json][timeout:30];${c.osm_type}(${c.osm_id})->.c;.c map_to_area->.a;(way(area.a)["golf"];way(area.a)["natural"~"^(water|wood|scrub)$"];way(area.a)["landuse"="forest"];way(area.a)["waterway"];);out geom;`;
  const j = await overpass(qy);
  const feats = [];
  for (const el of j.elements) {
    const k = kindOf(el.tags); if (!k) continue;
    if (el.type === 'way' && el.geometry) feats.push({ k, tags: el.tags, g: el.geometry.map((p) => ({ lat: p.lat, lon: p.lon })) });
    if (el.type === 'relation' && el.members) for (const m of el.members) if (m.role !== 'inner' && m.geometry) feats.push({ k, tags: el.tags, g: m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })) });
  }
  const data = { v: 3, id: c.id, name: c.name, place: c.place, lat: c.lat, lon: c.lon, feats, elev: null, loadedAt: new Date().toISOString() };
  if (feats.some((f) => f.k === 'hole')) remember(c, data);
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
  const elevPts = (course.elev?.pts || []).map(([lat, lon, z]) => ({ ...P.to({ lat, lon }), z }));
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
    const elev = elevPts.filter((q) => inBox(hb, q, 80));
    const hole = { ref: Number.isFinite(ref) ? ref : null, par, hcp: parseInt(f.tags.handicap, 10) || null, len, pts, pin, near, green, P, elev };
    hole.corridor = corridorOf(hole);
    return hole;
  }).sort((a, b) => (a.ref ?? 99) - (b.ref ?? 99));
  return holes;
}

// ------------------------------------------------------------------ settings (per phone)
const LS_SETTINGS = 'mc_strategy_settings';
const DEFAULTS = { winMin: 100, winMax: 115, offFairway: 'skog', sideInflate: 1.15, risk: 'forsiktig' };
export function getSettings() { return { ...DEFAULTS, ...(ls.get(LS_SETTINGS) || {}) }; }
function saveSettings(s) { ls.set(LS_SETTINGS, s); }

// ------------------------------------------------------------------ terrain
// Height at a point: inverse-distance weighting of the 4 nearest samples (within 70 m).
function elevAt(hole, p) {
  const e = hole.elev; if (!e || !e.length) return null;
  if (!hole.eg) { // bucket grid, 25 m cells
    hole.eg = new Map();
    for (const q of e) { const k = Math.floor(q.x / 25) + ':' + Math.floor(q.y / 25); if (!hole.eg.has(k)) hole.eg.set(k, []); hole.eg.get(k).push(q); }
  }
  const cx = Math.floor(p.x / 25), cy = Math.floor(p.y / 25);
  const best = [];
  for (let r = 1; r <= 3 && best.length < 4; r++) {
    best.length = 0;
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      const b = hole.eg.get(i + ':' + j); if (!b) continue;
      for (const q of b) {
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (best.length < 4) { best.push([d2, q.z]); best.sort((a, c) => a[0] - c[0]); }
        else if (d2 < best[3][0]) { best[3] = [d2, q.z]; best.sort((a, c) => a[0] - c[0]); }
      }
    }
  }
  if (!best.length) return null;
  if (best[0][0] < 1) return best[0][1];
  let w = 0, z = 0; for (const [d2, zz] of best) { const k = 1 / d2; w += k; z += k * zz; }
  return z / w;
}
const dz = (hole, a, b) => { const za = elevAt(hole, a), zb = elevAt(hole, b); return za === null || zb === null ? 0 : zb - za; };
// Landing (descent) angle by club type, used to turn height difference into carry: Δcarry = −Δh / tan(angle)
const DESCENT = { driver: 38, wood: 42, hybrid: 45, iron: 48, wedge: 52 };
const tanDesc = (c) => Math.tan(((DESCENT[c.category] || 46) * Math.PI) / 180);
// plays-like distance for an approach: horizontal distance plus ~0.9 m per metre the green sits higher
function playsLike(hole, from, to) { return dist(from, to) + 0.9 * dz(hole, from, to); }

// Elevation profile along the centre line (for the chart)
function profileOf(hole, teeShift) {
  if (!hole.elev || !hole.elev.length) return null;
  const out = [];
  const L = hole.len;
  for (let s = teeShift; s <= L; s += 5) { const z = elevAt(hole, pointAt(hole.pts, s)); if (z !== null) out.push({ s: s - teeShift, z }); }
  const zp = elevAt(hole, hole.pin); if (zp !== null) out.push({ s: L - teeShift, z: zp });
  return out.length > 3 ? out : null;
}

// ------------------------------------------------------------------ corridor (where is fairway, how wide)
// For every 10 m along the hole: the fairway's left/right edge relative to the centre line (null = not mapped there).
function corridorOf(hole) {
  const fws = hole.near.filter((f) => f.k === 'fairway' && f.closed);
  const rows = [];
  for (let s = 0; s <= hole.len; s += 10) {
    const a = pointAt(hole.pts, Math.max(0, s - 2)), b = pointAt(hole.pts, Math.min(hole.len, s + 2));
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = dy / L, ny = -dx / L; // right-hand normal
    const c = pointAt(hole.pts, s);
    let lo = null, hi = null;
    for (let o = -70; o <= 70; o += 2) {
      const p = { x: c.x + nx * o, y: c.y + ny * o };
      if (fws.some((f) => inBox(f.box, p) && inPoly(f.pts, p))) { if (lo === null) lo = o; hi = o; }
    }
    rows.push(lo === null ? null : { lo, hi });
  }
  return { rows, mapped: fws.length > 0 };
}
function corridorAt(hole, s) { const r = hole.corridor.rows[Math.max(0, Math.min(hole.corridor.rows.length - 1, Math.round(s / 10)))]; return r; }

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
const sideSd = (c, set) => Math.max(3, (+c.side_abs_p80 || 10) / 1.2816) * set.sideInflate;
function sampleShot(c, set, lieFactor = 1) {
  const mishit = rnd() < (+c.mishit_pct || 0) / 100;
  let carry = carryQuantile(c, 0.02 + rnd() * 0.97) * lieFactor;
  let side = (+c.side_mean || 0) + randn() * sideSd(c, set) * (lieFactor < 1 ? 1.3 : 1);
  if (mishit) { carry *= 0.55 + rnd() * 0.25; side *= 1.4; }
  const roll = Math.max(0, (+c.total_p50 || +c.carry_p50) - +c.carry_p50) * (mishit ? 1.3 : 1);
  return { carry, side, roll };
}

// Expected strokes to hole out from a (plays-like) distance and lie – rough model for a mid-handicap player
function E(d, lie) {
  const fw = d <= 20 ? 2.35 : 2.45 + 0.0055 * d;
  switch (lie) {
    case 'green': return 1.35 + 0.3 * Math.log1p(Math.max(0, d));
    case 'fairway': case 'tee': return fw;
    case 'rough': return fw + 0.22;
    case 'bunker': return d <= 40 ? 2.85 + 0.004 * d : fw + 0.45;
    case 'trees': return fw + 0.8;
    default: return fw + 0.22;
  }
}
// Mapped features first; where nothing is mapped, use the fairway corridor and the "off fairway" setting.
function lieAt(hole, p, set) {
  let lie = null;
  for (const f of hole.near) {
    if (!inBox(f.box, p, f.closed ? 0 : 6)) continue;
    const hit = f.closed ? inPoly(f.pts, p) : distToLine(f.pts, p) < 4;
    if (!hit) continue;
    if (f.k === 'water') return 'water';
    if (f.k === 'oob') return 'oob';
    if (f.k === 'bunker') lie = 'bunker';
    else if (f.k === 'green' && lie !== 'bunker') lie = 'green';
    else if ((f.k === 'fairway' || f.k === 'tee') && lie !== 'bunker' && lie !== 'green') lie = 'fairway';
    else if (f.k === 'rough' && !lie) lie = 'rough';
    else if (f.k === 'trees' && !lie) lie = 'trees';
  }
  if (lie) return lie;
  const pr = project(hole.pts, p);
  const cor = corridorAt(hole, pr.s);
  let lo = -15, hi = 15;
  if (cor) { lo = cor.lo; hi = cor.hi; }
  else if (hole.corridor.mapped) { lo = -12; hi = 12; } // fairway mapped elsewhere on the hole but not here (carry area): treat as rough
  const out = pr.lat < lo ? lo - pr.lat : pr.lat > hi ? pr.lat - hi : 0;
  if (out === 0) return hole.corridor.mapped ? 'rough' : 'fairway';
  if (out <= 12) return 'rough';
  if (set.offFairway === 'skog') return out > 35 ? 'lost' : 'trees';
  return out > 60 ? 'trees' : 'rough';
}

// One shot: flat carry is corrected for height difference at the landing spot, roll for the slope.
function shoot(hole, club, start, aim, set, lieFactor = 1) {
  const ax = aim.x - start.x, ay = aim.y - start.y, AL = Math.hypot(ax, ay) || 1;
  const vx = ax / AL, vy = ay / AL, nx = vy, ny = -vx;
  const s = sampleShot(club, set, lieFactor);
  const z0 = elevAt(hole, start), t = tanDesc(club);
  let carry = s.carry, land;
  for (let it = 0; it < 2; it++) {
    land = { x: start.x + vx * carry + nx * s.side, y: start.y + vy * carry + ny * s.side };
    const z1 = elevAt(hole, land);
    if (z0 === null || z1 === null) break;
    carry = Math.max(5, s.carry - (z1 - z0) / t);
  }
  let lie = lieAt(hole, land, set), end = land, pen = 0, label = lie;
  if (lie === 'water') { pen = 1; lie = 'rough'; label = 'water'; }
  else if (lie === 'oob' || lie === 'lost') { pen = 2; lie = 'tee'; end = start; label = 'oob'; } // stroke and distance
  else if (lie === 'fairway' || lie === 'rough') {
    const za = elevAt(hole, land), zb = elevAt(hole, { x: land.x + vx * 10, y: land.y + vy * 10 });
    const grade = za === null || zb === null ? 0 : (zb - za) / 10;
    const r = s.roll * (lie === 'fairway' ? 1 : 0.4) * Math.max(0.4, Math.min(1.8, 1 - 6 * grade));
    const e2 = { x: land.x + vx * r, y: land.y + vy * r };
    const lie2 = lieAt(hole, e2, set);
    if (lie2 === 'water') { pen = 1; lie = 'rough'; label = 'water'; }
    else if (lie2 === 'oob' || lie2 === 'lost') { end = land; }
    else { end = e2; lie = lie2; label = lie2; }
  }
  return { end, lie, pen, label, land };
}
const LIE_FACTOR = { fairway: 1, tee: 1, rough: 0.93, bunker: 0.85, trees: 0.6, green: 1 };
const winPenalty = (d, set) => { const out = d < set.winMin ? set.winMin - d : d > set.winMax ? d - set.winMax : 0; return Math.min(0.4, 0.008 * out); };
// Careful play: extra cost for trouble (trees, water, out) and bunkers, on top of the expected strokes
const RISK = { forsiktig: { trouble: 0.6, bunker: 0.25 }, 'nøytral': { trouble: 0, bunker: 0 } };

// Pick the club whose normal total distance best matches a plays-like distance (longest club first when short of reach)
function clubFor(clubs, need, { allowDriver = false } = {}) {
  const cands = clubs.filter((c) => allowDriver || c.category !== 'driver');
  let best = null;
  for (const c of cands) { const d = Math.abs((+c.total_p50 || +c.carry_p50) - need); if (!best || d < best.d) best = { c, d }; }
  return best && best.c;
}
// Point on the centre line that leaves a given plays-like distance to the pin
function layupPoint(hole, want) {
  let bestS = 0, bestD = Infinity;
  for (let s = 0; s <= hole.len; s += 5) { const p = pointAt(hole.pts, s); const d = Math.abs(playsLike(hole, p, hole.pin) - want); if (d < bestD) { bestD = d; bestS = s; } }
  return { s: bestS, p: pointAt(hole.pts, bestS) };
}

// Simulate a tee club (+ planned layup on par 5) and score it: expected strokes + penalty outside your approach window.
function evaluate(hole, club, start, aimOff, set, clubs, n) {
  const L = hole.len;
  const par3 = hole.par === 3, par5 = hole.par === 5;
  const reach = par3 ? L : Math.min(+club.total_p50 || +club.carry_p50, L - 5);
  const sStart = project(hole.pts, start).s;
  const base = par3 ? hole.pin : pointAt(hole.pts, Math.min(L, sStart + reach));
  const dx = base.x - start.x, dy = base.y - start.y, BL = Math.hypot(dx, dy) || 1;
  const aim = { x: base.x + (dy / BL) * aimOff, y: base.y + (-dx / BL) * aimOff };
  const want = (set.winMin + set.winMax) / 2;
  const lay = par5 ? layupPoint(hole, want) : null;
  seed(12345);
  let sum = 0, inWin = 0; const cnt = {}; const rem = []; const dots = []; const dots2 = []; const second = {};
  for (let i = 0; i < n; i++) {
    const t = shoot(hole, club, start, aim, set);
    let strokes = 1 + t.pen, pos = t.end, lie = t.lie;
    cnt[t.label] = (cnt[t.label] || 0) + 1;
    if (i < 160) dots.push({ ...t.end, label: t.label });
    if (par5) {
      // second shot: lay up to the window (or go for it if within reach of a normal club)
      const toPin = playsLike(hole, pos, hole.pin);
      const need = playsLike(hole, pos, lay.p);
      const layClub = clubFor(clubs, need) || club;
      const goClub = clubFor(clubs, toPin);
      const canGo = goClub && Math.abs((+goClub.carry_p50) - toPin) < 12 && lie !== 'trees';
      const c2 = canGo ? goClub : layClub;
      const tgt2 = canGo ? hole.pin : lay.p;
      const t2 = shoot(hole, c2, pos, tgt2, set, LIE_FACTOR[lie] || 1);
      strokes += 1 + t2.pen; pos = t2.end; lie = t2.lie;
      const key = canGo ? 'go:' + c2.club : c2.club; second[key] = (second[key] || 0) + 1;
      if (i < 120) dots2.push({ ...t2.end, label: t2.label });
    }
    const d = playsLike(hole, pos, hole.pin);
    const wp = par3 ? 0 : winPenalty(d, set);
    if (!par3 && d >= set.winMin - 5 && d <= set.winMax + 5) inWin++;
    sum += strokes + E(d, lie) + wp;
    rem.push(d);
  }
  rem.sort((a, b) => a - b);
  const pc = (k) => (cnt[k] || 0) / n;
  const rk = RISK[set.risk] || RISK.forsiktig;
  const riskCost = rk.trouble * (pc('trees') + pc('water') + pc('oob')) + rk.bunker * pc('bunker');
  const sec = Object.entries(second).sort((a, b) => b[1] - a[1])[0];
  return { club, aimOff, score: sum / n + riskCost, exp: sum / n, p: { fairway: pc('fairway'), green: pc('green'), rough: pc('rough'), bunker: pc('bunker'),
    trees: pc('trees'), water: pc('water'), oob: pc('oob') }, remaining: rem[Math.floor(n / 2)], inWin: inWin / n,
    dots, dots2, target: aim, lay, second: sec ? { club: sec[0].replace(/^go:/, ''), go: sec[0].startsWith('go:'), share: sec[1] / n } : null };
}

function planHole(hole, clubs, teeShift, set) {
  const start = pointAt(hole.pts, Math.max(0, teeShift));
  const L = hole.len - teeShift;
  const offsets = [-14, -7, 0, 7, 14];
  const opts = [];
  const plPin = playsLike(hole, start, hole.pin);
  const cands = hole.par === 3
    ? clubs.filter((c) => +c.carry_p50 > plPin * 0.8 && +c.carry_p50 < plPin * 1.2)
    : clubs.filter((c) => c.category !== 'wedge' && +c.carry_p50 >= 110 && +c.carry_p50 < L + 20);
  for (const c of cands) {
    let best = null;
    for (const o of offsets) { const r = evaluate(hole, c, start, o, set, clubs, 120); if (!best || r.score < best.score) best = r; }
    opts.push(evaluate(hole, c, start, best.aimOff, set, clubs, N_SAMPLES));
  }
  opts.sort((a, b) => a.score - b.score);
  return { start, L, plPin, opts };
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
const short = (n) => n.replace('Pitching Wedge', 'PW').replace(' Iron', '-jern').replace(' Wood', '-wood').replace(' Hybrid', '-hybrid');

function profileSvg(prof, fmt) {
  const W = 340, H = 120, pl = 34, pr = 10, pt = 12, pb = 22;
  const zs = prof.map((p) => p.z), zmin = Math.min(...zs), zmax = Math.max(...zs);
  const span = Math.max(8, zmax - zmin), z0 = zmin - span * 0.15, z1 = zmax + span * 0.15;
  const smax = prof[prof.length - 1].s;
  const X = (s) => pl + (s / smax) * (W - pl - pr), Y = (z) => pt + ((z1 - z) / (z1 - z0)) * (H - pt - pb);
  const line = prof.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)},${Y(p.z).toFixed(1)}`).join('');
  const area = line + `L${X(smax)},${H - pb}L${X(0)},${H - pb}Z`;
  const zt = prof[0].z, zg = prof[prof.length - 1].z;
  let ticks = ''; for (let s = 50; s < smax; s += 50) ticks += `<text x="${X(s)}" y="${H - 6}" class="axis" text-anchor="middle">${s}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Høydeprofil fra tee til green">
    <path d="${area}" fill="color-mix(in srgb, var(--accent) 18%, transparent)"/><path d="${line}" class="trend"/>
    <line x1="${pl}" x2="${W - pr}" y1="${Y(zt)}" y2="${Y(zt)}" class="grid zero"/>
    <text x="${pl - 4}" y="${Y(zt) + 4}" class="axis" text-anchor="end">tee</text>
    <circle cx="${X(smax)}" cy="${Y(zg)}" r="4" fill="var(--bad)"/>
    <text x="${X(smax) - 6}" y="${Y(zg) - 8}" class="axis" text-anchor="end">${zg - zt > 0 ? '+' : ''}${fmt(zg - zt)} m</text>
    ${ticks}</svg>`;
}

export async function renderStrategy(view, ctx) {
  const { esc, fmt, getProfile, toast, setTitle } = ctx;
  SB = ctx.sb;
  setTitle('Strategi');
  if (!state.clubs) {
    const d = new Date(); const from = new Date(d - 365 * 864e5).toISOString().slice(0, 10);
    const rows = await getProfile(from, d.toISOString().slice(0, 10), 'practice,map_my_bag,course_play');
    state.clubs = rows.filter((r) => r.in_bag && r.category !== 'putter' && r.carry_p50);
  }
  if (!state.course) return renderSearch();
  return renderHole();

  async function renderSearch() {
    const recent = ls.get(LS_RECENT) || [];
    let saved = [];
    try { const { data } = await SB.from('course_maps').select('id,name,place,lat,lon,holes').order('fetched_at', { ascending: false }).limit(30); saved = (data || []).filter((x) => !recent.some((r) => r.id === x.id)); } catch { /* offline */ }
    const pick = [...recent, ...saved.map((x) => ({ id: x.id, osm_type: x.id[0] === 'r' ? 'relation' : 'way', osm_id: +x.id.slice(1), name: x.name, place: x.place, lat: x.lat, lon: x.lon, holes: x.holes }))];
    view.innerHTML = `<section class="hero" style="padding-bottom:16px"><div class="eyebrow">Strategi ute</div>
        <div style="font-size:22px;font-weight:750;margin:4px 0 6px">Hvilken bane skal du spille?</div>
        <div class="sub">Hull, bunkere og vann fra OpenStreetMap, høyder fra Kartverket. Kølle og siktelinje regnes ut fra dine egne lengder og spredning fra TrackMan.</div></section>
      <form id="sf" class="row"><input type="search" id="sq" placeholder="F.eks. Bærum Golfklubb" style="flex:1" autocomplete="off">
      <button class="btn primary" type="submit">Søk</button></form>
      <div id="sres"></div>
      ${pick.length ? `<h2>Dine baner</h2><div class="card"><ul class="list">${pick.map((r, i) => `<li><a href="#/strategi" data-recent="${i}" class="rtitle">${esc(r.name)}</a><div class="small muted">${esc(r.place || '')}${r.holes ? ' · ' + r.holes + ' hull lagret' : ' · lagret på telefonen'}</div></li>`).join('')}</ul></div>` : ''}`;
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
    view.querySelectorAll('[data-recent]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); open(pick[+a.dataset.recent]); });
  }

  async function open(c) {
    view.innerHTML = `<div class="loading">Henter hull, hindre og høyder for ${esc(c.name)}…<div class="small">Første gang kan det ta opptil ett minutt. Deretter er banen lagret.</div></div>`;
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
    } catch (err) { view.innerHTML = `<div class="card warn">${esc(err.message)} Prøv igjen om litt.</div><div class="row"><button class="btn primary" id="retry">Prøv igjen</button><button class="btn" id="back">Tilbake</button></div>`;
      view.querySelector('#retry').onclick = () => open(c); view.querySelector('#back').onclick = () => renderSearch(); }
  }

  function renderHole() {
    const set = getSettings();
    const h = state.holes[state.idx];
    const counts = { water: 0, bunker: 0, fairway: 0, green: 0 };
    h.near.forEach((f) => { if (counts[f.k] !== undefined) counts[f.k]++; });
    const thin = !counts.fairway && !counts.bunker && !counts.water;
    const plan = planHole(h, state.clubs, state.teeShift, set);
    state.plan = plan; state.sel = 0;
    const haz = hazardsOf(h, state.teeShift);
    const prof = profileOf(h, state.teeShift);
    const dzHole = prof ? prof[prof.length - 1].z - prof[0].z : null;
    view.innerHTML = `
      <div class="row" style="margin-top:6px"><b style="flex:1">${esc(state.course.name)}</b>
        <button class="btn sm ghost" id="chg">Bytt bane</button></div>
      <div class="hole-nav" id="hn">${state.holes.map((x, i) => `<button class="${i === state.idx ? 'on' : ''}" data-i="${i}">${x.ref ?? i + 1}</button>`).join('')}</div>
      <div class="kpis">
        <div class="kpi"><div class="v">${h.ref ?? state.idx + 1}</div><div class="l">Hull · par ${h.par}${h.hcp ? ' · hcp ' + h.hcp : ''}</div></div>
        <div class="kpi"><div class="v">${fmt(plan.L)} m</div><div class="l">Lengde på kartet</div></div>
        <div class="kpi"><div class="v">${fmt(plan.plPin)} m</div><div class="l">Spiller som${dzHole !== null ? ` (${dzHole > 0 ? '+' : ''}${fmt(dzHole)} m)` : ''}</div></div>
      </div>
      <div class="row small" style="margin-top:10px"><span class="muted">Utslag:</span>
        <div class="seg" id="ts">${[[0, 'Som kartet'], [20, '20 m frem'], [40, '40 m frem']].map(([v, l]) => `<button data-v="${v}" class="${state.teeShift === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div id="map"></div>
      <div class="card" id="opts"></div>
      ${prof ? `<div class="card"><div class="row"><b>Høydeprofil</b><span class="spacer"></span><span class="small muted">${esc(state.course.elev?.src || '')}</span></div>${profileSvg(prof, fmt)}</div>`
        : `<div class="card warn small">Mangler høydedata for denne banen. Lengdene er ikke justert for opp- og nedoverbakke. Trykk «Hent på nytt» nederst.</div>`}
      ${haz.length ? `<div class="card"><b>Hindre</b><ul class="list">${haz.map((z) => `<li class="small">${K_NAME[z.k]} ${z.side === 'over' ? 'tvers over' : z.side} · ${z.s0}–${z.s1} m fra utslag${z.side === 'over' ? ` · <b>carry ${z.s1} m</b> for å gå over` : ` · ${z.gap} m fra midtlinjen`}</li>`).join('')}</ul></div>` : ''}
      ${thin ? `<div class="card warn small">Få detaljer er tegnet for dette hullet i OpenStreetMap (ingen fairway, bunkere eller vann). Forslaget bygger mest på lengde og spredning.</div>` : ''}
      <details class="card" id="setbox"><summary>Din strategi og forutsetninger</summary>
        <label>Ønsket innspill på par 4 og par 5 (meter, spiller som)</label>
        <div class="row"><input type="number" id="wmin" value="${set.winMin}" style="width:90px"> – <input type="number" id="wmax" value="${set.winMax}" style="width:90px"></div>
        <label>Terreng utenfor fairway og rough når det ikke er tegnet på kartet</label>
        <div class="seg" id="offf">${[['skog', 'Skog / out'], ['åpent', 'Åpent']].map(([v, l]) => `<button data-v="${v}" class="${set.offFairway === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label>Risiko</label>
        <div class="seg" id="risk">${[['forsiktig', 'Forsiktig'], ['nøytral', 'Nøytral']].map(([v, l]) => `<button data-v="${v}" class="${set.risk === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label>Ekstra spredning ute i forhold til simulatoren</label>
        <div class="seg" id="infl">${[[1, 'Ingen'], [1.15, '+15 %'], [1.3, '+30 %']].map(([v, l]) => `<button data-v="${v}" class="${set.sideInflate === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="row" style="margin-top:12px"><button class="btn sm" id="refetch">Hent banedata på nytt</button></div>
      </details>
      <p class="small muted">Hver kølle er testet med ${N_SAMPLES} simulerte slag med din lengde og spredning (siste 12 måneder), korrigert for høydeforskjell. Poengsummen er forventet antall slag på hullet, pluss et tillegg når innspillet havner utenfor ${set.winMin}–${set.winMax} m${set.risk === 'forsiktig' ? ', og et tillegg for risiko (skog, vann, out og bunker)' : ''}. Kartdata © OpenStreetMap-bidragsytere.</p>`;
    view.querySelector('#hn').onclick = (e) => { const i = e.target.dataset.i; if (i !== undefined) { state.idx = +i; renderHole(); } };
    view.querySelector('#ts').onclick = (e) => { const v = e.target.dataset.v; if (v !== undefined) { state.teeShift = +v; renderHole(); } };
    view.querySelector('#chg').onclick = () => { state.course = null; renderSearch(); };
    const upd = (patch) => { saveSettings({ ...getSettings(), ...patch }); renderHole(); view.querySelector('#setbox').open = true; };
    view.querySelector('#wmin').onchange = (e) => { const v = +e.target.value; if (v > 30 && v < 250) upd({ winMin: v, winMax: Math.max(v + 5, getSettings().winMax) }); };
    view.querySelector('#wmax').onchange = (e) => { const v = +e.target.value; if (v > 30 && v < 260) upd({ winMax: v, winMin: Math.min(v - 5, getSettings().winMin) }); };
    view.querySelector('#offf').onclick = (e) => { const v = e.target.dataset.v; if (v) upd({ offFairway: v }); };
    view.querySelector('#risk').onclick = (e) => { const v = e.target.dataset.v; if (v) upd({ risk: v }); };
    view.querySelector('#infl').onclick = (e) => { const v = e.target.dataset.v; if (v) upd({ sideInflate: +v }); };
    view.querySelector('#refetch').onclick = async () => {
      const c = state.course; const src = (ls.get(LS_RECENT) || []).find((r) => r.id === c.id) || { id: c.id, osm_type: c.id[0] === 'r' ? 'relation' : 'way', osm_id: +c.id.slice(1), name: c.name, place: c.place, lat: c.lat, lon: c.lon };
      view.innerHTML = `<div class="loading">Henter ${esc(c.name)} på nytt…</div>`;
      try { const data = await loadCourse(src, true); Object.assign(state, { course: data, holes: buildHoles(data) }); renderHole(); } catch (err) { toast(err.message); renderHole(); }
    };
    drawOptions(set);
    drawMap();
  }

  function drawOptions(set) {
    const box = view.querySelector('#opts');
    const { opts } = state.plan;
    const h = state.holes[state.idx];
    if (!opts.length) { box.innerHTML = `<div class="muted">Ingen kølle i bagen passer lengden på dette hullet.</div>`; return; }
    const best = opts[0];
    const aimTxt = (o) => Math.abs(o.aimOff) < 1 ? 'midt i fairway' : `${Math.abs(o.aimOff)} m ${o.aimOff < 0 ? 'venstre' : 'høyre'} for midten`;
    const par3 = h.par === 3, par5 = h.par === 5;
    const bar = (p) => `<div class="meter" aria-hidden="true">${['fairway', 'green', 'rough', 'bunker', 'trees', 'water', 'oob'].map((k) => p[k] ? `<i style="width:${p[k] * 100}%;background:${LIE_COLOR[k]}"></i>` : '').join('')}</div>`;
    // corridor at the landing zone of the best club vs its spread
    const landS = Math.min(h.len, state.teeShift + (+best.club.total_p50 || +best.club.carry_p50));
    const cor = corridorAt(h, landS);
    const width = cor ? cor.hi - cor.lo : null;
    const spread = Math.round(sideSd(best.club, set) * 1.2816);
    const planTxt = (o) => par3 ? `${esc(o.club.club)} mot green`
      : par5 && o.second ? `${esc(short(o.club.club))} → ${o.second.go ? 'gå for green med ' : ''}${esc(short(o.second.club))}${o.second.go ? '' : ` → ${fmt(o.remaining)} m inn`}`
      : `${esc(short(o.club.club))} → ${fmt(o.remaining)} m inn`;
    box.innerHTML = `<div class="tip-card"><div class="club-badge" style="background:${catVar(best.club.category)}">${esc(best.club.club.replace('Pitching Wedge', 'PW')).replace(' ', '<br>')}</div>
      <div><div class="small muted">Anbefalt fra tee</div><div style="font-size:18px;font-weight:750">${esc(best.club.club)}, sikt ${aimTxt(best)}</div>
      <div class="small" style="margin-top:2px">${planTxt(best)}</div>
      <div class="small muted" style="margin-top:2px">${par3 ? `Treffer green ${Math.round(best.p.green * 100)} %` : `Fairway ${Math.round(best.p.fairway * 100)} % · i innspillsvinduet ${Math.round(best.inWin * 100)} %`}${best.p.water + best.p.oob > 0.01 ? ` · straff ${Math.round((best.p.water + best.p.oob) * 100)} %` : ''}</div>
      ${!par3 ? `<div class="small muted">${width !== null ? `Fairway ca. ${fmt(width)} m bred der ballen lander` : 'Fairwaybredde ikke tegnet her'} · din spredning ±${spread} m</div>` : ''}</div></div>
      <div class="legend" style="margin-top:12px">${[['fairway', 'Fairway'], ['green', 'Green'], ['rough', 'Rough'], ['bunker', 'Bunker'], ['trees', 'Skog'], ['water', 'Vann'], ['oob', 'Out/tapt']].map(([k, l]) => `<span><i style="background:${LIE_COLOR[k]}"></i>${l}</span>`).join('')}</div>` +
      opts.slice(0, 5).map((o, i) => `<div class="opt ${i === 0 ? 'best' : ''}" data-o="${i}" style="cursor:pointer">
        <div class="oname">${esc(o.club.club)}</div><div class="num small">${i === 0 ? 'poeng ' + fmt(o.score, 2) : (o.score - best.score < 0.04 ? 'omtrent like bra' : '+' + fmt(o.score - best.score, 2))}</div>
        <div class="ometa">${bar(o.p)}<div style="margin-top:4px">${planTxt(o)} · sikt ${aimTxt(o)}</div>
        <div>${par3 ? `Green ${Math.round(o.p.green * 100)} %` : `Fairway ${Math.round(o.p.fairway * 100)} % · vindu ${Math.round(o.inWin * 100)} %`}
          · rough ${Math.round(o.p.rough * 100)} %${o.p.bunker > 0.01 ? ` · bunker ${Math.round(o.p.bunker * 100)} %` : ''}${o.p.trees > 0.01 ? ` · skog ${Math.round(o.p.trees * 100)} %` : ''}${o.p.water > 0.01 ? ` · <b>vann ${Math.round(o.p.water * 100)} %</b>` : ''}${o.p.oob > 0.01 ? ` · <b>out ${Math.round(o.p.oob * 100)} %</b>` : ''}
          · spredning ±${Math.round(sideSd(o.club, set) * 1.2816)} m</div></div></div>`).join('') +
      `<div class="small muted" style="margin-top:6px">Trykk på en kølle for å se spredningen på kartet${par5 ? ' (små prikker: utslag, ringer: andreslag)' : ''}. Lavest poeng er best.</div>`;
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
    if (o.lay) L.circleMarker(ll(o.lay.p), { radius: 7, color: '#f2c94c', weight: 2, fillOpacity: 0 }).addTo(state.layers);
    for (const d of o.dots) L.circleMarker(ll(d), { radius: 2.5, weight: 0, fillOpacity: .9, fillColor: LIE_COLOR[d.label] || '#fff' }).addTo(state.layers);
    for (const d of o.dots2 || []) L.circleMarker(ll(d), { radius: 3, weight: 1.5, color: LIE_COLOR[d.label] || '#fff', fillOpacity: 0 }).addTo(state.layers);
    view.querySelectorAll('.opt').forEach((el) => el.style.background = +el.dataset.o === state.sel ? 'var(--accent-soft)' : '');
  }
}

// exported for tests
export const _internals = { projector, polyLen, pointAt, project, inPoly, buildHoles, planHole, hazardsOf, carryQuantile, E, elevAt, playsLike, getSettings };

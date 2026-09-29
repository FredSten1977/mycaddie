import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { recommend, courseFeatures } from './recommend.js';
import { renderStrategy } from './strategy.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $title = document.getElementById('title');

// ---------------------------------------------------------------- helpers
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (v, d = 0) => (v === null || v === undefined || v === '' || Number.isNaN(+v)) ? '–'
  : Number(v).toLocaleString('nb-NO', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 1) => (v === null || v === undefined) ? '–' : (v > 0 ? '+' : '') + fmt(v, d);
const dateNo = (d) => d ? new Date(d).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const cleanName = (s) => String(s || '').replace(/[‎‏]/g, '').trim();

export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
async function q(promise) {
  const { data, error } = await promise;
  if (error) { console.error(error); throw new Error(error.message || String(error)); }
  return data;
}
const cache = new Map();
async function cached(key, fn, ttlMs = 5 * 60e3) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn(); cache.set(key, { t: Date.now(), v }); return v;
}
function invalidate(prefix) { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); }

function starsHtml(n, { interactive = false, kind = '', course = '', tm = '' } = {}) {
  if (!interactive) return n ? `<span class="stars ro" aria-label="${n} av 5 stjerner">${'<span>★</span>'.repeat(n)}</span>` : '';
  let h = `<span class="stars" role="group" aria-label="Gi stjerner" data-kind="${esc(kind)}" data-course="${esc(course)}" data-tm="${esc(tm)}">`;
  for (let i = 1; i <= 5; i++) h += `<button type="button" class="${i <= (n || 0) ? 'on' : ''}" data-stars="${i}" aria-label="${i} stjerner">★</button>`;
  return h + '</span>';
}
function wireStars(root, onChange) {
  root.querySelectorAll('.stars:not(.ro)').forEach((g) => {
    g.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-stars]'); if (!b) return;
      const stars = +b.dataset.stars;
      g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.stars <= stars));
      try {
        await rateCourse(g.dataset.kind, g.dataset.course, stars, g.dataset.tm || null);
        toast(`${stars} ★ lagret for ${g.dataset.course}`);
        onChange && onChange();
      } catch (err) { toast('Kunne ikke lagre: ' + err.message); }
    });
  });
}
async function rateCourse(kind, course_name, stars, tm_course_id) {
  await q(sb.from('course_ratings').upsert({ kind, course_name: cleanName(course_name), stars, tm_course_id: tm_course_id || null,
    rated_at: new Date().toISOString() }, { onConflict: 'owner_id,kind,course_key' }));
  invalidate('courses');
}

// ---------------------------------------------------------------- data
const getClubs = () => cached('clubs', () => q(sb.from('clubs').select('id,name,category,sort_order,loft_deg').order('sort_order')), 60 * 60e3);
const getOverview = () => cached('courses:overview', () => q(sb.rpc('course_overview')));
const getCatalog = () => cached('courses:catalog', () => q(sb.from('tm_courses')
  .select('id,name,name_key,location,lat,lon,difficulty,holes,tags,description,par,length_m,slope,course_rating,fictional,updated_at')
  .limit(2000)), 30 * 60e3);
export const getProfile = (from, to, acts) => cached(`profile:${from}:${to}:${acts}`, () =>
  q(sb.rpc('club_profile', { p_from: from, p_to: to, p_activities: acts.split(',') })));
const reviewCount = () => cached('review:count', async () => {
  const { count, error } = await sb.from('v_shots').select('id', { count: 'exact', head: true })
    .like('reason', '%mulig feil kølle%').eq('club_reviewed', false).eq('excluded', false);
  if (error) throw error; return count || 0;
}, 60e3);

// ---------------------------------------------------------------- auth
async function renderLogin() {
  $tabs.hidden = true; document.getElementById('btn-account').hidden = true; $title.textContent = 'My Caddie';
  $view.innerHTML = `
    <div class="card" style="margin-top:28px">
      <h2 style="margin-top:0">Logg inn</h2>
      <p class="muted small">Bruk den samme My Caddie-brukeren som i Chrome-utvidelsen.</p>
      <form id="login">
        <label for="em">E-post</label><input id="em" type="email" autocomplete="username" required>
        <label for="pw">Passord</label><input id="pw" type="password" autocomplete="current-password" required>
        <div class="row" style="margin-top:14px"><button class="btn primary" type="submit">Logg inn</button><span id="lerr" class="small" style="color:var(--bad)"></span></div>
      </form>
    </div>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: em.value.trim(), password: pw.value });
    if (error) { document.getElementById('lerr').textContent = 'Feil e-post eller passord.'; return; }
    route();
  });
}

// ---------------------------------------------------------------- home
async function renderHome() {
  $title.textContent = 'My Caddie';
  $view.innerHTML = `<div class="loading">Laster…</div>`;
  const [sync, nReview, overview, summary] = await Promise.all([
    q(sb.from('sync_runs').select('started_at,status,new_shots,message').order('started_at', { ascending: false }).limit(1)),
    reviewCount(),
    getOverview(),
    cached('summary:365', () => q(sb.rpc('round_summary', { p_from: isoDaysAgo(365), p_to: today() }))),
  ]);
  const last = sync[0];
  const ageDays = last ? (Date.now() - new Date(last.started_at)) / 864e5 : Infinity;
  const unrated = overview.filter((c) => !c.stars && c.last_played >= isoDaysAgo(45)).slice(0, 4);
  const sim18 = summary.find((s) => s.kind === 'simulator' && s.holes === 18);
  const out = summary.find((s) => s.kind === 'outdoor');

  let h = '';
  if (ageDays > 7) h += `<div class="card warn"><b>TrackMan-synken har ikke gått på ${last ? Math.floor(ageDays) + ' dager' : 'lenge'}.</b>
    <div class="small">Åpne Chrome med My Caddie Sync, eller trykk «Synk nå» i utvidelsen.</div></div>`;
  if (nReview > 0) h += `<a class="card link accent" href="#/sjekk"><div class="row"><div><b>${fmt(nReview)} slag passer ikke med valgt kølle</b>
    <div class="small muted">Trolig glemt å bytte kølle i simulatoren. Bekreft med ett trykk.</div></div><span class="spacer"></span><span>›</span></div></a>`;
  if (unrated.length) {
    h += `<div class="card"><b>Hva syntes du om banene?</b><ul class="list">` + unrated.map((c) =>
      `<li><div class="row"><div><div class="rtitle">${esc(cleanName(c.course_name))}</div><div class="small muted">${c.kind === 'outdoor' ? 'Ute' : 'Simulator'} · ${dateNo(c.last_played)}</div></div>
       <span class="spacer"></span>${starsHtml(0, { interactive: true, kind: c.kind, course: cleanName(c.course_name), tm: c.tm_course_id || '' })}</div></li>`).join('') + `</ul></div>`;
  }
  if (sim18) h += `<h2>Simulator, 18 hull <span class="small muted">siste 12 mnd</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="v">${signed(+sim18.to_par_avg)}</div><div class="l">Snitt mot par (${sim18.rounds} runder)</div></div>
      <div class="kpi"><div class="v">${signed(+sim18.last5_to_par_avg)}</div><div class="l">Siste 5 runder</div></div>
      <div class="kpi"><div class="v">${fmt(sim18.fir_pct)} %</div><div class="l">Fairway</div></div>
      <div class="kpi"><div class="v">${fmt(sim18.gir_pct)} %</div><div class="l">Green i regulation</div></div>
      <div class="kpi"><div class="v">${fmt(sim18.putts_avg, 1)}</div><div class="l">Putter per runde</div></div>
    </div>`;
  if (out) h += `<h2>Ute <span class="small muted">siste 12 mnd</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(out.strokes_avg, 1)}</div><div class="l">Snitt slag (${out.rounds} runder)</div></div>
      <div class="kpi"><div class="v">${fmt(out.strokes_best)}</div><div class="l">Beste</div></div>
      <div class="kpi"><div class="v">${fmt(out.stableford_avg, 1)}</div><div class="l">Stableford</div></div>
    </div>`;
  h += `<p class="small muted" style="margin-top:18px">Sist synket: ${last ? new Date(last.started_at).toLocaleString('nb-NO', { dateStyle: 'medium', timeStyle: 'short' }) : 'aldri'}</p>`;
  $view.innerHTML = h;
  wireStars($view, () => renderHome());
}

// ---------------------------------------------------------------- bag
const bagState = { period: '12m', src: 'all', showAll: false };
async function renderBag() {
  $title.textContent = 'Min bag';
  const periods = { '3m': [isoDaysAgo(91), '3 mnd'], '12m': [isoDaysAgo(365), '12 mnd'], 'ytd': [new Date().getFullYear() + '-01-01', 'I år'] };
  const srcs = { all: ['practice,map_my_bag,course_play', 'Alle slag'], train: ['practice,map_my_bag', 'Trening'], play: ['course_play', 'Runder'] };
  $view.innerHTML = `
    <div class="row" style="margin-top:6px">
      <div class="seg" id="per">${Object.entries(periods).map(([k, v]) => `<button data-k="${k}" class="${bagState.period === k ? 'on' : ''}">${v[1]}</button>`).join('')}</div>
      <div class="seg" id="src">${Object.entries(srcs).map(([k, v]) => `<button data-k="${k}" class="${bagState.src === k ? 'on' : ''}">${v[1]}</button>`).join('')}</div>
    </div>
    <div id="bagbody"><div class="loading">Laster…</div></div>`;
  $view.querySelector('#per').onclick = (e) => { const k = e.target.dataset.k; if (k) { bagState.period = k; renderBag(); } };
  $view.querySelector('#src').onclick = (e) => { const k = e.target.dataset.k; if (k) { bagState.src = k; renderBag(); } };

  const rows = await getProfile(periods[bagState.period][0], today(), srcs[bagState.src][0]);
  const shown = rows.filter((r) => (bagState.showAll || r.in_bag) && r.category !== 'putter' && r.carry_p50);
  const body = $view.querySelector('#bagbody');
  if (!shown.length) { body.innerHTML = `<div class="empty">Ingen fullslag i denne perioden.</div>`; return; }
  const lo = Math.floor(Math.min(...shown.map((r) => +r.carry_p20)) / 10) * 10 - 10;
  const hi = Math.ceil(Math.max(...shown.map((r) => +r.carry_p80)) / 10) * 10 + 10;
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;
  const confTxt = { 'høy': '', middels: 'middels sikker', lav: 'lav sikkerhet' };
  let h = `<div class="card"><div class="small muted" style="margin-bottom:4px">Carry i meter. Stolpen er forventet lengde (P50), feltet går fra trygg (P20) til lang (P80).</div>`;
  for (const r of shown) {
    h += `<div class="club">
      <div><div class="name">${esc(r.club)}</div><div class="sub">${fmt(r.full_shots)} slag${confTxt[r.confidence] ? ` · <span class="chip lav">${confTxt[r.confidence]}</span>` : ''}${!r.in_bag ? ' · ikke i bag' : ''}</div></div>
      <div class="bar" title="P20 ${fmt(r.carry_p20)} · P50 ${fmt(r.carry_p50)} · P80 ${fmt(r.carry_p80)}">
        <div class="axis"></div>
        <div class="rng" style="left:${pct(r.carry_p20)}%;width:${pct(r.carry_p80) - pct(r.carry_p20)}%"></div>
        <div class="mid" style="left:calc(${pct(r.carry_p50)}% - 1px)"></div>
      </div>
      <div class="p50">${fmt(r.carry_p50)}</div></div>`;
  }
  h += `<div class="scale"><span>${lo}</span><span>${Math.round((lo + hi) / 2)}</span><span>${hi}</span></div></div>`;
  h += `<details class="card"><summary>Tabell med alle tall</summary><div style="overflow-x:auto"><table class="t"><thead><tr>
    <th>Kølle</th><th>Trygg</th><th>Forv.</th><th>Lang</th><th>Total</th><th>Side P80</th><th>Feilslag</th><th>n</th></tr></thead><tbody>` +
    shown.map((r) => `<tr><td>${esc(r.club)}</td><td>${fmt(r.carry_p20)}</td><td><b>${fmt(r.carry_p50)}</b></td><td>${fmt(r.carry_p80)}</td>
      <td>${fmt(r.total_p50)}</td><td>±${fmt(r.side_abs_p80)}</td><td>${fmt(r.mishit_pct, 1)} %</td><td>${fmt(r.full_shots)}</td></tr>`).join('') +
    `</tbody></table></div></details>
    <label class="row small"><input type="checkbox" id="all" ${bagState.showAll ? 'checked' : ''}> Vis også køller som ikke er i bagen</label>`;
  body.innerHTML = h;
  body.querySelector('#all').onchange = (e) => { bagState.showAll = e.target.checked; renderBag(); };
}

// ---------------------------------------------------------------- rounds
const roundState = { kind: 'simulator' };
async function renderRounds() {
  $title.textContent = 'Runder';
  $view.innerHTML = `<div class="row" style="margin-top:6px"><div class="seg" id="rk">
      <button data-k="simulator" class="${roundState.kind === 'simulator' ? 'on' : ''}">Simulator</button>
      <button data-k="outdoor" class="${roundState.kind === 'outdoor' ? 'on' : ''}">Ute</button></div></div>
    <div id="rbody"><div class="loading">Laster…</div></div>`;
  $view.querySelector('#rk').onclick = (e) => { const k = e.target.dataset.k; if (k) { roundState.kind = k; renderRounds(); } };
  const [rounds, ratings] = await Promise.all([
    cached('rounds:' + roundState.kind, () => q(sb.from('rounds')
      .select('id,kind,played_on,course_name,holes_played,par,strokes,stableford_points,counts_in_stats,regulation,tee_name')
      .eq('kind', roundState.kind).is('superseded_by', null).order('played_on', { ascending: false }).limit(300))),
    cached('courses:ratings', () => q(sb.from('course_ratings').select('kind,course_key,stars'))),
  ]);
  const key = (s) => cleanName(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const rmap = new Map(ratings.map((r) => [r.kind + '|' + r.course_key, r.stars]));
  const counted = rounds.filter((r) => r.counts_in_stats);
  const skipped = rounds.length - counted.length;
  let h = `<ul class="list card">` + counted.map((r) => {
    const tp = r.par ? r.strokes - r.par : null;
    return `<li><div class="row"><div style="min-width:0;flex:1"><div class="rtitle">${esc(cleanName(r.course_name) || 'Ukjent bane')}</div>
      <div class="small muted">${dateNo(r.played_on)} · ${r.holes_played || '–'} hull${r.regulation === false ? ' · par 3-bane' : ''}${r.tee_name ? ' · ' + esc(r.tee_name) : ''}
      ${starsHtml(rmap.get(r.kind + '|' + key(r.course_name)))}</div></div>
      <div style="text-align:right"><div class="score">${fmt(r.strokes)}</div><div class="small ${tp > 0 ? 'pos' : 'neg'}">${tp === null ? '' : signed(tp, 0)}${r.stableford_points ? ' · ' + r.stableford_points + ' p' : ''}</div></div></div></li>`;
  }).join('') + `</ul>`;
  if (skipped) h += `<p class="small muted">${skipped} delvise runder er skjult (teller ikke i statistikken).</p>`;
  $view.querySelector('#rbody').innerHTML = counted.length ? h : `<div class="empty">Ingen runder ennå.</div>`;
}

// ---------------------------------------------------------------- courses
const courseState = { tab: 'rec', search: '' };
async function ensureCatalog(force = false) {
  const cat = await getCatalog();
  const newest = cat.reduce((m, c) => (c.updated_at > m ? c.updated_at : m), '');
  if (!force && cat.length > 100 && newest && Date.now() - new Date(newest) < 14 * 864e5) return cat;
  const { data, error } = await sb.functions.invoke('tm-courses', { body: {} });
  if (error) { console.warn(error); if (cat.length) return cat; throw new Error('Fikk ikke hentet banelisten fra TrackMan'); }
  invalidate('courses:catalog');
  toast(`Baneliste oppdatert: ${data.courses} baner`);
  return getCatalog();
}
async function renderCourses() {
  $title.textContent = 'Baner';
  $view.innerHTML = `<div class="row" style="margin-top:6px"><div class="seg" id="ct">
      <button data-k="rec" class="${courseState.tab === 'rec' ? 'on' : ''}">Anbefalt for deg</button>
      <button data-k="played" class="${courseState.tab === 'played' ? 'on' : ''}">Spilt</button></div></div>
    <div id="cbody"><div class="loading">Laster…</div></div>`;
  $view.querySelector('#ct').onclick = (e) => { const k = e.target.dataset.k; if (k) { courseState.tab = k; renderCourses(); } };
  const body = $view.querySelector('#cbody');
  const overview = await getOverview();

  if (courseState.tab === 'played') {
    const kinds = [['simulator', 'Simulator'], ['outdoor', 'Ute']];
    let h = '';
    for (const [k, label] of kinds) {
      const list = overview.filter((c) => c.kind === k);
      if (!list.length) continue;
      h += `<h2>${label} <span class="small muted">${list.length} baner</span></h2><ul class="list card">` + list.map((c) =>
        `<li><div class="row"><div style="flex:1;min-width:0"><div class="rtitle">${esc(cleanName(c.course_name))}</div>
          <div class="small muted">${c.rounds} ${c.rounds === 1 ? 'runde' : 'runder'} · sist ${dateNo(c.last_played)}${c.best_to_par !== null ? ' · beste ' + signed(c.best_to_par, 0) : ''}</div></div>
          ${starsHtml(c.stars, { interactive: true, kind: c.kind, course: cleanName(c.course_name), tm: c.tm_course_id || '' })}</div></li>`).join('') + `</ul>`;
    }
    body.innerHTML = h || `<div class="empty">Ingen spilte baner ennå.</div>`;
    wireStars(body);
    return;
  }

  let catalog;
  try { catalog = await ensureCatalog(); } catch (e) { body.innerHTML = `<div class="card warn">${esc(e.message)}</div>`; return; }
  const ratings = overview.filter((c) => c.kind === 'simulator' && c.stars);
  const res = recommend(catalog, overview.filter((c) => c.kind === 'simulator'), { limit: 15 });
  let h = '';
  if (ratings.length < 5) h += `<div class="card warn small">Du har gitt stjerner til ${ratings.length} simulatorbaner. Anbefalingene blir bedre jo flere du vurderer, under <a href="#/baner" data-tab2="played">Spilt</a>. Til da vektlegges banetype, vanskelighet og populære baner.</div>`;
  h += `<input type="search" id="csearch" placeholder="Søk i ${catalog.length} TrackMan-baner" value="${esc(courseState.search)}">`;
  h += `<div id="clist"></div>`;
  if (res.replay.length) h += `<h2>Spill igjen</h2><ul class="list card">` + res.replay.map((r) => `
      <li><div class="row"><div style="flex:1"><div class="rtitle">${esc(r.name)}</div><div class="small muted">${esc(r.reason)}</div></div>${starsHtml(r.stars)}</div></li>`).join('') + `</ul>`;
  h += `<p class="small muted">Listen er TrackMans fulle banekatalog. Om en bane er tilgjengelig på akkurat ditt simulatoranlegg, avhenger av lisensen der.
    <button class="btn sm ghost" id="refcat">Oppdater baneliste</button></p>`;
  body.innerHTML = h;

  const clist = body.querySelector('#clist');
  const card = (c) => `<li><div class="row"><div style="flex:1;min-width:0"><div class="rtitle">${esc(c.name)}</div>
      <div class="small muted">${esc(c.location || '')}${c.holes ? ' · ' + c.holes + ' hull' : ''}${c.par ? ' · par ' + c.par : ''}${c.length_m ? ' · ' + fmt(c.length_m) + ' m' : ''}${c.difficulty ? ' · vanskelighet ' + c.difficulty + '/5' : ''}</div>
      ${c.reason ? `<div class="small">${esc(c.reason)}</div>` : ''}</div>
      ${c.played ? '<span class="chip">spilt</span>' : ''}</div></li>`;
  const draw = () => {
    const s = courseState.search.trim().toLowerCase();
    if (s) {
      const hits = catalog.filter((c) => (c.name + ' ' + (c.location || '')).toLowerCase().includes(s)).slice(0, 30)
        .map((c) => ({ ...c, played: overview.some((o) => o.tm_course_id === c.id) }));
      clist.innerHTML = `<h2>Søk</h2><ul class="list card">${hits.map(card).join('') || '<li class="muted">Ingen treff</li>'}</ul>`;
    } else {
      clist.innerHTML = `<h2>Nye baner du trolig vil like</h2><ul class="list card">${res.picks.map(card).join('')}</ul>`;
    }
  };
  draw();
  body.querySelector('#csearch').addEventListener('input', (e) => { courseState.search = e.target.value; draw(); });
  body.querySelector('#refcat').onclick = async () => { await ensureCatalog(true); renderCourses(); };
  body.querySelectorAll('[data-tab2]').forEach((a) => a.onclick = (e) => { e.preventDefault(); courseState.tab = 'played'; renderCourses(); });
}

// ---------------------------------------------------------------- review (wrong club)
let pendingReclassify = false;
async function flushReclassify() {
  if (!pendingReclassify) return;
  pendingReclassify = false;
  try { await q(sb.rpc('reclassify')); invalidate('profile:'); invalidate('review:'); } catch (e) { pendingReclassify = true; toast('Oppdatering feilet: ' + e.message); }
}
async function renderReview() {
  $title.textContent = 'Sjekk kølle';
  $view.innerHTML = `<div class="loading">Laster…</div>`;
  const [rows, clubs] = await Promise.all([q(sb.rpc('review_queue', { p_limit: 400 })), getClubs()]);
  if (!rows.length) { $view.innerHTML = `<div class="empty">Ingen slag å sjekke. 👍</div>`; return; }
  const groups = [];
  for (const r of rows) {
    const key = r.started_at.slice(0, 10) + '|' + (r.course || r.activity);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, date: r.started_at, course: r.course, activity: r.activity, shots: [] });
    g.shots.push(r);
  }
  const actName = { course_play: 'Runde', practice: 'Trening', map_my_bag: 'Map My Bag' };
  const clubOpts = clubs.filter((c) => c.category !== 'putter').map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  let h = `<p class="small muted">Disse slagene passer ikke med kølla som var valgt i simulatoren (fart, launch eller loft). Velg riktig kølle. Rådataene fra TrackMan endres ikke, rettelsen lagres ved siden av.</p>`;
  groups.forEach((g, gi) => {
    const sure = g.shots.filter((s) => s.suggestions[0] && s.suggestions[0].p >= 0.6).length;
    h += `<div class="card" data-g="${gi}"><div class="row"><div><b>${esc(cleanName(g.course) || actName[g.activity] || g.activity)}</b>
      <div class="small muted">${actName[g.activity] || ''} · ${dateNo(g.date)} · ${g.shots.length} slag</div></div><span class="spacer"></span>
      ${sure ? `<button class="btn sm" data-bulk="${gi}">Godta ${sure} sikre forslag</button>` : ''}</div>`;
    for (const s of g.shots) {
      h += `<div class="shot" data-id="${s.shot_id}">
        <div class="row"><b>${s.hole_no ? 'Hull ' + s.hole_no + ' · ' : ''}Merket: ${esc(s.tagged_club)}</b></div>
        <div class="facts"><span>Carry <b>${fmt(s.carry_m)} m</b></span><span>Loft <b>${fmt(s.dynamic_loft, 1)}°</b></span>
          <span>Ballfart <b>${fmt(s.ball_speed_ms * 2.23694)} mph</b></span>${s.dist_to_pin_m ? `<span>Til flagg før slaget <b>${fmt(s.dist_to_pin_m)} m</b></span>` : ''}</div>
        <div class="opts">
          ${s.suggestions.map((x, i) => `<button class="btn sm ${i === 0 ? 'primary' : ''}" data-club="${x.club_id}">${esc(x.club)} <span class="small">${Math.round(x.p * 100)} %</span></button>`).join('')}
          <button class="btn sm ghost" data-club="${s.tagged_club_id}">Nei, det var ${esc(s.tagged_club)}</button>
          <select class="sm other" aria-label="Annen kølle" style="width:auto;min-height:32px;padding:4px 8px"><option value="">Annen…</option>${clubOpts}</select>
          <button class="btn sm ghost" data-exclude="1">Ta ut</button>
        </div></div>`;
    }
    h += `</div>`;
  });
  h += `<div class="row" style="margin:16px 0"><button class="btn primary" id="done">Ferdig, oppdater tallene</button></div>`;
  $view.innerHTML = h;

  const apply = async (el, club, exclude = false) => {
    const id = el.dataset.id;
    el.querySelectorAll('button,select').forEach((b) => b.disabled = true);
    try {
      await q(sb.rpc('set_shot_club', { p_shot: id, p_club: exclude ? null : club, p_exclude: exclude, p_reclassify: false }));
      pendingReclassify = true; el.classList.add('done');
      const name = exclude ? 'tatt ut' : (clubs.find((c) => c.id === club)?.name || '');
      el.querySelector('.opts').innerHTML = `<span class="small">✓ ${esc(name)}</span>`;
    } catch (e) { toast('Feil: ' + e.message); el.querySelectorAll('button,select').forEach((b) => b.disabled = false); }
  };
  $view.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'done') { b.disabled = true; b.textContent = 'Oppdaterer…'; await flushReclassify(); invalidate('review:'); toast('Tallene er oppdatert'); location.hash = '#/bag'; return; }
    if (b.dataset.bulk !== undefined) {
      const g = groups[+b.dataset.bulk]; b.disabled = true;
      for (const s of g.shots) if (s.suggestions[0] && s.suggestions[0].p >= 0.6) {
        const el = $view.querySelector(`.shot[data-id="${s.shot_id}"]`); if (el && !el.classList.contains('done')) await apply(el, s.suggestions[0].club_id);
      }
      return;
    }
    const el = b.closest('.shot'); if (!el) return;
    if (b.dataset.exclude) return apply(el, null, true);
    if (b.dataset.club) return apply(el, b.dataset.club);
  });
  $view.addEventListener('change', (e) => {
    if (e.target.classList.contains('other') && e.target.value) apply(e.target.closest('.shot'), e.target.value);
  });
}

// ---------------------------------------------------------------- account menu
document.getElementById('btn-account').onclick = async () => {
  const { data } = await sb.auth.getUser();
  if (confirm(`Innlogget som ${data.user?.email}.\n\nLogge ut?`)) { await sb.auth.signOut(); cache.clear(); route(); }
};

// ---------------------------------------------------------------- router
const routes = { '': ['home', renderHome], bag: ['bag', renderBag], runder: ['runder', renderRounds], baner: ['baner', renderCourses],
  strategi: ['strategi', () => renderStrategy($view, { sb, getProfile, toast, esc, fmt, setTitle: (t) => $title.textContent = t })],
  sjekk: ['home', renderReview] };
async function route() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  await flushReclassify();
  $tabs.hidden = false; document.getElementById('btn-account').hidden = false;
  const path = location.hash.replace(/^#\/?/, '').split('/')[0];
  const [tab, fn] = routes[path] || routes[''];
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  window.scrollTo(0, 0);
  try { await fn(); } catch (e) { console.error(e); $view.innerHTML = `<div class="card warn">Noe gikk galt: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') route(); });
route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { recommend } from './recommend.js';
import { renderStrategy } from './strategy.js';
import { trendChart, ring, gappingChart, dispersionField, CAT, CAT_LABEL, catVar, hideTip } from './charts.js';

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
const nameKey = (s) => cleanName(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

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
const diffBar = (d) => d ? `<span class="diff" title="Vanskelighet ${d} av 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= d ? 'on' : ''}"></i>`).join('')}</span>` : '';
const imgStyle = (url) => url ? `background-image:url('${esc(url)}')` : '';
function scoreBadge(strokes, par) {
  const tp = par ? strokes - par : null;
  const cls = tp === null ? 'even' : tp < 0 ? 'under' : tp === 0 ? 'even' : '';
  return `<div class="score-badge ${cls}">${fmt(strokes)}<small>${tp === null ? 'slag' : tp === 0 ? 'par' : signed(tp, 0)}</small></div>`;
}

// ---------------------------------------------------------------- data
const getClubs = () => cached('clubs', () => q(sb.from('clubs').select('id,name,category,sort_order,loft_deg').order('sort_order')), 60 * 60e3);
const getOverview = () => cached('courses:overview', () => q(sb.rpc('course_overview')));
const getCatalog = () => cached('courses:catalog', () => q(sb.from('tm_courses')
  .select('id,name,name_key,location,lat,lon,difficulty,holes,tags,description,par,length_m,slope,course_rating,fictional,image_url,updated_at')
  .limit(2000)), 30 * 60e3);
export const getProfile = (from, to, acts) => cached(`profile:${from}:${to}:${acts}`, () =>
  q(sb.rpc('club_profile', { p_from: from, p_to: to, p_activities: acts.split(',') })));
const getRounds = (kind) => cached('rounds:' + kind, () => q(sb.from('rounds')
  .select('id,kind,played_on,course_name,holes_played,par,strokes,stableford_points,counts_in_stats,regulation,tee_name')
  .eq('kind', kind).is('superseded_by', null).order('played_on', { ascending: false }).limit(400)));
const reviewCount = () => cached('review:count', async () => {
  const { count, error } = await sb.from('v_shots').select('id', { count: 'exact', head: true })
    .like('reason', '%mulig feil kølle%').eq('club_reviewed', false).eq('excluded', false);
  if (error) throw error; return count || 0;
}, 60e3);
async function imageIndex() {
  try { const cat = await getCatalog(); return { byId: new Map(cat.map((c) => [c.id, c])), byKey: new Map(cat.map((c) => [c.name_key, c])) }; }
  catch { return { byId: new Map(), byKey: new Map() }; }
}

// ---------------------------------------------------------------- auth
async function renderLogin() {
  $tabs.hidden = true; document.getElementById('btn-account').hidden = true; $title.textContent = 'My Caddie';
  $view.innerHTML = `
    <div class="login-hero">${document.querySelector('.logo').outerHTML.replace('class="logo"', '')}</div>
    <div class="card">
      <h2 style="margin-top:0">Logg inn</h2>
      <p class="muted small">Bruk den samme My Caddie-brukeren som i Chrome-utvidelsen.</p>
      <form id="login">
        <label for="em">E-post</label><input id="em" type="email" autocomplete="username" required>
        <label for="pw">Passord</label><input id="pw" type="password" autocomplete="current-password" required>
        <div class="row" style="margin-top:16px"><button class="btn primary" type="submit">Logg inn</button><span id="lerr" class="small" style="color:var(--bad)"></span></div>
      </form>
    </div>`;
  const hero = $view.querySelector('.login-hero svg'); if (hero) { hero.querySelector('circle').setAttribute('fill', 'var(--accent)'); }
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
  const [sync, nReview, overview, summary, simRounds, profile, img] = await Promise.all([
    q(sb.from('sync_runs').select('started_at,status,new_shots,message').order('started_at', { ascending: false }).limit(1)),
    reviewCount(), getOverview(),
    cached('summary:365', () => q(sb.rpc('round_summary', { p_from: isoDaysAgo(365), p_to: today() }))),
    getRounds('simulator'),
    getProfile(isoDaysAgo(365), today(), 'practice,map_my_bag,course_play'),
    imageIndex(),
  ]);
  const last = sync[0];
  const ageDays = last ? (Date.now() - new Date(last.started_at)) / 864e5 : Infinity;
  const unrated = overview.filter((c) => !c.stars && c.last_played >= isoDaysAgo(45)).slice(0, 4);
  const sim18 = summary.find((s) => s.kind === 'simulator' && s.holes === 18);
  const out = summary.find((s) => s.kind === 'outdoor');
  const trendRounds = simRounds.filter((r) => r.counts_in_stats && r.regulation !== false && r.holes_played === 18).slice(0, 30);
  const best = trendRounds.reduce((m, r) => (r.par && (m === null || r.strokes - r.par < m) ? r.strokes - r.par : m), null);

  let h = '';
  if (sim18) h += `<section class="hero">
      <div class="eyebrow">Simulator · 18 hull</div>
      <div class="big">${signed(+sim18.last5_to_par_avg)}</div>
      <div class="sub">snitt mot par siste 5 runder</div>
      <div class="hero-stats"><div><b>${signed(+sim18.to_par_avg)}</b>snitt 12 mnd</div><div><b>${best === null ? '–' : signed(best, 0)}</b>beste siste 30</div><div><b>${sim18.rounds}</b>runder</div></div>
      <div class="spark" id="spark"></div></section>`;
  if (ageDays > 7) h += `<div class="card warn"><b>TrackMan-synken har ikke gått på ${last ? Math.floor(ageDays) + ' dager' : 'lenge'}.</b>
    <div class="small">Åpne Chrome med My Caddie Sync, eller trykk «Synk nå» i utvidelsen.</div></div>`;
  if (nReview > 0) h += `<a class="card link accent" href="#/sjekk"><div class="review-hero"><div class="count">${fmt(nReview)}</div>
    <div style="flex:1"><b>slag passer ikke med valgt kølle</b><div class="small muted">Trolig glemt å bytte kølle i simulatoren. Bekreft med ett trykk.</div></div><span style="font-size:22px">›</span></div></a>`;
  if (sim18) h += `<div class="card"><div class="rings">
      ${ring(sim18.fir_pct, 'Fairway')}${ring(sim18.gir_pct, 'Green i reg.')}${ring(sim18.scrambling_pct, 'Scrambling')}
      <div class="ring"><div style="height:80px;display:grid;place-items:center;font-size:26px;font-weight:750" class="num">${fmt(sim18.putts_avg, 1)}</div><div class="ring-l">Putter per runde</div></div>
    </div></div>`;
  if (unrated.length) {
    h += `<h2>Hva syntes du om banene?</h2><div class="card"><ul class="list">` + unrated.map((c) => {
      const tc = img.byId.get(c.tm_course_id) || img.byKey.get(nameKey(c.course_name));
      return `<li><div class="row" style="flex-wrap:nowrap"><div class="thumb" style="${imgStyle(tc?.image_url)}"></div><div style="flex:1;min-width:0"><div class="rtitle">${esc(cleanName(c.course_name))}</div><div class="small muted">${c.kind === 'outdoor' ? 'Ute' : 'Simulator'} · ${dateNo(c.last_played)}</div>
       ${starsHtml(0, { interactive: true, kind: c.kind, course: cleanName(c.course_name), tm: c.tm_course_id || '' })}</div></div></li>`;
    }).join('') + `</ul></div>`;
  }
  const bag = profile.filter((r) => r.in_bag && r.category !== 'putter' && r.carry_p50);
  if (bag.length) {
    const max = Math.max(...bag.map((r) => +r.carry_p50));
    h += `<a class="card link" href="#/bag"><div class="row"><h3 style="margin:0">Min bag</h3><span class="spacer"></span><span class="small muted">forventet carry ›</span></div>
      <div style="display:flex;align-items:flex-end;gap:4px;height:110px;margin-top:10px">${bag.map((r) => `<div title="${esc(r.club)} ${fmt(r.carry_p50)} m" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
        <div class="num" style="font-size:10px;font-weight:700">${fmt(r.carry_p50)}</div>
        <div style="width:100%;max-width:26px;height:${(r.carry_p50 / max) * 80}%;background:${catVar(r.category)};border-radius:4px 4px 0 0"></div>
        <div style="font-size:9px;color:var(--muted);margin-top:3px;white-space:nowrap">${esc(shortClub(r.club))}</div></div>`).join('')}</div></a>`;
  }
  if (out) h += `<h2>Ute <span class="small muted">siste 12 mnd</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(out.strokes_avg, 1)}</div><div class="l">Snitt slag (${out.rounds} runder)</div></div>
      <div class="kpi"><div class="v">${fmt(out.strokes_best)}</div><div class="l">Beste</div></div>
      <div class="kpi"><div class="v">${fmt(out.stableford_avg, 1)}</div><div class="l">Stableford</div></div>
    </div>`;
  h += `<p class="small muted" style="margin-top:18px">Sist synket fra TrackMan: ${last ? new Date(last.started_at).toLocaleString('nb-NO', { dateStyle: 'medium', timeStyle: 'short' }) : 'aldri'}</p>`;
  $view.innerHTML = h;
  const sp = $view.querySelector('#spark'); if (sp) trendChart(sp, trendRounds, { height: 74, compact: true });
  wireStars($view, () => renderHome());
}
const shortClub = (n) => n.replace('Pitching Wedge', 'PW').replace(' Wedge', '').replace('Driver', 'Dr').replace(' Wood', 'W').replace(' Hybrid', 'H').replace(' Iron', 'i').replace('°', '');

// ---------------------------------------------------------------- bag
const bagState = { period: '12m', src: 'all', showAll: false, view: 'gap' };
async function renderBag() {
  $title.textContent = 'Min bag';
  const periods = { '3m': [isoDaysAgo(91), '3 mnd'], '12m': [isoDaysAgo(365), '12 mnd'], 'ytd': [new Date().getFullYear() + '-01-01', 'I år'] };
  const srcs = { all: ['practice,map_my_bag,course_play', 'Alle'], train: ['practice,map_my_bag', 'Trening'], play: ['course_play', 'Runder'] };
  $view.innerHTML = `
    <div class="row">
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
  const cats = [...new Set(shown.map((r) => CAT[r.category] || 'iron'))];
  const legend = `<div class="legend">${cats.map((c) => `<span><i style="background:var(--c-${c})"></i>${CAT_LABEL[c]}</span>`).join('')}</div>`;
  body.innerHTML = `
    <div class="card"><div class="row"><h3 style="margin:0">Lengder og hull mellom køllene</h3></div>
      <div class="small muted" style="margin:4px 0 8px">Feltet går fra trygg (P20) til lang (P80) carry, streken er forventet lengde (P50). Trykk på en kølle for detaljer.</div>
      ${legend}<div id="gap"></div></div>
    <div class="card"><h3>Spredning sett ovenfra</h3>
      <div class="small muted" style="margin-bottom:6px">Hver ellipse rommer 80 % av de gode fullslagene med kølla. Bredden er sideavviket.</div>
      ${legend}<div id="disp"></div></div>
    <details class="card"><summary>Tabell med alle tall</summary><div style="overflow-x:auto"><table class="t"><thead><tr>
      <th>Kølle</th><th>Trygg</th><th>Forv.</th><th>Lang</th><th>Total</th><th>Side P80</th><th>Feilslag</th><th>n</th></tr></thead><tbody>` +
      shown.map((r) => `<tr><td>${esc(r.club)}</td><td>${fmt(r.carry_p20)}</td><td><b>${fmt(r.carry_p50)}</b></td><td>${fmt(r.carry_p80)}</td>
        <td>${fmt(r.total_p50)}</td><td>±${fmt(r.side_abs_p80)}</td><td>${fmt(r.mishit_pct, 1)} %</td><td>${fmt(r.full_shots)}</td></tr>`).join('') +
      `</tbody></table></div></details>
    <label class="row small"><input type="checkbox" id="all" ${bagState.showAll ? 'checked' : ''}> Vis også køller som ikke er i bagen</label>`;
  gappingChart(body.querySelector('#gap'), shown);
  dispersionField(body.querySelector('#disp'), shown.filter((r) => r.side_abs_p80));
  body.querySelector('#all').onchange = (e) => { bagState.showAll = e.target.checked; renderBag(); };
}

// ---------------------------------------------------------------- rounds
const roundState = { kind: 'simulator' };
async function renderRounds() {
  $title.textContent = 'Runder';
  $view.innerHTML = `<div class="row"><div class="seg" id="rk">
      <button data-k="simulator" class="${roundState.kind === 'simulator' ? 'on' : ''}">Simulator</button>
      <button data-k="outdoor" class="${roundState.kind === 'outdoor' ? 'on' : ''}">Ute</button></div></div>
    <div id="rbody"><div class="loading">Laster…</div></div>`;
  $view.querySelector('#rk').onclick = (e) => { const k = e.target.dataset.k; if (k) { roundState.kind = k; renderRounds(); } };
  const [rounds, ratings, img] = await Promise.all([
    getRounds(roundState.kind),
    cached('courses:ratings', () => q(sb.from('course_ratings').select('kind,course_key,stars'))),
    imageIndex(),
  ]);
  const rmap = new Map(ratings.map((r) => [r.kind + '|' + r.course_key, r.stars]));
  const counted = rounds.filter((r) => r.counts_in_stats);
  const skipped = rounds.length - counted.length;
  const trend = counted.filter((r) => r.regulation !== false && r.holes_played === 18 && r.par);
  let h = '';
  if (trend.length >= 3) h += `<div class="card"><div class="row"><h3 style="margin:0">Score mot par</h3><span class="spacer"></span>
      <span class="legend" style="margin:0"><span><i style="background:var(--good);border-radius:50%"></i>under par</span><span><i style="background:var(--accent);height:3px"></i>snitt 5 runder</span></span></div>
      <div id="trend" style="margin-top:6px"></div></div>`;
  h += `<div class="card"><ul class="list">` + counted.map((r) => {
    const tc = r.kind === 'simulator' ? img.byKey.get(nameKey(r.course_name)) : null;
    return `<li><div class="row" style="flex-wrap:nowrap">${r.kind === 'simulator' ? `<div class="thumb" style="${imgStyle(tc?.image_url)}"></div>` : ''}
      <div style="min-width:0;flex:1"><div class="rtitle">${esc(cleanName(r.course_name) || 'Ukjent bane')}</div>
      <div class="small muted">${dateNo(r.played_on)} · ${r.holes_played || '–'} hull${r.regulation === false ? ' · par 3-bane' : ''}${r.tee_name ? ' · ' + esc(r.tee_name) : ''}${r.stableford_points ? ' · ' + r.stableford_points + ' p' : ''}</div>
      ${starsHtml(rmap.get(r.kind + '|' + nameKey(r.course_name)))}</div>
      ${scoreBadge(r.strokes, r.par)}</div></li>`;
  }).join('') + `</ul></div>`;
  if (skipped) h += `<p class="small muted">${skipped} delvise runder er skjult (teller ikke i statistikken).</p>`;
  $view.querySelector('#rbody').innerHTML = counted.length ? h : `<div class="empty">Ingen runder ennå.</div>`;
  const t = $view.querySelector('#trend'); if (t) trendChart(t, trend.slice(0, 60));
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
  $view.innerHTML = `<div class="row"><div class="seg" id="ct">
      <button data-k="rec" class="${courseState.tab === 'rec' ? 'on' : ''}">Anbefalt for deg</button>
      <button data-k="played" class="${courseState.tab === 'played' ? 'on' : ''}">Spilt</button></div></div>
    <div id="cbody"><div class="loading">Laster…</div></div>`;
  $view.querySelector('#ct').onclick = (e) => { const k = e.target.dataset.k; if (k) { courseState.tab = k; renderCourses(); } };
  const body = $view.querySelector('#cbody');
  const overview = await getOverview();
  let catalog = [];
  try { catalog = await ensureCatalog(); } catch (e) { if (courseState.tab === 'rec') { body.innerHTML = `<div class="card warn">${esc(e.message)}</div>`; return; } }
  const byId = new Map(catalog.map((c) => [c.id, c])); const byKey = new Map(catalog.map((c) => [c.name_key, c]));

  if (courseState.tab === 'played') {
    const kinds = [['simulator', 'Simulator'], ['outdoor', 'Ute']];
    let h = '';
    for (const [k, label] of kinds) {
      const list = overview.filter((c) => c.kind === k);
      if (!list.length) continue;
      const rated = list.filter((c) => c.stars).length;
      h += `<h2>${label} <span class="small muted">${list.length} baner · ${rated} med stjerner</span></h2><div class="card"><ul class="list">` + list.map((c) => {
        const tc = byId.get(c.tm_course_id) || (k === 'simulator' ? byKey.get(nameKey(c.course_name)) : null);
        return `<li><div class="row" style="flex-wrap:nowrap">${k === 'simulator' ? `<div class="thumb" style="${imgStyle(tc?.image_url)}"></div>` : ''}
          <div style="flex:1;min-width:0"><div class="rtitle">${esc(cleanName(c.course_name))}</div>
          <div class="small muted">${c.rounds} ${c.rounds === 1 ? 'runde' : 'runder'} · sist ${dateNo(c.last_played)}${c.best_to_par !== null ? ' · beste ' + signed(c.best_to_par, 0) : ''}</div>
          ${starsHtml(c.stars, { interactive: true, kind: c.kind, course: cleanName(c.course_name), tm: tc?.id || '' })}</div></div></li>`;
      }).join('') + `</ul></div>`;
    }
    body.innerHTML = h || `<div class="empty">Ingen spilte baner ennå.</div>`;
    wireStars(body, () => invalidate('courses:overview'));
    return;
  }

  const ratings = overview.filter((c) => c.kind === 'simulator' && c.stars);
  const res = recommend(catalog, overview.filter((c) => c.kind === 'simulator'), { limit: 12 });
  let h = '';
  if (ratings.length < 8) h += `<div class="card accent small">Du har gitt stjerner til <b>${ratings.length}</b> simulatorbaner. Jo flere du vurderer under <a href="#/baner" data-tab2="played">Spilt</a>, jo bedre treffer anbefalingene.</div>`;
  h += `<input type="search" id="csearch" placeholder="Søk i ${catalog.length} TrackMan-baner" value="${esc(courseState.search)}">`;
  h += `<div id="clist"></div>`;
  if (res.replay.length) h += `<h2>Verdt å spille igjen</h2><div class="card"><ul class="list">` + res.replay.map((r) => {
    const tc = byKey.get(nameKey(r.name));
    return `<li><div class="row" style="flex-wrap:nowrap"><div class="thumb" style="${imgStyle(tc?.image_url)}"></div><div style="flex:1"><div class="rtitle">${esc(r.name)}</div><div class="small muted">${esc(r.reason)}</div>${starsHtml(r.stars)}</div></div></li>`;
  }).join('') + `</ul></div>`;
  h += `<p class="small muted">Listen er TrackMans fulle banekatalog. Om en bane finnes på akkurat ditt simulatoranlegg, avhenger av lisensen der.
    <button class="btn sm ghost" id="refcat">Oppdater baneliste</button></p>`;
  body.innerHTML = h;

  const clist = body.querySelector('#clist');
  const maxScore = Math.max(0.0001, ...res.picks.map((c) => c.score));
  const card = (c, i, showMatch) => `<div class="ccard"><div class="img" style="${imgStyle(c.image_url)}">
      ${showMatch ? `<span class="match">${Math.round(Math.max(0.35, c.score / maxScore) * 100)} % match</span>` : ''}
      ${(c.tags || []).includes('Links') ? '<span class="tag">Links</span>' : (c.tags || []).includes('TourVenue') ? '<span class="tag">Tour</span>' : ''}</div>
      <div class="body"><div class="t">${esc(c.name)}</div>
      <div class="m">${esc(c.location || '')}</div>
      <div class="m">${c.par ? 'Par ' + c.par : ''}${c.length_m ? ' · ' + fmt(c.length_m) + ' m' : ''} ${diffBar(c.difficulty)}</div>
      ${c.reason ? `<div class="why">${esc(c.reason)}</div>` : ''}${c.played ? '<div class="why"><span class="chip">spilt</span></div>' : ''}</div></div>`;
  const draw = () => {
    const s = courseState.search.trim().toLowerCase();
    if (s) {
      const hits = catalog.filter((c) => (c.name + ' ' + (c.location || '')).toLowerCase().includes(s)).slice(0, 24)
        .map((c) => ({ ...c, played: overview.some((o) => o.tm_course_id === c.id || nameKey(o.course_name) === c.name_key) }));
      clist.innerHTML = `<h2>Søk</h2>${hits.length ? `<div class="ccards">${hits.map((c, i) => card(c, i, false)).join('')}</div>` : '<div class="empty">Ingen treff</div>'}`;
    } else {
      clist.innerHTML = `<h2>Nye baner du trolig vil like</h2><div class="ccards">${res.picks.map((c, i) => card(c, i, true)).join('')}</div>`;
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
  const catOf = new Map(clubs.map((c) => [c.id, c.category]));
  const groups = [];
  for (const r of rows) {
    const key = r.started_at.slice(0, 10) + '|' + (r.course || r.activity);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, date: r.started_at, course: r.course, activity: r.activity, shots: [] });
    g.shots.push(r);
  }
  const actName = { course_play: 'Runde', practice: 'Trening', map_my_bag: 'Map My Bag' };
  const clubOpts = clubs.filter((c) => c.category !== 'putter').map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  let h = `<div class="card accent"><div class="review-hero"><div class="count">${rows.length}</div><div class="small">slag der fart, launch eller loft ikke passer med kølla som var valgt i simulatoren. Velg riktig kølle. Rådataene fra TrackMan endres ikke.</div></div></div>`;
  groups.forEach((g, gi) => {
    const sure = g.shots.filter((s) => s.suggestions[0] && s.suggestions[0].p >= 0.6).length;
    h += `<div class="card" data-g="${gi}"><div class="row"><div><b>${esc(cleanName(g.course) || actName[g.activity] || g.activity)}</b>
      <div class="small muted">${actName[g.activity] || ''} · ${dateNo(g.date)} · ${g.shots.length} slag</div></div><span class="spacer"></span>
      ${sure ? `<button class="btn sm" data-bulk="${gi}">Godta ${sure} sikre forslag</button>` : ''}</div>`;
    for (const s of g.shots) {
      h += `<div class="shot" data-id="${s.shot_id}">
        <div class="row"><span class="sw" style="background:${catVar(catOf.get(s.tagged_club_id))}"></span><b>${s.hole_no ? 'Hull ' + s.hole_no + ' · ' : ''}Merket: ${esc(s.tagged_club)}</b></div>
        <div class="facts"><span class="fact">Carry <b>${fmt(s.carry_m)} m</b></span><span class="fact">Loft <b>${fmt(s.dynamic_loft, 1)}°</b></span>
          <span class="fact">Ballfart <b>${fmt(s.ball_speed_ms * 2.23694)}</b> mph</span>${s.dist_to_pin_m ? `<span class="fact">Til flagg <b>${fmt(s.dist_to_pin_m)} m</b></span>` : ''}</div>
        <div class="opts">
          ${s.suggestions.map((x, i) => `<button class="btn sm ${i === 0 ? 'primary' : ''}" data-club="${x.club_id}">${esc(x.club)} <span class="small">${Math.round(x.p * 100)} %</span></button>`).join('')}
          <button class="btn sm ghost" data-club="${s.tagged_club_id}">Nei, det var ${esc(s.tagged_club)}</button>
          <select class="other" aria-label="Annen kølle" style="width:auto;min-height:34px;padding:4px 8px;font-size:14px"><option value="">Annen…</option>${clubOpts}</select>
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
let routing = 0;
async function route() {
  const my = ++routing;
  hideTip();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  await flushReclassify();
  if (my !== routing) return;
  $tabs.hidden = false; document.getElementById('btn-account').hidden = false;
  const path = location.hash.replace(/^#\/?/, '').split('/')[0];
  const [tab, fn] = routes[path] || routes[''];
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  window.scrollTo(0, 0);
  try { await fn(); } catch (e) { console.error(e); $view.innerHTML = `<div class="card warn">Noe gikk galt: ${esc(e.message)}</div>`; }
}
if (!window.__mcBooted) {
  window.__mcBooted = true;
  window.addEventListener('hashchange', route);
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') route(); });
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

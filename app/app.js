import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { recommend } from './recommend.js';
import { renderStrategy } from './strategy.js';
import { trendChart, ring, gappingChart, dispersionField, CAT, CAT_LABEL, catVar, hideTip } from './charts.js';

// Links from invitation and password e-mails land here with #access_token=…&type=invite|recovery
const AUTH_HASH = location.hash;
let needPassword = /type=(invite|recovery|signup)/.test(AUTH_HASH);
const authError = /error_description=([^&]+)/.exec(AUTH_HASH);
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

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
function playedBadge(c) {
  const p = c.playedInfo;
  if (!p) return `<span class="pbadge new">Ny for deg</span>`;
  const when = new Date(p.last).toLocaleDateString('nb-NO', { month: 'short', year: 'numeric' });
  return `<span class="pbadge played">✓ Spilt ${p.rounds}× · sist ${when}</span>`;
}
const diffBar = (d) => d ? `<span class="diff" title="Vanskelighet ${d} av 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= d ? 'on' : ''}"></i>`).join('')}</span>` : '';
const imgStyle = (url) => url ? `background-image:url('${esc(url)}')` : '';
function scoreBadge(strokes, par) {
  const tp = par ? strokes - par : null;
  const cls = tp === null ? 'even' : tp < 0 ? 'under' : tp === 0 ? 'even' : '';
  return `<div class="score-badge ${cls}">${fmt(strokes)}<small>${tp === null ? 'slag' : tp === 0 ? 'par' : signed(tp, 0)}</small></div>`;
}

// ---------------------------------------------------------------- data
// Carry or total: one switch for the whole app, remembered on this phone
const DIST_KEY = 'mc_dist_mode';
function distMode() { try { return localStorage.getItem(DIST_KEY) === 'total' ? 'total' : 'carry'; } catch { return 'carry'; } }
function setDistMode(m) { try { localStorage.setItem(DIST_KEY, m); } catch { /* private mode */ } }
// Rows with carry_* fields swapped for total_* when total is selected, so every chart can read the same fields
function asMode(rows, mode = distMode()) {
  if (mode !== 'total') return rows;
  return rows.filter((r) => r.total_p50).map((r) => ({ ...r, carry_p20: r.total_p20 ?? r.total_p50, carry_p50: r.total_p50, carry_p80: r.total_p80 ?? r.total_p50,
    carry_p90: r.total_p90 ?? r.total_p80, side_mean: r.total_side_mean ?? r.side_mean, side_abs_p80: r.total_side_abs_p80 ?? r.side_abs_p80 }));
}
const distSwitch = (id) => `<div class="seg" id="${id}">${[['carry', 'Carry'], ['total', 'Total']].map(([k, l]) => `<button data-m="${k}" class="${distMode() === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
function wireDist(root, id, rerender) { const el = root.querySelector('#' + id); if (el) el.onclick = (e) => { const m = e.target.dataset.m; if (m && m !== distMode()) { setDistMode(m); rerender(); } }; }

const getClubs = () => cached('clubs', () => q(sb.from('clubs').select('id,name,category,sort_order,loft_deg').order('sort_order')), 60 * 60e3);
const getOverview = () => cached('courses:overview', () => q(sb.rpc('course_overview')));
const getCatalog = () => cached('courses:catalog', () => q(sb.from('tm_courses')
  .select('id,name,name_key,location,lat,lon,difficulty,holes,tags,description,par,length_m,slope,course_rating,fictional,image_url,updated_at,tm_created_at,available_from')
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
      <p class="muted small">Bruk den samme My Caddie-brukeren som i Chrome-utvidelsen. Ny bruker? Du får en invitasjon på e-post.</p>
      ${authError ? `<div class="card warn small">Lenken virket ikke (${esc(decodeURIComponent(authError[1].replace(/\+/g, ' ')))}). Be om en ny, eller bruk «Glemt passord».</div>` : ''}
      <form id="login">
        <label for="em">E-post</label><input id="em" type="email" autocomplete="username" required>
        <label for="pw">Passord</label><input id="pw" type="password" autocomplete="current-password" required>
        <div class="row" style="margin-top:16px"><button class="btn primary" type="submit">Logg inn</button><button class="btn ghost sm" type="button" id="forgot">Glemt passord?</button></div>
        <div id="lerr" class="small" style="color:var(--bad);margin-top:8px"></div>
      </form>
    </div>`;
  document.getElementById('forgot').onclick = async () => {
    const email = em.value.trim();
    if (!email) { document.getElementById('lerr').textContent = 'Skriv inn e-posten din først.'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    document.getElementById('lerr').style.color = error ? 'var(--bad)' : 'var(--accent)';
    document.getElementById('lerr').textContent = error ? 'Kunne ikke sende e-post: ' + error.message : 'Sjekk e-posten din for en lenke til å velge nytt passord.';
  };
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: em.value.trim(), password: pw.value });
    if (error) { document.getElementById('lerr').textContent = 'Feil e-post eller passord.'; return; }
    route();
  });
}

async function renderSetPassword() {
  $tabs.hidden = true; $title.textContent = 'My Caddie';
  const { data } = await sb.auth.getUser();
  $view.innerHTML = `
    <div class="login-hero">${document.querySelector('.logo').outerHTML.replace('class="logo"', '')}</div>
    <div class="card"><h2 style="margin-top:0">Velg passord</h2>
      <p class="muted small">For ${esc(data.user?.email || '')}. Du bruker det samme passordet i appen og i Chrome-utvidelsen.</p>
      <form id="setpw">
        <label for="p1">Nytt passord (minst 8 tegn)</label><input id="p1" type="password" autocomplete="new-password" minlength="8" required>
        <label for="p2">Gjenta passordet</label><input id="p2" type="password" autocomplete="new-password" minlength="8" required>
        <div class="row" style="margin-top:16px"><button class="btn primary" type="submit">Lagre passord</button></div>
        <div id="perr" class="small" style="color:var(--bad);margin-top:8px"></div>
      </form></div>`;
  document.getElementById('setpw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = p1.value, b = p2.value;
    if (a.length < 8) { perr.textContent = 'Passordet må ha minst 8 tegn.'; return; }
    if (a !== b) { perr.textContent = 'Passordene er ikke like.'; return; }
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) { perr.textContent = 'Kunne ikke lagre: ' + error.message; return; }
    needPassword = false; toast('Passordet er lagret. Velkommen!');
    history.replaceState(null, '', location.pathname + '#/'); route();
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
  if (!last && !profile.length) h += `<section class="hero" style="padding-bottom:16px"><div class="eyebrow">Velkommen</div>
      <div style="font-family:var(--serif);font-size:24px;font-weight:700;margin:4px 0 6px">Kom i gang med My Caddie</div>
      <div class="sub">Appen fylles av seg selv fra TrackMan når utvidelsen er installert.</div></section>
    <div class="card"><ol style="margin:0;padding-left:20px;line-height:1.6">
      <li><a href="my-caddie-sync.zip" download>Last ned My Caddie Sync</a> (Chrome-utvidelse) og pakk ut zip-filen til en fast mappe.</li>
      <li>I Chrome: gå til <b>chrome://extensions</b>, slå på <b>Utviklermodus</b>, klikk <b>Last inn upakket</b> og velg mappen.</li>
      <li>Klikk på utvidelsen og logg inn med samme e-post og passord som her.</li>
      <li>Vær innlogget i <a href="https://portal.trackmangolf.com" target="_blank" rel="noopener">TrackMan Portal</a> i Chrome, og trykk <b>Synk nå</b>. Første gang tar det noen minutter.</li>
      <li>Gå til <a href="#/bag">Min bag</a> og kryss av hvilke køller du har.</li>
    </ol></div>`;
  if (sim18) h += `<section class="hero">
      <div class="eyebrow">Simulator · 18 hull</div>
      <div class="big">${signed(+sim18.last5_to_par_avg)}</div>
      <div class="sub">snitt mot par siste 5 runder</div>
      <div class="hero-stats"><div><b>${signed(+sim18.to_par_avg)}</b>snitt 12 mnd</div><div><b>${best === null ? '–' : signed(best, 0)}</b>beste siste 30</div><div><b>${sim18.rounds}</b>runder</div></div>
      <div class="spark" id="spark"></div></section>`;
  if (ageDays > 7 && last) h += `<div class="card warn"><b>TrackMan-synken har ikke gått på ${last ? Math.floor(ageDays) + ' dager' : 'lenge'}.</b>
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
  const bag = asMode(profile.filter((r) => r.in_bag && r.category !== 'putter' && r.carry_p50));
  if (bag.length) {
    const max = Math.max(...bag.map((r) => +r.carry_p50));
    h += `<a class="card link" href="#/bag"><div class="row"><h3 style="margin:0">Min bag</h3><span class="spacer"></span><span class="small muted">forventet ${distMode()} ›</span></div>
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
  const mode = distMode();
  const shown = asMode(rows.filter((r) => (bagState.showAll || r.in_bag) && r.category !== 'putter' && r.carry_p50), mode);
  const body = $view.querySelector('#bagbody');
  if (!shown.length) { body.innerHTML = `<div class="empty">Ingen fullslag i denne perioden.</div>`; return; }
  const tableRows = rows.filter((r) => (bagState.showAll || r.in_bag) && r.category !== 'putter' && r.carry_p50);
  const cats = [...new Set(shown.map((r) => CAT[r.category] || 'iron'))];
  const legend = `<div class="legend">${cats.map((c) => `<span><i style="background:var(--c-${c})"></i>${CAT_LABEL[c]}</span>`).join('')}</div>`;
  body.innerHTML = `
    <div class="card"><div class="row"><h3 style="margin:0">Lengder og hull mellom køllene</h3><span class="spacer"></span>${distSwitch('dm')}</div>
      <div class="small muted" style="margin:4px 0 8px">${mode === 'total' ? 'Total lengde (carry + rulle, fra simulatoren)' : 'Carry'}: feltet går fra trygg (P20) til lang (P80), streken er forventet lengde (P50). Trykk på en kølle for detaljer.</div>
      ${legend}<div id="gap"></div></div>
    <div class="card"><h3>Spredning sett ovenfra</h3>
      <div class="small muted" style="margin-bottom:6px">Hver ellipse rommer 80 % av de gode fullslagene med kølla, målt der ballen ${mode === 'total' ? 'stopper' : 'lander'}. Bredden er sideavviket.</div>
      ${legend}<div id="disp"></div></div>
    <details class="card"><summary>Tabell med alle tall</summary><div style="overflow-x:auto"><table class="t"><thead><tr>
      <th>Kølle</th><th>Carry P20</th><th>Carry</th><th>Carry P80</th><th>Total P20</th><th>Total</th><th>Total P80</th><th>Side P80</th><th>Feilslag</th><th>n</th></tr></thead><tbody>` +
      tableRows.map((r) => `<tr><td>${esc(r.club)}</td><td>${fmt(r.carry_p20)}</td><td><b>${fmt(r.carry_p50)}</b></td><td>${fmt(r.carry_p80)}</td>
        <td>${fmt(r.total_p20)}</td><td><b>${fmt(r.total_p50)}</b></td><td>${fmt(r.total_p80)}</td><td>±${fmt(mode === 'total' ? r.total_side_abs_p80 : r.side_abs_p80)}</td><td>${fmt(r.mishit_pct, 1)} %</td><td>${fmt(r.full_shots)}</td></tr>`).join('') +
      `</tbody></table></div></details>
    <label class="row small"><input type="checkbox" id="all" ${bagState.showAll ? 'checked' : ''}> Vis også køller som ikke er i bagen</label>
    <details class="card" id="bagedit"><summary>Hvilke køller har du i bagen?</summary><div id="bagform" class="small muted" style="margin-top:8px">Laster…</div></details>`;
  wireDist(body, 'dm', renderBag);
  gappingChart(body.querySelector('#gap'), shown);
  dispersionField(body.querySelector('#disp'), shown.filter((r) => r.side_abs_p80));
  body.querySelector('#all').onchange = (e) => { bagState.showAll = e.target.checked; renderBag(); };
  body.querySelector('#bagedit').addEventListener('toggle', async (e) => { if (e.target.open) await renderBagEditor(body.querySelector('#bagform'), rows); }, { once: true });
}

// Tick the clubs in the bag; saved as a new period from today (the history is kept)
async function renderBagEditor(el, rows) {
  const clubs = (await getClubs()).filter((c) => c.category !== 'putter');
  const used = new Map(rows.map((r) => [r.club, r]));
  const list = clubs.filter((c) => used.has(c.name)).concat(clubs.filter((c) => !used.has(c.name)));
  el.classList.remove('muted');
  el.innerHTML = `<p class="muted" style="margin-top:0">Kryss av køllene du har nå. Endringen gjelder fra i dag, tidligere perioder beholdes.</p>
    <div style="columns:2;column-gap:16px">${list.map((c) => { const r = used.get(c.name);
      return `<label style="display:flex;gap:8px;align-items:center;margin:4px 0;color:var(--ink);break-inside:avoid"><input type="checkbox" value="${c.id}" ${r?.in_bag ? 'checked' : ''}>
        <span class="sw" style="background:${catVar(c.category)}"></span>${esc(c.name)}${r ? ` <span class="muted">(${fmt(r.full_shots)})</span>` : ''}</label>`; }).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary sm" id="savebag">Lagre bagen</button></div>`;
  el.querySelector('#savebag').onclick = async () => {
    const ids = [...el.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
    if (ids.length > 14) { toast(`Du har valgt ${ids.length} køller. Regelen er maks 14, men jeg lagrer likevel.`); }
    try { await q(sb.rpc('set_bag', { p_in_bag: ids })); invalidate('profile:'); invalidate('review:'); toast('Bagen er lagret'); renderBag(); }
    catch (e) { toast('Kunne ikke lagre: ' + e.message); }
  };
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
const courseState = { tab: 'rec', search: '', newLimit: 40 };
let triedDates = false;
async function ensureCatalog(force = false) {
  const cat = await getCatalog();
  const newest = cat.reduce((m, c) => (c.updated_at > m ? c.updated_at : m), '');
  const hasDates = cat.some((c) => c.tm_created_at || c.available_from);
  const needDates = !hasDates && !triedDates; triedDates = true;
  if (!force && !needDates && cat.length > 100 && newest && Date.now() - new Date(newest) < 14 * 864e5) return cat;
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
      <button data-k="new" class="${courseState.tab === 'new' ? 'on' : ''}">Nyeste</button>
      <button data-k="played" class="${courseState.tab === 'played' ? 'on' : ''}">Spilt</button></div></div>
    <div id="cbody"><div class="loading">Laster…</div></div>`;
  $view.querySelector('#ct').onclick = (e) => { const k = e.target.dataset.k; if (k) { courseState.tab = k; renderCourses(); } };
  const body = $view.querySelector('#cbody');
  const overview = await getOverview();
  let catalog = [];
  try { catalog = await ensureCatalog(); } catch (e) { if (courseState.tab !== 'played') { body.innerHTML = `<div class="card warn">${esc(e.message)}</div>`; return; } }
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

  const withPlayed = (c) => { const o = overview.find((x) => x.kind === 'simulator' && (x.tm_course_id === c.id || nameKey(x.course_name) === c.name_key));
    return { ...c, playedInfo: o ? { rounds: o.rounds, last: o.last_played, stars: o.stars } : null }; };
  const addedAt = (c) => c.available_from || c.tm_created_at || null;
  const baseCard = (c, extra = '') => `<div class="ccard"><div class="img" style="${imgStyle(c.image_url)}">${extra}
      ${playedBadge(c)}
      ${(c.tags || []).includes('Links') ? '<span class="tag">Links</span>' : (c.tags || []).includes('TourVenue') ? '<span class="tag">Tour</span>' : ''}</div>
      <div class="body"><div class="t">${esc(c.name)}</div>
      <div class="m">${esc(c.location || '')}</div>
      <div class="m">${c.par ? 'Par ' + c.par : ''}${c.length_m ? ' · ' + fmt(c.length_m) + ' m' : ''} ${diffBar(c.difficulty)}</div>
      ${c.reason ? `<div class="why">${esc(c.reason)}</div>` : ''}</div></div>`;

  if (courseState.tab === 'new') {
    const dated = catalog.filter((c) => addedAt(c)).map(withPlayed).sort((a, b) => addedAt(b).localeCompare(addedAt(a)));
    if (!dated.length) { body.innerHTML = `<div class="card warn">TrackMan oppgir ikke når banene ble lagt til akkurat nå. Prøv «Oppdater baneliste» senere.</div>`; return; }
    const shown = dated.slice(0, courseState.newLimit);
    let h = `<p class="small muted" style="margin-top:12px">Sortert etter når banen kom i TrackMan, nyeste først. ${dated.filter((c) => !c.playedInfo).length} av ${dated.length} har du ikke spilt.</p>`;
    let month = '';
    for (const c of shown) {
      const d = new Date(addedAt(c));
      const m = d.toLocaleDateString('nb-NO', { month: 'long', year: 'numeric' });
      if (m !== month) { if (month) h += `</div>`; h += `<h2 class="month">${m.charAt(0).toUpperCase() + m.slice(1)}</h2><div class="ccards">`; month = m; }
      h += baseCard(c, `<span class="match">Ny ${d.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' })}</span>`);
    }
    h += `</div>`;
    if (dated.length > shown.length) h += `<div class="row" style="justify-content:center;margin:16px 0"><button class="btn" id="more">Vis flere (${dated.length - shown.length} igjen)</button></div>`;
    body.innerHTML = h;
    const more = body.querySelector('#more'); if (more) more.onclick = () => { courseState.newLimit += 40; renderCourses(); };
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
  const card = (c, i, showMatch) => baseCard(c, showMatch ? `<span class="match">${Math.round(Math.max(0.35, c.score / maxScore) * 100)} % match</span>` : '');
  const draw = () => {
    const s = courseState.search.trim().toLowerCase();
    if (s) {
      const hits = catalog.filter((c) => (c.name + ' ' + (c.location || '')).toLowerCase().includes(s)).slice(0, 24).map(withPlayed);
      clist.innerHTML = `<h2>Søk</h2>${hits.length ? `<div class="ccards">${hits.map((c, i) => card(c, i, false)).join('')}</div>` : '<div class="empty">Ingen treff</div>'}`;
    } else {
      clist.innerHTML = `<h2>Baner du trolig vil like</h2><div class="ccards">${res.picks.map((c, i) => card(c, i, true)).join('')}</div>`;
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

// ---------------------------------------------------------------- matchplay
const MP_KEY = 'mc_match_names';
function mpNames() { try { return { p1: 'Fredrik', p2: 'Jimmy', ...(JSON.parse(localStorage.getItem(MP_KEY)) || {}) }; } catch { return { p1: 'Fredrik', p2: 'Jimmy' }; } }
function mpSaveNames(n) { try { localStorage.setItem(MP_KEY, JSON.stringify(n)); } catch { /* private mode */ } }
const mpUnfinished = (m) => /Ikke fullført: stilling etter (\d+)/.exec(m.note || '');
const mpResult = (m) => { const u = mpUnfinished(m); if (u) return m.winner === 0 ? `AS etter ${u[1]}` : `${m.margin} opp etter ${u[1]}`;
  return m.winner === 0 ? 'Delt' : m.remaining ? `${m.margin}&${m.remaining}` : `${m.margin} opp`; };
// Gross matchplay (no strokes) from the hole-by-hole scores; null when there is no hole data (manual matches)
function grossOf(m) {
  if (!Array.isArray(m.holes) || !m.holes.length) return null;
  const hs = m.holes.filter((x) => x.g1 != null || x.g2 != null); const n = hs.length; let st = 0;
  for (let i = 0; i < n; i++) {
    const { g1, g2 } = hs[i];
    st += g1 == null ? -1 : g2 == null ? 1 : g1 < g2 ? 1 : g1 > g2 ? -1 : 0;
    const left = n - i - 1;
    if (Math.abs(st) > left) return { winner: st > 0 ? 1 : 2, margin: Math.abs(st), remaining: left };
  }
  return { winner: st > 0 ? 1 : st < 0 ? 2 : 0, margin: Math.abs(st), remaining: 0 };
}
const RESULTS = ['1 opp', '2 opp', '2&1', '3&1', '3&2', '4&2', '4&3', '5&3', '5&4', '6&4', '6&5', '7&5', '7&6', '8&6', '8&7', '9&7', '9&8', '10&8'];
const lastWednesday = () => { const d = new Date(); const back = (d.getDay() - 3 + 7) % 7; d.setDate(d.getDate() - back); return d.toISOString().slice(0, 10); };
const hcp = (v) => v === null || v === undefined ? '–' : Number(v).toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function holeTable(m) {
  const cell = (g, st) => `${g ?? '–'}${st ? `<sup style="color:var(--gold-ink)">${'•'.repeat(st)}</sup>` : ''}`;
  const status = (v) => v === 0 ? 'AS' : v > 0 ? `+${v}` : `−${-v}`;
  return `<details style="margin-top:6px"><summary class="small">Hull for hull</summary><div style="overflow-x:auto"><table class="t" style="font-size:13px;margin-top:4px">
    <thead><tr><th>Hull</th><th>Par</th><th>SI</th><th>${esc(m.p1_name)}</th><th>${esc(m.p2_name)}</th><th>${esc(m.p1_name)} netto</th></tr></thead><tbody>
    ${m.holes.map((x) => `<tr style="${x.counted === false ? 'opacity:.45' : ''}"><td>${x.hole}</td><td>${x.par ?? ''}</td><td>${x.si ?? ''}</td>
      <td style="${x.res > 0 ? 'font-weight:700;color:var(--good)' : ''}">${cell(x.g1, x.s1)}</td><td style="${x.res < 0 ? 'font-weight:700;color:var(--good)' : ''}">${cell(x.g2, x.s2)}</td>
      <td>${x.counted === false ? '' : status(x.status)}</td></tr>`).join('')}
    </tbody></table></div><div class="small muted">• = tildelt slag på hullet. Grå hull ble spilt etter at matchen var avgjort.</div></details>`;
}

async function renderMatchplay() {
  $title.textContent = 'Matchplay';
  $view.innerHTML = `<div class="loading">Laster…</div>`;
  const [matches, overview, me] = await Promise.all([
    q(sb.from('matches').select('*').order('played_on', { ascending: false }).order('created_at', { ascending: false }).limit(500)),
    getOverview().catch(() => []),
    sb.auth.getUser().then((r) => r.data.user),
  ]);
  const names = mpNames();
  const key = (n) => String(n || '').trim().toLowerCase();
  // standings per player name
  const st = new Map();
  const add = (name) => { const k = key(name); if (!st.has(k)) st.set(k, { name: String(name).trim(), n: 0, w: 0, d: 0, l: 0, pm: 0, gpm: 0, gn: 0 }); return st.get(k); };
  add(names.p1); add(names.p2);
  const chrono = [...matches].reverse();
  const series = []; let run = 0;
  for (const m of chrono) {
    const a = add(m.p1_name), b = add(m.p2_name);
    a.n++; b.n++;
    if (m.winner === 0) { a.d++; b.d++; }
    else { const [w, l] = m.winner === 1 ? [a, b] : [b, a]; w.w++; l.l++; w.pm += m.margin; l.pm -= m.margin; }
    const g = grossOf(m);
    if (g) { a.gn++; b.gn++; if (g.winner) { const [gw, gl] = g.winner === 1 ? [a, b] : [b, a]; gw.gpm += g.margin; gl.gpm -= g.margin; } }
    const sgn = m.winner === 0 ? 0 : ((m.winner === 1 ? key(m.p1_name) : key(m.p2_name)) === key(names.p1) ? 1 : -1);
    run += sgn * m.margin; series.push({ d: m.played_on, v: run, m });
  }
  const rows = [...st.values()].sort((x, y) => y.pm - x.pm || y.w - x.w);
  const leader = rows[0] && rows[0].pm !== (rows[1]?.pm ?? 0) ? rows[0] : null;
  const courses = [...new Set(overview.map((c) => cleanName(c.course_name)).concat(matches.map((m) => m.course_name)))].sort((a, b) => a.localeCompare(b, 'nb'));
  const last = matches[0];

  let h = `<section class="hero" style="padding-bottom:14px"><div class="eyebrow">Onsdagsmatchen</div>
    <div style="font-family:var(--serif);font-size:24px;font-weight:700;margin:4px 0 2px">${esc(names.p1)} mot ${esc(names.p2)}</div>
    <div class="sub">${matches.length ? (leader ? `${esc(leader.name)} leder med ${signed(leader.pm, 0)} etter ${matches.length} ${matches.length === 1 ? 'runde' : 'runder'}` : `Helt likt etter ${matches.length} ${matches.length === 1 ? 'runde' : 'runder'}`) : 'Ingen matcher registrert ennå'}</div>
    ${series.length > 1 ? `<div id="mpchart" style="margin-top:10px"></div>` : ''}</section>
  ${matches.some((m) => m.auto && (m.p1_hcp === null || m.p2_hcp === null)) ? `<div class="card warn small">Noen matcher er regnet <b>brutto</b> fordi hcp ikke er hentet fra TrackMan ennå. Oppdater Chrome-utvidelsen til versjon 0.3.0 og synk, så hentes hcp fra scorekortene og matchene regnes om.</div>` : ''}
  <div class="card"><table class="t mp"><thead><tr><th>Spiller</th><th>Runder</th><th>Seier</th><th>Delt</th><th>Tap</th><th>+/− netto</th><th>+/− brutto</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.n}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
      <td><b class="${r.pm > 0 ? 'neg' : r.pm < 0 ? 'pos' : ''}">${r.pm > 0 ? '+' : ''}${r.pm}</b></td>
      <td class="muted">${r.gn ? (r.gpm > 0 ? '+' : '') + r.gpm : '–'}</td></tr>`).join('')}
  </tbody></table><div class="small muted" style="margin-top:6px">Seier, delt og tap er netto (med tildelte slag). +/− er summen av hull opp eller ned i hver match (3&2 teller 3). Brutto er samme match uten slag${matches.some((m) => !grossOf(m)) ? ', bare for matcher med score per hull' : ''}.</div></div>

  <details class="card" id="mpform" ${matches.length ? '' : 'open'}><summary><b>Registrer match</b></summary>
    <form id="mpf" style="margin-top:8px">
      <div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label for="mpd">Dato</label><input id="mpd" type="date" value="${lastWednesday()}" required></div>
        <div style="flex:1"><label for="mpk">Hvor</label><select id="mpk"><option value="outdoor">Ute</option><option value="simulator">Simulator</option></select></div></div>
      <label for="mpc">Bane</label><input id="mpc" type="text" list="mpcourses" required placeholder="F.eks. Bærum Golfklubb" value="${esc(last?.course_name || '')}">
      <datalist id="mpcourses">${courses.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="row" style="flex-wrap:nowrap">
        <div style="flex:1"><label for="mpn1">Spiller 1</label><input id="mpn1" type="text" value="${esc(names.p1)}" required></div>
        <div style="width:96px"><label for="mph1">Hcp</label><input id="mph1" type="number" step="0.1" min="-10" max="54" inputmode="decimal" value="${last ? (key(last.p1_name) === key(names.p1) ? last.p1_hcp : last.p2_hcp) ?? '' : ''}"></div></div>
      <div class="row" style="flex-wrap:nowrap">
        <div style="flex:1"><label for="mpn2">Spiller 2</label><input id="mpn2" type="text" value="${esc(names.p2)}" required></div>
        <div style="width:96px"><label for="mph2">Hcp</label><input id="mph2" type="number" step="0.1" min="-10" max="54" inputmode="decimal" value="${last ? (key(last.p2_name) === key(names.p2) ? last.p2_hcp : last.p1_hcp) ?? '' : ''}"></div></div>
      <label>Vinner</label>
      <div class="seg" id="mpw"><button type="button" data-w="1" class="on">${esc(names.p1)}</button><button type="button" data-w="0">Delt</button><button type="button" data-w="2">${esc(names.p2)}</button></div>
      <label for="mpr">Resultat</label><select id="mpr">${RESULTS.map((r) => `<option ${r === '2&1' ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label for="mpnote">Notat (valgfritt)</label><input id="mpnote" type="text" placeholder="F.eks. avgjort på 17. med birdie">
      <div class="row" style="margin-top:14px"><button class="btn primary" type="submit">Lagre match</button><span id="mperr" class="small" style="color:var(--bad)"></span></div>
    </form></details>

  <div class="small muted" style="margin:8px 2px">Simulatormatcher på onsdager registreres automatisk når begge har synket runden fra TrackMan (samme bane, samme dag). Bruk skjemaet for matcher ute.
    <button class="btn ghost sm" id="mpdetect">Se etter nye nå</button></div>
  <h2>Matcher</h2>
  ${matches.length ? `<div class="card"><ul class="list">${matches.map((m) => {
    const wname = m.winner === 1 ? m.p1_name : m.winner === 2 ? m.p2_name : null;
    const mine = me && m.created_by === me.id && !m.auto;
    const given = m.p1_ch != null && m.p2_ch != null && m.p1_ch !== m.p2_ch
      ? `${esc(m.p1_ch > m.p2_ch ? m.p1_name : m.p2_name)} fikk ${Math.abs(m.p1_ch - m.p2_ch)} slag` : '';
    return `<li><div class="row" style="flex-wrap:nowrap;align-items:flex-start">
      <div style="flex:1;min-width:0"><div class="rtitle">${esc(m.course_name)} ${m.auto ? '<span class="chip">fra TrackMan</span>' : ''}</div>
        <div class="small muted">${dateNo(m.played_on)} · ${m.kind === 'simulator' ? 'Simulator' : 'Ute'} · hcp ${esc(m.p1_name)} ${hcp(m.p1_hcp)} / ${esc(m.p2_name)} ${hcp(m.p2_hcp)}${m.p1_ch != null && m.p2_ch != null ? ` · spillehcp ${m.p1_ch} / ${m.p2_ch}` : ''}${given ? ' · ' + given : ''}</div>
        ${m.note ? `<div class="small">${esc(m.note)}</div>` : ''}
        ${Array.isArray(m.holes) && m.holes.length ? holeTable(m) : ''}
        ${mine ? `<button class="btn ghost sm mpdel" data-id="${m.id}" style="margin-top:4px;min-height:28px;padding:2px 8px">Slett</button>` : ''}</div>
      <div style="text-align:center"><div class="score-badge ${m.winner === 0 ? 'even' : 'under'}" style="min-width:74px">${esc(mpResult(m))}<small>${wname ? esc(wname) : 'delt'} · netto</small></div>
        ${(() => { const g = grossOf(m); return g ? `<div class="small muted" style="margin-top:4px">Brutto: ${esc(mpResult(g))}${g.winner ? ' ' + esc(g.winner === 1 ? m.p1_name : m.p2_name) : ''}</div>` : ''; })()}</div></div></li>`;
  }).join('')}</ul></div>` : `<div class="empty">Registrer den første matchen over.</div>`}`;
  $view.innerHTML = h;

  // cumulative chart for player 1
  const ch = $view.querySelector('#mpchart');
  if (ch) {
    const W = ch.clientWidth || 320, H = 70, pad = 6, n = series.length;
    const vs = series.map((p) => p.v).concat(0), lo = Math.min(...vs), hi = Math.max(...vs), span = Math.max(1, hi - lo);
    const X = (i) => pad + (i / (n - 1)) * (W - 2 * pad), Y = (v) => pad + ((hi - v) / span) * (H - 2 * pad);
    const path = series.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    ch.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Akkumulert +/− for ${esc(names.p1)} over tid">
      <line x1="${pad}" x2="${W - pad}" y1="${Y(0)}" y2="${Y(0)}" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 4"/>
      <path d="${path}" fill="none" stroke="#ffe08a" stroke-width="2.5" stroke-linejoin="round"/>
      ${series.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.v)}" r="3" fill="#fff"><title>${dateNo(p.d)} · ${esc(p.m.course_name)} · ${esc(mpResult(p.m))} · ${esc(names.p1)} ${p.v > 0 ? '+' : ''}${p.v}</title></circle>`).join('')}</svg>
      <div class="small" style="opacity:.8">${esc(names.p1)} sin stilling over tid (over streken = foran)</div>`;
  }

  // form
  let winner = 1;
  const f = $view.querySelector('#mpf');
  $view.querySelector('#mpw').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; winner = +b.dataset.w;
    $view.querySelectorAll('#mpw button').forEach((x) => x.classList.toggle('on', x === b)); $view.querySelector('#mpr').disabled = winner === 0; };
  const syncNames = () => { const b = $view.querySelectorAll('#mpw button'); b[0].textContent = mpn1.value || 'Spiller 1'; b[2].textContent = mpn2.value || 'Spiller 2'; };
  mpn1.oninput = syncNames; mpn2.oninput = syncNames;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = $view.querySelector('#mpr').value;
    const [mg, rm] = res.includes('&') ? res.split('&').map(Number) : [parseInt(res, 10), 0];
    const num = (v) => (v === '' ? null : Math.round(parseFloat(String(v).replace(',', '.')) * 10) / 10);
    const row = { played_on: mpd.value, kind: mpk.value, course_name: mpc.value.trim(), p1_name: mpn1.value.trim(), p1_hcp: num(mph1.value),
      p2_name: mpn2.value.trim(), p2_hcp: num(mph2.value), winner, margin: winner ? mg : 0, remaining: winner ? rm : 0, note: mpnote.value.trim() || null };
    if (!row.course_name || !row.p1_name || !row.p2_name) { mperr.textContent = 'Fyll inn bane og navn.'; return; }
    try {
      await q(sb.from('matches').insert(row));
      mpSaveNames({ p1: row.p1_name, p2: row.p2_name });
      toast(`Match lagret: ${winner ? (winner === 1 ? row.p1_name : row.p2_name) + ' vant ' + res : 'delt'}`);
      renderMatchplay();
    } catch (err) { mperr.textContent = 'Kunne ikke lagre: ' + err.message; }
  });
  $view.querySelector('#mpdetect').onclick = async () => { try { const n = await q(sb.rpc('detect_matches')); toast(`${n} matcher fra TrackMan er oppdatert`); renderMatchplay(); } catch (e) { toast('Feil: ' + e.message); } };
  // two-tap delete
  $view.querySelectorAll('.mpdel').forEach((b) => b.onclick = async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Trykk igjen for å slette'; b.style.color = 'var(--bad)'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Slett'; b.style.color = ''; }, 4000); return; }
    try { await q(sb.from('matches').delete().eq('id', b.dataset.id)); toast('Matchen er slettet'); renderMatchplay(); } catch (err) { toast('Kunne ikke slette: ' + err.message); }
  });
}

// ---------------------------------------------------------------- profile
async function renderProfile() {
  $title.textContent = 'Profil';
  const { data: { user } } = await sb.auth.getUser();
  const [prof, hist] = await Promise.all([
    q(sb.from('profiles').select('display_name').eq('user_id', user.id)),
    q(sb.from('hcp_history').select('valid_from,hcp_index').eq('user_id', user.id).order('valid_from', { ascending: false })),
  ]);
  const name = prof[0]?.display_name || '';
  $view.innerHTML = `<div class="card"><h3 style="margin-top:0">Deg</h3>
      <div class="small muted">Innlogget som ${esc(user.email)}</div>
      <form id="pf"><label for="pfn">Navn (vises i Matchplay)</label><input id="pfn" type="text" value="${esc(name)}" required>
        <div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label for="pfh">Hcp-indeks</label><input id="pfh" type="number" step="0.1" min="-10" max="54" inputmode="decimal" value="${hist[0]?.hcp_index ?? ''}"></div>
        <div style="flex:1"><label for="pfd">Gjelder fra</label><input id="pfd" type="date" value="${today()}"></div></div>
        <div class="small muted" style="margin-top:6px">Matchplay bruker handicapet som står på TrackMan-scorekortet. Dette feltet er bare reserve for runder der TrackMan ikke har hcp. Full differanse gis på hullene med lavest slagindeks.</div>
        <div class="row" style="margin-top:14px"><button class="btn primary" type="submit">Lagre</button><span id="pfe" class="small" style="color:var(--bad)"></span></div></form></div>
    ${hist.length ? `<div class="card"><h3 style="margin-top:0">Hcp-historikk</h3><ul class="list">${hist.map((h) => `<li class="row"><span>${dateNo(h.valid_from)}</span><span class="spacer"></span><b class="num">${hcp(h.hcp_index)}</b></li>`).join('')}</ul></div>` : ''}
    <div class="row" style="margin:16px 0"><button class="btn" id="logout">Logg ut</button></div>`;
  $view.querySelector('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = pfh.value === '' ? null : Math.round(parseFloat(String(pfh.value).replace(',', '.')) * 10) / 10;
    try { const r = await q(sb.rpc('set_profile', { p_name: pfn.value.trim(), p_hcp: v, p_from: pfd.value || today() }));
      toast(`Lagret${r?.matches ? ` · ${r.matches} matcher regnet om` : ''}`); renderProfile(); }
    catch (err) { pfe.textContent = 'Kunne ikke lagre: ' + err.message; }
  });
  $view.querySelector('#logout').onclick = async () => { await sb.auth.signOut(); cache.clear(); location.hash = '#/'; route(); };
}
document.getElementById('btn-account').onclick = () => { location.hash = '#/profil'; };

// ---------------------------------------------------------------- router
const routes = { '': ['home', renderHome], bag: ['bag', renderBag], runder: ['runder', renderRounds], baner: ['baner', renderCourses],
  strategi: ['strategi', () => renderStrategy($view, { sb, getProfile, toast, esc, fmt, setTitle: (t) => $title.textContent = t })],
  match: ['match', renderMatchplay], profil: ['', renderProfile], sjekk: ['home', renderReview] };
let routing = 0;
async function route() {
  const my = ++routing;
  hideTip();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  if (needPassword) return renderSetPassword();
  if (/access_token=|error=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/');
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

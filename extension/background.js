// My Caddie Sync – service worker
importScripts('transform.js');
const T = self.MyCaddieTransform;

const SUPABASE_URL = 'https://rhwbvviwdmkkpxqpuams.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NOhVkvqnjTltnUMYmS66og_tXdhZmGC'; // public client key; access is enforced by login + RLS
const PORTAL_URL = 'https://portal.trackmangolf.com/player/activities';
const AUTO_MINUTES = 12 * 60;

// ---------------------------------------------------------------- state & progress
let running = false;
async function getState() { return (await chrome.storage.local.get(['session', 'last', 'auto', 'log'])) || {}; }
async function setState(patch) { await chrome.storage.local.set(patch); }
async function progress(text, level = 'info') {
  const { log = [] } = await chrome.storage.local.get('log');
  log.push({ t: new Date().toISOString(), text, level });
  await chrome.storage.local.set({ log: log.slice(-200) });
  chrome.runtime.sendMessage({ type: 'progress', text, level }).catch(() => {});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Supabase auth (your My Caddie login)
async function authRequest(path, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `Innlogging feilet (${r.status})`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: j.user && j.user.email };
}
async function login(email, password) { const s = await authRequest('token?grant_type=password', { email, password }); await setState({ session: s }); return s; }
async function session() {
  const { session: s } = await getState();
  if (!s) throw new Error('Ikke logget inn i My Caddie');
  if (Date.now() < s.expires_at - 60000) return s;
  const n = await authRequest('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
  n.email = n.email || s.email; await setState({ session: n }); return n;
}
async function rpc(fn, args) {
  const s = await session();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || `Databasefeil (${r.status})`);
  return j;
}

// ---------------------------------------------------------------- TrackMan portal (read-only, via your open portal tab)
async function portalTab(openIfMissing) {
  const tabs = await chrome.tabs.query({ url: 'https://portal.trackmangolf.com/*' });
  if (tabs.length) return { tab: tabs[0], opened: false };
  if (!openIfMissing) return null;
  const tab = await chrome.tabs.create({ url: PORTAL_URL, active: false, pinned: true });
  return { tab, opened: true };
}
async function portalReady(tabId, timeoutMs = 25000) {
  const start = Date.now(); let reloaded = false;
  while (Date.now() - start < timeoutMs) {
    const st = await chrome.tabs.sendMessage(tabId, { type: 'mc-status' }).catch(() => null);
    if (st && st.ready) return true;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && /login\.trackmangolf\.com/.test(tab.url || '')) throw new Error('Du er ikke logget inn i TrackMan Portal. Åpne portalen og logg inn, og prøv igjen.');
    // The portal only reveals its login when it makes its own requests; a reload makes it do that.
    if (!reloaded && Date.now() - start > 6000) { reloaded = true; await chrome.tabs.reload(tabId).catch(() => {}); }
    await sleep(1000);
  }
  throw new Error('Fikk ikke kontakt med TrackMan Portal. Last portalen på nytt og prøv igjen.');
}
async function gqlBody(tabId, query, variables) {
  const res = await chrome.tabs.sendMessage(tabId, { type: 'mc-gql', query, variables });
  if (!res) throw new Error('Ingen svar fra portalfanen');
  if (res.error) throw new Error(res.error === 'not_ready' ? 'Portalen er ikke klar ennå' : res.error);
  const b = res.body || {};
  if (b.errors && b.errors.length && !b.data) throw new Error(b.errors.map((e) => e.message).join('; '));
  return b;
}
async function gql(tabId, query, variables) { return (await gqlBody(tabId, query, variables)).data; }

// Course rounds: ask for every player's scorecard; if TrackMan refuses that part, ask again without it.
let playersSupported = true;
async function fetchActivity(tabId, a, light) {
  if (a.kind === 'COURSE_PLAY' && playersSupported) {
    const q = T.queryFor(a, { light });
    try {
      const b = await gqlBody(tabId, q.query, q.variables);
      const node = b.data && b.data.node;
      const failed = (b.errors || []).some((e) => /playersScorecards/i.test(JSON.stringify(e)));
      if (!failed) return node;
    } catch (e) { if (!/playersScorecards/i.test(e.message)) throw e; }
    playersSupported = false;
    await progress('TrackMan ga ikke motspillerens scorekort – henter uten det', 'warn');
  }
  const q = T.queryFor(a, { light, basic: true });
  const d = await gql(tabId, q.query, q.variables);
  return d && d.node;
}
async function listActivities(tabId) {
  const all = []; let skip = 0;
  for (let page = 0; page < 60; page++) {
    const d = await gql(tabId, T.Q_LIST, { skip, take: 100 });
    const a = d && d.me && d.me.activities; if (!a) break;
    all.push(...(a.items || []));
    skip += 100;
    if (!a.pageInfo || !a.pageInfo.hasNextPage) break;
    await sleep(250);
  }
  return all;
}

// ---------------------------------------------------------------- sync
async function plan(tabId) {
  const acts = await listActivities(tabId);
  const known = new Set(await rpc('sync_known_activities'));
  // known course rounds whose scorecard should be read again (without shots), e.g. to learn who played
  const refresh = new Set(await rpc('sync_refresh_activities').catch(() => []));
  const byKind = {};
  const todo = [];
  let nRefresh = 0;
  for (const a of acts) {
    const supported = T.SUPPORTED_KINDS.includes(a.kind);
    const k = byKind[a.kind] || (byKind[a.kind] = { total: 0, new: 0, supported });
    k.total++;
    if (!supported) continue;
    if (!known.has(a.id)) { k.new++; todo.push(a); }
    else if (a.kind === 'COURSE_PLAY' && refresh.has(a.id)) { nRefresh++; todo.push({ ...a, light: true }); }
  }
  todo.sort((x, y) => String(x.time).localeCompare(String(y.time)));
  return { total: acts.length, byKind, todo, nRefresh, oldest: acts.map((a) => a.time).sort()[0] || null };
}

async function run({ preview = false, auto = false } = {}) {
  if (running) return { error: 'En synk kjører allerede' };
  running = true;
  playersSupported = true;
  let opened = null;
  try {
    await session();
    const pt = await portalTab(true);
    opened = pt.opened ? pt.tab.id : null;
    await progress(auto ? 'Automatisk synk startet' : preview ? 'Sjekker hva som er nytt …' : 'Synk startet');
    await portalReady(pt.tab.id);
    const p = await plan(pt.tab.id);
    await progress(`Fant ${p.total} aktiviteter i TrackMan (eldste ${p.oldest ? p.oldest.slice(0, 10) : '–'}). ${p.todo.length - p.nRefresh} er nye` +
                   (p.nRefresh ? `, ${p.nRefresh} runder oppdateres.` : '.'));
    if (preview) { await setState({ preview: { at: new Date().toISOString(), total: p.total, byKind: p.byKind, todo: p.todo.length } }); return { ok: true, preview: p.byKind, todo: p.todo.length }; }

    let nSess = 0, nShots = 0, nRounds = 0, nSuperseded = 0, failed = 0; const unknownClubs = new Set();
    for (let i = 0; i < p.todo.length; i++) {
      const a = p.todo[i];
      try {
        const node = await fetchActivity(pt.tab.id, a, !!a.light);
        const payload = T.toPayload(a, node);
        const r = await rpc('sync_import', { p: payload });
        nSess += r.sessions_new; nShots += r.shots_new; if (r.round_new) nRounds++; nSuperseded += r.legacy_rounds_superseded || 0;
        (r.unknown_clubs || []).forEach((c) => unknownClubs.add(c));
        if ((i + 1) % 10 === 0 || i === p.todo.length - 1) await progress(`${i + 1}/${p.todo.length} aktiviteter · ${nShots} nye slag · ${nRounds} runder`);
      } catch (e) {
        failed++; await progress(`${a.kind} ${String(a.time).slice(0, 10)}: ${e.message}`, 'error');
        if (/Ikke logget inn|JWT|not allowed/i.test(e.message)) break;
      }
      await sleep(a.light ? 150 : 300);
    }
    const last = { at: new Date().toISOString(), activities: p.todo.length, sessions: nSess, shots: nShots, rounds: nRounds,
                   superseded: nSuperseded, failed, unknownClubs: [...unknownClubs] };
    await setState({ last });
    await progress(`Ferdig: ${nSess} nye økter, ${nShots} nye slag, ${nRounds} nye runder${failed ? `, ${failed} feilet` : ''}.`, failed ? 'warn' : 'ok');
    if (unknownClubs.size) await progress(`Køllenavn som ikke ble gjenkjent: ${[...unknownClubs].join(', ')}`, 'warn');
    return { ok: true, last };
  } catch (e) {
    await progress(e.message, 'error');
    await setState({ last: { at: new Date().toISOString(), error: e.message } });
    return { error: e.message };
  } finally {
    running = false;
    if (opened) chrome.tabs.remove(opened).catch(() => {});
  }
}

// ---------------------------------------------------------------- wiring
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.cmd) return false;
  (async () => {
    try {
      if (msg.cmd === 'login') { const s = await login(msg.email, msg.password); return { ok: true, email: s.email }; }
      if (msg.cmd === 'logout') { await chrome.storage.local.remove(['session']); return { ok: true }; }
      if (msg.cmd === 'state') { const s = await getState(); const { preview } = await chrome.storage.local.get('preview'); return { email: s.session && s.session.email, last: s.last, auto: s.auto !== false, log: (s.log || []).slice(-30), running, preview }; }
      if (msg.cmd === 'auto') { await setState({ auto: !!msg.on }); await schedule(); return { ok: true }; }
      if (msg.cmd === 'preview') return await run({ preview: true });
      if (msg.cmd === 'sync') return await run({});
      return { error: 'ukjent kommando' };
    } catch (e) { return { error: e.message }; }
  })().then(sendResponse);
  return true;
});

async function schedule() {
  const { auto } = await getState();
  await chrome.alarms.clear('mycaddie-auto');
  if (auto !== false) chrome.alarms.create('mycaddie-auto', { delayInMinutes: 5, periodInMinutes: AUTO_MINUTES });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'mycaddie-auto') return;
  const { session: s, auto } = await getState();
  if (!s || auto === false) return;
  await run({ auto: true });
});

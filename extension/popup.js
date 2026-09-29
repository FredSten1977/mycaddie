const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const KIND = { SESSION: 'Trening', SHOT_ANALYSIS: 'Shot analysis', VIRTUAL_RANGE: 'Virtual range', MAP_MY_BAG: 'Map My Bag',
  COURSE_PLAY: 'Course Play', COMBINE_TEST: 'Combine test' };
const fmt = (iso) => iso ? new Date(iso).toLocaleString('nb-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';

function addLog(text, level) {
  const el = $('log'); const d = document.createElement('div'); d.className = level || ''; d.textContent = text;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}

async function refresh() {
  const s = await send({ cmd: 'state' });
  const loggedIn = !!(s && s.email);
  $('loginForm').hidden = loggedIn; $('main').hidden = !loggedIn;
  if (!loggedIn) return;
  $('who').textContent = s.email;
  $('auto').checked = s.auto;
  $('sync').disabled = $('preview').disabled = !!s.running;
  const kv = $('last'); kv.innerHTML = '';
  const row = (k, v) => { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('span'); b.textContent = v; kv.append(a, b); };
  if (s.last) {
    row('Sist synket', fmt(s.last.at));
    if (s.last.error) row('Status', 'Feil – se logg');
    else { row('Nye slag', String(s.last.shots)); row('Nye runder', String(s.last.rounds)); }
  } else row('Sist synket', 'aldri');
  if (s.preview && s.preview.byKind) {
    row('Nye aktiviteter', String(s.preview.todo));
    Object.entries(s.preview.byKind).filter(([, v]) => v.supported).forEach(([k, v]) => row(`  ${KIND[k] || k}`, `${v.new} av ${v.total}`));
  }
  $('log').innerHTML = ''; (s.log || []).forEach((l) => addLog(`${fmt(l.t)}  ${l.text}`, l.level));
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('loginErr').textContent = ''; $('loginBtn').disabled = true;
  const r = await send({ cmd: 'login', email: $('email').value.trim(), password: $('password').value });
  $('loginBtn').disabled = false; $('password').value = '';
  if (r && r.error) $('loginErr').textContent = r.error; else refresh();
});
$('logout').addEventListener('click', async () => { await send({ cmd: 'logout' }); refresh(); });
$('auto').addEventListener('change', (e) => send({ cmd: 'auto', on: e.target.checked }));
$('preview').addEventListener('click', async () => { $('sync').disabled = $('preview').disabled = true; await send({ cmd: 'preview' }); refresh(); });
$('sync').addEventListener('click', async () => { $('sync').disabled = $('preview').disabled = true; await send({ cmd: 'sync' }); refresh(); });
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'progress') addLog(`${fmt(new Date().toISOString())}  ${m.text}`, m.level); });
refresh();

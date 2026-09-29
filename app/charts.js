// Small SVG chart helpers for My Caddie. No libraries; every chart has a hover/tap tooltip.
const NS = 'http://www.w3.org/2000/svg';
export const CAT = { driver: 'wood', wood: 'wood', hybrid: 'hybrid', iron: 'iron', wedge: 'wedge' };
export const CAT_LABEL = { wood: 'Driver og køller', hybrid: 'Hybrider', iron: 'Jern', wedge: 'Wedger' };
export const catVar = (category) => `var(--c-${CAT[category] || 'iron'})`;
const f0 = (v) => Math.round(v).toLocaleString('nb-NO');
const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const sgn = (v) => (v > 0 ? '+' : '') + f1(v);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// one shared tooltip element
let tipEl;
function tip() {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'viz-tip'; tipEl.hidden = true; document.body.appendChild(tipEl); }
  return tipEl;
}
export function showTip(html, x, y) {
  const t = tip(); t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
  t.style.top = Math.max(8, y - h - 12) + 'px';
}
export function hideTip() { if (tipEl) tipEl.hidden = true; }
if (typeof document !== 'undefined') document.addEventListener('scroll', hideTip, { passive: true });

// ------------------------------------------------------------------ trend line (to-par per round + rolling average)
export function trendChart(el, rounds, { height = 170, rolling = 5, compact = false } = {}) {
  const pts = rounds.filter((r) => r.par && r.strokes).map((r) => ({ d: r.played_on, v: r.strokes - r.par, name: r.course_name }))
    .sort((a, b) => a.d.localeCompare(b.d));
  if (pts.length < 2) { el.innerHTML = ''; return; }
  const W = el.clientWidth || 340, H = height, padL = compact ? 6 : 30, padR = 8, padT = 10, padB = compact ? 6 : 22;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  lo = Math.floor((lo - 1) / 5) * 5; hi = Math.ceil((hi + 1) / 5) * 5;
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const roll = pts.map((_, i) => { const s = pts.slice(Math.max(0, i - rolling + 1), i + 1); return s.reduce((a, b) => a + b.v, 0) / s.length; });
  let g = '';
  if (!compact) for (let v = lo; v <= hi; v += 5) g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid${v === 0 ? ' zero' : ''}"/><text x="${padL - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v > 0 ? '+' + v : v}</text>`;
  else g += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" class="grid zero"/>`;
  const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="${compact ? 2.5 : 3.5}" class="dot ${p.v <= 0 ? 'good' : ''}"/>`).join('');
  const line = roll.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  if (!compact) {
    const first = pts[0].d, last = pts[pts.length - 1].d;
    const lab = (d) => new Date(d).toLocaleDateString('nb-NO', { month: 'short', year: '2-digit' });
    g += `<text x="${padL}" y="${H - 4}" class="axis">${lab(first)}</text><text x="${W - padR}" y="${H - 4}" class="axis" text-anchor="end">${lab(last)}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Score mot par per runde, med glidende snitt over ${rolling} runder">
    ${g}${dots}<path d="${line}" class="trend"/><line class="cross" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/></svg>`;
  const svg = el.querySelector('svg'), cross = svg.querySelector('.cross');
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - padL) / (W - padL - padR)) * (pts.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    const p = pts[i];
    showTip(`<b>${esc(String(p.name || '').trim())}</b><br>${new Date(p.d).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' })}<br>Score <b>${sgn(p.v).replace(',0', '')}</b> · snitt siste ${rolling}: <b>${sgn(roll[i])}</b>`,
      r.left + (x(i) / W) * r.width, r.top + (y(p.v) / H) * r.height);
  };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
}

// ------------------------------------------------------------------ ring gauge
export function ring(pct, label, sub = '') {
  const r = 30, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, +pct || 0));
  return `<div class="ring" title="${esc(label)}: ${f0(v)} %">
    <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true"><circle cx="40" cy="40" r="${r}" class="ring-bg"/>
    <circle cx="40" cy="40" r="${r}" class="ring-fg" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 40 40)"/></svg>
    <div class="ring-v">${pct === null || pct === undefined ? '–' : f0(v) + '<small>%</small>'}</div>
    <div class="ring-l">${esc(label)}${sub ? `<br><span>${esc(sub)}</span>` : ''}</div></div>`;
}

// ------------------------------------------------------------------ gapping chart (horizontal, one row per club)
export function gappingChart(el, clubs) {
  const lo = Math.max(0, Math.floor(Math.min(...clubs.map((c) => +c.carry_p20)) / 10) * 10 - 10);
  const hi = Math.ceil(Math.max(...clubs.map((c) => +c.carry_p90 || +c.carry_p80)) / 20) * 20;
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;
  let h = '<div class="gap-chart">';
  clubs.forEach((c, i) => {
    const next = clubs[i + 1];
    h += `<div class="gap-row" data-i="${i}">
      <div class="gap-name"><span class="sw" style="background:${catVar(c.category)}"></span>${esc(c.club)}${c.confidence === 'lav' ? ' <span class="chip lav">lav sikkerhet</span>' : c.confidence === 'middels' ? ' <span class="chip lav">middels</span>' : ''}</div>
      <div class="gap-track">
        <div class="gap-base" style="width:${pct(c.carry_p50)}%;background:${catVar(c.category)}"></div>
        <div class="gap-band" style="left:${pct(c.carry_p20)}%;width:${pct(c.carry_p80) - pct(c.carry_p20)}%;background:color-mix(in srgb, ${catVar(c.category)} 55%, transparent)"></div>
        <div class="gap-p50" style="left:${pct(c.carry_p50)}%"><span>${f0(c.carry_p50)}</span></div>
      </div></div>`;
    if (next) {
      const gap = c.carry_p50 - next.carry_p50;
      const cls = gap > 16 ? 'wide' : gap < 6 ? 'tight' : '';
      h += `<div class="gap-delta ${cls}"><span>${gap < 6 ? '⚠ ' : gap > 16 ? '⚠ ' : ''}${f0(gap)} m${gap < 6 ? ' – overlapp' : gap > 16 ? ' – stort hull' : ''}</span></div>`;
    }
  });
  h += `<div class="gap-axis"><span>${lo} m</span><span>${Math.round((lo + hi) / 2)} m</span><span>${hi} m</span></div></div>`;
  el.innerHTML = h;
  el.querySelectorAll('.gap-row').forEach((row) => {
    const c = clubs[+row.dataset.i];
    const show = (ev) => { const r = row.getBoundingClientRect();
      showTip(`<b>${esc(c.club)}</b> · ${f0(c.full_shots)} gode fullslag<br>Trygg (P20) <b>${f0(c.carry_p20)}</b> · Forventet <b>${f0(c.carry_p50)}</b> · Lang (P80) <b>${f0(c.carry_p80)}</b> m<br>Total ${f0(c.total_p50)} m · sideavvik ±${f0(c.side_abs_p80)} m · feilslag ${f1(+c.mishit_pct || 0)} %`,
        ev.clientX || r.left + r.width / 2, r.top); };
    row.addEventListener('pointermove', show); row.addEventListener('pointerdown', show); row.addEventListener('pointerleave', hideTip);
  });
}

// ------------------------------------------------------------------ dispersion "range view": every club as an ellipse on a fairway
export function dispersionField(el, clubs, { height = 460 } = {}) {
  const W = el.clientWidth || 340, H = height;
  const maxC = Math.ceil(Math.max(...clubs.map((c) => +c.carry_p80)) / 25) * 25 + 10;
  const side = Math.max(35, Math.ceil(Math.max(...clubs.map((c) => Math.abs(+c.side_mean || 0) + (+c.side_abs_p80 || 0))) / 5) * 5);
  const padT = 14, padB = 26, cx = W / 2;
  const sy = (H - padT - padB) / maxC, sx = (W / 2 - 34) / side;
  const Y = (d) => H - padB - d * sy, X = (s) => cx + s * sx;
  let g = `<rect x="${X(-side * 0.45)}" y="${padT}" width="${X(side * 0.45) - X(-side * 0.45)}" height="${H - padT - padB}" rx="18" class="fw"/>`;
  for (let d = 50; d <= maxC; d += 50) g += `<line x1="8" x2="${W - 8}" y1="${Y(d)}" y2="${Y(d)}" class="grid"/><text x="10" y="${Y(d) - 4}" class="axis">${d} m</text>`;
  g += `<line x1="${cx}" x2="${cx}" y1="${padT}" y2="${H - padB}" class="aim"/>`;
  g += `<text x="${cx}" y="${H - 8}" class="axis" text-anchor="middle">Sikt ↑</text>`;
  // draw long clubs first so short clubs sit on top
  const order = [...clubs].sort((a, b) => b.carry_p50 - a.carry_p50);
  order.forEach((c) => {
    const i = clubs.indexOf(c);
    const rx = Math.max(4, (+c.side_abs_p80 || 8) * sx), ry = Math.max(4, ((+c.carry_p80 - +c.carry_p20) / 2) * sy);
    const ex = X(+c.side_mean || 0), ey = Y((+c.carry_p20 + +c.carry_p80) / 2);
    g += `<g class="ell" data-i="${i}"><ellipse cx="${ex}" cy="${ey}" rx="${rx}" ry="${ry}" style="fill:${catVar(c.category)};stroke:${catVar(c.category)}"/>
      <circle cx="${X(+c.side_mean || 0)}" cy="${Y(+c.carry_p50)}" r="3" class="ell-mid"/></g>`;
  });
  // labels on the right, one per club, placed at its P50 and nudged apart
  let lastY = Infinity; const labels = [];
  [...clubs].sort((a, b) => a.carry_p50 - b.carry_p50).forEach((c) => {
    let ly = Y(+c.carry_p50) + 4; if (lastY - ly < 13) ly = lastY - 13; lastY = ly;
    labels.push(`<text x="${W - 8}" y="${ly}" class="ell-lab" text-anchor="end">${esc(c.club.replace('Pitching Wedge', 'PW'))} ${f0(c.carry_p50)}</text>`);
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Spredning per kølle sett ovenfra">${g}${labels.join('')}</svg>`;
  el.querySelectorAll('.ell').forEach((n) => {
    const c = clubs[+n.dataset.i];
    const show = (ev) => showTip(`<b>${esc(c.club)}</b><br>Carry ${f0(c.carry_p20)}–${f0(c.carry_p80)} m (80 % av slagene)<br>Sideavvik ±${f0(c.side_abs_p80)} m · ${c.left_pct ?? '–'} % til venstre`, ev.clientX, ev.clientY);
    n.addEventListener('pointermove', show); n.addEventListener('pointerdown', show); n.addEventListener('pointerleave', hideTip);
  });
}

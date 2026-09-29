// Course recommendations: content-based, explainable.
// Each course becomes a feature vector (style, setting, difficulty, length, region).
// Your stars pull similar courses up (4–5 ★) or down (1–2 ★). Courses you played but did not rate count as a weak "liked".

const KEYWORDS = {
  links: /\blinks?\b/i,
  parkland: /\bparkland\b/i,
  heath: /\bheath(land)?\b/i,
  desert: /\bdesert\b/i,
  mountain: /\b(mountain|alpine|alps|valley|hills?)\b/i,
  coast: /\b(ocean|sea|seaside|coast(al)?|cliffs?|bay|beach)\b/i,
  water: /\b(lakes?|river|lagoon|water)\b/i,
  forest: /\b(forest|woods?|wooded|pines?|trees?)\b/i,
  dunes: /\bdunes?\b/i,
  island: /\bisland\b/i,
  resort: /\bresort\b/i,
  championship: /\b(championship|tournament|major|open|ryder|pga|tour)\b/i,
};
const TAGS = ['Links', 'Parkland', 'TourVenue', 'Major', 'TopGlobal', 'Featured', 'MostPopular'];
const NORDIC = /(norway|norge|sweden|sverige|denmark|danmark|finland|iceland)/i;
const UKI = /(scotland|england|wales|ireland|united kingdom|\buk\b)/i;
const USA = /(usa|united states|, [A-Z]{2}$|california|florida|texas|new york|oregon|georgia|carolina|arizona|nevada|hawaii|michigan|wisconsin|colorado|pennsylvania|ohio|illinois|minnesota|massachusetts|indiana)/i;
const ASIA = /(japan|china|korea|thailand|vietnam|malaysia|indonesia|singapore|hong kong|india|uae|dubai|abu dhabi|saudi|qatar)/i;
const OCEANIA = /(australia|new zealand|tasmania)/i;

const LABEL = { links: 'links', parkland: 'parkland', heath: 'lynghei', desert: 'ørken', mountain: 'fjell/kupert', coast: 'kyst',
  water: 'mye vann', forest: 'skog', dunes: 'sanddyner', island: 'øy', resort: 'resort', championship: 'turneringsbane',
  nordic: 'Norden', uki: 'Storbritannia/Irland', usa: 'USA', asia: 'Asia/Midtøsten', oceania: 'Australia/NZ', europe: 'Europa' };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function courseFeatures(c) {
  const text = `${c.name || ''} ${c.description || ''}`;
  const f = {};
  for (const [k, re] of Object.entries(KEYWORDS)) f[k] = re.test(text) ? 1 : 0;
  const tags = c.tags || [];
  if (tags.includes('Links')) f.links = 1;
  if (tags.includes('Parkland')) f.parkland = 1;
  if (tags.includes('TourVenue') || tags.includes('Major')) f.championship = 1;
  const loc = c.location || '';
  const region = NORDIC.test(loc) ? 'nordic' : UKI.test(loc) ? 'uki' : ASIA.test(loc) ? 'asia' : OCEANIA.test(loc) ? 'oceania'
    : USA.test(loc) ? 'usa' : loc ? 'europe' : null;
  for (const r of ['nordic', 'uki', 'usa', 'asia', 'oceania', 'europe']) f[r] = region === r ? 0.7 : 0;
  f.difficulty = c.difficulty ? clamp((c.difficulty - 3) / 2, -1, 1) : 0;
  f.length = c.length_m ? clamp((c.length_m - 5800) / 700, -1.5, 1.5) * 0.7 : 0;
  f.slope = c.slope ? clamp((c.slope - 130) / 15, -1.5, 1.5) * 0.7 : 0;
  f._region = region;
  return f;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) {
    if (k[0] === '_') continue;
    dot += a[k] * (b[k] || 0); na += a[k] * a[k]; nb += (b[k] || 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const key = (s) => String(s || '').replace(/[‎‏]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// catalog: tm_courses rows. played: course_overview rows for kind = simulator.
export function recommend(catalog, played, { limit = 15 } = {}) {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const byKey = new Map(catalog.map((c) => [c.name_key || key(c.name), c]));
  const feats = new Map(catalog.map((c) => [c.id, courseFeatures(c)]));

  // anchors = played courses found in the catalog, with a weight from the stars
  const anchors = [];
  const playedIds = new Set();
  const playedInfo = new Map();
  for (const p of played) {
    const c = (p.tm_course_id && byId.get(p.tm_course_id)) || byKey.get(key(p.course_name));
    if (!c) continue;
    playedIds.add(c.id);
    playedInfo.set(c.id, { rounds: p.rounds, last: p.last_played, stars: p.stars });
    const w = p.stars ? p.stars - 3 : 0.3 * Math.log1p(p.rounds);
    if (w) anchors.push({ c, f: feats.get(c.id), w, stars: p.stars, name: c.name });
  }
  const norm = anchors.reduce((s, a) => s + Math.abs(a.w), 0) + 1;

  // taste profile for explanations: weighted average of features of liked courses
  const taste = {};
  for (const a of anchors) if (a.w > 0) for (const k in a.f) if (k[0] !== '_' && a.f[k] > 0) taste[k] = (taste[k] || 0) + a.w * a.f[k];

  // played courses stay in the list (marked), unless you gave them 1–2 stars
  const candidates = catalog.filter((c) => !(playedInfo.get(c.id)?.stars <= 2) && !c.fictional && (c.holes || 18) >= 18
    && !(c.tags || []).includes('Par3Course') && !(c.tags || []).includes('test'));

  const scored = candidates.map((c) => {
    const f = feats.get(c.id);
    let s = 0, best = null;
    for (const a of anchors) {
      if (a.c.id === c.id) continue; // a course is not evidence for itself
      const sim = cosine(f, a.f);
      s += a.w * sim;
      if (a.w > 0 && (!best || a.w * sim > best.v)) best = { v: a.w * sim, a, sim };
    }
    s /= norm;
    const pl = playedInfo.get(c.id) || null;
    const recentDays = pl ? (Date.now() - new Date(pl.last)) / 864e5 : Infinity;
    if (recentDays < 60) s -= 0.15; // just played: give other courses a chance
    else if (pl && pl.stars >= 4) s += 0.05;
    const tags = c.tags || [];
    s += 0.04 * (tags.includes('TopGlobal') + tags.includes('MostPopular') + tags.includes('Featured'));
    const traits = Object.keys(f).filter((k) => k[0] !== '_' && f[k] > 0 && LABEL[k] && (taste[k] || 0) > 0)
      .sort((x, y) => taste[y] - taste[x]).slice(0, 3).map((k) => LABEL[k]);
    let reason = '';
    if (best && best.sim > 0.5) reason = `Ligner på ${best.a.name}${best.a.stars ? ` (${best.a.stars} ★)` : ''}`;
    if (traits.length) reason += (reason ? ' · ' : '') + traits.join(', ');
    return { ...c, score: s, reason, playedInfo: pl };
  }).sort((a, b) => b.score - a.score);

  // diversify: at most 2 per region in the top list unless nothing else is left
  const picks = []; const perRegion = {};
  for (const c of scored) {
    const r = feats.get(c.id)._region || 'x';
    if ((perRegion[r] || 0) >= 3 && scored.length - picks.length > limit) continue;
    perRegion[r] = (perRegion[r] || 0) + 1; picks.push(c);
    if (picks.length >= limit) break;
  }

  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const replay = played.filter((p) => p.stars >= 4 && p.last_played < cutoff)
    .sort((a, b) => b.stars - a.stars || a.last_played.localeCompare(b.last_played)).slice(0, 5)
    .map((p) => ({ name: String(p.course_name).replace(/[‎‏]/g, '').trim(), stars: p.stars,
      reason: `Sist spilt ${new Date(p.last_played).toLocaleDateString('nb-NO', { month: 'short', year: 'numeric' })}${p.best_to_par !== null ? ` · beste ${p.best_to_par > 0 ? '+' : ''}${p.best_to_par}` : ''}` }));

  return { picks, replay };
}

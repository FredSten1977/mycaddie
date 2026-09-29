// TrackPull / TrackMan CSV → import payload for public.import_trackman(jsonb)
// Pure functions: runs in the browser and in Node (tests).
(function (root) {
  const PARSER_VERSION = 'csv-v1';
  const MPH = 0.44704;

  // header (normalized) → [field, factor]
  const COLS = {
    'club': ['club'], 'shot#': ['shot_no'], 'shotnumber': ['shot_no'], 'type': ['type'],
    'clubspeedmph': ['club_speed_ms', MPH], 'ballspeedmph': ['ball_speed_ms', MPH],
    'clubspeedms': ['club_speed_ms'], 'ballspeedms': ['ball_speed_ms'],
    'smashfactor': ['smash_factor'], 'attackangle': ['attack_angle'], 'clubpath': ['club_path'],
    'faceangle': ['face_angle'], 'facetopath': ['face_to_path'], 'swingdirection': ['swing_direction'],
    'dynamicloft': ['dynamic_loft'], 'spinloft': ['spin_loft'], 'launchangle': ['launch_angle'],
    'launchdirection': ['launch_direction'], 'spinrate': ['spin_rate'], 'spinraterpm': ['spin_rate'],
    'spinaxis': ['spin_axis'], 'carrym': ['carry_m'], 'totalm': ['total_m'],
    'carrysidem': ['carry_side_m'], 'totalsidem': ['total_side_m'], 'curvem': ['curve_m'],
    'carryactual': ['carry_actual_m'], 'carrysideactual': ['carry_side_actual_m'],
    'maxheightm': ['max_height_m'], 'landingangle': ['landing_angle'], 'hangtimes': ['hang_time_s'],
    'lowpointcm': ['low_point_cm'], 'impactheightmm': ['impact_height_mm'], 'impactoffsetmm': ['impact_offset_mm'],
    'date': ['date'], 'sessiondate': ['date'], 'reportid': ['report_id'], 'activitytype': ['activity_type'],
    'tag': ['tag'],
  };
  const norm = (h) => String(h || '').toLowerCase().replace(/\(°\)|°/g, '').replace(/[^a-z0-9#]/g, '');

  const ACTIVITY = {
    coursePlayactivity: 'course_play', courseplayactivity: 'course_play', coursesessionactivity: 'course_play',
    mapmybagsessionactivity: 'map_my_bag', mapmybagactivity: 'map_my_bag', bagmappingactivity: 'map_my_bag',
    sessionactivity: 'practice', shotanalysissessionactivity: 'practice', virtualrangesessionactivity: 'practice',
    rangepracticeactivity: 'practice',
    rangefindmydistanceactivity: 'test_game', combinetestactivity: 'test_game',
  };

  function parseCsvText(text) {
    // RFC-4180-ish parser, handles quotes and CRLF
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function num(v, f) {
    if (v === undefined || v === null) return null;
    const t = String(v).trim().replace(',', '.');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? (f ? Math.round(n * f * 1000) / 1000 : n) : null;
  }

  function toIso(d) {
    const t = String(d || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + 'T00:00:00Z';
    const x = new Date(t);
    return isNaN(x) ? null : x.toISOString();
  }

  async function sha1(text) {
    if (root.crypto && root.crypto.subtle) {
      const b = await root.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    return require('crypto').createHash('sha1').update(text).digest('hex');
  }

  // Returns {payloads: [payload...], summary}
  async function parseFile(name, text, opts = {}) {
    const chunk = opts.chunkSize || 1500;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = parseCsvText(text);
    const meta = {};
    let hi = -1;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const first = norm(rows[i][0]);
      if (first === 'date' || first === 'sessiondate') { hi = i; break; }
      const m = String(rows[i][0] || '').match(/^\s*([^:]+):\s*(.+)$/);
      if (m) meta[m[1].trim()] = m[2].trim();
    }
    if (hi < 0) throw new Error(`${name}: fant ingen header-rad (Date / Session Date)`);
    const header = rows[hi];
    const map = header.map((h) => COLS[norm(h)] || null);
    const unknownHeaders = header.filter((h, i) => h && !map[i]);
    const surface = meta['Hitting Surface'] ? meta['Hitting Surface'].toLowerCase() : null;

    const sessions = new Map();
    const shots = [];
    let skippedAvg = 0;
    for (let r = hi + 1; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || cells.every((c) => String(c).trim() === '')) continue;
      const rec = {}; const raw = {};
      header.forEach((h, i) => {
        if (h) raw[h] = cells[i] ?? '';
        const m = map[i]; if (!m) return;
        const [f, factor] = m;
        rec[f] = ['club', 'type', 'date', 'report_id', 'activity_type', 'tag'].includes(f) ? String(cells[i] ?? '').trim() : num(cells[i], factor);
      });
      if (String(rec.type).toLowerCase() === 'average' || String(cells[map.findIndex((m) => m && m[0] === 'shot_no')]).toLowerCase() === 'average') { skippedAvg++; continue; }
      if (!rec.club) continue;
      const started = toIso(rec.date);
      if (!started) continue;
      const act = rec.activity_type ? (ACTIVITY[rec.activity_type.toLowerCase()] || 'other') : 'practice';
      const key = (rec.report_id || 'file') + '|' + started;
      if (!sessions.has(key)) {
        sessions.set(key, {
          key, activity: act, trackman_kind: rec.activity_type || null, surface,
          started_at: started, external_id: rec.report_id || null, course_name: null,
        });
      }
      shots.push({
        session: key, club: rec.club, shot_no: rec.shot_no, shot_time: null,
        club_speed_ms: rec.club_speed_ms ?? null, ball_speed_ms: rec.ball_speed_ms ?? null,
        smash_factor: rec.smash_factor ?? null, attack_angle: rec.attack_angle ?? null,
        club_path: rec.club_path ?? null, face_angle: rec.face_angle ?? null,
        face_to_path: rec.face_to_path ?? null, swing_direction: rec.swing_direction ?? null,
        dynamic_loft: rec.dynamic_loft ?? null, spin_loft: rec.spin_loft ?? null,
        launch_angle: rec.launch_angle ?? null, launch_direction: rec.launch_direction ?? null,
        spin_rate: rec.spin_rate ?? null, spin_axis: rec.spin_axis ?? null,
        carry_m: rec.carry_m ?? null, total_m: rec.total_m ?? null,
        carry_side_m: rec.carry_side_m ?? null, total_side_m: rec.total_side_m ?? null,
        carry_actual_m: rec.carry_actual_m ?? null, carry_side_actual_m: rec.carry_side_actual_m ?? null,
        curve_m: rec.curve_m ?? null, max_height_m: rec.max_height_m ?? null,
        landing_angle: rec.landing_angle ?? null, hang_time_s: rec.hang_time_s ?? null,
        low_point_cm: rec.low_point_cm ?? null, impact_height_mm: rec.impact_height_mm ?? null,
        impact_offset_mm: rec.impact_offset_mm ?? null, raw,
      });
    }

    const fileHash = await sha1(text);
    const sessArr = [...sessions.values()];
    // chunk by shots, keeping each chunk's referenced sessions
    const payloads = [];
    for (let i = 0; i < Math.max(shots.length, 1); i += chunk) {
      const part = shots.slice(i, i + chunk);
      const keys = new Set(part.map((s) => s.session));
      payloads.push({
        channel: 'csv_upload',
        source: { type: 'csv_upload', external_id: 'sha1:' + fileHash, name,
                  parser_version: PARSER_VERSION, meta: { ...meta, unknown_headers: unknownHeaders } },
        sessions: sessArr.filter((s) => keys.has(s.key)),
        shots: part,
      });
    }
    const byAct = {};
    sessArr.forEach((s) => { byAct[s.activity] = (byAct[s.activity] || 0) + 1; });
    return {
      payloads,
      summary: { name, shots: shots.length, sessions: sessArr.length, byActivity: byAct,
                 skippedAverages: skippedAvg, surface, unknownHeaders,
                 first: sessArr.map((s) => s.started_at).sort()[0] || null,
                 last: sessArr.map((s) => s.started_at).sort().slice(-1)[0] || null },
    };
  }

  const api = { parseFile, parseCsvText, PARSER_VERSION };
  if (typeof module !== 'undefined') module.exports = api; else root.MyCaddieParse = api;
})(typeof window !== 'undefined' ? window : globalThis);

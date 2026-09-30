// My Caddie Sync – TrackMan GraphQL activity → public.sync_import(jsonb) payload.
// Pure functions: loaded by the extension service worker and by Node tests.
(function (root) {
  const PARSER_VERSION = 'tm-api-v2';

  const KIND_TO_ACTIVITY = {
    SESSION: 'practice', SHOT_ANALYSIS: 'practice', VIRTUAL_RANGE: 'practice', RANGE_PRACTICE: 'practice',
    VIRTUAL_GOLF_PRACTICE: 'practice', SIMULATOR: 'practice',
    COURSE_PLAY: 'course_play', VIRTUAL_GOLF_PLAY: 'course_play',
    MAP_MY_BAG: 'map_my_bag',
    RANGE_FIND_MY_DISTANCE: 'test_game', COMBINE_TEST: 'test_game', TARGET_PRACTICE: 'test_game',
  };
  // Activity kinds we know how to fetch shots for
  const SUPPORTED_KINDS = ['SESSION', 'SHOT_ANALYSIS', 'VIRTUAL_RANGE', 'MAP_MY_BAG', 'COURSE_PLAY', 'COMBINE_TEST'];

  const MEAS_FIELDS = 'clubSpeed ballSpeed smashFactor attackAngle clubPath faceAngle faceToPath swingDirection ' +
    'dynamicLoft spinLoft launchAngle launchDirection spinRate spinAxis carry total carrySide totalSide ' +
    'carryActual carrySideActual curve maxHeight landingAngle hangTime impactOffset impactHeight lowPointDistance';

  const Q_LIST = `query MyCaddieActivities($skip: Int!, $take: Int!) {
  me { activities(skip: $skip, take: $take) { totalCount pageInfo { hasNextPage } items { id time kind __typename } } } }`;

  const STROKE_TYPES = ['SessionActivity', 'ShotAnalysisSessionActivity', 'VirtualRangeSessionActivity',
    'MapMyBagSessionActivity', 'CombineTestActivity'];
  const Q_STROKES = `query MyCaddieStrokes($id: ID!) { node(id: $id) { __typename
${STROKE_TYPES.map((t) => `  ... on ${t} { id time kind strokes { time club targetDistance measurement { ${MEAS_FIELDS} } } }`).join('\n')}
} }`;

  const Q_COURSE = `query MyCaddieCourse($id: ID!) { node(id: $id) { __typename
  ... on CoursePlayActivity { id time kind gameType grossScore netScore stablefordPoints toPar matchScore numberOfHolesToPlay
    gameSettings { gameScore handicapped }
    course { displayName }
    scorecard { par grossScore netScore stablefordPoints numberOfHolesPlayed isCompleted teeName greenStimp windMode
      fairwayFirmness greenFirmness startedAt finishedAt courseHcp totalHcpStrokes
      player { name hcp courseHcp tee isGuest }
      participants { name hcp courseHcp tee isGuest }
      stat { driveAverage driveMax fairwayHitFairway fairwayHitLeft fairwayHitRight greenInRegulation scrambles numberOfPutts }
      holes { holeNumber isPlayed par distance strokeIndex grossScore putts greenInRegulation stablefordPoint hcpStrokes matchScore
        shots { shotNumber club launchLie finalLie launchTime total shotResult shotsToAdd
          measurement(shotMeasurementKind: MEASUREMENT) { ${MEAS_FIELDS} distanceFromPin targetDistance } } } } } } }`;

  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const mul = (v, f) => (n(v) === null ? null : Math.round(v * f * 1000) / 1000);

  // Angles: portal data is in degrees. Guard against a radians payload: if every launch
  // angle in a full-swing activity is tiny (< 1.6) while carries are long, convert.
  function looksLikeRadians(measurements) {
    const withCarry = measurements.filter((m) => m && n(m.carry) !== null && m.carry > 60 && n(m.launchAngle) !== null);
    return withCarry.length >= 5 && withCarry.every((m) => Math.abs(m.launchAngle) < 1.6);
  }
  const ANGLE_KEYS = ['attackAngle', 'clubPath', 'faceAngle', 'faceToPath', 'swingDirection', 'dynamicLoft', 'spinLoft',
    'launchAngle', 'launchDirection', 'spinAxis', 'landingAngle'];

  function shotFromMeasurement(m, rad) {
    m = m || {};
    const a = (k) => (rad && ANGLE_KEYS.includes(k) ? mul(m[k], 180 / Math.PI) : n(m[k]));
    return {
      club_speed_ms: n(m.clubSpeed), ball_speed_ms: n(m.ballSpeed), smash_factor: n(m.smashFactor),
      attack_angle: a('attackAngle'), club_path: a('clubPath'), face_angle: a('faceAngle'), face_to_path: a('faceToPath'),
      swing_direction: a('swingDirection'), dynamic_loft: a('dynamicLoft'), spin_loft: a('spinLoft'),
      launch_angle: a('launchAngle'), launch_direction: a('launchDirection'), spin_rate: n(m.spinRate), spin_axis: a('spinAxis'),
      carry_m: n(m.carry), total_m: n(m.total), carry_side_m: n(m.carrySide), total_side_m: n(m.totalSide),
      carry_actual_m: n(m.carryActual), carry_side_actual_m: n(m.carrySideActual), curve_m: n(m.curve),
      max_height_m: n(m.maxHeight), landing_angle: a('landingAngle'), hang_time_s: n(m.hangTime),
      low_point_cm: mul(m.lowPointDistance, 100), impact_height_mm: mul(m.impactHeight, 1000), impact_offset_mm: mul(m.impactOffset, 1000),
    };
  }

  function baseSource(act) {
    return { type: 'trackman_api', external_id: act.id, name: `${act.kind || act.__typename} ${act.time}`,
             parser_version: PARSER_VERSION, meta: { typename: act.__typename, kind: act.kind } };
  }

  // Practice / Map My Bag / tests: node with strokes[]
  function strokesActivityToPayload(summary, node) {
    const strokes = (node && node.strokes) || [];
    const rad = looksLikeRadians(strokes.map((s) => s.measurement));
    const key = 'a';
    const perClub = {};
    const shots = strokes
      .slice()
      .sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')))
      .map((s) => {
        const club = s.club || null;
        perClub[club] = (perClub[club] || 0) + 1;
        return { session: key, club, shot_no: perClub[club], shot_time: s.time || null,
                 ...shotFromMeasurement(s.measurement, rad),
                 raw: { club: s.club, time: s.time, targetDistance: s.targetDistance ?? null, measurement: s.measurement || null } };
      })
      .filter((s) => s.club);
    return {
      source: { ...baseSource(summary), meta: { ...baseSource(summary).meta, radians_converted: rad } },
      sessions: [{ key, activity: KIND_TO_ACTIVITY[summary.kind] || 'other', trackman_kind: summary.kind,
                   surface: null, started_at: summary.time, external_id: summary.id, course_name: null }],
      shots,
    };
  }

  // Course play: scorecard → round + holes + shots with lies and pin distances
  function coursePlayToPayload(summary, node) {
    const sc = (node && node.scorecard) || {};
    const holes = (sc.holes || []).filter((h) => h && h.isPlayed !== false);
    const allMeas = holes.flatMap((h) => (h.shots || []).map((s) => s.measurement));
    const rad = looksLikeRadians(allMeas);
    const key = 'a';
    const course = node && node.course && node.course.displayName;
    const shots = [];
    const roundHoles = holes.map((h) => {
      const hs = (h.shots || []).slice().sort((a, b) => (a.shotNumber || 0) - (b.shotNumber || 0));
      let before = n(h.distance);
      const first = hs[0];
      const fairway = h.par >= 4 && first && first.finalLie ? /fairway/i.test(first.finalLie) : null;
      hs.forEach((s) => {
        const after = s.measurement ? n(s.measurement.distanceFromPin) : null;
        shots.push({
          session: key, club: s.club || null, shot_no: (h.holeNumber || 0) * 100 + (s.shotNumber || 0),
          shot_time: s.launchTime || null, hole_no: h.holeNumber,
          launch_lie: s.launchLie || null, final_lie: s.finalLie || null,
          dist_to_pin_before_m: before, dist_to_pin_after_m: after, shot_result: s.shotResult || null,
          ...shotFromMeasurement(s.measurement, rad),
          raw: { shotNumber: s.shotNumber, club: s.club, launchLie: s.launchLie, finalLie: s.finalLie, total: s.total,
                 shotResult: s.shotResult, shotsToAdd: s.shotsToAdd, measurement: s.measurement || null },
        });
        before = after;
      });
      return { hole_no: h.holeNumber, par: h.par ?? null, length_m: n(h.distance), stroke_index: h.strokeIndex ?? null,
               strokes: h.grossScore ?? null, putts: h.putts ?? null, fairway_hit: fairway,
               gir: typeof h.greenInRegulation === 'boolean' ? h.greenInRegulation : null, stableford: h.stablefordPoint ?? null,
               hcp_strokes: h.hcpStrokes ?? null, match_score: h.matchScore ?? null };
    });
    const st = sc.stat || {};
    const firPossible = [st.fairwayHitFairway, st.fairwayHitLeft, st.fairwayHitRight].every((v) => typeof v === 'number')
      ? st.fairwayHitFairway + st.fairwayHitLeft + st.fairwayHitRight : null;
    const played = sc.numberOfHolesPlayed || roundHoles.length || null;
    const gir = typeof st.greenInRegulation === 'number' ? st.greenInRegulation : null;
    const playedOn = (sc.startedAt || summary.time || '').slice(0, 10);
    const round = played ? {
      session: key, content_key: `simulator|trackman|${summary.id}`, played_on: playedOn, course_name: course || null,
      tee_name: sc.teeName || null, holes_played: played, par: sc.par ?? null,
      strokes: sc.grossScore ?? node.grossScore ?? null, stableford_points: sc.stablefordPoints ?? node.stablefordPoints ?? null,
      fir_hit: typeof st.fairwayHitFairway === 'number' ? st.fairwayHitFairway : null, fir_possible: firPossible,
      gir_hit: gir, gir_possible: gir === null ? null : played,
      scrambling_made: typeof st.scrambles === 'number' ? st.scrambles : null,
      scrambling_possible: gir === null ? null : played - gir,
      putts: typeof st.numberOfPutts === 'number' ? st.numberOfPutts : null,
      avg_drive_m: n(st.driveAverage), longest_drive_m: n(st.driveMax),
      conditions: { greenStimp: sc.greenStimp ?? null, windMode: sc.windMode ?? null, fairwayFirmness: sc.fairwayFirmness ?? null,
                    greenFirmness: sc.greenFirmness ?? null, gameType: node.gameType ?? null, isCompleted: sc.isCompleted ?? null,
                    // handicap as registered on the TrackMan scorecard (used for matchplay)
                    tm_meta_v: 2,
                    tm_hcp: n(sc.player && sc.player.hcp),
                    tm_course_hcp: n(sc.courseHcp) ?? n(sc.player && sc.player.courseHcp),
                    tm_total_hcp_strokes: n(sc.totalHcpStrokes),
                    tm_game_score: (node.gameSettings && node.gameSettings.gameScore) || null,
                    tm_handicapped: node.gameSettings ? node.gameSettings.handicapped ?? null : null,
                    tm_net_score: n(sc.netScore) ?? n(node.netScore),
                    tm_participants: (sc.participants || []).map((x) => ({ name: x.name || null, hcp: n(x.hcp), course_hcp: n(x.courseHcp), tee: x.tee || null, guest: !!x.isGuest })) },
      holes: roundHoles,
    } : null;
    return {
      source: { ...baseSource(summary), meta: { ...baseSource(summary).meta, radians_converted: rad, course } },
      sessions: [{ key, activity: 'course_play', trackman_kind: summary.kind, surface: null,
                   started_at: summary.time, external_id: summary.id, course_name: course || null }],
      round,
      shots: shots.filter((s) => s.club),
    };
  }

  function queryFor(summary) {
    if (summary.kind === 'COURSE_PLAY') return { query: Q_COURSE, variables: { id: summary.id } };
    return { query: Q_STROKES, variables: { id: summary.id } };
  }
  function toPayload(summary, node) {
    return summary.kind === 'COURSE_PLAY' ? coursePlayToPayload(summary, node) : strokesActivityToPayload(summary, node);
  }

  const api = { PARSER_VERSION, SUPPORTED_KINDS, KIND_TO_ACTIVITY, Q_LIST, Q_STROKES, Q_COURSE, queryFor, toPayload,
                strokesActivityToPayload, coursePlayToPayload };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MyCaddieTransform = api;
})(typeof self !== 'undefined' ? self : globalThis);

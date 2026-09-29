// My Caddie – fetch an outdoor course from OpenStreetMap once and cache it in public.course_maps.
// Map data © OpenStreetMap contributors (ODbL). Called by the signed-in owner from the app.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });
const KEEP = ["golf", "ref", "par", "handicap", "name", "natural", "waterway", "landuse", "water"];

function kindOf(t: Record<string, string>): string | null {
  if (t.golf === "hole") return "hole";
  if (["fairway", "green", "tee", "bunker", "rough"].includes(t.golf)) return t.golf;
  if (t.golf === "water_hazard" || t.golf === "lateral_water_hazard" || t.natural === "water" || t.waterway || t.water) return "water";
  if (t.natural === "wood" || t.natural === "scrub" || t.landuse === "forest") return "trees";
  if (t.golf === "out_of_bounds") return "oob";
  return null;
}

async function overpass(q: string): Promise<any> {
  const errors: string[] = [];
  for (const url of MIRRORS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 35000);
    try {
      const r = await fetch(url, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "MyCaddie/1.0 (personal golf app)" },
        body: "data=" + encodeURIComponent(q),
      });
      const t = await r.text();
      if (r.ok && t.trim().startsWith("{")) return JSON.parse(t);
      errors.push(`${new URL(url).host}: ${r.status}`);
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message}`);
    } finally { clearTimeout(timer); }
  }
  throw new Error("Ingen kartserver svarte (" + errors.join(", ") + ")");
}

// ---------------------------------------------------------------- elevation
// Samples terrain height along every hole (centre line every 10 m, and 20/40 m to each side every 20 m).
// Norway: Kartverket's 1 m terrain model. Elsewhere, or if Kartverket fails: Open-Meteo (90 m, coarse).
const inNorway = (lat: number, lon: number) => lat > 57.8 && lat < 71.5 && lon > 4 && lon < 31.5;
function samplePoints(feats: any[]): number[][] {
  const pts: number[][] = [];
  for (const f of feats) {
    if (f.k !== "hole" || f.g.length < 2) continue;
    const lat0 = f.g[0].lat, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
    const xy = f.g.map((p: any) => [(p.lon - f.g[0].lon) * kx, (p.lat - lat0) * ky]);
    let carry = 0;
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
      const L = Math.hypot(bx - ax, by - ay); if (!L) continue;
      if (L < carry) { carry -= L; continue; }
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      for (let s = carry; s <= L; s += 10) {
        const x = ax + ux * s, y = ay + uy * s;
        const offs = Math.round(s / 10) % 2 === 0 ? [0, -20, 20, -40, 40] : [0];
        for (const o of offs) {
          const px = x + uy * o, py = y - ux * o;
          pts.push([lat0 + py / ky, f.g[0].lon + px / kx]);
        }
      }
      carry = 10 - ((L - carry) % 10); if (carry >= 10) carry = 0;
    }
    const last = f.g[f.g.length - 1]; pts.push([last.lat, last.lon]);
  }
  return pts.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);
}
async function withTimeout(url: string, ms: number) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal, headers: { "User-Agent": "MyCaddie/1.0 (personal golf app)" } }); } finally { clearTimeout(t); }
}
async function kartverket(pts: number[][]): Promise<number[]> {
  const out: number[] = new Array(pts.length);
  const batches: number[][] = [];
  for (let i = 0; i < pts.length; i += 50) batches.push([i, Math.min(pts.length, i + 50)]);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const [a, b] = batches[next++];
      const list = pts.slice(a, b).map(([lat, lon]) => [lon, lat]);
      const r = await withTimeout("https://ws.geonorge.no/hoydedata/v1/punkt?koordsys=4258&geojson=false&punkter=" + encodeURIComponent(JSON.stringify(list)), 15000);
      if (!r.ok) throw new Error("kartverket " + r.status);
      const j = await r.json();
      const arr = j.punkter || j.points || [];
      if (arr.length !== b - a) throw new Error("kartverket count");
      arr.forEach((p: any, i: number) => { out[a + i] = typeof p.z === "number" ? p.z : NaN; });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}
async function openMeteo(pts: number[][]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 100) {
    const sl = pts.slice(i, i + 100);
    const r = await withTimeout(`https://api.open-meteo.com/v1/elevation?latitude=${sl.map((p) => p[0]).join(",")}&longitude=${sl.map((p) => p[1]).join(",")}`, 15000);
    if (!r.ok) throw new Error("open-meteo " + r.status);
    const j = await r.json(); out.push(...j.elevation);
  }
  return out;
}
async function elevation(feats: any[], lat: number, lon: number) {
  const pts = samplePoints(feats);
  if (!pts.length) return null;
  if (inNorway(lat, lon)) {
    try {
      const z = await kartverket(pts);
      if (z.filter((v) => Number.isFinite(v)).length > pts.length * 0.8) return { src: "Kartverket (1 m)", pts: pts.map((p, i) => [p[0], p[1], Math.round(z[i] * 10) / 10]).filter((p) => Number.isFinite(p[2])) };
    } catch (e) { console.warn("kartverket failed", (e as Error).message); }
  }
  try {
    const z = await openMeteo(pts);
    return { src: "Open-Meteo (90 m, grov)", pts: pts.map((p, i) => [p[0], p[1], z[i]]).filter((p) => Number.isFinite(p[2])) };
  } catch (e) { console.warn("open-meteo failed", (e as Error).message); return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "not signed in" }, 401);

    const b = await req.json();
    const osmType = b.osm_type === "relation" ? "relation" : b.osm_type === "way" ? "way" : null;
    const osmId = Number(b.osm_id);
    if (!osmType || !Number.isFinite(osmId)) return json({ error: "bad course id" }, 400);
    const id = osmType[0] + osmId;

    if (!b.refresh) {
      const { data: hit } = await admin.from("course_maps").select("*").eq("id", id).maybeSingle();
      if (hit && hit.holes > 0) {
        if (!hit.data?.elev) {
          const elev = await elevation(hit.data.feats, hit.lat || hit.data.feats[0]?.g?.[0]?.lat, hit.lon || hit.data.feats[0]?.g?.[0]?.lon);
          if (elev) { hit.data = { ...hit.data, elev }; await admin.from("course_maps").update({ data: hit.data }).eq("id", id); }
        }
        return json({ ...hit, cached: true });
      }
    }

    // bounding box from the search result, padded ~150 m; fall back to the area of the course itself
    const bb = Array.isArray(b.bbox) && b.bbox.length === 4 ? b.bbox.map(Number) : null;
    const pad = 0.0015;
    const sel = bb
      ? `(${bb[0] - pad},${bb[2] - pad},${bb[1] + pad},${bb[3] + pad})`
      : null;
    const q = sel
      ? `[out:json][timeout:30];(way["golf"]${sel};way["natural"~"^(water|wood|scrub)$"]${sel};way["landuse"="forest"]${sel};way["waterway"]${sel};relation["natural"~"^(water|wood)$"]${sel};relation["landuse"="forest"]${sel};);out geom;`
      : `[out:json][timeout:30];${osmType}(${osmId});map_to_area->.a;(way(area.a)["golf"];way(area.a)["natural"~"^(water|wood|scrub)$"];way(area.a)["landuse"="forest"];way(area.a)["waterway"];);out geom;`;
    const j = await overpass(q);

    const feats: unknown[] = [];
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    for (const el of j.elements || []) {
      const tags = el.tags || {};
      const k = kindOf(tags);
      if (!k) continue;
      const t: Record<string, string> = {};
      for (const key of KEEP) if (tags[key] !== undefined) t[key] = tags[key];
      if (el.type === "way" && el.geometry) feats.push({ k, tags: t, g: el.geometry.map((p: any) => ({ lat: r6(p.lat), lon: r6(p.lon) })) });
      if (el.type === "relation" && el.members) for (const m of el.members) {
        if (m.role !== "inner" && m.geometry) feats.push({ k, tags: t, g: m.geometry.map((p: any) => ({ lat: r6(p.lat), lon: r6(p.lon) })) });
      }
    }
    const holes = feats.filter((f: any) => f.k === "hole").length;
    const clat = Number(b.lat) || (feats[0] as any)?.g?.[0]?.lat, clon = Number(b.lon) || (feats[0] as any)?.g?.[0]?.lon;
    const elev = holes ? await elevation(feats, clat, clon) : null;
    const row = { id, name: b.name ?? null, place: b.place ?? null, lat: Number(b.lat) || null, lon: Number(b.lon) || null,
                  data: { feats, elev }, holes, fetched_at: new Date().toISOString() };
    if (holes > 0) {
      const { error } = await admin.from("course_maps").upsert(row, { onConflict: "id" });
      if (error) throw error;
    }
    return json({ ...row, cached: false });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
});

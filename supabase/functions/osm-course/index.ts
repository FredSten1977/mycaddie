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
      if (hit && hit.holes > 0) return json({ ...hit, cached: true });
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
    const row = { id, name: b.name ?? null, place: b.place ?? null, lat: Number(b.lat) || null, lon: Number(b.lon) || null,
                  data: { feats }, holes, fetched_at: new Date().toISOString() };
    if (holes > 0) {
      const { error } = await admin.from("course_maps").upsert(row, { onConflict: "id" });
      if (error) throw error;
    }
    return json({ ...row, cached: false });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
});

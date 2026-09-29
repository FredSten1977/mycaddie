// My Caddie – sync the public TrackMan course catalog into public.tm_courses.
// The catalog is public (no TrackMan login is used or needed). Called from the app by the signed-in owner.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TM = "https://api.trackmangolf.com/graphql";
const Q = `query($skip:Int,$take:Int){ courses(skip:$skip,take:$take){ totalCount items {
  id displayName courseIdentifier courseLocation difficulty numbersOfHoles tags description
  worldLocation { latitude longitude } image { url }
  tees { name par courseDistance gender slope courseRating kind } } } }`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Tee = { name: string; par: number; courseDistance: number; gender: string; slope: number; courseRating: number; kind: string };

function mainTee(tees: Tee[]): Tee | null {
  const men = (tees || []).filter((t) => t.gender === "MALE");
  const pool = men.length ? men : tees || [];
  // "Long" is a typical men's back-of-club tee; fall back to the second-longest, then the longest
  const byKind = pool.find((t) => t.kind === "Long");
  if (byKind) return byKind;
  const sorted = [...pool].sort((a, b) => (b.courseDistance || 0) - (a.courseDistance || 0));
  return sorted[1] || sorted[0] || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    // Only the signed-in owner may trigger a refresh
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return new Response(JSON.stringify({ error: "not signed in" }), { status: 401, headers: cors });
    const rows: Record<string, unknown>[] = [];
    let skip = 0, total = Infinity;
    while (skip < total) {
      const r = await fetch(TM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: Q, variables: { skip, take: 100 } }),
      });
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
      const seg = j.data.courses;
      total = seg.totalCount;
      for (const c of seg.items) {
        const t = mainTee(c.tees);
        const tags: string[] = (c.tags || []).filter((x: string) => x !== "Marketing" && x !== "Course");
        rows.push({
          id: c.id,
          identifier: c.courseIdentifier,
          name: (c.displayName || "").replace(/[‎‏]/g, "").trim(),
          location: c.courseLocation,
          lat: c.worldLocation?.latitude ?? null,
          lon: c.worldLocation?.longitude ?? null,
          difficulty: c.difficulty,
          holes: c.numbersOfHoles,
          tags,
          description: c.description,
          tees: c.tees || [],
          par: t?.par ?? null,
          length_m: t?.courseDistance ?? null,
          slope: t?.slope ?? null,
          course_rating: t?.courseRating ?? null,
          image_url: Array.isArray(c.image) ? c.image[0]?.url ?? null : c.image?.url ?? null,
          fictional: c.courseLocation === "Fictional Course",
          updated_at: new Date().toISOString(),
        });
      }
      skip += 100;
      if (!seg.items.length) break;
    }
    const { error } = await admin.from("tm_courses").upsert(rows, { onConflict: "id" });
    if (error) throw error;
    return new Response(JSON.stringify({ courses: rows.length }), { headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});

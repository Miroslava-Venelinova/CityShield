// Throwaway spike Worker (PLAN.MD §4 phase 0, risk #1): fetches all five
// CityShield source sites plus Overpass/Nominatim from Cloudflare's edge and
// reports whether each responds with the structure the scrapers expect.
import { runAllChecks } from "./checks.mjs";

export default {
  async fetch(request) {
    const results = await runAllChecks();
    return Response.json(
      {
        ranFrom: "cloudflare-edge",
        colo: request.cf?.colo ?? null,
        checkedAt: new Date().toISOString(),
        allOk: results.every((r) => r.ok),
        results,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};

// /api/azure/* — read-only Azure reference data the frontend renders
// (and Claude can also pull via the parallel custom tool).

import type { FastifyInstance } from "fastify";
import { CURATED_VM_SKUS } from "../lib/vm-skus.js";

export async function azureRoutes(app: FastifyInstance) {
  // Curated VM SKU list. `family` and `free_tier` query params filter
  // the returned set; both optional.
  app.get<{
    Querystring: { family?: string; free_tier?: string };
  }>("/api/azure/vm-skus", async (req) => {
    let skus = CURATED_VM_SKUS;
    if (req.query.family) {
      skus = skus.filter((s) => s.family === req.query.family);
    }
    if (req.query.free_tier === "true") {
      skus = skus.filter((s) => s.free_tier);
    }
    return {
      count: skus.length,
      free_tier_note:
        "Azure's 12-month free tier covers 750 hrs/mo of B1s Linux + 750 hrs/mo of B1s Windows on NEW accounts. There is no perpetual VM free tier.",
      skus,
    };
  });
}

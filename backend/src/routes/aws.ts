// /api/aws/* — read-only AWS reference data the frontend renders
// (and Claude can also pull via the parallel custom tool).

import type { FastifyInstance } from "fastify";
import { CURATED_EC2_TYPES } from "../lib/ec2-types.js";

export async function awsRoutes(app: FastifyInstance) {
  // Curated EC2 instance type list. `family` and `free_tier` query
  // params filter the returned set; both optional. Mirror of the
  // Azure /api/azure/vm-skus endpoint.
  app.get<{
    Querystring: { family?: string; free_tier?: string };
  }>("/api/aws/ec2-types", async (req) => {
    let types = CURATED_EC2_TYPES;
    if (req.query.family) {
      types = types.filter((t) => t.family === req.query.family);
    }
    if (req.query.free_tier === "true") {
      types = types.filter((t) => t.free_tier);
    }
    return {
      count: types.length,
      free_tier_note:
        "AWS's 12-month free tier covers 750 hrs/mo of t3.micro Linux on NEW accounts (or t2.micro in regions where t3 isn't available). Free-tier hours are account-wide, not per-instance — running two micros simultaneously burns it twice as fast. There is no perpetual EC2 free tier.",
      types,
    };
  });
}

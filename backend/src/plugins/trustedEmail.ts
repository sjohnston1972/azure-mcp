// Cloudflare Access asserts the user's identity in a header on every
// request. We trust that header (the tunnel is the only ingress) and
// reject anything whose email doesn't match TRUSTED_USER_EMAIL.
//
// The /health endpoint is exempt so docker healthchecks keep working.

import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

const CF_HEADER = "cf-access-authenticated-user-email";

export async function trustedEmail(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/health")) return;

    // For local dev (no Cloudflare in front), allow requests when
    // NODE_ENV !== production AND the header is missing — this lets
    // `npm run dev` work without faking the header.
    const headerVal = req.headers[CF_HEADER];
    const asserted = Array.isArray(headerVal) ? headerVal[0] : headerVal;

    if (!asserted) {
      if (process.env.NODE_ENV !== "production") return;
      reply.code(401).send({ error: "no Cloudflare Access identity asserted" });
      return;
    }

    if (asserted.toLowerCase() !== config.TRUSTED_USER_EMAIL.toLowerCase()) {
      reply.code(403).send({ error: "asserted identity does not match TRUSTED_USER_EMAIL" });
      return;
    }
  });
}

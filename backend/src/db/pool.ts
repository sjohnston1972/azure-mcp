// Single shared pg connection pool. Used by every route that touches
// Postgres. Raw `pg` driver — no ORM (CLAUDE.md §6).

import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  host: config.POSTGRES_HOST,
  port: Number(config.POSTGRES_PORT),
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] idle pool client error:", err);
});

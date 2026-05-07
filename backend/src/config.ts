// Loads & validates env vars on boot. The backend exits with a clear
// error if anything required is missing — failing loudly is better than
// running half-configured and getting confusing 500s later.

const REQUIRED = [
  "ANTHROPIC_API_KEY",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "TRUSTED_USER_EMAIL",
] as const;

type RequiredEnv = (typeof REQUIRED)[number];

function readEnv(): Record<RequiredEnv, string> & {
  ANTHROPIC_MODEL: string;
  AZURE_MCP_URL: string;
  PORT_BACKEND: number;
  PUBLIC_URL: string;
  GH_TOKEN: string;
  GH_OWNER: string;
  GH_REPO_VISIBILITY: "public" | "private";
} {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k] === "");
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[config] missing required env: ${missing.join(", ")}\n` +
        `         Fill these in .env (see .env.example) and restart.`
    );
    process.exit(1);
  }

  const result: Record<RequiredEnv, string> = {} as Record<RequiredEnv, string>;
  for (const k of REQUIRED) result[k] = process.env[k] as string;

  return {
    ...result,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
    AZURE_MCP_URL: process.env.AZURE_MCP_URL ?? "http://azure-mcp:5008/sse",
    PORT_BACKEND: Number(process.env.PORT_BACKEND ?? "3000"),
    PUBLIC_URL: process.env.PUBLIC_URL ?? "http://localhost:8080",
    // GitHub integration is optional. If GH_TOKEN is unset, the sync
    // endpoints respond with a clear "not configured" error and the
    // frontend hides the sync button.
    GH_TOKEN: process.env.GH_TOKEN ?? "",
    GH_OWNER: process.env.GH_OWNER ?? "",
    GH_REPO_VISIBILITY:
      (process.env.GH_REPO_VISIBILITY ?? "private") === "public"
        ? "public"
        : "private",
  };
}

export const config = readEnv();

// eslint-disable-next-line no-console
console.log("[config] all required env vars present");

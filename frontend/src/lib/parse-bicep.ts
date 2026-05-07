// Parse Claude's <bicep>...</bicep> marker. The Bicep template is
// captured into the build state for the View drawer and for Push.

const RE = /<bicep>\s*([\s\S]*?)\s*<\/bicep>/i;

export function parseBicep(text: string): string | null {
  const m = text.match(RE);
  if (!m || !m[1]) return null;
  return m[1].trim();
}

export function bicepPending(text: string): boolean {
  const open = text.lastIndexOf("<bicep>");
  if (open === -1) return false;
  const close = text.indexOf("</bicep>", open);
  return close === -1;
}

export function stripBicep(text: string): string {
  let out = text.replace(RE, "").trimEnd();
  const open = out.lastIndexOf("<bicep>");
  if (open !== -1) out = out.slice(0, open).trimEnd();
  return out;
}

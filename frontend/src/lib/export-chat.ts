// Export a chat session to a downloadable Markdown file.
//
// Renders the same `display` array the ChatPanel shows on screen,
// preserving order: user messages, assistant text, and inline tool
// calls (with full input + result content). Output is a single .md
// blob the browser downloads via an anchor click.

import type { DisplayMessage, AssistantBlock } from "./types";

type ExportArgs = {
  display: DisplayMessage[];
  projectName?: string | null;
  topologyName?: string | null;
};

/** Produce the Markdown body. Pure function so it's easy to unit-test
 *  and reuse if we ever want to copy-to-clipboard instead. */
export function buildChatMarkdown({
  display,
  projectName,
  topologyName,
}: ExportArgs): string {
  const lines: string[] = [];
  const title =
    projectName && topologyName
      ? `Chat — ${projectName} / ${topologyName}`
      : projectName
        ? `Chat — ${projectName}`
        : `Chat export`;

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`*Exported ${new Date().toISOString()} from azure-mcp.*`);
  lines.push("");

  for (const m of display) {
    if (m.kind === "user") {
      lines.push("---");
      lines.push("");
      lines.push("## You");
      lines.push("");
      // Quote the user's prompt so multi-line prompts read as one block.
      for (const ln of m.text.split("\n")) {
        lines.push(`> ${ln}`);
      }
      lines.push("");
      continue;
    }
    if (m.kind === "system") {
      lines.push("---");
      lines.push("");
      lines.push(`## System (${m.tone ?? "info"})`);
      lines.push("");
      lines.push(m.text);
      lines.push("");
      continue;
    }
    // assistant
    lines.push("---");
    lines.push("");
    lines.push("## Claude");
    lines.push("");
    for (const b of m.blocks) {
      renderBlock(b, lines);
    }
  }

  return lines.join("\n");
}

function renderBlock(b: AssistantBlock, lines: string[]): void {
  if (b.type === "text") {
    if (b.text.trim().length === 0) return;
    lines.push(b.text);
    lines.push("");
    return;
  }
  // tool block
  const status = b.resultPending ? "running" : b.isError ? "error" : "ok";
  lines.push(`### Tool: \`${b.name}\` — ${status}`);
  lines.push("");

  // Input — try to pretty-print as JSON, fall back to raw string.
  lines.push("#### Input");
  lines.push("");
  try {
    const json = JSON.stringify(b.input, null, 2);
    lines.push("```json");
    lines.push(json);
    lines.push("```");
  } catch {
    lines.push("```");
    lines.push(String(b.input));
    lines.push("```");
  }
  lines.push("");

  // Result preview, if we have it (sent over SSE, truncated at ~6 KB
  // by the backend — the truncation marker is preserved).
  if (b.resultPreview) {
    lines.push("#### Result");
    lines.push("");
    lines.push("```");
    lines.push(b.resultPreview);
    lines.push("```");
    lines.push("");
  }
}

/** Trigger a browser download of the given markdown content. */
export function downloadChatMarkdown(args: ExportArgs): void {
  const md = buildChatMarkdown(args);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  // Build a kebab-case filename: chat-<project>-<topology>-<yyyymmddHHMM>.md
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const parts = ["chat"];
  if (args.projectName) parts.push(slug(args.projectName));
  if (args.topologyName) parts.push(slug(args.topologyName));
  parts.push(ts);
  const filename = parts.filter(Boolean).join("-") + ".md";

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Free the object URL on the next tick — Chrome occasionally races
  // the download if you revoke immediately.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

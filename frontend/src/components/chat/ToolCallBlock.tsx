// Inline collapsible card showing one tool_use + its result status.
// Default-collapsed (CLAUDE.md §10 says collapsed by default).

import { useState } from "react";

type Props = {
  name: string;
  input: unknown;
  resultPending: boolean;
  isError: boolean;
};

export function ToolCallBlock({ name, input, resultPending, isError }: Props) {
  const [open, setOpen] = useState(false);

  const status = resultPending
    ? { label: "running", cls: "bg-primary/10 text-primary", dotPulse: true }
    : isError
      ? { label: "error", cls: "bg-error/10 text-error", dotPulse: false }
      : { label: "ok", cls: "bg-secondary/10 text-secondary", dotPulse: false };

  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-container-high transition-colors"
      >
        <span className="material-symbols-outlined text-on-surface-variant text-base">
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
          tool
        </span>
        <code className="font-mono text-xs text-on-surface flex-1 truncate">
          {name}
        </code>
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold ${status.cls}`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full bg-current ${status.dotPulse ? "animate-pulse" : ""}`}
          />
          {status.label}
        </span>
      </button>

      {open && (
        <div className="border-t border-outline-variant/30 px-3 py-2 bg-surface-container-lowest">
          <div className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant mb-1">
            input
          </div>
          <pre className="font-mono text-xs whitespace-pre-wrap break-words text-on-surface">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

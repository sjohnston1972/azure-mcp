// Live "what is the agent doing right now" row.
//
// Sits between the stage bar and the message list. Always present so
// the layout doesn't jump; subtly tinted when idle, animated when the
// agent is working. Derives its state from the latest assistant
// message + the sending flag from useChat.

import { useEffect, useState } from "react";
import type { DisplayMessage } from "../../lib/types";

type Activity =
  | { kind: "idle" }
  | { kind: "thinking"; postTool: boolean }
  | { kind: "writing"; postTool: boolean }
  | { kind: "tool"; name: string };

function deriveActivity(
  display: DisplayMessage[],
  sending: boolean
): Activity {
  if (!sending) return { kind: "idle" };

  // Find the latest assistant message.
  let last: DisplayMessage | null = null;
  for (let i = display.length - 1; i >= 0; i--) {
    const m = display[i];
    if (m && m.kind === "assistant") {
      last = m;
      break;
    }
  }

  if (!last || last.kind !== "assistant" || last.blocks.length === 0) {
    return { kind: "thinking", postTool: false };
  }

  // Has any tool already been called this turn? Used to pick verbs that
  // describe synthesising a response after work vs starting fresh.
  const postTool = last.blocks.some((b) => b.type === "tool");

  // Look at the most recent block.
  const recent = last.blocks[last.blocks.length - 1];
  if (!recent) return { kind: "thinking", postTool };

  if (recent.type === "tool") {
    return recent.resultPending
      ? { kind: "tool", name: recent.name }
      : { kind: "thinking", postTool: true }; // tool returned, claude reasoning about it
  }
  if (recent.type === "text") {
    return { kind: "writing", postTool };
  }
  return { kind: "thinking", postTool };
}

// Verbs cycle every ~3s based on elapsed time so the indicator feels
// alive on long-running turns without flickering on short ones.
const VERB_ROTATE_MS = 3000;

const THINKING_VERBS_FRESH = [
  "Thinking",
  "Pondering",
  "Considering",
  "Working it out",
  "Reasoning through",
];

const THINKING_VERBS_POST_TOOL = [
  "Reasoning",
  "Analysing results",
  "Making sense of that",
  "Connecting the dots",
  "Working out next steps",
];

const WRITING_VERBS_FRESH = [
  "Writing",
  "Drafting",
  "Composing",
  "Putting it down",
];

const WRITING_VERBS_POST_TOOL = [
  "Synthesising",
  "Wrapping it up",
  "Drafting response",
  "Putting it together",
];

function pickVerb(list: string[], elapsedMs: number): string {
  const idx = Math.floor(elapsedMs / VERB_ROTATE_MS) % list.length;
  return list[idx] ?? list[0]!;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

type Props = {
  display: DisplayMessage[];
  sending: boolean;
};

export function ChatActivity({ display, sending }: Props) {
  const activity = deriveActivity(display, sending);
  const isActive = activity.kind !== "idle";

  // Track elapsed time since the current turn started. Reset whenever
  // sending flips to false.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (sending && startedAt === null) {
      setStartedAt(Date.now());
      setNow(Date.now());
    } else if (!sending && startedAt !== null) {
      setStartedAt(null);
    }
  }, [sending, startedAt]);
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsedMs = startedAt !== null ? now - startedAt : 0;

  const label = (() => {
    switch (activity.kind) {
      case "idle":
        return "Ready";
      case "thinking":
        return pickVerb(
          activity.postTool ? THINKING_VERBS_POST_TOOL : THINKING_VERBS_FRESH,
          elapsedMs
        );
      case "writing":
        return pickVerb(
          activity.postTool ? WRITING_VERBS_POST_TOOL : WRITING_VERBS_FRESH,
          elapsedMs
        );
      case "tool":
        return null; // rendered inline with the tool name below
    }
  })();

  return (
    <div
      className={`px-4 h-8 flex items-center gap-2 text-xs border-b border-outline-variant/30 transition-colors ${
        isActive ? "bg-primary/5" : "bg-surface-container-lowest"
      }`}
      role="status"
      aria-live="polite"
    >
      {isActive ? (
        <span className="inline-flex gap-1 items-center" aria-hidden="true">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-typing-dot" />
          <span
            className="w-1.5 h-1.5 rounded-full bg-primary animate-typing-dot"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-primary animate-typing-dot"
            style={{ animationDelay: "300ms" }}
          />
        </span>
      ) : (
        <span
          className="w-1.5 h-1.5 rounded-full bg-secondary"
          aria-hidden="true"
        />
      )}

      <span
        className={`font-semibold ${
          isActive ? "text-primary" : "text-on-surface-variant"
        }`}
      >
        {label}
        {activity.kind === "tool" && (
          <>
            Calling{" "}
            <code className="font-mono px-1 py-0.5 rounded bg-primary/10 text-primary">
              {activity.name}
            </code>
          </>
        )}
      </span>

      {isActive && startedAt !== null && (
        <span className="ml-auto text-on-surface-variant tabular-nums">
          {formatElapsed(now - startedAt)}
        </span>
      )}
    </div>
  );
}

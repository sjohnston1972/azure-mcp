// One row in the chat. Renders a user bubble, an assistant turn (text
// + inline tool calls + answer chips), or a system note.

import type { DisplayMessage } from "../../lib/types";
import { parseAnswers } from "../../lib/parse-answers";
import { stripBicep } from "../../lib/parse-bicep";
import { stripTopology } from "../../lib/parse-topology";
import { ToolCallBlock } from "./ToolCallBlock";

type Props = {
  msg: DisplayMessage;
  /** Show answer chips on this message (true for the most-recent
   *  assistant turn that has a closed <answers> block). */
  chipsActive?: boolean;
  onPickAnswer?: (text: string) => void;
};

export function Message({ msg, chipsActive = false, onPickAnswer }: Props) {
  if (msg.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-sm leading-relaxed">
          {msg.text}
        </div>
      </div>
    );
  }

  if (msg.kind === "system") {
    const tone = msg.tone === "error" ? "text-error" : "text-on-surface-variant";
    return (
      <div className="rounded-lg bg-surface-container-low p-3">
        <div className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant mb-1">
          system
        </div>
        <p className={`text-sm leading-relaxed ${tone}`}>{msg.text}</p>
      </div>
    );
  }

  // ── assistant turn ────────────────────────────────────────────
  // Find the last text block and parse it for an <answers> marker.
  // Chips render only on the last text block of the message, only
  // when streaming has finished, and only when this is the active
  // message (chipsActive — owned by the parent so older turns don't
  // re-show their chips).
  let lastTextIdx = -1;
  for (let i = msg.blocks.length - 1; i >= 0; i--) {
    const b = msg.blocks[i];
    if (b && b.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  const lastTextBlock = lastTextIdx >= 0 ? msg.blocks[lastTextIdx] : null;
  // Strip topology + bicep markers BEFORE parsing answers so the
  // chip parser sees the trimmed tail. Markers render in dedicated
  // panes (canvas + bicep drawer), not inline.
  const parsedLast =
    lastTextBlock && lastTextBlock.type === "text"
      ? parseAnswers(stripBicep(stripTopology(lastTextBlock.text)))
      : null;

  const showChips =
    chipsActive &&
    !msg.streaming &&
    parsedLast?.options &&
    parsedLast.options.length > 0;

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0 rounded-full bg-primary/10 grid place-items-center text-primary text-[11px] font-extrabold">
        a
      </div>
      <div className="flex-1 space-y-2 min-w-0">
        {msg.blocks.length === 0 && msg.streaming && (
          <div className="inline-flex gap-1 items-center">
            <span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant animate-typing-dot" />
            <span
              className="w-1.5 h-1.5 rounded-full bg-on-surface-variant animate-typing-dot"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-on-surface-variant animate-typing-dot"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        )}
        {msg.blocks.map((b, i) => {
          if (b.type === "text") {
            // For the last text block, use the parsed/stripped version
            // so the <answers>...</answers> marker doesn't render as
            // visible text.
            const display =
              i === lastTextIdx && parsedLast
                ? parsedLast.text
                : b.text;
            // Skip empty text blocks (e.g. when only the marker was
            // present and we stripped it all away).
            if (display.length === 0 && !msg.streaming) return null;
            return (
              <p
                key={i}
                className="text-sm leading-relaxed whitespace-pre-wrap break-words"
              >
                {display}
                {msg.streaming && i === msg.blocks.length - 1 && (
                  <span className="inline-block w-1.5 h-3 ml-0.5 bg-primary/60 animate-pulse align-middle" />
                )}
              </p>
            );
          }
          return (
            <ToolCallBlock
              key={b.id}
              name={b.name}
              input={b.input}
              resultPending={b.resultPending}
              isError={b.isError}
              resultPreview={b.resultPreview}
            />
          );
        })}

        {showChips && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {parsedLast!.options!.map((opt, i) => (
              <button
                key={`${i}-${opt}`}
                type="button"
                onClick={() => onPickAnswer?.(opt)}
                className="px-2.5 py-1 rounded-full text-[12px] font-semibold bg-primary/10 text-primary hover:bg-primary/15 hover:brightness-95 transition-colors border border-primary/20"
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

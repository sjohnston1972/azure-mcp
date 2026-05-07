// Multi-line input + send button. Enter sends, Shift+Enter inserts a
// newline. Disabled while a request is in flight.

import { useEffect, useRef, useState } from "react";

type Props = {
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
};

export function Composer({ disabled, sending, onSend, onCancel }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to 8 rows.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 8 * 20; // rough cap; 20px per line
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="border-t border-outline-variant/30 p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled
              ? "select a project first"
              : "Describe what you want to build…"
          }
          disabled={disabled}
          className="flex-1 p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none disabled:opacity-50"
        />
        {sending ? (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 rounded-lg border border-outline-variant/40 text-sm font-semibold hover:bg-surface-container-high transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="px-3 py-2 rounded-lg bg-gradient-to-br from-primary to-primary-container text-on-primary text-sm font-semibold shadow-sm disabled:opacity-50 hover:brightness-110 transition"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// Styled confirm dialog. Replaces window.confirm() across the app.
//
// Usage via the useConfirm() hook (preferred — promise-based):
//   const confirm = useConfirm();
//   if (await confirm({ title: "Delete?", message: "...", tone: "danger" })) {
//     ...do thing
//   }

import { useEffect } from "react";

export type ConfirmTone = "primary" | "danger";

export type ConfirmOptions = {
  title: string;
  /** Plain text or React node. Newlines in plain text are preserved. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** Optional Material Symbols icon name shown in the header pill. */
  icon?: string;
};

type Props = ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  icon,
  onConfirm,
  onCancel,
}: Props) {
  // Esc cancels, Enter confirms — same as the native dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const iconName = icon ?? (tone === "danger" ? "warning" : "help");
  const iconWrapCls =
    tone === "danger"
      ? "bg-error/10 text-error"
      : "bg-primary/10 text-primary";
  const confirmBtnCls =
    tone === "danger"
      ? "bg-error text-on-error hover:brightness-110"
      : "bg-gradient-to-br from-primary to-primary-container text-on-primary hover:brightness-110";

  return (
    <div
      className="fixed inset-0 z-[60] bg-on-surface/40 backdrop-blur-sm grid place-items-center p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        className="w-full max-w-md rounded-xl bg-surface-container-lowest shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 flex items-start gap-4">
          <div
            className={`w-10 h-10 rounded-lg shrink-0 grid place-items-center ${iconWrapCls}`}
          >
            <span className="material-symbols-outlined text-[22px]">
              {iconName}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="confirm-title" className="text-base font-extrabold tracking-tight">
              {title}
            </h2>
            <div className="text-sm text-on-surface-variant mt-1 leading-relaxed whitespace-pre-wrap break-words">
              {message}
            </div>
          </div>
        </div>

        <div className="border-t border-outline-variant/30 px-6 py-3 flex items-center justify-end gap-2 bg-surface-container-low">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-outline-variant/40 text-sm font-semibold hover:bg-surface-container-high transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold shadow-sm transition ${confirmBtnCls}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Simple modal for creating a project.

import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; description?: string }) => Promise<void>;
};

export function NewProjectModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setError(null);
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name)) {
      setError("Name: 1–60 chars, alphanumeric + dash/underscore only.");
      return;
    }
    setBusy(true);
    try {
      await onCreate({
        name,
        description: description.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-sm grid place-items-center p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-md rounded-xl bg-surface-container-lowest shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-outline-variant/30">
          <h2 className="text-base font-extrabold tracking-tight">
            New project
          </h2>
          <p className="text-xs text-on-surface-variant mt-0.5">
            The name becomes the <code className="font-mono">azure-mcp-project</code>{" "}
            tag on every resource you deploy.
          </p>
        </div>

        <div className="px-6 py-5 space-y-3">
          <label className="block">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="vigil-lab"
              className="mt-1 w-full p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
              Description (optional)
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What's this project for?"
              className="mt-1 w-full p-2.5 rounded-lg bg-surface-container-low border border-outline-variant/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </label>

          {error && (
            <div className="rounded-lg bg-error/5 border border-error/30 p-2 text-xs text-error">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-outline-variant/30 px-6 py-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-outline-variant/40 text-sm font-semibold hover:bg-surface-container-high disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim()}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-br from-primary to-primary-container text-on-primary text-sm font-semibold shadow-sm disabled:opacity-50 hover:brightness-110"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

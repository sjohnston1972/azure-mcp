// Topologies tab content for the left rail. Lists every topology in
// the active project with its status chip, inline rename, and
// delete + destroy actions.

import { useEffect, useRef, useState } from "react";
import type { TopologyRecord } from "../../lib/types";

type Props = {
  topologies: TopologyRecord[];
  activeTopologyId: string | null;
  onSelect: (t: TopologyRecord) => void;
  onNewTopology: () => void;
  onRename: (t: TopologyRecord, newName: string) => void;
  onDelete: (t: TopologyRecord) => void;
  onDestroy: (t: TopologyRecord) => void;
};

const STATUS_CHIP: Record<
  TopologyRecord["status"],
  { label: string; cls: string }
> = {
  draft: {
    label: "draft",
    cls: "bg-outline-variant/25 text-on-surface-variant",
  },
  live: {
    label: "live",
    cls: "bg-secondary/15 text-secondary",
  },
  failed: {
    label: "failed",
    cls: "bg-error/15 text-error",
  },
  destroyed: {
    label: "destroyed",
    cls: "bg-outline-variant/25 text-on-surface-variant line-through",
  },
};

export function TopologiesList({
  topologies,
  activeTopologyId,
  onSelect,
  onNewTopology,
  onRename,
  onDelete,
  onDestroy,
}: Props) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onNewTopology}
        className="w-full px-3 py-2 rounded-lg border border-dashed border-outline-variant/50 text-sm font-semibold text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-base">add</span>
        New topology
      </button>

      {topologies.length === 0 ? (
        <p className="text-xs text-on-surface-variant px-1">
          No topologies yet. Ask Claude to design something — a draft
          will appear here automatically.
        </p>
      ) : (
        // flex-col + gap is more robust than `space-y-X` (which relies on
        // adjacent-sibling margins and can collapse in some edge cases).
        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {topologies.map((t) => (
            <TopologyRow
              key={t.id}
              topology={t}
              active={t.id === activeTopologyId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              onDestroy={onDestroy}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TopologyRow({
  topology: t,
  active,
  onSelect,
  onRename,
  onDelete,
  onDestroy,
}: {
  topology: TopologyRecord;
  active: boolean;
  onSelect: (t: TopologyRecord) => void;
  onRename: (t: TopologyRecord, newName: string) => void;
  onDelete: (t: TopologyRecord) => void;
  onDestroy: (t: TopologyRecord) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(t.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const chip = STATUS_CHIP[t.status];
  const nodeCount = t.topology?.nodes.length ?? 0;

  // Reset draft when the underlying topology changes (e.g. successful
  // rename → list refreshes → keep the row in sync).
  useEffect(() => {
    setDraftName(t.name);
  }, [t.name]);

  const startEditing = () => {
    setDraftName(t.name);
    setEditing(true);
    // Focus + select on the next tick so the input is mounted.
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const commit = () => {
    const next = draftName.trim();
    setEditing(false);
    if (!next || next === t.name) return;
    onRename(t, next);
  };

  const cancel = () => {
    setEditing(false);
    setDraftName(t.name);
  };

  return (
    <li
      className={`block rounded-lg border transition-colors overflow-hidden ${
        active
          ? "bg-primary/10 border-primary/30"
          : "bg-surface-container-low border-outline-variant/30 hover:bg-surface-container-high"
      }`}
    >
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") cancel();
              }}
              maxLength={80}
              className="flex-1 min-w-0 text-sm font-semibold px-1 py-0.5 rounded bg-surface-container-lowest border border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          ) : (
            <button
              type="button"
              onClick={() => onSelect(t)}
              onDoubleClick={startEditing}
              title="Click to switch · double-click to rename"
              className="flex-1 min-w-0 text-left"
            >
              <span
                className={`text-sm font-semibold truncate block ${
                  active ? "text-primary" : ""
                }`}
              >
                {t.name}
              </span>
            </button>
          )}
          <span
            className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold ${chip.cls}`}
          >
            {chip.label}
          </span>
        </div>
        <div className="text-[11px] text-on-surface-variant">
          {nodeCount} node{nodeCount === 1 ? "" : "s"}
          {t.pushed_at && t.status === "live" && (
            <> · pushed {new Date(t.pushed_at).toLocaleDateString()}</>
          )}
          {t.status === "failed" && t.updated_at && (
            <> · last attempt {new Date(t.updated_at).toLocaleDateString()}</>
          )}
          {t.destroyed_at && t.status === "destroyed" && (
            <> · torn down {new Date(t.destroyed_at).toLocaleDateString()}</>
          )}
        </div>
      </div>
      <div className="border-t border-outline-variant/20 px-1.5 py-1 flex items-center justify-end gap-0.5">
        <button
          type="button"
          onClick={startEditing}
          title="Rename"
          className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">edit</span>
          Rename
        </button>
        {t.status === "live" && (
          <button
            type="button"
            onClick={() => onDestroy(t)}
            title="Destroy: tear down Azure resources tagged with this topology"
            className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-error hover:bg-error/10 transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[14px]">
              delete_sweep
            </span>
            Destroy
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(t)}
          title={
            t.status === "live"
              ? "Delete the record only (Azure resources stay alive)"
              : "Delete this topology"
          }
          className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high hover:text-error transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">delete</span>
          Delete
        </button>
      </div>
    </li>
  );
}

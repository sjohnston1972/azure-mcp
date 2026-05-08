// Topologies tab content for the left rail. Lists every topology in
// the active project with its status chip, inline rename, and
// delete + destroy actions.

import { useEffect, useRef, useState } from "react";
import type { TopologyRecord } from "../../lib/types";

type Props = {
  topologies: TopologyRecord[];
  activeTopologyId: string | null;
  /** Topology id currently being synced to GitHub. Disables the
   *  Sync button on that row + shows a spinner. */
  syncingTopologyId?: string | null;
  /** Topology id currently being destroyed in Azure. Replaces the
   *  status chip with a "destroying" pulse and hides the Destroy
   *  button so the user can't fire a second teardown. */
  destroyingTopologyId?: string | null;
  /** Whether the GitHub feature is configured at all. When false,
   *  the Sync button is hidden so users don't get a 400 surprise. */
  githubAvailable?: boolean;
  onSelect: (t: TopologyRecord) => void;
  onNewTopology: () => void;
  onRename: (t: TopologyRecord, newName: string) => void;
  onDelete: (t: TopologyRecord) => void;
  onDestroy: (t: TopologyRecord) => void;
  onSyncToGithub?: (t: TopologyRecord) => void;
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
  syncingTopologyId,
  destroyingTopologyId,
  githubAvailable,
  onSelect,
  onNewTopology,
  onRename,
  onDelete,
  onDestroy,
  onSyncToGithub,
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
              syncing={syncingTopologyId === t.id}
              destroying={destroyingTopologyId === t.id}
              githubAvailable={!!githubAvailable}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              onDestroy={onDestroy}
              onSyncToGithub={onSyncToGithub}
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
  syncing,
  destroying,
  githubAvailable,
  onSelect,
  onRename,
  onDelete,
  onDestroy,
  onSyncToGithub,
}: {
  topology: TopologyRecord;
  active: boolean;
  syncing: boolean;
  destroying: boolean;
  githubAvailable: boolean;
  onSelect: (t: TopologyRecord) => void;
  onRename: (t: TopologyRecord, newName: string) => void;
  onDelete: (t: TopologyRecord) => void;
  onDestroy: (t: TopologyRecord) => void;
  onSyncToGithub?: (t: TopologyRecord) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(t.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // While a destroy is in flight, override the status chip with a
  // pulsing "destroying" indicator. Once the chat turn ends (any
  // outcome), App clears destroyingTopologyId and the chip falls
  // back to t.status (destroyed on success, live on failure/incomplete).
  const chip = destroying
    ? {
        label: "destroying",
        cls: "bg-error/15 text-error animate-pulse",
      }
    : STATUS_CHIP[t.status];
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
      {/* The whole top region is the click target for switching to
          this topology — historically only the small name text was
          clickable, which made it easy to miss and gave the
          impression that the rail was "stuck" on the top topology.
          Inner action buttons (Rename / GitHub / Destroy / Delete)
          live in a separate <div> below and stop their own click
          propagation as needed. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (editing) return; // Don't steal focus from the input.
          onSelect(t);
        }}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(t);
          }
        }}
        onDoubleClick={() => {
          if (!editing) startEditing();
        }}
        title="Click to switch · double-click to rename"
        className={`px-2.5 py-2 cursor-pointer ${
          active ? "" : "hover:bg-surface-container-high"
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-0.5">
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commit}
              // Stop click events on the input from bubbling to the
              // parent div's onClick — without this, focusing the
              // input would also fire onSelect.
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                if (e.key === "Escape") cancel();
              }}
              maxLength={80}
              className="flex-1 min-w-0 text-sm font-semibold px-1 py-0.5 rounded bg-surface-container-lowest border border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          ) : (
            <span
              className={`flex-1 min-w-0 text-sm font-semibold truncate block ${
                active ? "text-primary" : ""
              }`}
            >
              {t.name}
            </span>
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
          {t.github_synced_at && t.github_repo && (
            <>
              {" · "}
              <a
                href={`https://github.com/${t.github_repo}`}
                target="_blank"
                rel="noreferrer"
                title={`Synced to ${t.github_repo} at ${new Date(
                  t.github_synced_at
                ).toLocaleString()}`}
                className="underline decoration-dotted hover:text-on-surface"
              >
                {/* Compact date+time, locale-aware (e.g. "8 May 14:32"
                    in en-GB, "May 8, 2:32 PM" in en-US). The hover
                    tooltip carries the full long-form timestamp + repo. */}
                synced{" "}
                {new Date(t.github_synced_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </a>
            </>
          )}
        </div>
      </div>
      {/* 2×2 grid with explicit cell placement:
              row 1 col 1: Rename     row 1 col 2: GitHub
              row 2 col 1: Destroy    row 2 col 2: Delete
          Each cell uses justify-self to hug its outer edge. Cells
          can be empty (Destroy is hidden when status != live, GitHub
          is hidden when the env var isn't configured) and the
          other items keep their fixed position so the layout never
          shuffles between rows depending on state. */}
      <div className="border-t border-outline-variant/20 px-1.5 py-1 grid grid-cols-2 gap-y-0.5">
        <button
          type="button"
          onClick={startEditing}
          title="Rename"
          className="justify-self-start px-2 py-0.5 rounded-md text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">edit</span>
          Rename
        </button>
        {githubAvailable && onSyncToGithub ? (
          <button
            type="button"
            onClick={() => onSyncToGithub(t)}
            disabled={syncing}
            title={
              syncing
                ? "Syncing to GitHub…"
                : t.github_repo
                  ? `Re-sync to ${t.github_repo}`
                  : "Push this topology to a new GitHub repo (Bicep + canvas + screenshot)"
            }
            className="justify-self-end px-2 py-0.5 rounded-md text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${
                syncing ? "animate-spin" : ""
              }`}
            >
              {syncing ? "progress_activity" : "cloud_upload"}
            </span>
            {syncing ? "Syncing…" : "GitHub"}
          </button>
        ) : (
          // Empty placeholder so Delete stays in col 2 row 2 below.
          <span />
        )}
        {t.status === "live" ? (
          <button
            type="button"
            onClick={() => onDestroy(t)}
            disabled={destroying}
            title={
              destroying
                ? "Destroy already in progress…"
                : "Destroy: tear down Azure resources tagged with this topology"
            }
            className="justify-self-start px-2 py-0.5 rounded-md text-[11px] font-semibold text-error hover:bg-error/10 transition-colors flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${
                destroying ? "animate-spin" : ""
              }`}
            >
              {destroying ? "progress_activity" : "delete_sweep"}
            </span>
            {destroying ? "Destroying…" : "Destroy"}
          </button>
        ) : (
          // Empty placeholder keeps Delete pinned to col 2.
          <span />
        )}
        <button
          type="button"
          onClick={() => onDelete(t)}
          title={
            t.status === "live"
              ? "Delete the record only (Azure resources stay alive)"
              : "Delete this topology"
          }
          className="justify-self-end px-2 py-0.5 rounded-md text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high hover:text-error transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">delete</span>
          Delete
        </button>
      </div>
    </li>
  );
}

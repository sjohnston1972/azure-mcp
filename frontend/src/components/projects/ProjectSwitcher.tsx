// Header dropdown for selecting / creating projects.

import { useEffect, useRef, useState } from "react";
import type { GithubStatus, Project } from "../../lib/types";
import { pushProjectToGithub } from "../../lib/api";
import { useConfirm } from "../ui/useConfirm";

type Props = {
  projects: Project[];
  current: Project | null;
  loading: boolean;
  githubStatus: GithubStatus | null;
  onSelect: (p: Project) => void;
  onCreate: () => void;
  onDelete: (p: Project) => void;
  /** Called when a successful push updates a project's github_repo /
   *  github_synced_at — App refreshes its project list. */
  onProjectUpdated: (p: Project) => void;
};

export function ProjectSwitcher({
  projects,
  current,
  loading,
  githubStatus,
  onSelect,
  onCreate,
  onDelete,
  onProjectUpdated,
}: Props) {
  const [open, setOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();

  const ghEnabled = !!githubStatus?.configured;

  const handleSync = async (p: Project) => {
    setSyncError(null);
    setSyncingId(p.id);
    try {
      const result = await pushProjectToGithub(p.id);
      onProjectUpdated(result.project);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingId(null);
    }
  };

  const fmtAgo = (iso: string | null): string => {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg border-2 transition-colors shadow-sm ${
          open
            ? "bg-primary/15 border-primary/40 text-primary"
            : "bg-primary/5 border-primary/30 hover:bg-primary/10 hover:border-primary/40"
        }`}
        title="Switch, create, or delete projects"
      >
        <span className="material-symbols-outlined text-base text-primary">
          folder_managed
        </span>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
          Project
        </span>
        <span className="text-[10px] font-extrabold uppercase tracking-widest">
          {loading ? "loading…" : current ? current.name : "Select"}
        </span>
        <span className="material-symbols-outlined text-base text-on-surface-variant">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        // right-0 anchors the dropdown to the right edge of the trigger
        // because the trigger lives in the top-right of the header — a
        // left-anchored dropdown would render off-screen.
        <div className="absolute top-full right-0 mt-1 w-80 rounded-xl bg-surface-container-lowest border border-outline-variant/40 shadow-lg z-50 overflow-hidden">
          <div className="max-h-80 overflow-y-auto">
            {projects.length === 0 ? (
              <div className="p-4 text-xs text-on-surface-variant">
                No projects yet. Create your first one to start designing.
              </div>
            ) : (
              <ul className="divide-y divide-outline-variant/20">
                {projects.map((p) => {
                  const isActive = current?.id === p.id;
                  return (
                    <li key={p.id} className="group">
                      <div
                        className={`flex items-center gap-1 px-2 py-1.5 ${
                          isActive ? "bg-primary/10" : "hover:bg-surface-container-low"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(p);
                            setOpen(false);
                          }}
                          className="flex-1 text-left min-w-0 px-1 py-0.5"
                        >
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`material-symbols-outlined text-base ${
                                isActive ? "text-primary" : "text-on-surface-variant"
                              }`}
                            >
                              {isActive ? "folder_open" : "folder"}
                            </span>
                            <span
                              className={`text-sm truncate ${
                                isActive ? "font-bold text-primary" : "font-semibold"
                              }`}
                            >
                              {p.name}
                            </span>
                          </div>
                          {p.description && (
                            <div className="text-xs text-on-surface-variant truncate ml-[22px]">
                              {p.description}
                            </div>
                          )}
                          {ghEnabled && (
                            <div className="ml-[22px] mt-0.5 flex items-center gap-1.5 text-[10px]">
                              <span className="material-symbols-outlined text-[12px] text-on-surface-variant">
                                hub
                              </span>
                              {p.github_synced_at && p.github_repo ? (
                                // Clickable link to the actual repo so
                                // the user can jump straight from the
                                // dropdown — same pattern as the
                                // topology row's footer link.
                                <a
                                  href={`https://github.com/${p.github_repo}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-secondary font-semibold underline decoration-dotted hover:text-on-surface"
                                >
                                  {p.github_repo} · synced{" "}
                                  {fmtAgo(p.github_synced_at)}
                                </a>
                              ) : (
                                <span className="text-on-surface-variant">
                                  GitHub · never synced
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                        {ghEnabled && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleSync(p);
                            }}
                            disabled={syncingId === p.id}
                            title={
                              syncingId === p.id
                                ? "Syncing to GitHub…"
                                : p.github_repo
                                  ? `Re-sync to ${p.github_repo}`
                                  : // Mirror the actual backend repo name format:
                                    // azure-mcp-<slug>-<project-uuid8>. Without
                                    // the UUID suffix the hint was misleading
                                    // since the real repo includes it.
                                    `Sync to GitHub (will create ${
                                      githubStatus?.owner
                                    }/azure-mcp-${p.name
                                      .toLowerCase()
                                      .replace(/[^a-z0-9_.-]/g, "-")}-${p.id
                                      .replace(/-/g, "")
                                      .slice(0, 8)})`
                            }
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold text-primary border border-primary/30 bg-primary/5 hover:bg-primary/15 transition-colors disabled:opacity-50"
                          >
                            <span
                              className={`material-symbols-outlined text-[14px] ${
                                syncingId === p.id ? "animate-spin" : ""
                              }`}
                            >
                              {syncingId === p.id
                                ? "progress_activity"
                                : "cloud_upload"}
                            </span>
                            {syncingId === p.id ? "Syncing…" : "GitHub"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete project '${p.name}'?`,
                              message: (
                                <>
                                  This removes the project record, its
                                  topologies, deployment history, and
                                  schedules from azure-mcp's database.
                                  <br />
                                  <br />
                                  <strong>Azure resources tagged with this
                                  name stay alive</strong> — destroy them
                                  via the Topologies rail or the project-
                                  wide Tear down button first if you also
                                  want them removed.
                                </>
                              ),
                              confirmLabel: "Delete project",
                              tone: "danger",
                              icon: "folder_delete",
                            });
                            if (ok) onDelete(p);
                          }}
                          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold text-error border border-error/30 bg-error/5 hover:bg-error/15 transition-colors"
                          title={`Delete project '${p.name}'`}
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            delete
                          </span>
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {syncError && (
            <div className="px-3 py-2 bg-error/5 border-t border-error/30 text-[11px] text-error font-mono break-words">
              GitHub sync failed: {syncError}
            </div>
          )}
          {!ghEnabled && (
            <div className="px-3 py-1.5 border-t border-outline-variant/30 text-[10px] text-on-surface-variant">
              GitHub sync disabled — set <code className="font-mono">GH_TOKEN</code> +{" "}
              <code className="font-mono">GH_OWNER</code> in <code className="font-mono">.env</code>.
            </div>
          )}
          <div className="border-t border-outline-variant/30 p-2">
            <button
              type="button"
              onClick={() => {
                onCreate();
                setOpen(false);
              }}
              className="w-full px-3 py-2 rounded-lg text-sm font-semibold text-primary hover:bg-primary/5 text-left flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-base">add</span>
              New project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

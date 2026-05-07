// Header dropdown for selecting / creating projects.

import { useEffect, useRef, useState } from "react";
import type { Project } from "../../lib/types";
import { useConfirm } from "../ui/useConfirm";

type Props = {
  projects: Project[];
  current: Project | null;
  loading: boolean;
  onSelect: (p: Project) => void;
  onCreate: () => void;
  onDelete: (p: Project) => void;
};

export function ProjectSwitcher({
  projects,
  current,
  loading,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();

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
                        </button>
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

// Collapsible left rail with four tabs: Projects, Topologies (active
// project), History, Templates.

import { useEffect, useState } from "react";
import type { Project, Template, TopologyRecord } from "../../lib/types";
import { listTemplates } from "../../lib/api";
import { TopologiesList } from "./TopologiesList";

type Deployment = {
  id: string;
  project_id: string;
  mode: string;
  prompt: string;
  status: string;
  created_at: string;
};

type Tab = "topologies" | "history" | "templates";

type Props = {
  projects: Project[];
  current: Project | null;
  topologies: TopologyRecord[];
  activeTopologyId: string | null;
  /** Bumped by App after a save/delete to force the templates list
   *  to reload without the user having to flip tabs. */
  templatesRefreshKey?: number;
  /** Topology id currently being synced to GitHub (passed through to
   *  TopologiesList so the row can spinner/disable). */
  syncingTopologyId?: string | null;
  /** Topology id currently mid-destroy. Same pattern as sync. */
  destroyingTopologyId?: string | null;
  /** Whether GitHub sync is available at all (env var configured). */
  githubAvailable?: boolean;
  onSelect: (p: Project) => void;
  onSelectTopology: (t: TopologyRecord) => void;
  onNewTopology: () => void;
  onRenameTopology: (t: TopologyRecord, newName: string) => void;
  onDeleteTopology: (t: TopologyRecord) => void;
  onDestroyTopology: (t: TopologyRecord) => void;
  onSyncTopologyToGithub?: (t: TopologyRecord) => void;
  onLoadTemplate: (t: Template) => void;
  onDeleteTemplate: (t: Template) => void;
};

export function LeftRail({
  projects,
  current,
  topologies,
  activeTopologyId,
  templatesRefreshKey,
  syncingTopologyId,
  destroyingTopologyId,
  githubAvailable,
  onSelect,
  onSelectTopology,
  onNewTopology,
  onRenameTopology,
  onDeleteTopology,
  onDestroyTopology,
  onSyncTopologyToGithub,
  onLoadTemplate,
  onDeleteTemplate,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  void onSelect; // projects no longer have a rail entry; the header switcher owns selection
  void projects;
  const [tab, setTab] = useState<Tab>("topologies");
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    if (collapsed) return;
    if (tab === "history") {
      const url = current?.id
        ? `/api/deployments?project_id=${current.id}`
        : "/api/deployments";
      fetch(url)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Deployment[]) => setDeployments(rows))
        .catch(() => setDeployments([]));
    } else if (tab === "templates") {
      listTemplates()
        .then((rows) => setTemplates(rows))
        .catch(() => setTemplates([]));
    }
  }, [tab, collapsed, current?.id, templatesRefreshKey]);

  const W = collapsed ? "w-16" : "w-64";

  return (
    <aside
      className={`${W} shrink-0 border-r border-outline-variant/40 bg-surface-container-lowest flex flex-col transition-[width] duration-200`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="px-3 py-3 hover:bg-surface-container-low transition-colors flex items-center justify-end text-on-surface-variant"
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span className="material-symbols-outlined">
          {collapsed ? "chevron_right" : "chevron_left"}
        </span>
      </button>

      <nav className="flex flex-col gap-0.5 px-2">
        <RailTab
          icon="schema"
          label="Topologies"
          active={tab === "topologies"}
          collapsed={collapsed}
          onClick={() => setTab("topologies")}
          badge={topologies.length || undefined}
        />
        <RailTab
          icon="history"
          label="History"
          active={tab === "history"}
          collapsed={collapsed}
          onClick={() => setTab("history")}
        />
        <RailTab
          icon="bookmark"
          label="Templates"
          active={tab === "templates"}
          collapsed={collapsed}
          onClick={() => setTab("templates")}
        />
      </nav>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-3 mt-4 pb-4">
          {tab === "topologies" && (
            current ? (
              <TopologiesList
                topologies={topologies}
                activeTopologyId={activeTopologyId}
                syncingTopologyId={syncingTopologyId}
                destroyingTopologyId={destroyingTopologyId}
                githubAvailable={!!githubAvailable}
                onSelect={onSelectTopology}
                onNewTopology={onNewTopology}
                onRename={onRenameTopology}
                onDelete={onDeleteTopology}
                onDestroy={onDestroyTopology}
                onSyncToGithub={onSyncTopologyToGithub}
              />
            ) : (
              <p className="text-xs text-on-surface-variant">
                Select a project to see its topologies.
              </p>
            )
          )}
          {tab === "history" && <DeploymentsList items={deployments} />}
          {tab === "templates" && (
            <TemplatesList
              items={templates}
              hasProject={!!current}
              onLoad={onLoadTemplate}
              onDelete={onDeleteTemplate}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function RailTab({
  icon,
  label,
  active,
  collapsed,
  onClick,
  badge,
}: {
  icon: string;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`flex items-center gap-3 ${collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2"} rounded-lg ${
        active
          ? "bg-primary/10 text-primary font-bold"
          : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
      } transition-colors`}
    >
      <span className="material-symbols-outlined text-base">{icon}</span>
      {!collapsed && (
        <>
          <span className="text-sm">{label}</span>
          {badge !== undefined && (
            <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-surface-container-high">
              {badge}
            </span>
          )}
        </>
      )}
    </button>
  );
}

const STATUS_TONE: Record<string, string> = {
  pending: "bg-outline-variant/25 text-on-surface-variant",
  success: "bg-secondary/15 text-secondary",
  failed: "bg-error/15 text-error",
  partial: "bg-orange-400/15 text-orange-500",
};

function DeploymentsList({ items }: { items: Deployment[] }) {
  if (items.length === 0)
    return (
      <p className="text-xs text-on-surface-variant">
        No deployments recorded yet.
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.map((d) => (
        <li
          key={d.id}
          className="rounded-lg bg-surface-container-low p-2.5 text-xs"
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
              {d.mode}
            </span>
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                STATUS_TONE[d.status] ?? STATUS_TONE.pending
              }`}
            >
              {d.status}
            </span>
          </div>
          <p className="line-clamp-2 leading-snug">{d.prompt}</p>
          <div className="mt-1 text-[10px] text-on-surface-variant">
            {new Date(d.created_at).toLocaleString()}
          </div>
        </li>
      ))}
    </ul>
  );
}

function TemplatesList({
  items,
  hasProject,
  onLoad,
  onDelete,
}: {
  items: Template[];
  hasProject: boolean;
  onLoad: (t: Template) => void;
  onDelete: (t: Template) => void;
}) {
  if (items.length === 0)
    return (
      <p className="text-xs text-on-surface-variant">
        No templates saved yet. Save one from a reviewed deployment.
      </p>
    );
  return (
    <ul className="flex flex-col gap-2 list-none p-0 m-0">
      {items.map((t) => (
        <li
          key={t.id}
          className="rounded-lg bg-surface-container-low p-2.5 text-xs group hover:bg-surface-container-high transition-colors"
        >
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => onLoad(t)}
              disabled={!hasProject}
              title={
                hasProject
                  ? `Load '${t.name}' as a new topology in this project`
                  : "Pick a project first to load a template"
              }
              className="flex-1 min-w-0 text-left disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="text-sm font-semibold truncate">{t.name}</div>
              {t.description && (
                <p className="text-[11px] text-on-surface-variant line-clamp-2 mt-0.5">
                  {t.description}
                </p>
              )}
              <div className="mt-1 text-[10px] text-on-surface-variant">
                {new Date(t.created_at).toLocaleDateString()}
              </div>
            </button>
            <button
              type="button"
              onClick={() => onDelete(t)}
              title={`Delete template '${t.name}'`}
              className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-error border border-error/40 hover:bg-error/10 transition-colors opacity-60 group-hover:opacity-100"
            >
              <span className="material-symbols-outlined text-base">delete</span>
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

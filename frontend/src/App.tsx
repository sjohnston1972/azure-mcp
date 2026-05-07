// Top-level workspace.
//
//   ┌─ TopNav (h-16) ────────────────────────────────────────────────┐
//   ├─ LeftRail ─┬─ Topology canvas ────────┬─ Chat panel ──────────┤
//   │  (Projects │  (React Flow)            │  (chat + stage bar)   │
//   │   Topologies (active project)         │  (bicep drawer)       │
//   │   History  │                          │                       │
//   │   Templates)                          │                       │
//   └────────────┴──────────────────────────┴───────────────────────┘
//
// Topology records live in the backend (`topologies` table). Each
// project can hold many topologies; each is draft / live / destroyed.
// The "active" topology id is persisted per-project in localStorage so
// the canvas + chat keep targeting the same one across reloads.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CanvasPanel } from "./components/canvas/CanvasPanel";
import { ChatPanel } from "./components/chat/ChatPanel";
import { LeftRail } from "./components/rail/LeftRail";
import { ProjectSwitcher } from "./components/projects/ProjectSwitcher";
import { NewProjectModal } from "./components/projects/NewProjectModal";
import { SchedulerModal } from "./components/scheduler/SchedulerModal";
import { ConfirmProvider, useConfirm } from "./components/ui/useConfirm";
import {
  createProject,
  createTopology,
  deleteProject,
  deleteTopology,
  listProjects,
  listTopologies,
  patchTopology,
} from "./lib/api";
import type {
  BuildState,
  Project,
  TopologyRecord,
} from "./lib/types";
import type { Topology } from "./lib/parse-topology";

const ACTIVE_PROJECT_KEY = "azure-mcp:active-project-id";
const activeTopologyKey = (projectId: string) =>
  `azure-mcp:active-topology:${projectId}`;

export function App() {
  return (
    <ConfirmProvider>
      <AppInner />
    </ConfirmProvider>
  );
}

function AppInner() {
  const confirm = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [schedulerOpen, setSchedulerOpen] = useState(false);

  // Topologies for the active project, plus which one is active.
  const [topologies, setTopologies] = useState<TopologyRecord[]>([]);
  const [activeTopologyId, setActiveTopologyId] = useState<string | null>(null);

  // Live build state — mirrors the active topology's topology + bicep
  // and tracks "pushed" for the stage bar. Updated by Claude's stream
  // (via the chat panel callbacks) and persisted back to the backend
  // when the chat turn completes.
  const [build, setBuild] = useState<BuildState>({
    topology: null,
    bicep: null,
    pushed: false,
    pushedAt: null,
  });

  const [autoPrompt, setAutoPrompt] = useState<
    { text: string; key: number } | null
  >(null);
  const [pendingDestroy, setPendingDestroy] = useState<
    { topologyId: string; key: number } | null
  >(null);

  // ── Project bootstrap + selection ────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProjects();
      setProjects(list);
      const savedId = localStorage.getItem(ACTIVE_PROJECT_KEY);
      const restored = savedId ? list.find((p) => p.id === savedId) : null;
      const next = restored ?? list[0] ?? null;
      setCurrent(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // When the project changes, load its topologies and pick the active one.
  useEffect(() => {
    if (!current) {
      setTopologies([]);
      setActiveTopologyId(null);
      setBuild({ topology: null, bicep: null, pushed: false, pushedAt: null });
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await listTopologies(current.id);
      if (cancelled) return;
      setTopologies(list);
      // Restore the saved active topology if it still exists, else
      // default to the most-recently-updated one (the list is ordered
      // by updated_at DESC by the backend).
      const savedId = localStorage.getItem(activeTopologyKey(current.id));
      const found = savedId ? list.find((t) => t.id === savedId) : null;
      const active = found ?? list[0] ?? null;
      setActiveTopologyId(active?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.id]);

  // Whenever the active topology changes (project switch, rail click,
  // create-new), reflect its data into build state.
  useEffect(() => {
    if (!activeTopologyId) {
      setBuild({ topology: null, bicep: null, pushed: false, pushedAt: null });
      return;
    }
    const t = topologies.find((x) => x.id === activeTopologyId);
    if (!t) {
      setBuild({ topology: null, bicep: null, pushed: false, pushedAt: null });
      return;
    }
    setBuild({
      topology: t.topology,
      bicep: t.bicep,
      pushed: t.status === "live",
      pushedAt: t.pushed_at,
    });
    // Persist the active id per-project.
    if (current) localStorage.setItem(activeTopologyKey(current.id), t.id);
  }, [activeTopologyId, topologies, current?.id]);

  const select = useCallback((p: Project) => {
    setCurrent(p);
    localStorage.setItem(ACTIVE_PROJECT_KEY, p.id);
  }, []);

  const create = useCallback(
    async (input: { name: string; description?: string }) => {
      const created = await createProject(input);
      setProjects((cur) => [created, ...cur]);
      select(created);
    },
    [select]
  );

  const removeProject = useCallback(
    async (p: Project) => {
      await deleteProject(p.id);
      setProjects((cur) => cur.filter((x) => x.id !== p.id));
      if (current?.id === p.id) {
        const next = projects.find((x) => x.id !== p.id) ?? null;
        setCurrent(next);
        if (next) localStorage.setItem(ACTIVE_PROJECT_KEY, next.id);
        else localStorage.removeItem(ACTIVE_PROJECT_KEY);
      }
    },
    [projects, current]
  );

  // ── Topology CRUD (rail interactions) ────────────────────────
  const handleSelectTopology = useCallback((t: TopologyRecord) => {
    setActiveTopologyId(t.id);
  }, []);

  const handleNewTopology = useCallback(async () => {
    if (!current) return;
    const t = await createTopology({ project_id: current.id });
    setTopologies((cur) => [t, ...cur]);
    setActiveTopologyId(t.id);
  }, [current]);

  const handleRenameTopology = useCallback(
    async (t: TopologyRecord, newName: string) => {
      try {
        const updated = await patchTopology(t.id, { name: newName });
        setTopologies((cur) =>
          cur.map((x) => (x.id === updated.id ? updated : x))
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[rename topology]", err);
      }
    },
    []
  );

  const handleDeleteTopology = useCallback(
    async (t: TopologyRecord) => {
      const live = t.status === "live";
      const ok = await confirm({
        title: `Delete topology '${t.name}'?`,
        message: live ? (
          <>
            This removes the topology record from azure-mcp.{" "}
            <strong>The Azure resources stay alive</strong> — destroy
            the topology first if you want them removed too.
          </>
        ) : (
          <>This removes the topology record. No Azure side effects.</>
        ),
        confirmLabel: "Delete",
        tone: "danger",
        icon: "delete",
      });
      if (!ok) return;
      await deleteTopology(t.id);
      setTopologies((cur) => cur.filter((x) => x.id !== t.id));
      if (activeTopologyId === t.id) {
        // Switch to another topology if any, else null.
        const next = topologies.find((x) => x.id !== t.id) ?? null;
        setActiveTopologyId(next?.id ?? null);
      }
    },
    [activeTopologyId, topologies, confirm]
  );

  // ── Per-turn persistence ─────────────────────────────────────
  // Called from ChatPanel's useChat onTurnComplete — at that point
  // the latest topology + bicep have been collected via onTopology/
  // onBicep. We persist them to the backend, creating the record if
  // we don't have an active topology yet, or PATCHing if we do.
  const persistBuildAfterTurn = useCallback(
    async (
      stage: string,
      topologyAtTurn: Topology | null,
      bicepAtTurn: string | null,
      teardownTargetId: string | null,
      errored: boolean
    ) => {
      if (!current) return;
      try {
        if (stage === "teardown" && teardownTargetId) {
          // Per-topology destroy → only mark destroyed if it succeeded.
          // On error, leave the status as it was (likely 'live') so
          // the user can retry.
          if (errored) return;
          const updated = await patchTopology(teardownTargetId, {
            status: "destroyed",
            topology: { nodes: [], edges: [] },
          });
          setTopologies((cur) =>
            cur.map((t) => (t.id === updated.id ? updated : t))
          );
          return;
        }

        if (stage === "push" && activeTopologyId) {
          // Push outcome → live on success, failed on error. Either way,
          // persist the topology+bicep so the rail reflects the current
          // design (Claude may have updated nodes mid-attempt).
          const updated = await patchTopology(activeTopologyId, {
            status: errored ? "failed" : "live",
            ...(topologyAtTurn ? { topology: topologyAtTurn } : {}),
            ...(bicepAtTurn ? { bicep: bicepAtTurn } : {}),
          });
          setTopologies((cur) =>
            cur.map((t) => (t.id === updated.id ? updated : t))
          );
          return;
        }

        if (stage === "build" && (topologyAtTurn || bicepAtTurn)) {
          if (!activeTopologyId) {
            // First topology in the project — create it.
            const created = await createTopology({
              project_id: current.id,
              ...(topologyAtTurn ? { topology: topologyAtTurn } : {}),
              ...(bicepAtTurn ? { bicep: bicepAtTurn } : {}),
            });
            setTopologies((cur) => [created, ...cur]);
            setActiveTopologyId(created.id);
          } else {
            const updated = await patchTopology(activeTopologyId, {
              ...(topologyAtTurn ? { topology: topologyAtTurn } : {}),
              ...(bicepAtTurn ? { bicep: bicepAtTurn } : {}),
            });
            setTopologies((cur) =>
              cur.map((t) => (t.id === updated.id ? updated : t))
            );
          }
        }
      } catch (err) {
        // Persistence failures are non-fatal — the in-memory build
        // state is still correct. We surface to console so the
        // user can copy logs if reporting an issue.
        // eslint-disable-next-line no-console
        console.error("[persistBuildAfterTurn]", err);
      }
    },
    [current, activeTopologyId]
  );

  // ── Live state mutators (no persistence yet — that's per turn) ──
  const onTopologyChange = useCallback((t: Topology) => {
    setBuild((b) => ({ ...b, topology: t }));
  }, []);

  const onBicepChange = useCallback((bicep: string) => {
    setBuild((b) => ({ ...b, bicep }));
  }, []);

  const onBuildReset = useCallback(() => {
    // "New build" in the chat = create a new draft topology immediately.
    void handleNewTopology();
  }, [handleNewTopology]);

  const onPushed = useCallback(() => {
    setBuild((b) => ({
      ...b,
      pushed: true,
      pushedAt: new Date().toISOString(),
    }));
  }, []);

  const onTorndown = useCallback(() => {
    // Project-wide tear-down: clear local view. The per-topology destroy
    // path (rail) updates the topology list directly via persistBuildAfterTurn.
    setBuild({ topology: null, bicep: null, pushed: false, pushedAt: null });
  }, []);

  const activeTopology = useMemo(
    () => topologies.find((t) => t.id === activeTopologyId) ?? null,
    [topologies, activeTopologyId]
  );

  return (
    <div className="h-screen flex flex-col">
      <header className="h-16 shrink-0 sticky top-0 z-40 bg-surface-container-lowest border-b border-outline-variant/40 flex items-center px-6 gap-4">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary-container grid place-items-center text-on-primary text-sm font-extrabold">
          a
        </div>
        <h1 className="text-lg font-extrabold tracking-tight">azure-mcp</h1>
        <span className="text-xs text-on-surface-variant ml-2 hidden md:inline">
          azure architecture, designed in chat
        </span>

        <div className="ml-auto flex items-center gap-2">
          <ProjectSwitcher
            projects={projects}
            current={current}
            loading={loading}
            onSelect={select}
            onCreate={() => setModalOpen(true)}
            onDelete={(p) => void removeProject(p)}
          />
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <LeftRail
          projects={projects}
          current={current}
          topologies={topologies}
          activeTopologyId={activeTopologyId}
          onSelect={select}
          onSelectTopology={handleSelectTopology}
          onNewTopology={() => void handleNewTopology()}
          onRenameTopology={(t, newName) => void handleRenameTopology(t, newName)}
          onDeleteTopology={(t) => void handleDeleteTopology(t)}
          onDestroyTopology={async (t) => {
            const ok = await confirm({
              title: `Destroy topology '${t.name}'?`,
              message: (
                <>
                  This deletes every Azure resource tagged with{" "}
                  <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">
                    mcp-topology-id={t.id.slice(0, 8)}…
                  </code>
                  . Resources from <strong>other topologies</strong> in this
                  project stay alive. The topology record stays for audit;
                  delete it separately if you also want to remove the
                  record.
                </>
              ),
              confirmLabel: "Destroy resources",
              cancelLabel: "Keep resources",
              tone: "danger",
              icon: "delete_sweep",
            });
            if (!ok) return;
            setActiveTopologyId(t.id);
            setPendingDestroy({ topologyId: t.id, key: Date.now() });
          }}
        />
        <main className="flex-1 grid grid-cols-1 md:grid-cols-[1fr_460px] gap-4 p-4 min-w-0">
          <CanvasPanel
            topology={build.topology}
            projectId={current?.id ?? null}
            onExamplePrompt={(text) =>
              setAutoPrompt({ text, key: Date.now() })
            }
          />
          <ChatPanel
            projectName={current?.name ?? null}
            projectId={current?.id ?? null}
            activeTopologyId={activeTopologyId}
            activeTopologyName={activeTopology?.name ?? null}
            build={build}
            autoPrompt={autoPrompt}
            pendingDestroy={pendingDestroy}
            onTopologyChange={onTopologyChange}
            onBicepChange={onBicepChange}
            onBuildReset={onBuildReset}
            onPushed={onPushed}
            onTorndown={onTorndown}
            onSchedule={() => setSchedulerOpen(true)}
            onAutoPromptConsumed={() => setAutoPrompt(null)}
            onPendingDestroyConsumed={() => setPendingDestroy(null)}
            onTurnComplete={persistBuildAfterTurn}
          />
        </main>
      </div>

      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={create}
      />

      <SchedulerModal
        open={schedulerOpen}
        project={current}
        onClose={() => setSchedulerOpen(false)}
      />
    </div>
  );
}

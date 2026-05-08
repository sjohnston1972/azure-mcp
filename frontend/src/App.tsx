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
import { VmSelector } from "./components/azure/VmSelector";
import { ConfirmProvider, useConfirm } from "./components/ui/useConfirm";
import {
  createProject,
  createTopology,
  deleteProject,
  deleteTemplate,
  deleteTopology,
  getGithubStatus,
  listProjects,
  listTopologies,
  patchTopology,
} from "./lib/api";
import type {
  BuildState,
  GithubStatus,
  Project,
  Template,
  TopologyRecord,
} from "./lib/types";
import type { Topology } from "./lib/parse-topology";
import { inferTopologyName } from "./lib/infer-name";
import type { ToolStatus } from "./hooks/useChat";

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
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [vmSelectorOpen, setVmSelectorOpen] = useState(false);

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

  // GitHub status is global config (whether GH_TOKEN + GH_OWNER are
  // present in the env), fetched once at boot. Drives whether the
  // sync UI shows up at all.
  useEffect(() => {
    getGithubStatus()
      .then(setGithubStatus)
      .catch(() => setGithubStatus({ configured: false, owner: null, visibility: "private" }));
  }, []);

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

  // Bumped after a template is loaded or deleted so the rail's
  // Templates tab refetches without the user having to flip tabs.
  const [templatesRefreshKey, setTemplatesRefreshKey] = useState(0);

  /** Load a saved Bicep template into the active project as a new
   *  draft topology. The template only stores Bicep — we set it on the
   *  new topology and auto-prompt Claude to render the canvas
   *  topology marker from it, so the visual fills in on the next turn. */
  const handleLoadTemplate = useCallback(
    async (t: Template) => {
      if (!current) return;
      const ok = await confirm({
        title: `Load '${t.name}' into '${current.name}'?`,
        message: (
          <>
            Creates a new <strong>draft topology</strong> in this project
            from the saved Bicep. Claude will render the canvas on the
            next turn — nothing deploys until you click Push.
          </>
        ),
        confirmLabel: "Load template",
        icon: "bookmark",
        tone: "primary",
      });
      if (!ok) return;
      try {
        const created = await createTopology({
          project_id: current.id,
          name: t.name.slice(0, 24),
          bicep: t.bicep,
        });
        setTopologies((cur) => [created, ...cur]);
        setActiveTopologyId(created.id);
        // Ask Claude to populate the topology marker from the loaded
        // Bicep so the canvas fills in. The Bicep is inlined so the
        // model has it even if Claude's earlier conversation history
        // doesn't contain it (e.g. brand-new chat).
        setAutoPrompt({
          text:
            `I've loaded the saved template '${t.name}' as a new draft topology in '${current.name}'. ` +
            `Render the topology canvas based on this Bicep — emit a \`<topology>\` marker only (no \`<bicep>\`, no changes). ` +
            `Don't deploy. Here's the template:\n\n` +
            "```bicep\n" +
            t.bicep +
            "\n```",
          key: Date.now(),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[load template]", err);
      }
    },
    [current, confirm]
  );

  const handleDeleteTemplate = useCallback(
    async (t: Template) => {
      const ok = await confirm({
        title: `Delete template '${t.name}'?`,
        message: (
          <>
            This removes the saved Bicep snippet. Topologies that were
            created from it stay intact.
          </>
        ),
        confirmLabel: "Delete",
        tone: "danger",
        icon: "delete",
      });
      if (!ok) return;
      try {
        await deleteTemplate(t.id);
        setTemplatesRefreshKey((k) => k + 1);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[delete template]", err);
      }
    },
    [confirm]
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
      deploy: ToolStatus,
      destroy: ToolStatus,
      userPrompt: string
    ) => {
      if (!current) return;
      try {
        // Per-topology destroy (rail-initiated) → only flip when a
        // teardown target was queued AND destroy_azure resolved with
        // success. We deliberately key off destroy/teardownTargetId
        // instead of stage so a destroy that happens via a typed-in
        // build-stage message (rare but possible) still gets honoured.
        if (teardownTargetId && destroy === "success") {
          const updated = await patchTopology(teardownTargetId, {
            status: "destroyed",
            topology: { nodes: [], edges: [] },
          });
          setTopologies((cur) =>
            cur.map((t) => (t.id === updated.id ? updated : t))
          );
          return;
        }
        // destroy "failed" / "incomplete" / null → leave status alone.

        // Deploy outcome (regardless of stage label). The user can
        // retry a failed push by typing a follow-up message — that
        // goes out as stage='build' but Claude will call deploy_bicep
        // again. We must flip the active topology's status based on
        // what actually ran, not on the stage label.
        //
        //   deploy === "success"    → flip to live
        //   deploy === "failed"     → flip to failed
        //   deploy === "incomplete" → DON'T flip (stream died mid-call,
        //                             Azure may still be processing —
        //                             user should check the portal)
        //                             but still persist topology/bicep.
        if (activeTopologyId && deploy) {
          const statusUpdate: { status?: "live" | "failed" } = {};
          if (deploy === "success") statusUpdate.status = "live";
          else if (deploy === "failed") statusUpdate.status = "failed";

          if (statusUpdate.status || topologyAtTurn || bicepAtTurn) {
            const updated = await patchTopology(activeTopologyId, {
              ...statusUpdate,
              ...(topologyAtTurn ? { topology: topologyAtTurn } : {}),
              ...(bicepAtTurn ? { bicep: bicepAtTurn } : {}),
            });
            setTopologies((cur) =>
              cur.map((t) => (t.id === updated.id ? updated : t))
            );
          }
          return;
        }

        if (stage === "build" && (topologyAtTurn || bicepAtTurn)) {
          if (!activeTopologyId) {
            // First topology in the project — create it. Auto-name
            // from the user's prompt (≤16 chars) so the rail is
            // immediately readable instead of "untitled-N".
            const inferredName = userPrompt
              ? inferTopologyName(userPrompt)
              : undefined;
            const created = await createTopology({
              project_id: current.id,
              ...(inferredName ? { name: inferredName } : {}),
              ...(topologyAtTurn ? { topology: topologyAtTurn } : {}),
              ...(bicepAtTurn ? { bicep: bicepAtTurn } : {}),
            });
            setTopologies((cur) => [created, ...cur]);
            setActiveTopologyId(created.id);
          } else {
            // If the active topology still has the default
            // "untitled-N" name (placeholder from + New topology),
            // rename it from the user's prompt at the same time as
            // we persist the build content. Don't touch user-renamed
            // topologies.
            const active = topologies.find((t) => t.id === activeTopologyId);
            const isPlaceholderName = !!active?.name && /^untitled-\d+$/.test(active.name);
            const inferredName =
              isPlaceholderName && userPrompt
                ? inferTopologyName(userPrompt)
                : null;
            const updated = await patchTopology(activeTopologyId, {
              ...(topologyAtTurn ? { topology: topologyAtTurn } : {}),
              ...(bicepAtTurn ? { bicep: bicepAtTurn } : {}),
              ...(inferredName ? { name: inferredName } : {}),
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
    [current, activeTopologyId, topologies]
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
          <button
            type="button"
            onClick={() => setVmSelectorOpen(true)}
            title="Browse Azure VM sizes (free-tier highlighted)"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant/40 hover:bg-surface-container-high transition-colors text-sm font-semibold text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-base">memory</span>
            VM sizes
          </button>
          <ProjectSwitcher
            projects={projects}
            current={current}
            loading={loading}
            githubStatus={githubStatus}
            onSelect={select}
            onCreate={() => setModalOpen(true)}
            onDelete={(p) => void removeProject(p)}
            onProjectUpdated={(updated) => {
              setProjects((cur) =>
                cur.map((p) => (p.id === updated.id ? updated : p))
              );
              if (current?.id === updated.id) setCurrent(updated);
            }}
          />
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <LeftRail
          projects={projects}
          current={current}
          topologies={topologies}
          activeTopologyId={activeTopologyId}
          templatesRefreshKey={templatesRefreshKey}
          onSelect={select}
          onSelectTopology={handleSelectTopology}
          onNewTopology={() => void handleNewTopology()}
          onRenameTopology={(t, newName) => void handleRenameTopology(t, newName)}
          onDeleteTopology={(t) => void handleDeleteTopology(t)}
          onLoadTemplate={(t) => void handleLoadTemplate(t)}
          onDeleteTemplate={(t) => void handleDeleteTemplate(t)}
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
            onTemplateSaved={() => setTemplatesRefreshKey((k) => k + 1)}
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

      <VmSelector
        open={vmSelectorOpen}
        onClose={() => setVmSelectorOpen(false)}
        onPick={(sku) => {
          // Picking a SKU drops a build-stage prompt into the chat
          // pinning that exact size. Reuses the autoPrompt path that
          // example prompts on the empty canvas use.
          setAutoPrompt({
            text: `Design a single Linux VM using SKU ${sku}. Default region uksouth, smallest reasonable disk, system-assigned managed identity, no public IP. Tag everything per the project's mcp-* scheme.`,
            key: Date.now(),
          });
        }}
      />
    </div>
  );
}

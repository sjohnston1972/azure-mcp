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
import { Ec2Selector } from "./components/aws/Ec2Selector";
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
  pushTopologyToGithub,
} from "./lib/api";
import { captureCanvasPng } from "./lib/canvas-screenshot";
import type {
  BuildState,
  Cloud,
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
  const [ec2SelectorOpen, setEc2SelectorOpen] = useState(false);

  // Active cloud — drives which projects show up in the dropdown,
  // which system prompt the chat uses, which deploy tools are
  // available, and the visual treatment of the header. Persisted
  // to localStorage so a refresh keeps the user's last toggle.
  const [cloud, setCloud] = useState<Cloud>(() => {
    const saved = localStorage.getItem("azure-mcp:cloud");
    return saved === "aws" ? "aws" : "azure";
  });
  useEffect(() => {
    localStorage.setItem("azure-mcp:cloud", cloud);
    // Drive the AWS-orange palette swap defined in index.css.
    // Setting data-cloud on <html> lets the [data-cloud="aws"]
    // selector flip --color-primary etc. without us writing
    // colour overrides in every component.
    document.documentElement.setAttribute("data-cloud", cloud);
  }, [cloud]);

  // ── Project bootstrap + selection ────────────────────────────
  // Only fetches projects matching the active cloud. The
  // active-project memory is per-cloud (separate localStorage key)
  // so flipping the toggle restores YOUR last choice in that cloud
  // rather than landing on a stale project from the other cloud.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProjects(cloud);
      setProjects(list);
      const savedId = localStorage.getItem(`${ACTIVE_PROJECT_KEY}:${cloud}`);
      const restored = savedId ? list.find((p) => p.id === savedId) : null;
      const next = restored ?? list[0] ?? null;
      setCurrent(next);
    } finally {
      setLoading(false);
    }
  }, [cloud]);

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
    // Per-cloud key so each cloud remembers the last project the
    // user worked on independently.
    localStorage.setItem(`${ACTIVE_PROJECT_KEY}:${p.cloud}`, p.id);
  }, []);

  const create = useCallback(
    async (input: { name: string; description?: string }) => {
      // Stamp the new project with whichever cloud is currently
      // active in the toggle. NewProjectModal doesn't ask the user
      // to pick a cloud — the toggle IS the cloud picker.
      const created = await createProject({ ...input, cloud });
      setProjects((cur) => [created, ...cur]);
      select(created);
    },
    [select, cloud]
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
      // If the template carries the canvas JSON it was saved with,
      // we can render the topology directly — no Claude round-trip.
      // Older templates (saved before topology was captured) still
      // fall back to asking Claude to derive a marker from the Bicep.
      const hasCanvas = !!t.topology;
      const ok = await confirm({
        title: `Load '${t.name}' into '${current.name}'?`,
        message: hasCanvas ? (
          <>
            Creates a new <strong>draft topology</strong> in this project
            from the saved Bicep and canvas snapshot. Renders straight
            from saved data — no chat call.
          </>
        ) : (
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
          // Pass through the saved canvas if present so the new
          // topology row lands with both bicep and topology JSON.
          ...(t.topology ? { topology: t.topology } : {}),
        });
        setTopologies((cur) => [created, ...cur]);
        setActiveTopologyId(created.id);
        if (!hasCanvas) {
          // Legacy templates: fall back to the LLM rendering path so
          // the canvas eventually fills in. The Bicep is inlined so
          // the model has it even on a fresh chat.
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
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[load template]", err);
      }
    },
    [current, confirm]
  );

  // Tracks the topology currently being synced to GitHub so the
  // rail row can show a spinner + disable the button. Also rate-
  // limits to one sync at a time across the whole app.
  const [syncingTopologyId, setSyncingTopologyId] = useState<string | null>(
    null
  );
  // Tracks the topology currently being destroyed in Azure. Lets the
  // rail row show "destroying…" with a spinner and hide the Destroy
  // button immediately on click — without waiting for the chat turn
  // to complete (which can take 5-10 minutes).
  const [destroyingTopologyId, setDestroyingTopologyId] = useState<
    string | null
  >(null);

  /** Sync a topology to its own GitHub repo (Bicep + topology.json
   *  + README + canvas screenshot). Capture the screenshot from the
   *  React Flow canvas after switching to that topology so the user
   *  sees what will be saved before the upload. */
  const handleSyncTopologyToGithub = useCallback(
    async (t: TopologyRecord) => {
      if (!githubStatus?.configured) return;
      if (syncingTopologyId) return; // Already a sync in flight.

      const ok = await confirm({
        title: t.github_repo
          ? `Re-sync '${t.name}' to GitHub?`
          : `Sync '${t.name}' to GitHub?`,
        message: (
          <>
            {t.github_repo ? (
              <>
                Updates the existing repo{" "}
                <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">
                  {t.github_repo}
                </code>{" "}
                with the latest Bicep, topology JSON, README, and a
                fresh canvas screenshot.
              </>
            ) : (
              <>
                Creates a new private GitHub repo named{" "}
                <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">
                  azure-mcp-{t.name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}-
                  {t.id.replace(/-/g, "").slice(0, 8)}
                </code>{" "}
                with the Bicep, topology JSON, README, and a canvas
                screenshot.
              </>
            )}
          </>
        ),
        confirmLabel: t.github_repo ? "Re-sync" : "Sync to GitHub",
        icon: "cloud_upload",
        tone: "primary",
      });
      if (!ok) return;

      // Switch to the target topology if needed so the canvas is
      // showing the right thing. Then ALWAYS wait a short settle
      // window before capturing — React Flow can be mid-layout (or
      // remount) even when the topology was already active, and a
      // half-rendered screenshot has bitten us before. Two animation
      // frames + a 250ms tick gives the layout pass time to land.
      if (activeTopologyId !== t.id) {
        setActiveTopologyId(t.id);
      }
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(null)))
      );
      await new Promise((r) => setTimeout(r, 250));

      setSyncingTopologyId(t.id);
      try {
        let screenshot: string | undefined;
        try {
          const png = await captureCanvasPng();
          screenshot = png ?? undefined;
          if (png) {
            // Soft signal in the browser console so the user can
            // confirm a fresh capture happened on each click — handy
            // when GitHub's image CDN caches the previous version.
            // eslint-disable-next-line no-console
            console.info(
              "[sync] captured fresh canvas screenshot (%d KB)",
              Math.round(png.length / 1024)
            );
          }
        } catch (err) {
          // Screenshot capture is best-effort — sync still proceeds
          // without an image if html-to-image trips on something.
          // eslint-disable-next-line no-console
          console.warn("[sync] canvas screenshot failed", err);
        }
        const result = await pushTopologyToGithub(t.id, screenshot);
        // Reflect the new github_repo / github_synced_at on the row.
        setTopologies((cur) =>
          cur.map((x) => (x.id === result.topology.id ? result.topology : x))
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[sync topology]", err);
      } finally {
        setSyncingTopologyId(null);
      }
    },
    [githubStatus?.configured, syncingTopologyId, confirm, activeTopologyId]
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
      // Cloud-aware text: each topology row remembers its own cloud
      // (denormalised on the row), so a delete confirm always names
      // the right provider regardless of the toggle's current state.
      const cloudName = t.cloud === "aws" ? "AWS" : "Azure";
      const ok = await confirm({
        title: `Delete topology '${t.name}'?`,
        message: live ? (
          <>
            This removes the topology record from Cloud Topology Creator.{" "}
            <strong>The {cloudName} resources stay alive</strong> — destroy
            the topology first if you want them removed too.
          </>
        ) : (
          <>This removes the topology record. No {cloudName} side effects.</>
        ),
        confirmLabel: "Delete",
        tone: "danger",
        icon: "delete",
      });
      if (!ok) return;
      await deleteTopology(t.id);
      setTopologies((cur) => cur.filter((x) => x.id !== t.id));
      // If we just deleted the topology that was on the canvas,
      // clear it (set active=null) so we don't show stale data from
      // a now-deleted record. The user can click any remaining
      // topology in the rail to switch back into it.
      if (activeTopologyId === t.id) {
        setActiveTopologyId(null);
      }
    },
    [activeTopologyId, confirm]
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
      // Always clear the optimistic "destroying" badge when a
      // destroy-related turn ends, regardless of outcome — the row
      // chip then reflects t.status (destroyed on success, live or
      // failed on partial outcomes).
      const clearDestroying = () => {
        if (teardownTargetId && destroyingTopologyId === teardownTargetId) {
          setDestroyingTopologyId(null);
        }
      };
      try {
        // Per-topology destroy (rail-initiated) → only flip when a
        // teardown target was queued AND destroy_azure resolved with
        // success. We deliberately key off destroy/teardownTargetId
        // instead of stage so a destroy that happens via a typed-in
        // build-stage message (rare but possible) still gets honoured.
        if (teardownTargetId && destroy === "success") {
          // Carry the existing topology JSON forward but stamp every
          // node's status as "destroyed" so the canvas dims them in
          // place (rather than wiping). The user can still see what
          // was there at the moment of teardown — useful for audit.
          const existing = topologies.find((t) => t.id === teardownTargetId);
          const newTopology = existing?.topology
            ? {
                nodes: existing.topology.nodes.map((n) => ({
                  ...n,
                  status: "destroyed" as const,
                })),
                edges: existing.topology.edges,
              }
            : { nodes: [], edges: [] };
          const updated = await patchTopology(teardownTargetId, {
            status: "destroyed",
            topology: newTopology,
          });
          setTopologies((cur) =>
            cur.map((t) => (t.id === updated.id ? updated : t))
          );
          clearDestroying();
          return;
        }
        // destroy "failed" / "incomplete" / null → leave status alone,
        // but still drop the optimistic in-flight badge so the row
        // chip falls back to the persisted t.status (typically "live").
        clearDestroying();

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
    [current, activeTopologyId, topologies, destroyingTopologyId]
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
        {/* Cloud-icon badge. The icon itself stays the same across
            modes (cloud is the umbrella concept); the badge BG is
            the active primary, which our index.css [data-cloud=aws]
            selector swaps to AWS orange. */}
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-primary-container grid place-items-center text-on-primary shadow-sm">
          <span className="material-symbols-outlined text-[22px]">cloud</span>
        </div>
        <h1 className="text-lg font-extrabold tracking-tight">
          Cloud Topology Creator
        </h1>
        <span className="text-xs text-on-surface-variant ml-2 hidden md:inline">
          {cloud === "aws"
            ? "AWS architecture, designed in chat"
            : "Azure architecture, designed in chat"}
        </span>

        {/* Cloud toggle — switches the whole UI between Azure and
            AWS modes. Project list, system prompt, deploy tools,
            and visual treatment all key off this. localStorage
            persists the choice across reloads. */}
        <div className="ml-4 inline-flex items-center rounded-lg border border-outline-variant/40 bg-surface-container-low p-0.5">
          {(["azure", "aws"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCloud(c)}
              className={`px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${
                cloud === c
                  ? "bg-primary text-on-primary shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
              title={
                c === "azure"
                  ? "Azure mode — Bicep, az CLI, Microsoft Azure MCP"
                  : "AWS mode — CloudFormation, aws CLI (SSO from host)"
              }
            >
              {c === "azure" ? "Azure" : "AWS"}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {cloud === "azure" && (
            <button
              type="button"
              onClick={() => setVmSelectorOpen(true)}
              title="Browse Azure VM sizes (free-tier highlighted)"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant/40 hover:bg-surface-container-high transition-colors text-sm font-semibold text-on-surface-variant"
            >
              <span className="material-symbols-outlined text-base">memory</span>
              VM sizes
            </button>
          )}
          {cloud === "aws" && (
            <button
              type="button"
              onClick={() => setEc2SelectorOpen(true)}
              title="Browse AWS EC2 instance types (free-tier highlighted)"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant/40 hover:bg-surface-container-high transition-colors text-sm font-semibold text-on-surface-variant"
            >
              <span className="material-symbols-outlined text-base">memory</span>
              EC2 sizes
            </button>
          )}
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
          syncingTopologyId={syncingTopologyId}
          destroyingTopologyId={destroyingTopologyId}
          githubAvailable={!!githubStatus?.configured}
          onSelect={select}
          onSelectTopology={handleSelectTopology}
          onNewTopology={() => void handleNewTopology()}
          onRenameTopology={(t, newName) => void handleRenameTopology(t, newName)}
          onDeleteTopology={(t) => void handleDeleteTopology(t)}
          onSyncTopologyToGithub={(t) => void handleSyncTopologyToGithub(t)}
          onLoadTemplate={(t) => void handleLoadTemplate(t)}
          onDeleteTemplate={(t) => void handleDeleteTemplate(t)}
          onDestroyTopology={async (t) => {
            const cloudName = t.cloud === "aws" ? "AWS" : "Azure";
            const ok = await confirm({
              title: `Destroy topology '${t.name}'?`,
              message: (
                <>
                  This deletes every {cloudName} resource tagged with{" "}
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
            // Optimistic UI: mark this topology as destroying right
            // away so the row chip + button reflect the in-flight
            // state. Cleared in persistBuildAfterTurn (any outcome).
            setDestroyingTopologyId(t.id);
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
            cloud={current?.cloud ?? cloud}
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

      <Ec2Selector
        open={ec2SelectorOpen}
        onClose={() => setEc2SelectorOpen(false)}
        onPick={(typeName) => {
          // Same pattern as VM picker — drop a build-stage prompt
          // pinning the chosen EC2 type so Claude generates a CFN
          // template using exactly that size.
          setAutoPrompt({
            text: `Design a single Linux EC2 instance using type ${typeName}. Default region us-east-1, smallest reasonable EBS volume, no public IP (private subnet + NAT), use the dynamic SSM parameter for the AMI. Tag everything per the project's mcp-* scheme.`,
            key: Date.now(),
          });
        }}
      />
    </div>
  );
}

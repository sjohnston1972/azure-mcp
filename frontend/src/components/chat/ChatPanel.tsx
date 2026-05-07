// Right pane: streaming chat + lifecycle stage bar + Bicep drawer.
// Topology + bicep markers parsed from Claude's stream are forwarded
// to the parent (App), which holds per-project build state.

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../../hooks/useChat";
import { parseAnswers } from "../../lib/parse-answers";
import type { BuildState } from "../../lib/types";
import type { Topology } from "../../lib/parse-topology";
import { ChatActivity } from "./ChatActivity";
import { Composer } from "./Composer";
import { Message } from "./Message";
import { StageBar } from "./StageBar";
import { BicepDrawer } from "./BicepDrawer";
import { useConfirm } from "../ui/useConfirm";

type Props = {
  projectName: string | null;
  projectId: string | null;
  /** Active topology id — sent with every chat turn so Claude tags
   *  resources with `azure-mcp-topology-id=<id>` and per-topology
   *  destroy can target precisely. */
  activeTopologyId: string | null;
  activeTopologyName: string | null;
  build: BuildState | null;
  /** A prompt set externally (e.g. from a "Try this" button on the
   *  empty canvas). When this changes to a non-null value AND the
   *  chat isn't currently sending, we auto-send it as a build turn
   *  and call onAutoPromptConsumed to clear it. */
  autoPrompt: { text: string; key: number } | null;
  /** A per-topology destroy queued from the rail. When this changes,
   *  we dispatch a teardown chat turn scoped to the given topology id. */
  pendingDestroy: { topologyId: string; key: number } | null;
  onTopologyChange: (t: Topology) => void;
  onBicepChange: (b: string) => void;
  onBuildReset: () => void;
  onPushed: () => void;
  onTorndown: () => void;
  onSchedule: () => void;
  onAutoPromptConsumed: () => void;
  onPendingDestroyConsumed: () => void;
  /** Fires after every assistant turn ends. App uses this to persist
   *  the topology + bicep to the backend (creating or PATCHing the
   *  active record), and to flip topology status on push/teardown.
   *  `errored` is true if any tool call returned is_error this turn —
   *  used to mark a failed push as `failed` rather than `live`. */
  onTurnComplete: (
    stage: string,
    topology: Topology | null,
    bicep: string | null,
    teardownTargetId: string | null,
    errored: boolean
  ) => void;
};

export function ChatPanel({
  projectName,
  projectId,
  activeTopologyId,
  activeTopologyName,
  build,
  autoPrompt,
  pendingDestroy,
  onTopologyChange,
  onBicepChange,
  onBuildReset,
  onPushed,
  onTorndown,
  onSchedule,
  onAutoPromptConsumed,
  onPendingDestroyConsumed,
  onTurnComplete,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const confirm = useConfirm();
  // Track the stage of the in-flight turn so its completion handler
  // knows whether to flip pushed/torndown. Also the latest topology+
  // bicep we've seen this turn — at end-of-turn we hand them to the
  // parent for persistence.
  const lastStageRef = useRef<string>("build");
  const turnTopologyRef = useRef<Topology | null>(null);
  const turnBicepRef = useRef<string | null>(null);
  const turnTeardownTargetRef = useRef<string | null>(null);

  const { display, sending, error, send, sendStaged, cancel, reset } = useChat({
    onTopology: (t) => {
      turnTopologyRef.current = t;
      onTopologyChange(t);
    },
    onBicep: (b) => {
      turnBicepRef.current = b;
      onBicepChange(b);
    },
    onTurnComplete: ({ stage, errored }) => {
      // Only flip the local "pushed" flag on a successful push.
      if (stage === "push" && !errored) onPushed();
      if (stage === "teardown" && !errored) onTorndown();
      onTurnComplete(
        stage,
        turnTopologyRef.current,
        turnBicepRef.current,
        turnTeardownTargetRef.current,
        errored
      );
      // Reset per-turn capture refs.
      turnTopologyRef.current = null;
      turnBicepRef.current = null;
      turnTeardownTargetRef.current = null;
    },
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [display]);

  // Auto-prompt consumer: example-prompt clicks elsewhere in the app
  // arrive here as `autoPrompt`. We keep `send` in a ref so the effect
  // doesn't re-fire on every render (send's identity changes per turn).
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!autoPrompt) return;
    if (sending || !projectId) return;
    void sendRef.current(autoPrompt.text, projectId, "build", activeTopologyId);
    onAutoPromptConsumed();
  }, [autoPrompt, sending, projectId, activeTopologyId, onAutoPromptConsumed]);

  // Per-topology destroy queue. Sends a teardown turn scoped to the
  // requested topology id. App's onTurnComplete then PATCHes that
  // topology to status=destroyed.
  const sendStagedRef = useRef(sendStaged);
  sendStagedRef.current = sendStaged;
  useEffect(() => {
    if (!pendingDestroy) return;
    if (sending || !projectId || !projectName) return;
    turnTeardownTargetRef.current = pendingDestroy.topologyId;
    void sendStagedRef.current(
      "teardown",
      projectId,
      projectName,
      pendingDestroy.topologyId
    );
    onPendingDestroyConsumed();
  }, [
    pendingDestroy,
    sending,
    projectId,
    projectName,
    onPendingDestroyConsumed,
  ]);

  const disabled = !projectName;

  const chipsTargetId = useMemo(() => {
    for (let i = display.length - 1; i >= 0; i--) {
      const m = display[i];
      if (!m || m.kind !== "assistant" || m.streaming) continue;
      const lastText = [...m.blocks].reverse().find((b) => b.type === "text");
      if (lastText && lastText.type === "text") {
        const parsed = parseAnswers(lastText.text);
        if (parsed.options && parsed.options.length > 0) return m.id;
      }
      break;
    }
    return null;
  }, [display]);

  const handleNewBuild = async () => {
    const ok = await confirm({
      title: "Start a new build?",
      message:
        "This clears the canvas and the Bicep template, but keeps your chat history so you can pick up where you left off.",
      confirmLabel: "Start over",
      icon: "edit_square",
    });
    if (!ok) return;
    onBuildReset();
  };

  const handlePush = async () => {
    if (!projectName || !build?.bicep) return;
    const ok = await confirm({
      title: `Deploy '${activeTopologyName ?? "topology"}' to Azure?`,
      message: (
        <>
          This will create <strong>live Azure resources</strong>, tagged with{" "}
          <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">
            azure-mcp-project={projectName}
          </code>
          {activeTopologyId && (
            <>
              {" "}and{" "}
              <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">
                azure-mcp-topology-id={activeTopologyId.slice(0, 8)}…
              </code>
            </>
          )}
          . Every resource Claude proposed in the canvas will be created.
        </>
      ),
      confirmLabel: "Push to Azure",
      tone: "primary",
      icon: "rocket_launch",
    });
    if (!ok) return;
    lastStageRef.current = "push";
    turnTeardownTargetRef.current = null;
    // Inline the user-approved Bicep into the push prompt so Claude
    // can't drift to an earlier version (e.g. reverting a rename).
    await sendStaged(
      "push",
      projectId,
      projectName,
      activeTopologyId,
      build?.bicep ?? null
    );
  };

  const handleTeardown = async () => {
    if (!projectName) return;
    const ok = await confirm({
      title: `Tear down everything in '${projectName}'?`,
      message: (
        <>
          This deletes <strong>every</strong> Azure resource tagged with{" "}
          <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">
            azure-mcp-project={projectName}
          </code>
          , including resources from <strong>every topology</strong> in this
          project. To destroy a single topology only, use the Destroy
          button on its row in the Topologies rail. This is not
          reversible.
        </>
      ),
      confirmLabel: "Tear down all",
      cancelLabel: "Keep resources",
      tone: "danger",
      icon: "delete_sweep",
    });
    if (!ok) return;
    lastStageRef.current = "teardown";
    turnTeardownTargetRef.current = null;
    // Project-wide tear-down: do NOT pass a topology_id.
    await sendStaged("teardown", projectId, projectName, null);
  };

  return (
    <>
      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant/40 shadow-sm overflow-hidden flex flex-col h-full">
        <div className="px-4 py-3 border-b border-outline-variant/30 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold">Chat</h2>
              <p className="text-xs text-on-surface-variant">
                {projectName
                  ? `Project '${projectName}'${build?.pushed ? " — deployed" : ""}`
                  : "Pick or create a project to start"}
              </p>
            </div>
            {display.length > 0 && (
              <button
                type="button"
                onClick={reset}
                className="text-xs font-semibold text-on-surface-variant hover:text-on-surface px-2 py-1 rounded-md hover:bg-surface-container-high transition-colors"
              >
                New chat
              </button>
            )}
          </div>
          <StageBar
            build={build}
            sending={sending}
            hasProject={!!projectName}
            onNewBuild={handleNewBuild}
            onViewBicep={() => setDrawerOpen(true)}
            onPush={() => void handlePush()}
            onTeardown={() => void handleTeardown()}
            onSchedule={onSchedule}
            onSaveTemplate={() => setDrawerOpen(true)}
          />
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
          {display.length === 0 && (
            <div className="rounded-lg bg-surface-container-low p-3">
              <div className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant mb-1">
                ready
              </div>
              <p className="text-sm leading-relaxed text-on-surface">
                Ask me anything Azure-related. When you ask me to{" "}
                <strong>design or modify</strong> an architecture, the
                topology canvas and the Bicep drawer fill in automatically.
                For chat or read-only questions they stay empty. Nothing
                deploys until you click <strong>Push to Azure</strong>.
              </p>
            </div>
          )}
          {display.map((m) => (
            <Message
              key={m.id}
              msg={m}
              chipsActive={m.id === chipsTargetId}
              onPickAnswer={(t) =>
                send(t, projectId, "build", activeTopologyId)
              }
            />
          ))}
          {error && (
            <div className="rounded-lg bg-error/5 border border-error/30 p-3 text-xs text-error font-mono whitespace-pre-wrap break-words">
              {error}
            </div>
          )}
        </div>

        <ChatActivity display={display} sending={sending} />

        <Composer
          disabled={disabled}
          sending={sending}
          onSend={(t) => send(t, projectId, "build", activeTopologyId)}
          onCancel={cancel}
        />
      </section>

      <BicepDrawer
        open={drawerOpen}
        bicep={build?.bicep ?? null}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          // Give a small UX hint by closing the drawer.
          setDrawerOpen(false);
        }}
      />
    </>
  );
}

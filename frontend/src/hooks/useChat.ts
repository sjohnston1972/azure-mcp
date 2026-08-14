// Chat hook: manages conversation history, streaming state, and
// SSE-driven updates from /api/chat. Also surfaces parsed lifecycle
// markers (topology, bicep) up to the parent so the canvas + bicep
// drawer can read them.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantBlock,
  ChatMessage,
  DisplayMessage,
  Stage,
} from "../lib/types";
import { streamChat } from "../lib/api";
import { sseStream } from "../lib/sse";
import { parseTopology, type Topology } from "../lib/parse-topology";
import { parseBicep } from "../lib/parse-bicep";

let _idCounter = 0;
const nextId = () => `m_${Date.now()}_${++_idCounter}`;

/** Outcome of a single tool's last invocation in a turn:
 *   - "success"    → tool resolved without is_error
 *   - "failed"     → tool resolved with is_error
 *   - "incomplete" → tool_use sent but tool_result never arrived (stream
 *                    died mid-call; Azure may still be processing —
 *                    user should check the portal)
 *   - null         → tool was not called this turn at all
 */
export type ToolStatus = "success" | "failed" | "incomplete" | null;

/** Convenience aggregate kept for back-compat with callers that only
 *  cared about a single yes/no outcome. Computed from deploy/destroy
 *  outcomes — see TurnOutcomeInfo. */
export type TurnOutcome = "success" | "failed" | "incomplete" | "noop";

export type TurnOutcomeInfo = {
  stage: Stage;
  /** Outcome of the LAST deploy_bicep call this turn, if any. */
  deploy: ToolStatus;
  /** Outcome of the LAST destroy_azure call this turn, if any. */
  destroy: ToolStatus;
  userPrompt: string;
};

type Callbacks = {
  onTopology?: (t: Topology) => void;
  onBicep?: (b: string) => void;
  /** Fires when an assistant turn fully completes. */
  onTurnComplete?: (info: TurnOutcomeInfo) => void;
};

function buildPushPrompt(
  projectName: string,
  topologyId: string | null,
  bicep: string | null,
  cloud: "azure" | "aws" = "azure"
): string {
  const requiredTags: Record<string, string> = {
    "mcp-project": projectName,
  };
  if (topologyId) requiredTags["mcp-topology-id"] = topologyId;
  const requiredTagsJson = JSON.stringify(requiredTags);

  // Multi-file convention is the same for both clouds — the marker
  // `// === FILE: <name>.<ext> ===` works for .bicep and .yaml/.json.
  const isMultiFile = bicep ? /^\s*\/\/\s*===\s*FILE\s*:/m.test(bicep) : false;

  if (cloud === "aws") {
    const paramHint = isMultiFile
      ? `\`files\` = the multi-file template below split by the \`// === FILE: <name> ===\` separators (each section becomes one entry in the files map); ` +
        `\`entry\` = the entry-point filename (typically \`main.yaml\`); `
      : `\`template\` = the CloudFormation template below verbatim (do NOT regenerate, rename, simplify, or modify it); `;

    const head =
      `Push the architecture to AWS now. ` +
      `Call the \`deploy_cloudformation\` tool ONCE with these parameters: ` +
      paramHint +
      `\`stack_name\` = a kebab-case name for this stack (e.g. \`mcp-${projectName}-${topologyId ? topologyId.slice(0, 8) : "main"}\`); ` +
      `\`region\` = the region the template targets (default us-east-1); ` +
      `\`capabilities\` = pass exactly the ones the template needs (CAPABILITY_IAM if it creates IAM roles/policies, CAPABILITY_NAMED_IAM if any roles have explicit names, CAPABILITY_AUTO_EXPAND if you used transforms); ` +
      `\`required_tags\` = ${requiredTagsJson} (CloudFormation propagates stack tags to taggable resources — pass them whether or not they're already in the template). ` +
      `After the tool returns, inspect the result. On \`is_error: true\` or non-zero exit, emit \`<topology>\` with affected nodes' status \`failed\`. On success, emit the topology with all nodes \`success\`.`;

    if (!bicep) {
      return (
        head +
        "\n\n(No CloudFormation template was captured from the build. If you previously emitted one in this conversation, use that exact template. Otherwise stop and ask the user.)"
      );
    }
    return head + "\n\n```\n" + bicep + "\n```";
  }

  // Azure path (default).
  const paramHint = isMultiFile
    ? `\`files\` = the multi-file template below split by the \`// === FILE: <name>.bicep ===\` separators (each section becomes one entry in the files map; the first must be \`main.bicep\`); ` +
      `\`entry\` = 'main.bicep' (default); `
    : `\`bicep\` = the template below verbatim (do NOT regenerate, rename, simplify, or modify it); `;

  const head =
    `Push the architecture to Azure now. ` +
    `Call the \`deploy_bicep\` tool ONCE with these parameters: ` +
    paramHint +
    `\`scope\` = 'subscription' if the template starts with \`targetScope = 'subscription'\` else 'resourceGroup' (with \`resource_group_name\` set); ` +
    `\`location\` = 'uksouth' (or the location the template targets); ` +
    `\`required_tags\` = ${requiredTagsJson} (the tool merges these onto every resource — pass them whether or not they're already in the Bicep). ` +
    `After the tool returns, inspect the result. On \`is_error: true\` or non-zero exit, emit \`<topology>\` with affected nodes' status \`failed\`. On success, emit the topology with all nodes \`success\`.`;

  if (!bicep) {
    return (
      head +
      "\n\n(No Bicep was captured from the build. If you previously emitted one in this conversation, use that exact template. Otherwise stop and ask the user for the Bicep.)"
    );
  }
  return head + "\n\n```bicep\n" + bicep + "\n```";
}

function buildTeardownPrompt(
  projectName: string,
  topologyId: string | null,
  cloud: "azure" | "aws" = "azure"
): string {
  if (cloud === "aws") {
    const filter = topologyId
      ? `\`tag_filters\` = \`{ "mcp-project": "${projectName}", "mcp-topology-id": "${topologyId}" }\` (per-topology destroy)`
      : `\`tag_filters\` = \`{ "mcp-project": "${projectName}" }\` (project-wide tear-down)`;
    return (
      `Tear down AWS resources for this project now. Use the \`destroy_aws\` tool with ${filter}. ` +
      `The tool runs \`aws cloudformation delete-stack\` for matching CloudFormation stacks and waits for stack-delete-complete. ` +
      `After the tool returns, emit \`<topology>{"nodes":[],"edges":[]}</topology>\` if it succeeded, or the prior topology with statuses set to \`failed\` if it didn't.`
    );
  }
  const filter = topologyId
    ? `\`tag_filters\` = \`{ "mcp-project": "${projectName}", "mcp-topology-id": "${topologyId}" }\` (per-topology destroy)`
    : `\`tag_filters\` = \`{ "mcp-project": "${projectName}" }\` (project-wide tear-down)`;
  return (
    `Tear down Azure resources for this project now. Use the \`destroy_azure\` tool with ${filter}. ` +
    `It is a two-step call: call it FIRST without \`confirm\` to get the dry-run list of what would be deleted. ` +
    `Check that list — every entry should carry this project's tag. If it does, call the tool AGAIN with the identical arguments plus \`confirm: true\` to perform the deletion. ` +
    `If the dry run shows anything unexpected, or is refused, do NOT confirm — report what it returned and stop. ` +
    `The confirmed run does \`az group delete\` for matching resource groups and \`az resource delete\` for standalone matches, then waits for completion. ` +
    `After the confirmed run returns, emit \`<topology>{"nodes":[],"edges":[]}</topology>\` if it succeeded, or the prior topology with statuses set to \`failed\` if it didn't.`
  );
}

export function useChat(cb: Callbacks = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [display, setDisplay] = useState<DisplayMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Latest callbacks in a ref so we can use them inside `send`
  // without re-binding the function on every callback change.
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  }, [cb]);

  const send = useCallback(
    async (
      text: string,
      projectId: string | null,
      stage: Stage = "build",
      topologyId: string | null = null,
      /** Optional short label shown in the chat instead of `text`. Used
       *  by the StageBar buttons to avoid dumping the full auto-prompt
       *  (Bicep template included) into the visible history. */
      displayText?: string
    ) => {
      if (sending || !text.trim()) return;
      setError(null);

      const userMsg: ChatMessage = { role: "user", content: text };
      const newMessages = [...messages, userMsg];
      setMessages(newMessages);

      const userDisplay: DisplayMessage = {
        kind: "user",
        id: nextId(),
        text: displayText ?? text,
      };
      const assistantId = nextId();
      const assistantDisplay: DisplayMessage = {
        kind: "assistant",
        id: assistantId,
        blocks: [],
        streaming: true,
      };
      setDisplay((d) => [...d, userDisplay, assistantDisplay]);

      setSending(true);
      const ac = new AbortController();
      abortRef.current = ac;

      // Concatenated assistant text — used for marker parsing on each
      // delta so topology/bicep can flow to the canvas/drawer in real time.
      let assistantText = "";
      let topologyEmitted: Topology | null = null;
      let bicepEmitted: string | null = null;
      // Track each tool call this turn. `outcome` is unresolved until
      // the matching tool_result event arrives — if the SSE stream
      // dies before that, the entry stays unresolved and the topology
      // status is NOT flipped (the deployment may still be running on
      // the backend; the user should check Azure rather than have us
      // guess). Once resolved we know success or failure.
      type ToolOutcome =
        | { resolved: false }
        | { resolved: true; isError: boolean };
      // `input` is kept because destroy_azure is a two-step call: the
      // first invocation is a dry run that deletes nothing. Only a call
      // carrying `confirm: true` actually removed anything, so only that
      // one may flip the topology row to "destroyed".
      const toolResults: {
        id: string;
        name: string;
        input: unknown;
        outcome: ToolOutcome;
      }[] = [];

      /** True for a destroy_azure call that actually performed deletions
       *  (as opposed to the dry-run half of the plan-then-confirm flow). */
      const isConfirmedDestroy = (t: { name: string; input: unknown }) =>
        t.name === "destroy_azure" &&
        typeof t.input === "object" &&
        t.input !== null &&
        (t.input as { confirm?: unknown }).confirm === true;

      const updateAssistant = (
        mut: (blocks: AssistantBlock[]) => AssistantBlock[]
      ) => {
        setDisplay((d) =>
          d.map((m) =>
            m.kind === "assistant" && m.id === assistantId
              ? { ...m, blocks: mut(m.blocks) }
              : m
          )
        );
      };

      // Per-turn outcome reporter. Idempotent — called from `done`,
      // from the error event suppress branch, and from the catch
      // block, but only fires once. Without this, a stream that
      // errors AFTER deploy_bicep / destroy_azure has resolved
      // successfully leaves the topology row stuck on its prior
      // status (the resources are live in Azure but the UI never
      // hears about it).
      let outcomeReported = false;
      const reportOutcome = () => {
        if (outcomeReported) return;
        outcomeReported = true;
        const lastDeploy = [...toolResults]
          .reverse()
          .find((tr) => tr.name === "deploy_bicep");
        const lastDestroy = [...toolResults].reverse().find(isConfirmedDestroy);
        const statusFor = (tool: typeof lastDeploy): ToolStatus => {
          if (!tool) return null;
          if (!tool.outcome.resolved) return "incomplete";
          return tool.outcome.isError ? "failed" : "success";
        };
        cbRef.current.onTurnComplete?.({
          stage,
          deploy: statusFor(lastDeploy),
          destroy: statusFor(lastDestroy),
          userPrompt: text,
        });
      };

      try {
        const res = await streamChat(
          newMessages,
          projectId,
          stage,
          topologyId,
          ac.signal
        );
        for await (const evt of sseStream(res)) {
          if (evt.event === "text") {
            const { delta } = JSON.parse(evt.data) as { delta: string };
            assistantText += delta;

            // Parse lifecycle markers as they arrive. Closed markers
            // are reported once each (we track what we've already
            // raised so we don't flood the parent with re-renders).
            const t = parseTopology(assistantText);
            if (t && JSON.stringify(t) !== JSON.stringify(topologyEmitted)) {
              topologyEmitted = t;
              cbRef.current.onTopology?.(t);
            }
            const b = parseBicep(assistantText);
            if (b && b !== bicepEmitted) {
              bicepEmitted = b;
              cbRef.current.onBicep?.(b);
            }

            updateAssistant((blocks) => {
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") {
                return [
                  ...blocks.slice(0, -1),
                  { ...last, text: last.text + delta },
                ];
              }
              return [...blocks, { type: "text", text: delta }];
            });
          } else if (evt.event === "tool_use") {
            const { id, name, input } = JSON.parse(evt.data) as {
              id: string;
              name: string;
              input: unknown;
            };
            // Pre-record at tool_use time. Outcome stays unresolved
            // until the matching tool_result event arrives.
            toolResults.push({ id, name, input, outcome: { resolved: false } });
            updateAssistant((blocks) => [
              ...blocks,
              {
                type: "tool",
                id,
                name,
                input,
                resultPending: true,
                isError: false,
              },
            ]);
          } else if (evt.event === "tool_result") {
            const {
              id,
              is_error,
              content_preview,
            } = JSON.parse(evt.data) as {
              id: string;
              is_error: boolean;
              content_preview?: string;
            };
            const entry = toolResults.find((t) => t.id === id);
            if (entry) {
              entry.outcome = { resolved: true, isError: Boolean(is_error) };
            }
            updateAssistant((blocks) =>
              blocks.map((b) =>
                b.type === "tool" && b.id === id
                  ? {
                      ...b,
                      resultPending: false,
                      isError: Boolean(is_error),
                      resultPreview: content_preview,
                    }
                  : b
              )
            );
          } else if (evt.event === "error") {
            const { message } = JSON.parse(evt.data) as { message: string };
            // What was the last interesting tool's state at the moment
            // the stream died? Three cases:
            //   - resolved-success: pure post-success noise → suppress,
            //     but STILL fire onTurnComplete so the topology row
            //     flips to live/destroyed (otherwise Azure has the
            //     resources but the UI thinks nothing happened).
            //   - resolved-failure: alarming red pill is fine
            //   - unresolved (e.g. tool_use sent but tool_result never
            //     came back): replace the cryptic "Error in input
            //     stream" with a clearer warning so the user knows the
            //     deployment may still be running on Azure's side
            const lastInteresting = [...toolResults]
              .reverse()
              .find((t) => t.name === "deploy_bicep" || isConfirmedDestroy(t));
            if (
              lastInteresting?.outcome.resolved === true &&
              !lastInteresting.outcome.isError
            ) {
              // Suppress the user-facing error — Azure is in the right
              // state, the stream hiccup is noise. But propagate the
              // outcome so the topology row updates.
              reportOutcome();
            } else if (
              lastInteresting &&
              !lastInteresting.outcome.resolved
            ) {
              setError(
                `Stream cut off while ${lastInteresting.name} was running ` +
                  `(${message}). Azure may still be processing the ` +
                  `${lastInteresting.name === "deploy_bicep" ? "deployment" : "deletion"}` +
                  ` — check the Azure portal before retrying. ` +
                  `Topology status left unchanged.`
              );
              // Report so listeners can clear any "in-flight" UI state.
              reportOutcome();
            } else {
              setError(message);
              reportOutcome();
            }
          } else if (evt.event === "done") {
            setDisplay((d) =>
              d.map((m) =>
                m.kind === "assistant" && m.id === assistantId
                  ? { ...m, streaming: false }
                  : m
              )
            );
            reportOutcome();
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setError("cancelled");
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
        }
        setDisplay((d) =>
          d.map((m) =>
            m.kind === "assistant" && m.id === assistantId
              ? { ...m, streaming: false }
              : m
          )
        );
        // Even on a thrown stream error, propagate any tool outcomes
        // that resolved before the error so the UI can settle (clear
        // optimistic in-flight state, flip topology row if applicable).
        reportOutcome();
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [messages, sending]
  );

  /** Send a stage-specific deterministic prompt. Used by the StageBar
   *  buttons so the user doesn't have to type "deploy this now".
   *  topologyId, when set, scopes a teardown to a single topology
   *  instead of project-wide. `bicep` is inlined into the push prompt
   *  so Claude can't drift from the user-approved version (e.g.
   *  reverting a rename done in a later build turn). */
  const sendStaged = useCallback(
    async (
      stage: Stage,
      projectId: string | null,
      projectName: string | null,
      topologyId: string | null = null,
      bicep: string | null = null,
      cloud: "azure" | "aws" = "azure"
    ) => {
      const name = projectName ?? "<project>";
      const prompt =
        stage === "push"
          ? buildPushPrompt(name, topologyId, bicep, cloud)
          : stage === "teardown"
            ? buildTeardownPrompt(name, topologyId, cloud)
            : null;
      if (!prompt) return;
      // Short label for the chat view — full prompt still goes to Claude.
      const cloudName = cloud === "aws" ? "AWS" : "Azure";
      const displayText =
        stage === "push"
          ? `🚀 Push to ${cloudName}`
          : stage === "teardown"
            ? topologyId
              ? `🗑 Destroy this topology`
              : `🗑 Tear down all '${name}' resources`
            : prompt;
      await send(prompt, projectId, stage, topologyId, displayText);
    },
    [send]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setDisplay([]);
    setError(null);
    setSending(false);
  }, []);

  return { display, sending, error, send, sendStaged, cancel, reset };
}

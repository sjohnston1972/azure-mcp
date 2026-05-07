// One Azure resource on the canvas. React Flow custom node.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  ICON_FOR,
  TONE_FOR,
  type AzureNodeStatus,
  type AzureResourceKind,
} from "../../lib/azure-icons";

export type AzureNodeData = {
  label: string;
  sublabel?: string;
  kind: AzureResourceKind;
  status: AzureNodeStatus;
};

const STATUS_CHIP: Record<
  AzureNodeStatus,
  { label: string; cls: string; pulse: boolean }
> = {
  planned: {
    label: "planned",
    cls: "bg-outline-variant/25 text-on-surface-variant",
    pulse: false,
  },
  pending: {
    label: "pending",
    cls: "bg-outline-variant/25 text-on-surface-variant",
    pulse: false,
  },
  deploying: {
    label: "deploying",
    cls: "bg-primary/15 text-primary",
    pulse: true,
  },
  success: {
    label: "deployed",
    cls: "bg-secondary/15 text-secondary",
    pulse: false,
  },
  failed: { label: "failed", cls: "bg-error/15 text-error", pulse: false },
};

export function AzureNode({ data }: NodeProps) {
  const d = data as unknown as AzureNodeData;
  const icon = ICON_FOR[d.kind] ?? ICON_FOR.generic;
  const tone = TONE_FOR[d.kind] ?? TONE_FOR.generic;
  const status = STATUS_CHIP[d.status];

  return (
    <div
      className="rounded-xl bg-surface-container-lowest border border-outline-variant/40 shadow-sm hover:shadow-md transition-shadow"
      style={{ width: 200, minHeight: 84 }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-outline-variant !border-0 !w-2 !h-2"
      />
      <div className="flex items-center gap-3 px-3 py-2">
        <div
          className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${tone}`}
        >
          <span className="material-symbols-outlined text-[20px]">{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate">{d.label}</div>
          {d.sublabel && (
            <div className="text-[10px] text-on-surface-variant truncate">
              {d.sublabel}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
          {d.kind}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${status.cls}`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full bg-current ${status.pulse ? "animate-pulse" : ""}`}
          />
          {status.label}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-outline-variant !border-0 !w-2 !h-2"
      />
    </div>
  );
}

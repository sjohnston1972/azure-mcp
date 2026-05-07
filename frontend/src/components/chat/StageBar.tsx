// Build → View → Push → Tear-down stage bar.
//
// Lives in the chat panel header. Each button reflects the current
// build state and triggers the appropriate next action:
//   - Build:       (always visible) clears the build to start fresh
//   - View Bicep:  enabled when a bicep template has been emitted
//   - Push:        enabled when there's a topology + bicep, NOT pushed
//   - Tear down:   enabled after a successful push

import type { BuildState } from "../../lib/types";

type Props = {
  build: BuildState | null;
  sending: boolean;
  hasProject: boolean;
  onNewBuild: () => void;
  onViewBicep: () => void;
  onPush: () => void;
  onTeardown: () => void;
  onSchedule: () => void;
  onSaveTemplate: () => void;
};

export function StageBar({
  build,
  sending,
  hasProject,
  onNewBuild,
  onViewBicep,
  onPush,
  onTeardown,
  onSchedule,
  onSaveTemplate,
}: Props) {
  const hasTopology = !!build?.topology;
  const hasBicep = !!build?.bicep;
  const pushed = !!build?.pushed;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StageButton
        icon="edit_square"
        label="Build"
        tone="neutral"
        active={!hasTopology}
        disabled={!hasProject || sending}
        onClick={onNewBuild}
        title="Start a new build (clears the canvas + bicep)"
      />
      <StageButton
        icon="description"
        label="View Bicep"
        tone="neutral"
        disabled={!hasBicep}
        onClick={onViewBicep}
        title={hasBicep ? "Open the generated Bicep template" : "Build something first"}
      />
      {!pushed ? (
        <StageButton
          icon="rocket_launch"
          label="Push to Azure"
          tone="primary"
          disabled={!hasTopology || !hasBicep || sending || !hasProject}
          onClick={onPush}
          title="Deploy the architecture above to Azure"
        />
      ) : (
        <StageButton
          icon="delete_sweep"
          label="Tear down"
          tone="danger"
          disabled={sending || !hasProject}
          onClick={onTeardown}
          title={`Delete every Azure resource tagged with this project`}
        />
      )}
      <StageButton
        icon="bookmark_add"
        label="Save template"
        tone="ghost"
        disabled={!hasBicep}
        onClick={onSaveTemplate}
        title="Save the current Bicep as a reusable template"
      />
      <StageButton
        icon="schedule"
        label="Schedule"
        tone="ghost"
        disabled={!hasProject}
        onClick={onSchedule}
        title="Schedule pushes / tear-downs of templates"
      />
    </div>
  );
}

function StageButton({
  icon,
  label,
  tone,
  active,
  disabled,
  onClick,
  title,
}: {
  icon: string;
  label: string;
  tone: "neutral" | "primary" | "danger" | "ghost";
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  const cls = (() => {
    if (disabled)
      return "opacity-40 cursor-not-allowed border border-outline-variant/40";
    if (tone === "primary")
      return "bg-gradient-to-br from-primary to-primary-container text-on-primary shadow-sm hover:brightness-110";
    if (tone === "danger")
      return "bg-error/10 text-error border border-error/30 hover:bg-error/15";
    if (active)
      return "bg-primary/10 text-primary border border-primary/30";
    if (tone === "ghost")
      return "text-on-surface-variant hover:bg-surface-container-high";
    return "border border-outline-variant/40 hover:bg-surface-container-high";
  })();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${cls}`}
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
      {label}
    </button>
  );
}

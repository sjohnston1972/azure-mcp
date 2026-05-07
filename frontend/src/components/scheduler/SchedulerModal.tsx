// Scheduler modal. Lists existing cron schedules for the active
// project, lets the user toggle/delete them, and create new ones
// targeting a saved template.

import { useEffect, useMemo, useState } from "react";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  listTemplates,
  patchSchedule,
} from "../../lib/api";
import type { Project, Schedule, Template } from "../../lib/types";
import { useConfirm } from "../ui/useConfirm";

type Props = {
  open: boolean;
  project: Project | null;
  onClose: () => void;
};

const PRESETS: { label: string; cron: string; hint: string }[] = [
  { label: "Every weekday at 09:00 UTC", cron: "0 9 * * 1-5", hint: "Mon–Fri 09:00" },
  { label: "Every weekday at 18:00 UTC", cron: "0 18 * * 1-5", hint: "Mon–Fri 18:00" },
  { label: "Every Sunday at 02:00 UTC", cron: "0 2 * * 0", hint: "Sun 02:00" },
  { label: "Every hour", cron: "0 * * * *", hint: "Top of the hour" },
  { label: "Every 5 minutes (testing)", cron: "*/5 * * * *", hint: "Use sparingly" },
];

export function SchedulerModal({ open, project, onClose }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  // New-schedule form state
  const [newAction, setNewAction] = useState<"push" | "teardown">("push");
  const [newTemplateId, setNewTemplateId] = useState<string>("");
  const [newCron, setNewCron] = useState<string>("0 9 * * 1-5");

  const refresh = async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const [s, t] = await Promise.all([
        listSchedules(project.id),
        listTemplates(),
      ]);
      setSchedules(s);
      setTemplates(t);
      const first = t[0];
      if (first && !newTemplateId) setNewTemplateId(first.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && project) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  const create = async () => {
    if (!project) return;
    setError(null);
    if (newAction === "push" && !newTemplateId) {
      setError("Select a template to push.");
      return;
    }
    setBusy(true);
    try {
      await createSchedule({
        project_id: project.id,
        template_id: newAction === "push" ? newTemplateId : undefined,
        action: newAction,
        cron: newCron,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: Schedule) => {
    setBusy(true);
    try {
      await patchSchedule(s.id, { enabled: !s.enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Schedule) => {
    const ok = await confirm({
      title: `Delete this ${s.action} schedule?`,
      message: (
        <>
          The cron <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-surface-container-high">{s.cron}</code> will stop firing immediately. Past runs stay in the deployment history.
        </>
      ),
      confirmLabel: "Delete schedule",
      tone: "danger",
      icon: "schedule",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteSchedule(s.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const templatesById = useMemo(() => {
    const m: Record<string, Template> = {};
    for (const t of templates) m[t.id] = t;
    return m;
  }, [templates]);

  if (!open || !project) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] rounded-xl bg-surface-container-lowest shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-outline-variant/30 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold tracking-tight">
              Schedules — {project.name}
            </h2>
            <p className="text-xs text-on-surface-variant">
              Cron-driven push and tear-down. Times are UTC.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface p-1 rounded-md hover:bg-surface-container-high"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {error && (
            <div className="rounded-lg bg-error/5 border border-error/30 p-2 text-xs text-error">
              {error}
            </div>
          )}

          {/* ── Existing schedules ──────────────────────────── */}
          <section>
            <h3 className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant mb-2">
              Active schedules
            </h3>
            {loading ? (
              <p className="text-xs text-on-surface-variant">Loading…</p>
            ) : schedules.length === 0 ? (
              <p className="text-xs text-on-surface-variant">
                No schedules for this project yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {schedules.map((s) => {
                  const tmpl = s.template_id ? templatesById[s.template_id] : null;
                  return (
                    <li
                      key={s.id}
                      className="rounded-lg bg-surface-container-low border border-outline-variant/30 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                s.action === "push"
                                  ? "bg-primary/15 text-primary"
                                  : "bg-error/15 text-error"
                              }`}
                            >
                              {s.action}
                            </span>
                            <code className="font-mono text-xs">{s.cron}</code>
                            {!s.enabled && (
                              <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                                paused
                              </span>
                            )}
                          </div>
                          {s.action === "push" && (
                            <div className="text-xs mt-1">
                              Template:{" "}
                              <span className="font-semibold">
                                {tmpl?.name ?? "(deleted)"}
                              </span>
                            </div>
                          )}
                          {s.last_run_at && (
                            <div className="text-[11px] text-on-surface-variant mt-1">
                              Last run {new Date(s.last_run_at).toLocaleString()} —{" "}
                              <span
                                className={
                                  s.last_run_status === "success"
                                    ? "text-secondary"
                                    : "text-error"
                                }
                              >
                                {s.last_run_status}
                              </span>
                              {s.last_run_error && (
                                <span className="block text-error">
                                  {s.last_run_error}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void toggle(s)}
                            disabled={busy}
                            className="px-2 py-1 rounded-md text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
                          >
                            {s.enabled ? "Pause" : "Resume"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(s)}
                            disabled={busy}
                            className="text-on-surface-variant hover:text-error p-1 rounded-md hover:bg-surface-container-high disabled:opacity-50"
                            title="Delete schedule"
                          >
                            <span className="material-symbols-outlined text-base">
                              delete
                            </span>
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Create new schedule ─────────────────────────── */}
          <section>
            <h3 className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant mb-2">
              New schedule
            </h3>
            <div className="rounded-lg bg-surface-container-low border border-outline-variant/30 p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
                    Action
                  </span>
                  <select
                    value={newAction}
                    onChange={(e) =>
                      setNewAction(e.target.value as "push" | "teardown")
                    }
                    className="mt-1 w-full p-2 rounded-lg bg-surface-container-lowest border border-outline-variant/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="push">Push to Azure</option>
                    <option value="teardown">Tear down</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
                    Template{newAction === "push" ? "" : " (n/a)"}
                  </span>
                  <select
                    value={newTemplateId}
                    onChange={(e) => setNewTemplateId(e.target.value)}
                    disabled={newAction !== "push" || templates.length === 0}
                    className="mt-1 w-full p-2 rounded-lg bg-surface-container-lowest border border-outline-variant/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                  >
                    {templates.length === 0 ? (
                      <option value="">No templates saved yet</option>
                    ) : (
                      templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
                  Cron expression (UTC)
                </span>
                <input
                  type="text"
                  value={newCron}
                  onChange={(e) => setNewCron(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="mt-1 w-full p-2 rounded-lg bg-surface-container-lowest border border-outline-variant/40 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.cron}
                    type="button"
                    onClick={() => setNewCron(p.cron)}
                    title={p.hint}
                    className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                      newCron === p.cron
                        ? "bg-primary/10 text-primary border-primary/30"
                        : "border-outline-variant/40 hover:bg-surface-container-high"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void create()}
                  disabled={
                    busy || (newAction === "push" && !newTemplateId)
                  }
                  className="px-3 py-1.5 rounded-lg bg-gradient-to-br from-primary to-primary-container text-on-primary text-sm font-semibold shadow-sm disabled:opacity-50 hover:brightness-110"
                >
                  {busy ? "Saving…" : "Add schedule"}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// EC2 instance type reference modal. AWS-side counterpart to
// VmSelector — searchable list of curated EC2 types with the
// free-tier eligible one (t3.micro) clearly flagged.
//
// Doesn't deploy anything itself — picking a type here passes the
// canonical id (e.g. "t3.micro") up to the parent so it can drop
// a build-stage chat prompt that pins that size for Claude.

import { useEffect, useMemo, useState } from "react";

type Family =
  | "general-purpose"
  | "burstable"
  | "compute-optimized"
  | "memory-optimized"
  | "storage-optimized"
  | "gpu"
  | "graviton-arm";

type Ec2Type = {
  name: string;
  family: Family;
  family_label: string;
  vcpus: number;
  memory_gib: number;
  architecture: "x86_64" | "arm64";
  network: string;
  free_tier: boolean;
  est_monthly_usd: number;
  notes: string;
};

type ApiResponse = {
  count: number;
  free_tier_note: string;
  types: Ec2Type[];
};

const FAMILY_FILTERS: { value: Family | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "burstable", label: "Burstable (T)" },
  { value: "general-purpose", label: "General (M)" },
  { value: "compute-optimized", label: "Compute (C)" },
  { value: "memory-optimized", label: "Memory (R)" },
  { value: "storage-optimized", label: "Storage (I)" },
  { value: "gpu", label: "GPU (G/P)" },
  { value: "graviton-arm", label: "Graviton (ARM)" },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** When the user picks a type, the parent receives the canonical
   *  name. Typical handler: stash it as a chat-prompt prefill or send
   *  a build turn pinning that size. */
  onPick?: (typeName: string) => void;
};

export function Ec2Selector({ open, onClose, onPick }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Family | "all">("all");
  const [search, setSearch] = useState("");
  const [freeTierOnly, setFreeTierOnly] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch("/api/aws/ec2-types")
      .then((r) => {
        if (!r.ok) throw new Error(`/api/aws/ec2-types → ${r.status}`);
        return r.json() as Promise<ApiResponse>;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.types.filter((t) => {
      if (filter !== "all" && t.family !== filter) return false;
      if (freeTierOnly && !t.free_tier) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !t.name.toLowerCase().includes(q) &&
          !t.notes.toLowerCase().includes(q) &&
          !t.family_label.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [data, filter, search, freeTierOnly]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] rounded-xl bg-surface-container-lowest shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-outline-variant/30 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold tracking-tight">
              AWS EC2 instance types
            </h2>
            <p className="text-xs text-on-surface-variant">
              Curated reference. Prices are indicative (on-demand, Linux,
              us-east-1, 730 hrs/mo) — varies by region.
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

        {data?.free_tier_note && (
          <div className="px-6 py-2 bg-primary/5 border-b border-primary/30 text-[12px] text-on-surface flex items-start gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">
              verified
            </span>
            <span>{data.free_tier_note}</span>
          </div>
        )}

        <div className="px-6 py-3 border-b border-outline-variant/30 flex items-center gap-3 flex-wrap">
          <input
            type="search"
            placeholder="Filter by name, family, or note…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] p-2 rounded-lg bg-surface-container-low border border-outline-variant/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <label className="inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer">
            <input
              type="checkbox"
              checked={freeTierOnly}
              onChange={(e) => setFreeTierOnly(e.target.checked)}
              className="accent-primary"
            />
            Free tier only
          </label>
          <div className="flex flex-wrap gap-1">
            {FAMILY_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                  filter === f.value
                    ? "bg-primary/10 text-primary border-primary/30"
                    : "border-outline-variant/40 hover:bg-surface-container-high"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && (
            <p className="px-6 py-4 text-sm text-on-surface-variant">
              Loading instance types…
            </p>
          )}
          {error && (
            <div className="m-6 rounded-lg bg-error/5 border border-error/30 p-3 text-xs text-error font-mono">
              {error}
            </div>
          )}
          {data && filtered.length === 0 && (
            <p className="px-6 py-4 text-sm text-on-surface-variant">
              No instance types match the current filter.
            </p>
          )}
          {data && filtered.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-surface-container-low sticky top-0 text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
                <tr>
                  <th className="text-left px-6 py-2">Name</th>
                  <th className="text-left px-3 py-2">Family</th>
                  <th className="text-left px-3 py-2">Arch</th>
                  <th className="text-right px-3 py-2">vCPU</th>
                  <th className="text-right px-3 py-2">RAM</th>
                  <th className="text-right px-3 py-2">~ $/mo</th>
                  <th className="text-left px-3 py-2">Notes</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.name}
                    // Free-tier rows get a subtle primary tint —
                    // primary in AWS mode is orange, so the row
                    // highlight matches the rest of the AWS theming.
                    className={`border-t border-outline-variant/20 hover:bg-surface-container-low ${
                      t.free_tier ? "bg-primary/5" : ""
                    }`}
                  >
                    <td className="px-6 py-2 align-top">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs">{t.name}</code>
                        {t.free_tier && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest bg-primary/15 text-primary">
                            <span className="material-symbols-outlined text-[12px]">
                              verified
                            </span>
                            Free tier
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-xs">
                      {t.family_label}
                    </td>
                    <td className="px-3 py-2 align-top text-xs font-mono text-on-surface-variant">
                      {t.architecture}
                    </td>
                    <td className="px-3 py-2 align-top text-right tabular-nums">
                      {t.vcpus}
                    </td>
                    <td className="px-3 py-2 align-top text-right tabular-nums">
                      {t.memory_gib} GiB
                    </td>
                    <td className="px-3 py-2 align-top text-right tabular-nums text-on-surface-variant">
                      ${t.est_monthly_usd.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-on-surface-variant max-w-[320px]">
                      {t.notes}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <button
                        type="button"
                        onClick={() => {
                          onPick?.(t.name);
                          onClose();
                        }}
                        className="px-2 py-1 rounded-md text-[11px] font-bold text-primary border border-primary/30 hover:bg-primary/10 transition-colors whitespace-nowrap"
                      >
                        Use this
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// Curated list of Azure VM SKUs with the data the UI and Claude both
// need to make a sensible pick: family, vCPU/RAM/disk, free-tier
// eligibility, and an indicative monthly USD list price (Pay-As-You-Go,
// Linux, East US, on-demand, 730 hrs/mo).
//
// Indicative prices are not authoritative — they're a rough guide so
// users can see relative cost at a glance. Real pricing varies by
// region and changes; cross-reference azure.microsoft.com/pricing/calculator
// before signing off on production deployments.
//
// Free-tier eligibility:
//   - Only Standard_B1s qualifies for the Azure Free Account 12-month
//     free tier (750 hrs/mo Linux + 750 hrs/mo Windows on NEW accounts).
//   - There is NO perpetual VM free tier — after 12 months B1s reverts
//     to its standard rate.

export type VmFamily =
  | "burstable"
  | "general-purpose"
  | "memory-optimized"
  | "compute-optimized"
  | "gpu"
  | "legacy-basic";

export type VmSku = {
  /** The Azure SKU id used in Bicep / az CLI: `Standard_B1s` etc. */
  name: string;
  family: VmFamily;
  family_label: string;
  vcpus: number;
  /** RAM in GB. */
  memory_gb: number;
  /** Temporary OS disk in GB included with the SKU. 0 means OS disk
   *  is sized separately (most v5+ families). */
  os_disk_gb: number;
  /** Whether this SKU is eligible for Azure's 12-month free tier. */
  free_tier: boolean;
  /** Indicative monthly USD list price (PAYG, Linux, East US, 730 hrs).
   *  Varies by region; use as a ballpark, not a quote. */
  est_monthly_usd: number;
  /** Short description showing the SKU's intended use. */
  notes: string;
};

export const CURATED_VM_SKUS: VmSku[] = [
  // ── Burstable (B-series) — best for low-baseline workloads + free tier
  { name: "Standard_B1ls", family: "burstable", family_label: "Burstable B-series", vcpus: 1, memory_gb: 0.5, os_disk_gb: 4, free_tier: false, est_monthly_usd: 3.8, notes: "Cheapest VM. Linux only. Tiny — only useful for sleeping listeners." },
  { name: "Standard_B1s", family: "burstable", family_label: "Burstable B-series", vcpus: 1, memory_gb: 1, os_disk_gb: 4, free_tier: true, est_monthly_usd: 7.59, notes: "Free-tier eligible (750 hrs/mo for first 12 months on new Azure accounts). Good fit for jump boxes, micro APIs, dev tinkering." },
  { name: "Standard_B1ms", family: "burstable", family_label: "Burstable B-series", vcpus: 1, memory_gb: 2, os_disk_gb: 4, free_tier: false, est_monthly_usd: 15.18, notes: "Same vCPU as B1s, double the RAM. Useful for a small Linux app server." },
  { name: "Standard_B2s", family: "burstable", family_label: "Burstable B-series", vcpus: 2, memory_gb: 4, os_disk_gb: 8, free_tier: false, est_monthly_usd: 30.37, notes: "Most popular small Linux/Windows dev box." },
  { name: "Standard_B2ms", family: "burstable", family_label: "Burstable B-series", vcpus: 2, memory_gb: 8, os_disk_gb: 16, free_tier: false, est_monthly_usd: 60.74, notes: "Comfortable for small Windows desktops or .NET app servers." },
  { name: "Standard_B4ms", family: "burstable", family_label: "Burstable B-series", vcpus: 4, memory_gb: 16, os_disk_gb: 32, free_tier: false, est_monthly_usd: 121.47, notes: "Sweet spot for medium dev/test workloads with bursty CPU." },
  { name: "Standard_B8ms", family: "burstable", family_label: "Burstable B-series", vcpus: 8, memory_gb: 32, os_disk_gb: 64, free_tier: false, est_monthly_usd: 242.94, notes: "Larger burstable for build agents, mid-size apps." },

  // ── General Purpose (Dsv5, latest Intel) ──────────────────────────
  { name: "Standard_D2s_v5", family: "general-purpose", family_label: "General Purpose Dsv5", vcpus: 2, memory_gb: 8, os_disk_gb: 0, free_tier: false, est_monthly_usd: 70.08, notes: "Modern general-purpose. Premium SSD only." },
  { name: "Standard_D4s_v5", family: "general-purpose", family_label: "General Purpose Dsv5", vcpus: 4, memory_gb: 16, os_disk_gb: 0, free_tier: false, est_monthly_usd: 140.16, notes: "Balanced workloads, web apps, app servers." },
  { name: "Standard_D8s_v5", family: "general-purpose", family_label: "General Purpose Dsv5", vcpus: 8, memory_gb: 32, os_disk_gb: 0, free_tier: false, est_monthly_usd: 280.32, notes: "Heavier general workloads." },
  { name: "Standard_D16s_v5", family: "general-purpose", family_label: "General Purpose Dsv5", vcpus: 16, memory_gb: 64, os_disk_gb: 0, free_tier: false, est_monthly_usd: 560.64, notes: "Big general-purpose host." },

  // ── Memory Optimized (Esv5) ───────────────────────────────────────
  { name: "Standard_E2s_v5", family: "memory-optimized", family_label: "Memory Optimized Esv5", vcpus: 2, memory_gb: 16, os_disk_gb: 0, free_tier: false, est_monthly_usd: 92.71, notes: "8 GB/vCPU. Good for SQL, in-memory caches." },
  { name: "Standard_E4s_v5", family: "memory-optimized", family_label: "Memory Optimized Esv5", vcpus: 4, memory_gb: 32, os_disk_gb: 0, free_tier: false, est_monthly_usd: 185.42, notes: "Mid-size memory-heavy workloads." },
  { name: "Standard_E8s_v5", family: "memory-optimized", family_label: "Memory Optimized Esv5", vcpus: 8, memory_gb: 64, os_disk_gb: 0, free_tier: false, est_monthly_usd: 370.84, notes: "Larger DBs, JVM apps with big heaps." },
  { name: "Standard_E16s_v5", family: "memory-optimized", family_label: "Memory Optimized Esv5", vcpus: 16, memory_gb: 128, os_disk_gb: 0, free_tier: false, est_monthly_usd: 741.68, notes: "Heavy memory workloads (Redis, big SQL)." },

  // ── Compute Optimized (Fsv2) ──────────────────────────────────────
  { name: "Standard_F2s_v2", family: "compute-optimized", family_label: "Compute Optimized Fsv2", vcpus: 2, memory_gb: 4, os_disk_gb: 16, free_tier: false, est_monthly_usd: 62.05, notes: "CPU-heavy work like batch processing, build farms." },
  { name: "Standard_F4s_v2", family: "compute-optimized", family_label: "Compute Optimized Fsv2", vcpus: 4, memory_gb: 8, os_disk_gb: 32, free_tier: false, est_monthly_usd: 124.10, notes: "Web servers under sustained load." },
  { name: "Standard_F8s_v2", family: "compute-optimized", family_label: "Compute Optimized Fsv2", vcpus: 8, memory_gb: 16, os_disk_gb: 64, free_tier: false, est_monthly_usd: 248.20, notes: "Encoding, simulation, computation-heavy services." },

  // ── GPU ───────────────────────────────────────────────────────────
  { name: "Standard_NC4as_T4_v3", family: "gpu", family_label: "GPU NCv3 (T4)", vcpus: 4, memory_gb: 28, os_disk_gb: 0, free_tier: false, est_monthly_usd: 525.60, notes: "Nvidia T4 (16 GB). Inference, light training, video." },
  { name: "Standard_NV6ads_A10_v5", family: "gpu", family_label: "GPU NVv5 (A10)", vcpus: 6, memory_gb: 55, os_disk_gb: 0, free_tier: false, est_monthly_usd: 1011.0, notes: "Partial Nvidia A10. Visualisation, light AI." },

  // ── Legacy basic — included for completeness, prefer B-series ────
  { name: "Standard_A2_v2", family: "legacy-basic", family_label: "Legacy Av2", vcpus: 2, memory_gb: 4, os_disk_gb: 20, free_tier: false, est_monthly_usd: 87.60, notes: "Legacy entry-level. Generally prefer B-series (cheaper + more modern)." },
];

export function getFreeTierSkus(): VmSku[] {
  return CURATED_VM_SKUS.filter((s) => s.free_tier);
}

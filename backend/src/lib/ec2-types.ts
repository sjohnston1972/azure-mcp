// Curated list of EC2 instance types with the data the UI and Claude
// both need to make a sensible pick: family, vCPU/RAM/network, free-
// tier eligibility, and an indicative monthly USD list price
// (on-demand, Linux, us-east-1, 730 hrs/mo).
//
// Indicative prices are not authoritative — they're a rough guide so
// users can see relative cost at a glance. Real pricing varies by
// region and changes regularly; cross-reference
// aws.amazon.com/ec2/pricing/on-demand/ before signing off on
// production deployments.
//
// Free-tier eligibility:
//   - t3.micro (or t2.micro if t3 isn't available in the region) is
//     the only free-tier eligible compute. 750 hrs/mo for the first
//     12 months on NEW AWS accounts.
//   - Free-tier is account-level (combined across all regions), not
//     per-instance — running two t3.micros simultaneously burns it
//     down twice as fast.
//   - There is NO perpetual EC2 free tier — after 12 months t3.micro
//     reverts to its standard on-demand rate.

export type Ec2Family =
  | "general-purpose"
  | "burstable"
  | "compute-optimized"
  | "memory-optimized"
  | "storage-optimized"
  | "gpu"
  | "graviton-arm";

export type Ec2Type = {
  /** The instance type id used in CloudFormation / aws CLI: `t3.micro`. */
  name: string;
  family: Ec2Family;
  family_label: string;
  vcpus: number;
  /** RAM in GiB. */
  memory_gib: number;
  /** Architecture — useful for AMI selection. */
  architecture: "x86_64" | "arm64";
  /** Network performance label as AWS publishes it. */
  network: string;
  /** Whether this type is eligible for AWS's 12-month free tier. */
  free_tier: boolean;
  /** Indicative monthly USD on-demand price (Linux, us-east-1, 730 hrs).
   *  Varies by region; use as a ballpark, not a quote. */
  est_monthly_usd: number;
  /** Short description showing the type's intended use. */
  notes: string;
};

export const CURATED_EC2_TYPES: Ec2Type[] = [
  // ── Burstable (T-series) — best for low-baseline workloads + free tier
  {
    name: "t3.nano",
    family: "burstable",
    family_label: "Burstable T-series",
    vcpus: 2,
    memory_gib: 0.5,
    architecture: "x86_64",
    network: "Up to 5 Gbps",
    free_tier: false,
    est_monthly_usd: 3.8,
    notes: "Cheapest T-series. Great for tiny listeners, NAT instances, jump boxes.",
  },
  {
    name: "t3.micro",
    family: "burstable",
    family_label: "Burstable T-series",
    vcpus: 2,
    memory_gib: 1,
    architecture: "x86_64",
    network: "Up to 5 Gbps",
    free_tier: true,
    est_monthly_usd: 7.49,
    notes:
      "Free-tier eligible (750 hrs/mo for first 12 months on new AWS accounts). Good fit for personal sites, dev sandboxes, small APIs.",
  },
  {
    name: "t3.small",
    family: "burstable",
    family_label: "Burstable T-series",
    vcpus: 2,
    memory_gib: 2,
    architecture: "x86_64",
    network: "Up to 5 Gbps",
    free_tier: false,
    est_monthly_usd: 15.0,
    notes: "Step up from t3.micro — same vCPU but double the RAM.",
  },
  {
    name: "t3.medium",
    family: "burstable",
    family_label: "Burstable T-series",
    vcpus: 2,
    memory_gib: 4,
    architecture: "x86_64",
    network: "Up to 5 Gbps",
    free_tier: false,
    est_monthly_usd: 30.0,
    notes: "Most popular small dev/staging box. Comfortable for a lab Linux VM.",
  },
  {
    name: "t3.large",
    family: "burstable",
    family_label: "Burstable T-series",
    vcpus: 2,
    memory_gib: 8,
    architecture: "x86_64",
    network: "Up to 5 Gbps",
    free_tier: false,
    est_monthly_usd: 60.0,
    notes: "Doubled RAM for memory-hungry small services.",
  },

  // ── Graviton (T4g) — ARM, ~20% cheaper, free-tier on t4g.small until further notice
  {
    name: "t4g.micro",
    family: "graviton-arm",
    family_label: "Graviton T4g (ARM)",
    vcpus: 2,
    memory_gib: 1,
    architecture: "arm64",
    network: "Up to 5 Gbps",
    free_tier: false,
    est_monthly_usd: 6.0,
    notes:
      "ARM equivalent of t3.micro — slightly cheaper, but most container images need to be multi-arch or arm64. AMIs: amzn2-ami-hvm-arm64.",
  },
  {
    name: "t4g.small",
    family: "graviton-arm",
    family_label: "Graviton T4g (ARM)",
    vcpus: 2,
    memory_gib: 2,
    architecture: "arm64",
    network: "Up to 5 Gbps",
    free_tier: false,
    est_monthly_usd: 12.0,
    notes:
      "AWS extended a free-tier-style promotional rate on t4g.small for new accounts in many regions — verify in your billing console before relying on it.",
  },

  // ── General purpose (M-series)
  {
    name: "m5.large",
    family: "general-purpose",
    family_label: "General-purpose M5",
    vcpus: 2,
    memory_gib: 8,
    architecture: "x86_64",
    network: "Up to 10 Gbps",
    free_tier: false,
    est_monthly_usd: 70.0,
    notes:
      "Workhorse general-purpose for steady-state workloads. No CPU credits — predictable performance.",
  },
  {
    name: "m5.xlarge",
    family: "general-purpose",
    family_label: "General-purpose M5",
    vcpus: 4,
    memory_gib: 16,
    architecture: "x86_64",
    network: "Up to 10 Gbps",
    free_tier: false,
    est_monthly_usd: 140.0,
    notes: "App servers, small databases, Kubernetes worker nodes.",
  },
  {
    name: "m6i.large",
    family: "general-purpose",
    family_label: "General-purpose M6i (Intel)",
    vcpus: 2,
    memory_gib: 8,
    architecture: "x86_64",
    network: "Up to 12.5 Gbps",
    free_tier: false,
    est_monthly_usd: 70.0,
    notes:
      "Newer Intel Ice Lake — same price as m5.large, ~15% better perf. Default M-class for new designs in supported regions.",
  },
  {
    name: "m7g.large",
    family: "graviton-arm",
    family_label: "Graviton M7g (ARM)",
    vcpus: 2,
    memory_gib: 8,
    architecture: "arm64",
    network: "Up to 12.5 Gbps",
    free_tier: false,
    est_monthly_usd: 56.0,
    notes:
      "Graviton3 — ARM-native, ~20% cheaper than m6i.large with comparable performance for compatible workloads.",
  },

  // ── Compute-optimized (C-series)
  {
    name: "c6i.large",
    family: "compute-optimized",
    family_label: "Compute-optimized C6i",
    vcpus: 2,
    memory_gib: 4,
    architecture: "x86_64",
    network: "Up to 12.5 Gbps",
    free_tier: false,
    est_monthly_usd: 62.0,
    notes:
      "CPU-bound workloads at a lower per-vCPU cost than M-class. HPC, batch processing, transcoding.",
  },
  {
    name: "c6i.xlarge",
    family: "compute-optimized",
    family_label: "Compute-optimized C6i",
    vcpus: 4,
    memory_gib: 8,
    architecture: "x86_64",
    network: "Up to 12.5 Gbps",
    free_tier: false,
    est_monthly_usd: 124.0,
    notes: "More cores at the same memory/CPU ratio.",
  },

  // ── Memory-optimized (R-series)
  {
    name: "r6i.large",
    family: "memory-optimized",
    family_label: "Memory-optimized R6i",
    vcpus: 2,
    memory_gib: 16,
    architecture: "x86_64",
    network: "Up to 12.5 Gbps",
    free_tier: false,
    est_monthly_usd: 92.0,
    notes:
      "RAM-heavy workloads: in-memory databases (Redis), caches, real-time analytics.",
  },
  {
    name: "r6i.xlarge",
    family: "memory-optimized",
    family_label: "Memory-optimized R6i",
    vcpus: 4,
    memory_gib: 32,
    architecture: "x86_64",
    network: "Up to 12.5 Gbps",
    free_tier: false,
    est_monthly_usd: 184.0,
    notes: "Bigger working sets for in-memory DBs and cache fleets.",
  },

  // ── Storage-optimized (I-series) — high IOPS local NVMe
  {
    name: "i3.large",
    family: "storage-optimized",
    family_label: "Storage-optimized I3",
    vcpus: 2,
    memory_gib: 15.25,
    architecture: "x86_64",
    network: "Up to 10 Gbps",
    free_tier: false,
    est_monthly_usd: 113.0,
    notes:
      "475 GB local NVMe SSD. Time-series DBs, search, transactional workloads needing low-latency local storage.",
  },

  // ── GPU (G/P-series) — for ML/training/inference
  {
    name: "g5.xlarge",
    family: "gpu",
    family_label: "GPU G5 (NVIDIA A10G)",
    vcpus: 4,
    memory_gib: 16,
    architecture: "x86_64",
    network: "Up to 10 Gbps",
    free_tier: false,
    est_monthly_usd: 730.0,
    notes:
      "Single A10G GPU. Inference, fine-tuning small models, graphics workloads. Quota-restricted on new accounts — request before deploying.",
  },
  {
    name: "p4d.24xlarge",
    family: "gpu",
    family_label: "GPU P4d (NVIDIA A100)",
    vcpus: 96,
    memory_gib: 1152,
    architecture: "x86_64",
    network: "400 Gbps",
    free_tier: false,
    est_monthly_usd: 24000.0,
    notes:
      "8x A100 GPUs — model training. Listed for reference; on-demand pricing is brutal, use Spot or Capacity Reservations.",
  },
];

// Mapping from coarse Azure resource categories to Material Symbols
// names. We deliberately do NOT bundle the official Microsoft Azure
// icon set in v1 (CLAUDE.md §4.2 — link from a CDN, don't bundle), and
// the official icons require auth/licensing for hotlinking. Instead we
// use Google Material Symbols (already loaded for UI chrome) — visually
// netbud-sibling, and shippable today. Switch to official Azure icons
// in a polish pass once we settle on a CDN.

export type AzureNodeStatus =
  | "planned"
  | "pending"
  | "deploying"
  | "success"
  | "failed"
  // Set on every node after a per-topology destroy completes — keeps
  // the resource visible on the canvas (so the user can see what was
  // there) but visually marks it as gone.
  | "destroyed";

export type AzureResourceKind =
  | "resource-group"
  | "vnet"
  | "subnet"
  | "nsg"
  | "public-ip"
  | "load-balancer"
  | "firewall"
  | "vm"
  | "vm-scale-set"
  | "app-service"
  | "container-app"
  | "aks"
  | "function-app"
  | "storage"
  | "sql"
  | "cosmos"
  | "key-vault"
  | "managed-identity"
  | "rbac"
  | "openai"
  | "ai-foundry"
  | "cognitive"
  | "log-analytics"
  | "app-insights"
  | "private-endpoint"
  | "generic";

export const ICON_FOR: Record<AzureResourceKind, string> = {
  "resource-group": "folder_managed",
  vnet: "lan",
  subnet: "subdirectory_arrow_right",
  nsg: "shield",
  "public-ip": "public",
  "load-balancer": "swap_horiz",
  firewall: "local_fire_department",
  vm: "memory",
  "vm-scale-set": "view_module",
  "app-service": "web",
  "container-app": "deployed_code",
  aks: "hub",
  "function-app": "bolt",
  storage: "database",
  sql: "table_view",
  cosmos: "scatter_plot",
  "key-vault": "key_vertical",
  "managed-identity": "badge",
  rbac: "verified_user",
  openai: "psychology",
  "ai-foundry": "neurology",
  cognitive: "smart_toy",
  "log-analytics": "monitoring",
  "app-insights": "analytics",
  "private-endpoint": "vpn_lock",
  generic: "deployed_code",
};

// Tone class for the icon halo on each node — keeps related families
// visually grouped without needing the full Azure colour spec.
export const TONE_FOR: Record<AzureResourceKind, string> = {
  "resource-group": "bg-tertiary/15 text-tertiary",
  vnet: "bg-primary/15 text-primary",
  subnet: "bg-primary/10 text-primary",
  nsg: "bg-primary/10 text-primary",
  "public-ip": "bg-primary/10 text-primary",
  "load-balancer": "bg-primary/10 text-primary",
  firewall: "bg-error/10 text-error",
  vm: "bg-primary/10 text-primary",
  "vm-scale-set": "bg-primary/10 text-primary",
  "app-service": "bg-primary/10 text-primary",
  "container-app": "bg-primary/10 text-primary",
  aks: "bg-primary/10 text-primary",
  "function-app": "bg-primary/10 text-primary",
  storage: "bg-secondary/15 text-secondary",
  sql: "bg-secondary/15 text-secondary",
  cosmos: "bg-secondary/15 text-secondary",
  "key-vault": "bg-error/10 text-error",
  "managed-identity": "bg-error/10 text-error",
  rbac: "bg-error/10 text-error",
  openai: "bg-tertiary/15 text-tertiary",
  "ai-foundry": "bg-tertiary/15 text-tertiary",
  cognitive: "bg-tertiary/15 text-tertiary",
  "log-analytics": "bg-tertiary/15 text-tertiary",
  "app-insights": "bg-tertiary/15 text-tertiary",
  "private-endpoint": "bg-error/10 text-error",
  generic: "bg-outline-variant/30 text-on-surface-variant",
};

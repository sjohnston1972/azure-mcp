// Mapping from coarse cloud resource categories to Material Symbols
// names. Despite the file name, this is now a MULTI-CLOUD map — both
// Azure and AWS resource kinds live in here so the canvas + topology
// JSON parser only need to know about a single union type. We
// deliberately do NOT bundle the official Microsoft Azure or AWS
// icon sets (CLAUDE.md §4.2 — link from a CDN, don't bundle); both
// require auth/licensing for hotlinking. Instead we use Google
// Material Symbols (already loaded for UI chrome) — visually
// netbud-sibling, and shippable today.

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

// Azure resource kinds. Kept as-is for backward compat; new code
// should refer to CloudResourceKind which unions these with the
// AWS set below.
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

// AWS resource kinds. Mirrors the rough categories Steven asks Claude
// to design (see SYSTEM_PROMPT_AWS topology marker rules).
export type AwsResourceKind =
  | "vpc"
  | "security-group"
  | "route-table"
  | "internet-gateway"
  | "nat-gateway"
  | "vpc-endpoint"
  | "ec2"
  | "auto-scaling-group"
  | "launch-template"
  | "ecs-cluster"
  | "ecs-service"
  | "ecs-task"
  | "fargate-task"
  | "eks-cluster"
  | "lambda"
  | "api-gateway"
  | "s3"
  | "rds"
  | "dynamodb"
  | "elasticache"
  | "iam-role"
  | "iam-policy"
  | "kms-key"
  | "secrets-manager"
  | "cloudwatch"
  | "log-group"
  | "bedrock"
  | "sagemaker"
  | "step-functions"
  | "sns"
  | "sqs";

/** Union of every kind the canvas can render. The `subnet`,
 *  `load-balancer`, and `generic` kinds live in AzureResourceKind
 *  but are equally valid for AWS — we share them. */
export type CloudResourceKind = AzureResourceKind | AwsResourceKind;

export const ICON_FOR: Record<CloudResourceKind, string> = {
  // ── Azure ──
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
  // ── AWS ──
  vpc: "lan",
  "security-group": "shield",
  "route-table": "alt_route",
  "internet-gateway": "public",
  "nat-gateway": "settings_ethernet",
  "vpc-endpoint": "vpn_lock",
  ec2: "memory",
  "auto-scaling-group": "view_module",
  "launch-template": "history_edu",
  "ecs-cluster": "hub",
  "ecs-service": "deployed_code",
  "ecs-task": "deployed_code",
  "fargate-task": "deployed_code",
  "eks-cluster": "hub",
  lambda: "bolt",
  "api-gateway": "api",
  s3: "database",
  rds: "table_view",
  dynamodb: "scatter_plot",
  elasticache: "memory_alt",
  "iam-role": "verified_user",
  "iam-policy": "policy",
  "kms-key": "key_vertical",
  "secrets-manager": "lock",
  cloudwatch: "monitoring",
  "log-group": "list_alt",
  bedrock: "neurology",
  sagemaker: "psychology",
  "step-functions": "schema",
  sns: "campaign",
  sqs: "queue",
};

// Tone class for the icon halo on each node — keeps related families
// visually grouped without needing each cloud's full colour spec.
export const TONE_FOR: Record<CloudResourceKind, string> = {
  // ── Azure ──
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
  // ── AWS — same family colour scheme so the canvas reads
  //         consistently regardless of which cloud the user is on. ──
  vpc: "bg-primary/15 text-primary",
  "security-group": "bg-primary/10 text-primary",
  "route-table": "bg-primary/10 text-primary",
  "internet-gateway": "bg-primary/10 text-primary",
  "nat-gateway": "bg-primary/10 text-primary",
  "vpc-endpoint": "bg-error/10 text-error",
  ec2: "bg-primary/10 text-primary",
  "auto-scaling-group": "bg-primary/10 text-primary",
  "launch-template": "bg-primary/10 text-primary",
  "ecs-cluster": "bg-primary/10 text-primary",
  "ecs-service": "bg-primary/10 text-primary",
  "ecs-task": "bg-primary/10 text-primary",
  "fargate-task": "bg-primary/10 text-primary",
  "eks-cluster": "bg-primary/10 text-primary",
  lambda: "bg-primary/10 text-primary",
  "api-gateway": "bg-primary/10 text-primary",
  s3: "bg-secondary/15 text-secondary",
  rds: "bg-secondary/15 text-secondary",
  dynamodb: "bg-secondary/15 text-secondary",
  elasticache: "bg-secondary/15 text-secondary",
  "iam-role": "bg-error/10 text-error",
  "iam-policy": "bg-error/10 text-error",
  "kms-key": "bg-error/10 text-error",
  "secrets-manager": "bg-error/10 text-error",
  cloudwatch: "bg-tertiary/15 text-tertiary",
  "log-group": "bg-tertiary/15 text-tertiary",
  bedrock: "bg-tertiary/15 text-tertiary",
  sagemaker: "bg-tertiary/15 text-tertiary",
  "step-functions": "bg-primary/10 text-primary",
  sns: "bg-primary/10 text-primary",
  sqs: "bg-primary/10 text-primary",
};

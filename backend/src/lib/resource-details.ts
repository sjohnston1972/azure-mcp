// Live resource detail fetcher.
//
// Click on a node on the canvas → frontend asks /api/topologies/:id/
// details/:nodeId → this module:
//   1. resolves the topology row + the node label
//   2. queries Azure (or AWS — TODO next round) for the resource
//      with matching tag mcp-topology-id=<topo-uuid> and name=<label>
//   3. dispatches to a kind-specific fetcher to pull rich details
//      (IPs, NICs, SKU, status, etc.)
//   4. returns a normalised JSON shape the frontend can render
//
// All in-memory cached for 30s per resource so re-clicks are instant.
//
// Auth comes from the same env vars the deploy tools use:
// AZURE_CLIENT_ID/SECRET/TENANT/SUBSCRIPTION_ID via the azure-cli
// sidecar (no separate Azure SDK dependency).

import { spawn } from "node:child_process";
import { config } from "../config.js";

const AZURE_CLI_IMAGE =
  process.env.AZURE_CLI_IMAGE ?? "mcr.microsoft.com/azure-cli:latest";

// 30s cache TTL keeps re-clicks instant without showing stale state
// after a meaningful change. Tuned for the homelab use case where
// the user is reviewing a fresh deploy.
const CACHE_TTL_MS = 30_000;

/** Normalised detail shape returned to the frontend. The kind-specific
 *  payload lives in `props` so the modal can render whichever fields
 *  apply to that resource type without us having to model every field
 *  on every kind in TypeScript. */
export type ResourceDetails = {
  cloud: "azure" | "aws";
  /** Top-line summary (always present). */
  name: string;
  kind: string;
  resource_type: string;
  location: string;
  resource_group?: string;
  /** Provisioning / power state — green if "Running", grey if stopped, etc. */
  state?: string;
  /** Tags currently on the resource (we surface mcp-* prominently). */
  tags?: Record<string, string>;
  /** Primary URL into the cloud console — opens in a new tab. */
  console_url?: string;
  /** Kind-specific structured payload — frontend pattern-matches on
   *  it to render the right fields. See the per-kind fetchers below
   *  for what each kind's `props` contains. */
  props: Record<string, unknown>;
  /** Raw response from `az resource show` etc., for the "Raw" tab in
   *  the modal. Useful for debugging when a field is unexpectedly
   *  missing from props. */
  raw?: unknown;
};

type CacheEntry = { at: number; data: ResourceDetails | null };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): ResourceDetails | null | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return e.data;
}

function cacheSet(key: string, data: ResourceDetails | null): void {
  cache.set(key, { at: Date.now(), data });
}

/** Run an `az` command inside the standard azure-cli sidecar with
 *  service-principal creds. Returns parsed JSON or null on failure. */
async function azCli<T = unknown>(args: string[]): Promise<T | null> {
  const shellScript = [
    "set -e",
    "az login --service-principal -u $AZURE_CLIENT_ID -p $AZURE_CLIENT_SECRET --tenant $AZURE_TENANT_ID --output none",
    "az account set --subscription $AZURE_SUBSCRIPTION_ID",
    `az ${args.map((a) => (a.includes(" ") ? `'${a}'` : a)).join(" ")} --output json`,
  ].join("\n");

  const dockerArgs = [
    "run",
    "--rm",
    "-e",
    `AZURE_TENANT_ID=${config.AZURE_TENANT_ID}`,
    "-e",
    `AZURE_CLIENT_ID=${config.AZURE_CLIENT_ID}`,
    "-e",
    `AZURE_CLIENT_SECRET=${config.AZURE_CLIENT_SECRET}`,
    "-e",
    `AZURE_SUBSCRIPTION_ID=${config.AZURE_SUBSCRIPTION_ID}`,
    AZURE_CLI_IMAGE,
    "sh",
    "-c",
    shellScript,
  ];

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 60_000);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.on("error", () => resolve({ code: -1, stdout, stderr }));
    }
  );

  if (result.code !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[resource-details] az command failed (${args.join(" ")}): ${result.stderr.slice(0, 300)}`
    );
    return null;
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

/** Build the Azure portal URL for a resource id. Direct link into the
 *  resource overview blade — most useful single click for an architect. */
function azurePortalUrl(resourceId: string): string {
  return `https://portal.azure.com/#@/resource${resourceId}/overview`;
}

/** Resolve a topology node to a live Azure resource by tag + name.
 *  Returns the resource's full id, or null if no match. */
async function findAzureResource(
  topologyId: string,
  nodeLabel: string
): Promise<{ id: string; type: string; location: string; resourceGroup: string } | null> {
  // Tag query needs to match BOTH the topology id AND the resource
  // name. Single `az resource list --tag` filters by ONE tag pair,
  // so we list by topology id then filter the result client-side.
  type Row = {
    id: string;
    name: string;
    type: string;
    location: string;
    resourceGroup: string;
  };
  const rows = await azCli<Row[]>([
    "resource",
    "list",
    "--tag",
    `mcp-topology-id=${topologyId}`,
    "--query",
    "[].{id:id, name:name, type:type, location:location, resourceGroup:resourceGroup}",
  ]);
  if (!rows || rows.length === 0) return null;
  // Exact name match first; fall back to "name endsWith label" for
  // child resources whose tag-search returns the parent name (rare).
  const exact = rows.find((r) => r.name === nodeLabel);
  if (exact) return exact;
  const fuzzy = rows.find((r) => r.name.endsWith(`-${nodeLabel}`) || r.name === `vm-${nodeLabel}`);
  return fuzzy ?? null;
}

// ── Per-kind Azure fetchers ─────────────────────────────────────

async function fetchAzureVm(resourceId: string): Promise<ResourceDetails | null> {
  // -d gives us the instanceView (power state, OS info), and we
  // grab the NIC + IP details via a separate query. The vm show
  // call is the slow one (~1-2s); rest of the lookups happen in
  // parallel inside the same sidecar via `az graph` would be
  // faster but adds a dependency, so we do sequential az calls.
  const vm = await azCli<Record<string, unknown> & {
    name: string;
    location: string;
    resourceGroup: string;
    hardwareProfile?: { vmSize?: string };
    storageProfile?: {
      imageReference?: { publisher?: string; offer?: string; sku?: string };
      osDisk?: { osType?: string; diskSizeGB?: number; managedDisk?: { storageAccountType?: string } };
      dataDisks?: Array<{ name: string; diskSizeGB: number }>;
    };
    networkProfile?: { networkInterfaces?: Array<{ id: string }> };
    powerState?: string;
    instanceView?: {
      statuses?: Array<{ code: string; displayStatus?: string }>;
    };
    tags?: Record<string, string>;
  }>(["vm", "show", "--ids", resourceId, "-d"]);
  if (!vm) return null;

  const power =
    vm.powerState ??
    vm.instanceView?.statuses?.find((s) => s.code?.startsWith("PowerState/"))?.displayStatus ??
    "unknown";

  // Pull NIC details in parallel — per-NIC IP info isn't on the VM.
  const nicIds = (vm.networkProfile?.networkInterfaces ?? []).map((n) => n.id);
  const nics = await Promise.all(
    nicIds.map(async (id) => {
      type NicRow = {
        name: string;
        ipConfigurations?: Array<{
          privateIPAddress?: string;
          privateIPAllocationMethod?: string;
          publicIPAddress?: { id?: string };
          subnet?: { id?: string };
        }>;
        macAddress?: string;
        enableAcceleratedNetworking?: boolean;
        networkSecurityGroup?: { id?: string };
      };
      const nic = await azCli<NicRow>(["network", "nic", "show", "--ids", id]);
      if (!nic) return null;
      // Resolve any public IP addresses associated with the NIC.
      const publicIpIds = (nic.ipConfigurations ?? [])
        .map((c) => c.publicIPAddress?.id)
        .filter((x): x is string => !!x);
      const publicIps = await Promise.all(
        publicIpIds.map(async (pid) => {
          const pip = await azCli<{ ipAddress?: string; publicIPAllocationMethod?: string }>(
            ["network", "public-ip", "show", "--ids", pid]
          );
          return pip;
        })
      );
      return {
        name: nic.name,
        macAddress: nic.macAddress,
        acceleratedNetworking: nic.enableAcceleratedNetworking,
        nsg: nic.networkSecurityGroup?.id?.split("/").pop(),
        privateIPs: (nic.ipConfigurations ?? []).map((c) => ({
          address: c.privateIPAddress,
          allocation: c.privateIPAllocationMethod,
          subnet: c.subnet?.id?.split("/").pop(),
        })),
        publicIPs: publicIps
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({ address: p.ipAddress, allocation: p.publicIPAllocationMethod })),
      };
    })
  );

  return {
    cloud: "azure",
    name: vm.name,
    kind: "vm",
    resource_type: "Microsoft.Compute/virtualMachines",
    location: vm.location,
    resource_group: vm.resourceGroup,
    state: power,
    tags: vm.tags,
    console_url: azurePortalUrl(resourceId),
    props: {
      vmSize: vm.hardwareProfile?.vmSize,
      osType: vm.storageProfile?.osDisk?.osType,
      image: vm.storageProfile?.imageReference
        ? `${vm.storageProfile.imageReference.publisher}/${vm.storageProfile.imageReference.offer}/${vm.storageProfile.imageReference.sku}`
        : undefined,
      osDisk: vm.storageProfile?.osDisk
        ? {
            sizeGB: vm.storageProfile.osDisk.diskSizeGB,
            sku: vm.storageProfile.osDisk.managedDisk?.storageAccountType,
          }
        : undefined,
      dataDisks: vm.storageProfile?.dataDisks ?? [],
      nics: nics.filter((n) => n !== null),
    },
    raw: vm,
  };
}

async function fetchAzureBastion(resourceId: string): Promise<ResourceDetails | null> {
  type BastionRow = {
    name: string;
    location: string;
    resourceGroup: string;
    sku?: { name?: string };
    scaleUnits?: number;
    dnsName?: string;
    provisioningState?: string;
    ipConfigurations?: Array<{
      name: string;
      subnet?: { id?: string };
      publicIPAddress?: { id?: string };
    }>;
    tags?: Record<string, string>;
  };
  const b = await azCli<BastionRow>(["network", "bastion", "show", "--ids", resourceId]);
  if (!b) return null;

  // Pull public-IP addresses in parallel.
  const pipIds = (b.ipConfigurations ?? [])
    .map((c) => c.publicIPAddress?.id)
    .filter((x): x is string => !!x);
  const pips = await Promise.all(
    pipIds.map((id) => azCli<{ ipAddress?: string; sku?: { name?: string } }>(["network", "public-ip", "show", "--ids", id]))
  );

  return {
    cloud: "azure",
    name: b.name,
    kind: "bastion",
    resource_type: "Microsoft.Network/bastionHosts",
    location: b.location,
    resource_group: b.resourceGroup,
    state: b.provisioningState,
    tags: b.tags,
    console_url: azurePortalUrl(resourceId),
    props: {
      sku: b.sku?.name,
      scaleUnits: b.scaleUnits,
      dnsName: b.dnsName,
      ipConfigurations: (b.ipConfigurations ?? []).map((c, i) => ({
        name: c.name,
        subnet: c.subnet?.id?.split("/").pop(),
        publicIp: pips[i]?.ipAddress,
        publicIpSku: pips[i]?.sku?.name,
      })),
    },
    raw: b,
  };
}

async function fetchAzureStorage(resourceId: string): Promise<ResourceDetails | null> {
  type Row = {
    name: string;
    location: string;
    resourceGroup: string;
    sku?: { name?: string; tier?: string };
    kind?: string;
    accessTier?: string;
    primaryEndpoints?: Record<string, string>;
    enableHttpsTrafficOnly?: boolean;
    minimumTlsVersion?: string;
    allowBlobPublicAccess?: boolean;
    provisioningState?: string;
    tags?: Record<string, string>;
  };
  const s = await azCli<Row>(["storage", "account", "show", "--ids", resourceId]);
  if (!s) return null;

  return {
    cloud: "azure",
    name: s.name,
    kind: "storage",
    resource_type: "Microsoft.Storage/storageAccounts",
    location: s.location,
    resource_group: s.resourceGroup,
    state: s.provisioningState,
    tags: s.tags,
    console_url: azurePortalUrl(resourceId),
    props: {
      sku: s.sku?.name,
      tier: s.sku?.tier,
      kind: s.kind,
      accessTier: s.accessTier,
      httpsOnly: s.enableHttpsTrafficOnly,
      minTls: s.minimumTlsVersion,
      blobPublicAccess: s.allowBlobPublicAccess,
      endpoints: s.primaryEndpoints ?? {},
    },
    raw: s,
  };
}

async function fetchAzureVNet(resourceId: string): Promise<ResourceDetails | null> {
  type Row = {
    name: string;
    location: string;
    resourceGroup: string;
    addressSpace?: { addressPrefixes?: string[] };
    dhcpOptions?: { dnsServers?: string[] };
    subnets?: Array<{
      name: string;
      addressPrefix?: string;
      addressPrefixes?: string[];
      networkSecurityGroup?: { id?: string };
      routeTable?: { id?: string };
    }>;
    virtualNetworkPeerings?: Array<{
      name: string;
      remoteVirtualNetwork?: { id?: string };
      peeringState?: string;
      allowForwardedTraffic?: boolean;
      allowGatewayTransit?: boolean;
      useRemoteGateways?: boolean;
    }>;
    provisioningState?: string;
    tags?: Record<string, string>;
  };
  const v = await azCli<Row>(["network", "vnet", "show", "--ids", resourceId]);
  if (!v) return null;
  return {
    cloud: "azure",
    name: v.name,
    kind: "vnet",
    resource_type: "Microsoft.Network/virtualNetworks",
    location: v.location,
    resource_group: v.resourceGroup,
    state: v.provisioningState,
    tags: v.tags,
    console_url: azurePortalUrl(resourceId),
    props: {
      addressSpace: v.addressSpace?.addressPrefixes ?? [],
      dnsServers: v.dhcpOptions?.dnsServers ?? [],
      subnets: (v.subnets ?? []).map((s) => ({
        name: s.name,
        addressPrefix: s.addressPrefix ?? (s.addressPrefixes ?? []).join(", "),
        nsg: s.networkSecurityGroup?.id?.split("/").pop(),
        routeTable: s.routeTable?.id?.split("/").pop(),
      })),
      peerings: (v.virtualNetworkPeerings ?? []).map((p) => ({
        name: p.name,
        remote: p.remoteVirtualNetwork?.id?.split("/").pop(),
        state: p.peeringState,
        allowForwardedTraffic: p.allowForwardedTraffic,
        allowGatewayTransit: p.allowGatewayTransit,
        useRemoteGateways: p.useRemoteGateways,
      })),
    },
    raw: v,
  };
}

/** Subnet fetcher. Subnets are child resources, not directly visible
 *  via `az resource list --tag`. We find the parent VNet via the
 *  topology tag, then `az network vnet subnet show`. */
async function fetchAzureSubnet(
  vnetId: string,
  subnetName: string
): Promise<ResourceDetails | null> {
  // Parse the VNet's RG + name from its resource id.
  const m = vnetId.match(
    /\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/virtualNetworks\/([^/]+)/i
  );
  if (!m || !m[1] || !m[2]) return null;
  const rg = m[1];
  const vnetName = m[2];

  type Row = {
    id: string;
    name: string;
    addressPrefix?: string;
    addressPrefixes?: string[];
    networkSecurityGroup?: { id?: string };
    routeTable?: { id?: string };
    serviceEndpoints?: Array<{ service: string; locations?: string[] }>;
    delegations?: Array<{ name: string; serviceName?: string }>;
    privateEndpointNetworkPolicies?: string;
    privateLinkServiceNetworkPolicies?: string;
    provisioningState?: string;
  };
  const s = await azCli<Row>([
    "network",
    "vnet",
    "subnet",
    "show",
    "--vnet-name",
    vnetName,
    "--name",
    subnetName,
    "--resource-group",
    rg,
  ]);
  if (!s) return null;
  return {
    cloud: "azure",
    name: s.name,
    kind: "subnet",
    resource_type: "Microsoft.Network/virtualNetworks/subnets",
    location: "",
    resource_group: rg,
    state: s.provisioningState,
    console_url: azurePortalUrl(s.id),
    props: {
      addressPrefix: s.addressPrefix ?? (s.addressPrefixes ?? []).join(", "),
      vnet: vnetName,
      nsg: s.networkSecurityGroup?.id?.split("/").pop(),
      routeTable: s.routeTable?.id?.split("/").pop(),
      serviceEndpoints: (s.serviceEndpoints ?? []).map((e) => e.service),
      delegations: (s.delegations ?? []).map((d) => d.serviceName ?? d.name),
      privateEndpointNetworkPolicies: s.privateEndpointNetworkPolicies,
      privateLinkServiceNetworkPolicies: s.privateLinkServiceNetworkPolicies,
    },
    raw: s,
  };
}

/** Resource group fetcher. RGs aren't tagged with mcp-topology-id by
 *  default (only the resources inside are), so we look up by name
 *  directly via `az group show`. */
async function fetchAzureResourceGroup(name: string): Promise<ResourceDetails | null> {
  type Row = {
    id: string;
    name: string;
    location: string;
    properties?: { provisioningState?: string };
    tags?: Record<string, string>;
  };
  const rg = await azCli<Row>(["group", "show", "--name", name]);
  if (!rg) return null;
  // Count resources in the RG for a quick at-a-glance number.
  const items = await azCli<Array<{ type: string }>>([
    "resource",
    "list",
    "--resource-group",
    name,
    "--query",
    "[].{type:type}",
  ]);
  const byType: Record<string, number> = {};
  for (const it of items ?? []) byType[it.type] = (byType[it.type] ?? 0) + 1;
  return {
    cloud: "azure",
    name: rg.name,
    kind: "resource-group",
    resource_type: "Microsoft.Resources/resourceGroups",
    location: rg.location,
    resource_group: rg.name,
    state: rg.properties?.provisioningState,
    tags: rg.tags,
    console_url: `https://portal.azure.com/#@/resource${rg.id}/overview`,
    props: {
      resourceCount: items?.length ?? 0,
      byType,
    },
    raw: rg,
  };
}

async function fetchAzureSqlServer(resourceId: string): Promise<ResourceDetails | null> {
  type Row = {
    name: string;
    location: string;
    resourceGroup: string;
    administratorLogin?: string;
    fullyQualifiedDomainName?: string;
    version?: string;
    state?: string;
    publicNetworkAccess?: string;
    minimalTlsVersion?: string;
    tags?: Record<string, string>;
  };
  const srv = await azCli<Row>(["sql", "server", "show", "--ids", resourceId]);
  if (!srv) return null;

  // Also pull the databases on this server — useful at-a-glance.
  type DbRow = { name: string; sku?: { name?: string; tier?: string }; status?: string; maxSizeBytes?: string };
  const dbs = await azCli<DbRow[]>([
    "sql",
    "db",
    "list",
    "--server",
    srv.name,
    "--resource-group",
    srv.resourceGroup,
    "--query",
    "[].{name:name, sku:sku, status:status, maxSizeBytes:maxSizeBytes}",
  ]);

  return {
    cloud: "azure",
    name: srv.name,
    kind: "sql",
    resource_type: "Microsoft.Sql/servers",
    location: srv.location,
    resource_group: srv.resourceGroup,
    state: srv.state,
    tags: srv.tags,
    console_url: azurePortalUrl(resourceId),
    props: {
      adminLogin: srv.administratorLogin,
      fqdn: srv.fullyQualifiedDomainName,
      version: srv.version,
      publicNetworkAccess: srv.publicNetworkAccess,
      minTls: srv.minimalTlsVersion,
      databases: (dbs ?? []).filter((d) => d.name !== "master"),
    },
    raw: srv,
  };
}

/** Generic fallback — for kinds we haven't written a dedicated
 *  fetcher for. Pulls whatever `az resource show` returns and lets
 *  the frontend render it as a raw JSON view. */
async function fetchAzureGeneric(
  resourceId: string,
  type: string,
  location: string,
  resourceGroup: string
): Promise<ResourceDetails | null> {
  const r = await azCli<Record<string, unknown> & { name: string; tags?: Record<string, string> }>(
    ["resource", "show", "--ids", resourceId]
  );
  if (!r) return null;
  return {
    cloud: "azure",
    name: r.name,
    kind: "generic",
    resource_type: type,
    location,
    resource_group: resourceGroup,
    state: (r.properties as { provisioningState?: string } | undefined)?.provisioningState,
    tags: r.tags,
    console_url: azurePortalUrl(resourceId),
    props: {},
    raw: r,
  };
}

// ── Public API ──────────────────────────────────────────────────

/** Map a topology node `kind` to the Azure provider/type prefix
 *  that should match the live resource's `type` field. Used to
 *  pick the right fetcher when multiple kinds could share a label. */
const AZURE_KIND_TO_TYPE_PREFIX: Record<string, string[]> = {
  vm: ["Microsoft.Compute/virtualMachines"],
  "vm-scale-set": ["Microsoft.Compute/virtualMachineScaleSets"],
  bastion: ["Microsoft.Network/bastionHosts"],
  storage: ["Microsoft.Storage/storageAccounts"],
  sql: ["Microsoft.Sql/servers"],
};

export async function getAzureResourceDetails(input: {
  topologyId: string;
  nodeKind: string;
  nodeLabel: string;
  /** Bypass the in-memory cache. Used by the explicit refresh path
   *  so the user gets fresh data instead of the stale 30s entry. */
  force?: boolean;
}): Promise<ResourceDetails | null> {
  const cacheKey = `azure:${input.topologyId}:${input.nodeKind}:${input.nodeLabel}`;
  if (!input.force) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  // Special cases that bypass the tag-list lookup:
  //
  //   - Resource groups aren't tagged with mcp-topology-id by default
  //     (only the resources inside are), so look up by name directly.
  //
  //   - Subnets are child resources of VNets and don't appear in
  //     `az resource list --tag`. Find the parent VNet via the tag
  //     index, then `az network vnet subnet show`.
  let details: ResourceDetails | null = null;
  if (input.nodeKind === "resource-group") {
    details = await fetchAzureResourceGroup(input.nodeLabel);
    cacheSet(cacheKey, details);
    return details;
  }
  if (input.nodeKind === "subnet") {
    // Locate any VNet in this topology to use as the parent. We use the
    // generic tag-list helper (rather than --resource-type, which doesn't
    // compose reliably with --tag in az CLI) and filter VNet types
    // client-side.
    type Row = { id: string; type: string; name: string };
    const all = await azCli<Row[]>([
      "resource",
      "list",
      "--tag",
      `mcp-topology-id=${input.topologyId}`,
      "--query",
      "[].{id:id, type:type, name:name}",
    ]);
    const vnets = (all ?? []).filter(
      (r) => r.type === "Microsoft.Network/virtualNetworks"
    );
    for (const vn of vnets) {
      const found = await fetchAzureSubnet(vn.id, input.nodeLabel);
      if (found) {
        cacheSet(cacheKey, found);
        return found;
      }
    }
    cacheSet(cacheKey, null);
    return null;
  }

  const found = await findAzureResource(input.topologyId, input.nodeLabel);
  if (!found) {
    cacheSet(cacheKey, null);
    return null;
  }

  // Dispatch by the actual Azure resource type — authoritative when the
  // topology kind hint disagrees (e.g. Claude tagged something `generic`
  // but the real type is a VM).
  const t = found.type;
  if (t === "Microsoft.Compute/virtualMachines") {
    details = await fetchAzureVm(found.id);
  } else if (t === "Microsoft.Network/bastionHosts") {
    details = await fetchAzureBastion(found.id);
  } else if (t === "Microsoft.Network/virtualNetworks") {
    details = await fetchAzureVNet(found.id);
  } else if (t === "Microsoft.Storage/storageAccounts") {
    details = await fetchAzureStorage(found.id);
  } else if (t === "Microsoft.Sql/servers") {
    details = await fetchAzureSqlServer(found.id);
  } else {
    details = await fetchAzureGeneric(found.id, t, found.location, found.resourceGroup);
  }

  cacheSet(cacheKey, details);
  return details;
}

// ── AWS resource lookup + fetchers ──────────────────────────────
//
// AWS strategy mirrors Azure but uses CloudFormation stack listing
// as the index instead of tag-based resource search:
//   1. Find the CFN stack by tag mcp-topology-id (or by stack name
//      following our convention `mcp-<project>-<topo8>`).
//   2. list-stack-resources gives every resource the stack owns,
//      with PhysicalResourceId + ResourceType. No tag-propagation
//      gotchas (some AWS resource types don't accept stack tags).
//   3. Match a topology node to a stack resource by either:
//      - Name tag (set explicitly in the template), OR
//      - LogicalResourceId (the CFN template's resource block name).
//   4. Per-kind describe via the appropriate aws ec2 / iam / rds CLI.
//
// Region: AWS is region-scoped. We default to AWS_DEFAULT_REGION
// (env, falls back to us-east-1) since the AWS system prompt's
// default is us-east-1. A future revision should persist the
// region per topology row.

const AWS_CLI_IMAGE = process.env.AWS_CLI_IMAGE ?? "amazon/aws-cli:latest";

function awsRegion(): string {
  return (
    process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1"
  );
}

async function awsCli<T = unknown>(args: string[]): Promise<T | null> {
  // Same docker-socket sidecar pattern as azCli. Creds via env vars
  // (long-lived IAM access keys for the `claude` user).
  const shellScript = `aws ${args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ")} --output json`;

  const dockerArgs = [
    "run",
    "--rm",
    "-e",
    `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID ?? ""}`,
    "-e",
    `AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY ?? ""}`,
    "-e",
    `AWS_DEFAULT_REGION=${awsRegion()}`,
    AWS_CLI_IMAGE,
    "sh",
    "-c",
    shellScript,
  ];

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 60_000);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.on("error", () => resolve({ code: -1, stdout, stderr }));
    }
  );

  if (result.code !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[resource-details] aws command failed (${args.slice(0, 3).join(" ")}): ${result.stderr.slice(0, 300)}`
    );
    return null;
  }
  try {
    return result.stdout.trim() ? (JSON.parse(result.stdout) as T) : (null as T | null);
  } catch {
    return null;
  }
}

function awsConsoleUrl(region: string, path: string): string {
  return `https://${region}.console.aws.amazon.com/${path}?region=${region}`;
}

type StackResource = {
  LogicalResourceId: string;
  PhysicalResourceId: string;
  ResourceType: string;
  ResourceStatus: string;
};

/** Find the CloudFormation stack for this topology and return its
 *  resources. We try the explicit naming convention first
 *  (mcp-<project>-<topo8>) — fast common-case — then fall back to
 *  scanning stacks by tag if the name lookup misses. */
async function findAwsStackResources(
  topologyId: string
): Promise<{ stackName: string; resources: StackResource[] } | null> {
  // Strategy: list all stacks, find the one tagged mcp-topology-id=<id>.
  type Stack = {
    StackName: string;
    Tags?: Array<{ Key: string; Value: string }>;
  };
  const stacks = await awsCli<{ Stacks: Stack[] }>([
    "cloudformation",
    "describe-stacks",
    "--query",
    "{Stacks:Stacks[].{StackName:StackName,Tags:Tags}}",
  ]);
  if (!stacks?.Stacks) return null;
  const match = stacks.Stacks.find((s) =>
    (s.Tags ?? []).some(
      (t) => t.Key === "mcp-topology-id" && t.Value === topologyId
    )
  );
  if (!match) return null;
  const out = await awsCli<{ StackResourceSummaries: StackResource[] }>([
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    match.StackName,
  ]);
  return {
    stackName: match.StackName,
    resources: out?.StackResourceSummaries ?? [],
  };
}

/** Match a topology node to a stack resource. Tries LogicalResourceId
 *  first (most reliable since CFN owns it), then falls back to a Name
 *  tag scan (slower — describes each candidate to read its tags). */
function pickStackResource(
  resources: StackResource[],
  nodeLabel: string
): StackResource | null {
  const byLogicalId = resources.find((r) => r.LogicalResourceId === nodeLabel);
  if (byLogicalId) return byLogicalId;
  // Substring / kebab-case match — CFN logical IDs are often PascalCase
  // while the topology labels are kebab-case ("web-01").
  const slug = nodeLabel.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const fuzzy = resources.find(
    (r) => r.LogicalResourceId.replace(/[^a-z0-9]/gi, "").toLowerCase() === slug
  );
  return fuzzy ?? null;
}

async function fetchAwsEc2Instance(
  id: string,
  region: string
): Promise<ResourceDetails | null> {
  type Row = {
    Reservations: Array<{
      Instances: Array<{
        InstanceId: string;
        InstanceType: string;
        ImageId: string;
        State: { Name: string };
        PrivateIpAddress?: string;
        PublicIpAddress?: string;
        SubnetId?: string;
        VpcId?: string;
        Architecture?: string;
        Platform?: string;
        PlatformDetails?: string;
        IamInstanceProfile?: { Arn?: string };
        SecurityGroups?: Array<{ GroupId: string; GroupName: string }>;
        NetworkInterfaces?: Array<{
          NetworkInterfaceId: string;
          PrivateIpAddress?: string;
          MacAddress?: string;
          Association?: { PublicIp?: string };
          Groups?: Array<{ GroupId: string; GroupName: string }>;
        }>;
        Tags?: Array<{ Key: string; Value: string }>;
      }>;
    }>;
  };
  const data = await awsCli<Row>(["ec2", "describe-instances", "--instance-ids", id]);
  const inst = data?.Reservations?.[0]?.Instances?.[0];
  if (!inst) return null;
  const tags = Object.fromEntries((inst.Tags ?? []).map((t) => [t.Key, t.Value]));
  const name = tags["Name"] ?? inst.InstanceId;
  return {
    cloud: "aws",
    name,
    kind: "ec2",
    resource_type: "AWS::EC2::Instance",
    location: region,
    state: inst.State?.Name,
    tags,
    console_url: awsConsoleUrl(
      region,
      `ec2/home#InstanceDetails:instanceId=${inst.InstanceId}`
    ),
    props: {
      instanceId: inst.InstanceId,
      instanceType: inst.InstanceType,
      imageId: inst.ImageId,
      architecture: inst.Architecture,
      platform: inst.PlatformDetails ?? inst.Platform ?? "linux",
      privateIp: inst.PrivateIpAddress,
      publicIp: inst.PublicIpAddress,
      vpcId: inst.VpcId,
      subnetId: inst.SubnetId,
      iamInstanceProfile: inst.IamInstanceProfile?.Arn?.split("/").pop(),
      securityGroups: (inst.SecurityGroups ?? []).map((g) => `${g.GroupId} (${g.GroupName})`),
      networkInterfaces: (inst.NetworkInterfaces ?? []).map((n) => ({
        id: n.NetworkInterfaceId,
        privateIp: n.PrivateIpAddress,
        publicIp: n.Association?.PublicIp,
        mac: n.MacAddress,
        sgs: (n.Groups ?? []).map((g) => g.GroupId),
      })),
    },
    raw: inst,
  };
}

async function fetchAwsVpc(
  id: string,
  region: string
): Promise<ResourceDetails | null> {
  type Vpc = {
    VpcId: string;
    CidrBlock: string;
    IsDefault: boolean;
    State: string;
    Tags?: Array<{ Key: string; Value: string }>;
  };
  const data = await awsCli<{ Vpcs: Vpc[] }>([
    "ec2",
    "describe-vpcs",
    "--vpc-ids",
    id,
  ]);
  const v = data?.Vpcs?.[0];
  if (!v) return null;
  // Pull subnets + peerings + IGWs in parallel for at-a-glance summary.
  const [subnets, peerings, igws] = await Promise.all([
    awsCli<{ Subnets: Array<{ SubnetId: string; CidrBlock: string; AvailabilityZone: string }> }>([
      "ec2",
      "describe-subnets",
      "--filters",
      `Name=vpc-id,Values=${id}`,
    ]),
    awsCli<{
      VpcPeeringConnections: Array<{
        VpcPeeringConnectionId: string;
        Status?: { Code?: string };
        AccepterVpcInfo?: { VpcId?: string };
        RequesterVpcInfo?: { VpcId?: string };
      }>;
    }>([
      "ec2",
      "describe-vpc-peering-connections",
      "--filters",
      `Name=accepter-vpc-info.vpc-id,Values=${id}`,
      `Name=requester-vpc-info.vpc-id,Values=${id}`,
    ]),
    awsCli<{ InternetGateways: Array<{ InternetGatewayId: string }> }>([
      "ec2",
      "describe-internet-gateways",
      "--filters",
      `Name=attachment.vpc-id,Values=${id}`,
    ]),
  ]);
  const tags = Object.fromEntries((v.Tags ?? []).map((t) => [t.Key, t.Value]));
  return {
    cloud: "aws",
    name: tags["Name"] ?? v.VpcId,
    kind: "vpc",
    resource_type: "AWS::EC2::VPC",
    location: region,
    state: v.State,
    tags,
    console_url: awsConsoleUrl(region, `vpcconsole/home#VpcDetails:VpcId=${v.VpcId}`),
    props: {
      vpcId: v.VpcId,
      cidr: v.CidrBlock,
      isDefault: v.IsDefault,
      subnets: (subnets?.Subnets ?? []).map((s) => ({
        id: s.SubnetId,
        cidr: s.CidrBlock,
        az: s.AvailabilityZone,
      })),
      peerings: (peerings?.VpcPeeringConnections ?? []).map((p) => ({
        id: p.VpcPeeringConnectionId,
        state: p.Status?.Code,
        accepter: p.AccepterVpcInfo?.VpcId,
        requester: p.RequesterVpcInfo?.VpcId,
      })),
      internetGateways: (igws?.InternetGateways ?? []).map((g) => g.InternetGatewayId),
    },
    raw: v,
  };
}

async function fetchAwsSubnet(
  id: string,
  region: string
): Promise<ResourceDetails | null> {
  type Subnet = {
    SubnetId: string;
    VpcId: string;
    CidrBlock: string;
    AvailabilityZone: string;
    AvailableIpAddressCount: number;
    MapPublicIpOnLaunch: boolean;
    State: string;
    Tags?: Array<{ Key: string; Value: string }>;
  };
  const data = await awsCli<{ Subnets: Subnet[] }>([
    "ec2",
    "describe-subnets",
    "--subnet-ids",
    id,
  ]);
  const s = data?.Subnets?.[0];
  if (!s) return null;
  const tags = Object.fromEntries((s.Tags ?? []).map((t) => [t.Key, t.Value]));
  return {
    cloud: "aws",
    name: tags["Name"] ?? s.SubnetId,
    kind: "subnet",
    resource_type: "AWS::EC2::Subnet",
    location: region,
    state: s.State,
    tags,
    console_url: awsConsoleUrl(region, `vpcconsole/home#SubnetDetails:subnetId=${s.SubnetId}`),
    props: {
      subnetId: s.SubnetId,
      vpcId: s.VpcId,
      cidr: s.CidrBlock,
      az: s.AvailabilityZone,
      availableIps: s.AvailableIpAddressCount,
      publicOnLaunch: s.MapPublicIpOnLaunch,
    },
    raw: s,
  };
}

async function fetchAwsSecurityGroup(
  id: string,
  region: string
): Promise<ResourceDetails | null> {
  type Sg = {
    GroupId: string;
    GroupName: string;
    VpcId: string;
    Description: string;
    IpPermissions?: Array<{
      IpProtocol: string;
      FromPort?: number;
      ToPort?: number;
      IpRanges?: Array<{ CidrIp: string }>;
      UserIdGroupPairs?: Array<{ GroupId: string }>;
    }>;
    IpPermissionsEgress?: Array<{ IpProtocol: string }>;
    Tags?: Array<{ Key: string; Value: string }>;
  };
  const data = await awsCli<{ SecurityGroups: Sg[] }>([
    "ec2",
    "describe-security-groups",
    "--group-ids",
    id,
  ]);
  const sg = data?.SecurityGroups?.[0];
  if (!sg) return null;
  const tags = Object.fromEntries((sg.Tags ?? []).map((t) => [t.Key, t.Value]));
  return {
    cloud: "aws",
    name: tags["Name"] ?? sg.GroupName,
    kind: "security-group",
    resource_type: "AWS::EC2::SecurityGroup",
    location: region,
    tags,
    console_url: awsConsoleUrl(
      region,
      `vpcconsole/home#SecurityGroup:groupId=${sg.GroupId}`
    ),
    props: {
      groupId: sg.GroupId,
      groupName: sg.GroupName,
      vpcId: sg.VpcId,
      description: sg.Description,
      ingress: (sg.IpPermissions ?? []).map((p) => ({
        protocol: p.IpProtocol,
        from: p.FromPort,
        to: p.ToPort,
        cidrs: (p.IpRanges ?? []).map((r) => r.CidrIp),
        sgs: (p.UserIdGroupPairs ?? []).map((g) => g.GroupId),
      })),
      egressCount: (sg.IpPermissionsEgress ?? []).length,
    },
    raw: sg,
  };
}

async function fetchAwsIamRole(
  name: string,
  region: string
): Promise<ResourceDetails | null> {
  type Role = {
    RoleName: string;
    Arn: string;
    Path: string;
    CreateDate: string;
    AssumeRolePolicyDocument: string;
  };
  const data = await awsCli<{ Role: Role }>([
    "iam",
    "get-role",
    "--role-name",
    name,
  ]);
  if (!data?.Role) return null;
  // Attached managed policies — most useful at a glance for SSM roles.
  const policies = await awsCli<{
    AttachedPolicies: Array<{ PolicyName: string; PolicyArn: string }>;
  }>(["iam", "list-attached-role-policies", "--role-name", name]);
  return {
    cloud: "aws",
    name: data.Role.RoleName,
    kind: "iam-role",
    resource_type: "AWS::IAM::Role",
    location: "global",
    console_url: awsConsoleUrl(region, `iamv2/home#/roles/details/${name}`),
    props: {
      arn: data.Role.Arn,
      path: data.Role.Path,
      attachedPolicies: (policies?.AttachedPolicies ?? []).map((p) => p.PolicyName),
    },
    raw: data.Role,
  };
}

async function fetchAwsVpcEndpoint(
  id: string,
  region: string
): Promise<ResourceDetails | null> {
  type Ep = {
    VpcEndpointId: string;
    VpcEndpointType: string;
    VpcId: string;
    ServiceName: string;
    State: string;
    SubnetIds?: string[];
    PrivateDnsEnabled?: boolean;
    Tags?: Array<{ Key: string; Value: string }>;
  };
  const data = await awsCli<{ VpcEndpoints: Ep[] }>([
    "ec2",
    "describe-vpc-endpoints",
    "--vpc-endpoint-ids",
    id,
  ]);
  const e = data?.VpcEndpoints?.[0];
  if (!e) return null;
  const tags = Object.fromEntries((e.Tags ?? []).map((t) => [t.Key, t.Value]));
  return {
    cloud: "aws",
    name: tags["Name"] ?? e.VpcEndpointId,
    kind: "vpc-endpoint",
    resource_type: "AWS::EC2::VPCEndpoint",
    location: region,
    state: e.State,
    tags,
    console_url: awsConsoleUrl(
      region,
      `vpcconsole/home#EndpointDetails:vpcEndpointId=${e.VpcEndpointId}`
    ),
    props: {
      endpointId: e.VpcEndpointId,
      type: e.VpcEndpointType,
      vpcId: e.VpcId,
      service: e.ServiceName,
      privateDns: e.PrivateDnsEnabled,
      subnetIds: e.SubnetIds ?? [],
    },
    raw: e,
  };
}

async function fetchAwsCfnStack(
  stackName: string,
  region: string
): Promise<ResourceDetails | null> {
  type Stack = {
    StackName: string;
    StackId: string;
    StackStatus: string;
    CreationTime: string;
    Tags?: Array<{ Key: string; Value: string }>;
  };
  const data = await awsCli<{ Stacks: Stack[] }>([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
  ]);
  const s = data?.Stacks?.[0];
  if (!s) return null;
  const resList = await awsCli<{ StackResourceSummaries: StackResource[] }>([
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    stackName,
  ]);
  const byType: Record<string, number> = {};
  for (const r of resList?.StackResourceSummaries ?? []) {
    byType[r.ResourceType] = (byType[r.ResourceType] ?? 0) + 1;
  }
  const tags = Object.fromEntries((s.Tags ?? []).map((t) => [t.Key, t.Value]));
  return {
    cloud: "aws",
    name: s.StackName,
    kind: "cloudformation-stack",
    resource_type: "AWS::CloudFormation::Stack",
    location: region,
    state: s.StackStatus,
    tags,
    console_url: awsConsoleUrl(
      region,
      `cloudformation/home#/stacks/stackinfo?stackId=${encodeURIComponent(s.StackId)}`
    ),
    props: {
      stackName: s.StackName,
      createdAt: s.CreationTime,
      resourceCount: resList?.StackResourceSummaries?.length ?? 0,
      byType,
    },
    raw: s,
  };
}

async function fetchAwsGeneric(
  resource: StackResource,
  region: string
): Promise<ResourceDetails | null> {
  return {
    cloud: "aws",
    name: resource.PhysicalResourceId,
    kind: "generic",
    resource_type: resource.ResourceType,
    location: region,
    state: resource.ResourceStatus,
    console_url: awsConsoleUrl(region, ""),
    props: {
      logicalId: resource.LogicalResourceId,
      physicalId: resource.PhysicalResourceId,
    },
    raw: resource,
  };
}

export async function getAwsResourceDetails(input: {
  topologyId: string;
  nodeKind: string;
  nodeLabel: string;
  force?: boolean;
}): Promise<ResourceDetails | null> {
  const cacheKey = `aws:${input.topologyId}:${input.nodeKind}:${input.nodeLabel}`;
  if (!input.force) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const region = awsRegion();
  const stack = await findAwsStackResources(input.topologyId);
  if (!stack) {
    cacheSet(cacheKey, null);
    return null;
  }

  // Special-case the CFN stack itself when the topology has a stack
  // node (we use kind 'cloudformation-stack' or 'resource-group' as
  // a stack analog).
  if (
    input.nodeKind === "cloudformation-stack" ||
    input.nodeKind === "resource-group" ||
    input.nodeLabel === stack.stackName
  ) {
    const details = await fetchAwsCfnStack(stack.stackName, region);
    cacheSet(cacheKey, details);
    return details;
  }

  const match = pickStackResource(stack.resources, input.nodeLabel);
  if (!match) {
    cacheSet(cacheKey, null);
    return null;
  }

  let details: ResourceDetails | null = null;
  switch (match.ResourceType) {
    case "AWS::EC2::Instance":
      details = await fetchAwsEc2Instance(match.PhysicalResourceId, region);
      break;
    case "AWS::EC2::VPC":
      details = await fetchAwsVpc(match.PhysicalResourceId, region);
      break;
    case "AWS::EC2::Subnet":
      details = await fetchAwsSubnet(match.PhysicalResourceId, region);
      break;
    case "AWS::EC2::SecurityGroup":
      details = await fetchAwsSecurityGroup(match.PhysicalResourceId, region);
      break;
    case "AWS::EC2::VPCEndpoint":
      details = await fetchAwsVpcEndpoint(match.PhysicalResourceId, region);
      break;
    case "AWS::IAM::Role":
      details = await fetchAwsIamRole(match.PhysicalResourceId, region);
      break;
    default:
      details = await fetchAwsGeneric(match, region);
  }
  cacheSet(cacheKey, details);
  return details;
}

// ── Bulk prefetch (post-deploy DB cache) ────────────────────────
// After a successful deploy the topology row's status flips to
// "live". The route handler kicks off this function in the
// background to populate every node's detail entry, so the user's
// first click on the canvas opens the modal instantly instead of
// paying the ~17-30s CLI spawn cost per resource.
//
// We parallelise across nodes (each fetch is independent) but the
// in-process cache means re-runs of the same topology are cheap.

export async function prefetchTopologyDetails(input: {
  topologyId: string;
  cloud: "azure" | "aws";
  nodes: Array<{ id: string; kind: string; label: string }>;
  /** Force-refresh ignores the in-memory cache. Used by the explicit
   *  /details/refresh endpoint when the user wants up-to-the-minute
   *  data. The post-deploy auto-prefetch leaves this false so we
   *  reuse anything the user might have already clicked through. */
  force?: boolean;
}): Promise<Record<string, ResourceDetails | null>> {
  const fetcher =
    input.cloud === "aws" ? getAwsResourceDetails : getAzureResourceDetails;
  const results = await Promise.all(
    input.nodes.map(async (n) => {
      try {
        const r = await fetcher({
          topologyId: input.topologyId,
          nodeKind: n.kind,
          nodeLabel: n.label,
          force: input.force,
        });
        return [n.id, r] as const;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[prefetch] node ${n.id} (${n.kind}/${n.label}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return [n.id, null] as const;
      }
    })
  );
  return Object.fromEntries(results);
}

// Re-export the kind→type table for tests / docs.
export const _AZURE_KIND_TO_TYPE_PREFIX = AZURE_KIND_TO_TYPE_PREFIX;

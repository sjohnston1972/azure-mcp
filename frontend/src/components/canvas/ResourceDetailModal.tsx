// Live resource detail modal. Opens when the user clicks a node on
// a LIVE topology canvas. Fetches /api/topologies/:id/details/:nodeId
// on mount, shows a loading state, then renders a kind-specific
// layout. Always exposes the raw cloud-API response on a "Raw" tab
// so the user can verify a field that's missing from the rendered
// view.

import { useEffect, useState } from "react";
import {
  fetchResourceDetails,
  type ResourceDetails,
} from "../../lib/api";

type Props = {
  open: boolean;
  topologyId: string | null;
  nodeId: string | null;
  onClose: () => void;
};

export function ResourceDetailModal({ open, topologyId, nodeId, onClose }: Props) {
  const [data, setData] = useState<ResourceDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "raw">("details");

  useEffect(() => {
    if (!open || !topologyId || !nodeId) return;
    setLoading(true);
    setError(null);
    setData(null);
    setTab("details");
    fetchResourceDetails(topologyId, nodeId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, topologyId, nodeId]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] rounded-xl bg-surface-container-lowest shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-outline-variant/30 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-extrabold tracking-tight truncate">
              {data ? data.name : nodeId}
            </h2>
            <p className="text-xs text-on-surface-variant truncate">
              {data
                ? `${data.resource_type} · ${data.location}`
                : "Loading live resource details…"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data?.console_url && (
              <a
                href={data.console_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-primary/40 text-xs font-bold text-primary hover:bg-primary/10 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">
                  open_in_new
                </span>
                Open in {data.cloud === "aws" ? "AWS" : "Azure"} console
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-on-surface-variant hover:text-on-surface p-1 rounded-md hover:bg-surface-container-high"
              aria-label="Close"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        {loading && (
          <div className="grid place-items-center flex-1 py-12 text-sm text-on-surface-variant">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-base">
                progress_activity
              </span>
              Querying {data?.cloud ?? "cloud"} API…
            </div>
          </div>
        )}

        {error && (
          <div className="m-6 rounded-lg bg-error/5 border border-error/30 p-3 text-xs text-error font-mono whitespace-pre-wrap break-words">
            {error}
          </div>
        )}

        {data && (
          <>
            {/* Top summary strip — state, RG, tags */}
            <div className="px-6 py-3 border-b border-outline-variant/30 flex items-center gap-3 flex-wrap">
              {data.state && (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${stateChipClass(data.state)}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {data.state}
                </span>
              )}
              {data.resource_group && (
                <span className="text-xs text-on-surface-variant">
                  RG{" "}
                  <code className="font-mono">{data.resource_group}</code>
                </span>
              )}
              {Object.entries(data.tags ?? {})
                .filter(([k]) => k.startsWith("mcp-"))
                .map(([k, v]) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-surface-container-low text-on-surface-variant border border-outline-variant/30"
                  >
                    {k}={k === "mcp-topology-id" ? `${v.slice(0, 8)}…` : v}
                  </span>
                ))}
            </div>

            <div className="px-6 py-2 border-b border-outline-variant/30 flex items-center gap-1">
              {(["details", "raw"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors ${
                    tab === t
                      ? "bg-primary/10 text-primary"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  {t === "details" ? "Details" : "Raw JSON"}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto px-6 py-4">
              {tab === "details" ? <DetailsView d={data} /> : <RawView d={data} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function stateChipClass(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("running") || s.includes("succeeded") || s.includes("available")) {
    return "bg-secondary/15 text-secondary";
  }
  if (s.includes("stopped") || s.includes("deallocated") || s.includes("destroyed")) {
    return "bg-outline-variant/25 text-on-surface-variant";
  }
  if (s.includes("fail") || s.includes("error")) {
    return "bg-error/15 text-error";
  }
  return "bg-primary/10 text-primary";
}

// ── Per-kind detail layouts ─────────────────────────────────────

function DetailsView({ d }: { d: ResourceDetails }) {
  switch (d.resource_type) {
    case "Microsoft.Compute/virtualMachines":
      return <VmDetails d={d} />;
    case "Microsoft.Network/bastionHosts":
      return <BastionDetails d={d} />;
    case "Microsoft.Network/virtualNetworks":
      return <VNetDetails d={d} />;
    case "Microsoft.Network/virtualNetworks/subnets":
      return <SubnetDetails d={d} />;
    case "Microsoft.Resources/resourceGroups":
      return <ResourceGroupDetails d={d} />;
    case "Microsoft.Storage/storageAccounts":
      return <StorageDetails d={d} />;
    case "Microsoft.Sql/servers":
      return <SqlServerDetails d={d} />;
    default:
      return <GenericDetails d={d} />;
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1 text-sm border-b border-outline-variant/15 last:border-b-0">
      <div className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant pt-0.5">
        {label}
      </div>
      <div className="text-on-surface break-words">{value}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5 last:mb-0">
      <h3 className="text-xs font-extrabold uppercase tracking-widest text-on-surface-variant mb-2">
        {title}
      </h3>
      <div className="rounded-lg bg-surface-container-low border border-outline-variant/30 px-3 py-2">
        {children}
      </div>
    </div>
  );
}

function VmDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    vmSize?: string;
    osType?: string;
    image?: string;
    osDisk?: { sizeGB?: number; sku?: string };
    dataDisks?: Array<{ name: string; diskSizeGB: number }>;
    nics?: Array<{
      name: string;
      macAddress?: string;
      acceleratedNetworking?: boolean;
      nsg?: string;
      privateIPs?: Array<{ address?: string; allocation?: string; subnet?: string }>;
      publicIPs?: Array<{ address?: string; allocation?: string }>;
    }>;
  };
  return (
    <>
      <Section title="Compute">
        <Field label="VM size" value={<code className="font-mono">{p.vmSize}</code>} />
        <Field label="OS" value={p.osType} />
        <Field label="Image" value={<code className="font-mono text-xs">{p.image}</code>} />
        {p.osDisk && (
          <Field
            label="OS disk"
            value={
              <span>
                {p.osDisk.sizeGB} GB · {p.osDisk.sku}
              </span>
            }
          />
        )}
        {p.dataDisks && p.dataDisks.length > 0 && (
          <Field
            label="Data disks"
            value={
              <ul className="list-none p-0 m-0 space-y-0.5">
                {p.dataDisks.map((d) => (
                  <li key={d.name}>
                    <code className="font-mono">{d.name}</code> · {d.diskSizeGB} GB
                  </li>
                ))}
              </ul>
            }
          />
        )}
      </Section>
      <Section title="Network">
        {p.nics && p.nics.length > 0 ? (
          <div className="space-y-3">
            {p.nics.map((n) => (
              <div key={n.name} className="text-sm">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <code className="font-mono text-xs font-bold">{n.name}</code>
                  <span className="text-[10px] text-on-surface-variant">
                    {n.macAddress} · accel-net{" "}
                    {n.acceleratedNetworking ? "on" : "off"}
                    {n.nsg && (
                      <>
                        {" "}
                        · NSG <code className="font-mono">{n.nsg}</code>
                      </>
                    )}
                  </span>
                </div>
                {n.privateIPs?.map((p, i) => (
                  <div
                    key={i}
                    className="text-xs text-on-surface ml-2 flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[12px] text-on-surface-variant">
                      lan
                    </span>
                    <code className="font-mono">{p.address}</code>
                    <span className="text-on-surface-variant">
                      {p.allocation}
                    </span>
                    {p.subnet && (
                      <span className="text-on-surface-variant">
                        in <code className="font-mono">{p.subnet}</code>
                      </span>
                    )}
                  </div>
                ))}
                {n.publicIPs?.map((p, i) => (
                  <div
                    key={`pub-${i}`}
                    className="text-xs text-on-surface ml-2 flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[12px] text-tertiary">
                      public
                    </span>
                    <code className="font-mono">{p.address}</code>
                    <span className="text-on-surface-variant">
                      {p.allocation}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No NICs found.</p>
        )}
      </Section>
    </>
  );
}

function BastionDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    sku?: string;
    scaleUnits?: number;
    dnsName?: string;
    ipConfigurations?: Array<{
      name: string;
      subnet?: string;
      publicIp?: string;
      publicIpSku?: string;
    }>;
  };
  return (
    <>
      <Section title="Bastion">
        <Field label="SKU" value={p.sku} />
        <Field label="Scale units" value={p.scaleUnits} />
        <Field label="DNS" value={<code className="font-mono text-xs">{p.dnsName}</code>} />
      </Section>
      <Section title="IP configuration">
        {p.ipConfigurations && p.ipConfigurations.length > 0 ? (
          <div className="space-y-2">
            {p.ipConfigurations.map((c) => (
              <div key={c.name} className="text-sm">
                <code className="font-mono text-xs font-bold">{c.name}</code>
                {c.publicIp && (
                  <div className="text-xs ml-2 flex items-center gap-2">
                    <span className="material-symbols-outlined text-[12px] text-tertiary">
                      public
                    </span>
                    <code className="font-mono">{c.publicIp}</code>
                    <span className="text-on-surface-variant">{c.publicIpSku}</span>
                  </div>
                )}
                {c.subnet && (
                  <div className="text-xs ml-2 text-on-surface-variant">
                    Subnet <code className="font-mono">{c.subnet}</code>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No IP configurations found.</p>
        )}
      </Section>
    </>
  );
}

function StorageDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    sku?: string;
    tier?: string;
    kind?: string;
    accessTier?: string;
    httpsOnly?: boolean;
    minTls?: string;
    blobPublicAccess?: boolean;
    endpoints?: Record<string, string>;
  };
  return (
    <>
      <Section title="Storage">
        <Field label="SKU" value={p.sku} />
        <Field label="Tier" value={p.tier} />
        <Field label="Kind" value={p.kind} />
        <Field label="Access tier" value={p.accessTier} />
      </Section>
      <Section title="Security">
        <Field label="HTTPS only" value={p.httpsOnly ? "yes" : "no"} />
        <Field label="Min TLS" value={p.minTls} />
        <Field
          label="Public blob access"
          value={p.blobPublicAccess ? "allowed" : "blocked"}
        />
      </Section>
      {p.endpoints && Object.keys(p.endpoints).length > 0 && (
        <Section title="Endpoints">
          {Object.entries(p.endpoints).map(([k, v]) => (
            <Field
              key={k}
              label={k}
              value={
                <a
                  href={v}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline decoration-dotted hover:text-on-surface text-xs font-mono break-all"
                >
                  {v}
                </a>
              }
            />
          ))}
        </Section>
      )}
    </>
  );
}

function SqlServerDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    adminLogin?: string;
    fqdn?: string;
    version?: string;
    publicNetworkAccess?: string;
    minTls?: string;
    databases?: Array<{ name: string; sku?: { name?: string; tier?: string }; status?: string; maxSizeBytes?: string }>;
  };
  return (
    <>
      <Section title="SQL Server">
        <Field label="FQDN" value={<code className="font-mono text-xs">{p.fqdn}</code>} />
        <Field label="Version" value={p.version} />
        <Field label="Admin login" value={<code className="font-mono">{p.adminLogin}</code>} />
        <Field label="Public access" value={p.publicNetworkAccess} />
        <Field label="Min TLS" value={p.minTls} />
      </Section>
      {p.databases && p.databases.length > 0 && (
        <Section title="Databases">
          <div className="space-y-1">
            {p.databases.map((db) => (
              <div
                key={db.name}
                className="text-sm flex items-center justify-between gap-2"
              >
                <code className="font-mono">{db.name}</code>
                <span className="text-[10px] text-on-surface-variant">
                  {db.sku?.tier ?? db.sku?.name} · {db.status}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function VNetDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    addressSpace?: string[];
    dnsServers?: string[];
    subnets?: Array<{
      name: string;
      addressPrefix?: string;
      nsg?: string;
      routeTable?: string;
    }>;
    peerings?: Array<{
      name: string;
      remote?: string;
      state?: string;
    }>;
  };
  return (
    <>
      <Section title="Address space">
        {(p.addressSpace ?? []).map((cidr) => (
          <Field key={cidr} label="CIDR" value={<code className="font-mono">{cidr}</code>} />
        ))}
        {(p.dnsServers ?? []).length > 0 && (
          <Field
            label="DNS servers"
            value={(p.dnsServers ?? []).map((d) => (
              <code key={d} className="font-mono mr-2">{d}</code>
            ))}
          />
        )}
      </Section>
      {p.subnets && p.subnets.length > 0 && (
        <Section title={`Subnets (${p.subnets.length})`}>
          <div className="space-y-1">
            {p.subnets.map((s) => (
              <div key={s.name} className="text-sm flex items-center justify-between gap-2 py-0.5">
                <code className="font-mono text-xs">{s.name}</code>
                <span className="text-xs text-on-surface-variant">
                  {s.addressPrefix}
                  {s.nsg && (
                    <>
                      {" "}
                      · NSG <code className="font-mono">{s.nsg}</code>
                    </>
                  )}
                  {s.routeTable && (
                    <>
                      {" "}
                      · RT <code className="font-mono">{s.routeTable}</code>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {p.peerings && p.peerings.length > 0 && (
        <Section title={`Peerings (${p.peerings.length})`}>
          <div className="space-y-1">
            {p.peerings.map((pe) => (
              <div key={pe.name} className="text-sm flex items-center justify-between gap-2 py-0.5">
                <code className="font-mono text-xs">{pe.name}</code>
                <span className="text-xs text-on-surface-variant">
                  → <code className="font-mono">{pe.remote}</code> · {pe.state}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function SubnetDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    addressPrefix?: string;
    vnet?: string;
    nsg?: string;
    routeTable?: string;
    serviceEndpoints?: string[];
    delegations?: string[];
    privateEndpointNetworkPolicies?: string;
    privateLinkServiceNetworkPolicies?: string;
  };
  return (
    <Section title="Subnet">
      <Field label="VNet" value={<code className="font-mono">{p.vnet}</code>} />
      <Field label="CIDR" value={<code className="font-mono">{p.addressPrefix}</code>} />
      <Field label="NSG" value={p.nsg ? <code className="font-mono">{p.nsg}</code> : "—"} />
      <Field
        label="Route table"
        value={p.routeTable ? <code className="font-mono">{p.routeTable}</code> : "—"}
      />
      {p.serviceEndpoints && p.serviceEndpoints.length > 0 && (
        <Field
          label="Service endpoints"
          value={p.serviceEndpoints.map((s) => (
            <code key={s} className="font-mono mr-2 text-xs">{s}</code>
          ))}
        />
      )}
      {p.delegations && p.delegations.length > 0 && (
        <Field
          label="Delegations"
          value={p.delegations.map((s) => (
            <code key={s} className="font-mono mr-2 text-xs">{s}</code>
          ))}
        />
      )}
      <Field
        label="Private endpoint policy"
        value={p.privateEndpointNetworkPolicies}
      />
      <Field
        label="Private link policy"
        value={p.privateLinkServiceNetworkPolicies}
      />
    </Section>
  );
}

function ResourceGroupDetails({ d }: { d: ResourceDetails }) {
  const p = d.props as {
    resourceCount?: number;
    byType?: Record<string, number>;
  };
  return (
    <>
      <Section title="Resource group">
        <Field label="Location" value={d.location} />
        <Field label="State" value={d.state} />
        <Field label="Total resources" value={p.resourceCount ?? 0} />
      </Section>
      {p.byType && Object.keys(p.byType).length > 0 && (
        <Section title="Resources by type">
          <div className="space-y-1">
            {Object.entries(p.byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <div
                  key={type}
                  className="text-sm flex items-center justify-between gap-2 py-0.5"
                >
                  <code className="font-mono text-xs">{type}</code>
                  <span className="text-xs text-on-surface-variant">{count}</span>
                </div>
              ))}
          </div>
        </Section>
      )}
    </>
  );
}

function GenericDetails({ d }: { d: ResourceDetails }) {
  return (
    <Section title="Resource">
      <p className="text-xs text-on-surface-variant mb-2">
        No custom layout for <code className="font-mono">{d.resource_type}</code>{" "}
        yet. The Raw JSON tab has the full cloud-API response.
      </p>
      <Field label="Resource type" value={<code className="font-mono">{d.resource_type}</code>} />
      <Field label="Location" value={d.location} />
      {d.resource_group && <Field label="RG" value={d.resource_group} />}
      {d.state && <Field label="State" value={d.state} />}
    </Section>
  );
}

function RawView({ d }: { d: ResourceDetails }) {
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-surface-container-low rounded-lg p-3 max-h-[60vh] overflow-auto">
      {JSON.stringify(d.raw ?? d, null, 2)}
    </pre>
  );
}

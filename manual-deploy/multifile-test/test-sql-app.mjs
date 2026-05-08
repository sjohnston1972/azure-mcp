// E2E test 2: small SQL web app via the multi-file deploy_bicep path.
//   App Service Plan (B1 Linux) + App Service (Node 22)
//   + Azure SQL Server + Basic Database + firewall rule (Allow Azure)
//
// Drives validate_bicep then deploy_bicep with the actual compiled
// custom-tools handlers — same code path the chat takes.

import { callCustomTool } from "/app/dist/claude/custom-tools.js";

const project = "mft-sqlapp";
const topologyId = "22222222-2222-2222-2222-222222222222";

const main = `targetScope = 'subscription'

@description('Project tag')
param projectName string = '${project}'

@description('Topology id tag')
param topologyId string = '${topologyId}'

@description('Per-deployment id tag')
param deploymentId string = newGuid()

@description('Deployment timestamp tag')
param deployedAt string = utcNow()

@description('Region')
param location string = 'uksouth'

@description('SQL admin login (NOT one of the SQL reserved names: admin/administrator/sa/root/dbmanager/loginmanager).')
param sqlAdminLogin string = 'sqluser'

@secure()
@description('SQL admin password — 8-128 chars, 3 of {upper,lower,digit,non-alphanumeric}, must NOT contain the login.')
param sqlAdminPassword string = 'Vigil!Sql-Web-2026#Lab'

var commonTags = {
  'mcp-project': projectName
  'mcp-topology-id': topologyId
  'mcp-deployment-id': deploymentId
  'mcp-deployed-at': deployedAt
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-\${projectName}'
  location: location
  tags: commonTags
}

module app './app.bicep' = {
  scope: rg
  name: 'sql-web-app'
  params: {
    location: location
    projectName: projectName
    sqlAdminLogin: sqlAdminLogin
    sqlAdminPassword: sqlAdminPassword
    tags: commonTags
  }
}
`;

// We tried App Service first (B1, S1, F1) but the subscription has
// 0 quota in EVERY App Service VM bucket (Basic / Standard / Free)
// in uksouth. Container Apps lives in a separate quota space and
// works on a vanilla sub. Pattern-wise still a "small SQL web app".
const app = `param location string
param projectName string
param sqlAdminLogin string
@secure()
param sqlAdminPassword string
param tags object

var sqlServerName = 'sql-\${projectName}-\${uniqueString(resourceGroup().id)}'
var caAppName = 'app-\${projectName}'
var caEnvName = 'cae-\${projectName}'
var lawName = 'log-\${projectName}'

// ---------- Log Analytics workspace ----------
// Container Apps Environments require a Log Analytics workspace for
// platform diagnostics — there's no "skip logging" option on the env.
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------- Azure SQL ----------
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  tags: tags
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    version: '12.0'
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: '1.2'
  }
}

resource sqlDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: 'app-db'
  location: location
  tags: tags
  sku: { name: 'Basic', tier: 'Basic', capacity: 5 }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 2147483648
  }
}

// '0.0.0.0' / '0.0.0.0' is Azure's special "Allow access from Azure
// services" rule — the Container App can reach the DB without
// opening public ingress for anyone else.
resource sqlFirewallAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---------- Container Apps Environment ----------
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: caEnvName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        // listKeys() pulls the workspace's primary shared key at
        // deploy time — Bicep only allows this on a sibling/child
        // resource reference, which is why law is declared above.
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

// ---------- Container App ----------
// nginxdemos/hello is a tiny public image (under 20 MB) that serves
// a simple "Hello, world!" page on :80. We feed it the SQL connection
// string as an env var so the test exercises secret/config wiring
// even though the demo image doesn't itself read it.
resource caApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: caAppName
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 80
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'sql-connection-string'
          value: 'Server=tcp:\${sqlServer.properties.fullyQualifiedDomainName},1433;Database=\${sqlDb.name};User ID=\${sqlAdminLogin};Password=\${sqlAdminPassword};Encrypt=true;TrustServerCertificate=false;'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: 'docker.io/nginxdemos/hello:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'SQL_CONNECTION_STRING', secretRef: 'sql-connection-string' }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

output appUrl string = 'https://\${caApp.properties.configuration.ingress.fqdn}'
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output sqlDatabaseName string = sqlDb.name
`;

async function step(label, fn) {
  console.log("\n========================================");
  console.log(`[mft-sqlapp] ${label}`);
  console.log("========================================");
  console.time(`[mft-sqlapp] ${label}`);
  const result = await fn();
  console.timeEnd(`[mft-sqlapp] ${label}`);
  console.log(`[mft-sqlapp] is_error: ${result.is_error}`);
  const c =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content, null, 2);
  // Truncate noisy successful deploy logs to keep output readable
  console.log(c.length > 4000 ? c.slice(0, 2000) + "\n…[truncated]\n" + c.slice(-1500) : c);
  return result;
}

// Single validate → deploy → teardown cycle. We deliberately don't
// loop deploy/teardown here: SQL Server names are globally unique
// AND Azure holds a name-recovery reservation for ~7 days after
// delete, which makes back-to-back create/delete with deterministic
// names (uniqueString of rg.id) flake on the second pass even though
// the architecture is correct. The chat-driven use case doesn't hit
// this — humans don't tear down and immediately re-deploy.
const v1 = await step("validate", () =>
  callCustomTool("validate_bicep", {
    files: { "main.bicep": main, "app.bicep": app },
    entry: "main.bicep",
  })
);
if (v1.is_error) process.exit(2);

const d1 = await step("deploy", () =>
  callCustomTool("deploy_bicep", {
    files: { "main.bicep": main, "app.bicep": app },
    entry: "main.bicep",
    scope: "subscription",
    location: "uksouth",
    required_tags: {
      "mcp-project": project,
      "mcp-topology-id": topologyId,
    },
  })
);
if (d1.is_error) process.exit(3);

const t1 = await step("teardown", () =>
  callCustomTool("destroy_azure", {
    tag_filters: {
      "mcp-project": project,
      "mcp-topology-id": topologyId,
    },
  })
);
if (t1.is_error) process.exit(4);

console.log("\n[mft-sqlapp] CYCLE CLEAN ✓");
process.exit(0);

// E2E test: Azure OpenAI chat app via the multi-file deploy_bicep path.
//   Cognitive Services account (kind=OpenAI) + small model deployment
//   (gpt-4o-mini) + Container Apps Environment + Container App that
//   reads AOAI endpoint/deployment as env vars.
//
// Why Container Apps and not App Service: this subscription has 0
// quota in every App Service VM bucket in uksouth (verified by
// repeated SubscriptionIsOverQuotaForSku errors on Basic/Standard/
// Free during the SQL test). Container Apps lives in a separate
// quota space.
//
// Why eastus2 for AOAI: the OpenAI account itself can be in any
// region with the kind=OpenAI service, but model availability is
// regional. eastus2 reliably has gpt-4o-mini quota on a vanilla
// sub. uksouth has spotty model coverage.

import { callCustomTool } from "/app/dist/claude/custom-tools.js";

const project = "mft-aoai";
const topologyId = "33333333-3333-3333-3333-333333333333";

const main = `targetScope = 'subscription'

@description('Project tag')
param projectName string = '${project}'

@description('Topology id tag')
param topologyId string = '${topologyId}'

@description('Per-deployment id tag')
param deploymentId string = newGuid()

@description('Deployment timestamp tag')
param deployedAt string = utcNow()

@description('Region for both the AOAI account and the Container App.')
param location string = 'eastus2'

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
  name: 'aoai-chat-app'
  params: {
    location: location
    projectName: projectName
    tags: commonTags
  }
}
`;

const app = `param location string
param projectName string
param tags object

var aoaiName = 'aoai-\${projectName}-\${uniqueString(resourceGroup().id)}'
var caAppName = 'app-\${projectName}'
var caEnvName = 'cae-\${projectName}'
var lawName = 'log-\${projectName}'
var deploymentName = 'gpt-4-1-mini'

// ---------- Log Analytics workspace ----------
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------- Azure OpenAI account ----------
// kind=OpenAI is the AOAI service; sku.name=S0 is the only Standard
// SKU. customSubDomainName is REQUIRED for AOAI accounts (used as
// the host prefix in the endpoint URL: <name>.openai.azure.com).
resource aoai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aoaiName
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: aoaiName
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
    }
  }
}

// ---------- Model deployment ----------
// We tried GlobalStandard first but the subscription has 0 quota in
// "Tokens Per Minute (thousands) - gpt-4o-mini - GlobalStandard".
// Regional Standard SKU lives in a separate quota pool (per-region)
// and is normally non-zero on a vanilla sub. capacity=1 = 1K TPM —
// the smallest possible deployment, plenty for a smoke test.
resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aoai
  name: deploymentName
  sku: {
    name: 'Standard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'OpenAI'
      // Tried gpt-4o-mini:2024-07-18 first — Microsoft's model
      // catalog list said it was GenerallyAvailable but the deploy
      // validator rejected it as deprecated. gpt-4.1-mini:2025-04-14
      // is current GA with deprecation 2026-10-14 (verified via
      // 'az cognitiveservices model list').
      name: 'gpt-4.1-mini'
      version: '2025-04-14'
    }
    versionUpgradeOption: 'OnceCurrentVersionExpired'
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
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

// ---------- Container App ----------
// nginxdemos/hello stands in for the actual chat UI. The AOAI
// endpoint and deployment name flow in as env vars; the AOAI key
// is wired via a Container App secret pulled from listKeys() so
// the value never appears in the rendered ARM JSON output.
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
          name: 'aoai-key'
          value: aoai.listKeys().key1
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'chat'
          image: 'docker.io/nginxdemos/hello:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'AZURE_OPENAI_ENDPOINT', value: aoai.properties.endpoint }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: deploymentName }
            { name: 'AZURE_OPENAI_API_KEY', secretRef: 'aoai-key' }
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
output aoaiEndpoint string = aoai.properties.endpoint
output modelDeploymentName string = modelDeployment.name
`;

async function step(label, fn) {
  console.log("\n========================================");
  console.log(`[mft-aoai] ${label}`);
  console.log("========================================");
  console.time(`[mft-aoai] ${label}`);
  const result = await fn();
  console.timeEnd(`[mft-aoai] ${label}`);
  console.log(`[mft-aoai] is_error: ${result.is_error}`);
  const c =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content, null, 2);
  console.log(c.length > 4000 ? c.slice(0, 2000) + "\n…[truncated]\n" + c.slice(-1500) : c);
  return result;
}

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
    location: "eastus2",
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

console.log("\n[mft-aoai] CYCLE CLEAN ✓");
process.exit(0);

// End-to-end smoke test for the new multi-file deploy_bicep path.
// Imports the compiled runBicepDeploy from the running backend
// container and drives it with a hub-spoke design split into
// main.bicep + network.bicep — the exact pattern Claude is now
// expected to emit via the <bicep> multi-file marker.
//
// Run inside the backend container:
//   docker compose exec azure-mcp-backend node /test/test-multifile.mjs

import { callCustomTool } from "/app/dist/claude/custom-tools.js";

const project = "mft";
const topologyId = "11111111-1111-1111-1111-111111111111";

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

@description('Linux admin user (NOT one of the reserved names)')
param adminUsername string = 'azureops'

@secure()
@description('Linux admin password — 12+ chars, 3 of 4 classes, must not contain the username')
param adminPassword string = 'Vigil!Hub-Spoke-2026#Lab'

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

module net './network.bicep' = {
  scope: rg
  name: 'hub-spoke-net'
  params: {
    location: location
    adminUsername: adminUsername
    adminPassword: adminPassword
    tags: commonTags
  }
}
`;

const network = `param location string
param adminUsername string
@secure()
param adminPassword string
param tags object

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: 'nsg-spoke-vm'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-SSH-FromHub'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '10.0.0.0/16'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
    ]
  }
}

resource hubVnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-hub'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ '10.0.0.0/16' ] }
    subnets: [
      {
        name: 'AzureBastionSubnet'
        properties: { addressPrefix: '10.0.0.0/26' }
      }
    ]
  }
}

resource s1Vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-spoke1'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ '10.1.0.0/16' ] }
    subnets: [
      {
        name: 'vm-subnet'
        properties: {
          addressPrefix: '10.1.0.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource s2Vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-spoke2'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ '10.2.0.0/16' ] }
    subnets: [
      {
        name: 'vm-subnet'
        properties: {
          addressPrefix: '10.2.0.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

// Full serial peering chain to avoid concurrent-write rejections
resource hubToS1 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: hubVnet
  name: 'hub-to-spoke1'
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: s1Vnet.id }
  }
}

resource s1ToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: s1Vnet
  name: 'spoke1-to-hub'
  dependsOn: [ hubToS1 ]
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: hubVnet.id }
  }
}

resource hubToS2 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: hubVnet
  name: 'hub-to-spoke2'
  dependsOn: [ s1ToHub ]
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: s2Vnet.id }
  }
}

resource s2ToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: s2Vnet
  name: 'spoke2-to-hub'
  dependsOn: [ hubToS2 ]
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: hubVnet.id }
  }
}

resource bastionPip 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: 'pip-bastion-hub'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource bastion 'Microsoft.Network/bastionHosts@2024-01-01' = {
  name: 'bas-hub'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    ipConfigurations: [
      {
        name: 'IpConf'
        properties: {
          subnet: {
            id: '\${hubVnet.id}/subnets/AzureBastionSubnet'
          }
          publicIPAddress: { id: bastionPip.id }
        }
      }
    ]
  }
}

resource nicS1 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: 'nic-vm-spoke1'
  location: location
  tags: tags
  properties: {
    enableAcceleratedNetworking: false
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: '\${s1Vnet.id}/subnets/vm-subnet' }
        }
      }
    ]
  }
}

resource vmS1 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-spoke1'
  location: location
  tags: tags
  properties: {
    hardwareProfile: { vmSize: 'Standard_B1s' }
    osProfile: {
      computerName: 'vm-spoke1'
      adminUsername: adminUsername
      adminPassword: adminPassword
      linuxConfiguration: { disablePasswordAuthentication: false }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 30
        managedDisk: { storageAccountType: 'Standard_LRS' }
      }
    }
    networkProfile: { networkInterfaces: [ { id: nicS1.id } ] }
  }
}

resource nicS2 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: 'nic-vm-spoke2'
  location: location
  tags: tags
  properties: {
    enableAcceleratedNetworking: false
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: '\${s2Vnet.id}/subnets/vm-subnet' }
        }
      }
    ]
  }
}

resource vmS2 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-spoke2'
  location: location
  tags: tags
  properties: {
    hardwareProfile: { vmSize: 'Standard_B1s' }
    osProfile: {
      computerName: 'vm-spoke2'
      adminUsername: adminUsername
      adminPassword: adminPassword
      linuxConfiguration: { disablePasswordAuthentication: false }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 30
        managedDisk: { storageAccountType: 'Standard_LRS' }
      }
    }
    networkProfile: { networkInterfaces: [ { id: nicS2.id } ] }
  }
}
`;

console.log("[mft] starting deploy_bicep with multi-file input");
console.time("[mft] elapsed");
const result = await callCustomTool("deploy_bicep", {
  files: { "main.bicep": main, "network.bicep": network },
  entry: "main.bicep",
  scope: "subscription",
  location: "uksouth",
  required_tags: {
    "mcp-project": project,
    "mcp-topology-id": topologyId,
  },
});
console.timeEnd("[mft] elapsed");

console.log("[mft] is_error:", result.is_error);
console.log("[mft] content:");
console.log(typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2));

process.exit(result.is_error ? 1 : 0);

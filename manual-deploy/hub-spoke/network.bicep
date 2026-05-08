// Hub-spoke lab — RG-scoped resources.
// Native types only (no AVM modules — those defaults bit us last time:
// accelerated networking on B1s, encryptionAtHost without the feature
// registered, undocumented required params).

@description('Azure region for all resources.')
param location string

@description('Linux VM admin username.')
param adminUsername string

@secure()
@description('Linux VM admin password.')
param adminPassword string

@description('Common tags applied to every resource.')
param tags object

// ---------- NSG: allow SSH only from the hub VNet (Bastion sits there) ----------
resource nsgSpoke 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
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

// ---------- VNets ----------
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

resource spoke1Vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
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
          networkSecurityGroup: { id: nsgSpoke.id }
        }
      }
    ]
  }
}

resource spoke2Vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
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
          networkSecurityGroup: { id: nsgSpoke.id }
        }
      }
    ]
  }
}

// ---------- Peerings (bidirectional, no spoke-to-spoke) ----------
resource hubToSpoke1 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: hubVnet
  name: 'hub-to-spoke1'
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: spoke1Vnet.id }
  }
}

resource spoke1ToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: spoke1Vnet
  name: 'spoke1-to-hub'
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: hubVnet.id }
  }
}

// Each peering is a child write on its parent VNet, AND ARM also
// validates the remote VNet is not concurrently being modified.
// That means we must serialize ALL four peerings into a single chain
// (hubToSpoke1 → spoke1ToHub → hubToSpoke2 → spoke2ToHub) — partial
// serialization (e.g. just chaining the two hub-side ones) is not
// enough. Without this, spoke2-to-hub races against the hub's
// in-flight hub-to-spoke2 write and fails with ReferencedResourceNotProvisioned.
resource hubToSpoke2 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: hubVnet
  name: 'hub-to-spoke2'
  // Wait until BOTH the hub-side and spoke-side of the spoke1 peering
  // are settled before touching the hub VNet again.
  dependsOn: [ hubToSpoke1, spoke1ToHub ]
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: spoke2Vnet.id }
  }
}

resource spoke2ToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = {
  parent: spoke2Vnet
  name: 'spoke2-to-hub'
  // Wait for hub-to-spoke2 to fully complete — otherwise the hub
  // VNet is in 'Updating' state and ARM rejects this write with
  // ReferencedResourceNotProvisioned even though we're writing to
  // the spoke side.
  dependsOn: [ hubToSpoke2 ]
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: { id: hubVnet.id }
  }
}

// ---------- Bastion (hub) ----------
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
            id: '${hubVnet.id}/subnets/AzureBastionSubnet'
          }
          publicIPAddress: { id: bastionPip.id }
        }
      }
    ]
  }
}

// ---------- Spoke1 NIC + VM ----------
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
          subnet: {
            id: '${spoke1Vnet.id}/subnets/vm-subnet'
          }
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
    networkProfile: {
      networkInterfaces: [ { id: nicS1.id } ]
    }
  }
}

// ---------- Spoke2 NIC + VM ----------
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
          subnet: {
            id: '${spoke2Vnet.id}/subnets/vm-subnet'
          }
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
    networkProfile: {
      networkInterfaces: [ { id: nicS2.id } ]
    }
  }
}

output spoke1VmName string = vmS1.name
output spoke2VmName string = vmS2.name
output bastionName string = bastion.name

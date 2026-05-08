// Hub-spoke lab — sub-scope entry point.
// Creates the resource group, then delegates RG-scoped resources to a
// sibling module file (network.bicep) which Bicep compiles in-place.

targetScope = 'subscription'

@description('Project tag value used for grouping resources.')
param projectName string = 'hub-spoke-claude'

@description('Azure region for all resources.')
param location string = 'uksouth'

@description('Linux VM admin username (NOT one of the reserved names).')
param adminUsername string = 'azureuser'

@secure()
@description('Linux VM admin password — 12+ chars, 3 of 4 classes, must not contain the username.')
param adminPassword string

@secure()
@description('Per-deployment id used in the mcp-deployment-id tag.')
param deploymentId string = newGuid()

@description('Deployment timestamp used in the mcp-deployed-at tag.')
param deployedAt string = utcNow()

var commonTags = {
  'mcp-project': projectName
  'mcp-deployment-id': deploymentId
  'mcp-deployed-at': deployedAt
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${projectName}'
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

# Microsoft's Bicep MCP server, packaged as a one-shot image our
# backend can spawn via stdio. The published tool is a .NET 10 global
# tool — we install it into a base SDK image and set PATH so the
# binary is invokable as ENTRYPOINT.

FROM mcr.microsoft.com/dotnet/sdk:10.0

# Install the official Microsoft package. Pin a specific version once
# you've validated it; latest is fine for the homelab.
RUN dotnet tool install --global Azure.Bicep.McpServer

ENV PATH="${PATH}:/root/.dotnet/tools"

# Run as stdio MCP server. The tool talks JSON-RPC on stdin/stdout
# (default MCP transport), which our @modelcontextprotocol/sdk client
# consumes.
ENTRYPOINT ["Azure.Bicep.McpServer"]

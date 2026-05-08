# AWS Labs' aws-api-mcp-server, packaged as a one-shot image our
# backend can spawn via stdio. Sibling to bicep-mcp/.
#
# The package is published on PyPI as `awslabs.aws-api-mcp-server`.
# We install it into a Python slim image and run as the ENTRYPOINT.
# AWS auth (SSO) comes from the host's ~/.aws mounted at /root/.aws
# read-only by the spawning command — see backend/src/mcp/aws-client.ts.
#
# Why uv instead of pip: uv resolves + installs an order of magnitude
# faster, and the awslabs MCP servers ship instructions for both
# `uvx` and pip. We use uv at build time to produce a lean image
# that doesn't carry pip's wheel cache.

FROM python:3.12-slim

# uv is a fast Python package manager that handles the install
# without us needing to fight pip vs poetry vs hatch tooling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -LsSf https://astral.sh/uv/install.sh | sh \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"

# Pin to the package's published name; latest is fine for the homelab.
# The console entry point installed by this package is also called
# `awslabs.aws-api-mcp-server` (matches the dotted module path).
RUN uv tool install awslabs.aws-api-mcp-server

# Default region — overridable per spawn via -e AWS_REGION=...
ENV AWS_REGION=us-east-1
# The MCP server is read-mostly by default. The package has a
# write-mode flag for environments where mutating actions are wanted;
# we leave it OFF here because all mutating actions in azure-mcp go
# through our own deploy_cloudformation / destroy_aws custom tools
# which carry tag enforcement and safety guards.
ENV READ_OPERATIONS_ONLY=true

# Run as stdio MCP server.
ENTRYPOINT ["awslabs.aws-api-mcp-server"]

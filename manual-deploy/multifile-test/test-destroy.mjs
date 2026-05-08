// Tear-down counterpart to test-multifile.mjs — drives the destroy_azure
// custom tool with a tag filter that matches the previous test deploy.

import { callCustomTool } from "/app/dist/claude/custom-tools.js";

console.log("[mft] tear-down via destroy_azure tag_filters");
console.time("[mft] elapsed");
const result = await callCustomTool("destroy_azure", {
  tag_filters: {
    "mcp-project": "mft",
    "mcp-topology-id": "11111111-1111-1111-1111-111111111111",
  },
});
console.timeEnd("[mft] elapsed");

console.log("[mft] is_error:", result.is_error);
console.log("[mft] content:");
console.log(typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2));

process.exit(result.is_error ? 1 : 0);

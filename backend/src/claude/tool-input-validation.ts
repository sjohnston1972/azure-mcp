// Input validation for the deploy/destroy custom tools.
//
// WHY THIS FILE EXISTS
// --------------------
// `custom-tools.ts` runs cloud CLI commands inside a throwaway container
// that holds live Azure/AWS credentials. The arguments for those commands
// come from Claude's tool calls — and in an agentic loop those arguments
// are influenced by text we do not control (existing resource names, tags,
// MCP tool output, error messages). A prompt-injection payload hidden in
// any of that could steer the model into emitting a hostile resource-group
// name or tag value.
//
// The *structural* defence is in custom-tools.ts: dynamic values are handed
// to the container as environment variables, never pasted into the shell
// script text, so a shell metacharacter has nothing to break out of. This
// file is the second layer — an allowlist check that rejects anything that
// doesn't look like a real cloud identifier long before a container spawns.
//
// Both layers matter. The env-var layer stops shell injection; this layer
// also covers the JMESPath query strings (`--query "[?tags.\"k\"=='v']"`),
// where a stray quote would still change the meaning of the query even
// though it can never execute a command.
//
// Every validator returns `null` when the value is fine, or a human-readable
// error string naming the offending field. Callers surface that string to
// Claude as an `is_error` tool result and spawn nothing.

/** Azure resource group: 1-90 chars of alphanumerics, underscore, period,
 *  parentheses, hyphen. Cannot end with a period. Microsoft's documented
 *  rule — deliberately not widened. */
export const AZURE_RG_RE = /^[a-zA-Z0-9._()-]{1,90}$/;

/** Azure region short name, e.g. `uksouth`, `eastus2`. Lowercase
 *  alphanumerics only — the display-name form ("UK South") is not
 *  accepted by the CLI flags we use anyway. */
export const AZURE_LOCATION_RE = /^[a-z0-9]{1,40}$/;

/** ARM deployment name, e.g. `azmcp-1a2b3c4d`. */
export const DEPLOYMENT_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** AWS region, e.g. `us-east-1`, `eu-west-2`, `ap-southeast-3`. */
export const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

/** CloudFormation stack name: letter first, then alphanumerics and
 *  hyphens, up to 128 chars. (Previously inline in runDeployCloudFormation
 *  — hoisted here so deploy and destroy share one definition.) */
export const CFN_STACK_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,127}$/;

/** Tag key charset. Azure and AWS both allow a wider set than this
 *  (Azure permits most Unicode), but every tag this tool writes or
 *  queries is of the `mcp-*` family, so a strict allowlist costs us
 *  nothing and removes the whole quoting problem. */
export const TAG_KEY_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** Tag value charset. Deliberately excludes the quote characters, `$`,
 *  backtick, `;`, `\` and every control character — the union of what
 *  is dangerous in a shell word and inside a JMESPath string literal.
 *  Spaces, colons and slashes are allowed because real tag values use
 *  them (ISO-8601 timestamps, resource paths). */
export const TAG_VALUE_RE = /^[a-zA-Z0-9 ._:/-]{1,256}$/;

/**
 * Validate one scalar string against a regex.
 *
 * @param field  the tool-input field name, used verbatim in the error so
 *               Claude knows exactly which argument to fix
 * @param value  the value to check; `undefined` passes (callers decide
 *               separately whether a field is required)
 */
export function validateScalar(
  field: string,
  value: string | undefined,
  re: RegExp,
  hint: string
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return `\`${field}\` must be a string`;
  }
  if (!re.test(value)) {
    // We echo the rejected value back (truncated) because the model needs
    // to see what it sent to correct itself. It is inert in a tool result.
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    return `\`${field}\` is not a valid value: '${shown}'. ${hint}`;
  }
  // Azure resource-group names may not end in a period — the charset
  // regex can't express that, so it's a separate check.
  if (re === AZURE_RG_RE && value.endsWith(".")) {
    return `\`${field}\` must not end with a period.`;
  }
  return null;
}

/** Convenience wrappers so call sites read as prose. */
export const validateAzureLocation = (field: string, v?: string) =>
  validateScalar(
    field,
    v,
    AZURE_LOCATION_RE,
    "Use the region's short name, lowercase and unpunctuated (e.g. 'uksouth', 'eastus2')."
  );

export const validateAzureResourceGroup = (field: string, v?: string) =>
  validateScalar(
    field,
    v,
    AZURE_RG_RE,
    "Azure resource group names are 1-90 characters of letters, digits, '.', '_', '(', ')' and '-', and may not end with a period."
  );

export const validateDeploymentName = (field: string, v?: string) =>
  validateScalar(
    field,
    v,
    DEPLOYMENT_NAME_RE,
    "Deployment names are 1-64 characters of letters, digits, '.', '_' and '-'."
  );

export const validateAwsRegion = (field: string, v?: string) =>
  validateScalar(
    field,
    v,
    AWS_REGION_RE,
    "Use an AWS region code such as 'us-east-1' or 'eu-west-2'."
  );

export const validateStackName = (field: string, v?: string) =>
  validateScalar(
    field,
    v,
    CFN_STACK_NAME_RE,
    "CloudFormation stack names are 1-128 characters: a letter, then letters, digits and hyphens."
  );

/**
 * Validate a whole tag map. Used for `required_tags` on the deploy tools
 * and `tag_filters` on the destroy tools.
 *
 * Only entries with a non-empty key AND value are considered — the
 * handlers filter blanks out before use, so a blank pair is dropped
 * rather than rejected. That means an all-blank map validates as "empty";
 * pass `requireAtLeastOne` when the caller cannot safely proceed with an
 * empty effective filter (destroy, notably).
 */
export function validateTags(
  field: string,
  tags: Record<string, string> | undefined,
  opts: { requireAtLeastOne?: boolean } = {}
): string | null {
  if (tags === undefined) {
    return opts.requireAtLeastOne
      ? `\`${field}\` is required and must contain at least one tag.`
      : null;
  }
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    return `\`${field}\` must be an object of tag key → value.`;
  }
  let kept = 0;
  for (const [k, v] of Object.entries(tags)) {
    // Blank pairs are dropped by the handlers, so don't fail on them.
    if (!k || !v) continue;
    kept++;
    if (typeof v !== "string") {
      return `\`${field}\` value for key '${k}' must be a string.`;
    }
    if (!TAG_KEY_RE.test(k)) {
      const shown = k.length > 60 ? `${k.slice(0, 60)}…` : k;
      return `\`${field}\` has an invalid tag key '${shown}'. Tag keys are 1-128 characters of letters, digits, '.', '_' and '-'.`;
    }
    if (!TAG_VALUE_RE.test(v)) {
      const shown = v.length > 60 ? `${v.slice(0, 60)}…` : v;
      return `\`${field}\` has an invalid value for tag '${k}': '${shown}'. Tag values are 1-256 characters of letters, digits, spaces, '.', '_', ':', '/' and '-'. Quotes, backticks, '$', ';' and backslashes are not allowed.`;
    }
  }
  if (kept === 0 && opts.requireAtLeastOne) {
    return `\`${field}\` must contain at least one tag with a non-empty key and value.`;
  }
  return null;
}

/** Tag keys that anchor a destroy to a single project. `mcp-project` is
 *  the current convention (see the chat system prompt); `azure-mcp-project`
 *  is the older name still present in some docs and early deployments. */
export const PROJECT_ANCHOR_TAG_KEYS = ["mcp-project", "azure-mcp-project"];

/**
 * Guard for tag-filter destroys: the filter must name a project.
 *
 * Without this, a single generic tag (`env=lab`) is enough to sweep the
 * whole subscription, because the destroy path lists every resource group
 * the service principal can see and deletes each match. Requiring the
 * project anchor bounds the blast radius to one project by construction.
 */
export function requireProjectAnchor(
  field: string,
  tagEntries: [string, string][]
): string | null {
  const hasAnchor = tagEntries.some(
    ([k, v]) => PROJECT_ANCHOR_TAG_KEYS.includes(k) && v.trim().length > 0
  );
  if (hasAnchor) return null;
  return (
    `\`${field}\` must include a non-empty project anchor tag ` +
    `(one of: ${PROJECT_ANCHOR_TAG_KEYS.map((k) => `'${k}'`).join(", ")}). ` +
    `Destroying by an unanchored tag filter could match resources across the whole subscription, so it is refused. ` +
    `Add the active project's tag and try again.`
  );
}

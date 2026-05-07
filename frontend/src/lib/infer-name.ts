// Infer a short (≤16 char) topology name from a free-text user
// prompt. Strip stopwords, kebab-case, fit as many significant words
// as we can. Falls back to a UUID-ish suffix if there's nothing
// meaningful left after filtering.

const STOPWORDS = new Set([
  // Articles, prepositions, conjunctions
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at",
  "with", "from", "as", "by", "into", "onto", "via", "per", "plus",
  // Pronouns
  "i", "me", "my", "you", "your", "we", "us", "our", "it",
  // Verb particles (often follow phrasal verbs like "set up", "spin up")
  "up", "out", "down", "off", "over", "back",
  // Verbs the user is likely to use to ask for an architecture
  "build", "create", "design", "plan", "make", "set", "setup", "set-up",
  "deploy", "spin", "stand", "stand-up", "draft", "sketch", "propose",
  "draw", "lay", "lay-out", "configure", "wire", "rig",
  // Hedges
  "want", "need", "would", "like", "please", "let", "lets", "give",
  "show", "could", "should", "may", "can", "do",
  // Size / qualifier adjectives
  "tiny", "small", "minimal", "simple", "basic", "test", "demo",
  "quick", "little", "big", "large", "single", "one", "two", "three",
  "four", "five",
  // Generic / meta
  "azure", "cloud", "thing", "stuff", "some", "any", "all", "this",
  "that", "these", "those", "is", "are", "be", "got", "having", "have",
  "just", "now", "then",
]);

const MAX_LEN = 16;

export function inferTopologyName(prompt: string): string {
  if (!prompt || typeof prompt !== "string") return shortFallback();

  // Lowercase, keep alphanumerics, hyphens, and whitespace; collapse
  // any other punctuation into spaces.
  const cleaned = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w));

  if (words.length === 0) return shortFallback();

  // Greedy fit — keep adding words while the kebab-case result stays
  // ≤ MAX_LEN. If the first word alone is too long, truncate it.
  let name = "";
  for (const w of words) {
    const candidate = name ? `${name}-${w}` : w;
    if (candidate.length > MAX_LEN) break;
    name = candidate;
  }
  if (!name) {
    const first = words[0] ?? "";
    name = first.slice(0, MAX_LEN);
  }
  return name || shortFallback();
}

function shortFallback(): string {
  // 6-char base36 — visually distinct, no collision risk in practice.
  return `topo-${Math.random().toString(36).slice(2, 8)}`;
}

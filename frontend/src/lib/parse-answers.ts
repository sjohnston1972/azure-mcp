// Parse Claude's <answers>opt1 | opt2 | opt3</answers> marker out of
// a text block. The marker is stripped from the displayed text and the
// options surface as clickable chips below the message.

export type ParsedAnswers = {
  /** The text with the <answers>...</answers> block removed. */
  text: string;
  /** The parsed options if a closed marker was found, else null. */
  options: string[] | null;
  /** True if we saw an opening tag without a closing tag — i.e. the
   *  marker is mid-stream. We use this to suppress the partial tag in
   *  the rendered text rather than show "<answers>foo |" as text. */
  pending: boolean;
};

const RE = /<answers>([\s\S]*?)<\/answers>\s*$/i;
const OPEN_RE = /<answers>[\s\S]*$/i;

export function parseAnswers(text: string): ParsedAnswers {
  const match = text.match(RE);
  if (match && match[1] !== undefined) {
    const stripped = text.slice(0, match.index).trimEnd();
    const options = match[1]
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 6); // Cap at 6 to keep the chip row sane.
    return {
      text: stripped,
      options: options.length > 0 ? options : null,
      pending: false,
    };
  }

  // Look for an unclosed opening tag — the marker is still streaming.
  // Hide the partial so the user doesn't see "<answers>" mid-thought.
  const open = text.match(OPEN_RE);
  if (open && open.index !== undefined) {
    return {
      text: text.slice(0, open.index).trimEnd(),
      options: null,
      pending: true,
    };
  }

  return { text, options: null, pending: false };
}

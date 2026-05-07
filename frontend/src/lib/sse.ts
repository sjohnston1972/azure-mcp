// Minimal Server-Sent Events parser for fetch().
//
// Browsers expose EventSource for SSE but EventSource only supports GET
// — and we POST a chat message body. This wraps a fetch ReadableStream
// and yields parsed { event, data } pairs as they arrive.

export type SSEMessage = { event: string; data: string };

export async function* sseStream(
  response: Response
): AsyncGenerator<SSEMessage, void, void> {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Events are separated by a blank line per the SSE spec.
      let split = buf.indexOf("\n\n");
      while (split !== -1) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const parsed = parseEvent(raw);
        if (parsed) yield parsed;
        split = buf.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): SSEMessage | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    // We ignore id: / retry: / comment lines for now.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

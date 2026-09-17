// Minimal Server-Sent Events reader for streamed chat completions. It accepts both LF and CRLF,
// ignores non-data fields, and processes a final event even when the connection closes without a
// trailing newline.

export async function readSseJson(stream, onValue) {
  if (!stream) {
    throw new Error("The response had no readable stream.");
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  const consume = line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") {
      return;
    }
    let value;
    try {
      value = JSON.parse(trimmed.slice(5));
    } catch {
      // A malformed event is isolated; later events can still complete the reply.
      return;
    }
    onValue(value);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      consume(line);
    }
  }
  if (buffer.trim()) {
    consume(buffer);
  }
}

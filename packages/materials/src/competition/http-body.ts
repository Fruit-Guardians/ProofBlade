/**
 * Read an HTTP response as UTF-8 text without allowing an unbounded body to
 * enter the process heap. Real fetch Responses expose a ReadableStream, so the
 * limit is enforced before concatenating the bytes; the text-only fallback is
 * retained for small test doubles and older fetch implementations.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} response exceeds ${maxBytes} bytes`);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

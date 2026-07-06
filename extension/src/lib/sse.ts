/**
 * Мінімальний парсер Server-Sent Events поверх fetch + ReadableStream.
 * Використовується для стріму відповіді AI з POST /v1/chat (ТЗ §5).
 */

/** Розбирає потік байтів SSE і повертає значення полів `data:` по одному. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Події розділяються порожнім рядком.
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (data.length > 0) {
          if (data === '[DONE]') return;
          yield data;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Дістає текстову дельту з data-пейлоада: або JSON {"delta": "..."}, або сирий текст. */
export function extractDelta(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'delta' in parsed &&
      typeof (parsed as { delta: unknown }).delta === 'string'
    ) {
      return (parsed as { delta: string }).delta;
    }
  } catch {
    // не JSON — вважаємо сирим текстом
  }
  return data;
}

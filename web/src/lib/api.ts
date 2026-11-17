// Typed fetch wrapper + SSE client for the chat stream.

export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check that the API is running and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = body as { error?: string; fields?: Record<string, string> } | null;
    throw new ApiError(res.status, b?.error ?? `Request failed (${res.status})`, b?.fields);
  }
  return body as T;
}

export interface StreamHandlers {
  onEvent: (event: string, data: any) => void;
}

/** POST and read a text/event-stream response. Resolves when the stream ends. */
export async function postStream(path: string, json: unknown, handlers: StreamHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(json), signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok || !res.body) {
    let msg = `Request failed (${res.status})`;
    try {
      const b = await res.json();
      msg = b.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        try {
          handlers.onEvent(event, JSON.parse(data.join("\n")));
        } catch {
          /* malformed event; skip */
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
}

import { createParser } from "eventsource-parser";

export type ChatMessage = {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  model: string;
  status: string;
  references?: Reference[];
  rag?: boolean;
};
export type KnowledgeDocument = {
  id: string;
  name: string;
  sha256: string;
  created_at: string;
  size_bytes: number;
  chunk_count: number;
};
export type Reference = {
  citation: number;
  document_id: string;
  name: string;
  sha256: string;
  start_line: number;
  end_line: number;
  content: string;
};
export type Conversation = {
  id: string;
  title: string;
  updated_at: string;
  messages?: ChatMessage[];
};
export type Model = { id: string; name: string; provider: string };
export type Status = { api_enabled: boolean; endpoint: string };
export type StreamEvent = {
  request_id?: string;
  content?: string;
  status?: string;
  error?: string;
  references?: Reference[];
  rag?: boolean;
};

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error?.message ?? `接続に失敗しました (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

let authentication: Promise<Status> | undefined;
export function initialize(): Promise<Status> {
  if (!authentication) {
    const code = new URLSearchParams(window.location.hash.slice(1)).get(
      "setup",
    );
    window.history.replaceState(null, "", window.location.pathname);
    authentication = (async () => {
      if (code)
        await request("/auth/session", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
      return request<Status>("/ui/status");
    })();
  }
  return authentication;
}

export async function streamChat(
  path: string,
  body: object,
  signal: AbortSignal,
  receive: (event: string, data: StreamEvent) => void,
) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message ?? "生成を開始できませんでした。");
  }
  if (!response.body) throw new Error("ストリームを取得できませんでした。");
  let ended = false;
  const parser = createParser({
    onEvent: (event) => {
      if (event.event === "done") ended = true;
      receive(event.event ?? "message", JSON.parse(event.data));
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    parser.feed(decoder.decode());
    if (!ended)
      throw new Error(
        "接続が途中で切れました。保存済みの内容を確認してください。",
      );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

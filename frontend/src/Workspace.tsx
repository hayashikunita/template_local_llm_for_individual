import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  Cpu,
  FileText,
  KeyRound,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
  Pencil,
  FlaskConical,
} from "lucide-react";
import { initialize, request, streamChat } from "./api";
import type { ChatMessage, Conversation, Model, Status } from "./api";

const demo = "demo-preview";
const statusLabels: Record<string, string> = {
  complete: "完了",
  generating: "生成中",
  cancelled: "停止済み",
  interrupted: "中断",
  error: "失敗",
};

export default function Workspace() {
  const [authenticated, setAuthenticated] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>({
    api_enabled: false,
    endpoint: "http://127.0.0.1:11434",
  });
  const [models, setModels] = useState<Model[]>([
    { id: demo, name: "接続テスト（LLMではありません）", provider: "demo" },
  ]);
  const [ollama, setOllama] = useState("unavailable");
  const [model, setModel] = useState(
    localStorage.getItem("local-llm-model") ?? demo,
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [view, setView] = useState<"chat" | "api">("chat");
  const [sidebar, setSidebar] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(512);
  const [apiToken, setApiToken] = useState("");
  const [apiWorking, setApiWorking] = useState(false);
  const [copied, setCopied] = useState("");
  const [modal, setModal] = useState<"delete" | "rename" | null>(null);
  const [title, setTitle] = useState("");
  const abort = useRef<AbortController | null>(null);
  const requestId = useRef<string | null>(null);
  const tail = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = conversations.find((item) => item.id === active);

  async function refreshModels() {
    const result = await request<{ models: Model[]; ollama: string }>(
      "/ui/models",
    );
    setModels(result.models);
    setOllama(result.ollama);
  }

  useEffect(() => {
    let cancelled = false;
    void initialize()
      .then(async (result) => {
        const [items, catalog] = await Promise.all([
          request<Conversation[]>("/ui/conversations"),
          request<{ models: Model[]; ollama: string }>("/ui/models"),
        ]);
        if (cancelled) return;
        setStatus(result);
        setConversations(items);
        setModels(catalog.models);
        setOllama(catalog.ollama);
        setAuthenticated(true);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason.message));
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [messages]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);

  async function openConversation(identity: string) {
    if (busy || switching) return;
    setSwitching(true);
    setError("");
    try {
      const item = await request<Conversation>(`/ui/conversations/${identity}`);
      setActive(identity);
      setMessages(item.messages ?? []);
      setView("chat");
      setSidebar(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  function newConversation() {
    if (busy || switching) return;
    setActive(null);
    setMessages([]);
    setInput("");
    setError("");
    setView("chat");
    setSidebar(false);
    editor.current?.focus();
  }

  async function send() {
    if (!input.trim() || busy || !authenticated || switching) return;
    const content = input.trim();
    setBusy(true);
    setError("");
    setInput("");
    requestId.current = null;
    const controller = new AbortController();
    abort.current = controller;
    let identity = active;
    try {
      if (!identity) {
        const created = await request<Conversation>("/ui/conversations", {
          method: "POST",
          body: JSON.stringify({ title: content.slice(0, 36) }),
        });
        identity = created.id;
        setActive(identity);
        setConversations((previous) => [created, ...previous]);
      }
      setMessages((previous) => [
        ...previous,
        {
          id: "sending-user",
          role: "user",
          content,
          model,
          status: "complete",
        },
        {
          id: "streaming",
          role: "assistant",
          content: "",
          model,
          status: "generating",
        },
      ]);
      await streamChat(
        `/ui/conversations/${identity}/chat`,
        { content, model, temperature, max_tokens: maxTokens },
        controller.signal,
        (name, data) => {
          if (name === "start") requestId.current = data.request_id ?? null;
          if (name === "delta")
            setMessages((previous) =>
              previous.map((item) =>
                item.id === "streaming"
                  ? { ...item, content: item.content + (data.content ?? "") }
                  : item,
              ),
            );
          if (name === "done") {
            setMessages((previous) =>
              previous.map((item) =>
                item.id === "streaming"
                  ? {
                      ...item,
                      content: data.content ?? item.content,
                      status: data.status ?? "complete",
                    }
                  : item,
              ),
            );
            if (data.error) setError(data.error);
          }
        },
      );
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") {
        setError((reason as Error).message);
        setInput(content);
      }
    } finally {
      if (identity) {
        try {
          const saved = await request<Conversation>(
            `/ui/conversations/${identity}`,
          );
          setMessages(saved.messages ?? []);
          setConversations(await request<Conversation[]>("/ui/conversations"));
        } catch (reason) {
          setError((reason as Error).message);
        }
      }
      abort.current = null;
      requestId.current = null;
      setBusy(false);
      editor.current?.focus();
    }
  }

  async function stop() {
    try {
      if (requestId.current)
        await request(`/ui/generations/${requestId.current}/cancel`, {
          method: "POST",
        });
      else abort.current?.abort();
    } catch (reason) {
      setError((reason as Error).message);
      abort.current?.abort();
    }
  }

  async function confirmModal() {
    if (!active) return;
    try {
      if (modal === "delete") {
        await request(`/ui/conversations/${active}`, { method: "DELETE" });
        newConversation();
      } else
        await request(`/ui/conversations/${active}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        });
      setConversations(await request<Conversation[]>("/ui/conversations"));
      setModal(null);
    } catch (reason) {
      setModal(null);
      setError((reason as Error).message);
    }
  }

  async function apiAction(enable: boolean) {
    setApiWorking(true);
    setError("");
    try {
      if (enable) {
        const result = await request<{ token: string }>("/ui/api-token", {
          method: "POST",
        });
        setApiToken(result.token);
      } else {
        await request("/ui/api-token", { method: "DELETE" });
        setApiToken("");
      }
      setStatus(await request<Status>("/ui/status"));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setApiWorking(false);
    }
  }

  async function copy(text: string, identity: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(identity);
    } catch {
      setError("クリップボードにコピーできませんでした。");
    }
  }

  const apiExample = `$headers = @{ Authorization = "Bearer $env:LOCAL_LLM_API_KEY" }\n$body = @{\n  model = "${demo}"\n  messages = @(@{ role = "user"; content = "Hello" })\n  stream = $false\n} | ConvertTo-Json -Depth 4\nInvoke-RestMethod -Uri "${location.origin}/api/v1/chat" -Method Post -Headers $headers -ContentType "application/json" -Body $body`;

  return (
    <div className="workspace">
      {sidebar && (
        <button
          className="scrim"
          aria-label="メニューを閉じる"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Cpu size={23} />
          </div>
          <div>
            <strong>Local LLM</strong>
            <span>PERSONAL WORKSPACE</span>
          </div>
        </div>
        <button
          className="new-chat"
          onClick={newConversation}
          disabled={busy || switching}
        >
          <Plus size={18} />
          新しい会話
        </button>
        <nav aria-label="ワークスペース">
          <button
            className={view === "chat" ? "nav-item selected" : "nav-item"}
            onClick={() => {
              setView("chat");
              setSidebar(false);
            }}
          >
            <MessageSquare size={17} />
            チャット
          </button>
          <button
            className={view === "api" ? "nav-item selected" : "nav-item"}
            onClick={() => {
              setView("api");
              setSidebar(false);
            }}
          >
            <Code2 size={17} />
            API連携
            <span
              className={`tiny-dot ${status.api_enabled ? "online" : ""}`}
            />
          </button>
        </nav>
        <div className="history-heading">
          <span>会話履歴</span>
          <span className="mono">{conversations.length}</span>
        </div>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="会話を検索"
            placeholder="タイトルで検索"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <div className="history-list">
          {conversations
            .filter((item) =>
              item.title
                .toLocaleLowerCase()
                .includes(filter.toLocaleLowerCase()),
            )
            .map((item) => (
              <button
                key={item.id}
                className={`history-item ${item.id === active ? "active" : ""}`}
                disabled={busy || switching}
                onClick={() => void openConversation(item.id)}
              >
                <MessageSquare size={15} />
                <span>{item.title}</span>
                <ChevronRight size={13} />
              </button>
            ))}
          {!conversations.length && (
            <p className="history-empty">会話はまだありません</p>
          )}
        </div>
        <div className="local-status">
          <ShieldCheck size={18} />
          <div>
            <strong>端末内のワークスペース</strong>
            <span>検証専用 · RAG未対応</span>
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="avatar">L</span>
          <span>
            ローカルユーザー<small>PROTOTYPE / 0.1</small>
          </span>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            title="メニュー"
            aria-label="メニュー"
            onClick={() => setSidebar(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>ワークスペース</span>
            <ChevronRight size={13} />
            <strong>{view === "api" ? "API連携" : "チャット"}</strong>
          </div>
          <span className="prototype-badge">
            <FlaskConical size={13} />
            検証版
          </span>
          <button
            className={`icon-button ${settingsOpen ? "pressed" : ""}`}
            title="生成設定"
            aria-label="生成設定"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings2 size={18} />
          </button>
        </header>

        {!ready ? (
          <div className="locked">
            <Cpu className="spin" />
            <h1>接続しています</h1>
          </div>
        ) : !authenticated ? (
          <div className="locked">
            <KeyRound size={34} />
            <h1>この画面はロックされています</h1>
            <p>{error}</p>
            <p>起動コマンドから開いたブラウザーをご利用ください。</p>
            <button onClick={() => location.reload()}>再接続</button>
          </div>
        ) : (
          <>
            {error && (
              <div className="error-banner" role="alert">
                <CircleHelp size={18} />
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="エラーを閉じる"
                  onClick={() => setError("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {settingsOpen && (
              <section className="settings-strip" aria-label="生成設定">
                <label>
                  温度 <output>{temperature.toFixed(1)}</output>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={temperature}
                    disabled={busy}
                    onChange={(event) =>
                      setTemperature(Number(event.target.value))
                    }
                  />
                </label>
                <label>
                  最大出力トークン
                  <input
                    type="number"
                    min="16"
                    max="2048"
                    value={maxTokens}
                    disabled={busy}
                    onChange={(event) =>
                      setMaxTokens(
                        Math.max(
                          16,
                          Math.min(2048, Number(event.target.value)),
                        ),
                      )
                    }
                  />
                </label>
                <div className="endpoint-detail">
                  <span>OLLAMA</span>
                  <code>{status.endpoint}</code>
                  <strong>
                    {ollama === "connected" ? "接続済み" : "未接続"}
                  </strong>
                </div>
              </section>
            )}

            {view === "api" ? (
              <div className="api-view">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">DEVELOPER ACCESS</span>
                    <h1>API連携</h1>
                  </div>
                  <span
                    className={`state-badge ${status.api_enabled ? "on" : ""}`}
                  >
                    {status.api_enabled ? "有効" : "無効"}
                  </span>
                </div>
                <section className="api-access">
                  <KeyRound size={22} />
                  <div>
                    <h2>ローカルAPIキー</h2>
                    <p>有効期限：発行から1時間 / 再起動で失効</p>
                  </div>
                  <div className="api-actions">
                    <button
                      className="primary"
                      disabled={apiWorking}
                      onClick={() => void apiAction(true)}
                    >
                      {status.api_enabled ? "キーを再発行" : "APIを有効にする"}
                    </button>
                    {status.api_enabled && (
                      <button
                        disabled={apiWorking}
                        onClick={() => void apiAction(false)}
                      >
                        無効にする
                      </button>
                    )}
                  </div>
                </section>
                {apiToken && (
                  <div className="token-box">
                    <label htmlFor="api-key">発行したキー</label>
                    <div>
                      <input
                        id="api-key"
                        type="password"
                        readOnly
                        value={apiToken}
                        autoComplete="off"
                      />
                      <button
                        className="icon-button"
                        aria-label="APIキーをコピー"
                        title="APIキーをコピー"
                        onClick={() => void copy(apiToken, "key")}
                      >
                        {copied === "key" ? (
                          <Check size={17} />
                        ) : (
                          <Copy size={17} />
                        )}
                      </button>
                    </div>
                  </div>
                )}
                <section className="endpoint-list">
                  <h2>エンドポイント</h2>
                  {[
                    ["GET", "/api/v1/models", "モデル一覧"],
                    ["POST", "/api/v1/chat", "回答生成 / SSE"],
                    ["POST", "/api/v1/generations/{id}/cancel", "生成の停止"],
                    ["GET", "/api/v1/health", "稼働状態"],
                    ["GET", "/api/v1/openapi.json", "OpenAPI仕様"],
                  ].map(([method, path, label]) => (
                    <div className="endpoint-row" key={path}>
                      <span
                        className={`method ${method === "POST" ? "post" : ""}`}
                      >
                        {method}
                      </span>
                      <code>{path}</code>
                      <span>{label}</span>
                    </div>
                  ))}
                </section>
                <section className="code-panel">
                  <div>
                    <h2>
                      <Terminal size={17} />
                      PowerShell
                    </h2>
                    <button
                      className="icon-button"
                      aria-label="APIサンプルをコピー"
                      title="コピー"
                      onClick={() => void copy(apiExample, "example")}
                    >
                      {copied === "example" ? (
                        <Check size={16} />
                      ) : (
                        <Copy size={16} />
                      )}
                    </button>
                  </div>
                  <pre>{apiExample}</pre>
                </section>
              </div>
            ) : (
              <>
                <section className="conversation-toolbar">
                  <div className="conversation-title">
                    <h1>{current?.title ?? "新しい会話"}</h1>
                    <span>
                      {messages.length
                        ? `${messages.filter((item) => item.role === "user").length} 件のメッセージ`
                        : "LOCAL SESSION"}
                    </span>
                  </div>
                  <div className="toolbar-actions">
                    {active && (
                      <>
                        <button
                          className="icon-button"
                          title="会話名を変更"
                          aria-label="会話名を変更"
                          disabled={busy}
                          onClick={() => {
                            setTitle(current?.title ?? "");
                            setModal("rename");
                          }}
                        >
                          <Pencil size={16} />
                        </button>
                        <a
                          className="icon-button"
                          title="JSONをエクスポート"
                          aria-label="JSONをエクスポート"
                          href={`/ui/conversations/${active}/export`}
                        >
                          <ArrowDownToLine size={17} />
                        </a>
                        <button
                          className="icon-button danger"
                          title="会話を削除"
                          aria-label="会話を削除"
                          disabled={busy}
                          onClick={() => setModal("delete")}
                        >
                          <Trash2 size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </section>
                <div className="model-bar">
                  <Cpu size={17} />
                  <select
                    aria-label="モデル"
                    value={model}
                    disabled={busy}
                    onChange={(event) => {
                      setModel(event.target.value);
                      localStorage.setItem(
                        "local-llm-model",
                        event.target.value,
                      );
                    }}
                  >
                    {!models.some((item) => item.id === model) && (
                      <option value={model}>{model}（利用不可）</option>
                    )}
                    {models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon-button"
                    title="モデル一覧を更新"
                    aria-label="モデル一覧を更新"
                    disabled={busy}
                    onClick={() =>
                      void refreshModels().catch((reason) =>
                        setError(reason.message),
                      )
                    }
                  >
                    <RefreshCw size={15} />
                  </button>
                  <span className="rag-status">
                    <FileText size={13} />
                    文書参照なし
                  </span>
                </div>
                {model === demo && (
                  <div className="demo-banner">
                    <FlaskConical size={15} />
                    <span>
                      接続テストモード：固定応答です。LLMは使用していません。
                    </span>
                  </div>
                )}
                <div
                  className="chat-scroll"
                  aria-label="会話メッセージ"
                  aria-busy={busy}
                >
                  {!messages.length ? (
                    <div className="empty-state">
                      <div className="empty-mark">
                        <MessageSquare size={33} strokeWidth={1.4} />
                        <span className="mark-accent" />
                      </div>
                      <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
                      <h2>ここから、会話をはじめる。</h2>
                      <div className="prompt-options">
                        {[
                          "短い文章の下書きを作りたい",
                          "考えを箇条書きで整理したい",
                          "接続テストを実行したい",
                        ].map((prompt) => (
                          <button
                            key={prompt}
                            onClick={() => {
                              setInput(prompt);
                              editor.current?.focus();
                            }}
                          >
                            <span>{prompt}</span>
                            <ArrowUp size={15} />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="messages">
                      {messages.map((item) => (
                        <article
                          key={item.id}
                          className={`message ${item.role}`}
                        >
                          <div className={`message-avatar ${item.role}`}>
                            {item.role === "user" ? "YOU" : <Cpu size={17} />}
                          </div>
                          <div className="message-main">
                            <div className="message-meta">
                              <strong>
                                {item.role === "user"
                                  ? "あなた"
                                  : item.model === demo
                                    ? "接続テスト"
                                    : item.model}
                              </strong>
                              {item.role === "assistant" && (
                                <span
                                  className={
                                    item.status === "error" ? "text-danger" : ""
                                  }
                                >
                                  {statusLabels[item.status] ?? item.status}
                                </span>
                              )}
                            </div>
                            <div className="message-text">
                              {item.content ||
                                (item.status === "generating" ? (
                                  <span className="typing">
                                    応答を待っています<span>...</span>
                                  </span>
                                ) : (
                                  "（出力なし）"
                                ))}
                            </div>
                            {item.role === "assistant" && item.content && (
                              <button
                                className="copy-message"
                                title="回答をコピー"
                                onClick={() =>
                                  void copy(item.content, String(item.id))
                                }
                              >
                                {copied === String(item.id) ? (
                                  <Check size={13} />
                                ) : (
                                  <Copy size={13} />
                                )}
                                <span>
                                  {copied === String(item.id)
                                    ? "コピー済み"
                                    : "コピー"}
                                </span>
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  <div ref={tail} />
                </div>
                <div className="composer-area">
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send();
                    }}
                  >
                    <textarea
                      ref={editor}
                      aria-label="メッセージ"
                      placeholder="メッセージを入力…"
                      maxLength={12000}
                      value={input}
                      disabled={busy || switching}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-bottom">
                      <span>
                        <ShieldCheck size={14} />
                        {busy ? "回答を生成しています" : "公開・架空データのみ"}
                      </span>
                      {busy ? (
                        <button
                          type="button"
                          className="send-button stop"
                          title="生成を停止"
                          aria-label="生成を停止"
                          onClick={() => void stop()}
                        >
                          <Square size={16} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          className="send-button"
                          type="submit"
                          title="送信"
                          aria-label="送信"
                          disabled={!input.trim() || switching}
                        >
                          <ArrowUp size={19} />
                        </button>
                      )}
                    </div>
                  </form>
                  <div className="composer-note">
                    検証専用です。機密情報・個人情報は入力しないでください。
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </main>
      <dialog ref={dialog} onCancel={() => setModal(null)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirmModal();
          }}
        >
          <h2>
            {modal === "delete" ? "会話を削除しますか？" : "会話名を変更"}
          </h2>
          {modal === "delete" ? (
            <p>この会話とメッセージを削除します。この操作は取り消せません。</p>
          ) : (
            <input
              aria-label="新しい会話名"
              value={title}
              maxLength={120}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => setModal(null)}>
              キャンセル
            </button>
            <button
              className={modal === "delete" ? "destructive" : "primary"}
              type="submit"
            >
              {modal === "delete" ? "削除する" : "保存する"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

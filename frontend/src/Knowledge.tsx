import { useRef, useState } from "react";
import { ArrowDownToLine, FileText, MessageSquare, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { request } from "./api";
import type { KnowledgeDocument, Reference } from "./api";

export function References({ sources }: { sources: Reference[] }) {
  return (
    <section className="references" aria-label="出典">
      {sources.map((source) => (
        <details key={`${source.citation}-${source.document_id}`}>
          <summary>[{source.citation}] {source.name} / 行 {source.start_line}–{source.end_line}</summary>
          <p className="reference-excerpt">{source.content}</p>
          <small className="source-hash">SHA-256: {source.sha256}</small>
          <a className="source-download" href={`/ui/documents/${source.document_id}/original`} download>
            <ArrowDownToLine size={14} />原本
          </a>
        </details>
      ))}
    </section>
  );
}

type Props = {
  documents: KnowledgeDocument[];
  selected: string[];
  busy: boolean;
  setDocuments: (documents: KnowledgeDocument[]) => void;
  setSelected: (selected: string[]) => void;
  onChat: () => void;
  onError: (error: string) => void;
};

export default function KnowledgePanel({ documents, selected, busy, setDocuments, setSelected, onChat, onError }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Reference[] | null>(null);
  const disabled = busy || working;

  async function refresh() {
    const items = await request<KnowledgeDocument[]>("/ui/documents");
    setDocuments(items);
    setSelected(selected.filter((identity) => items.some((item) => item.id === identity)));
    setResults(null);
  }

  async function upload(file: File) {
    setWorking(true);
    onError("");
    try {
      if (!/\.(txt|md)$/i.test(file.name) || file.size > 80000 || !file.size) {
        throw new Error("UTF-8のTXT・Markdownを選んでください（1件80,000バイト以下）。");
      }
      const document = await request<KnowledgeDocument>(`/ui/documents?name=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
      });
      setDocuments(await request<KnowledgeDocument[]>("/ui/documents"));
      if (selected.length < 20) setSelected([...selected, document.id]);
      setResults(null);
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setWorking(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(document: KnowledgeDocument) {
    if (!window.confirm(`「${document.name}」の原本と検索索引を完全削除しますか？過去の会話に保存した引用は残ります。`)) return;
    setWorking(true);
    onError("");
    try {
      await request(`/ui/documents/${document.id}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function search() {
    setWorking(true);
    onError("");
    setResults(null);
    try {
      const result = await request<{ references: Reference[] }>("/ui/documents/search", {
        method: "POST", body: JSON.stringify({ query, document_ids: selected }),
      });
      setResults(result.references);
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="knowledge-view">
      <div className="section-heading">
        <div><span className="eyebrow">LOCAL DOCUMENTS</span><h1>ナレッジ</h1></div>
        <span className="mono">{documents.length} / 100</span>
      </div>
      <section className="knowledge-actions" aria-label="文書登録">
        <input ref={fileInput} type="file" accept=".txt,.md" aria-label="文書ファイル" hidden
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        <button className="primary" disabled={disabled} onClick={() => fileInput.current?.click()}><Upload size={17} />{working ? "処理中" : "文書を登録"}</button>
        <span>TXT / MD · UTF-8 · 80,000 bytes</span>
        <button className="icon-button" title="文書一覧を更新" aria-label="文書一覧を更新" disabled={disabled}
          onClick={() => void refresh().catch((reason) => onError(reason.message))}><RefreshCw size={17} /></button>
      </section>
      <section className="document-list" aria-label="登録済み文書" aria-busy={working}>
        {!documents.length && <p className="knowledge-empty">登録済み文書はありません</p>}
        {documents.map((document) => (
          <div className="document-row" key={document.id}>
            <input type="checkbox" aria-label={`${document.name}を検索対象にする`} checked={selected.includes(document.id)}
              disabled={disabled || (!selected.includes(document.id) && selected.length >= 20)}
              onChange={(event) => { setSelected(event.target.checked ? [...selected, document.id] : selected.filter((identity) => identity !== document.id)); setResults(null); }} />
            <FileText size={19} />
            <div className="document-name"><strong>{document.name}</strong><small>検索可能 · {document.size_bytes.toLocaleString()} bytes · {document.chunk_count} 箇所</small></div>
            <a className="icon-button" title={`${document.name}の原本`} aria-label={`${document.name}の原本`} href={`/ui/documents/${document.id}/original`} download><ArrowDownToLine size={17} /></a>
            <button className="icon-button" title={`${document.name}を削除`} aria-label={`${document.name}を削除`} disabled={disabled} onClick={() => void remove(document)}><Trash2 size={17} /></button>
          </div>
        ))}
      </section>
      <section className="knowledge-search" aria-label="文書検索">
        <h2>選択文書 <span className="mono">{selected.length} / 20</span></h2>
        <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <input aria-label="文書の検索語句" value={query} minLength={2} maxLength={500} placeholder="検索語句" onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button" title="文書を検索" aria-label="文書を検索" disabled={disabled || !selected.length || query.trim().length < 2}><Search size={18} /></button>
        </form>
        <button disabled={disabled || !selected.length} onClick={onChat}><MessageSquare size={17} />選択文書で新しい会話</button>
        {results !== null && <div role="status">検索結果 {results.length} 件</div>}
        {results && <References sources={results} />}
      </section>
    </div>
  );
}
import hashlib
import re
import sqlite3
import unicodedata
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

from backend.storage import timestamp


MAX_DOCUMENT_BYTES = 80000
MAX_DOCUMENTS = 100


def normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


class Knowledge:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "knowledge.sqlite3"
        with self.connection() as database:
            database.executescript("""
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL, original BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY, document_id TEXT NOT NULL
                    REFERENCES documents(id) ON DELETE CASCADE,
                    start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
                    content TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                    content, tokenize='trigram'
                );
                CREATE TRIGGER IF NOT EXISTS chunks_deleted AFTER DELETE ON chunks BEGIN
                    DELETE FROM search_index WHERE rowid=old.id;
                END;
            """)

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as database, database:
            database.row_factory = sqlite3.Row
            database.execute("PRAGMA foreign_keys=ON")
            yield database

    def listing(self) -> list[dict]:
        with self.connection() as database:
            return [dict(row) for row in database.execute("""
                SELECT id, name, sha256, created_at, length(original) AS size_bytes,
                (SELECT count(*) FROM chunks WHERE document_id=documents.id) AS chunk_count
                FROM documents ORDER BY created_at DESC
            """)]

    def register(self, name: str, original: bytes) -> dict:
        if not name or len(name) > 120 or any(character in name for character in '/\\\x00\r\n'):
            raise ValueError("ファイル名が不正です。")
        if Path(name).suffix.lower() not in {".txt", ".md"}:
            raise ValueError("UTF-8のTXT・Markdownのみ登録できます。")
        if not original or len(original) > MAX_DOCUMENT_BYTES:
            raise ValueError("ファイルは空でなく、80,000バイト以下にしてください。")
        try:
            text = original.decode("utf-8-sig")
        except UnicodeDecodeError as exception:
            raise ValueError("UTF-8で保存したテキストを選んでください。") from exception
        if not text.strip() or any(ord(character) < 32 and character not in '\t\n\r' for character in text):
            raise ValueError("空白のみ、またはバイナリを含む文書は登録できません。")
        chunks = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            for offset in range(0, len(line), 700):
                fragment = line[offset:offset + 700]
                if not fragment.strip():
                    continue
                if chunks and len(chunks[-1][2]) + len(fragment) < 700:
                    start_line, _, previous = chunks[-1]
                    chunks[-1] = (start_line, line_number, previous + "\n" + fragment)
                else:
                    chunks.append((line_number, line_number, fragment))
        identity = uuid4().hex
        sha256 = hashlib.sha256(original).hexdigest()
        with self.connection() as database:
            if database.execute("SELECT 1 FROM documents WHERE sha256=?", (sha256,)).fetchone():
                raise ValueError("同じ内容の文書は登録済みです。")
            if database.execute("SELECT count(*) FROM documents").fetchone()[0] >= MAX_DOCUMENTS:
                raise ValueError("文書は100件までです。不要な文書を削除してください。")
            database.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)",
                             (identity, name, sha256, timestamp(), original))
            for start_line, end_line, content in chunks:
                cursor = database.execute(
                    "INSERT INTO chunks(document_id,start_line,end_line,content) VALUES (?,?,?,?)",
                    (identity, start_line, end_line, content),
                )
                database.execute("INSERT INTO search_index(rowid,content) VALUES (?,?)",
                                 (cursor.lastrowid, normalized(content)))
        return next(document for document in self.listing() if document["id"] == identity)

    def original(self, identity: str) -> bytes | None:
        with self.connection() as database:
            row = database.execute("SELECT original FROM documents WHERE id=?", (identity,)).fetchone()
            return bytes(row[0]) if row else None

    def delete(self, identity: str) -> bool:
        with self.connection() as database:
            return database.execute("DELETE FROM documents WHERE id=?", (identity,)).rowcount > 0

    def search(self, query: str, document_ids: list[str]) -> list[dict]:
        if not document_ids or not query.strip():
            return []
        terms = re.findall(r"[^\W_]+", normalized(query[:500]))
        grams = list(dict.fromkeys(
            term[offset:offset + 3] for term in terms for offset in range(len(term) - 2)
        ))[:64]
        placeholders = ','.join('?' for _ in document_ids)
        with self.connection() as database:
            if grams:
                expression = ' OR '.join('"' + gram + '"' for gram in grams)
                rows = database.execute(f"""
                    SELECT chunks.*, documents.name, documents.sha256
                    FROM search_index JOIN chunks ON chunks.id=search_index.rowid
                    JOIN documents ON documents.id=chunks.document_id
                    WHERE search_index MATCH ? AND document_id IN ({placeholders})
                    ORDER BY bm25(search_index), chunks.id LIMIT 4
                """, [expression, *document_ids]).fetchall()
            else:
                short_terms = [term for term in terms if len(term) >= 2][:16]
                rows = database.execute(f"""
                    SELECT chunks.*, documents.name, documents.sha256
                    FROM chunks JOIN documents ON documents.id=chunks.document_id
                    WHERE document_id IN ({placeholders}) ORDER BY chunks.id
                """, document_ids).fetchall()
                rows = [row for row in rows if any(term in normalized(row["content"]) for term in short_terms)][:4]
        return [dict(row, citation=index) for index, row in enumerate(rows, start=1)]
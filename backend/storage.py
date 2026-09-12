import json
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "conversations.sqlite3"
        with self.connection() as database:
            database.executescript("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL, content TEXT NOT NULL, model TEXT NOT NULL,
                    status TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL,
                    settings TEXT NOT NULL
                );
                UPDATE messages SET status='interrupted' WHERE status='generating';
            """)

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as database, database:
            database.row_factory = sqlite3.Row
            database.execute("PRAGMA foreign_keys=ON")
            yield database

    def create(self, title: str) -> dict:
        conversation = dict(id=uuid4().hex, title=title, created_at=timestamp(), updated_at=timestamp())
        with self.connection() as database:
            database.execute("INSERT INTO conversations VALUES (:id, :title, :created_at, :updated_at)", conversation)
        return conversation

    def listing(self) -> list[dict]:
        with self.connection() as database:
            return [dict(row) for row in database.execute("SELECT * FROM conversations ORDER BY updated_at DESC")]

    def get(self, identity: str) -> dict | None:
        with self.connection() as database:
            row = database.execute("SELECT * FROM conversations WHERE id=?", (identity,)).fetchone()
            if row is None:
                return None
            result = dict(row)
            result["messages"] = [dict(message) for message in database.execute(
                "SELECT * FROM messages WHERE conversation_id=? ORDER BY id", (identity,)
            )]
            return result

    def rename(self, identity: str, title: str) -> None:
        with self.connection() as database:
            database.execute("UPDATE conversations SET title=?, updated_at=? WHERE id=?", (title, timestamp(), identity))

    def delete(self, identity: str) -> None:
        with self.connection() as database:
            database.execute("DELETE FROM conversations WHERE id=?", (identity,))

    def begin(self, identity: str, content: str, model: str, request_id: str, settings: dict) -> int:
        with self.connection() as database:
            for role, text, status in [("user", content, "complete"), ("assistant", "", "generating")]:
                cursor = database.execute(
                    "INSERT INTO messages(conversation_id,role,content,model,status,request_id,created_at,settings) VALUES(?,?,?,?,?,?,?,?)",
                    (identity, role, text, model, status, request_id, timestamp(), json.dumps(settings)),
                )
            database.execute("UPDATE conversations SET updated_at=? WHERE id=?", (timestamp(), identity))
            return cursor.lastrowid

    def finish(self, message_id: int, content: str, status: str) -> None:
        with self.connection() as database:
            database.execute("UPDATE messages SET content=?,status=? WHERE id=?", (content, status, message_id))
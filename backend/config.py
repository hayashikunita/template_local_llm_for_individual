import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def local_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Inference endpoint must be an HTTP loopback origin.")
    if parsed.port is None:
        raise ValueError("Inference endpoint must include a port.")
    return value.rstrip("/")


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    ollama_url: str = "http://127.0.0.1:11434"
    port: int = 8765

    def __post_init__(self) -> None:
        local_endpoint(self.ollama_url)
        if not 1024 <= self.port <= 65535:
            raise ValueError("Port must be between 1024 and 65535.")

    @classmethod
    def from_env(cls) -> "Settings":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local/share")))
        return cls(
            data_dir=Path(os.environ.get("LOCAL_LLM_DATA_DIR", str(base / "LocalLLMTemplate"))),
            ollama_url=local_endpoint(os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")),
            port=int(os.environ.get("LOCAL_LLM_PORT", "8765")),
        )
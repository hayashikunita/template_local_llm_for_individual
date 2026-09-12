import asyncio
import hashlib
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.staticfiles import StaticFiles

from backend.config import Settings
from backend.inference import DEMO_MODEL, Inference
from backend.storage import Store

LOGGER = logging.getLogger("local_llm")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(StrictModel):
    code: str = Field(min_length=20, max_length=200)


class Title(StrictModel):
    title: str = Field(default="新しい会話", min_length=1, max_length=120)


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=12000)


class Generate(StrictModel):
    model: str = Field(default=DEMO_MODEL, min_length=1, max_length=200)
    messages: list[Message] = Field(min_length=1, max_length=40)
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=512, ge=16, le=2048)
    stream: bool = True

    @model_validator(mode="after")
    def validate_messages(self):
        if self.messages[-1].role != "user" or sum(len(item.content) for item in self.messages) > 24000:
            raise ValueError("End with a user message; maximum total length is 24000 characters.")
        return self


class UIMessage(StrictModel):
    content: str = Field(min_length=1, max_length=12000)
    model: str = Field(default=DEMO_MODEL, max_length=200)
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=512, ge=16, le=2048)


@dataclass
class Job:
    identity: str
    owner: str
    conversation_id: str | None
    model: str
    task: asyncio.Task | None = None
    output: str = ""
    status: str = "generating"
    error: str | None = None
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=128))


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def create_app(settings: Settings, inference: Inference | None = None) -> FastAPI:
    store = Store(settings.data_dir)
    engine = inference or Inference(settings.ollama_url)
    jobs: dict[str, Job] = {}
    sessions: dict[str, float] = {}
    api_tokens: dict[str, float] = {}
    launch_code = secrets.token_urlsafe(32)
    bootstrap = {"hash": digest(launch_code), "expires": time.monotonic() + 300, "failures": 0}
    origin = f"http://127.0.0.1:{settings.port}"

    @asynccontextmanager
    async def lifespan(_app):
        yield
        pending = [job.task for job in jobs.values() if job.task and not job.task.done()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    app = FastAPI(title="Local LLM Template API", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.launch_code = launch_code
    app.state.jobs = jobs
    app.state.store = store

    def error(status: int, code: str, message: str, identity: str) -> JSONResponse:
        return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "request_id": identity}})

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        request.state.identity = uuid4().hex
        if request.headers.get("host") != f"127.0.0.1:{settings.port}":
            return error(400, "invalid_host", "許可されていない接続先です。", request.state.identity)
        if request.headers.get("origin") not in {None, origin}:
            return error(403, "invalid_origin", "許可されていないアクセス元です。", request.state.identity)
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            if request.url.path.startswith(("/ui/", "/auth/")) and request.headers.get("origin") != origin:
                return error(403, "origin_required", "画面から操作してください。", request.state.identity)
            length = request.headers.get("content-length", "0")
            if not length.isdigit() or int(length) > 100000 or request.headers.get("transfer-encoding"):
                return error(413, "request_too_large", "要求が大きすぎます。", request.state.identity)
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.identity
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        LOGGER.info("request id=%s method=%s status=%s", request.state.identity, request.method, response.status_code)
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request, exception):
        return error(exception.status_code, f"http_{exception.status_code}", str(exception.detail), request.state.identity)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, _exception):
        return error(422, "invalid_request", "入力の長さ・型・設定値を確認してください。", request.state.identity)

    def ui_auth(request: Request) -> str:
        key = digest(request.cookies.get("local_session", ""))
        if sessions.get(key, 0) <= time.monotonic():
            raise HTTPException(401, "画面の認証が必要です。起動コマンドを再実行してください。")
        return "ui:" + key

    def api_auth(request: Request) -> str:
        authorization = request.headers.get("authorization", "")
        token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
        key = digest(token)
        if api_tokens.get(key, 0) <= time.monotonic():
            raise HTTPException(401, "APIが無効、または認証情報が無効です。")
        return "api:" + key

    def conversation(identity: str) -> dict:
        result = store.get(identity)
        if result is None:
            raise HTTPException(404, "会話が見つかりません。")
        return result

    @app.get("/healthz")
    async def health():
        return {"status": "ok", "phase": "prototype"}

    @app.post("/auth/session")
    async def login(body: Login, response: Response):
        if bootstrap["failures"] >= 10 or bootstrap["expires"] < time.monotonic():
            raise HTTPException(401, "起動リンクの有効期限が切れています。再起動してください。")
        if not secrets.compare_digest(bootstrap["hash"], digest(body.code)):
            bootstrap["failures"] += 1
            raise HTTPException(401, "起動リンクが無効です。")
        bootstrap["hash"] = ""
        token = secrets.token_urlsafe(32)
        sessions[digest(token)] = time.monotonic() + 12 * 3600
        response.set_cookie("local_session", token, httponly=True, samesite="strict", max_age=12 * 3600, path="/")
        return {"authenticated": True}

    @app.get("/ui/status")
    async def status(_owner=Depends(ui_auth)):
        return {"authenticated": True, "api_enabled": any(expiry > time.monotonic() for expiry in api_tokens.values()), "phase": "prototype", "endpoint": settings.ollama_url}

    @app.post("/ui/api-token")
    async def issue_token(_owner=Depends(ui_auth)):
        for job in jobs.values():
            if job.owner.startswith("api:") and job.task and not job.task.done():
                job.task.cancel()
        api_tokens.clear()
        token = secrets.token_urlsafe(32)
        api_tokens[digest(token)] = time.monotonic() + 3600
        return {"token": token, "expires_in": 3600}

    @app.delete("/ui/api-token")
    async def revoke_token(_owner=Depends(ui_auth)):
        api_tokens.clear()
        for job in jobs.values():
            if job.owner.startswith("api:") and job.task and not job.task.done():
                job.task.cancel()
        return {"api_enabled": False}

    @app.get("/ui/models")
    async def ui_models(_owner=Depends(ui_auth)):
        return await engine.models()

    @app.get("/api/v1/models")
    async def api_models(_owner=Depends(api_auth)):
        return await engine.models()

    @app.get("/api/v1/health")
    async def api_health(_owner=Depends(api_auth)):
        return {"status": "ok", "busy": any(job.status == "generating" for job in jobs.values())}

    @app.get("/ui/conversations")
    async def conversations(_owner=Depends(ui_auth)):
        return store.listing()

    @app.post("/ui/conversations", status_code=201)
    async def create_conversation(body: Title, _owner=Depends(ui_auth)):
        return store.create(body.title.strip() or "新しい会話")

    @app.get("/ui/conversations/{identity}")
    async def get_conversation(identity: str, _owner=Depends(ui_auth)):
        return conversation(identity)

    @app.patch("/ui/conversations/{identity}")
    async def rename_conversation(identity: str, body: Title, _owner=Depends(ui_auth)):
        conversation(identity)
        store.rename(identity, body.title.strip() or "新しい会話")
        return conversation(identity)

    @app.delete("/ui/conversations/{identity}")
    async def delete_conversation(identity: str, _owner=Depends(ui_auth)):
        conversation(identity)
        if any(job.conversation_id == identity and job.status == "generating" for job in jobs.values()):
            raise HTTPException(409, "生成を停止してから削除してください。")
        store.delete(identity)
        return {"deleted": True}

    @app.get("/ui/conversations/{identity}/export")
    async def export_conversation(identity: str, _owner=Depends(ui_auth)):
        return JSONResponse(conversation(identity), headers={"Content-Disposition": f'attachment; filename="conversation-{identity}.json"'})

    async def run_job(job: Job, body: Generate):
        message_id = None
        try:
            if job.conversation_id:
                message_id = store.begin(job.conversation_id, body.messages[-1].content, body.model, job.identity, {"temperature": body.temperature, "max_tokens": body.max_tokens, "prompt_version": "1"})
            async with asyncio.timeout(120):
                async for token in engine.generate(body.model, [item.model_dump() for item in body.messages], body.temperature, body.max_tokens):
                    if job.owner.startswith("api:") and api_tokens.get(job.owner[4:], 0) <= time.monotonic():
                        raise asyncio.CancelledError
                    if len(job.output) + len(token) > 50000:
                        raise ValueError("Output limit")
                    job.output += token
                    if body.stream:
                        await job.queue.put(token)
                job.status = "complete"
        except asyncio.CancelledError:
            job.status = "cancelled"
        except TimeoutError:
            job.status, job.error = "error", "生成が時間制限を超えました。"
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            job.status, job.error = "error", "ローカルモデルの応答を取得できませんでした。Ollamaとモデルを確認してください。"
        except Exception:
            job.status, job.error = "error", "生成処理に失敗しました。"
        finally:
            if message_id is not None:
                store.finish(message_id, job.output, job.status)
            LOGGER.info("generation id=%s result=%s", job.identity, job.status)

    def event(name: str, data: dict) -> str:
        return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def generate_response(body: Generate, owner: str, request: Request, conversation_id: str | None = None):
        if any(job.status == "generating" for job in jobs.values()):
            raise HTTPException(429, "別の回答を生成中です。完了後に再試行してください。")
        available = await engine.models()
        if body.model not in {item["id"] for item in available["models"]}:
            raise HTTPException(503, "指定したモデルは利用できません。モデル一覧を更新してください。")
        if any(job.status == "generating" for job in jobs.values()):
            raise HTTPException(429, "別の回答を生成中です。")
        for old_id in [identity for identity, job in jobs.items() if job.status != "generating"]:
            del jobs[old_id]
        job = Job(request.state.identity, owner, conversation_id, body.model)
        jobs[job.identity] = job
        job.task = asyncio.create_task(run_job(job, body))

        def result():
            return {"request_id": job.identity, "model": job.model, "prompt_version": "1", "status": job.status,
                    "content": job.output, "error": job.error, "references": [], "demo": job.model == DEMO_MODEL}

        async def chunks():
            try:
                yield event("start", {"request_id": job.identity, "model": body.model, "demo": body.model == DEMO_MODEL})
                while not job.task.done() or not job.queue.empty():
                    try:
                        token = await asyncio.wait_for(job.queue.get(), timeout=0.2)
                        yield event("delta", {"content": token})
                    except TimeoutError:
                        if await request.is_disconnected():
                            break
                yield event("done", result())
            finally:
                if not job.task.done():
                    job.task.cancel()
                with suppress(asyncio.CancelledError):
                    await job.task

        if body.stream:
            return StreamingResponse(chunks(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})
        try:
            while not job.task.done():
                await asyncio.wait({job.task}, timeout=0.1)
                if await request.is_disconnected():
                    job.task.cancel()
            await job.task
            return JSONResponse(result(), status_code=502 if job.status == "error" else 200)
        finally:
            if not job.task.done():
                job.task.cancel()

    @app.post("/api/v1/chat")
    async def api_chat(body: Generate, request: Request, owner=Depends(api_auth)):
        return await generate_response(body, owner, request)

    @app.post("/ui/conversations/{identity}/chat")
    async def ui_chat(identity: str, body: UIMessage, request: Request, owner=Depends(ui_auth)):
        history = conversation(identity)["messages"]
        messages = [{"role": item["role"], "content": item["content"]} for item in history if item["status"] == "complete" and item["content"]]
        messages.append({"role": "user", "content": body.content})
        if len(messages) > 40 or sum(len(item["content"]) for item in messages) > 24000:
            raise HTTPException(413, "会話が長すぎます。新しい会話を作成してください。")
        payload = Generate(messages=messages, model=body.model, temperature=body.temperature, max_tokens=body.max_tokens)
        return await generate_response(payload, owner, request, identity)

    async def cancel(identity: str, owner: str):
        job = jobs.get(identity)
        if not job or job.owner != owner:
            raise HTTPException(404, "生成要求が見つかりません。")
        if job.task and not job.task.done():
            job.task.cancel()
            await job.task
        return {"request_id": identity, "status": job.status}

    @app.post("/ui/generations/{identity}/cancel")
    async def ui_cancel(identity: str, owner=Depends(ui_auth)):
        return await cancel(identity, owner)

    @app.post("/api/v1/generations/{identity}/cancel")
    async def api_cancel(identity: str, owner=Depends(api_auth)):
        return await cancel(identity, owner)

    @app.get("/api/v1/openapi.json")
    async def schema(_owner=Depends(api_auth)):
        document = app.openapi().copy()
        document["paths"] = {path: value for path, value in document["paths"].items() if path.startswith("/api/v1/")}
        return document

    public = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    if (public / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=public / "assets"), name="assets")

    @app.get("/")
    async def index():
        if not (public / "index.html").exists():
            raise HTTPException(503, "Frontend not built. Run npm run build in frontend.")
        return FileResponse(public / "index.html")

    return app
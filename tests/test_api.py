import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Settings
from backend.inference import DEMO_MODEL, Inference


class DemoInference(Inference):
    async def models(self):
        return {"models": [{"id": DEMO_MODEL, "name": "Demo", "provider": "demo"}], "ollama": "unavailable"}


class APITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = Settings(Path(self.temporary.name))
        self.app = create_app(self.settings, DemoInference(self.settings.ollama_url))
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765")
        self.client.headers["Origin"] = "http://127.0.0.1:8765"

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def login(self):
        result = self.client.post("/auth/session", json={"code": self.app.state.launch_code})
        self.assertEqual(result.status_code, 200)

    def token(self):
        self.login()
        return self.client.post("/ui/api-token").json()["token"]

    def test_auth_and_origin_boundary(self):
        self.assertEqual(self.client.get("/ui/conversations").status_code, 401)
        self.assertEqual(self.client.get("/api/v1/models").status_code, 401)
        self.login()
        self.assertEqual(self.client.post("/auth/session", json={"code": self.app.state.launch_code}).status_code, 401)
        self.assertEqual(self.client.get("/ui/status", headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/ui/status", headers={"Host": "evil.example"}).status_code, 400)
        result = self.client.get("/ui/status")
        self.assertIn("object-src 'none'", result.headers["content-security-policy"])

    def test_ui_conversation_persistence_and_export(self):
        self.login()
        identity = self.client.post("/ui/conversations", json={"title": "Test"}).json()["id"]
        response = self.client.post(f"/ui/conversations/{identity}/chat", json={"content": "hello"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("event: start", response.text)
        self.assertIn('"status": "complete"', response.text)
        result = self.client.get(f"/ui/conversations/{identity}").json()
        self.assertEqual(len(result["messages"]), 2)
        self.assertIn("固定応答", result["messages"][1]["content"])
        self.client.patch(f"/ui/conversations/{identity}", json={"title": "Renamed"})
        exported = self.client.get(f"/ui/conversations/{identity}/export")
        self.assertEqual(exported.json()["title"], "Renamed")
        self.assertEqual(create_app(self.settings).state.store.get(identity)["title"], "Renamed")
        self.client.delete(f"/ui/conversations/{identity}")
        self.assertEqual(self.client.get(f"/ui/conversations/{identity}").status_code, 404)

    def test_external_api_is_stateless_and_revocable(self):
        token = self.token()
        headers = {"Authorization": f"Bearer {token}"}
        response = self.client.post("/api/v1/chat", headers=headers, json={"messages": [{"role": "user", "content": "hello"}], "stream": False})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["demo"])
        self.assertEqual(self.client.get("/ui/conversations").json(), [])
        self.assertEqual(self.client.get("/api/v1/openapi.json", headers=headers).status_code, 200)
        self.client.delete("/ui/api-token")
        self.assertEqual(self.client.get("/api/v1/models", headers=headers).status_code, 401)

    def test_invalid_and_unavailable_requests(self):
        token = self.token()
        headers = {"Authorization": f"Bearer {token}"}
        for payload in ({"messages": []}, {"messages": [{"role": "system", "content": "override"}]}):
            self.assertEqual(self.client.post("/api/v1/chat", headers=headers, json=payload).status_code, 422)
        payload = {"model": "missing", "messages": [{"role": "user", "content": "hello"}]}
        self.assertEqual(self.client.post("/api/v1/chat", headers=headers, json=payload).status_code, 503)
        payload = {"messages": [{"role": "user", "content": "x" * 110000}]}
        self.assertEqual(self.client.post("/api/v1/chat", headers=headers, content=json.dumps(payload)).status_code, 413)
        self.assertEqual(self.client.post("/api/v1/generations/missing/cancel", headers=headers).status_code, 404)

    def test_api_key_does_not_authorize_ui(self):
        token = self.token()
        self.client.cookies.clear()
        response = self.client.get("/ui/conversations", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401)
        response = self.client.post("/ui/api-token", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401)

    def test_ui_mutation_requires_origin(self):
        self.login()
        self.client.headers.pop("Origin")
        self.assertEqual(self.client.post("/ui/conversations", json={"title": "denied"}).status_code, 403)

    def test_rotating_api_key_invalidates_previous_key(self):
        previous = self.token()
        response = self.client.post("/ui/api-token")
        self.assertEqual(response.status_code, 200)
        current = response.json()["token"]
        self.assertNotEqual(previous, current)
        self.assertEqual(response.json()["expires_in"], 3600)
        for token, expected in ((previous, 401), (current, 200)):
            with self.subTest(expected=expected):
                response = self.client.get("/api/v1/health", headers={"Authorization": f"Bearer {token}"})
                self.assertEqual(response.status_code, expected)

    def test_invalid_generation_settings_do_not_create_jobs(self):
        headers = {"Authorization": f"Bearer {self.token()}"}
        invalid = [
            {"temperature": -0.1}, {"temperature": 2.1},
            {"max_tokens": 15}, {"max_tokens": 2049},
            {"unexpected": True},
            {"messages": [{"role": "assistant", "content": "last"}]},
            {"messages": [{"role": "user", "content": ""}]},
            {"messages": [{"role": "user", "content": "x" * 12001}]},
            {"messages": [{"role": "user", "content": "x"}] * 41},
            {"messages": [{"role": "user", "content": "x" * 8001}] * 3},
        ]
        for overrides in invalid:
            with self.subTest(fields=list(overrides), case=invalid.index(overrides)):
                body = {"messages": [{"role": "user", "content": "hello"}], **overrides}
                response = self.client.post("/api/v1/chat", headers=headers, json=body)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["error"]["code"], "invalid_request")
                self.assertEqual(response.json()["error"]["request_id"], response.headers["X-Request-ID"])
        self.assertEqual(self.app.state.jobs, {})
        self.assertEqual(self.client.get("/ui/conversations").json(), [])

    def test_restart_marks_unfinished_reply_interrupted(self):
        self.login()
        identity = self.client.post("/ui/conversations", json={"title": "Restart"}).json()["id"]
        self.app.state.store.begin(identity, "unfinished", DEMO_MODEL, "test-request", {})
        restarted = create_app(self.settings, DemoInference(self.settings.ollama_url))
        messages = restarted.state.store.get(identity)["messages"]
        self.assertEqual([message["status"] for message in messages], ["complete", "interrupted"])
        self.assertEqual(messages[0]["content"], "unfinished")
        self.assertEqual(messages[1]["content"], "")


class ControlledInference(DemoInference):
    def __init__(self, endpoint):
        super().__init__(endpoint)
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.fail = False

    async def generate(self, model, messages, temperature, max_tokens):
        yield "partial"
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise ValueError("private upstream error details")
        yield " complete"


class GenerationLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        settings = Settings(Path(temporary.name))
        self.engine = ControlledInference(settings.ollama_url)
        self.app = create_app(settings, self.engine)
        lifespan = self.app.router.lifespan_context(self.app)
        await lifespan.__aenter__()
        self.addAsyncCleanup(lifespan.__aexit__, None, None, None)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://127.0.0.1:8765",
            headers={"Origin": "http://127.0.0.1:8765"},
            trust_env=False,
        )
        self.addAsyncCleanup(self.client.aclose)
        response = await self.client.post("/auth/session", json={"code": self.app.state.launch_code})
        self.assertEqual(response.status_code, 200)
        response = await self.client.post("/ui/api-token")
        self.headers = {"Authorization": f"Bearer {response.json()['token']}"}
        response = await self.client.post("/ui/conversations", json={"title": "Lifecycle"})
        self.identity = response.json()["id"]
        self.chat_path = f"/ui/conversations/{self.identity}/chat"

    async def start_generation(self, external=False):
        if external:
            request = self.client.post("/api/v1/chat", headers=self.headers, json={
                "messages": [{"role": "user", "content": "test"}], "stream": False,
            })
        else:
            request = self.client.post(self.chat_path, json={"content": "test"})
        task = asyncio.create_task(request)

        async def cleanup():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        self.addAsyncCleanup(cleanup)
        await asyncio.wait_for(self.engine.started.wait(), timeout=5)
        identity = next(iter(self.app.state.jobs))
        return task, identity

    def stream_result(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        events = []
        for block in response.text.strip().split("\n\n"):
            fields = dict(line.split(": ", 1) for line in block.splitlines())
            events.append((fields["event"], json.loads(fields["data"])))
        self.assertEqual(events[0][0], "start")
        self.assertEqual(events[-1][0], "done")
        result = events[-1][1]
        self.assertEqual(result["request_id"], events[0][1]["request_id"])
        self.assertEqual(result["content"], "".join(data["content"] for name, data in events if name == "delta"))
        return result

    async def test_busy_generation_blocks_second_request_and_deletion(self):
        task, _identity = await self.start_generation()
        response = await self.client.get("/api/v1/health", headers=self.headers)
        self.assertTrue(response.json()["busy"])
        response = await self.client.post("/api/v1/chat", headers=self.headers, json={
            "messages": [{"role": "user", "content": "second"}],
        })
        self.assertEqual(response.status_code, 429)
        response = await self.client.delete(f"/ui/conversations/{self.identity}")
        self.assertEqual(response.status_code, 409)
        self.engine.release.set()
        result = self.stream_result(await asyncio.wait_for(task, timeout=5))
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["content"], "partial complete")
        response = await self.client.get("/api/v1/health", headers=self.headers)
        self.assertFalse(response.json()["busy"])
        response = await self.client.get(f"/ui/conversations/{self.identity}")
        self.assertEqual(len(response.json()["messages"]), 2)

    async def test_cancel_checks_owner_and_preserves_partial_reply(self):
        task, identity = await self.start_generation()
        response = await self.client.post(f"/api/v1/generations/{identity}/cancel", headers=self.headers)
        self.assertEqual(response.status_code, 404)
        self.assertFalse(task.done())
        response = await self.client.post(f"/ui/generations/{identity}/cancel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cancelled")
        result = self.stream_result(await asyncio.wait_for(task, timeout=5))
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["content"], "partial")
        response = await self.client.get(f"/ui/conversations/{self.identity}")
        reply = response.json()["messages"][-1]
        self.assertEqual((reply["content"], reply["status"]), ("partial", "cancelled"))
        self.engine.release.set()
        response = await self.client.post(self.chat_path, json={"content": "retry"})
        self.assertEqual(self.stream_result(response)["status"], "complete")

    async def test_stream_error_is_reported_and_partial_reply_saved(self):
        self.engine.fail = True
        self.engine.release.set()
        response = await self.client.post(self.chat_path, json={"content": "test"})
        result = self.stream_result(response)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["content"], "partial")
        self.assertTrue(result["error"])
        self.assertNotIn("private upstream", response.text)
        response = await self.client.get(f"/ui/conversations/{self.identity}")
        reply = response.json()["messages"][-1]
        self.assertEqual((reply["content"], reply["status"]), ("partial", "error"))

    async def test_nonstream_error_returns_502_without_saving_api_messages(self):
        self.engine.fail = True
        self.engine.release.set()
        response = await self.client.post("/api/v1/chat", headers=self.headers, json={
            "messages": [{"role": "user", "content": "test"}], "stream": False,
        })
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["status"], "error")
        self.assertEqual(response.json()["content"], "partial")
        self.assertNotIn("private upstream", response.text)
        response = await self.client.get(f"/ui/conversations/{self.identity}")
        self.assertEqual(response.json()["messages"], [])

    async def test_revoking_key_cancels_running_api_request(self):
        task, _identity = await self.start_generation(external=True)
        response = await self.client.delete("/ui/api-token")
        self.assertEqual(response.status_code, 200)
        response = await asyncio.wait_for(task, timeout=5)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertEqual(response.json()["content"], "partial")
        response = await self.client.get("/api/v1/health", headers=self.headers)
        self.assertEqual(response.status_code, 401)


class OllamaAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_installed_models_and_real_protocol_stream(self):
        requests = []

        def handler(request):
            requests.append(request)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "local-test:1"}]})
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "local-test:1")
            self.assertEqual(payload["messages"][0]["role"], "system")
            self.assertEqual(payload["options"]["num_predict"], 256)
            return httpx.Response(200, text='{"message":{"content":"Hello"},"done":false}\n{"message":{"content":" world"},"done":true}\n')

        original = httpx.AsyncClient
        def client(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            self.assertFalse(kwargs["follow_redirects"])
            return original(transport=httpx.MockTransport(handler), **kwargs)

        with patch("backend.inference.httpx.AsyncClient", side_effect=client):
            engine = Inference("http://127.0.0.1:11434")
            self.assertEqual((await engine.models())["models"][1]["id"], "local-test:1")
            result = [chunk async for chunk in engine.generate("local-test:1", [{"role": "user", "content": "Hi"}], 0.7, 256)]
            self.assertEqual("".join(result), "Hello world")
        self.assertEqual([item.url.path for item in requests], ["/api/tags", "/api/chat"])

    async def test_incomplete_stream_is_not_success(self):
        original = httpx.AsyncClient
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, text='{"message":{"content":"partial"}}\n'))
        with patch("backend.inference.httpx.AsyncClient", side_effect=lambda **kwargs: original(transport=transport, **kwargs)):
            engine = Inference("http://127.0.0.1:11434")
            with self.assertRaises(ValueError):
                _result = [chunk async for chunk in engine.generate("local-test:1", [{"role": "user", "content": "Hi"}], 0.7, 256)]
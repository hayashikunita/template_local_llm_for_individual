import asyncio
import json
from collections.abc import AsyncIterator

import httpx


DEMO_MODEL = "demo-preview"
SYSTEM_PROMPT = "Answer helpfully in the user's language. Do not claim to have searched documents. No tools are available."


class Inference:
    def __init__(self, endpoint: str):
        self.endpoint = endpoint

    async def models(self) -> dict:
        available = [{"id": DEMO_MODEL, "name": "接続テスト（LLMではありません）", "provider": "demo"}]
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=3, follow_redirects=False) as client:
                response = await client.get(f"{self.endpoint}/api/tags")
                response.raise_for_status()
                for item in response.json()["models"]:
                    available.append({"id": item["name"], "name": item["name"], "provider": "ollama"})
            status = "connected"
        except (httpx.HTTPError, KeyError, ValueError, TypeError):
            status = "unavailable"
        return {"models": available, "ollama": status}

    async def generate(self, model: str, messages: list[dict], temperature: float, max_tokens: int) -> AsyncIterator[str]:
        if model == DEMO_MODEL:
            text = (
                "これは接続テスト用の固定応答です。LLMによる生成ではありません。\n\n"
                "受け取ったメッセージ：\n" + messages[-1]["content"] +
                "\n\n画面・API・会話保存の動作を確認しています。業務上の回答には利用できません。"
            )
            for offset in range(0, len(text), 6):
                await asyncio.sleep(0.04)
                yield text[offset:offset + 6]
            return
        payload = {
            "model": model, "stream": True,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, *messages],
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        async with httpx.AsyncClient(trust_env=False, timeout=90, follow_redirects=False) as client:
            async with client.stream("POST", f"{self.endpoint}/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    event = json.loads(line)
                    if "error" in event:
                        raise ValueError("Inference failed")
                    if token := event.get("message", {}).get("content"):
                        yield token
                    if event.get("done"):
                        return
                raise ValueError("Inference stream ended unexpectedly")
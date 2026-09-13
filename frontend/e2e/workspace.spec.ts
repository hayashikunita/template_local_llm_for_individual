import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: ChildProcess;
let inferenceServer: Server;
let inferenceRequests = 0;
let directory: string;
let launchURL: string;
const root = path.resolve("..");

test.beforeAll(async () => {
  inferenceServer = createServer((incoming, outgoing) => {
    if (incoming.url === "/api/tags") {
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ models: [{ name: "test-rag" }] }));
      return;
    }
    if (incoming.url !== "/api/chat") {
      outgoing.writeHead(404).end();
      return;
    }
    let body = "";
    incoming.on("data", (chunk) => { body += chunk.toString(); });
    incoming.on("end", () => {
      inferenceRequests++;
      const payload = JSON.parse(body);
      const prompt = payload.messages[0];
      if (prompt.role !== "system" || !prompt.content.includes("8000") || !prompt.content.includes("untrusted data")) {
        outgoing.writeHead(400).end();
        return;
      }
      outgoing.setHeader("Content-Type", "application/x-ndjson");
      outgoing.end(JSON.stringify({ message: { content: "交通費の上限は月額8000円です。[1]" }, done: true }) + "\n");
    });
  });
  await new Promise<void>((resolve) => inferenceServer.listen(0, "127.0.0.1", resolve));
  const inferencePort = (inferenceServer.address() as AddressInfo).port;
  directory = mkdtempSync(path.join(tmpdir(), "local-llm-e2e-"));
  const python = path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  server = spawn(
    python,
    ["-m", "backend", "--port", "8891", "--print-launch-url"],
    {
      cwd: root,
      env: {
        ...process.env,
        LOCAL_LLM_DATA_DIR: directory,
        PYTHONIOENCODING: "utf-8",
        OLLAMA_URL: `http://127.0.0.1:${inferencePort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  launchURL = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error("Server did not start")),
      25000,
    );
    server.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/LAUNCH_URL=(http[^\r\n]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.on("error", reject);
    server.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited: ${code}`));
    });
  });
  mkdirSync("test-results/screenshots", { recursive: true });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    await new Promise<void>((resolve) => {
      server.once("exit", () => resolve());
      server.kill();
    });
  }
  if (inferenceServer) await new Promise<void>((resolve, reject) => inferenceServer.close((error) => error ? reject(error) : resolve()));
  if (directory)
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
});

test("chat, cancellation, persistence, API boundaries and responsive layout", async ({
  page,
}) => {
  const outside: string[] = [];
  const errors: string[] = [];
  page.on("request", (outgoing) => {
    if (!outgoing.url().startsWith(new URL(launchURL).origin))
      outside.push(new URL(outgoing.url()).origin);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(launchURL);
  await expect(
    page.getByRole("textbox", { name: "メッセージ", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("setup=");
  await page.screenshot({
    path: "test-results/screenshots/desktop-empty.png",
    fullPage: true,
  });
  await page
    .getByRole("textbox", { name: "メッセージ", exact: true })
    .fill("こんにちは。接続を確認します。");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.locator(".message.assistant .message-text")).toContainText(
    "固定応答",
    { timeout: 15000 },
  );
  await expect(page.locator(".message.assistant .message-meta")).toContainText(
    "完了",
  );
  await page.screenshot({
    path: "test-results/screenshots/desktop-chat.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "会話名を変更", exact: true }).click();
  await page.getByRole("textbox", { name: "新しい会話名" }).fill("検証会話");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.locator(".conversation-title h1")).toHaveText("検証会話");
  const exportPath = await page
    .getByRole("link", { name: "JSONをエクスポート" })
    .getAttribute("href");
  const exported = await page.request.get(
    new URL(exportPath ?? "/", page.url()).href,
  );
  expect((await exported.json()).messages).toHaveLength(2);
  await page.reload();
  await page.getByRole("button", { name: "検証会話", exact: true }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(1);

  await page
    .getByRole("textbox", { name: "メッセージ", exact: true })
    .fill("停止を確認します。".repeat(30));
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(
    page.locator(".message.assistant").last().locator(".message-text"),
  ).toContainText("接続テスト", { timeout: 15000 });
  await page.getByRole("button", { name: "生成を停止" }).click();
  await expect(
    page.locator(".message.assistant").last().locator(".message-meta"),
  ).toContainText("停止済み");
  await expect(
    page.getByRole("textbox", { name: "メッセージ", exact: true }),
  ).toBeEnabled();

  await page
    .getByRole("textbox", { name: "メッセージ", exact: true })
    .fill('<img src="https://example.invalid/collect" onerror="alert(1)">');
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(
    page.locator(".message.assistant").last().locator(".message-meta"),
  ).toContainText("完了", { timeout: 15000 });
  await expect(page.locator(".message img")).toHaveCount(0);

  await page.getByRole("button", { name: "API連携", exact: true }).click();
  const origin = new URL(launchURL).origin;
  expect((await page.request.get(origin + "/api/v1/models")).status()).toBe(
    401,
  );
  await page.getByRole("button", { name: "APIを有効にする" }).click();
  const key = page.locator("#api-key");
  await expect(key).toBeVisible();
  const token = await key.inputValue();
  const headers = { Authorization: `Bearer ${token}` };
  const response = await page.request.post(origin + "/api/v1/chat", {
    headers,
    data: { messages: [{ role: "user", content: "api test" }], stream: false },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).demo).toBe(true);
  expect(
    (
      await page.request.get(origin + "/ui/status", {
        headers: { Origin: "https://example.invalid" },
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "無効にする", exact: true }).click();
  expect(
    (await page.request.get(origin + "/api/v1/models", { headers })).status(),
  ).toBe(401);
  await page.screenshot({
    path: "test-results/screenshots/desktop-api.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "ナレッジ", exact: true }).click();
  const original = Buffer.from("# 架空の規程\n交通費の上限は月額8000円です。\n<img src=\"https://example.invalid/collect\">", "utf8");
  await page.getByLabel("文書ファイル", { exact: true }).setInputFiles({ name: "架空規程.md", mimeType: "text/markdown", buffer: original });
  await expect(page.getByLabel("架空規程.mdを検索対象にする")).toBeChecked();
  await page.getByRole("textbox", { name: "文書の検索語句" }).fill("交通費");
  await page.getByRole("button", { name: "文書を検索", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("検索結果 1 件");
  await page.locator(".references summary").click();
  await expect(page.locator(".reference-excerpt")).toContainText("8000");
  await expect(page.locator(".references img")).toHaveCount(0);
  const originalPath = await page.getByRole("link", { name: "架空規程.mdの原本", exact: true }).getAttribute("href");
  expect(await (await page.request.get(origin + originalPath)).body()).toEqual(original);
  await page.screenshot({ path: "test-results/screenshots/desktop-knowledge.png", fullPage: true });
  await page.getByRole("button", { name: "選択文書で新しい会話" }).click();
  await expect(page.getByRole("combobox", { name: "モデル", exact: true })).toHaveValue("test-rag");
  await expect(page.getByLabel("文書検索を有効にする")).toBeChecked();
  await page.getByRole("textbox", { name: "メッセージ", exact: true }).fill("交通費の上限は？");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.locator(".message.assistant .message-text")).toContainText("8000円です。[1]");
  await expect(page.locator(".message.assistant .message-meta")).toContainText("完了");
  await page.locator(".references summary").click();
  await expect(page.locator(".reference-excerpt")).toContainText("交通費の上限");
  await page.screenshot({ path: "test-results/screenshots/desktop-rag.png", fullPage: true });
  expect(inferenceRequests).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "交通費の上限は？", exact: true }).click();
  await expect(page.locator(".references summary")).toContainText("架空規程.md / 行 1–3");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".references summary").click();
  await expect(page.getByLabel("文書検索を有効にする")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/screenshots/mobile-rag.png", fullPage: true });
  await page.getByRole("button", { name: "検索対象の文書を選ぶ" }).click();
  await page.getByLabel("架空規程.mdを検索対象にする").check();
  await page.screenshot({ path: "test-results/screenshots/mobile-knowledge.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "選択文書で新しい会話" }).click();
  await page.getByRole("textbox", { name: "メッセージ", exact: true }).fill("宇宙旅行について");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.locator(".message.assistant .message-text")).toContainText("一致する情報が見つかりません");
  expect(inferenceRequests).toBe(1);
  await page.getByRole("button", { name: "検索対象の文書を選ぶ" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "架空規程.mdを削除", exact: true }).click();
  await expect(page.getByText("登録済み文書はありません", { exact: true })).toBeVisible();
  expect((await page.request.get(origin + originalPath)).status()).toBe(404);
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.getByRole("button", { name: "チャット", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "メッセージ", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/screenshots/mobile-chat.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "会話を削除", exact: true }).click();
  await page.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(page.locator(".conversation-title h1")).toHaveText("新しい会話");
  await page.screenshot({
    path: "test-results/screenshots/mobile-empty.png",
    fullPage: true,
  });
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

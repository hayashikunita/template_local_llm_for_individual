import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let server: ChildProcess;
let directory: string;
let launchURL: string;
const root = path.resolve("..");

test.beforeAll(async () => {
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

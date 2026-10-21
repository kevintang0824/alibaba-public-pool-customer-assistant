const assert = require("node:assert/strict");
const path = require("node:path");
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("C:/Users/zhinian/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const { chromium } = playwright;

const extensionDir = path.resolve(__dirname, "..");
const bridgePath = path.join(extensionDir, "chat_bridge.js");
const commandKey = "aliPublicCustomerAssistantV1ChatCommand";
const resultKey = "aliPublicCustomerAssistantV1ChatResult";
let launchedBrowser;

async function main() {
  launchedBrowser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const page = await launchedBrowser.newPage({ viewport: { width: 1000, height: 760 } });

  await page.addInitScript(() => {
    const values = {};
    const listeners = [];
    globalThis.__mockStorageValues = values;
    globalThis.chrome = {
      storage: {
        local: {
          get(key, callback) {
            setTimeout(() => callback({ [key]: values[key] }), 0);
          },
          set(update, callback) {
            const changes = {};
            for (const [key, value] of Object.entries(update)) {
              changes[key] = { oldValue: values[key], newValue: value };
              values[key] = value;
            }
            setTimeout(() => {
              listeners.forEach((listener) => listener(changes, "local"));
              callback?.();
            }, 0);
          },
          remove(key, callback) {
            delete values[key];
            setTimeout(() => callback?.(), 0);
          },
        },
        onChanged: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
      },
    };
  });

  await page.route("https://onetalk.alibaba.com/message/weblite.htm", async (route) => {
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <style>
              body { margin: 0; width: 1000px; height: 760px; font-family: Arial, sans-serif; }
              #chat { position: fixed; inset: 0; background: white; }
              h2 { position: absolute; top: 16px; left: 40px; margin: 0; }
              .chat-close { position: absolute; top: 16px; right: 16px; width: 34px; height: 34px; }
              #composer { position: absolute; left: 40px; right: 40px; bottom: 30px; height: 120px; }
              textarea { width: 760px; height: 96px; }
              #send { position: absolute; right: 0; bottom: 10px; width: 90px; height: 38px; }
            </style>
          </head>
          <body>
            <section id="chat">
              <h2>Adam Durucz</h2>
              <button class="chat-close" aria-label="关闭">×</button>
              <div id="composer">
                <textarea placeholder="请在此输入正文"></textarea>
                <button id="send">发送</button>
              </div>
            </section>
            <script>
              document.querySelector("#send").addEventListener("click", () => {
                const input = document.querySelector("textarea");
                document.body.dataset.sentText = input.value;
                input.value = "";
                input.dispatchEvent(new Event("input", { bubbles: true }));
              });
              document.querySelector(".chat-close").addEventListener("click", () => {
                document.body.dataset.closeClicks = String(
                  Number(document.body.dataset.closeClicks || 0) + 1
                );
              });
            </script>
          </body>
        </html>
      `,
    });
  });

  await page.goto("https://onetalk.alibaba.com/message/weblite.htm");
  await page.addScriptTag({ path: bridgePath });

  async function sendCommand(action, payload = {}) {
    const id = `${action}-${Date.now()}-${Math.random()}`;
    await page.evaluate(
      ({ key, command }) =>
        new Promise((resolve) => chrome.storage.local.set({ [key]: command }, resolve)),
      {
        key: commandKey,
        command: { id, action, payload, createdAt: Date.now() },
      }
    );
    await page.waitForFunction(
      ({ key, expectedId }) => globalThis.__mockStorageValues[key]?.id === expectedId,
      { key: resultKey, expectedId: id }
    );
    return page.evaluate((key) => globalThis.__mockStorageValues[key], resultKey);
  }

  const status = await sendCommand("status");
  assert.equal(status.ok, true);
  assert.equal(status.ready, true);
  assert.equal(status.recipient, "Adam Durucz");

  const dryRun = await sendCommand("compose", {
    expectedRecipient: "Adam Durucz",
    text: "Hello, this is a local test.",
    dryRun: true,
    sendMedia: false,
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.filled, true);
  assert.equal(dryRun.sent, false);
  assert.equal(await page.locator("textarea").inputValue(), "Hello, this is a local test.");
  assert.equal(await page.locator("body").getAttribute("data-sent-text"), null);

  const sendResult = await sendCommand("compose", {
    expectedRecipient: "Adam Durucz",
    text: "Hello, this message should be sent.",
    dryRun: false,
    sendMedia: false,
  });
  assert.equal(sendResult.ok, true);
  assert.equal(sendResult.sent, true);
  assert.equal(await page.locator("body").getAttribute("data-sent-text"), "Hello, this message should be sent.");
  assert.equal(await page.locator("textarea").inputValue(), "");

  const closeResult = await sendCommand("close");
  assert.equal(closeResult.ok, true);
  await page.waitForFunction(() => document.body.dataset.closeClicks === "1");
  assert.equal(await page.locator("#chat").isVisible(), true);

  await page.locator("h2").evaluate((heading) => {
    heading.textContent = "Javier Ruiz Lopez";
  });
  const nextRecipient = await sendCommand("compose", {
    expectedRecipient: "Javier Javier",
    previousRecipient: "Adam Durucz",
    text: "Hello, second verified customer.",
    dryRun: false,
    sendMedia: false,
  });
  assert.equal(nextRecipient.ok, true);
  assert.equal(nextRecipient.recipient, "Javier Ruiz Lopez");
  assert.equal(nextRecipient.recipientMatch, "alias");
  assert.equal(await page.locator("body").getAttribute("data-sent-text"), "Hello, second verified customer.");

  const mismatch = await sendCommand("compose", {
    expectedRecipient: "Wrong Customer",
    previousRecipient: "Javier Ruiz Lopez",
    recipientTimeout: 400,
    text: "This must not be sent.",
    dryRun: false,
    sendMedia: false,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /聊天收件人未匹配且会话未切换/);
  assert.equal(await page.locator("body").getAttribute("data-sent-text"), "Hello, second verified customer.");

  await launchedBrowser.close();
  launchedBrowser = null;
  console.log("chat bridge integration tests passed");
}

main().catch(async (error) => {
  console.error(error);
  await launchedBrowser?.close().catch(() => {});
  process.exitCode = 1;
});

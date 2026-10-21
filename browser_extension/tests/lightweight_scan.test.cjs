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
const contentPath = path.join(extensionDir, "content.js");
let launchedBrowser;

async function main() {
  launchedBrowser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const page = await launchedBrowser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.addInitScript(() => {
    const values = {};
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener() {},
        },
      },
      storage: {
        local: {
          get(key, callback) {
            setTimeout(() => callback({ [key]: values[key] }), 0);
          },
          set(update, callback) {
            Object.assign(values, update);
            setTimeout(() => callback?.(), 0);
          },
          remove(key, callback) {
            for (const item of Array.isArray(key) ? key : [key]) delete values[item];
            setTimeout(() => callback?.(), 0);
          },
        },
      },
    };
    globalThis.__scrollByCalls = 0;
    globalThis.scrollBy = () => {
      globalThis.__scrollByCalls += 1;
    };
  });

  const rows = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    return `
      <tr class="ant-table-row">
        <td><input type="checkbox" /></td>
        <td>
          <div><strong>Customer ${number}</strong> <span>L3</span><span title="立即沟通"></span></div>
          <div>c***${number}@example.com</div>
          <div>Company ${number}</div>
        </td>
        <td>未标记</td>
        <td>TM沟通 商家主动发起的tm</td>
        <td>2026-07-30</td>
        <td>无采购额</td>
        <td>美国</td>
        <td>加为我的客户</td>
      </tr>
    `;
  }).join("");
  const noise = Array.from({ length: 6000 }, (_, index) => `<div class="noise">noise-${index}</div>`).join("");

  await page.route("https://i.alibaba.com/hub/alicrm/public_customer", async (route) => {
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <style>
              body { margin: 0; font-family: Arial, sans-serif; }
              table { width: 1100px; border-collapse: collapse; }
              tr { height: 64px; }
              td { border: 1px solid #ddd; padding: 6px; }
              .noise { display: none; }
            </style>
          </head>
          <body>
            <h1>公海</h1>
            <table><tbody>${rows}</tbody></table>
            <ul class="ant-pagination"><li class="ant-pagination-item-active">1</li></ul>
            ${noise}
          </body>
        </html>
      `,
    });
  });

  await page.goto("https://i.alibaba.com/hub/alicrm/public_customer");
  await page.addScriptTag({ path: contentPath });
  await page.waitForSelector("#acda-panel");
  assert.equal(await page.locator("#acda-lightweight-mode").isChecked(), true);
  await page.locator("#acda-message").fill("Hello from Example Company. What products are you looking for?");

  const startedAt = Date.now();
  await page.locator("#acda-scan-pages-button").click();
  await page.waitForFunction(() => document.querySelector("#acda-log")?.textContent.includes("扫描完成"));
  const elapsedMs = Date.now() - startedAt;

  const stats = await page.locator("#acda-count").innerText();
  assert.match(stats, /客户：10\/10/);
  assert.equal(await page.evaluate(() => globalThis.__scrollByCalls), 0);
  assert.ok(elapsedMs < 2000, `lightweight scan took ${elapsedMs}ms`);

  await page.locator("#acda-clear").click();
  await page.locator("#acda-customer-limit").fill("2");
  await page.locator("#acda-min-delay").fill("0.3");
  await page.locator("#acda-max-delay").fill("0.3");
  await page.locator("#acda-speed").selectOption("open");
  await page.locator("#acda-scan-pages-button").click();
  await page.waitForFunction(() => document.querySelector("#acda-log")?.textContent.includes("扫描完成"));
  await page.locator("#acda-start").click();
  await page.waitForFunction(() => document.querySelector("#acda-log")?.textContent.includes("队列完成"));
  const skipLog = await page.locator("#acda-log").innerText();
  assert.match(skipLog, /跳过：Customer 1 没有找到可用的旺旺入口/);
  assert.match(skipLog, /跳过：Customer 2 没有找到可用的旺旺入口/);
  assert.doesNotMatch(skipLog, /暂停：/);

  await launchedBrowser.close();
  launchedBrowser = null;
  console.log(`lightweight scan tests passed (${elapsedMs}ms)`);
}

main().catch(async (error) => {
  console.error(error);
  await launchedBrowser?.close().catch(() => {});
  process.exitCode = 1;
});

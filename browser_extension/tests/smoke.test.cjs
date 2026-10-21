const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..");
const sourcePath = path.join(extensionDir, "content.js");
const bridgePath = path.join(extensionDir, "chat_bridge.js");
const manifestPath = path.join(extensionDir, "manifest.json");
const source = fs.readFileSync(sourcePath, "utf8");
const bridgeSource = fs.readFileSync(bridgePath, "utf8");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

assert.equal(manifest.version, "1.2.0");
assert.ok(manifest.permissions.includes("storage"));
assert.ok(manifest.permissions.includes("unlimitedStorage"));
const bridgeRegistration = manifest.content_scripts.find((entry) => entry.js.includes("chat_bridge.js"));
assert.ok(bridgeRegistration);
assert.match(bridgeSource, /loadMediaFiles/);
assert.match(bridgeSource, /cachedMediaCapturedAt/);
assert.equal(bridgeRegistration.all_frames, true);
assert.ok(bridgeRegistration.matches.includes("https://onetalk.alibaba.com/*"));
assert.match(source, /id="acda-scan-pages"/);
assert.match(source, /id="acda-customer-limit"/);
assert.match(source, /id="acda-lightweight-mode"/);
assert.match(source, /id="acda-skip-count"/);
assert.match(source, /id="acda-current-page-mode"/);
assert.match(source, /id="acda-scan-pages-button"/);
assert.match(source, /processCurrentPageCustomer/);
assert.match(source, /runChatFrameCommand/);
assert.match(source, /releaseRowDomReferences/);
assert.match(source, /attemptCloseChat/);
assert.match(source, /requireIntroText/);
assert.match(source, /renderMessage/);
assert.match(source, /\{company\}/);
assert.match(source, /没有找到可用的旺旺入口/);
assert.match(source, /从第 \$\{resumed\.index \+ 1\}/);
assert.doesNotMatch(source, /聊天窗口未关闭，已暂停以防发错客户/);
assert.match(source, /25 \* 1024 \* 1024/);
assert.doesNotMatch(source, /200 \* 1024 \* 1024/);
assert.doesNotMatch(source, /id="acda-scan-more"/);
assert.match(bridgeSource, /waitForRecipient/);
assert.match(bridgeSource, /findChatInput/);
assert.match(bridgeSource, /findCloseButton/);
assert.doesNotMatch(source, /Kevin|Plant Fun/i);
assert.doesNotMatch(bridgeSource, /Kevin|Plant Fun/i);

const marker = source.lastIndexOf("})();");
assert.notEqual(marker, -1);
const instrumented =
  source.slice(0, marker) +
  `
  window.__acdaTest = {
    cleanName,
    looksLikeNameLine,
    makeRowKey,
    parseRowText,
    splitUsefulLines,
    requireIntroText,
  };
` +
  source.slice(marker);

class MockElement {}

const context = {
  alert() {},
  atob,
  chrome: {
    runtime: {
      onMessage: {
        addListener() {},
      },
    },
    storage: {
      local: {
        get(_key, callback) {
          callback({});
        },
        remove(_key, callback) {
          callback();
        },
        set(_value, callback) {
          callback();
        },
      },
    },
  },
  console,
  document: {
    addEventListener() {},
    readyState: "loading",
  },
  Element: MockElement,
  File: class {},
  FileReader: class {},
  InputEvent: class {},
  location: {
    href: "https://alicrm.alibaba.com/#public-customer",
    hostname: "alicrm.alibaba.com",
  },
  Node: {
    TEXT_NODE: 3,
  },
  setTimeout,
  TextEncoder,
  URL,
  window: {
    __aliPublicCustomerOneTalkLoaded: false,
  },
};
context.window.window = context.window;

vm.createContext(context);
vm.runInContext(instrumented, context, { filename: sourcePath });

const api = context.window.__acdaTest;
assert.ok(api);

const customerCell = {
  innerText: ["John Buyer", "j***n@example.com", "Example Garden LLC"].join("\n"),
};
const root = {
  getBoundingClientRect() {
    return { top: 200 };
  },
  querySelector(selector) {
    return selector === "td:nth-child(2)" ? customerCell : null;
  },
  querySelectorAll() {
    return [];
  },
};
const rowText = [
  "John Buyer",
  "j***n@example.com",
  "Example Garden LLC",
  "未标记",
  "TM沟通",
  "商家主动发起的tm",
  "2026-06-29",
  "无采购额",
  "美国",
  "加为我的客户",
].join("\n");

const row = api.parseRowText(rowText, root, null);
assert.equal(row.name, "John Buyer");
assert.equal(row.email, "j***n@example.com");
assert.equal(row.company, "Example Garden LLC");
assert.equal(row.followStatus, "TM沟通");
assert.equal(api.makeRowKey(row), "email:j***n@example.com");
assert.equal(api.cleanName("John Buyer L3"), "John Buyer");
assert.equal(api.looksLikeNameLine("John Buyer"), true);
assert.equal(api.splitUsefulLines(rowText).length, 10);
assert.throws(() => api.requireIntroText({ introText: "" }), /请先填写自己的公司介绍语/);
assert.equal(api.requireIntroText({ introText: "Hello from Example Company." }), "Hello from Example Company.");

console.log("browser_extension smoke tests passed");

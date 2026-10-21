(() => {
  if (window.__acdaChatBridgeLoaded) return;
  if (location.hostname !== "onetalk.alibaba.com" || !/\/message\/weblite/i.test(location.pathname)) return;
  window.__acdaChatBridgeLoaded = true;

  const STORAGE_PREFIX = "aliPublicCustomerAssistantV1";
  const COMMAND_KEY = `${STORAGE_PREFIX}ChatCommand`;
  const RESULT_KEY = `${STORAGE_PREFIX}ChatResult`;
  const MEDIA_KEY = `${STORAGE_PREFIX}Media`;
  const MEDIA_META_KEY = `${STORAGE_PREFIX}MediaMeta`;
  const handledCommands = new Set();
  let cachedMediaCapturedAt = 0;
  let cachedMediaFiles = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const lower = (value) => norm(value).toLowerCase();

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => resolve(result?.[key]));
      } catch {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, resolve);
      } catch {
        resolve();
      }
    });
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0.05 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= innerHeight &&
      rect.left <= innerWidth
    );
  }

  function textOf(el) {
    const parts = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ]
      .map(norm)
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
    return norm(parts.join(" "));
  }

  function scoreChatInput(el) {
    const rect = el.getBoundingClientRect();
    const meta = lower(
      [
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        textOf(el),
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (/搜索|search|translate|翻译|筛选/.test(meta)) return -10;
    let score = 0;
    if (/请在此输入正文|输入正文|正文|message|type.*message|reply|发送/.test(meta)) score += 14;
    if (rect.top > innerHeight * 0.48) score += 5;
    if (rect.width > 220 && rect.height > 36) score += 5;
    if (rect.left < innerWidth * 0.78) score += 2;
    if (el.isContentEditable) score += 2;
    return score;
  }

  function findChatInput() {
    return Array.from(
      document.querySelectorAll("textarea,input[type='text'],[contenteditable='true'],div[role='textbox']")
    )
      .filter(visible)
      .map((el) => ({ el, score: scoreChatInput(el), rect: el.getBoundingClientRect() }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.rect.top - a.rect.top)[0]?.el;
  }

  function readActiveRecipient() {
    const candidates = Array.from(
      document.querySelectorAll("h1,h2,h3,[class*='conversation-title'],[class*='chat-title'],[class*='user-name']")
    )
      .filter(visible)
      .map((el) => ({ el, text: norm(textOf(el)), rect: el.getBoundingClientRect() }))
      .filter((item) => {
        if (!item.text || item.text.length > 100) return false;
        if (item.rect.top > 170 || item.rect.left > innerWidth * 0.78) return false;
        return !/消息|message|本地时间|local time/i.test(item.text);
      })
      .sort((a, b) => {
        const aHeading = /^H[1-3]$/.test(a.el.tagName) ? 1 : 0;
        const bHeading = /^H[1-3]$/.test(b.el.tagName) ? 1 : 0;
        if (aHeading !== bHeading) return bHeading - aHeading;
        return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
      });
    return candidates[0]?.text || "";
  }

  async function waitForChatInput(timeout = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const input = findChatInput();
      if (input) return input;
      await sleep(200);
    }
    throw new Error("旺旺聊天输入框没有出现");
  }

  function recipientNameTokens(value) {
    return Array.from(
      new Set(
        lower(value)
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .split(/[^\p{L}\p{N}]+/u)
          .filter((token) => token.length >= 3)
      )
    );
  }

  function classifyRecipient(expectedName, actualName, previousName) {
    const expected = lower(expectedName);
    const actual = lower(actualName);
    const previous = lower(previousName);
    if (!expected) return "unchecked";
    if (actual && (actual.includes(expected) || expected.includes(actual))) return "exact";

    const expectedTokens = recipientNameTokens(expectedName);
    const actualTokens = new Set(recipientNameTokens(actualName));
    if (expectedTokens.some((token) => actualTokens.has(token))) return "alias";
    if (previous && actual && actual !== previous) return "switched";
    return "";
  }

  async function waitForRecipient(expectedName, previousName = "", timeout = 12000) {
    if (!lower(expectedName)) {
      return { recipient: readActiveRecipient(), match: "unchecked" };
    }
    const startedAt = Date.now();
    let lastRecipient = "";
    while (Date.now() - startedAt < timeout) {
      lastRecipient = readActiveRecipient();
      const match = classifyRecipient(expectedName, lastRecipient, previousName);
      if (match) return { recipient: lastRecipient, match };
      await sleep(200);
    }
    throw new Error(
      `聊天收件人未匹配且会话未切换：期望 ${expectedName}，当前 ${lastRecipient || "未识别"}`
    );
  }

  async function fillText(el, text) {
    el.focus();
    el.click();
    await sleep(80);
    if (el.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findSendButton(input) {
    const inputRect = input.getBoundingClientRect();
    return Array.from(document.querySelectorAll("button,[role='button'],span,div"))
      .filter(visible)
      .filter((el) => /^(发送|Send)$/i.test(norm(textOf(el))))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= inputRect.left &&
          rect.left <= inputRect.right + 80 &&
          rect.top >= inputRect.top - 30 &&
          rect.top <= inputRect.bottom + 55
        );
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
  }

  function buttonDisabled(button) {
    return (
      button?.getAttribute("disabled") !== null ||
      button?.getAttribute("aria-disabled") === "true" ||
      /disabled/.test(lower(button?.className))
    );
  }

  function inputValue(input) {
    return norm(input?.isContentEditable ? input.innerText || input.textContent : input?.value);
  }

  async function clickSend(input) {
    const button = findSendButton(input);
    if (!button) throw new Error("找不到聊天输入框旁边的发送按钮");
    if (buttonDisabled(button)) throw new Error("旺旺发送按钮仍是禁用状态");
    const before = inputValue(input);
    button.click();
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      await sleep(150);
      if (!findChatInput() || !inputValue(input) || inputValue(input) !== before) return;
    }
    throw new Error("点击发送后输入框未清空，无法确认发送成功");
  }

  function dataUrlToFile(stored) {
    const dataUrl = String(stored?.dataUrl || "");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const bytes = /;base64/i.test(meta)
      ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return new File([bytes], stored.name || "material", {
      type: stored.type || meta.match(/^data:([^;,]+)/i)?.[1] || "application/octet-stream",
      lastModified: stored.lastModified || Date.now(),
    });
  }

  async function loadMediaFiles() {
    const meta = await storageGet(MEDIA_META_KEY);
    const capturedAt = Number(meta?.capturedAt || 0);
    if (!capturedAt || !Number(meta?.count || 0)) {
      cachedMediaCapturedAt = 0;
      cachedMediaFiles = [];
      return [];
    }
    if (cachedMediaCapturedAt === capturedAt && cachedMediaFiles.length) {
      return cachedMediaFiles;
    }
    const media = await storageGet(MEDIA_KEY);
    cachedMediaFiles = (media?.files || []).map(dataUrlToFile).filter(Boolean);
    cachedMediaCapturedAt = capturedAt;
    return cachedMediaFiles;
  }

  function chooseFileInput() {
    return Array.from(document.querySelectorAll("input[type='file']"))
      .map((el) => {
        const meta = lower([el.accept, el.name, el.id, el.className].join(" "));
        let score = 0;
        if (/image|video/.test(meta)) score += 5;
        if (/file|upload|attachment/.test(meta)) score += 3;
        if (el.multiple) score += 1;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.el;
  }

  async function sendPersistedMedia() {
    const files = await loadMediaFiles();
    if (!files.length) return { sent: 0, skipped: true };
    const fileInput = chooseFileInput();
    if (!fileInput) throw new Error("聊天窗口没有可用的图片/视频上传控件");
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(Math.max(1400, files.length * 450));
    const input = findChatInput();
    const sendButton = input ? findSendButton(input) : null;
    if (sendButton && !buttonDisabled(sendButton)) {
      sendButton.click();
      await sleep(650);
    }
    try {
      fileInput.value = "";
    } catch {
      // Some upload controls do not allow resetting the value.
    }
    return { sent: files.length, skipped: false };
  }

  function findCloseButton() {
    const candidates = Array.from(
      document.querySelectorAll(
        "button,[role='button'],a,[aria-label],[title],[class*='close'],[class*='Close'],span,i,svg"
      )
    )
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const meta = lower(
          [
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.className,
            textOf(el),
          ]
            .filter(Boolean)
            .join(" ")
        );
        let score = 0;
        if (/关闭|close/.test(meta)) score += 100;
        if (rect.top >= 0 && rect.top <= 140) score += 20;
        if (rect.right >= innerWidth - 85) score += 35;
        if (rect.right >= innerWidth - 45) score += 20;
        if (rect.width >= 8 && rect.height >= 8 && rect.width <= 70 && rect.height <= 70) score += 15;
        if (/搜索|search/.test(meta)) score -= 100;
        return { el, rect, score, meta };
      })
      .filter((item) => item.score >= 65)
      .sort((a, b) => b.score - a.score || b.rect.left - a.rect.left || a.rect.width - b.rect.width);

    const candidate = candidates[0]?.el;
    if (!candidate) return null;
    return (
      candidate.closest("button,[role='button'],a,[class*='close'],[class*='Close']") ||
      candidate
    );
  }

  async function handleCompose(payload = {}) {
    const recipientCheck = await waitForRecipient(
      payload.expectedRecipient,
      payload.previousRecipient,
      Math.max(300, Number(payload.recipientTimeout || 15000))
    );
    const recipient = recipientCheck.recipient;
    const input = await waitForChatInput(15000);
    const message = norm(payload.text);
    if (!message) throw new Error("发送内容为空");
    await fillText(input, message);
    if (inputValue(input) !== message) throw new Error("话术没有完整填入聊天输入框");
    if (payload.dryRun) {
      return {
        recipient,
        recipientMatch: recipientCheck.match,
        filled: true,
        sent: false,
        mediaSent: 0,
      };
    }
    await clickSend(input);
    const mediaResult = payload.sendMedia ? await sendPersistedMedia() : { sent: 0, skipped: true };
    return {
      recipient,
      recipientMatch: recipientCheck.match,
      filled: true,
      sent: true,
      mediaSent: mediaResult.sent,
      mediaSkipped: mediaResult.skipped,
    };
  }

  async function respond(id, result) {
    await storageSet(RESULT_KEY, { id, completedAt: Date.now(), ...result });
  }

  async function handleCommand(command) {
    if (!command?.id || handledCommands.has(command.id)) return;
    if (Date.now() - Number(command.createdAt || 0) > 60000) return;
    handledCommands.add(command.id);
    if (handledCommands.size > 100) handledCommands.delete(handledCommands.values().next().value);

    try {
      if (command.action === "status") {
        await respond(command.id, {
          ok: true,
          ready: Boolean(findChatInput()),
          recipient: readActiveRecipient(),
        });
        return;
      }
      if (command.action === "compose") {
        await respond(command.id, { ok: true, ...(await handleCompose(command.payload)) });
        return;
      }
      if (command.action === "close") {
        const closeButton = findCloseButton();
        if (!closeButton) throw new Error("找不到旺旺聊天窗口的关闭按钮");
        await respond(command.id, { ok: true, scheduled: true });
        setTimeout(() => closeButton.click(), 80);
        return;
      }
      throw new Error(`未知聊天指令：${command.action}`);
    } catch (error) {
      await respond(command.id, { ok: false, error: error?.message || String(error) });
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[MEDIA_KEY] || changes[MEDIA_META_KEY]) {
      cachedMediaCapturedAt = 0;
      cachedMediaFiles = [];
    }
    if (!changes[COMMAND_KEY]?.newValue) return;
    handleCommand(changes[COMMAND_KEY].newValue);
  });

  storageGet(COMMAND_KEY).then(handleCommand).catch(() => {});
})();

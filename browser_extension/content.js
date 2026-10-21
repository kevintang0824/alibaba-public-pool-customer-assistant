(() => {
  if (window.__aliPublicCustomerAssistantLoaded) return;
  window.__aliPublicCustomerAssistantLoaded = true;

  const DEFAULT_TEXT = "";
  const STORAGE_PREFIX = "aliPublicCustomerAssistantV1";
  const SETTINGS_KEY = `${STORAGE_PREFIX}Settings`;
  const WORKFLOW_KEY = `${STORAGE_PREFIX}Workflow`;
  const SCAN_WORKFLOW_KEY = `${STORAGE_PREFIX}ScanWorkflow`;
  const PREPARED_QUEUE_KEY = `${STORAGE_PREFIX}PreparedQueue`;
  const MEDIA_KEY = `${STORAGE_PREFIX}Media`;
  const MEDIA_META_KEY = `${STORAGE_PREFIX}MediaMeta`;
  const CHAT_COMMAND_KEY = `${STORAGE_PREFIX}ChatCommand`;
  const CHAT_RESULT_KEY = `${STORAGE_PREFIX}ChatResult`;

  const state = {
    running: false,
    scanning: false,
    prepared: false,
    pagesScanned: 0,
    rows: [],
    rowMap: new Map(),
    selectedKeys: new Set(),
    files: [],
    persistedFilesCount: 0,
    logs: [],
  };

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

  function storageRemove(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(key, resolve);
      } catch {
        resolve();
      }
    });
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.closest("#acda-panel")) return false;
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
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth
    );
  }

  function rendered(el) {
    if (!el || !(el instanceof Element) || el.closest("#acda-panel")) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0.05 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function textOf(el) {
    if (!el) return "";
    const content = el.innerText || el.textContent || "";
    const parts = [content, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
      .map(norm)
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
    return norm(parts.join(" "));
  }

  function ownTextOf(el) {
    if (!el) return "";
    const own = Array.from(el.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" ");
    const parts = [own, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
      .map(norm)
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
    return norm(parts.join(" "));
  }

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    state.logs.push(line);
    if (state.logs.length > 400) state.logs.shift();
    const box = document.querySelector("#acda-log");
    if (box) {
      box.textContent = state.logs.slice(-140).join("\n");
      box.scrollTop = box.scrollHeight;
    }
  }

  function updateStats() {
    const customers = document.querySelector("#acda-count");
    const files = document.querySelector("#acda-files-count");
    if (customers) {
      const prefix = state.scanning ? `扫描：${state.pagesScanned} 页` : `已扫：${state.pagesScanned} 页`;
      customers.textContent = `${prefix}｜客户：${state.selectedKeys.size}/${state.rows.length}`;
    }
    if (files) files.textContent = `素材：${state.files.length || state.persistedFilesCount}`;
  }

  function shouldInjectPanel() {
    const href = location.href;
    return /(^|\.)alibaba\.com$/i.test(location.hostname) && /alicrm|public[_-]?customer|customer_detail|\/hub\//i.test(href);
  }

  function detectBlockingState() {
    const bodyText = norm(document.body?.innerText || "");
    const keywords = ["验证码", "安全验证", "重新登录", "登录异常", "账号异常", "风险验证", "滑块", "人机验证"];
    const hit = keywords.find((keyword) => bodyText.includes(keyword));
    if (hit) throw new Error(`检测到需要人工处理：${hit}`);
    const memory = performance?.memory;
    if (memory?.usedJSHeapSize > 900 * 1024 * 1024) {
      throw new Error("当前网页内存已超过 900MB，请刷新页面后缩小客户数量");
    }
  }

  function isDetailPage() {
    const bodyText = norm(document.body?.innerText || "");
    return location.href.includes("customer_detail") || (bodyText.includes("客户详情") && bodyText.includes("客户来源"));
  }

  function readSettings() {
    const minDelay = Math.max(0.3, Number(document.querySelector("#acda-min-delay")?.value || 1));
    const maxDelay = Math.max(minDelay, Number(document.querySelector("#acda-max-delay")?.value || minDelay));
    const lightweightMode = document.querySelector("#acda-lightweight-mode")?.checked !== false;
    const scanPageLimit = lightweightMode ? 20 : 200;
    const customerCountLimit = lightweightMode ? 100 : 2000;
    return {
      introText: document.querySelector("#acda-message")?.value || DEFAULT_TEXT,
      speed: document.querySelector("#acda-speed")?.value || "safe",
      minDelay,
      maxDelay,
      scanPages: Math.min(
        scanPageLimit,
        Math.max(1, Number(document.querySelector("#acda-scan-pages")?.value || 1))
      ),
      customerLimit: Math.min(
        customerCountLimit,
        Math.max(1, Number(document.querySelector("#acda-customer-limit")?.value || 20))
      ),
      skipCount: Math.min(
        99,
        Math.max(0, Number(document.querySelector("#acda-skip-count")?.value || 0))
      ),
      verifyRecipient: Boolean(document.querySelector("#acda-verify")?.checked),
      randomOrder: Boolean(document.querySelector("#acda-random")?.checked),
      sendMedia: Boolean(document.querySelector("#acda-send-media")?.checked),
      currentPageMode: Boolean(document.querySelector("#acda-current-page-mode")?.checked),
      lightweightMode,
    };
  }

  function applySettings(settings = {}) {
    const message = document.querySelector("#acda-message");
    if (message) message.value = settings.introText || DEFAULT_TEXT;
    const speed = document.querySelector("#acda-speed");
    if (speed) speed.value = settings.speed || "safe";
    const minDelay = document.querySelector("#acda-min-delay");
    if (minDelay) minDelay.value = settings.minDelay || 1;
    const maxDelay = document.querySelector("#acda-max-delay");
    if (maxDelay) maxDelay.value = settings.maxDelay || 1;
    const scanPages = document.querySelector("#acda-scan-pages");
    if (scanPages) scanPages.value = settings.scanPages || 1;
    const customerLimit = document.querySelector("#acda-customer-limit");
    if (customerLimit) customerLimit.value = settings.customerLimit || 20;
    const skipCount = document.querySelector("#acda-skip-count");
    if (skipCount) skipCount.value = settings.skipCount || 0;
    const verify = document.querySelector("#acda-verify");
    if (verify) verify.checked = settings.verifyRecipient !== false;
    const random = document.querySelector("#acda-random");
    if (random) random.checked = Boolean(settings.randomOrder);
    const sendMedia = document.querySelector("#acda-send-media");
    if (sendMedia) sendMedia.checked = Boolean(settings.sendMedia);
    const currentPageMode = document.querySelector("#acda-current-page-mode");
    if (currentPageMode) currentPageMode.checked = settings.currentPageMode !== false;
    const lightweightMode = document.querySelector("#acda-lightweight-mode");
    if (lightweightMode) lightweightMode.checked = settings.lightweightMode !== false;
    syncLightweightControls();
  }

  function syncLightweightControls() {
    const enabled = document.querySelector("#acda-lightweight-mode")?.checked !== false;
    const files = document.querySelector("#acda-files");
    const sendMedia = document.querySelector("#acda-send-media");
    if (files) files.disabled = false;
    if (sendMedia) sendMedia.disabled = false;
    const tip = document.querySelector("#acda-media-tip");
    if (tip) {
      tip.textContent = enabled
        ? "选择图片后会自动切换到图文模式；建议 1–2 张清晰产品图，过多图片会让聊天页变慢。"
        : "图文模式已开启；先用“测试1个”核对文字和图片，再正式发送。";
    }
  }

  function renderMessage(template, item = {}) {
    return String(template || "")
      .replace(/\{name\}/gi, norm(item.name) || "there")
      .replace(/\{company\}/gi, norm(item.company) || "your company")
      .trim();
  }

  function renderMediaList(files = []) {
    const list = document.querySelector("#acda-media-list");
    if (!list) return;
    list.textContent = files.length
      ? files.map((file) => `${file.type?.startsWith("image/") ? "🖼" : "🎬"} ${file.name}`).join(" · ")
      : "尚未选择素材";
  }

  function saveSettings() {
    storageSet(SETTINGS_KEY, readSettings()).catch(() => {});
  }

  function buildPanel() {
    if (document.querySelector("#acda-panel") || !shouldInjectPanel()) return;

    const panel = document.createElement("div");
    panel.id = "acda-panel";
    panel.innerHTML = `
      <div class="acda-head">
        <div class="acda-title">阿里公海客户开发助手 v1.2</div>
        <button id="acda-toggle" title="收起/展开">-</button>
      </div>
      <div class="acda-body">
        <div class="acda-field">
          <label for="acda-message">公司介绍语（必填）</label>
          <textarea
            id="acda-message"
            aria-label="公司介绍语"
            placeholder="请输入自己的公司介绍语。测试或群发前会检查此项。"
          ></textarea>
          <div class="acda-field-hint">支持个性化变量：<code>{name}</code> 客户名、<code>{company}</code> 公司名。建议 2–4 行，先说价值，再用一个问题收尾。</div>
        </div>
        <div class="acda-field">
          <select id="acda-speed" aria-label="速度档">
            <option value="safe">安全档（推荐）</option>
            <option value="normal">普通档</option>
            <option value="fast">快速档</option>
            <option value="open">全开放/无上限</option>
          </select>
        </div>
        <div class="acda-field acda-range">
          <label>发送间隔</label>
          <input id="acda-min-delay" type="number" min="0.3" step="0.1" value="1" />
          <span>-</span>
          <input id="acda-max-delay" type="number" min="0.3" step="0.1" value="1" />
          <span>秒</span>
        </div>
        <div class="acda-field">
          <label>图片/视频素材（建议 1–2 张主图）</label>
          <input id="acda-files" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" multiple />
          <div id="acda-media-tip" class="acda-field-hint">选择图片后会自动切换到图文模式；建议 1–2 张清晰产品图，过多图片会让聊天页变慢。</div>
          <div id="acda-media-list" class="acda-media-list">尚未选择素材</div>
        </div>
        <div class="acda-field acda-range">
          <label>抓取范围</label>
          <input id="acda-scan-pages" type="number" min="1" max="200" value="1" aria-label="扫描页数" />
          <span>页</span>
          <input id="acda-customer-limit" type="number" min="1" max="2000" value="20" aria-label="最多客户数" />
          <span>个客户</span>
        </div>
        <div class="acda-field acda-range">
          <label>跳过前</label>
          <input id="acda-skip-count" type="number" min="0" max="99" value="0" aria-label="跳过前几位客户" />
          <span>位客户后开始</span>
        </div>
        <div class="acda-checks">
          <label><input id="acda-lightweight-mode" type="checkbox" checked /> 轻量扫描（选图后自动切换为图文模式）</label>
          <label><input id="acda-current-page-mode" type="checkbox" checked /> 当前页快捷模式：旺旺 → 发送 → 关闭</label>
          <label><input id="acda-verify" type="checkbox" checked /> 发送前校验收件人</label>
          <label><input id="acda-random" type="checkbox" /> 全部客户乱序发送</label>
          <label><input id="acda-send-media" type="checkbox" /> 随话术发送已选图片/视频</label>
        </div>
        <div class="acda-actions">
          <button id="acda-scan-pages-button" class="acda-secondary">1. 扫描客户</button>
          <button id="acda-test-one" class="acda-test">2. 测试1个（不发）</button>
          <button id="acda-start">3. 开始群发</button>
          <button id="acda-stop" class="acda-danger">停止</button>
          <button id="acda-clear" class="acda-secondary">清空队列</button>
        </div>
        <div class="acda-stats">
          <span id="acda-count">已扫：0 页｜客户：0/0</span>
          <span id="acda-files-count">素材：0</span>
        </div>
        <div id="acda-log" class="acda-log"></div>
        <div class="acda-tip">选图后先点“测试1个”核对收件人、个性化话术和素材。测试只填入文字，不会发送或关闭窗口；正式群发建议每批 10–20 位。</div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    document.querySelector("#acda-toggle").addEventListener("click", () => {
      panel.classList.toggle("acda-collapsed");
      document.querySelector("#acda-toggle").textContent = panel.classList.contains("acda-collapsed") ? "+" : "-";
    });
    document.querySelector("#acda-files").addEventListener("change", async (event) => {
      state.files = Array.from(event.target.files || []);
      const lightweight = document.querySelector("#acda-lightweight-mode");
      const sendMedia = document.querySelector("#acda-send-media");
      if (state.files.length) {
        if (lightweight) lightweight.checked = false;
        if (sendMedia) sendMedia.checked = true;
      }
      syncLightweightControls();
      renderMediaList(state.files);
      updateStats();
      log(`已选择 ${state.files.length} 个图片/视频素材。`);
      try {
        await persistSelectedFiles(state.files);
      } catch (error) {
        state.persistedFilesCount = 0;
        updateStats();
        log(`素材保存失败：${error.message}`);
        alert(`素材保存失败：${error.message}`);
      }
      saveSettings();
    });
    document.querySelector("#acda-scan-pages-button").addEventListener("click", () =>
      runAction(() => beginConfiguredScan({ autoStart: false, dryRun: false }))
    );
    document.querySelector("#acda-test-one").addEventListener("click", () =>
      runAction(() => startBatch({ dryRun: true, limit: 1 }))
    );
    document.querySelector("#acda-start").addEventListener("click", () =>
      runAction(() => startBatch({ dryRun: false }))
    );
    document.querySelector("#acda-stop").addEventListener("click", stopRun);
    document.querySelector("#acda-clear").addEventListener("click", clearAll);
    document.querySelector("#acda-lightweight-mode").addEventListener("change", () => {
      syncLightweightControls();
      invalidatePreparedQueue();
    });
    panel.addEventListener("change", saveSettings);
    panel.addEventListener("input", saveSettings);
    for (const id of [
      "#acda-scan-pages",
      "#acda-customer-limit",
      "#acda-current-page-mode",
    ]) {
      document.querySelector(id)?.addEventListener("change", invalidatePreparedQueue);
    }

    Promise.all([
      storageGet(SETTINGS_KEY),
      storageGet(PREPARED_QUEUE_KEY),
      storageGet(MEDIA_META_KEY),
      storageGet(WORKFLOW_KEY),
    ])
      .then(([settings, prepared, mediaMeta, pausedWorkflow]) => {
        applySettings(settings || {});
        state.persistedFilesCount = Number(mediaMeta?.count || 0);
        if (mediaMeta?.names?.length) {
          renderMediaList(mediaMeta.names.map((name, index) => ({ name, type: mediaMeta.types?.[index] || "" })));
        }
        restorePreparedQueue(prepared);
        if (
          pausedWorkflow?.queue?.length &&
          pausedWorkflow.running === false &&
          Number(pausedWorkflow.index || 0) < pausedWorkflow.queue.length
        ) {
          log(
            `发现暂停任务：第 ${pausedWorkflow.index + 1}/${pausedWorkflow.queue.length} 位，点击“开始群发”继续。`
          );
        }
        updateStats();
      })
      .catch(() => applySettings());
    log("插件已加载。设置抓取页数和客户数后，点“扫描客户”。");
    updateStats();
    setTimeout(resumeWorkflowIfNeeded, 900);
  }

  async function runAction(action) {
    try {
      detectBlockingState();
      await action();
    } catch (error) {
      state.running = false;
      state.scanning = false;
      const workflow = await storageGet(WORKFLOW_KEY);
      if (workflow?.queue?.length && Number(workflow.index || 0) < workflow.queue.length) {
        await storageSet(WORKFLOW_KEY, {
          ...workflow,
          running: false,
          lastError: error?.message || String(error),
          pausedAt: Date.now(),
        });
      } else {
        await storageRemove(WORKFLOW_KEY);
      }
      await storageRemove(SCAN_WORKFLOW_KEY);
      const message = error?.message || String(error);
      log(`暂停：${message}`);
      alert(`操作暂停：${message}`);
    }
  }

  async function clearAll() {
    state.running = false;
    state.scanning = false;
    state.prepared = false;
    state.pagesScanned = 0;
    state.rows = [];
    state.rowMap.clear();
    state.selectedKeys.clear();
    state.logs = [];
    clearHighlights();
    await storageRemove(WORKFLOW_KEY);
    await storageRemove(SCAN_WORKFLOW_KEY);
    await storageRemove(PREPARED_QUEUE_KEY);
    await storageRemove(MEDIA_KEY);
    await storageRemove(MEDIA_META_KEY);
    state.persistedFilesCount = 0;
    const box = document.querySelector("#acda-log");
    if (box) box.textContent = "";
    updateStats();
    log("已清空队列。");
  }

  async function stopRun() {
    state.running = false;
    state.scanning = false;
    await storageRemove(WORKFLOW_KEY);
    await storageRemove(SCAN_WORKFLOW_KEY);
    log("已停止。");
  }

  function checkCopy() {
    const text = norm(readSettings().introText);
    if (!text) {
      alert("文案为空，请先填写通用介绍语。");
      return;
    }
    const warnings = [];
    if (text.length < 20) warnings.push("文案较短");
    if (/(whatsapp|wechat|@|gmail|hotmail|phone|tel|\+\d{5,})/i.test(text)) warnings.push("疑似包含站外联系方式");
    if (!/[?.!。！？]/.test(text)) warnings.push("结尾缺少自然停顿符号");
    log(warnings.length ? `文案检查：${warnings.join("，")}。` : "文案检查通过。");
    alert(warnings.length ? `文案检查：${warnings.join("，")}。` : "文案检查通过。");
  }

  function requireIntroText(settings = readSettings()) {
    const text = String(settings?.introText || "").trim();
    if (!norm(text)) {
      throw new Error("请先填写自己的公司介绍语，再测试或群发。");
    }
    return text;
  }

  function invalidatePreparedQueue() {
    if (state.scanning || state.running || !state.prepared) return;
    state.prepared = false;
    storageRemove(PREPARED_QUEUE_KEY).catch(() => {});
    log("抓取范围已更改，请重新扫描客户。");
  }

  function restorePreparedQueue(prepared) {
    if (!prepared?.queue?.length || prepared.hostname !== location.hostname) return;
    const age = Date.now() - Number(prepared.capturedAt || 0);
    if (age > 2 * 60 * 60 * 1000) {
      storageRemove(PREPARED_QUEUE_KEY).catch(() => {});
      return;
    }
    const lightweightMode = document.querySelector("#acda-lightweight-mode")?.checked !== false;
    const restoredQueue = lightweightMode ? prepared.queue.slice(0, 100) : prepared.queue;
    hydrateRows(restoredQueue, prepared.pagesScanned || 0);
    state.prepared = true;
    if (restoredQueue.length < prepared.queue.length) {
      log(`轻量模式仅恢复前 ${restoredQueue.length} 个客户，避免占用过多内存。`);
    }
    log(`已恢复上次扫描队列：${state.rows.length} 个客户，共 ${state.pagesScanned} 页。`);
  }

  function hydrateRows(rows, pagesScanned = 0) {
    state.rows = [];
    state.rowMap.clear();
    state.selectedKeys.clear();
    addRows(
      (rows || []).map((row) => ({ ...row, el: null, parts: null, highlightEl: null, nameEl: null })),
      true
    );
    state.pagesScanned = pagesScanned;
    updateStats();
  }

  function makeRowKey(row) {
    const id = row.detailUrl?.match(/customerId=([^&#]+)/)?.[1];
    if (id) return `id:${decodeURIComponent(id)}`;
    if (row.email) return `email:${lower(row.email)}`;
    return `name:${lower(row.name)}|${lower(row.company)}`;
  }

  function addRows(rows, select, customerLimit = Number.POSITIVE_INFINITY) {
    let added = 0;
    for (const row of rows) {
      if (!row.name) continue;
      row.key = makeRowKey(row);
      if (!state.rowMap.has(row.key)) {
        if (state.rows.length >= customerLimit) break;
        state.rows.push(row);
        state.rowMap.set(row.key, row);
        added += 1;
      } else {
        const old = state.rowMap.get(row.key);
        Object.assign(old, row, { key: old.key });
      }
      if (select) state.selectedKeys.add(row.key);
    }
    updateStats();
    highlightSelectedRows();
    return added;
  }

  async function scanCurrentScreen({ reset, select, metadata = {}, customerLimit = Number.POSITIVE_INFINITY }) {
    detectBlockingState();
    if (reset) {
      state.rows = [];
      state.rowMap.clear();
      state.selectedKeys.clear();
    }
    const rows = findVisibleCustomerRows().map((row) => ({ ...row, ...metadata }));
    const added = addRows(rows, select, customerLimit);
    log(`当前屏识别到 ${rows.length} 条，新增 ${added} 条，累计 ${state.rows.length} 条。`);
    if (!rows.length) log("没有识别到客户。请确认当前页面是公海客户列表或客户详情页。");
    return { found: rows.length, added };
  }

  async function beginConfiguredScan({ autoStart, dryRun, limit }) {
    if (isDetailPage()) throw new Error("请先返回公海客户列表页再扫描。");
    if (state.running || state.scanning) throw new Error("已有任务正在执行，请先停止。");

    const settings = readSettings();
    const customerLimit = Math.max(1, Number(limit || settings.customerLimit));
    const targetPages = dryRun && limit === 1 ? 1 : settings.scanPages;

    state.running = true;
    state.scanning = true;
    state.prepared = false;
    state.pagesScanned = 0;
    state.rows = [];
    state.rowMap.clear();
    state.selectedKeys.clear();
    clearHighlights();
    updateStats();

    await storageRemove(WORKFLOW_KEY);
    await storageRemove(PREPARED_QUEUE_KEY);
    await storageSet(SCAN_WORKFLOW_KEY, {
      running: true,
      autoStart,
      dryRun,
      targetPages,
      customerLimit,
      pagesScanned: 0,
      queue: [],
      settings,
      startPage: readCurrentPageNumber(),
      hostname: location.hostname,
      waitingForNext: false,
    });
    log(`开始扫描：最多 ${targetPages} 页、${customerLimit} 个客户。`);
    await continueConfiguredScan();
  }

  async function continueConfiguredScan() {
    let scan = await storageGet(SCAN_WORKFLOW_KEY);
    if (!scan?.running) return;

    state.running = true;
    state.scanning = true;
    if (!state.rows.length && scan.queue?.length) hydrateRows(scan.queue, scan.pagesScanned || 0);
    if (scan.waitingForNext) {
      const changed = await waitForPageChange(scan.lastFingerprint || "", scan.lastPageNumber || null, 15000);
      if (!changed) {
        log("翻页后页面没有变化，已保留当前扫描结果。");
        await completeConfiguredScan(scan);
        return;
      }
      scan = { ...scan, waitingForNext: false };
      await storageSet(SCAN_WORKFLOW_KEY, scan);
    }

    while (state.running && scan?.running) {
      detectBlockingState();
      const pageOrdinal = Number(scan.pagesScanned || 0) + 1;
      const pageNumber = readCurrentPageNumber();
      const metadata = {
        pageNumber,
        pageOrdinal,
        listUrl: location.href,
      };
      log(`正在扫描第 ${pageOrdinal}/${scan.targetPages} 页${pageNumber ? `（页码 ${pageNumber}）` : ""}。`);
      await scanWholeCurrentPage(
        metadata,
        scan.customerLimit,
        scan.settings?.lightweightMode !== false
      );
      const activeScan = await storageGet(SCAN_WORKFLOW_KEY);
      if (!state.running || !activeScan?.running) return;

      state.pagesScanned = pageOrdinal;
      scan = {
        ...scan,
        pagesScanned: pageOrdinal,
        queue: state.rows.map(serializeRow),
        waitingForNext: false,
      };
      await storageSet(SCAN_WORKFLOW_KEY, scan);
      updateStats();

      const reachedPageLimit = pageOrdinal >= scan.targetPages;
      const reachedCustomerLimit = state.rows.length >= scan.customerLimit;
      if (reachedPageLimit || reachedCustomerLimit) {
        await completeConfiguredScan(scan);
        return;
      }

      const beforeFingerprint = getPageFingerprint();
      releaseRowDomReferences();
      scan = {
        ...scan,
        waitingForNext: true,
        lastFingerprint: beforeFingerprint,
        lastPageNumber: pageNumber,
      };
      await storageSet(SCAN_WORKFLOW_KEY, scan);
      const moved = await clickNextPage();
      if (!moved) {
        log("已经到最后一页，提前结束扫描。");
        await completeConfiguredScan(scan);
        return;
      }
      const changed = await waitForPageChange(beforeFingerprint, pageNumber);
      if (!changed) {
        log("下一页没有加载成功，已保留当前扫描结果。");
        await completeConfiguredScan(scan);
        return;
      }
      scan = { ...scan, waitingForNext: false };
      await storageSet(SCAN_WORKFLOW_KEY, scan);
    }
  }

  async function scanWholeCurrentPage(metadata, customerLimit, lightweightMode = true) {
    const before = state.rows.length;
    if (lightweightMode) {
      await sleep(80);
      await scanCurrentScreen({
        reset: false,
        select: true,
        metadata,
        customerLimit,
      });
      log(`本页轻量扫描完成，新增 ${state.rows.length - before} 个客户。`);
      return;
    }

    window.scrollTo({ top: 0, behavior: "auto" });
    await sleep(450);

    let stableRounds = 0;
    for (let step = 0; step < 30 && state.running; step += 1) {
      await scanCurrentScreen({
        reset: false,
        select: true,
        metadata,
        customerLimit,
      });
      if (state.rows.length >= customerLimit) break;

      const beforeY = Math.round(window.scrollY);
      const beforeHeight = document.documentElement.scrollHeight;
      const distance = Math.max(420, Math.floor(window.innerHeight * 0.78));
      window.scrollBy({ top: distance, behavior: "auto" });
      await sleep(420);
      const afterY = Math.round(window.scrollY);
      const afterHeight = document.documentElement.scrollHeight;
      const atBottom = afterY + window.innerHeight >= afterHeight - 8;
      if (afterY === beforeY && afterHeight === beforeHeight) stableRounds += 1;
      else stableRounds = 0;
      if (atBottom || stableRounds >= 2) {
        await scanCurrentScreen({
          reset: false,
          select: true,
          metadata,
          customerLimit,
        });
        break;
      }
    }
    log(`本页扫描完成，新增 ${state.rows.length - before} 个客户。`);
  }

  async function completeConfiguredScan(scan) {
    state.running = false;
    state.scanning = false;
    state.prepared = true;
    state.pagesScanned = Number(scan.pagesScanned || state.pagesScanned || 0);
    await storageRemove(SCAN_WORKFLOW_KEY);
    await storageSet(PREPARED_QUEUE_KEY, {
      queue: state.rows.map(serializeRow),
      pagesScanned: state.pagesScanned,
      capturedAt: Date.now(),
      hostname: location.hostname,
    });
    updateStats();
    log(`扫描完成：共 ${state.pagesScanned} 页，去重后 ${state.rows.length} 个客户。`);

    if (scan.autoStart) {
      await launchPreparedQueue({
        dryRun: Boolean(scan.dryRun),
        limit: scan.dryRun ? 1 : undefined,
        settings: scan.settings || readSettings(),
      });
    }
  }

  function findVisibleCustomerRows() {
    const rows = [];
    const usedRoots = new Set();
    const lightweightMode = document.querySelector("#acda-lightweight-mode")?.checked !== false;

    const tableRowSelectors = [
      "tbody tr.ant-table-row",
      "tbody tr.next-table-row",
      "tbody tr[class*='table-row']",
      "[role='row'][class*='table-row']",
    ];
    for (const el of document.querySelectorAll(tableRowSelectors.join(","))) {
      if (!rendered(el) || usedRoots.has(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height < 34 || rect.height > 220 || rect.width < 420) continue;
      const rawText = el.innerText || el.textContent || "";
      if (!looksLikeCustomerRow(norm(rawText))) continue;
      const row = parseRowText(rawText, el, null);
      if (row?.name) {
        rows.push(row);
        usedRoots.add(el);
      }
    }
    if (rows.length) {
      return rows
        .filter((row) => row.name && !/客户阶段|跟进状态|采购意向|操作|公海/.test(row.name))
        .sort((a, b) => a.y - b.y);
    }

    const rootSelectors = [
      "tr",
      "[role='row']",
      ".next-table-row",
      ".ant-table-row",
      "[class*='table-row']",
      "[class*='TableRow']",
      "[class*='row']",
    ];
    for (const el of document.querySelectorAll(rootSelectors.join(","))) {
      if (!visible(el) || usedRoots.has(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height < 34 || rect.height > 180 || rect.width < 420 || rect.top < 120) continue;
      const rawText = el.innerText || el.textContent || "";
      if (!looksLikeCustomerRow(norm(rawText))) continue;
      const row = parseRowText(rawText, el, null);
      if (row?.name) {
        rows.push(row);
        usedRoots.add(el);
      }
    }
    if (rows.length || lightweightMode) {
      return rows
        .filter((row) => row.name && !/客户阶段|跟进状态|采购意向|操作|公海/.test(row.name))
        .sort((a, b) => a.y - b.y);
    }

    const bandRows = findRowsByVisualBands();
    for (const row of bandRows) {
      const duplicate = rows.some((old) => Math.abs(old.y - row.y) < 18 || makeRowKey(old) === makeRowKey(row));
      if (!duplicate) rows.push(row);
    }

    return rows
      .filter((row) => row.name && !/客户阶段|跟进状态|采购意向|操作|公海/.test(row.name))
      .sort((a, b) => a.y - b.y);
  }

  function releaseRowDomReferences() {
    clearHighlights();
    for (const row of state.rows) {
      row.el = null;
      row.parts = null;
      row.highlightEl = null;
      row.nameEl = null;
    }
  }

  function looksLikeCustomerRow(text) {
    if (!text || text.length < 4) return false;
    if (/客户阶段.*跟进状态.*采购意向/.test(text)) return false;
    return (
      /\bL[1-5]\b/.test(text) ||
      /@/.test(text) ||
      /加为我的客户|TM沟通|公海召回|询盘客户|未标记|采购额/.test(text)
    );
  }

  function findRowsByVisualBands() {
    const textElements = Array.from(document.querySelectorAll("a,span,div,p,td"))
      .filter(visible)
      .map((el) => ({ el, text: ownTextOf(el), rect: el.getBoundingClientRect() }))
      .filter((item) => item.text && item.rect.top > 120 && item.rect.left > 240);

    const badges = textElements.filter((item) => /^L[1-5]$/.test(item.text) && item.rect.width < 42 && item.rect.height < 28);
    const bands = [];
    for (const badge of badges) {
      const nearbyName = textElements
        .filter((item) => item.rect.left < badge.rect.left && item.rect.left > badge.rect.left - 260)
        .filter((item) => Math.abs(item.rect.top - badge.rect.top) < 18)
        .filter((item) => looksLikeNameLine(item.text))
        .sort((a, b) => b.rect.left - a.rect.left)[0];
      const y = nearbyName ? nearbyName.rect.top : badge.rect.top;
      if (!bands.some((old) => Math.abs(old.y - y) < 28)) bands.push({ y, nameEl: nearbyName?.el || badge.el });
    }

    return bands
      .map((band) => {
        const parts = textElements
          .filter((item) => item.rect.top >= band.y - 12 && item.rect.top <= band.y + 82)
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const text = parts.map((item) => item.text).join("\n");
        const row = parseRowText(text, null, parts);
        if (!row) return null;
        row.y = band.y + window.scrollY;
        row.scrollY = Math.max(0, window.scrollY + band.y - 180);
        row.highlightEl = band.nameEl;
        row.nameEl = band.nameEl;
        return row;
      })
      .filter(Boolean);
  }

  function parseRowText(rawText, rootEl, parts) {
    const rect = rootEl?.getBoundingClientRect?.();
    const lines = splitUsefulLines(rawText);
    const customerCell =
      rootEl?.querySelector?.("td:nth-child(2)") ||
      rootEl?.querySelector?.("[class*='customer']") ||
      null;
    const customerLines = splitUsefulLines(customerCell?.innerText || customerCell?.textContent || "");
    const level = rawText.match(/\bL[1-5]\b/)?.[0] || "";
    const email =
      customerLines.find((line) => /[@＠]/.test(line) && /[a-z0-9*._%+-]+[@＠][a-z0-9*.-]+/i.test(line)) ||
      lines.find((line) => /[@＠]/.test(line) && /[a-z0-9*._%+-]+[@＠][a-z0-9*.-]+/i.test(line)) ||
      "";
    const followStatus = lines.find((line) => /TM沟通|公海召回|RFQ报价|询盘|未沟通|-/.test(line)) || "";
    const noteTime = lines.find((line) => /今天|\d{4}-\d{1,2}-\d{1,2}|\d+天前|昨天|前天/.test(line)) || "";
    const detailLink = findDetailUrl(rootEl, parts);
    const nameLine = customerLines.find(looksLikeNameLine) || lines.find(looksLikeNameLine) || "";
    if (!nameLine) return null;
    const name = cleanName(nameLine);
    const company =
      customerLines.find((line) => {
        const clean = cleanName(line);
        return clean && clean !== name && !/@/.test(clean) && !/^L[1-5]$/.test(clean) && !/TM沟通|未标记|采购|今天|\d{4}-/.test(clean);
      }) || "";
    return {
      el: rootEl || null,
      parts: parts || null,
      highlightEl: rootEl || null,
      nameEl: findNameElement(rootEl, name) || null,
      name,
      company: cleanName(company),
      level,
      email,
      followStatus,
      noteTime,
      detailUrl: detailLink,
      y: rect ? rect.top + window.scrollY : 0,
      scrollY: rect ? Math.max(0, rect.top + window.scrollY - 180) : window.scrollY,
      text: rawText,
    };
  }

  function findDetailUrl(rootEl, parts) {
    const elements = [];
    if (rootEl) {
      elements.push(rootEl);
      elements.push(...rootEl.querySelectorAll("a,[data-href],[data-url]"));
    }
    for (const part of parts || []) {
      if (part?.el) elements.push(part.el);
    }

    const candidates = new Set();
    for (const el of elements) {
      if (!(el instanceof Element)) continue;
      if (el.matches?.("a,[data-href],[data-url]")) candidates.add(el);
      const anchor = el.closest?.("a,[data-href],[data-url]");
      if (anchor) candidates.add(anchor);
      const child = el.querySelector?.("a,[data-href],[data-url]");
      if (child) candidates.add(child);
    }

    for (const el of candidates) {
      const raw =
        el.href ||
        el.getAttribute?.("href") ||
        el.getAttribute?.("data-href") ||
        el.getAttribute?.("data-url") ||
        "";
      if (!/customer_detail|customerId=/i.test(raw)) continue;
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    }
    return "";
  }

  function splitUsefulLines(text) {
    return String(text || "")
      .split(/\n| {2,}|\t/)
      .map((line) => norm(line))
      .filter(Boolean)
      .filter((line) => !/^(客户|客户阶段|跟进状态|小记时间|采购意向|年采购额|采购品类|国家|操作)$/.test(line));
  }

  function cleanName(line) {
    return norm(
      String(line || "")
        .replace(/\bL[1-5]\b/g, "")
        .replace(/加为我的客户|Ta的Alibaba买家主页|未读|已读|客户详情/g, "")
        .replace(/[：:]\s*$/, "")
    );
  }

  function looksLikeNameLine(line) {
    const text = cleanName(line);
    if (!text || text.length < 2 || text.length > 80) return false;
    if (/[@＠]/.test(text)) return false;
    if (/^(L[1-5]|-|无采购额|未标记|询盘客户|今天|昨天|前天)$/.test(text)) return false;
    if (/客户阶段|跟进状态|采购|加为我的客户|TM沟通|公海召回|商家主动|完成了|无潜力分|搜索|更多/.test(text)) return false;
    return /[A-Za-z0-9]/.test(text);
  }

  function findNameElement(rootEl, name) {
    if (!rootEl || !name) return null;
    return Array.from(rootEl.querySelectorAll("a,span,div,p"))
      .filter(visible)
      .find((el) => cleanName(ownTextOf(el)) === name || cleanName(ownTextOf(el)).includes(name));
  }

  function clearHighlights() {
    document.querySelectorAll(".acda-highlight").forEach((el) => el.classList.remove("acda-highlight"));
  }

  function highlightSelectedRows() {
    clearHighlights();
    for (const key of state.selectedKeys) {
      const row = state.rowMap.get(key);
      const target = row?.highlightEl || row?.el || row?.nameEl;
      if (target?.classList) target.classList.add("acda-highlight");
    }
  }

  function shuffle(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  async function startBatch({ dryRun, limit }) {
    const currentSettings = readSettings();
    requireIntroText(currentSettings);
    const paused = await storageGet(WORKFLOW_KEY);
    if (
      paused?.queue?.length &&
      paused.running === false &&
      Number(paused.index || 0) < paused.queue.length &&
      Boolean(paused.dryRun) === Boolean(dryRun)
    ) {
      const resumed = {
        ...paused,
        running: true,
        settings: { ...(paused.settings || {}), ...currentSettings },
        lastError: "",
      };
      state.running = true;
      state.scanning = false;
      await storageSet(WORKFLOW_KEY, resumed);
      log(`从第 ${resumed.index + 1}/${resumed.queue.length} 位客户继续。`);
      await runQueueLoop();
      return;
    }
    if (state.prepared && state.rows.length) {
      await launchPreparedQueue({ dryRun, limit, settings: currentSettings });
      return;
    }
    await beginConfiguredScan({ autoStart: true, dryRun, limit });
  }

  async function launchPreparedQueue({ dryRun, limit, settings }) {
    const introText = requireIntroText(settings);
    settings = { ...settings, introText };
    if (settings.sendMedia && !dryRun) {
      const mediaMeta = await storageGet(MEDIA_META_KEY);
      if (!Number(mediaMeta?.count || 0)) {
        throw new Error("已勾选发送图片/视频，但素材尚未保存完成或没有选择素材");
      }
    }
    let queue = state.rows.filter((row) => state.selectedKeys.has(row.key));
    if (settings.randomOrder) queue = shuffle(queue);
    const skipCount = Math.min(queue.length, Math.max(0, Number(settings.skipCount || 0)));
    if (skipCount) {
      queue = queue.slice(skipCount);
      log(`本次跳过队列前 ${skipCount} 位客户。`);
    }
    if (limit) queue = queue.slice(0, limit);
    if (!queue.length) throw new Error("队列为空，请先点“扫描客户”。");

    state.running = true;
    state.scanning = false;
    await storageSet(WORKFLOW_KEY, {
      running: true,
      dryRun,
      queue: queue.map(serializeRow),
      index: 0,
      settings,
    });
    log(dryRun ? "开始试 1 个：只填入，不点击发送。" : `开始群发：本次 ${queue.length} 个客户。`);
    await runQueueLoop();
  }

  function serializeRow(row) {
    return {
      key: row.key,
      name: row.name,
      company: row.company,
      email: row.email,
      level: row.level,
      detailUrl: row.detailUrl,
      scrollY: row.scrollY,
      pageNumber: row.pageNumber,
      pageOrdinal: row.pageOrdinal,
      listUrl: row.listUrl,
    };
  }

  async function resumeWorkflowIfNeeded() {
    const scan = await storageGet(SCAN_WORKFLOW_KEY);
    if (scan?.running) {
      state.running = true;
      state.scanning = true;
      if (scan.queue?.length) hydrateRows(scan.queue, scan.pagesScanned || 0);
      log(`检测到未完成扫描：已扫 ${scan.pagesScanned || 0}/${scan.targetPages} 页，继续执行。`);
      runAction(continueConfiguredScan);
      return;
    }
    const workflow = await storageGet(WORKFLOW_KEY);
    if (!workflow?.running) return;
    state.running = true;
    state.scanning = false;
    log(`检测到未完成队列：${workflow.index + 1}/${workflow.queue.length}。继续执行。`);
    runAction(runQueueLoop);
  }

  async function runQueueLoop() {
    const workflow = await storageGet(WORKFLOW_KEY);
    if (!workflow?.running) return;
    state.running = true;

    while (state.running) {
      detectBlockingState();
      const current = await storageGet(WORKFLOW_KEY);
      if (!current?.running) return;
      if (current.index >= current.queue.length) {
        await storageRemove(WORKFLOW_KEY);
        if (!current.dryRun) {
          await storageRemove(PREPARED_QUEUE_KEY);
          await storageRemove(MEDIA_KEY);
          await storageRemove(MEDIA_META_KEY);
          state.files = [];
          state.persistedFilesCount = 0;
          state.prepared = false;
          releaseRowDomReferences();
          state.rows = [];
          state.rowMap.clear();
          state.selectedKeys.clear();
          updateStats();
          log("队列完成。");
        } else {
          state.prepared = true;
          log("测试完成：未发送，完整扫描队列仍然保留。");
        }
        state.running = false;
        return;
      }

      const item = current.queue[current.index];
      log(`${current.dryRun ? "测试" : "处理"} ${current.index + 1}/${current.queue.length}：${item.name}`);
      const result = isDetailPage()
        ? await processDetailCustomer(item, current)
        : await processListCustomer(item, current);

      if (result === "navigating") return;
      const next = { ...current, index: current.index + 1 };
      await storageSet(WORKFLOW_KEY, next);
      await randomDelay(current.settings);
    }
  }

  async function processListCustomer(item, workflow) {
    let row = locateVisibleRow(item);
    if (!row && Number.isFinite(item.scrollY)) {
      window.scrollTo({ top: Math.max(0, item.scrollY), behavior: "smooth" });
      await sleep(800);
      row = locateVisibleRow(item);
    }
    if (workflow.settings?.currentPageMode !== false) {
      if (!row && item.pageNumber) {
        releaseRowDomReferences();
        const moved = await goToPageNumber(item.pageNumber);
        if (moved) {
          await sleep(900);
          window.scrollTo({ top: Math.max(0, Number(item.scrollY || 0)), behavior: "auto" });
          await sleep(550);
          row = locateVisibleRow(item);
        }
      }
      if (row?.el && !visible(row.el)) {
        row.el.scrollIntoView({ block: "center", behavior: "auto" });
        await sleep(450);
        row = locateVisibleRow(item) || row;
      }
      if (!row) {
        log(`未在第 ${item.pageNumber || "当前"} 页找到客户：${item.name}，跳过。`);
        return "skipped";
      }
      row.highlightEl?.classList?.add("acda-highlight");
      return await processCurrentPageCustomer(row, item, workflow);
    }
    if (!row && item.detailUrl) {
      log(`打开客户详情：${item.name}`);
      location.href = item.detailUrl;
      return "navigating";
    }
    if (!row && item.pageNumber) {
      const moved = await goToPageNumber(item.pageNumber);
      if (moved) {
        await sleep(900);
        window.scrollTo({ top: Math.max(0, Number(item.scrollY || 0)), behavior: "auto" });
        await sleep(550);
        row = locateVisibleRow(item);
      }
    }
    if (row?.el && !visible(row.el)) {
      row.el.scrollIntoView({ block: "center", behavior: "auto" });
      await sleep(450);
      row = locateVisibleRow(item) || row;
    }
    if (!row) {
      log(`未在当前页找到客户：${item.name}，跳过。`);
      return "skipped";
    }

    row.highlightEl?.classList?.add("acda-highlight");
    log(`进入客户详情：${item.name}`);
    if (row.detailUrl) {
      location.href = row.detailUrl;
      return "navigating";
    }
    const opened = await clickCustomerName(row);
    if (!opened) {
      log(`无法打开详情：${item.name}`);
      return "skipped";
    }
    return await processDetailCustomer(item, workflow);
  }

  async function processCurrentPageCustomer(row, item, workflow) {
    const previousStatus = await readChatStatusForSwitch();
    const opened = await clickWangwang(row, item);
    if (!opened) {
      log(`跳过：${item.name} 没有找到可用的旺旺入口。`);
      return "skipped";
    }
    const settings = workflow.settings || readSettings();
    const introText = renderMessage(requireIntroText(settings), item);
    const result = await runChatFrameCommand(
      "compose",
      {
        expectedRecipient: settings.verifyRecipient ? item.name : "",
        previousRecipient: previousStatus?.recipient || "",
        text: introText,
        dryRun: Boolean(workflow.dryRun),
        sendMedia: Boolean(settings.sendMedia),
      },
      settings.sendMedia ? 45000 : 25000
    );

    log(`旺旺已填入话术：${result.recipient || item.name}`);
    if (result.recipientMatch === "switched" || result.recipientMatch === "alias") {
      log(`客户名称不同但会话已确认：${item.name} → ${result.recipient}`);
    }
    if (workflow.dryRun) {
      log("测试模式：未发送、未关闭聊天，请人工检查输入框。");
      return "done";
    }

    log(`旺旺文字已发送：${item.name}`);
    if (result.mediaSent) log(`图片/视频已发送：${result.mediaSent} 个。`);
    await attemptCloseChat(item);
    return "done";
  }

  function chatFrameVisible() {
    return Array.from(
      document.querySelectorAll(
        "iframe.weblite-iframe,iframe[title='聊天窗口-阿里消息界面'],iframe[src*='onetalk.alibaba.com/message/weblite']"
      )
    ).some((frame) => {
      const style = getComputedStyle(frame);
      const rect = frame.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0.05 &&
        rect.width > 260 &&
        rect.height > 220
      );
    });
  }

  async function waitForChatFrameClosed(timeout = 8000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (!chatFrameVisible()) return true;
      await sleep(200);
    }
    return false;
  }

  async function attemptCloseChat(item) {
    try {
      await runChatFrameCommand(
        "close",
        { expectedRecipient: item.name },
        5000
      );
    } catch (error) {
      log(`关闭按钮未响应：${error.message}。下一位仍会校验收件人。`);
      return false;
    }

    if (await waitForChatFrameClosed(1800)) {
      log(`聊天窗口已关闭：${item.name}`);
      return true;
    }

    try {
      const status = await runChatFrameCommand("status", {}, 2500);
      const expected = lower(item.name);
      const actual = lower(status.recipient);
      if (!status.ready || (actual && expected && !actual.includes(expected) && !expected.includes(actual))) {
        log(`当前会话已退出：${item.name}`);
        return true;
      }
    } catch {
      // The iframe may stop responding while Alibaba is collapsing it.
    }

    log(`阿里保留了消息面板，将直接切换下一位并重新校验客户姓名。`);
    return false;
  }

  async function readChatStatusForSwitch() {
    if (!chatFrameVisible()) return null;
    try {
      return await runChatFrameCommand("status", {}, 1800);
    } catch {
      return null;
    }
  }

  async function runChatFrameCommand(action, payload = {}, timeout = 15000) {
    const id =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}-${action}`;
    await storageSet(CHAT_COMMAND_KEY, {
      id,
      action,
      payload,
      createdAt: Date.now(),
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const result = await storageGet(CHAT_RESULT_KEY);
      if (result?.id === id) {
        await storageRemove(CHAT_COMMAND_KEY);
        await storageRemove(CHAT_RESULT_KEY);
        if (!result.ok) throw new Error(result.error || `旺旺指令失败：${action}`);
        return result;
      }
      await sleep(120);
    }
    await storageRemove(CHAT_COMMAND_KEY);
    throw new Error(
      action === "compose"
        ? "旺旺聊天框未响应。请在扩展管理页重新加载插件并刷新阿里页面。"
        : `旺旺指令超时：${action}`
    );
  }

  function locateVisibleRow(item) {
    const rows = findVisibleCustomerRows();
    addRows(rows, false);
    return (
      rows.find((row) => row.key === item.key) ||
      rows.find((row) => row.email && item.email && lower(row.email) === lower(item.email)) ||
      rows.find((row) => lower(row.name) === lower(item.name)) ||
      rows.find((row) => lower(row.name).includes(lower(item.name)) || lower(item.name).includes(lower(row.name)))
    );
  }

  async function processDetailCustomer(item, workflow) {
    await waitForDetailReady();
    await clickAddCustomerInDetail().catch((error) => log(`加客户跳过：${error.message}`));
    const previousStatus = await readChatStatusForSwitch();
    const opened = await clickWangwangInDetail(item);
    if (!opened) {
      log(`跳过：${item.name} 的详情页没有可用旺旺入口。`);
      return "skipped";
    }
    const settings = workflow.settings || readSettings();
    const introText = renderMessage(requireIntroText(settings), item);
    const result = await runChatFrameCommand(
      "compose",
      {
        expectedRecipient: settings.verifyRecipient ? item.name : "",
        previousRecipient: previousStatus?.recipient || "",
        text: introText,
        dryRun: Boolean(workflow.dryRun),
        sendMedia: Boolean(settings.sendMedia),
      },
      settings.sendMedia ? 45000 : 25000
    );
    log(`旺旺已填入话术：${result.recipient || item.name}`);
    if (result.recipientMatch === "switched" || result.recipientMatch === "alias") {
      log(`客户名称不同但会话已确认：${item.name} → ${result.recipient}`);
    }
    if (!workflow.dryRun) {
      log(`旺旺文字已发送：${item.name}`);
      if (result.mediaSent) log(`图片/视频已发送：${result.mediaSent} 个。`);
      await attemptCloseChat(item);
    } else {
      log("测试模式：未发送、未关闭聊天，请人工检查输入框。");
    }

    if (history.length > 1 && (workflow.index + 1 < workflow.queue.length || workflow.dryRun)) {
      log(workflow.dryRun ? "测试完成，返回客户列表。" : "返回列表处理下一个客户。");
      await storageSet(WORKFLOW_KEY, { ...workflow, index: workflow.index + 1 });
      history.back();
      setTimeout(() => runAction(runQueueLoop), 2200);
      return "navigating";
    }
    return "done";
  }

  async function waitForDetailReady() {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (isDetailPage()) return;
      await sleep(300);
    }
    throw new Error("客户详情页未加载完成");
  }

  async function clickAddCustomer(row) {
    const root = row.el || findVisualRootForRow(row);
    const button = findClickableByText("加为我的客户", root);
    if (!button) {
      if (textOf(root || document.body).includes("已是我的客户")) return true;
      throw new Error("当前行没有“加为我的客户”按钮");
    }
    button.click();
    log(`已点击加为我的客户：${row.name}`);
    await sleep(1000);
    closeKnownDialogs();
    return true;
  }

  async function clickAddCustomerInDetail() {
    const button = findClickableByText("加为我的客户", document.body);
    if (!button) {
      if (norm(document.body.innerText).includes("已是我的客户")) return true;
      throw new Error("详情页没有“加为我的客户”按钮");
    }
    button.click();
    log("详情页已点击加为我的客户。");
    await sleep(1200);
    closeKnownDialogs();
    return true;
  }

  function findVisualRootForRow(row) {
    if (row.el) return row.el;
    const y = row.y ? row.y - window.scrollY : null;
    if (!Number.isFinite(y)) return null;
    const candidates = Array.from(document.querySelectorAll("div,tr,[role='row']"))
      .filter(visible)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top <= y + 8 && rect.bottom >= y + 28 && rect.width > 420 && rect.height < 190;
      })
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    return candidates[0] || null;
  }

  function findClickableByText(keyword, root = document.body) {
    return Array.from(root.querySelectorAll("button,a,span,div,[role='button']"))
      .filter(visible)
      .filter((el) => textOf(el).includes(keyword))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
  }

  async function clickCustomerName(row) {
    const root = row.el || findVisualRootForRow(row);
    const link = root?.querySelector?.("a[href*='customer_detail'],a[href*='customerId']");
    if (link && visible(link)) {
      link.click();
      return true;
    }
    const nameEl =
      row.nameEl ||
      Array.from((root || document).querySelectorAll("a,span,div,p"))
        .filter(visible)
        .find((el) => cleanName(ownTextOf(el)).includes(row.name));
    if (nameEl) {
      nameEl.click();
      return true;
    }
    return false;
  }

  async function clickWangwang(row, item = row) {
    let target = findWangwangNearRow(row);
    if (!target) {
      const root = row.el || findVisualRootForRow(row);
      root?.scrollIntoView?.({ block: "center", behavior: "auto" });
      await sleep(350);
      const refreshed = locateVisibleRow(item);
      if (refreshed) {
        row = refreshed;
        target = findWangwangNearRow(refreshed);
      }
    }
    if (!target) return false;
    target.click();
    log(`已点击旺旺：${row.name}`);
    await sleep(1200);
    return true;
  }

  async function clickWangwangInDetail(item) {
    const target = findWangwangNearDetailName(item.name) || findClickableByText("TM沟通", document.body);
    if (!target) return false;
    target.click();
    log(`详情页已点击旺旺：${item.name}`);
    await sleep(1400);
    return true;
  }

  function findWangwangNearRow(row) {
    const root = row.el || findVisualRootForRow(row);
    const exact = root?.querySelector?.("[title='立即沟通'],.alitalk-unit,[aria-label='立即沟通']");
    if (exact && visible(exact)) return exact;

    const nameEl =
      row.nameEl ||
      row.highlightEl ||
      Array.from(document.querySelectorAll("a,span,div,p"))
        .filter(visible)
        .find((el) => cleanName(ownTextOf(el)) === row.name);
    if (!nameEl) return null;
    const nameRect = nameEl.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll("button,a,span,div,i,svg"))
      .filter(visible)
      .filter((el) => !/^L[1-5]$/.test(ownTextOf(el)))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8 || rect.width > 36 || rect.height > 36) return false;
        const nearName = rect.left >= nameRect.right - 8 && rect.left <= nameRect.right + 90 && Math.abs(rect.top - nameRect.top) < 24;
        return nearName && looksBlue(el);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.left - br.left;
      });
    return candidates[0] || null;
  }

  function findWangwangNearDetailName(name) {
    const nameEls = Array.from(document.querySelectorAll("a,span,div,p"))
      .filter(visible)
      .filter((el) => cleanName(ownTextOf(el)) === name || cleanName(ownTextOf(el)).includes(name))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    for (const nameEl of nameEls) {
      let scope = nameEl;
      for (let depth = 0; depth < 5 && scope; depth += 1, scope = scope.parentElement) {
        const exact = scope.querySelector?.("[title='立即沟通'],.alitalk-unit,[aria-label='立即沟通']");
        if (exact && visible(exact)) return exact;
      }
      const nameRect = nameEl.getBoundingClientRect();
      const candidate = Array.from(document.querySelectorAll("button,a,span,div,i,svg"))
        .filter(visible)
        .filter((el) => !/^L[1-5]$/.test(ownTextOf(el)))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8 || rect.width > 36 || rect.height > 36) return false;
          return rect.left >= nameRect.right - 6 && rect.left <= nameRect.right + 90 && Math.abs(rect.top - nameRect.top) < 28 && looksBlue(el);
        })[0];
      if (candidate) return candidate;
    }
    return null;
  }

  function looksBlue(el) {
    const style = getComputedStyle(el);
    const colors = [style.color, style.backgroundColor, style.borderColor, style.fill, style.stroke].join(" ");
    if (/0,\s*1[0-9]{2},\s*2[0-9]{2}|23,\s*105,\s*255|0,\s*102,\s*255|rgb\(0,\s*126,\s*255/.test(colors)) return true;
    const text = lower(textOf(el));
    return /wang|tm|chat|message|旺旺|沟通|联系/.test(text);
  }

  async function waitForChatInput(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const input = findChatInput();
      if (input) return input;
      await sleep(300);
    }
    throw new Error("聊天输入框没有出现");
  }

  function findChatInput() {
    const inputs = Array.from(
      document.querySelectorAll("textarea,input[type='text'],[contenteditable='true'],div[role='textbox']")
    ).filter(visible);
    const ranked = inputs
      .map((el) => ({ el, score: scoreChatInput(el), rect: el.getBoundingClientRect() }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.rect.top - a.rect.top);
    return ranked[0]?.el || null;
  }

  function scoreChatInput(el) {
    const rect = el.getBoundingClientRect();
    const meta = lower(
      [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("title"), textOf(el)]
        .filter(Boolean)
        .join(" ")
    );
    if (/搜索|search|translate|翻译|筛选/.test(meta)) return -5;
    let score = 0;
    if (/请输入|输入正文|正文|message|type|reply|发送/.test(meta)) score += 8;
    if (rect.top > window.innerHeight * 0.45) score += 4;
    if (rect.width > 220 && rect.height > 36) score += 4;
    if (rect.left > window.innerWidth * 0.35) score += 2;
    if (el.isContentEditable) score += 2;
    return score;
  }

  async function fillAndMaybeSend(input, item, workflow) {
    const settings = workflow.settings || readSettings();
    if (settings.verifyRecipient && !verifyRecipientSoft(item.name)) {
      throw new Error(`收件人校验失败：${item.name}`);
    }
    await fillText(input, renderMessage(requireIntroText(settings), item));
    log(`已填入话术：${item.name}`);
    if (workflow.dryRun) {
      log("测试模式：不点击发送。");
      return;
    }
    await clickSendNearInput(input);
    log(`已发送文字：${item.name}`);
    await sleep(900);
    if (settings.sendMedia) await sendMediaFiles(item);
  }

  function verifyRecipientSoft(name) {
    const clean = lower(name);
    if (!clean) return true;
    const panels = Array.from(document.querySelectorAll("div,section,aside"))
      .filter(visible)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.35 && rect.width > 260 && rect.height > 120;
      })
      .map(textOf)
      .join(" ");
    return lower(panels || document.body.innerText).includes(clean);
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
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function clickSendNearInput(input) {
    const inputRect = input.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],span,div"))
      .filter(visible)
      .filter((el) => /^(发送|Send)$/i.test(norm(textOf(el))))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.left >= inputRect.left && rect.left <= inputRect.right + 60 && rect.top >= inputRect.top - 20 && rect.top <= inputRect.bottom + 45;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const button = candidates[0];
    if (!button) throw new Error("找不到输入框旁边的发送按钮");
    if (button.getAttribute("disabled") !== null || /disabled/.test(button.className || "")) {
      throw new Error("发送按钮仍是禁用状态");
    }
    button.click();
    await sleep(500);
  }

  async function persistSelectedFiles(files) {
    if (!files.length) {
      await storageRemove(MEDIA_KEY);
      await storageRemove(MEDIA_META_KEY);
      state.persistedFilesCount = 0;
      updateStats();
      return;
    }
    const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalSize > 25 * 1024 * 1024) {
      throw new Error("所选素材总大小超过 25MB。为防止网页崩溃，请压缩视频或减少文件。");
    }

    log("正在保存素材，页面跳转后仍可继续发送……");
    const storedFiles = [];
    for (const file of files) {
      storedFiles.push({
        name: file.name,
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified || Date.now(),
        size: file.size || 0,
        dataUrl: await fileToDataUrl(file),
      });
    }
    const media = { files: storedFiles, capturedAt: Date.now() };
    await storageSet(MEDIA_KEY, media);
    await storageSet(MEDIA_META_KEY, {
      count: storedFiles.length,
      totalSize,
      names: storedFiles.map((file) => file.name),
      types: storedFiles.map((file) => file.type),
      capturedAt: media.capturedAt,
    });
    state.persistedFilesCount = storedFiles.length;
    state.files = [];
    updateStats();
    log(`素材已就绪：${storedFiles.length} 个。`);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error(`读取素材失败：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function loadPersistedMediaFiles() {
    const media = await storageGet(MEDIA_KEY);
    const files = [];
    for (const stored of media?.files || []) {
      const comma = String(stored.dataUrl || "").indexOf(",");
      if (comma < 0) continue;
      const meta = stored.dataUrl.slice(0, comma);
      const payload = stored.dataUrl.slice(comma + 1);
      const bytes = /;base64/i.test(meta)
        ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload));
      files.push(
        new File([bytes], stored.name || "material", {
          type: stored.type || meta.match(/^data:([^;,]+)/i)?.[1] || "application/octet-stream",
          lastModified: stored.lastModified || Date.now(),
        })
      );
    }
    state.files = files;
    state.persistedFilesCount = files.length;
    updateStats();
    return files;
  }

  async function sendMediaFiles(item) {
    const files = state.files.length ? state.files : await loadPersistedMediaFiles();
    if (!files.length) {
      log("未选择图片/视频素材，跳过素材发送。");
      return;
    }
    const fileInput = await findOrOpenFileInput();
    if (!fileInput) throw new Error("找不到图片/视频上传入口");
    const dt = new DataTransfer();
    files.forEach((file) => dt.items.add(file));
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    log(`已上传素材：${item.name}`);
    await sleep(1800);
    const input = findChatInput();
    if (input) await clickSendNearInput(input).catch(() => {});
    log(`已尝试发送素材：${item.name}`);
  }

  async function findOrOpenFileInput() {
    let input = chooseFileInput();
    if (input) return input;
    const inputBox = findChatInput();
    const rect = inputBox?.getBoundingClientRect();
    const icons = Array.from(document.querySelectorAll("button,[role='button'],span,div,i,svg"))
      .filter(visible)
      .filter((el) => {
        const text = lower(textOf(el));
        if (/图片|视频|image|video|file|文件|附件/.test(text)) return true;
        if (!rect) return false;
        const r = el.getBoundingClientRect();
        return r.top >= rect.top - 64 && r.top <= rect.top && r.left >= rect.left && r.left <= rect.left + 220 && r.width <= 34 && r.height <= 34;
      });
    icons[0]?.click();
    await sleep(600);
    return chooseFileInput();
  }

  function chooseFileInput() {
    return Array.from(document.querySelectorAll("input[type='file']"))
      .filter((el) => !el.closest("#acda-panel"))
      .sort((a, b) => {
        const aText = lower([a.accept, a.name, a.id, a.className].join(" "));
        const bText = lower([b.accept, b.name, b.id, b.className].join(" "));
        const aScore = /image|video|file|upload/.test(aText) ? 1 : 0;
        const bScore = /image|video|file|upload/.test(bText) ? 1 : 0;
        return bScore - aScore;
      })[0];
  }

  function closeKnownDialogs() {
    const scopes = Array.from(
      document.querySelectorAll("[role='dialog'],.ant-modal,.next-dialog,[class*='Modal'],[class*='modal']")
    ).filter(visible);
    const buttons = scopes.flatMap((scope) =>
      Array.from(scope.querySelectorAll("button,[role='button'],span,div"))
    )
      .filter(visible)
      .filter((el) => /^(确定|知道了|确认|OK)$/i.test(norm(textOf(el))));
    buttons.slice(0, 2).forEach((button) => button.click());
  }

  async function randomDelay(settings = {}) {
    const min = Number(settings.minDelay || 1);
    const max = Math.max(min, Number(settings.maxDelay || min));
    const factor = settings.speed === "fast" ? 0.6 : settings.speed === "open" ? 0.3 : settings.speed === "normal" ? 0.85 : 1;
    const seconds = (min + Math.random() * (max - min)) * factor;
    await sleep(Math.max(250, seconds * 1000));
  }

  function readCurrentPageNumber() {
    const selectors = [
      "[aria-current='page']",
      ".next-pagination-item.current",
      ".next-pagination-item.next-current",
      ".ant-pagination-item-active",
      "[class*='pagination'] [class*='current']",
      "[class*='pagination'] [class*='active']",
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!rendered(el)) continue;
        const match = textOf(el).match(/^\s*(\d+)\s*$/);
        if (match) return Number(match[1]);
      }
    }

    const bottomText = Array.from(document.querySelectorAll("div,span"))
      .filter(visible)
      .filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.65)
      .map(ownTextOf)
      .find((text) => /\d+\s*\/\s*\d+/.test(text));
    const fraction = bottomText?.match(/(\d+)\s*\/\s*\d+/);
    return fraction ? Number(fraction[1]) : null;
  }

  function getPageFingerprint() {
    const page = readCurrentPageNumber() || "";
    const names = findVisibleCustomerRows()
      .slice(0, 5)
      .map((row) => lower(row.name))
      .join("|");
    return `${page}::${names}`;
  }

  async function waitForPageChange(beforeFingerprint, beforePageNumber, timeout = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      await sleep(250);
      detectBlockingState();
      const pageNumber = readCurrentPageNumber();
      if (beforePageNumber && pageNumber && pageNumber !== beforePageNumber) return true;
      const fingerprint = getPageFingerprint();
      if (fingerprint && beforeFingerprint && fingerprint !== beforeFingerprint) return true;
    }
    return false;
  }

  async function goToPageNumber(targetPage) {
    const target = Number(targetPage);
    if (!Number.isFinite(target) || target < 1) return false;
    const current = readCurrentPageNumber();
    if (current === target) return true;

    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    await sleep(450);
    const beforeFingerprint = getPageFingerprint();
    if (current && target === current + 1) {
      const moved = await clickNextPage();
      if (!moved) return false;
      return await waitForPageChange(beforeFingerprint, current);
    }
    const directCandidates = Array.from(document.querySelectorAll("button,a,li,span,[role='button']"))
      .filter(visible)
      .filter((el) => textOf(el) === String(target))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const context = lower(
          [el.className, el.parentElement?.className, el.parentElement?.parentElement?.className].join(" ")
        );
        return rect.top > window.innerHeight * 0.55 && rect.width <= 90 && /page|pagination|pager/.test(context);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      });
    if (directCandidates[0]) {
      directCandidates[0].click();
      return await waitForPageChange(beforeFingerprint, current);
    }

    const jumpInput = Array.from(document.querySelectorAll("input"))
      .filter(visible)
      .filter((el) => !el.closest("#acda-panel"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const context = norm(
          [el.parentElement?.innerText, el.parentElement?.parentElement?.innerText].filter(Boolean).join(" ")
        );
        return rect.top > window.innerHeight * 0.55 && rect.width <= 130 && /到第|跳转|页|go to/i.test(context);
      })
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
    if (!jumpInput) return false;

    await fillText(jumpInput, String(target));
    const scope = jumpInput.parentElement?.parentElement || jumpInput.parentElement || document.body;
    const confirmButton = Array.from(scope.querySelectorAll("button,a,span,[role='button']"))
      .filter(visible)
      .filter((el) => /^(确定|跳转|Go)$/i.test(norm(textOf(el))))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (confirmButton) {
      confirmButton.click();
    } else {
      jumpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      jumpInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    }
    return await waitForPageChange(beforeFingerprint, current);
  }

  async function clickNextPage() {
    const candidates = Array.from(
      document.querySelectorAll(
        ".next-pagination-next,.ant-pagination-next,[aria-label='下一页'],[aria-label='Next Page'],[title='下一页'],button,a,span,li,[role='button']"
      )
    )
      .filter(visible)
      .filter((el) => {
        const text = norm(ownTextOf(el));
        const aria = norm(el.getAttribute("aria-label") || el.getAttribute("title") || "");
        const className = lower(el.className);
        return /^(下一页|下页|Next|›|>)$/i.test(text) || /下一页|next/i.test(aria) || /pagination-next/.test(className);
      })
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.55;
      })
      .sort((a, b) => {
        const aClass = /pagination-next/.test(lower(a.className)) ? 1 : 0;
        const bClass = /pagination-next/.test(lower(b.className)) ? 1 : 0;
        if (aClass !== bClass) return bClass - aClass;
        return b.getBoundingClientRect().left - a.getBoundingClientRect().left;
      });
    const next = candidates[0];
    if (
      !next ||
      next.getAttribute("disabled") !== null ||
      next.getAttribute("aria-disabled") === "true" ||
      /disabled/.test(lower(next.className))
    ) {
      log("没有找到可用的下一页按钮。");
      return false;
    }
    next.click();
    return true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPanel);
  } else {
    buildPanel();
  }

  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "ACDA_SHOW_PANEL") {
      buildPanel();
      const panel = document.querySelector("#acda-panel");
      panel?.classList.remove("acda-collapsed");
    }
  });
})();

# 阿里国际站公海客户开发助手

一款运行在 Chrome / Edge 中的本地浏览器扩展，用于在阿里国际站公海客户可见页面中扫描客户、建立去重队列，并辅助打开旺旺、填写个性化介绍语以及发送图片或视频素材。

当前版本：`v1.2.0`

> 本工具只操作当前登录账号有权访问的可见页面，不读取隐藏接口，不绕过登录、验证码或安全验证。使用者应遵守阿里国际站规则以及客户所在地区的营销和隐私要求。

## 功能

- 按页数和客户数扫描公海列表
- 跨页去重并生成固定处理队列
- 当前页快捷流程：旺旺 → 填写/发送 → 关闭
- 发送前校验聊天收件人
- 测试 1 位客户时只填入、不发送
- 支持 `{name}` 客户名和 `{company}` 公司名变量
- 支持图片及视频素材
- 素材缓存复用和批量上传，降低连续使用时的卡顿
- 暂停后保留进度，可从当前客户继续
- 验证码、登录异常及风险提示交由人工处理

## 安装

1. 从 [Releases](../../releases) 下载最新 ZIP 并解压。
2. Chrome 打开 `chrome://extensions/`，Edge 打开 `edge://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择包含 `manifest.json` 的解压目录。
6. 刷新已打开的阿里国际站公海客户页面。

也可以直接加载仓库中的 `browser_extension` 目录进行开发测试。

## 推荐使用流程

1. 登录阿里国际站并打开公海客户列表。
2. 填写自己的公司介绍语，例如：

   ```text
   Hi {name},

   We noticed that {company} may be interested in our products.
   Here is one of our popular designs. Would you like to see our catalog and latest prices?
   ```

3. 如需图文触达，选择 1–2 张经过压缩的产品主图。
4. 设置扫描页数和客户数，首次建议 `1 页 / 5 位客户`。
5. 点击“扫描客户”。
6. 点击“测试1个（不发）”，核对客户、文字和素材。
7. 确认无误后再开始发送，建议每批 `10–20` 位客户。

## 数据与隐私

- 话术、队列、进度和临时素材保存在浏览器扩展本地存储中。
- 扩展不包含账号密码，也不会把使用日志上传到第三方服务器。
- 点击“清空队列”会清除当前队列和临时素材。
- 卸载扩展会删除该扩展在浏览器中的本地数据。

## 项目结构

```text
browser_extension/                 浏览器扩展主线版本
  content.js                       公海扫描、队列和控制面板
  chat_bridge.js                   旺旺聊天填写、发送和素材上传
  content.css                      控制面板样式
  manifest.json                    Chrome Manifest V3 配置
  tests/                           本地回归测试
alibaba_customer_dev_assistant/    早期 Windows 桌面自动化版本
```

## 本地测试

```text
node browser_extension/tests/smoke.test.cjs
node browser_extension/tests/lightweight_scan.test.cjs
node browser_extension/tests/chat_bridge.test.cjs
```

后两项测试需要本机安装 Chrome，并能够由 Playwright 启动。

## 使用限制

- 页面结构变化后，按钮识别规则可能需要更新。
- 不建议一次发送大量高清图片；优先使用 1–2 张压缩后的产品主图。
- 验证码、安全验证、登录异常和账号风险提示必须人工处理。
- 请控制联系频率，并尊重客户的拒收意愿。

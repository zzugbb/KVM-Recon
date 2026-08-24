# Capture Pack 与离场验收清单

## 1. 目标

Capture Pack 是 KVM-Recon 的核心导出物。它需要让工程师在离开机房后仍能回答：

- 目标 BMC 属于哪个 `kvmFamily` 候选？
- 登录链路、KVM 入口、HTTP API、WebSocket 链路是否被采集？
- 资料是否足够支撑下游 KVM 网关适配？
- 缺失资料有哪些，现场人员需要补做什么？

Capture Pack 必须可离线打开、可脱敏审查、可长期归档。出机房联网后，工程师或 AI 应能仅凭本包分析协议；KVM-Recon 本身不写 Adapter。

权威实现契约是 TypeScript 类型与导出代码（`src/core/capture-pack/`、`buildProbeArtifacts`、`buildBrowserArtifacts`、`buildNetworkArtifacts`）。独立 JSON Schema 见仓库 `schema/`。

当前已导出但易被忽略的文件：

- `probe/path-evidence.json`：各指纹路径是否可达。
- `page/screenshots.json`：包内截图相对路径索引。
- `page/screenshots/`：PNG 文件。
- 已知族还有 `artifacts/oem-profile.yaml`；未知族为 `artifacts/notes.md`。
- 每个包都有 `artifacts/handover.md`：说明出机房后如何把资料交给工程师或 AI。
- 登录后复验时还有 `probe/authenticated.json`：只含 cookie 名和带会话后的路径可达性，不含 Cookie 值。
- 现场填写的厂商/型号写入 `probe/operator-observed.json` 与 `manifest.job.observed`，只作铭牌证据，不替代 `kvmFamily`。

阶段 8 已落地的字段：时间线 click、storage key 增减、截图角色、WS `magic`、`not-h5`、TLS 的 Chromium 可达性。独立 JSON Schema 位于 `schema/`（manifest、checklist、HTTP 行、WS socket/frame、operator-observed）；其余文件以 TypeScript 类型与导出代码为权威。采集侧代码阶段已收口，见 `docs/development-plan.md` 第 22 节。

## 2. 目录结构

```text
capture-pack/
  manifest.json
  probe/
    bmc-basic.json
    family-signatures.json
    path-evidence.json
    redfish.json
    operator-observed.json
  http/
    requests.jsonl
    har.json
  ws/
    frames.jsonl
    sockets.json
  page/
    timeline.jsonl
    storage.json
    selectors.json
    screenshots.json
    screenshots/
  tls/
    certificate.json
  checklist.json
  report.md
  report.html
  artifacts/
    oem-profile.yaml
    notes.md
    handover.md
```

## 3. manifest.json

记录采集作业的摘要信息。

建议字段：

```json
{
  "schemaVersion": "1.0.0",
  "tool": {
    "name": "KVM-Recon",
    "version": "0.1.0"
  },
  "job": {
    "id": "2026-08-24T10-45-00Z-demo",
    "startedAt": "2026-08-24T10:45:00+08:00",
    "endedAt": "2026-08-24T10:58:00+08:00",
    "operatorNote": "现场采集备注",
    "observed": {
      "vendor": "AMI",
      "product": "MegaRAC SPX",
      "firmware": "1.0.0",
      "location": "A柜 U12"
    }
  },
  "target": {
    "host": "10.0.0.10",
    "port": 443,
    "scheme": "https"
  },
  "family": {
    "primary": "ami-megarac",
    "confidence": 0.86,
    "candidates": [
      {
        "kvmFamily": "ami-megarac",
        "confidence": 0.86,
        "evidence": ["/api/randomtag", "/api/session", "/api/kvm/token"]
      }
    ]
  },
  "readiness": {
    "status": "PARTIAL",
    "blockingCount": 0,
    "warningCount": 2
  },
  "redaction": {
    "status": "pass",
    "redactedFields": 36
  }
}
```

## 4. HTTP 资料

`http/requests.jsonl` 用于保存结构化请求列表。每行一个请求摘要。

建议字段：

```json
{
  "id": "http-000123",
  "timestamp": "2026-08-24T10:49:12.123+08:00",
  "method": "POST",
  "url": "https://10.0.0.10/api/session",
  "resourceType": "xhr",
  "status": 200,
  "requestHeaders": {
    "content-type": "application/json",
    "x-csrftoken": "<redacted:sha256:...>"
  },
  "responseHeaders": {
    "set-cookie": "QSESSIONID=<redacted:len:32>; Path=/"
  },
  "requestBodySummary": {
    "bytes": 128,
    "redactedFields": ["Password"],
    "jsonKeys": ["UserName", "Password"]
  },
  "responseBodySummary": {
    "bytes": 512,
    "redactedFields": ["CSRFToken"]
  },
  "tags": ["login"],
  "windowRole": "main"
}
```

HTTP 资料必须脱敏：

- 密码字段不落盘。
- Token、Cookie、CSRF、SessionId 只保留掩码、长度和 hash。
- Cookie / Set-Cookie **保留 cookie 名**，只脱敏值，便于离场后识别 `QSESSIONID` 等字段。
- JSON 体保留 `jsonKeys` 字段名，不保存明文敏感值。
- URL query 中的 token 等参数脱敏，路径保留。
- 响应体默认只保存摘要；必要正文需经过字段级脱敏。

## 5. WebSocket 资料

`ws/sockets.json` 记录每条 WebSocket 连接。

```json
{
  "id": "ws-0001",
  "url": "wss://10.0.0.10/kvm",
  "createdAt": "2026-08-24T10:50:03.000+08:00",
  "closedAt": "2026-08-24T10:50:25.000+08:00",
  "subProtocols": ["binary"],
  "requestHeaders": {
    "cookie": "QSESSIONID=<redacted:len:32>"
  },
  "binaryFrameCount": 128,
  "textFrameCount": 0,
  "tags": ["kvm-video"],
  "windowRole": "popup"
}
```

`ws/frames.jsonl` 只保存帧元数据和首包特征：

```json
{
  "socketId": "ws-0001",
  "timestamp": "2026-08-24T10:50:03.200+08:00",
  "direction": "down",
  "opcode": "binary",
  "bytes": 64,
  "headHex": "1700000000000000",
  "sampled": true
}
```

`magic` 为可选识别结果（例如可打印的握手字符串）。`closedAt` 在浏览器报告 WebSocket 关闭时填写；连接仍在时该字段可省略。
`windowRole` 为 `main`（首个采集窗口）或 `popup`（新窗口）。未区分时可省略。

限制：

- 不保存完整视频流。
- 默认只保存前 N 帧或每类关键帧的 head hex。
- 长时间持续图像帧只计数和采样。

## 6. 页面资料

页面资料用于还原现场操作路径。

`page/timeline.jsonl`：

- 页面加载。
- hash 路由变化。
- popup/new window。
- 截图时间点（包内相对路径）。
- 点击事件摘要（选择器或短文案，不含敏感值）。

`page/storage.json`：

- localStorage/sessionStorage key 列表。
- 不导出敏感值原文。
- 写入前后 key 增减（`localStorageAdded` / `Removed` 等）。

`page/selectors.json`：

- 登录按钮候选。
- KVM 菜单候选。
- HTML5 KVM 按钮候选。
- viewer 容器候选。

`page/screenshots.json`：

- 包内相对路径与角色，例如 `{ "path": "page/screenshots/viewer.png", "role": "viewer" }`。
- 角色：`login` / `home` / `kvm-entry` / `viewer` / `error` / `unknown`。
- 不得包含采集机绝对路径。

`page/screenshots/`：

- 现场按角色采集的 PNG。

## 7. TLS 资料

`tls/certificate.json`：

- 证书 subject / issuer。
- SAN。
- 有效期。
- 是否自签。
- TLS 协议版本。
- cipher。
- Node probe 是否可访问。
- 失败原因。
- Chromium 是否可访问（`chromium.reachable` / `chromium.authorizationError`）。

## 8. 离场验收清单

`checklist.json` 是导出前的核心判断依据。

状态：

- `pass`：已采集，满足适配分析。
- `fail`：明确失败。
- `unknown`：工具无法判断。
- `missing`：没有采集到。
- `not_applicable`：当前 BMC 不适用。
- `needs_user_action`：需要现场人员补操作。

影响级别：

- `blocking`：缺失后大概率无法离场适配。
- `warning`：能分析，但可能需要二次进场。
- `info`：辅助信息，不阻断。

示例：

```json
{
  "readiness": "PARTIAL",
  "items": [
    {
      "id": "ws.kvm.established",
      "title": "KVM WebSocket 已建立",
      "status": "pass",
      "severity": "blocking",
      "evidence": ["ws-0001"],
      "userAction": ""
    },
    {
      "id": "page.viewer.screenshot",
      "title": "viewer 页面截图已采集",
      "status": "missing",
      "severity": "warning",
      "evidence": [],
      "userAction": "请打开 HTML5 KVM 后把画面窗口留在前台，选择截图角色并点击“采集当前页面”。"
    }
  ]
}
```

## 9. 离场结论

导出报告必须给出明确结论：

- `YES`：资料足够，离开机房后大概率可以分析并适配。
- `PARTIAL`：能分析协议族，但缺少部分复验资料。
- `NO`：缺登录、KVM 入口或 WebSocket 等关键资料，建议不要离场。

`NO` 的典型阻断条件：

- BMC 首页无法访问。
- 未捕获登录链路。
- 未捕获 KVM 入口。
- 未捕获 KVM WebSocket。
- 脱敏检查未通过。

## 10. 现场补采提示

报告要给现场人员可执行的补采动作，避免只给技术错误。

示例：

```text
缺失：未捕获 KVM WebSocket。
影响：离开机房后无法判断播放面协议。
建议操作：
1. 点击“新建采集作业”，在采集窗口登录 BMC。
2. 点击“远程控制台 / HTML5 KVM”。若打开了新窗口，把新窗口留在前台至少 10 秒。
3. 主窗口「采集进度」中「KVM WebSocket」变为已采集。
4. 再点击“停止采集并导出”。
```

## 11. 导出安全要求

导出前必须通过脱敏检查：

- 明文密码不得进入导出包。
- Token/Cookie/CSRF 不得明文进入导出包。
- 完整 KVM 视频流不得进入导出包。
- 用户可查看脱敏摘要。
- 工具应默认导出安全包；调试级原始包不作为本阶段功能。

## 12. 本阶段契约范围

采集侧代码阶段已收口。本规范与 `schema/`、`examples/sample-capture-pack/` 对齐当前导出物。`probe/operator-observed.json` 仅在现场填写了铭牌或备注时出现。`probe/authenticated.json` 仅在做过登录后复验时出现。


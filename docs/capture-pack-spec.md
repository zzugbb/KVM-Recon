# Capture Pack 与离场验收清单

## 1. 目标

Capture Pack 是 KVM-Recon 的核心导出物。它需要让工程师在离开机房后仍能回答：

- 目标 BMC 属于哪个采集桶（`manifest.family.primary`）？真实协议是否与该桶同构？
- 登录链路、KVM 入口、HTTP API、WebSocket 链路是否被采集？
- 资料是否足够支撑下游 KVM 网关适配？未知族应新建 Adapter 还是误判进了已知三族？
- 缺失资料有哪些，现场人员需要补做什么？

Capture Pack 必须可离线打开、可脱敏审查、可长期归档。出机房联网后，工程师或 AI 应能仅凭本包分析协议；KVM-Recon 本身不写 Adapter。

权威实现契约是 TypeScript 类型与导出代码（`src/core/capture-pack/`、`buildProbeArtifacts`、`buildBrowserArtifacts`、`buildNetworkArtifacts`）。独立 JSON Schema 见仓库 `schema/`。

当前已导出但易被忽略的文件：

- `probe/path-evidence.json`：各指纹路径是否命中（HTML 200 不算）。
- `probe/path-details.json`：每个探测路径的状态码、内容类型、重定向和响应结构特征；401/403/405 只记录事实，不直接算命中。
- `probe/product-hints.json`：H3C HDM2、Dell iDRAC、HPE iLO、Huawei legacy、未知 HTML5 KVM 等产品迹象。
- `page/screenshots.json`：包内截图相对路径索引。
- `page/screenshots/`：PNG 文件。
- 已知族还有 `artifacts/oem-profile.yaml`；未知族为 `artifacts/notes.md`。
- 每个包都有根目录 `README.md`：给人与 AI 看的阅读地图和适配前裁定项。
- 登录后复验时还有 `probe/authenticated.json`：只含 cookie 名和带会话后的路径可达性，不含 Cookie 值。
- 现场填写的厂商/型号写入 `probe/operator-observed.json` 与 `manifest.job.observed`，只作铭牌证据，不替代采集桶。
- `http/adapter-evidence.json`：登录链路、KVM 启动链路、WebSocket 升级和 HTTP/WS 关联索引，供离场实现 Adapter 时快速复盘。
- `http/capture-status.json`：导出前网络空闲等待结果；超时会记录响应体任务数和仍在途的请求 ID，并把就绪结论降为 `PARTIAL`。

独立 JSON Schema 位于 `schema/`，覆盖 manifest、checklist、网络空闲状态、HTTP/WS 行、页面 timeline/storage/selectors/screenshots、TLS 与 probe 文件；与类型冲突时仍以 TypeScript 导出代码为准。采集侧代码已收口，见 `docs/development-plan.md` 当前状态。

## 2. 目录结构

```text
capture-pack/
  README.md
  manifest.json
  probe/
    bmc-basic.json
    family-signatures.json
    path-evidence.json
    path-details.json
    product-hints.json
    redfish.json
    operator-observed.json
  http/
    requests.jsonl
    har.json
    adapter-evidence.json
    capture-status.json
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
```

## 3. manifest.json

记录采集作业的摘要信息。

建议字段：

```json
{
  "schemaVersion": "1.0.0",
  "tool": {
    "name": "KVM-Recon",
    "version": "0.2.5"
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
    "productHints": [
      {
        "productFamily": "unknown-h5",
        "confidence": 0.8,
        "evidence": ["HTML5 KVM viewer traffic"]
      }
    ],
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

`family.primary` 是采集桶（含 `unknown-h5` / `not-h5`），不是网关 Adapter 主键。出机房后按 HTTP/WS 核对是否同构，裁定见 `docs/kvm-family.md`。每个包根目录 `README.md` 也有同样的「核对真实族再动手」一节。

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
    "jsonKeys": ["UserName", "Password"],
    "sample": {
      "UserName": "admin",
      "Password": "<redacted:sha256:...>"
    }
  },
  "responseBodySummary": {
    "bytes": 512,
    "redactedFields": ["CSRFToken"],
    "sample": {
      "CSRFToken": "<redacted:sha256:...>",
      "privilege": 4
    }
  },
  "responseContentType": "application/json",
  "redirectLocation": "",
  "responseStructure": {
    "bodyKind": "json-object",
    "jsonKeys": ["CSRFToken", "QSESSIONID", "privilege"],
    "jsonShape": {
      "CSRFToken": "string",
      "QSESSIONID": "string",
      "privilege": "number"
    },
    "jsonPaths": {
      "$.CSRFToken": "string",
      "$.privilege": "number"
    }
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
- JSON 与 `application/x-www-form-urlencoded` 体可保留经过字段级处理的 `sample`，用于还原嵌套结构、表单参数和非敏感参数关系；敏感值写入 hash/长度掩码。
- 短文本响应可保留有限长度 `sample`；HTML 页面和长视频/二进制流不落正文。
- URL query 中的 token 等参数脱敏，路径保留。
- 响应体默认只保存摘要；必要正文需经过字段级脱敏。

`http/adapter-evidence.json` 从上述请求与 WebSocket 摘要派生，按链路聚合：

- `loginChain`：登录、Session 创建、鉴权入口。
- `kvmLaunchChain`：KVM Token、SetKvmKey、StartH5Kvm、viewer/console/IRC/VNC 入口。
- `webSocketUpgrades`：KVM WebSocket URL、请求/响应子协议、101 状态、握手响应头名、首帧特征、窗口角色。
- `correlations`：每条 WebSocket 前最近的登录请求 id 与 KVM 启动请求 id，分成 `likelyLoginHttpIds` / `likelyKvmLaunchHttpIds`。

通用 `login/signin` URL 只有在请求为 POST、XHR 或 Fetch 时才进入 `loginChain`；GET `/login.html` 只保留为普通页面请求。Huawei legacy 的通用属性读写接口只有 Referer 来自 `remote/kvm_by_html5` 时才进入 `kvmLaunchChain`，避免把首页轮询误作 KVM Token 链路。

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
  "handshakeStatus": 101,
  "responseHeaders": {
    "sec-websocket-protocol": "binary"
  },
  "responseSubProtocol": "binary",
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

KVM WebSocket 识别不只看单一路径。已覆盖 AMI `/kvm`/`/kvm/video`、Dell `/vnc/vconsole`、Dell `:5900/`、Dell `:5900/vkvm/`、HPE `/wss/ircport`、Huawei legacy `:2198/` 等形态；子协议和二进制首帧（如 RFB、Dell APCP、Huawei FEF6、AMI IVTP）也会参与判断。通用 `/websocket` 上的纯文本首页心跳或告警帧不作为可靠 KVM 证据。

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
- 离场清单 `page.viewer.screenshot` **只认 `role=viewer`**；登录页、菜单页、异常页或未标明 role 的截图不能让该项通过。
- 自动 viewer 截图必须等正确 viewer target 收到可靠 KVM 证据后才生成，避免把 BMC 首页误当 KVM 画面。
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
      "title": "KVM WebSocket",
      "status": "pass",
      "severity": "blocking",
      "evidence": ["ws-0001"],
      "userAction": ""
    },
    {
      "id": "page.viewer.screenshot",
      "title": "KVM 画面截图",
      "status": "missing",
      "severity": "warning",
      "evidence": [],
      "userAction": "打开 HTML5 KVM 后会自动截图，无需再点「采集当前画面」。"
    }
  ]
}
```

## 9. 离场结论

导出报告必须给出明确结论：

- `YES`：资料足够，离开机房后大概率可以分析并适配。
- `PARTIAL`：能分析协议，但缺少部分复验资料。
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
- 工具应默认导出安全包；不提供未脱敏的调试级原始包。

## 12. 契约范围

采集侧代码已收口。本规范与 `schema/`、`examples/sample-capture-pack/` 对齐当前导出物。`probe/operator-observed.json` 仅在现场填写了铭牌或备注时出现。`probe/authenticated.json` 仅在做过登录后复验时出现。若改了导出结构，请同步更新样例目录（`writeSampleCapturePack`，见 `src/core/delivery/createSampleCapturePack.ts`）；`npm test` 不会改盘上样例。

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
    sources.json
    sources/
  ws/
    frames.jsonl
    sockets.json
  page/
    timeline.jsonl
    storage.json
    selectors.json
    screenshots.json
    screenshots/
    scripts.json   # 页面实际引用的 HTML/JS，仅在采集到 page-scripts 时出现
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
    "version": "0.2.7",
    "buildId": "3d7a6e2c4f10"
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
        "evidence": ["/api/randomtag", "http:/api/session", "http:/api/kvm/token"]
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
  "networkRequestId": "12345.67",
  "redirectHop": 0,
  "redirectedToId": "http-000123::redirect-1",
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
  "streaming": false,
  "responseBodyCaptured": true,
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
- 短文本响应可保留有限长度 `sample`。HTML 页面与 JavaScript 源码在 `http/requests.jsonl` 中保留脱敏后最长约 64 KiB 的正文样本；完整源码另存 `http/sources/<id>.js|html`（单文件最长约 2 MiB，最多 24 个、合计约 8 MiB）并由 `http/sources.json` 记录 URL、窗口、SHA-256、字节数、是否截断，以及 `referenced.required` 关键引用覆盖率。
- `data:` / `blob:` 不进入 HTTP 请求列表；图片、字体、媒体、样式、流式响应、二进制 MIME 与超过 1 MiB 的非源码响应不读取正文，并在 `responseBodySkippedReason` 记录原因。CDP `resourceType=Script` / `Document` 或 JavaScript/HTML MIME 的源码若解压后的 `dataLength` 或 `encodedDataLength` 已超过 2 MiB，则不调用 `Network.getResponseBody`，标记 `source-too-large-to-read`。总量超预算时标记 `source-budget-exceeded`。未知族要求可靠 Viewer 窗口内的第一方脚本完整；页面引用了 Viewer 主脚本却只采到 worker 时清单为 PARTIAL。YES 包校验只阻断 `referenced.required` 缺失。
- URL query 中的 token 等参数脱敏，路径保留。
- 响应体默认只保存摘要；必要正文需经过字段级脱敏。
- Chromium 重定向复用的 CDP `requestId` 会按 hop 拆成独立记录，并通过 `redirectedFromId` / `redirectedToId` 关联；每一跳保留方法、请求体、状态、Location 和响应头。
- `requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` 中补充的 Cookie、Set-Cookie 等原始头会合并到对应请求 hop；两类 ExtraInfo 都使用 `redirectHasExtraInfo` / `hasExtraInfo` 跳过没有附加事件的重定向 hop，避免后续请求头或响应头错位。响应 ExtraInfo 的状态码和同名原始头具有更高优先级，头名按大小写不敏感方式合并；请求 ExtraInfo 合并后重新计算链路标签。

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
  "sampledFrameCount": 64,
  "droppedFrameCount": 64,
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
`windowRole` 为 `main`（首个采集窗口）或 `popup`（新窗口），仅用于展示。内部关联与自动截图使用 `captureWindowId`（采集会话内每个 BrowserWindow 的稳定 ID）。弹窗子窗口额外记录 `openerCaptureWindowId`：主窗口请求 token、子窗口建立 WS 视为同一上下文；两个兄弟弹窗不关联。旧包没有窗口 ID 时，才退回比较 `windowRole`。

KVM WebSocket 识别不只看单一路径。已覆盖 AMI `/kvm`/`/kvm/video`、Dell `/vmc/vconsole` 与 `/vnc/vconsole`、Dell `:5900/`、Dell `:5900/vkvm/`、HPE `/wss/ircport`、Huawei legacy `:2198/` 等形态；子协议和二进制首帧（如 RFB、Dell APCP、Huawei FEF6、AMI IVTP）也会参与判断。华为 `:8208` 是虚拟媒体端口，不能作为 KVM 视频证据。通用 `/websocket` 上的纯文本首页心跳、告警帧、仅上行认证/控制包，或仅命中 AMI 弱首字节的普通二进制帧都不能单独作为可靠 KVM 证据。可靠判定至少要求采样记录中存在 `direction=down`。弱 AMI 帧必须具备可信 KVM URL/WebSocket 标签，或关联到同一 `captureWindowId` / 直接父子窗口（`openerCaptureWindowId`）、2 分钟内、状态成功且非静态资源的**明确** KVM 启动 HTTP 请求；`kvm.js`、`/api/console/status` 等宽泛 `kvm-entry` 不构成启动链。关键登录 POST 与 KVM token 响应正文缺失、加载失败或超限时清单为 PARTIAL，不能只靠 URL+200 判 YES。Viewer/登录相关 HTML、JavaScript 应保留脱敏样本（超大脚本保存截断前缀）；无样本时 `http.viewer_source` 为 PARTIAL，即使 WS 已通也不能保证离场后能写新 Adapter。

限制：

- 不保存完整视频流。
- 每条连接默认最多保存 64 条帧摘要，并额外保证首个上下行方向及新魔数能够留样。
- 长时间持续图像帧只累计 `binaryFrameCount` / `textFrameCount`，采样与丢弃数量分别写入 `sampledFrameCount` / `droppedFrameCount`。

## 6. 页面资料

页面资料用于还原现场操作路径。

`page/timeline.jsonl`：

- 页面加载。
- hash 路由变化。
- popup/new window。
- 截图时间点（包内相对路径）。
- 点击事件摘要（选择器或短文案，不含敏感值）。
- 每条事件的 `windowRole`（`main` / `popup`，仅展示）。
- 每条事件的 `captureWindowId`（采集会话内窗口 ID；与 HTTP/WS 使用同一值，用于同窗口关联）。

`page/storage.json`：

- localStorage/sessionStorage key 列表。
- 不导出敏感值原文。
- 写入前后 key 增减（`localStorageAdded` / `Removed` 等）。
- 保存该快照所属的 `windowRole`。
- 顶层 key 是全部快照的并集；`snapshots` 按 `captureWindowId`（无 ID 时 `windowRole`）+ `captureRole` 保留登录页、KVM 入口和 Viewer 的聚合结果。

`page/selectors.json`：

- 登录按钮候选。
- KVM 菜单候选。
- HTML5 KVM 按钮候选。
- viewer 容器候选。
- 每个候选保存来源 `windowRole`。
- 聚合所有页面采集事件，按窗口角色、页面角色、语义角色和 selector 去重，不再只保留最后一次快照。
- iframe 的 `src/name/id/class/title` 或同源子文档中的 KVM surface 可作为 Viewer 候选；OOPIF 内容无法由顶层 DOM 读取时，使用已关联 WebSocket 的窗口角色定位截图目标。

`page/screenshots.json`：

- 包内相对路径、语义角色与窗口角色，例如 `{ "path": "page/screenshots/viewer.png", "role": "viewer", "windowRole": "popup" }`。
- 角色：`login` / `home` / `kvm-entry` / `viewer` / `error` / `unknown`。
- 离场清单 `page.viewer.screenshot` **只认 `role=viewer`**；登录页、菜单页、异常页或未标明 role 的截图不能让该项通过。
- 自动 viewer 截图必须等正确 viewer target 收到可靠 KVM 证据后才生成，避免把 BMC 首页误当 KVM 画面。
- 操作员手动选择「KVM 画面」时可对当前窗口补拍新/未知协议，索引会记录 `operatorConfirmed: true`；该字段只证明操作员确认了画面，不会让 `ws.kvm.established` 自动通过。若未实际生成截图，IPC 返回失败，界面不得显示已采集。
- 同一次页面事实中的点击、storage、截图与 selector 必须绑定同一 `captureWindowId`，并导出一致的 `windowRole`。
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

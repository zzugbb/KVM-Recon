# Capture Pack 与离场验收清单

## 1. 目标

Capture Pack 是 KVM-Recon 的核心导出物。它需要让工程师在离开机房后仍能回答：

- 目标 BMC 属于哪个 `kvmFamily` 候选？
- 登录链路、KVM 入口、HTTP API、WebSocket 链路是否被采集？
- 资料是否足够支撑下游 KVM 网关适配？
- 缺失资料有哪些，现场人员需要补做什么？

Capture Pack 必须可离线打开、可脱敏审查、可长期归档。

权威实现契约是 TypeScript 类型与导出代码（`src/core/capture-pack/`、`buildProbeArtifacts`、`buildBrowserArtifacts`、`buildNetworkArtifacts`）。独立 JSON Schema 文件见开发计划阶段 8.5。

当前已导出但易被忽略的文件：

- `probe/path-evidence.json`：各指纹路径是否可达。
- `page/screenshots.json`：包内截图相对路径索引。
- `page/screenshots/`：PNG 文件。
- 已知族还有 `artifacts/oem-profile.yaml`；未知族为 `artifacts/notes.md`。

阶段 8 才要求补齐的字段：时间线 click、storage 写入前后变化、截图角色、WS `magic`、`not-h5`、TLS 的 Chromium/Node 分记。

## 2. 目录结构

```text
capture-pack/
  manifest.json
  probe/
    bmc-basic.json
    family-signatures.json
    path-evidence.json
    redfish.json
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
    "operatorNote": "现场采集备注"
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
    "contentType": "application/json",
    "bytes": 128,
    "redactedFields": ["Password"]
  },
  "responseBodySummary": {
    "contentType": "application/json",
    "bytes": 512,
    "redactedFields": ["CSRFToken"]
  },
  "tags": ["login", "ami-megarac"]
}
```

HTTP 资料必须脱敏：

- 密码字段不落盘。
- Token、Cookie、CSRF、SessionId 只保留掩码、长度和 hash。
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
  "tags": ["kvm-video", "ami-megarac"]
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

`magic` 为可选识别结果（例如可打印的握手字符串）。当前导出以 `headHex`、长度和方向为准；填写 `magic` 见开发计划阶段 8.3。

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
- 点击事件摘要（阶段 8.2）。

`page/storage.json`：

- localStorage/sessionStorage key 列表。
- 不导出敏感值原文。
- 写入前后变化（阶段 8.2）。

`page/selectors.json`：

- 登录按钮候选。
- KVM 菜单候选。
- HTML5 KVM 按钮候选。
- viewer 容器候选（阶段 8.4 补齐）。

`page/screenshots.json`：

- 包内相对路径列表，例如 `page/screenshots/live-1.png`。
- 不得包含采集机绝对路径。

`page/screenshots/`：

- 现场「采集当前页面」与导出时截图的 PNG。
- 角色分类（登录页、登录后首页、KVM 入口、viewer、异常画面）见阶段 8.2。

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
- Chromium 是否可访问（阶段 8.3；当前以采集窗口能否打开目标主机为准，未单独写入该文件）。

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
      "userAction": "请重新开始采集，打开 HTML5 KVM 后等待画面区域稳定 10 秒，再点击停止采集。"
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
1. 点击“重新采集”。
2. 在采集窗口登录 BMC。
3. 点击“远程控制台 / HTML5 KVM”。
4. 等待至少 10 秒，直到工具显示“WS 下行帧已捕获”。
5. 再点击“停止采集并导出”。
```

## 11. 导出安全要求

导出前必须通过脱敏检查：

- 明文密码不得进入导出包。
- Token/Cookie/CSRF 不得明文进入导出包。
- 完整 KVM 视频流不得进入导出包。
- 用户可查看脱敏摘要。
- 工具应默认导出安全包；调试级原始包不作为 MVP 功能。

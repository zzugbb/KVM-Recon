# Capture Pack JSON Schema

本目录是 Capture Pack 的独立 JSON Schema，方便出机房后用任意校验器核对 zip 内文件。

权威实现仍是 TypeScript 类型与导出代码（`src/core/capture-pack/`）。Schema 与类型冲突时，以导出代码和本仓库单测为准，再回改 Schema。运行时校验仍用轻量必填字段检查，不引入 ajv。

| 文件 | 对应包内路径 |
| --- | --- |
| `manifest.schema.json` | `manifest.json` |
| `checklist.schema.json` | `checklist.json` |
| `http-request.schema.json` | `http/requests.jsonl` 的每一行 |
| `ws-socket.schema.json` | `ws/sockets.json` 数组元素 |
| `ws-frame.schema.json` | `ws/frames.jsonl` 的每一行 |
| `page-timeline-event.schema.json` | `page/timeline.jsonl` 的每一行 |
| `page-storage.schema.json` | `page/storage.json` |
| `page-selectors.schema.json` | `page/selectors.json` |
| `page-screenshots.schema.json` | `page/screenshots.json` |
| `tls-certificate.schema.json` | `tls/certificate.json` |
| `probe-bmc-basic.schema.json` | `probe/bmc-basic.json` |
| `probe-path-evidence.schema.json` | `probe/path-evidence.json` |
| `probe-path-details.schema.json` | `probe/path-details.json` |
| `probe-product-hints.schema.json` | `probe/product-hints.json` |
| `probe-family-signatures.schema.json` | `probe/family-signatures.json` |
| `probe-redfish.schema.json` | `probe/redfish.json` |
| `operator-observed.schema.json` | `probe/operator-observed.json`（现场铭牌，可选） |
| `probe-authenticated.schema.json` | `probe/authenticated.json`（登录后复验，可选） |
| `http-adapter-evidence.schema.json` | `http/adapter-evidence.json` |

`http/har.json` 遵循 HAR 1.2，不另写一份项目内 Schema。`page/screenshots/` 下的 PNG 与 `artifacts/*` 不是 JSON。

不在本工具内做在线分析；这些文件只用于离线校验资料包形状。

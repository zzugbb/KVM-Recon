# Capture Pack JSON Schema

本目录是 Capture Pack 的独立 JSON Schema，方便出机房后用任意校验器核对 zip 内文件。

权威实现仍是 TypeScript 类型与导出代码（`src/core/capture-pack/`）。Schema 与类型冲突时，以导出代码和本仓库单测为准，再回改 Schema。

| 文件 | 对应包内路径 |
| --- | --- |
| `manifest.schema.json` | `manifest.json` |
| `checklist.schema.json` | `checklist.json` |
| `http-request.schema.json` | `http/requests.jsonl` 的每一行 |
| `ws-socket.schema.json` | `ws/sockets.json` 数组元素 |
| `ws-frame.schema.json` | `ws/frames.jsonl` 的每一行 |
| `operator-observed.schema.json` | `probe/operator-observed.json`（现场铭牌，可选） |

不在本工具内做在线分析；这些文件只用于离线校验资料包形状。

`page/timeline.jsonl`、`tls/certificate.json`、`probe/redfish.json` 等其余文件以 TypeScript 类型和导出代码为权威，本阶段不补全量 JSON Schema。采集侧代码阶段已收口，见 `docs/development-plan.md` 第 22 节。

# Capture Pack 2.0 JSON Schema

> **版本范围：Capture Pack 2.0 / KVM-Recon 0.3.0。** 0.3.0 阶段 0 起与
> `src/core/capture-pack-v2/types.ts` 逐字段同步（规范 §22：不再以「代码优先、
> Schema 滞后」为常态）。修改类型时必须同步修改本目录与测试。
>
> 当前仓库只维护 2.0 Schema；旧 1.x 格式可从已发布 Git 标签查阅。

本目录是 Capture Pack 2.0 的独立 JSON Schema（33 个），方便出机房后用任意校验器核对 zip 内文件。
权威规范是 `docs/v0.3-development-spec.md`；类型契约是 `src/core/capture-pack-v2/types.ts`。
Schema 与类型冲突时，以规范与类型为准，并立即回改本目录。`packV2Consistency.ts`
导出时会按包内 `schema/` 副本对全部结构化文件执行 Schema 自校验（规范 §14 条件 10），
因此 `ajv` 是运行时依赖。

字段关系约束（负向用例见 `capturePackV2Schema.test.ts`）：

- `manifest.schema.json`：`captureIntegrity=COMPLETE` 时 `workflowStatus` 必须为 `KVM_REACHED`。
- `integrity.schema.json`：`reasons` 必须是 11 个稳定原因代码之一（规范 §14）；
  `gates` 必须恰好覆盖十个唯一门禁；`COMPLETE` 时 `reasons` 为空且十项门禁全部通过；
  `INCOMPLETE` 时 `reasons` 至少一个。

| 文件 | 对应包内路径 |
| --- | --- |
| `manifest.schema.json` | `manifest.json` |
| `integrity.schema.json` | `integrity.json` |
| `ai-index.schema.json` | `ai/index.json` |
| `ai-adapter-dossier.schema.json` | `ai/adapter-dossier.json` |
| `ai-value-flow.schema.json` | `ai/value-flow.json` |
| `ai-missing-evidence.schema.json` | `ai/missing-evidence.json` |
| `catalog-resource.schema.json` | `catalog/resources.jsonl` 的每一行 |
| `targets.schema.json` | `catalog/targets.json` 与 `raw/browser/targets.json` |
| `catalog-channels.schema.json` | `catalog/channels.json` |
| `catalog-relation.schema.json` | `catalog/relations.jsonl` 的每一行 |
| `http-transaction.schema.json` | `raw/http/transactions.jsonl` 的每一行 |
| `cdp-event.schema.json` | `raw/cdp/events.jsonl` 的每一行 |
| `cdp-command.schema.json` | `raw/cdp/commands.jsonl` 的每一行 |
| `netlog.schema.json` | `raw/netlog/netlog.json` |
| `ws-metadata.schema.json` | `raw/websocket/<socket-id>/metadata.json` |
| `ws-frame-index.schema.json` | `raw/websocket/<socket-id>/frames.index.jsonl` 的每一行 |
| `realtime-webrtc.schema.json` | `raw/realtime/webrtc.jsonl` 的每一行 |
| `realtime-webtransport.schema.json` | `raw/realtime/webtransport.jsonl` 的每一行 |
| `realtime-sse.schema.json` | `raw/realtime/sse.jsonl` 的每一行 |
| `realtime-download.schema.json` | `raw/realtime/downloads.jsonl` 的每一行 |
| `runtime-crypto.schema.json` | `raw/runtime/crypto.jsonl` 的每一行 |
| `browser-timeline-event.schema.json` | `raw/browser/timeline.jsonl` 的每一行 |
| `browser-action.schema.json` | `raw/browser/actions.jsonl` 的每一行 |
| `browser-render-surface.schema.json` | `raw/browser/render-surfaces.jsonl` 的每一行 |
| `browser-storage.schema.json` | `raw/browser/storage.json` |
| `browser-frame-tree.schema.json` | `raw/browser/frame-tree.json` |
| `browser-console-entry.schema.json` | `raw/browser/console.jsonl` 的每一行 |
| `controller-diagnostic.schema.json` | `raw/controller/diagnostics.jsonl` 的每一行 |
| `scripts-index.schema.json` | `raw/scripts/index.json` |
| `replay-manifest.schema.json` | `replay/manifest.json` |
| `replay-request.schema.json` | `replay/http.jsonl` 的每一行 |
| `replay-channels.schema.json` | `replay/channels.json` |
| `probe-index.schema.json` | `raw/probe/index.json` |

以下文件不是 JSON，不设 Schema：`00_START_HERE.md`、`ai/summary.md`、`report.html`
（内容契约由 `packV2Layout.ts` 的 `checkStartHereContent` 校验）；`checksums.sha256`
（`<sha256>  <path>` 行，导出时计算）；`raw/http/bodies/*`、`raw/scripts/files/*`（按
SHA-256 寻址的正文 blob）；`raw/websocket/*/frames.bin`（二进制 payload，偏移由
frames.index.jsonl 描述）；`raw/browser/dom-snapshots/*`、`raw/browser/screenshots/*`；
`raw/http/session.har`（HAR 1.2 互操作副本，见 [HAR 1.2](http://www.softwareishard.com/blog/har-12-spec/)）。

阶段 0 说明（规范 §19）：

- 本目录 Schema 覆盖阶段 0 类型已固化的全部结构化文件；阶段 1-4 实现
  `JobWorkspace` / `BodyStore` / 采集器 / `EvidenceGraph` 时如需扩展行字段，
  必须同步更新本目录与 `types.ts`，再更新测试与样例包。
- `examples/capture-pack-v2/` 是与这些 Schema 保持同步的样例包。
- 旧 1.x 包不能按 2.0 Schema 验证，更不能据此宣称 2.0 的 COMPLETE。

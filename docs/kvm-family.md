# kvmFamily：采集桶与网关主键

> **版本范围：主要描述 0.2.x 的采集桶与现有网关命名。** “协议族与产品铭牌不能混用”“未知协议不要误改现有 Adapter”等原则继续有效；0.3.0 会把分类迁移为离线 Analyzer，采集完整度不再依赖本文件中的已知族规则，见 [`v0.3-development-spec.md`](v0.3-development-spec.md)。

本文给**出机房后写 KVM 网关的人**看。现场采集步骤仍看 `docs/offline-field-guide.md`。

KVM-Recon 会在 zip 名和 `manifest.family.primary` 里写一个标签。那只是采集器对**当前已实现的三套指纹**打分的结果，**不是**下游 Adapter 的主键。适配时以包内 HTTP / WebSocket 为准。

## 1. 两套名字，不要混用

| 出现位置 | 是什么 | 能否写进网关 registry |
| --- | --- | --- |
| zip 名、`manifest.family.primary` | 采集桶 | 仅当流量与该已知族**同构**时，才可沿用 |
| `manifest.family.productHints`、`probe/product-hints.json` | 产品提示 | 否。不是已确认 Adapter，也不进入 ZIP 文件名 |
| 网关 `kvmFamily` / Adapter 注册名 | 协议主键 | 必须是稳定、可检索的市面 BMC 产品名 |

采集器现在只会写出这五个顶层采集桶：

- `ami-megarac` / `openbmc-h5` / `huawei-ibmc`：命中已知指纹
- `unknown-h5`：捕获到有效 HTML5 KVM 流量，但对不上上面三族。Dell iDRAC、HPE iLO、H3C HDM2 在采到有效 H5 证据后通常落这里
- `not-h5`：完全没有有效 H5 证据才是这一桶

`unknown-h5` 和 `not-h5` **永远不要**写进网关配置。它们只表示「工具还不认识」，不是一种 BMC 产品。

现场填写的厂商/型号（浪潮、Dell、HPE）是铭牌，不能当 `kvmFamily`。同一品牌可以走出两族（例如浪潮既有 AMI MegaRAC，也有 OpenBMC H5）。已知 AMI / Huawei / OpenBMC 协议的贴牌设备仍归已有采集桶。AMI MegaRAC 的 HTML5 启动链有两条，都只从真实操作流量识别，不主动探测：`/api/kvm/token`，以及部分固件使用的 `/api/settings/media/h5viewercfg`（响应含 token/session 等启动参数，随后 `wss://BMC/kvm`）。`/api/session` 加上其中任一即可作为 AMI 流量证据。

zip 名就算写错，`http/`、`ws/`、`page/` 仍是浏览器真实流量，不会按错族去伪造接口。产品提示不参与当前 ZIP 文件名。

## 2. 产品提示（productHints）

下列名字目前只是产品提示，位于 `manifest.family.productHints` 和 `probe/product-hints.json`，**不会**写进 zip 文件名，也**不是**正式采集桶：

| 产品提示 | 含义 |
| --- | --- |
| `dell-idrac-h5` | Dell iDRAC HTML5 Virtual Console |
| `hpe-ilo-h5` | HPE iLO HTML5 Integrated Remote Console |
| `h3c-hdm2` | H3C HDM2 HTML5 迹象（只称产品提示，不是已确定的网关 Adapter 主键） |
| `huawei-ibmc-legacy` | 华为 iBMC 旧版 HTML5 迹象 |

`unknown-h5` 不是产品提示。采集桶是 `unknown-h5` 且没有上表证据时，`productHints` 为空。

新版代表机验证通过后，才考虑把 Dell / HPE / H3C 提升为正式采集桶。在此之前，有效 H5 流量的 zip 仍应是 `unknown-h5`。`h3c-hdm2` 不要提前写成已确定的网关 Adapter 主键。

## 3. 动手前怎么裁定

1. 打开 `http/requests.jsonl` 和 `ws/sockets.json`，还原登录 URL/字段、Cookie 名、KVM WS 路径与子协议、页面 hash。
2. 对照现网三族的契约，问是否**同构**（不是厂商是否同名，也不是 zip 是否写成那一族，也不是 productHints 叫什么）。
3. **同构**：复用现网 Adapter，差异放 OEM Profile 或该 Adapter 内的小分支。
4. **不同构，或采集桶是 `unknown-h5` / `not-h5`**：默认 **新建 Adapter**。先不要改现网 `ami-megarac` / `openbmc-h5` / `huawei-ibmc`，以免把已通机型打坏。
5. 给新 Adapter 起一个**网关主键**（下一节），登记新 key，再实现。等采集器以后能稳定识别，再把该名字加进指纹表。

## 4. 网关主键怎么起名

**新 Adapter**用 `{bmc-product}-h5`（kebab-case、小写 ASCII）。用市面上能搜到的 BMC / 控制台产品名，不用服务器品牌、不用采集桶、也不要把尚未验证的产品提示直接登记成主键。

已占用的三个保持历史拼写，**不要为了对齐格式去改网关已有 key**：

| 网关主键 | 市面产品 |
| --- | --- |
| `ami-megarac` | AMI MegaRAC HTML5 |
| `openbmc-h5` | OpenBMC webui-vue / H5Viewer |
| `huawei-ibmc` | 华为 iBMC HTML5 |

尚未被采集器识别、写新 Adapter 时建议直接用这些主键（确认流量属于该产品后再登记）。`h3c-hdm2` 不在此列，当前只是产品提示：

| 建议主键 | 市面产品 |
| --- | --- |
| `dell-idrac-h5` | Dell iDRAC HTML5 Virtual Console |
| `hpe-ilo-h5` | HPE iLO HTML5 Integrated Remote Console |
| `lenovo-xcc-h5` | Lenovo XClarity Controller HTML5 |
| `supermicro-html5` | Supermicro HTML5 / ATEN 控制台 |
| `cisco-imc-h5` | Cisco IMC HTML5 |
| `fujitsu-irmc-h5` | Fujitsu iRMC HTML5 |

`supermicro-html5` 不套 `-h5`，是因为市面常称 HTML5 KVM，而不是某一条 `*-h5` 产品线。

不要用：`dell`、`hp`、`inspur`、`unknown-h5`、`not-h5`、中文、空格。品牌太粗（iLO 与旧 Java 控制台不是一族）；采集桶不能当产品名。

表里没有的产品：仍按 `{bmc-product}-h5` 自拟，先查厂商对 HTML5 控制台的官方称呼，再落到 kebab-case。不要为了「先跑起来」去改现网三个 Adapter 的公共路径。

## 5. 和本工具的边界

- 本工具不写 Adapter，也不把 `unknown-h5` 自动改成 `dell-idrac-h5`。
- 已知三族的 zip 仍可能误判；以包内接口为准，必要时当新族处理。
- 未识别桶在清单里是「协议族指纹不适用」，不因此把完整采集打成 PARTIAL。YES 只表示资料够分析，不表示网关已有 Adapter。
- 新主键要进采集器指纹表，属于另一次改动，不在导出包里完成。代表机验证前，不要把 Dell / HPE / H3C 提升为正式采集桶。

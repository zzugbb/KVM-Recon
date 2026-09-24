# 参与贡献

感谢你关注 KVM-Recon。本仓库是**离线采集工具**，不是生产 KVM 网关。贡献前请先阅读 `README.md`（英文）或 `README.zh-CN.md`（中文），以及 `docs/development-plan.md` 的约束与当前状态。

## 环境

- Node.js 22 或更高（见 `.nvmrc`）
- npm（使用仓库内 `package-lock.json`，请跑 `npm ci`）

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm test` 含单测和离线采集/导出闭环。现场 HAR 回放使用 `KVM_RECON_FIELD_COLLECTION_2` 指向本机语料目录；未设置则跳过。`npm run test:e2e` 覆盖 Electron 启动、原生 popup、生产采集 Controller、主/弹窗、请求正文、脚本、窗口血缘和 ZIP 自校验，需要先 `npm run build`。

## 可以做的改动

- 采集正确性、Capture Pack 契约、文档、测试、CI/打包缺陷
- 真机验收中暴露的 bug 修复
- 开源治理文件与 GitHub Actions 维护

## 不要做的改动

以下内容属于项目边界外，PR 会被关闭：

- 自动登录 BMC
- MITM / 拆 TLS 中间人代理
- 机房内调用公网或 AI
- 根据 Capture Pack 自动写 Adapter
- 完整 KVM 视频解码或保存完整码流
- 在仓库中提交真实凭据、Cookie、未经审核的现场 Capture Pack 或 HAR
- 在采集器中加入厂商/协议族判定，或根据判定筛选证据

## Pull Request

1. 从 `main` 拉分支，保持改动聚焦。
2. 新增逻辑请补单测；错误处理需注释捕获场景、策略与影响。
3. 不要提交 `.env`、证书、私钥、未脱敏 Capture Pack、本机 `release/` 安装包。
4. 描述里说明：改了什么、为什么、如何验证（`npm test` / `npm run typecheck` / 是否跑过 `test:e2e`）。
5. 用户可见改动请写入 `CHANGELOG.md` 的 `[Unreleased]`。
6. 使用仓库里的 PR 模板。
7. 若改了 Capture Pack 2.0 导出结构，请同步 `schema/2.0/` 和 `examples/capture-pack-v2/`，并运行样例一致性测试。真实凭据必须进入导出包，但不得进入仓库样例。

## Dependabot

依赖与 GitHub Actions 的版本更新由 Dependabot 开 Pull Request，CI 通过后由维护者合并。

## 发布

按 `docs/releasing.md`：先把 `CHANGELOG.md` 的 `[Unreleased]` 收成新版本号并同步 `package.json` 的 `version`，再打 `v*` 标签。试构建可在 Actions 中运行 **Build installers**。

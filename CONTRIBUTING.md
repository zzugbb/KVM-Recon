# 参与贡献

感谢你关注 KVM-Recon。本仓库是**离线采集工具**，不是生产 KVM 网关。贡献前请先阅读 `README.md`（英文）或 `README.zh-CN.md`（中文），以及 `docs/development-plan.md` 第 2、22、23 节。

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

`npm test` 含单测和离线 HTTP 探测/导出闭环。`npm run test:e2e` 会启动 Electron 主窗口并在加载成功后退出，需要先 `npm run build`。

## 可以做的改动

- 采集正确性、脱敏、Capture Pack 契约、文档、测试、CI/打包缺陷
- 真机验收中暴露的 bug 修复
- 开源治理文件与 GitHub Actions 维护

## 不要做的改动

以下内容属于项目边界外，PR 会被关闭：

- 自动登录 BMC
- MITM / 拆 TLS 中间人代理
- 机房内调用公网或 AI
- 根据 Capture Pack 自动写 Adapter
- 完整 KVM 视频解码或保存完整码流
- 把明文密码、Cookie 值、storage 明文写入导出包

## Pull Request

1. 从 `main` 拉分支，保持改动聚焦。
2. 新增逻辑请补单测；错误处理需注释捕获场景、策略与影响。
3. 不要提交 `.env`、证书、私钥、未脱敏 Capture Pack、本机 `release/` 安装包。
4. 描述里说明：改了什么、为什么、如何验证（`npm test` / `npm run typecheck` / 是否跑过 `test:e2e`）。
5. 用户可见改动请写入 `CHANGELOG.md` 的 `[Unreleased]`。
6. 使用仓库里的 PR 模板。

## Dependabot

依赖与 GitHub Actions 的版本更新由 Dependabot 开 Pull Request，CI 通过后由维护者合并。

## 发布

按 `docs/releasing.md`：先把 `CHANGELOG.md` 的 `[Unreleased]` 收成新版本号并同步 `package.json` 的 `version`，再打 `v*` 标签。试构建可在 Actions 中运行 **Build installers**。

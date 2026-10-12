# KVM-Recon 展示站

独立静态站，介绍项目定位、能力、系统架构、内部工作流程及完整 / 缺口合成案例，提供证据与文件浏览。沿用客户端的深石墨与青绿色主题；无后端、运行时依赖、登录或追踪，不连接真实机器，也不接受地址、凭据或采集包上传。

## 运行与检查

需要 Node.js 22+，无需安装展示站依赖。在仓库根目录执行：

```bash
npm --prefix showcase run dev           # 根路径开发预览，端口 3100
npm --prefix showcase test
npm --prefix showcase run build
npm --prefix showcase run preview:pages # 构建产物预览，端口 3101 /KVM-Recon/
```

启动前核对端口。构建只将页面、样式、两个 JavaScript 模块与 `data/` 复制到 `showcase/out/`，不包含桌面源码、准备脚本或现场资料；构建产物不提交。

流程与案例进入可见区域后每步 2 秒循环播放；离开区域或切到后台暂停计时。点击步骤、切换案例或操作证据会暂停，按“自动播放”恢复。系统开启减少动态效果时默认不播放；现场配合说明默认展开。播放节奏不代表原始采集耗时。

页面或路径变更后，核对播放 / 暂停 / 恢复、两类案例、流程与证据步骤、文件切换、键盘和手机布局；检查根路径与 `/KVM-Recon/` 下的刷新、锚点、资源加载及控制台错误。

## 公开素材

`data/cases.json` 只读取已有公开合成输入：

- **完整案例**：来自 `examples/capture-pack-v2/`。固定 seed 随机 URL Mock 经 fetch / WebSocket 驱动；浏览器和运行时事实为确定性装配，不是完整 Electron 实采或真机验收。
- **缺口案例**：`fixture-worker-source-missing` 经项目 `derivePackIntegrity` 实际派生。其他门禁为 Fixture 预设通过，不声称执行了对应 ZIP 导出，也不伪造失败网络请求。

契约或样例变更后，在根项目依赖已安装的环境运行 `node showcase/scripts/prepare-data.mjs`，再执行上方测试与构建。准备脚本复用根开发依赖 esbuild；访客浏览器和 Pages CI 不执行该脚本、Collector 或完整度引擎。不得把现场目录或用户采集包作为公开素材输入。

## GitHub Pages

[发布工作流](../.github/workflows/showcase-pages.yml)在 main 上展示目录或工作流变化时检查、构建并发布，PR 仅检查，支持手动运行。首次将仓库 **Settings → Pages → Source** 设置为 **GitHub Actions**。站点地址为 [zzugbb.github.io/KVM-Recon](https://zzugbb.github.io/KVM-Recon/)，是否已上线以对应部署结果为准。

资源使用相对路径，案例数据相对模块 URL 加载；无需 SPA 路由回退、后端或额外 Secrets。仅上传 `showcase/out/`。修复或回滚 main 后重新发布，核对工作流、实际地址和线上交互；本地验证不替代线上检查。

项目使用与安全见[主 README](../README.md)，模块实现及验证范围见[项目状态](../docs/status.md)。展示站独立于桌面安装包，网站及纯文档更新无需修改应用版本或新增版本日志。

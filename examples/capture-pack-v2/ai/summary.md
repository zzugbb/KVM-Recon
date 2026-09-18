# AI 分析摘要（样例包）

目标：127.0.0.1:48080（设备说明：样例设备 / 未知厂商）

本包由完全未知协议的本地 Mock KVM 生成：所有 URL 均为随机值，不命中任何厂商签名。
classificationStatus=UNKNOWN 只表示当前没有已知协议候选，不影响资料完整性。

适配链：登录交互 → Session/Cookie 建立 → KVM 点击 → 启动请求 → Viewer 打开 → 脚本/Worker → 实时通道。

入口页：http://127.0.0.1:48080/4baa81443f20/58c19b1607.html
登录接口：http://127.0.0.1:48080/4baa81443f20/0f2b14d699
KVM 启动：http://127.0.0.1:48080/4baa81443f20/6bd45ecb6b
Viewer 页：http://127.0.0.1:48080/4baa81443f20/8109a05e47.html
实时通道：ws://127.0.0.1:48080/4baa81443f20/eed11298e3?t=76a0f653f5e653e37ab1c852ae71a9f8

每一步的证据 ID 与文件路径见 ai/adapter-dossier.json。

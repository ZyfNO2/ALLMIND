# GPT-Niang WPF 来源

来源：https://github.com/T7moris/GPT-Niang ，上游基础版本 f906d61bb3a19b6a7004507274fdd2165d3f14b6。
本目录包含 ALLMIND 增量修改：独立控制器管道、窗口可见性策略、原生宿主入口、通知与音乐挂起，以及 widget.ps1 的 ALLMIND 模式。
代码按随附 LICENSE（MIT）保留署名；角色图片适用 assets/CHARACTER-NOTICE.txt，语录适用 assets/quotes-LICENSE.txt。

运行时由 ALLMIND 控制器启动，不要求安装原 GPT-Niang，不启动 Codex 监控/额度轮询，不注册原项目 MCP、启动项或更新器。
`bin/ALLMIND.Widget.exe` 由 runtime/build-allmind-host.ps1 从源码构建，源码仓库不保存编译产物。

默认点击音效 assets/press.wav 与 assets/release.wav 保留上游原字节。固定提交中的 Git blob 分别为 181ed31a2713f050f1c6026d5ca7066bf0518b01、2073ff7f80dd1d1f85f73d9ca2ddd033d1a9ada2；SHA-256 分别为 10f802ff0f6d8327fee9c795d9f5672afe5bcc8660fc593a3e72ce99324f0053、f743d9b0b4e6d1576ca2329707788d0f35acb3763adb7c48c42f9b31e37c2064。上游 LICENSE 与素材声明随目录保留；此处不扩张其授权范围。

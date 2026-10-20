# GPT-Niang WPF 来源

来源：https://github.com/T7moris/GPT-Niang ，上游基础版本 f906d61bb3a19b6a7004507274fdd2165d3f14b6。
本目录包含 ALLMIND 增量修改：独立控制器管道、窗口可见性策略、原生宿主入口、通知与音乐挂起，以及 widget.ps1 的 ALLMIND 模式。
代码按随附 LICENSE（MIT）保留署名；角色图片适用 assets/CHARACTER-NOTICE.txt，语录适用 assets/quotes-LICENSE.txt。

运行时由 ALLMIND 控制器启动，不要求安装原 GPT-Niang，不启动 Codex 监控/额度轮询，不注册原项目 MCP、启动项或更新器。
`bin/ALLMIND.Widget.exe` 由 runtime/build-allmind-host.ps1 从源码构建，源码仓库不保存编译产物。

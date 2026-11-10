# AI / 自动化维护约定

## 项目范围

- 此仓库是 Windows 和 macOS 的唯一源码；不要再建立相互独立的“Windows 版/Mac 版”维护分支或目录副本。
- **默认每次功能更新同时检查并更新两个平台的面板、API、CLI、文档和测试。** 平台专属变更要说明原因，并验证另一个平台没有回归。
- 简单共享行为优先跨平台代码；原生启动、登录项、SSH 文件权限、进程归属核验等复杂行为保留独立模块，架构清晰和安全性高于勉强统一。

## 结构与变更

- Windows 后端：[Panel](<Panel/Server.ps1>)；macOS 后端：[portable 实现](<portable/TunnelStudio/server/app.mjs>)。
- 两平台共享 CLI：[客户端](<portable/TunnelStudio/bin/tunnel.mjs>)；Windows 无 Node 的原始 API 包装：[客户端](<Panel/ApiClient.ps1>)。
- 共享模块和样式以 [shared](<shared/sync.mjs>) 中的文件为权威来源，修改后执行 `node scripts/sync-shared.mjs --write`，再执行无参数检查。平台主 UI 保留单独实现；同步新的业务交互，不能把另一平台的能力限制硬编码覆盖过去。
- Windows 仅支持 PowerShell 7.x，入口统一使用 pwsh.exe；不维护 Windows PowerShell 5.x 兼容分支。源文件使用 UTF-8（现有 BOM 可保留），新增进程参数使用 ProcessStartInfo.ArgumentList，测试和 CI 同样使用 pwsh。
- API 保持相同端点、核心字段和 JSON 输入类型；系统状态不写入跨设备配置。修改后更新 [README](<README.md>) 并增加两侧契约测试。

## 自动化操作

- 优先使用 `node bin/tunnel.mjs` / Windows `bin\api.cmd`，不要使用浏览器自动点击添加配置。
- 所有默认测试必须用临时目录与演示模式；禁止测试过程中连接用户生产服务器、写 authorized_keys、启动真实隧道、读私钥内容或结束其他项目进程。
- 不能猜测用户的目标主机、密钥、指纹或业务密码；添加配置不等于获准授权 SSH。
- 真实部署/重启会影响用户会话时，先说明影响；源码测试通过不等于已更新本机打包应用。

## 安全与提交

- 不提交配置、运行记录、私钥、密码、token、同步文件、日志、截图、历史备份或生成应用；运行数据必须留在各自设备。
- 新公开示例使用 `192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24` 或 `example.com` 等文档地址，不能使用个人生产节点。
- 推送前检查 `git status`、`git diff --cached`，运行 `node scripts/audit-repository.mjs`。不使用 `git add -f` 绕过忽略规则。
- 不强制推送，不覆盖用户未提交修改；更新使用 `git pull --ff-only`。

更多说明见 [开发指南](<DEVELOPING.md>)。

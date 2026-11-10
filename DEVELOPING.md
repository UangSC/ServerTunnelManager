# 开发指南

## 整合来源与边界

1. macOS 分支贡献本机权限安全安装、独立 SSH 目录、HTTP/SOCKS5 业务健康探测、原生 `.app`/登录自启、停止时关闭自建子进程。
2. Windows 分支贡献 [非阻塞 HTTP 接收器](<Panel/Http.ps1>)、待打开操作防重复点击及卡片行高/响应式布局修正。
3. 合并后保留 macOS 更完整的状态过滤、详情实时曲线、实际转发目标显示、单向连接动画和 reduced-motion 支持，不回退为 Windows 旧界面行为。
4. 新增共同 CRUD 读取 API、[共享 CLI](<portable/TunnelStudio/bin/tunnel.mjs>)、[快捷图标 UI](<shared/application-shortcut-ui.js>)；原生快捷图标模块分别为 [Windows](<Panel/Shortcuts.ps1>) 和 [macOS](<portable/TunnelStudio/server/shortcuts.mjs>)。
5. 两份来源没有 Git 历史；当前仓库的初始提交只包含经过审查的源码，不导入历史备份/本地运行数据。

## 目录

```text
Panel/                         Windows PowerShell 服务 + 平台 UI
portable/TunnelStudio/server/  macOS Node 服务/SSH/探测/登录/快捷入口
portable/TunnelStudio/bin/     macOS 安装和进程管理 + 通用 Node API 客户端
portable/TunnelStudio/web/     macOS 平台 UI + 共享资源的分发副本
shared/                        共享同步模块、设置组件和样式的权威源码
bin/                           仓库入口：Windows .cmd/.ps1、macOS .sh、通用 .mjs
macos/                         原生启动器及不含用户数据的应用构建器
scripts/                       共享资源一致性和提交安全检查
examples/                      文档保留地址的示例，不含真实连接数据
tests/                         Windows 回归与共享同步测试
.github/workflows/             macOS / Windows CI
```

共享 UI 样式和同步模块采用“权威源码 + 分发副本”，这样安装后的 macOS 不依赖外部仓库，Windows 仍可直接从工作副本运行。

```sh
node scripts/sync-shared.mjs --write
node scripts/sync-shared.mjs
```

不要只改生成的副本。两份主 UI 脚本因现有密码向导、终端命令和进程生命周期差异暂时保留单独文件；新增通用功能应抽出共享组件，旧功能改动必须两侧检查，而非一次覆盖整个 UI。

## 测试要求

macOS / POSIX 的 Node 自动测试：

```sh
node --test portable/TunnelStudio/tests/*.test.mjs tests/sync.test.mjs
```

Windows 测试：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\http.tests.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\ports.tests.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\windows-integration.tests.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\windows-api.tests.ps1
```

测试使用独立临时目录、文档地址、模拟 SSH 或无网络 sentinel，不连接生产服务器。[Windows API 回归](<tests/windows-api.tests.ps1>) 必须针对临时实际 PowerShell 服务验证共享 Node CLI，防止两个后端的健康标识、响应结构或字段漂移。

Windows 原生 `.lnk` 在临时路径检查；macOS wrapper 创建/删除也只在临时应用目录验证。CI 中不启用登录自启，不创建真实用户开始菜单/桌面入口。

本机没有 Windows 时，不得把语法扫描宣称为 Windows 测试成功；查阅 [CI](<.github/workflows/ci.yml>) 或在 Windows 执行以上命令。完整 macOS 应用还需要实机验证签名、Finder 启动、登录项允许、Node 路径以及升级后数据保留。

## API 兼容

- 所有非 health API 用 `X-Panel-Token`；令牌每次启动更新，仅从本机 HTML 初始化。
- 原 Windows health 标识为 `tunnel-studio`，Node 为 `Tunnel Studio`；共享客户端兼容二者，不要未经迁移改变启动器依赖的标识。
- 系统集成状态 `autostart`/`applicationShortcut` 不放进配置设置或同步包。
- 新接口先增加两平台契约与错误场景测试，再更新 [README](<README.md>)。
- Mac 停止时关闭自建隧道，Windows 停止后保留已登记隧道，这是原生生命周期的明确差异，不强行抹平。

## 提交、发布和版本

版本保持 Node 后端、Node package、Windows Core 和 macOS 构建器一致。公开示例不得包含实际主机/账号、密码、token 或绝对个人路径。

```sh
git status --short
git add <explicit-source-paths>
git diff --cached --stat
node scripts/audit-repository.mjs
git diff --cached
git commit -m "Describe the cross-platform change"
git push origin main
```

审查脚本只检查 Git 索引中的文件内容，不读取未跟踪的用户秘密；检查路径、二进制/产物、凭据模式和非示例公网 IPv4。它不能代替人工审查，也不保证发现所有秘密。不要为了让扫描通过而绕过忽略或用高权限强制提交。

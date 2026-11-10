# macOS 使用与数据安全

macOS Apple Silicon / Intel 以 Node.js 22+ 和系统 OpenSSH 运行，不需要 PowerShell 或 npm 依赖。界面、CLI 与 API 用法见 [README](<README.md>)。

## 启动与更新

```sh
./bin/start.sh --open
./bin/status.sh
./bin/stop.sh
./bin/restart.sh --open
```

首次启动自动部署到 `~/Library/Application Support/TunnelStudio`；以后源码更新需执行：

```sh
git pull --ff-only origin main
./bin/macos.sh update
```

更新停止旧服务和它创建的隧道、复制代码后再启动，保留配置、密钥和同步设置。外部占用面板端口时拒绝接管/结束。浏览器关闭不影响后台服务。

**停止/重启 macOS 面板会关闭它创建的 SSH 隧道。** 启动后是否恢复，取决于全局 `autoOpenOnLaunch` 和每条映射 `autoOpen`，不能与“登录自启”混为一谈。

Finder 可双击 [Start.command](<Start.command>)、[Stop.command](<Stop.command>)、[Restart.command](<Restart.command>)。完整应用启动和打包见 [应用说明](<macos/README.md>)。

已有完整 `.app` 的源代码在包内；拉取仓库不会更新已打包的包内副本。发布新版本应构建到**新路径**后验证再切换，不能强制覆盖现有同名应用。源码部署后如继续打开旧完整应用，它可能部署旧包内代码，请选择一致的更新入口。

## 可选应用程序入口

安装完成后，网页“设置 → 启动与自动化 → 应用程序快捷图标”可创建/移除 `~/Applications/Tunnel Studio.app` 轻量 wrapper。它引用本机已安装程序，双击启动服务并打开浏览器；不包含配置、密钥或 Node 副本。

```sh
./bin/macos.sh install --application-shortcut
./bin/macos.sh install --no-application-shortcut
node bin/tunnel.mjs shortcut on
node bin/tunnel.mjs shortcut off
```

默认不创建。系统 Node 或保留完整应用中的 Node 必须可用；没有 Node 22+ 则明确失败。所有同名陌生应用、符号链接、额外 runtime 或被修改的 wrapper 都拒绝覆盖/删除。不会触碰 `/Applications/Tunnel Studio.app` 完整包，关闭快捷入口设置也不会停止服务或删除运行数据。

登录自启继续由完整原生 `.app` 的 SMAppService 支持，开启时可能需在系统设置允许。轻量 wrapper 不提供原生登录项。

## 源码、运行副本和密钥

- [portable 源码](<portable/TunnelStudio/package.json>) 在仓库中；运行副本在本机 Application Support。
- 本机副本的 `data/config.json` 为该设备配置；`data/ssh` 保存独立私钥/指纹，`data/logs` 为日志，`data/sync` 为同步设置和备份。
- 第一次迁移可读取当前源码的本地 Windows 面板配置，保留服务器/映射但改用本机私钥路径，清除免密与自动开启状态、强制演示模式。现有安装数据不被覆盖。
- ExFAT 无真实 POSIX 权限，不可作为运行密钥目录；安装器验证 0600 权限并拒绝不支持的磁盘。仓库可以留在外置磁盘，运行副本必须在本机安全磁盘。

如需复制当前用户已有 SSH 身份，必须显式执行：

```sh
./bin/macos.sh install --with-user-ssh
```

仅复制缺失的 `id_ed25519`、公钥和 `known_hosts`；不覆盖应用已有文件、不修改用户 SSH、不写服务器授权。身份属于私密本机数据，不得上传 Git。

真实 SSH 固定 `BatchMode=yes`、`StrictHostKeyChecking=yes`、独立 known_hosts 和私钥；没有可信指纹或身份会报错，不自动接受未知主机。私钥带口令时先加入 ssh-agent。向导只生成终端命令，密码/指纹确认在终端完成。

## 探测与恢复

- `http` 通过本机转发探测，保留 URL 路径，401/403/404/405 等响应说明可达而非认证成功，5xx 为远端异常。
- `socks5` 检查无认证方法协商；`tcp` 只查监听；`none` 不探测；`auto` 有 URL 时 HTTP，否则 TCP。
- SSH 在线与远端业务健康分别报告；真实吞吐未采集时显示“未采集”。箭头/光点仅表示映射方向和连接状态。
- 探测有并发限制/超时；重连退避最多 3 次，手动关闭会取消重试，认证/指纹错误不反复重连。
- 导入、重置和同步前创建本机备份，导入后恢复演示模式且关闭自动开启；不要把备份提交 Git。

```sh
node --test portable/TunnelStudio/tests/*.test.mjs tests/sync.test.mjs
```

自动测试使用临时目录，不连接生产主机。完整应用仍需 macOS 实机检查 Finder 启动、登录项和签名。


### 1.5 专用隧道升级

更新后支持与 Windows 相同的专用隧道、账号/出口备注和卡片／列表切换。先更新两台设备，再从已配置的设备发布同步；Mac 中通过设置里的同步预览应用配置，本机密钥路径和已有映射本机端口保留。仅拉取 Git 不包含账号的私人映射。新增映射不会自动开启；浏览器代理绑定需要在 Mac 本机配置，不同步 Windows 的浏览器目录。

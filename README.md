# Tunnel Studio / ServerTunnelManager

Windows / macOS 本地 SSH 端口转发控制台。支持网页、**JSON API** 和 **无浏览器 CLI**；AI 可以直接添加服务器、创建映射、调整设置、启动/关闭隧道，无需模拟点击。

- 默认地址：`http://127.0.0.1:9666/`，只监听回环地址，不要暴露到公网或局域网。
- 全新安装为空列表、默认**演示模式**，不连接任何预设服务器。
- Windows：PowerShell 7.x / OpenSSH；macOS：Node.js 22+ / 系统 OpenSSH。没有 npm 依赖。
- Windows/macOS 共用 CLI、同步模块、样式和新增设置组件；系统进程、密钥权限和应用集成分别实现，结构清晰优先，不强行统一复杂平台代码。

## 1. 获取与更新

本仓库是两平台的统一源码，不再维护两份独立项目：

```sh
git clone git@github.com:UangSC/ServerTunnelManager.git
cd ServerTunnelManager
```

后续在**每台设备的 Git 工作副本**中更新：

```sh
git status --short
git pull --ff-only origin main
```

有本地源码修改时先提交或备份，不能用强制覆盖来“更新”。私钥、配置、日志、备份和截图均不入库；`git pull` 不会把另一台机器的服务器配置或密钥拉过来。需要同步服务器/映射时使用配置导入或面板的跨设备配置同步，不能把运行数据提交到 Git。

旧 Windows 目录没有 Git 元数据时，建议新建一个干净的 clone，停止旧面板后，在新面板导入可信的旧配置。旧目录作为本地备份保留，不直接对整个目录执行 `git add .`。

### macOS 启动、部署更新

```sh
./bin/start.sh --open                 # 首次安装本机运行副本，然后启动/打开浏览器
./bin/status.sh
./bin/stop.sh
./bin/restart.sh --open
./bin/macos.sh update                 # git pull 后部署代码，保留已有 data
```

Finder 也可双击 [Start.command](<Start.command>)、[Stop.command](<Stop.command>)、[Restart.command](<Restart.command>)。

运行副本位于 `~/Library/Application Support/TunnelStudio`，数据在其 `data` 子目录；源码可以放外置硬盘，运行副本必须在支持 POSIX 权限的本机磁盘上。`update` 会停止旧面板及其创建的隧道、复制代码后启动；按自动开启设置恢复映射。安装/更新不会覆盖已有配置、密钥或同步设置。

已有完整 `.app` 可继续使用。完整应用内含 Node，但与源码部署是两种更新入口；**更新源码不会自动替换已打包应用内的代码**，请重建新应用或改用源码启动入口，避免旧 `.app` 再启动时部署旧代码。详情见 [macOS 指南](<MACOS.md>) 和 [应用打包说明](<macos/README.md>)。

### Windows 启动、部署更新

```powershell
.\bin\start.cmd
.\bin\stop.cmd
.\bin\restart.cmd
.\bin\start.cmd -NoBrowser
```

也可双击 [Start-Panel.cmd](<Start-Panel.cmd>) / [Stop-Panel.cmd](<Stop-Panel.cmd>)。后台服务与浏览器独立；关掉浏览器不会关闭服务。

Windows 使用当前 Git 工作副本中的脚本。更新后重启面板即可加载新代码。Windows 停止/重启面板**保留已登记的 SSH 隧道**，下次启动只在核实 PID、创建时间和完整转发规则后恢复管理；如需完全断开，先调用 CLI `batch close --all` 再停止面板。不会接管或结束其他项目/手动 SSH 进程。

## 2. 应用程序快捷图标

网页 **设置 → 启动与自动化 → 应用程序快捷图标**，与“登录自启”“自动开启隧道”是三个独立功能：

| 平台 | 开启后的入口 | 关闭设置的行为 |
| --- | --- | --- |
| macOS | `~/Applications/Tunnel Studio.app`，使用已安装的本机代码，双击启动面板并打开浏览器 | 只移除当前安装创建的轻量快捷入口，不停止服务，不删除数据，不碰 `/Applications` 中的完整应用 |
| Windows | 当前用户开始菜单和桌面的 **Tunnel Studio - Start / Stop** 图标 | 只移除属于当前项目的快捷方式，不改开机自启或数据 |

macOS 需先安装本机运行副本并有 Node.js 22+（系统 Node 或保留完整应用中的运行时）。Windows 快捷方式使用系统 PowerShell，无需 Node。已有陌生/其他安装的同名应用或链接时拒绝覆盖或删除。macOS 的完整 `.app` 不受这个开关控制，可按系统常规方法另行管理。

**CLI 配置（两平台，面板需已启动）：**

```sh
node bin/tunnel.mjs shortcut status
node bin/tunnel.mjs shortcut on
node bin/tunnel.mjs shortcut off
node bin/tunnel.mjs startup status
node bin/tunnel.mjs startup on
node bin/tunnel.mjs startup off
```

**离线安装入口：**

```sh
# macOS，首次安装时显式添加 / 后续显式移除；默认不自动创建
./bin/macos.sh install --application-shortcut
./bin/macos.sh install --no-application-shortcut
```

```powershell
# Windows，不需要运行面板，不需要 Node
.\bin\shortcuts.cmd -Action install
.\bin\shortcuts.cmd -Action status
.\bin\shortcuts.cmd -Action remove
```

macOS 登录自启需完整原生应用，可能需要系统设置中允许登录项；轻量快捷入口本身不是登录服务。

## 3. CLI：适合 AI 的首选入口

共享客户端位于 [CLI 实现](<portable/TunnelStudio/bin/tunnel.mjs>)，仓库入口为 [tunnel.mjs](<bin/tunnel.mjs>)。**Windows 和 macOS 使用相同命令**，需要 Node.js 22+，不需要 npm install；CLI 不打开浏览器，也不会自动输入 SSH 密码或授权未知主机。

```sh
node bin/tunnel.mjs --help
node bin/tunnel.mjs status
node bin/tunnel.mjs server list
node bin/tunnel.mjs tunnel list
node bin/tunnel.mjs settings get
```

面板不是默认端口时用 `--url http://127.0.0.1:PORT`，或环境变量 `TUNNEL_STUDIO_URL`。`--url` 放在命令前后都可以。CLI 只允许普通 HTTP 回环地址，禁止外部 URL、URL 凭据、路径和重定向。默认超时 10 秒，可 `--timeout 30000`（毫秒）。

### 从零添加服务器和映射

以下地址为文档保留地址，**必须换成自己的服务器**。端口映射新增后默认关闭：

```sh
node bin/tunnel.mjs server add --name demo --host 192.0.2.10 --port 22 --user alice
# 读取输出 JSON 中的 server.id，再填入下条命令：
node bin/tunnel.mjs tunnel add --name web --server-id srv-REPLACE --local-port 18080 --remote-host 127.0.0.1 --remote-port 8080 --probe http --open-url http://127.0.0.1:18080/ --group work --auto-open false
node bin/tunnel.mjs tunnel open t-REPLACE
node bin/tunnel.mjs tunnel close t-REPLACE
```

`server add` 的 SSH 端口、用户和密钥路径如未填写，会从当前面板默认设置取得。macOS 私钥限定在运行副本 `data/ssh` 内；Windows 支持本机 `~/.ssh/...` 或绝对路径。添加配置不会生成、复制或上传密钥。

### 编辑、查询、探测、删除

```sh
node bin/tunnel.mjs server get srv-REPLACE
node bin/tunnel.mjs server update srv-REPLACE --name renamed --note "managed by CLI"
node bin/tunnel.mjs server test srv-REPLACE
node bin/tunnel.mjs server command srv-REPLACE
node bin/tunnel.mjs tunnel get t-REPLACE
node bin/tunnel.mjs tunnel update t-REPLACE --local-port 18081 --auto-open true
node bin/tunnel.mjs tunnel port t-REPLACE
node bin/tunnel.mjs tunnel restart t-REPLACE
node bin/tunnel.mjs tunnel probe t-REPLACE
node bin/tunnel.mjs batch close --all
node bin/tunnel.mjs batch open t-FIRST t-SECOND
node bin/tunnel.mjs tunnel delete t-REPLACE --yes
node bin/tunnel.mjs server delete srv-REPLACE --yes
```

运行中的映射/关联服务器需要先关闭再编辑；仍有隧道引用的服务器不能删除。`server test` 仅测试 SSH 端口连通性，不证明免密成功；演示模式的结果是模拟的。`probe` 对已在线隧道进行 HTTP/SOCKS5/TCP 探测，401/403 可表示服务可达，不代表业务已认证。

### 设置、JSON 输入与整份配置

```sh
node bin/tunnel.mjs settings set --simulation true --theme dark --auto-reconnect true
node bin/tunnel.mjs settings set --auto-open-on-launch true
node bin/tunnel.mjs settings set --panel-port 9667
# 修改面板端口需要重启；重启前仍使用旧监听端口。
node bin/tunnel.mjs settings set --json '{"theme":"light","refreshMs":1500}'
node bin/tunnel.mjs server add --file examples/server.json
node bin/tunnel.mjs settings set --file -     # 从 stdin 读一个 JSON 对象
node bin/tunnel.mjs export --out local-backup.json
node bin/tunnel.mjs import --file local-backup.json --yes
node bin/tunnel.mjs reset --yes
```

使用 PowerShell 7.x；包含较复杂 JSON 时建议使用 `--file` 或 `--file -` 避免原生命令引号差异。`--json` / `--file` / 命名字段三种输入不可混用。命名字段使用 kebab-case：`--server-id` 对应 `serverId`；布尔值必须是 `true`/`false`，端口等数字必须是整数。

- 删除、批量删除、导入和重置要求显式 `--yes`；普通新增和编辑不需要交互确认。
- 输出是 stdout 上的 JSON，错误写 stderr，失败退出码为非零，批量部分失败也返回非零；`--help` 输出文本。
- 导出包含本机配置和路径信息，不含私钥内容；`--out` 使用独占创建，不覆盖已有文件。备份仍可能包含内部主机、用户、URL 等敏感信息，请勿提交 Git。
- 导入是**替换列表**，不是 upsert；会关闭本面板隧道并备份，强制演示模式、关闭自动开启、清除免密状态。先审查文件，再 `--yes`；完成本机 SSH 验证后才能启用真实模式。
- macOS 已安装副本也包含 CLI，可用其 Node 运行 `~/Library/Application Support/TunnelStudio/bin/tunnel.mjs`，不必连接源码硬盘。

### Windows 不安装 Node 的 API CLI

[api.cmd](<bin/api.cmd>) / [api.ps1](<bin/api.ps1>) 基于系统 PowerShell。自动检查当前工作副本的面板进程、获取内存令牌，输出 JSON：

```powershell
.\bin\api.cmd -Path /api/servers
.\bin\api.cmd -Path /api/tunnels
.\bin\api.cmd -Path /api/settings -Method POST -Body '{"simulation":true}'
Get-Content -Raw -Encoding UTF8 .\examples\server.json | .\bin\api.cmd -Path /api/servers -Method POST -BodyStdin
.\bin\api.cmd -Path /api/application-shortcut -Method POST -Body '{"enabled":true}'
.\bin\api.cmd -Path /api/tunnels/t-REPLACE/close -Method POST -Body '{}'
.\bin\api.cmd -Path /api/state -Port 9666
```

它是原始 API 包装器，不是共享资源 CLI 的参数别名；不会添加 `--yes` 保护，调用删除/覆盖接口时请先确认意图。推荐 `-BodyStdin` 传复杂 JSON，密码和令牌不要写命令行或日志。

## 4. JSON API

### 认证与安全约定

- 健康接口 `GET /api/health` 不需要令牌；其他 API 一律需要 `X-Panel-Token`。
- 每次面板启动生成随机会话令牌，在本机首页 HTML 的 `<meta name="panel-token" content="…">` 注入。CLI 从健康接口确认面板后通过普通 HTTP 读取，不需要浏览器、DOM 或持久 token 文件。
- 不支持 `Authorization: Bearer`、URL 查询令牌或跨站 CORS。Token **值**区分大小写；重启后失效，重新初始化客户端。
- `POST/PATCH/PUT/DELETE` 的输入为 `Content-Type: application/json` 的 JSON 对象；成功一般返回 HTTP 200 + JSON，验证错误为非 2xx。批量操作还需逐项检查 `results[].ok`。
- API 拥有本机面板用户权限，不是多用户网络服务；回环鉴权不防御同用户恶意程序。不要反向代理到外网。

直接在 Node 中复用客户端（无浏览器）：

```js
import { Client } from './portable/TunnelStudio/bin/tunnel.mjs';
const panel = new Client('http://127.0.0.1:9666');
const { server } = await panel.request('POST', '/api/servers', {
  name: 'demo', host: '192.0.2.10', port: 22, user: 'alice',
  keyPath: process.platform === 'win32' ? '~/.ssh/id_ed25519' : 'data/ssh/id_ed25519'
});
const result = await panel.request('POST', '/api/tunnels', {
  name: 'web', serverId: server.id, localHost: '127.0.0.1', localPort: 18080,
  remoteHost: '127.0.0.1', remotePort: 8080, probe: 'http', autoOpen: false
});
console.log(JSON.stringify(result));
```

也可使用原始调用：

```sh
node bin/tunnel.mjs api GET /api/servers
node bin/tunnel.mjs api POST /api/settings --json '{"simulation":true}'
node bin/tunnel.mjs api POST /api/batch --json '{"action":"close","ids":["t-REPLACE"]}'
```

### 端点速查

| 方法 | 路径 | 输入 / 返回 |
| --- | --- | --- |
| GET | `/api/health` | 无令牌；运行版本、PID、实际端口 |
| GET | `/api/bootstrap` | 完整 UI 初始化数据；原始响应含 token，CLI 会去除 token |
| GET | `/api/state` | `runtime`、服务器状态、指标、活动、启动/快捷入口状态 |
| GET | `/api/servers` / `/api/servers/{id}` | `{ok,servers}` / `{ok,server}` |
| POST | `/api/servers` | 新增，返回 `{ok,server}` |
| PATCH / PUT | `/api/servers/{id}` | 部分更新，返回 `{ok,server}` |
| DELETE | `/api/servers/{id}` | 删除未被隧道引用的服务器 |
| POST | `/api/servers/{id}/test` / `/command` | 连通性测试 / 生成终端免密命令，不自动执行命令 |
| GET | `/api/tunnels` / `/api/tunnels/{id}` | `{ok,tunnels}` / `{ok,tunnel}` |
| POST | `/api/tunnels` | 新增，返回 `{ok,tunnel}` |
| PATCH / PUT | `/api/tunnels/{id}` | 更新映射，运行中需要先关闭 |
| DELETE | `/api/tunnels/{id}` | 关闭并删除隧道 |
| POST | `/api/tunnels/{id}/open` / `/close` / `/restart` / `/probe` | 操作或健康探测；开始连接不等于已就绪，应轮询 state |
| GET | `/api/tunnels/{id}/port` | 端口诊断，不自动结束外部进程 |
| POST | `/api/batch` | `{action:"open\|close\|restart\|delete",ids:[...]}`，逐项 `results` |
| POST | `/api/tunnels/order` | `{ids:[...]}` 排序 |
| GET / POST | `/api/settings` | 获取 / 部分更新设置 |
| POST | `/api/startup` | `{enabled:true/false}`，返回 `autostart`；状态从 settings/bootstrap 读取 |
| GET / POST | `/api/application-shortcut` | 读取 / `{enabled:true/false}`，返回 `applicationShortcut` |
| GET | `/api/export` | 导出配置，包含本机路径，不含私钥内容 |
| POST | `/api/import` | 整份配置或 `{config:...}`，停止、备份后替换，恢复安全默认 |
| POST | `/api/reset` | 清空列表，危险操作 |
| GET | `/api/logs?since=0&source=panel&limit=300` | 日志 `lines`、`lastId` |
| POST | `/api/logs/clear` / `/api/activity/clear` | 清空内存缓冲，不删除历史日志 |
| POST | `/api/passwordless/command` | `{host,port,user,keyPath}`，返回 `command` |
| POST | `/api/shutdown` | 停止面板；隧道生命周期见平台说明 |

**服务器字段：** `name`、`host`、`port`（SSH 端口）、`user`、`keyPath`、`note`、`color`（violet/ocean/emerald/amber/rose）。

**隧道字段：** `name`、`serverId`、`localHost`（只允许 `127.0.0.1`）、`localPort`、`remoteHost`、`remotePort`、`probe`（auto/http/tcp/socks5/none）、`openUrl`（HTTP(S)）、`group`、`note`、`autoOpen`。

**设置字段：** `theme`、`accent`、`simulation`、`refreshMs`、`latencyProbe`、`autoReconnect`、`confirmDelete`、`autoOpenOnLaunch`、`panelPort`、`defaultUser`、`defaultPort`、`defaultKeyPath`、`connectTimeout`、`serverAliveInterval`、`serverAliveCountMax`、`strictHostKeyChecking`、`openBrowserOnStart`、`logRetention`。macOS 固定启用主机指纹校验；完整应用双击总会打开浏览器。Windows 为兼容旧配置保留部分值转换行为，自动化应传正确的 JSON 类型，保存后读取校验结果。

### 跨设备配置同步 API

同步需自行配置可信 SSH 目标，不预设个人服务器；这是**配置同步**，与 Git 源码更新不是同一功能。

- `GET/POST /api/sync/settings`：`{host,port,user,remoteDir,keyPath,knownHostsPath}`。
- `POST /api/sync/pull-preview`：`{includeLogs:false}`，返回一次性预览 `token`。
- `POST /api/sync/pull-apply`：`{token:"preview-token",confirm:true}`。
- `POST /api/sync/publish-preview`：`{includeLogs:false}`。
- `POST /api/sync/publish-apply`：`{token:"preview-token",confirm:true}`。

两个 token 用途不同：HTTP header 是当前面板会话 token；JSON body 是这一次同步预览 token。预览后本机配置/目标变更、过期或使用过的预览必须重做。默认白名单只同步服务器与映射，不上传私钥、认证状态、本机主题或登录设置；日志必须逐次显式选择。CLI `api` 子命令可以调用以上全部端点。

## 5. SSH 与平台边界

- 初次使用先配置本机密钥并确认服务器指纹，然后关闭演示模式。面板不会替你信任未知主机。
- macOS 向导只生成手动 shell 步骤，密码在终端输入；Windows 保留现有免密向导，密码仅在进程内存中，不写配置/日志。AI 可直接 `server command` 获取步骤，但不得绕过人工指纹核验。
- macOS 使用独立 `data/ssh/known_hosts`，私钥权限必须为当前用户独享；有口令的私钥需先加入 ssh-agent。可显式 `./bin/macos.sh install --with-user-ssh` 复制缺失的现有 SSH 文件，不覆盖已有文件、不修改用户 SSH、不写远端授权。
- 真实模式只管理本项目的 TCP `ssh -L`；不是内置代理服务。业务页面可打开不等于业务 API 已认证。
- 本机端口冲突不会触发杀进程。诊断后改端口或在原项目停止占用者。
- 未采集真实吞吐时 macOS 明确显示“未采集”，不会把动画当作实际流量。
- 旧 [菜单入口](<ServerTunnelManager.ps1>) 保留兼容，真实开启必须显式 `-Destination alice@example.com` 或 `TUNNEL_STUDIO_DESTINATION`；它使用独立运行记录，**不建议与新面板混用**。无服务器目标的旧映射文件不会被猜测绑定到某个生产主机。

## 6. 开发、测试与发布安全

未来功能默认要同时更新 Windows/macOS 面板与 CLI/API 契约。详细维护约定见 [AGENTS.md](<AGENTS.md>) 和 [DEVELOPING.md](<DEVELOPING.md>)。优先共享简单兼容代码；复杂原生行为保留清晰独立模块，不能因为追求跨平台而降低安全性。

```sh
node scripts/sync-shared.mjs --write       # 改 shared 后同步两侧资源
node scripts/sync-shared.mjs               # 检查两侧一致
node --test portable/TunnelStudio/tests/*.test.mjs tests/sync.test.mjs
node scripts/audit-repository.mjs          # 审查 Git 暂存文件，不读未跟踪本机秘密
```

Windows 回归通过系统 PowerShell 执行，**不要传 LiveSsh**：

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tests\http.tests.ps1
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tests\ports.tests.ps1
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tests\windows-integration.tests.ps1
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tests\windows-api.tests.ps1
```

[CI](<.github/workflows/ci.yml>) 会运行 macOS 测试、共享资源一致性检查及真实 Windows PowerShell 回归。本次 Mac 本机测试不连接生产服务器；本机没有 Windows PowerShell，Windows 执行结果以 CI/Windows 机器为准，不能把静态检查当作实机通过。

[忽略规则](<.gitignore>) 排除本地 JSON 配置、旧映射、运行记录、密钥、同步数据、日志、历史备份、截图、临时测试目录、打包产物和系统元数据。公开示例仅使用 RFC 文档保留地址。提交前审查 `git diff --cached`，**不能仅凭 .gitignore 认为源码或文档没有秘密**。

---

Tunnel Studio 1.4.0 · 一个仓库、两平台、可自动化的本地控制台。


## 专用隧道与总览布局（1.5）

总览的普通隧道下方新增“专用隧道”区域，左侧工作台也有独立入口。两类映射共用已有 SSH 生命周期、端口冲突检查、日志、编辑和自动重连。卡片／列表切换按“发牌”顺序依次入场：先记录每个条目切换前的位置，重建 DOM 后只播放 `transform` 与 `opacity`，条目从原位置滑入新布局并逐条错开，条目越多间隔越短，整体控制在半秒左右；容器本身只做 5px 的收尾位移。动画全部交给合成层，不触发布局重排，也不会在状态轮询时重复触发；系统开启“减少动态效果”时直接跳过。三个区域分别记住当前设备的布局选择。

新建或编辑映射时选择“专用隧道”，填写绑定账号、ISP 标识、预期出口 IP 和服务器路由备注。代理的远端目标通常是 SSH 服务器的回环地址与专用 HTTP 代理端口。本机只做 SSH 转发；ISP 用户名密码仍由服务器管理。操作菜单中的“复制代理地址”复制 `http://127.0.0.1:<本机端口>`，浏览器或应用需要单独使用这个代理。此功能不修改系统代理和浏览器配置，也不在本机保存 ISP 认证。

预期出口和路由为配置备注，不会改变服务器路由；TCP 探测成功仅代表监听可达，不代表已经验证实际出口 IP。

共享 CLI 示例（文档地址）：

```sh
node bin/tunnel.mjs tunnel add --name "Account proxy" --server-id srv-ID --local-port 18001 --remote-host 127.0.0.1 --remote-port 18001 --probe tcp --kind dedicated --proxy-account example --isp-id ISP-01 --proxy-exit-ip 203.0.113.10 --proxy-route direct
```

两端 API 的新增字段为 `kind`（`standard` / `dedicated`）、`proxyAccount`、`ispId`、`proxyExitIp`、`proxyRoute`（`unknown` / `direct` / `vpn`）。创建、部分更新、导入导出和同步均保留这些字段。旧配置缺少类型时视为普通隧道。Windows 无 Node 的 `bin/api.cmd` 仍可通过 JSON 请求体使用相同 API。

跨设备同步包含类型、账号、预期出口、路由备注及转发映射；已有映射保留各设备自己的监听端口、私钥路径及自动开启偏好，新映射默认不自动开启。布局偏好、浏览器目录和 ISP 密码不进入同步包。**两端均应更新到 1.5 或更高版本再发布同步**，旧版客户端不认识新增字段，可能在重新发布时丢失它们。代码更新不会自动从另一台设备复制私人配置：先在配置完整的设备发布同步，再在另一端预览并应用。


Windows 1.5 起要求 PowerShell 7.x（`pwsh.exe` 在 PATH 中）。直接运行旧的 Windows PowerShell 会被脚本版本要求拒绝。已有同项目快捷图标可在设置中重新启用以升级目标程序；系统自启包装和 `.cmd` 入口也使用 7.x。根目录的兼容入口继续保留，内部实现按平台和共享模块分目录维护。


### 紧凑列表

总览及专用隧道的列表采用统一的五列布局：名称/账号、本机入口、远端信息、状态、操作。列宽由同一组 CSS 轨道决定，行高固定 62px，长文字单行省略、悬停可看完整内容；状态只改变左侧色条，不会改变尺寸。

行内不再堆叠功能按钮：开关和“更多”固定在最后一列右端，所以任何一行都不会因为可用功能不同而高低错位。打开面板、连接信息、复制地址、端口诊断、重启隧道、编辑配置、查看日志和删除都收进同一个操作菜单，菜单按隧道当前状态列出可用项；点整行仍然打开详情抽屉。菜单支持 Esc 关闭与方向键移动焦点，点击外部或滚动时自动收起。卡片布局同样只保留“主操作 + 更多”，底部操作条高度固定，主操作右对齐。

窄屏可横向滚动查看完整列表，卡片布局保持原样。布局切换按钮为分段控件，动画只改 `transform`/`opacity` 并遵循系统减少动态效果偏好；列表的连接信息支持没有网页入口的代理隧道。

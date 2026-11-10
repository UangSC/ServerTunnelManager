# Tunnel Studio.app

macOS 的应用格式是 `.app`，不是 Android 的 APK。本项目使用一个无窗口的原生 Objective-C 启动器，继续使用原来的浏览器界面。

## 使用

在 Finder 的「应用程序」中双击 **Tunnel Studio**：

1. 首次运行或升级时，将程序文件安装到 `~/Library/Application Support/TunnelStudio`，保留配置、密钥和日志。
2. 启动面板；已运行则复用现有实例。
3. 自动在默认浏览器打开本机面板。

应用内置官方 Node.js 24 LTS，不依赖 Homebrew、shell PATH 或外置硬盘。
正常启动没有原生窗口、菜单栏图标或终端窗口。启动失败会打开 `data/logs/launcher.log` 供排查。
应用包不包含用户配置、SSH 私钥、日志或服务器地址；运行数据独立保存。

## 登录自启

网页的「设置 → 启动与自动化 → 开机自启」可以随时开启或关闭。
仅在当前 macOS 用户登录后生效，不在登录前运行，也不会在登录时弹出浏览器。
双击应用始终打开浏览器。

使用 macOS 13+ 的 SMAppService 原生登录项，辅助程序包含在应用包中，启用时注册，关闭时注销。
无需写入 `~/Library/LaunchAgents`，即使该目录由管理员拥有也可使用。系统要求允许时，页面会明确提示前往「系统设置 → 通用 → 登录项」。
没有强制保活，所以从页面停止面板后不会被立即拉起。
关闭自启不会停止已经运行的面板和隧道。
如希望登录后连隧道也启动，还需开启设置中的「启动时自动开启已标记的隧道」，并勾选对应映射的自动开启。

移动 `.app` 后重新双击一次，会更新应用路径，并修复先前已启用的登录启动项。
删除应用前建议先关闭登录自启、停止面板；保留的 Application Support 数据可用于重新安装恢复。

## 从源码构建

需要 macOS 和 Xcode Command Line Tools：

```sh
python3 macos/build-app.py --output "$HOME/Applications/Tunnel Studio.app"
```

输出路径必须不存在。脚本按当前 Mac 的 arm64 / x64 架构下载固定版本的官方 Node.js，
校验固定 SHA-256、编译原生启动器、打包仅程序文件并检查签名。
下载缓存位于 `~/Library/Caches/TunnelStudio-build`。
构建的应用对应当前机器架构，不是 Universal 包。

应用采用本地 ad-hoc 签名；已在当前 Mac 验证。若要向其他用户公开分发并免除系统来源提示，
需要开发者使用自己的 Apple Developer ID 签名和公证。这里没有使用开发者证书，也没有修改系统 Gatekeeper 设置。

程序升级会停止旧面板及其创建的隧道，保留数据后启动新版本；相同版本重复双击不会重启面板。
自启是否恢复隧道取决于用户的自动开启配置。

自动测试：`node --test portable/TunnelStudio/tests/*.test.mjs tests/sync.test.mjs`。
打包后还应测试空 PATH 启动、重复启动、浏览器打开、原生登录项启用/关闭、
模拟登录启动和现有配置/SSH 文件保持不变。

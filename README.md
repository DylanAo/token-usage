# Token Usage — Claude + Codex 用量统计

[English](README.en.md) | 中文

## 写在前头
本项目由开源项目 [codex-usage](https://github.com/DhWU-coder/codex-usage)改造而来。原作者的版权与 MIT 许可声明已保留在本仓库的 `LICENSE` 中。

本项目由中国科大「词元计划」提供算力支持，采用deepseek-v4-flash 正式版、deepseek-v4,1-flash、deepseek-v4-pro 预览版模型和deepseek-v4-pro 正式版模型，基于Vibe Coding开发。总计消耗约3亿token。

本项目在一条仪表盘同时统计 **Claude Code** 与 **Codex** 的 token 用量。

## 快速开始

本项目由纯Node写的，没有第三方依赖。**只需要提前装好 Node.js（≥ 22.13）**。

### 方式一：双击启动（推荐）

双击项目根目录的 **`setup.bat`**。它会：
1. 自动检查 Node.js 是否安装；
2. 后台无窗启动本地服务，并打开浏览器进入仪表盘 `http://127.0.0.1:3765`。

想要停止时，在终端执行：

```bash
token-usage stop
```

### 方式二：命令行

```bash
# 启动网页仪表盘
npm run serve
# 或在终端打印文字汇总（含按来源 Claude / Codex 分开的用量）
npm run summary
```

然后打开 `http://127.0.0.1:3765` 查看仪表盘。

## 数据来源与索引目录

- **Claude Code**：读取 `~/.claude/projects/*.jsonl` 会话文件。
- **Codex**：读取 `~/.codex/sessions` 与 `~/.codex/archived_sessions` 下的会话文件。
- 合并后的用量索引（SQLite）写入 **`~/.token-usage/usage-index.sqlite`**，服务状态记录于 `~/.token-usage/services.json`。

## 环境要求

- Node.js **>= 22.13**（用到了内置 SQLite）

```bash
node --version
```

## 多电脑 AI 仪表盘

当前版本可以把多台电脑上的 Claude Code 和 Codex 用量汇总到一台树莓派。树莓派运行汇总服务，各台电脑运行轻量级 `agent`。采集器只发送会话标题、项目、模型、token 用量、活动状态和心跳，不会默认上传完整对话或源代码。

### 在树莓派上启动汇总服务

先在树莓派生成一个足够长的随机令牌，然后启动监听局域网的服务：

```bash
export TOKEN_USAGE_REMOTE_TOKEN='替换成随机令牌'
export TOKEN_USAGE_REMOTE_RETENTION_DAYS='90'
node src/cli.js run --host 0.0.0.0 --port 3765
```

也可以把令牌直接作为参数传给 `run` 或 `gateway`：

```bash
node src/cli.js gateway --host 0.0.0.0 --remote-token '替换成随机令牌'
```

打开树莓派的 `http://树莓派地址:3765`，仪表盘中的“电脑状态”和“当前任务”会显示已连接的采集器。

仪表盘在宽屏下将“电脑状态”“当前任务”“模型分布”放在同一行，下方为窄版时间分布和宽版对话消耗。对话按最后活动时间倒序排列，最近使用的会话显示在最上方；小屏幕会自动调整布局。

### 树莓派常驻运行与防休眠

仪表盘地址为 `http://树莓派地址:3765`，项目目录可选择 `~/token-usage`。建议使用部署用户的 systemd 用户服务 `token-usage-gateway.service` 管理汇总服务，并启用服务自启和 linger，使其退出 SSH 后仍会运行，开机时也会启动。以下状态检查适用于已经配置好该用户服务的部署。

通过 SSH 登录部署用户后，可查看服务状态及日志：

```bash
systemctl --user status token-usage-gateway.service
journalctl --user -u token-usage-gateway.service -n 50 --no-pager
loginctl show-user "$USER" -p Linger
```

在使用 systemd 的树莓派上，可执行以下命令配置防休眠策略（需要 sudo 权限）：

```bash
sudo install -d -m 0755 /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/99-token-usage-no-sleep.conf >/dev/null <<'EOF'
[Login]
IdleAction=ignore
HandleLidSwitch=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
EOF
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl restart systemd-logind
```

这会禁止通过 systemd 进入睡眠、挂起、休眠和混合睡眠，并让 logind 忽略空闲、合盖和休眠按键动作。配置持久保存在 `/etc/systemd/`，重启后继续有效，无需为本次配置重启树莓派。重启 logind 会影响登录会话管理，建议通过 SSH 操作。

验证配置：

```bash
systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager IdleAction
curl -I http://127.0.0.1:3765/
```

前一条命令应输出四行 `masked`（对 masked 单元返回非零退出码是正常现象）；空闲策略应输出 `s "ignore"`，网页应返回 HTTP 200。屏幕自动熄灭与系统休眠不同，这些设置用于保持主机和汇总服务在线，不会关闭桌面的屏幕节能功能。

如需撤销本项目添加的防休眠设置：

```bash
sudo rm /etc/systemd/logind.conf.d/99-token-usage-no-sleep.conf
sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl restart systemd-logind
```

仅当这些目标是由本节命令屏蔽时才执行上述 `unmask`；它会移除对应目标的系统级屏蔽。令牌保存在部署用户的 `~/.token-usage/` 中，不应写入 README 或提交到仓库。

### 在每台电脑上启动采集器

每台电脑都需要 Node.js ≥ 22.13，并使用同一个树莓派地址和令牌。`--machine-id` 应当在不同电脑之间保持唯一：

```bash
node src/cli.js agent \
  --server http://树莓派地址:3765 \
  --token '替换成随机令牌' \
  --machine-id computer-1 \
  --label '电脑 1'
```

采集器默认每 15 秒发送一次心跳和新增事件。也可以通过环境变量配置：

```bash
export TOKEN_USAGE_SERVER='http://树莓派地址:3765'
export TOKEN_USAGE_TOKEN='替换成随机令牌'
export TOKEN_USAGE_MACHINE_ID='computer-1'
export TOKEN_USAGE_MACHINE_LABEL='电脑 1'
node src/cli.js agent
```

当前任务状态依据会话文件活动时间推断：最近有活动时为“进行中”，短时间没有活动时为“等待中”，机器超过三分钟没有心跳时显示为离线。这个状态用于仪表盘提示，不等同于 provider 的官方任务状态。

远程事件与本机事件共用 SQLite 索引，因此原有按日期、电脑、项目、模型和 provider 的统计会自动包含远程电脑。默认自动清理 90 天以前的远程事件；可以通过 `TOKEN_USAGE_REMOTE_RETENTION_DAYS` 调整，设置为 `0` 可以关闭自动清理。原始会话文件仍然保留在各台电脑上。

## 上传源码前的隐私检查

仅上传项目源码与文档。不要将 `~/.token-usage/`、`.claude/`、`.codex/`、环境配置、认证令牌、SQLite 数据库、会话 JSONL 或日志复制进仓库。`.gitignore` 已包含常见运行数据和凭据文件的忽略规则；它不会移除已经被 Git 跟踪或写入历史提交的文件，手动压缩上传时也不会生效。

`npm run export` 生成的静态 HTML 会嵌入真实统计数据，可能包含会话标题、项目和本机路径。默认输出的 `dist/` 已被忽略；自定义导出位置、截图和手工保存的 API 响应需要另行检查。

远程令牌目前只保护采集器上报接口，仪表盘及统计读取接口没有登录鉴权。应将服务限制在可信网络内；公开源码不需要公开运行中的仪表盘或数据。

## License

本项目沿用 **MIT License**，见 [LICENSE](LICENSE)。

感谢原项目 [codex-usage](https://github.com/DhWU-coder/codex-usage)（MIT）——本项目基于其代码改造而来，遵循 MIT 协议要求保留了原版权声明。# token-usage
# token-usage

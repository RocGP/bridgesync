# BridgeSync

换电脑时一键迁移 **Claude Code、VS Code、Antigravity IDE、Antigravity / Gemini CLI** 的配置与会话历史。本地 Web 工具：打包成单个 zip，在新机器上**非破坏式**还原。

## 功能

- **五个迁移域**
  - Claude Code CLI / 扩展：`~/.claude`（会话历史、记忆、设置）+ `~/.claude.json`（含 MCP 配置）+ Claude 桌面端配置
  - VS Code：`settings.json` / 快捷键 / 代码片段 + 扩展清单（还原时自动重装）
  - Antigravity IDE（VSCode 分支）：编辑器配置 + 扩展（覆盖两套 User 目录与扩展目录）
  - Antigravity / Gemini CLI：`~/.gemini`（对话历史、Agent 记忆、OAuth 配置；自动排除浏览器录制等数 GB 垃圾）
  - SSH 密钥（`~/.ssh`）、全局 `.gitconfig`
- **非破坏式还原**：还原前先把目标机现有配置快照到 `backups/pre-restore-*`；JSON 配置深度合并、**目标机现有值优先**；普通文件存在即跳过，绝不覆盖。
- **路径自动改写**：项目工作区可重映射，Claude 会话内的 `cwd` 与项目 key 按新路径改写；未跟踪的项目按 `旧 home → 新 home` 兜底改写。
- **去噪**：备份自动排除 `node_modules`、`.git`、`.codegraph`、浏览器录制、缓存等。
- 实时日志（SSE）、体积统计、可视化面板。

## 使用

```bash
npm install
node server.js          # 或 start.bat (Windows) / start.sh
# 打开 http://127.0.0.1:3000
```

- **备份**页：勾选组件 → 可加项目工作区 → 生成 zip（保存在 `backups/`）。
- **还原**页：拖入 zip → 填路径映射 → 开始还原。还原后看 home 目录的 `BridgeSync-MIGRATION-NOTES.txt` 做收尾。

## ⚠️ 安全须知

- 勾选「凭证」或「SSH 密钥」后，生成的 zip **含明文密钥**。`.claude.json` 内的 MCP token 也会一并打包。
- **请把备份 zip 当机密文件**，迁移完成后删除。
- 本仓库的 `.gitignore` 已排除 `backups/` 和所有 `*.zip`，避免误传密钥。
- 服务仅监听 `127.0.0.1`，不对外暴露。

## 工具链不随备份迁移的部分

新机器需手动准备（还原后 `MIGRATION-NOTES.txt` 也会列出）：

- Node.js、VS Code 的 `code` 命令、Antigravity 的 `antigravity` 命令、`gh`
- `rtk`（独立二进制，自行拷贝 + 加入 PATH）
- `codegraph`：`npm install -g @colbymchenry/codegraph`，每个项目跑 `codegraph init -i` 重建索引（`.codegraph` 不入备份）
- 未迁移登录态的需重新登录

## 许可

ISC

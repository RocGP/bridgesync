# BridgeSync

换电脑时一键迁移各类 **AI 编码工具**的配置、会话历史与密钥。本地 Web 工具：自动检测本机已装的工具 → 打包成单个 zip → 在新机器上**非破坏式**还原。

## 特点

- **自动检测、按需呈现**：扫描本机实际安装的工具，只显示检测到的，没装的不出现。换任何用户、任何系统（Windows / macOS / Linux）都能自动定位"该用户自己"的目录——**不写死任何路径**。
- **声明式工具注册表**（[`tools.js`](tools.js)）：加一个工具 = 加一条数据，无需改逻辑。欢迎 PR 扩充（见下方贡献指南）。
- **非破坏式还原**：还原前先把目标机现有配置快照到 `backups/pre-restore-*`；JSON 配置深度合并、**目标机现有值优先**；普通文件存在即跳过，绝不覆盖。
- **路径自动改写**：项目工作区可重映射，Claude 会话内的 `cwd` 与项目 key 按新路径改写；未跟踪项目按 `旧 home → 新 home` 兜底改写。

## 支持的工具

| 类别 | 工具 |
|---|---|
| **编辑器**（设置+扩展） | VS Code、Cursor、Windsurf、Antigravity IDE、VSCodium |
| **扩展型 Agent**（数据在编辑器 globalStorage） | Cline、Roo Code、Kilo Code、Cody |
| **CLI Agent** | Claude Code、Antigravity / Gemini CLI、OpenAI Codex CLI、Continue、Aider、Qwen Code |
| **独立编辑器** | Zed |
| **密钥 / 配置** | SSH 密钥、全局 .gitconfig |

> 检测按"路径是否存在"过滤，因此注册表可登记多个候选路径，写多了无害。

## 使用

```bash
npm install
node server.js          # 或 start.bat (Windows) / start.sh
# 打开 http://127.0.0.1:3000
```

- **备份**页：勾选检测到的工具 → 可加项目工作区 → 生成 zip（存在 `backups/`）。
- **还原**页：拖入 zip → 填工作区路径映射 → 开始还原。完成后看 home 目录的 `BridgeSync-MIGRATION-NOTES.txt` 做收尾。

## ⚠️ 安全须知

- 含 🔒 的工具（SSH、含凭证的目录）默认不勾选。勾选「包含私密文件」或带 🔒 的工具后，zip 内含**明文密钥/令牌**。
- **请把备份 zip 当机密文件**，迁移完成后删除。
- `.gitignore` 已排除 `backups/` 和所有 `*.zip`，避免误传密钥。
- 服务仅监听 `127.0.0.1`，不对外暴露。

## 不随备份迁移的部分

新机需手动准备（`MIGRATION-NOTES.txt` 也会列出）：Node.js、各编辑器 CLI（`code`/`cursor`/`windsurf`/`antigravity`…）、`gh`、`rtk`（拷贝二进制+加 PATH）、`codegraph`（`npm i -g @colbymchenry/codegraph` + 每项目 `codegraph init -i`）、以及未迁移登录态的重新登录。

## 贡献：新增一个工具

只改 [`tools.js`](tools.js) 里的 `TOOLS` 数组，加一条记录即可，`detect`/`backup`/`restore` 会自动处理。完整字段与条目 kind 说明见该文件顶部注释。

**VSCode 系编辑器**——用 `editorTool` 工厂：
```js
editorTool({
  id: 'cursor', name: 'Cursor', cli: 'cursor',
  userPaths: (c) => path.join(c.cfgRoot, 'Cursor', 'User'),
  extDirs:  (c) => path.join(c.home, '.cursor', 'extensions')
})
```

**扩展型 Agent**（数据在宿主编辑器 globalStorage）——用 `extAgentTool`：
```js
extAgentTool({ id: 'cline', name: 'Cline', extId: 'saoudrizwan.claude-dev', excludes: ['cache'] })
```

**CLI / 独立工具**——直接写 items：
```js
{ id: 'codex-cli', name: 'OpenAI Codex CLI', category: 'cli', secret: true,
  items: [{ kind: 'dir', src: (c) => path.join(c.home, '.codex'),
            excludes: ['cache'], secretNames: ['auth.json'] }] }
```

路径解析器统一写成 `(ctx) => string | string[]`，`ctx` 提供 `home / platform / appData / localAppData / cfgRoot`。返回多个候选路径时，存在的才会被采用。含私密数据的整条工具加 `secret: true`；目录内的私密文件名放进 `secretNames`（未勾选「包含私密文件」时排除）。

## 许可

[MIT](LICENSE)

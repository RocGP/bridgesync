'use strict';

/**
 * BridgeSync 工具注册表
 * ----------------------------------------------------------------------------
 * 每个 agent / 编辑器登记成一条数据，backup / restore / detect 全部遍历这张表，
 * 不写死逻辑。新增一个工具 = 在 TOOLS 里加一条，无需改 server.js。
 *
 * 路径全部由 ctx（home / 各平台目录）派生，所以对任何用户、任何系统都能
 * 自动定位"该用户自己"的目录。detect 会按"实际存在"过滤，路径写多了无害，
 * 因此不确定的工具可以登记多个候选路径。
 *
 * --- 一个工具的字段 ---
 *   id        唯一标识（英文、kebab-case）
 *   name      显示名
 *   category  'editor' | 'extension' | 'cli' | 'standalone' | 'keys'
 *   secret    true 表示整条含私密数据（如 SSH 私钥），默认不勾选
 *   items     该工具要迁移的若干"条目"，每个条目是下面某种 kind
 *
 * --- 条目 kind ---
 *   editorUser        VSCode 系 User 目录（settings.json 合并，其余跳过已存在）
 *   editorExtensions  扩展清单（CLI 列出，还原时只装缺的）
 *   extAgent          寄生在宿主编辑器 globalStorage/<extId> 里的扩展型 agent
 *   dir               普通目录（按 excludes 复制，还原跳过已存在）
 *   file              单个文件（还原跳过已存在）
 *   jsonMerge         JSON 配置（深合并、目标机现有值优先；可选路径重写）
 *   claudeProjects    Claude 专用：项目 key 重映射 + 会话内 cwd 重写
 *
 * 路径解析器统一写成 (ctx) => string | string[]，返回候选路径列表。
 */

const path = require('path');
const os = require('os');

function buildCtx() {
  const home = os.homedir();
  const platform = os.platform();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  // VSCode 系 User 目录与多数应用配置的根
  let cfgRoot;
  if (platform === 'win32') cfgRoot = appData;
  else if (platform === 'darwin') cfgRoot = path.join(home, 'Library', 'Application Support');
  else cfgRoot = path.join(home, '.config');
  return { home, platform, appData, localAppData, cfgRoot };
}

// 把解析器结果统一成数组
function resolve(resolver, ctx) {
  const r = typeof resolver === 'function' ? resolver(ctx) : resolver;
  if (r == null) return [];
  return Array.isArray(r) ? r.filter(Boolean) : [r];
}

// ----------------------------------------------------------------------------
// 工厂：VSCode 系编辑器（VS Code / Cursor / Windsurf / Antigravity IDE / VSCodium）
// ----------------------------------------------------------------------------
function editorTool({ id, name, cli, userPaths, extDirs, extraFiles = [] }) {
  const items = [
    { kind: 'editorUser', paths: userPaths },
    { kind: 'editorExtensions', cli, extDirs }
  ];
  extraFiles.forEach(f => items.push({ kind: 'file', src: f }));
  return { id, name, category: 'editor', cli, userPaths, extDirs, items };
}

// 寄生在编辑器 globalStorage 里的扩展型 agent
function extAgentTool({ id, name, extId, excludes = [] }) {
  return {
    id, name, category: 'extension', extId,
    items: [{ kind: 'extAgent', extId, excludes }]
  };
}

const GEMINI_EXCLUDES = ['tmp', 'cache', 'antigravity-browser-profile', 'browser_recordings', 'bin'];

// ----------------------------------------------------------------------------
// 工具注册表
// ----------------------------------------------------------------------------
const TOOLS = [
  // ===== Claude Code（CLI / VS Code 扩展共用 ~/.claude）=====
  {
    id: 'claude-code',
    name: 'Claude Code',
    category: 'cli',
    items: [
      // ~/.claude 主体（projects 单独处理；可选排除凭证）
      {
        kind: 'dir',
        src: (c) => path.join(c.home, '.claude'),
        excludes: ['projects', 'cache', 'downloads', 'paste-cache', 'telemetry'],
        secretNames: ['.credentials.json']
      },
      // 会话/记忆：项目 key 重映射 + 文件内路径重写
      { kind: 'claudeProjects', src: (c) => path.join(c.home, '.claude', 'projects') },
      // 全局配置（含 MCP 服务器）：路径重写后合并
      { kind: 'jsonMerge', src: (c) => path.join(c.home, '.claude.json'), rewrite: true, secretNames: [] },
      // Claude 桌面端配置
      {
        kind: 'jsonMerge', rewrite: true,
        src: (c) => {
          if (c.platform === 'win32') return [
            path.join(c.localAppData, 'Claude', 'claude_desktop_config.json'),
            path.join(c.localAppData, 'Claude-3p', 'claude_desktop_config.json')
          ];
          if (c.platform === 'darwin') return path.join(c.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
          return path.join(c.home, '.config', 'Claude', 'claude_desktop_config.json');
        }
      }
    ]
  },

  // ===== Antigravity / Gemini CLI（~/.gemini）=====
  {
    id: 'gemini-cli',
    name: 'Antigravity / Gemini CLI',
    category: 'cli',
    items: [
      { kind: 'dir', src: (c) => path.join(c.home, '.gemini'), excludes: GEMINI_EXCLUDES, skipNames: ['projects.json'] },
      { kind: 'jsonMerge', src: (c) => path.join(c.home, '.gemini', 'projects.json'), rewrite: true }
    ]
  },

  // ===== VSCode 系编辑器 =====
  editorTool({
    id: 'vscode', name: 'VS Code', cli: 'code',
    userPaths: (c) => path.join(c.cfgRoot, 'Code', 'User'),
    extDirs: (c) => path.join(c.home, '.vscode', 'extensions')
  }),
  editorTool({
    id: 'antigravity-ide', name: 'Antigravity IDE', cli: 'antigravity',
    userPaths: (c) => [path.join(c.cfgRoot, 'Antigravity', 'User'), path.join(c.cfgRoot, 'Antigravity IDE', 'User')],
    extDirs: (c) => [path.join(c.home, '.antigravity', 'extensions'), path.join(c.home, '.antigravity-ide', 'extensions')],
    extraFiles: [(c) => path.join(c.home, '.antigravity', 'argv.json')]
  }),
  editorTool({
    id: 'cursor', name: 'Cursor', cli: 'cursor',
    userPaths: (c) => path.join(c.cfgRoot, 'Cursor', 'User'),
    extDirs: (c) => path.join(c.home, '.cursor', 'extensions')
  }),
  editorTool({
    id: 'windsurf', name: 'Windsurf', cli: 'windsurf',
    userPaths: (c) => path.join(c.cfgRoot, 'Windsurf', 'User'),
    extDirs: (c) => path.join(c.home, '.windsurf', 'extensions')
  }),
  editorTool({
    id: 'vscodium', name: 'VSCodium', cli: 'codium',
    userPaths: (c) => path.join(c.cfgRoot, 'VSCodium', 'User'),
    extDirs: (c) => path.join(c.home, '.vscode-oss', 'extensions')
  }),

  // ===== VSCode 扩展型 agent（数据在宿主编辑器 globalStorage 里）=====
  extAgentTool({ id: 'cline', name: 'Cline', extId: 'saoudrizwan.claude-dev', excludes: ['cache', 'checkpoints'] }),
  extAgentTool({ id: 'roo-code', name: 'Roo Code', extId: 'rooveterinaryinc.roo-cline', excludes: ['cache', 'checkpoints'] }),
  extAgentTool({ id: 'kilo-code', name: 'Kilo Code', extId: 'kilocode.kilo-code', excludes: ['cache', 'checkpoints'] }),
  extAgentTool({ id: 'cody', name: 'Sourcegraph Cody', extId: 'sourcegraph.cody-ai', excludes: ['cache'] }),

  // ===== 其它 CLI 类 agent =====
  {
    id: 'continue', name: 'Continue', category: 'cli',
    items: [{ kind: 'dir', src: (c) => path.join(c.home, '.continue'), excludes: ['index', '.cache', 'logs'] }]
  },
  {
    id: 'aider', name: 'Aider', category: 'cli',
    items: [
      { kind: 'file', src: (c) => path.join(c.home, '.aider.conf.yml') },
      { kind: 'file', src: (c) => path.join(c.home, '.aider.model.settings.yml') },
      { kind: 'file', src: (c) => path.join(c.home, '.aider.model.metadata.json') }
    ]
  },
  {
    id: 'codex-cli', name: 'OpenAI Codex CLI', category: 'cli', secret: true,
    items: [{ kind: 'dir', src: (c) => path.join(c.home, '.codex'), excludes: ['cache'], secretNames: ['auth.json'] }]
  },
  {
    id: 'qwen-code', name: 'Qwen Code', category: 'cli',
    items: [{ kind: 'dir', src: (c) => path.join(c.home, '.qwen'), excludes: ['cache', 'tmp'] }]
  },

  // ===== 独立 AI 编辑器 =====
  {
    id: 'zed', name: 'Zed', category: 'standalone',
    items: [{
      kind: 'dir',
      src: (c) => c.platform === 'win32' ? path.join(c.appData, 'Zed') : path.join(c.cfgRoot, 'zed'),
      excludes: ['db', 'logs', 'cache', 'conversations', 'crashes', 'languages', 'node']
    }]
  },

  // ===== 密钥 / 通用配置 =====
  {
    id: 'ssh', name: 'SSH 密钥 (~/.ssh)', category: 'keys', secret: true,
    items: [{ kind: 'dir', src: (c) => path.join(c.home, '.ssh') }]
  },
  {
    id: 'gitconfig', name: '全局 .gitconfig', category: 'keys',
    items: [{ kind: 'file', src: (c) => path.join(c.home, '.gitconfig') }]
  }
];

// 取所有 editor 类工具（extAgent 需要遍历它们的 globalStorage）
function getEditorTools() {
  return TOOLS.filter(t => t.category === 'editor');
}

module.exports = { TOOLS, buildCtx, resolve, getEditorTools, GEMINI_EXCLUDES };

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const { TOOLS, buildCtx, resolve, getEditorTools } = require('./tools');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(pathMod.join(__dirname, 'public')));

const upload = multer({ dest: pathMod.join(__dirname, 'uploads/') });

const backupsDir = pathMod.join(__dirname, 'backups');
const uploadsDir = pathMod.join(__dirname, 'uploads');
const tempDir = pathMod.join(__dirname, 'temp');
[backupsDir, uploadsDir, tempDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// VSCode 系 User 目录里值得迁移的项（globalStorage/workspaceStorage/History 与机器/路径绑定，排除）
const EDITOR_USER_ITEMS = ['settings.json', 'keybindings.json', 'snippets'];

// 测量体积时跳过的重型/缓存目录，使显示值≈实际备份大小
const SIZE_EXCLUDES = ['cache', 'downloads', 'node_modules', '.git', 'paste-cache', 'telemetry', 'browser_recordings', 'antigravity-browser-profile', 'globalStorage', 'workspaceStorage', 'History', 'db', 'logs'];

// ---------------------------------------------------------------------------
// SSE 实时日志
// ---------------------------------------------------------------------------
let logClients = [];
function sendLog(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
  logClients.forEach(client => client.write(`data: ${JSON.stringify({ message, type })}\n\n`));
}

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logClients.push(res);
  sendLog('已连接实时日志终端。', 'system');
  req.on('close', () => { logClients = logClients.filter(c => c !== res); });
});

// ---------------------------------------------------------------------------
// 文件/目录助手
// ---------------------------------------------------------------------------
function getDirInfo(dirPath) {
  let size = 0, fileCount = 0, dirCount = 0;
  function traverse(p) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        dirCount++;
        fs.readdirSync(p).forEach(f => {
          if (SIZE_EXCLUDES.includes(f)) return;
          traverse(pathMod.join(p, f));
        });
      } else { fileCount++; size += st.size; }
    } catch (e) { /* 忽略权限错误 */ }
  }
  traverse(dirPath);
  return { size, fileCount, dirCount };
}

function pathExists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

// 普通递归复制（用于打包进全新的临时目录）
function copyDirRecursive(src, dest, excludeNames = []) {
  if (excludeNames.includes(pathMod.basename(src))) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(f => copyDirRecursive(pathMod.join(src, f), pathMod.join(dest, f), excludeNames));
  } else {
    const parent = pathMod.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 非破坏式复制：绝不覆盖目标机已存在的文件
function copyDirSkipExisting(src, dest, excludeNames = []) {
  if (excludeNames.includes(pathMod.basename(src))) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(f => copyDirSkipExisting(pathMod.join(src, f), pathMod.join(dest, f), excludeNames));
  } else {
    if (fs.existsSync(dest)) return; // 目标机优先
    const parent = pathMod.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 深合并：目标机现有值永远赢，source 只补目标缺的键
function deepMergeTargetWins(target, source) {
  if (Array.isArray(target) || Array.isArray(source)) return target;
  if (typeof target !== 'object' || target === null) return target;
  if (typeof source !== 'object' || source === null) return target;
  const out = { ...target };
  for (const k of Object.keys(source)) {
    if (!(k in out)) out[k] = source[k];
    else out[k] = deepMergeTargetWins(out[k], source[k]);
  }
  return out;
}

function mergeJsonIntoTarget(sourceContent, targetFile) {
  let source;
  try { source = JSON.parse(sourceContent); }
  catch (e) { sendLog(`备份 JSON 解析失败，跳过 ${pathMod.basename(targetFile)}。`, 'warning'); return; }
  const parent = pathMod.dirname(targetFile);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, JSON.stringify(source, null, 2), 'utf8');
    return;
  }
  let target;
  try { target = JSON.parse(fs.readFileSync(targetFile, 'utf8')); }
  catch (e) { sendLog(`目标 ${pathMod.basename(targetFile)} 不是合法 JSON，保持原样。`, 'warning'); return; }
  fs.writeFileSync(targetFile, JSON.stringify(deepMergeTargetWins(target, source), null, 2), 'utf8');
}

function rewritePaths(content, pathMapping) {
  Object.keys(pathMapping).forEach(oldP => {
    const newP = pathMapping[oldP];
    if (!oldP || !newP) return;
    content = content.split(oldP).join(newP);
    content = content.split(oldP.replace(/\\/g, '/')).join(newP.replace(/\\/g, '/'));
    content = content.split(oldP.replace(/\\/g, '\\\\')).join(newP.replace(/\\/g, '\\\\'));
  });
  return content;
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function runPowerShell(psCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand]);
    child.stdout.on('data', d => sendLog(d.toString().trim()));
    child.stderr.on('data', d => sendLog(d.toString().trim(), 'warning'));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell 退出码 ${code}`)));
  });
}

function zipDirectory(sourceDir, outPath) {
  sendLog(`正在压缩备份目录到：${pathMod.basename(outPath)}`, 'backup');
  if (os.platform() === 'win32') {
    return runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(sourceDir)}, ${psQuote(outPath)})`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('zip', ['-r', outPath, '.'], { cwd: sourceDir });
    child.stdout.on('data', d => sendLog(d.toString().trim()));
    child.stderr.on('data', d => sendLog(d.toString().trim(), 'warning'));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`zip 退出码 ${code}`)));
  });
}

function unzipDirectory(zipPath, targetDir) {
  sendLog('正在解压备份文件到临时还原目录…', 'restore');
  if (os.platform() === 'win32') {
    return runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(targetDir)})`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', targetDir]);
    child.stdout.on('data', d => sendLog(d.toString().trim()));
    child.stderr.on('data', d => sendLog(d.toString().trim(), 'warning'));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip 退出码 ${code}`)));
  });
}

function pathToProjectKey(absolutePath) { return absolutePath.replace(/[^a-zA-Z0-9]/g, '-'); }

// 用编辑器 CLI 列出扩展，失败则扫描扩展目录
function listExtensions(cli, extDirs) {
  return new Promise(res => {
    exec(`${cli} --list-extensions`, (err, stdout) => {
      if (!err && stdout) return res(stdout.split('\n').map(x => x.trim()).filter(Boolean));
      const found = new Set();
      (extDirs || []).forEach(dir => {
        if (!pathExists(dir)) return;
        try { fs.readdirSync(dir).forEach(f => { if (fs.statSync(pathMod.join(dir, f)).isDirectory()) found.add(f); }); } catch (e) {}
      });
      res([...found]);
    });
  });
}

// ---------------------------------------------------------------------------
// 注册表助手：解析条目的源路径 / 探测工具
// ---------------------------------------------------------------------------
function itemSources(item, ctx) {
  if (item.kind === 'editorUser') return resolve(item.paths, ctx);
  if (item.kind === 'editorExtensions') return [];
  if (item.kind === 'extAgent') return [];
  return resolve(item.src, ctx);          // dir / file / jsonMerge / claudeProjects
}

// 某 extAgent 在各宿主编辑器 globalStorage 下的实际数据目录
function extAgentHosts(extId, ctx) {
  const hosts = [];
  getEditorTools().forEach(ed => {
    resolve(ed.userPaths, ctx).forEach((userPath, k) => {
      const gs = pathMod.join(userPath, 'globalStorage', extId);
      if (pathExists(gs)) hosts.push({ editorId: ed.id, userIndex: k, dir: gs });
    });
  });
  return hosts;
}

// 探测一个工具：是否存在、体积、（编辑器的）扩展数
async function detectTool(tool, ctx) {
  let exists = false, size = 0, extCount = 0, extensionsList = [];
  for (const item of tool.items) {
    if (item.kind === 'editorExtensions') {
      extensionsList = await listExtensions(tool.cli, resolve(item.extDirs, ctx));
      extCount = extensionsList.length;
      if (extCount) exists = true;
    } else if (item.kind === 'extAgent') {
      extAgentHosts(item.extId, ctx).forEach(h => { exists = true; try { size += getDirInfo(h.dir).size; } catch (e) {} });
    } else {
      itemSources(item, ctx).forEach(p => {
        if (!pathExists(p)) return;
        exists = true;
        try { size += fs.statSync(p).isDirectory() ? getDirInfo(p).size : fs.statSync(p).size; } catch (e) {}
      });
    }
  }
  return { id: tool.id, name: tool.name, category: tool.category, secret: !!tool.secret, exists, size, extCount, extensionsList };
}

// ---------------------------------------------------------------------------
// 1. 环境检测
// ---------------------------------------------------------------------------
app.get('/api/detect', async (req, res) => {
  const ctx = buildCtx();
  const tools = [];
  for (const tool of TOOLS) tools.push(await detectTool(tool, ctx));
  res.json({
    os: os.platform(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    home: os.homedir(),
    tools
  });
});

// ---------------------------------------------------------------------------
// 2. 扫描任意工作区
// ---------------------------------------------------------------------------
app.post('/api/scan-workspace', (req, res) => {
  const { workspacePath } = req.body;
  if (!workspacePath) return res.status(400).json({ error: '缺少 workspacePath' });
  const clean = pathMod.resolve(workspacePath);
  if (!fs.existsSync(clean)) return res.status(404).json({ error: '目录不存在' });
  try {
    const info = getDirInfo(clean);
    res.json({ path: clean, name: pathMod.basename(clean), size: info.size, files: info.fileCount, dirs: info.dirCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// 3. 备份（数据驱动）
// ---------------------------------------------------------------------------
function stageTool(tool, ctx, toolDir, includeSecrets) {
  // 返回该工具的 manifest 条目数组；无数据则返回 []
  const records = [];
  let staged = false, secretStaged = false;

  tool.items.forEach((item, i) => {
    const itemDir = pathMod.join(toolDir, `item_${i}`);

    if (item.kind === 'editorExtensions') {
      return; // 扩展清单在外层异步统一处理
    }

    if (item.kind === 'extAgent') {
      const hosts = extAgentHosts(item.extId, ctx).map(h => {
        const dest = pathMod.join(itemDir, `${h.editorId}__user_${h.userIndex}`);
        copyDirRecursive(h.dir, dest, item.excludes || []);
        return { editorId: h.editorId, userIndex: h.userIndex };
      });
      if (hosts.length) { staged = true; records.push({ i, kind: 'extAgent', extId: item.extId, hosts }); }
      return;
    }

    if (item.kind === 'claudeProjects') {
      const src = itemSources(item, ctx)[0];
      if (src && pathExists(src)) {
        copyDirRecursive(src, pathMod.join(itemDir, 'projects'));
        staged = true; records.push({ i, kind: 'claudeProjects', present: true });
      }
      return;
    }

    if (item.kind === 'editorUser') {
      const srcIndices = [];
      itemSources(item, ctx).forEach((userPath, j) => {
        if (!pathExists(userPath)) return;
        let any = false;
        EDITOR_USER_ITEMS.forEach(it => {
          const p = pathMod.join(userPath, it);
          if (pathExists(p)) { copyDirRecursive(p, pathMod.join(itemDir, `src_${j}`, it)); any = true; }
        });
        if (any) srcIndices.push(j);
      });
      if (srcIndices.length) { staged = true; records.push({ i, kind: 'editorUser', srcIndices }); }
      return;
    }

    const excludes = (item.excludes || []).concat((!includeSecrets && item.secretNames) || []);
    const skipNames = item.skipNames || [];
    const srcIndices = [];

    itemSources(item, ctx).forEach((src, j) => {
      if (!pathExists(src)) return;
      const isDir = fs.statSync(src).isDirectory();
      if (item.kind === 'dir') {
        // 顶层跳过 skipNames（如 gemini 的 projects.json 由 jsonMerge 处理）
        const dest = pathMod.join(itemDir, `src_${j}`);
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach(f => {
          if (excludes.includes(f) || skipNames.includes(f)) return;
          copyDirRecursive(pathMod.join(src, f), pathMod.join(dest, f), excludes);
        });
        if (item.secretNames && includeSecrets && item.secretNames.some(n => pathExists(pathMod.join(src, n)))) secretStaged = true;
      } else if (item.kind === 'file') {
        if (isDir) return;
        copyDirRecursive(src, pathMod.join(itemDir, `file_${j}`));
      } else if (item.kind === 'jsonMerge') {
        if (isDir) return;
        copyDirRecursive(src, pathMod.join(itemDir, `json_${j}`));
      }
      srcIndices.push(j);
    });

    if (srcIndices.length) {
      staged = true;
      records.push({ i, kind: item.kind, rewrite: !!item.rewrite, srcIndices });
    }
  });

  if (tool.secret && staged) secretStaged = true;
  return { records, staged, secretStaged };
}

app.post('/api/backup', async (req, res) => {
  const { selectedTools, includeSecrets, customWorkspaces } = req.body;
  const selected = Array.isArray(selectedTools) ? selectedTools : [];
  const ctx = buildCtx();
  const timestamp = Date.now();
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionTempDir = pathMod.join(tempDir, `backup_${timestamp}`);
  const finalZipPath = pathMod.join(backupsDir, `BridgeSync_${dateStr}.zip`);

  try {
    fs.mkdirSync(sessionTempDir, { recursive: true });
    sendLog(`开始备份… 临时目录：${sessionTempDir}`, 'system');

    const manifest = {
      backupTime: new Date().toISOString(),
      sourceOS: os.platform(),
      sourceHost: os.hostname(),
      sourceUser: os.userInfo().username,
      sourceHome: os.homedir(),
      includesSecrets: false,
      tools: [],
      workspaces: []
    };

    for (const tool of TOOLS) {
      if (!selected.includes(tool.id)) continue;
      sendLog(`正在备份：${tool.name}…`, 'backup');
      const toolDir = pathMod.join(sessionTempDir, 'tools', tool.id);
      const { records, staged, secretStaged } = stageTool(tool, ctx, toolDir, !!includeSecrets);

      // 编辑器扩展清单
      for (let i = 0; i < tool.items.length; i++) {
        const item = tool.items[i];
        if (item.kind !== 'editorExtensions') continue;
        const extensions = await listExtensions(tool.cli, resolve(item.extDirs, ctx));
        if (extensions.length) {
          sendLog(`${tool.name}：发现 ${extensions.length} 个扩展。`, 'backup');
          records.push({ i, kind: 'editorExtensions', cli: tool.cli, extensions });
        }
      }

      if (records.length) {
        if (secretStaged) { manifest.includesSecrets = true; sendLog(`注意：${tool.name} 备份含明文私密数据，请妥善保管压缩包。`, 'warning'); }
        manifest.tools.push({ id: tool.id, name: tool.name, category: tool.category, secret: !!tool.secret, items: records });
        sendLog(`${tool.name} 已暂存。`, 'backup');
      }
    }

    // 自定义工作区
    if (customWorkspaces && customWorkspaces.length) {
      const wsDest = pathMod.join(sessionTempDir, 'workspaces');
      fs.mkdirSync(wsDest, { recursive: true });
      for (const wPath of customWorkspaces) {
        if (fs.existsSync(wPath)) {
          const folderName = pathMod.basename(wPath);
          sendLog(`正在暂存工作区目录：${folderName}（${wPath}）`, 'backup');
          copyDirRecursive(wPath, pathMod.join(wsDest, folderName), ['node_modules', '.git', 'dist', 'build', '.next', '.codegraph']);
          manifest.workspaces.push({ originalPath: wPath, folderName });
        } else sendLog(`工作区目录不存在：${wPath}`, 'warning');
      }
    }

    fs.writeFileSync(pathMod.join(sessionTempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await zipDirectory(sessionTempDir, finalZipPath);
    sendLog('正在清理临时文件…', 'system');
    fs.rmSync(sessionTempDir, { recursive: true, force: true });
    sendLog(`备份完成！保存路径：${finalZipPath}`, 'success');
    res.json({ success: true, filename: pathMod.basename(finalZipPath), size: fs.statSync(finalZipPath).size, time: manifest.backupTime });
  } catch (e) {
    sendLog(`备份失败：${e.message}`, 'error');
    if (fs.existsSync(sessionTempDir)) fs.rmSync(sessionTempDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 4. 上传备份并解析 manifest
// ---------------------------------------------------------------------------
let activeRestoreSession = null;

app.post('/api/restore-upload', upload.single('backupFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const fileInfo = req.file;
  const restoreTempPath = pathMod.join(tempDir, `restore_${Date.now()}`);
  try {
    fs.mkdirSync(restoreTempPath, { recursive: true });
    await unzipDirectory(fileInfo.path, restoreTempPath);
    const manifestPath = pathMod.join(restoreTempPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      fs.rmSync(restoreTempPath, { recursive: true, force: true });
      fs.unlinkSync(fileInfo.path);
      return res.status(400).json({ error: '无效备份文件：缺少 manifest.json。' });
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    activeRestoreSession = { tempPath: restoreTempPath, zipPath: fileInfo.path, manifest };
    res.json({ success: true, manifest });
  } catch (e) {
    sendLog(`解析上传备份失败：${e.message}`, 'error');
    if (fs.existsSync(restoreTempPath)) fs.rmSync(restoreTempPath, { recursive: true, force: true });
    if (fs.existsSync(fileInfo.path)) fs.unlinkSync(fileInfo.path);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 5. 确认还原（非破坏式）
// ---------------------------------------------------------------------------
function snapshotExisting(snapshotDir, manifest, ctx) {
  sendLog(`还原前先把目标机现有配置快照到 ${pathMod.basename(snapshotDir)}/…`, 'system');
  const toolMap = {}; TOOLS.forEach(t => { toolMap[t.id] = t; });
  (manifest.tools || []).forEach(saved => {
    const tool = toolMap[saved.id];
    if (!tool) return;
    tool.items.forEach((item, i) => {
      if (item.kind === 'editorExtensions') return;
      if (item.kind === 'extAgent') {
        extAgentHosts(item.extId, ctx).forEach(h => {
          try { copyDirRecursive(h.dir, pathMod.join(snapshotDir, saved.id, `${h.editorId}__user_${h.userIndex}`), SIZE_EXCLUDES); } catch (e) {}
        });
        return;
      }
      itemSources(item, ctx).forEach((p, j) => {
        if (!pathExists(p)) return;
        try { copyDirRecursive(p, pathMod.join(snapshotDir, saved.id, `item_${i}_src_${j}`), SIZE_EXCLUDES); } catch (e) {}
      });
    });
  });
}

app.post('/api/restore-confirm', async (req, res) => {
  if (!activeRestoreSession) return res.status(400).json({ error: '没有进行中的还原会话，请先上传 zip。' });
  const { pathMapping } = req.body;
  const { tempPath, zipPath, manifest } = activeRestoreSession;
  const ctx = buildCtx();
  const toolMap = {}; TOOLS.forEach(t => { toolMap[t.id] = t; });
  const notes = [];

  try {
    sendLog('开始非破坏式还原…', 'system');
    const snapshotDir = pathMod.join(backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    snapshotExisting(snapshotDir, manifest, ctx);

    // 全局路径映射：用户填的 + 隐式 sourceHome→目标home
    const mappings = {};
    Object.keys(pathMapping || {}).forEach(k => { if (pathMapping[k]) mappings[k] = pathMapping[k]; });
    if (manifest.sourceHome && manifest.sourceHome !== os.homedir()) mappings[manifest.sourceHome] = os.homedir();

    // 工作区（跳过已存在，绝不覆盖）
    (manifest.workspaces || []).forEach(w => {
      const target = (pathMapping || {})[w.originalPath];
      if (!target) { sendLog(`跳过工作区 ${w.folderName}（未配置映射）。`, 'restore'); return; }
      const srcFolder = pathMod.join(tempPath, 'workspaces', w.folderName);
      if (fs.existsSync(srcFolder)) { sendLog(`还原工作区 ${w.folderName} → ${target}（保留已有文件）`, 'restore'); copyDirSkipExisting(srcFolder, target); }
    });

    // 各工具
    for (const saved of (manifest.tools || [])) {
      const tool = toolMap[saved.id];
      if (!tool) { sendLog(`备份含未知工具 ${saved.id}，跳过。`, 'warning'); continue; }
      sendLog(`正在还原：${saved.name}…`, 'restore');
      const toolDir = pathMod.join(tempPath, 'tools', saved.id);

      for (const rec of saved.items) {
        const item = tool.items[rec.i];
        if (!item) continue;
        const itemDir = pathMod.join(toolDir, `item_${rec.i}`);

        if (rec.kind === 'editorExtensions') {
          installMissingExtensions(rec.cli || tool.cli, saved.name, rec.extensions || []);
        } else if (rec.kind === 'extAgent') {
          (rec.hosts || []).forEach(h => {
            const ed = toolMap[h.editorId];
            if (!ed) return;
            const userPath = resolve(ed.userPaths, ctx)[h.userIndex];
            if (!userPath) return;
            const src = pathMod.join(itemDir, `${h.editorId}__user_${h.userIndex}`);
            if (fs.existsSync(src)) copyDirSkipExisting(src, pathMod.join(userPath, 'globalStorage', rec.extId));
          });
        } else if (rec.kind === 'claudeProjects') {
          restoreProjects(pathMod.join(itemDir, 'projects'), pathMod.join(os.homedir(), '.claude', 'projects'), mappings, manifest.workspaces || [], pathMapping || {});
        } else if (rec.kind === 'editorUser') {
          const targets = itemSources(item, ctx);
          (rec.srcIndices || []).forEach(j => {
            const srcUser = pathMod.join(itemDir, `src_${j}`);
            const destUser = targets[j];
            if (!fs.existsSync(srcUser) || !destUser) return;
            EDITOR_USER_ITEMS.forEach(it => {
              const s = pathMod.join(srcUser, it);
              if (!fs.existsSync(s)) return;
              if (it === 'settings.json') mergeJsonIntoTarget(fs.readFileSync(s, 'utf8'), pathMod.join(destUser, it));
              else copyDirSkipExisting(s, pathMod.join(destUser, it));
            });
          });
        } else if (rec.kind === 'dir') {
          const targets = itemSources(item, ctx);
          (rec.srcIndices || []).forEach(j => {
            const s = pathMod.join(itemDir, `src_${j}`);
            if (fs.existsSync(s) && targets[j]) copyDirSkipExisting(s, targets[j]);
          });
        } else if (rec.kind === 'file') {
          const targets = itemSources(item, ctx);
          (rec.srcIndices || []).forEach(j => {
            const s = pathMod.join(itemDir, `file_${j}`);
            if (fs.existsSync(s) && targets[j] && !fs.existsSync(targets[j])) {
              const parent = pathMod.dirname(targets[j]);
              if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
              fs.copyFileSync(s, targets[j]);
            } else if (targets[j] && fs.existsSync(targets[j])) {
              notes.push(`${saved.name}: ${pathMod.basename(targets[j])} 目标机已存在，保留未覆盖。`);
            }
          });
        } else if (rec.kind === 'jsonMerge') {
          const targets = itemSources(item, ctx);
          (rec.srcIndices || []).forEach(j => {
            const s = pathMod.join(itemDir, `json_${j}`);
            if (!fs.existsSync(s) || !targets[j]) return;
            let content = fs.readFileSync(s, 'utf8');
            if (rec.rewrite) content = rewritePaths(content, mappings);
            mergeJsonIntoTarget(content, targets[j]);
          });
        }
      }
      sendLog(`${saved.name} 已还原。`, 'success');
    }

    writeMigrationNotes(manifest, snapshotDir, notes);

    sendLog('正在清理还原缓存…', 'system');
    fs.rmSync(tempPath, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    activeRestoreSession = null;
    sendLog('还原完成（非破坏式）。', 'success');
    res.json({ success: true, snapshot: snapshotDir });
  } catch (e) {
    sendLog(`还原失败：${e.message}`, 'error');
    res.status(500).json({ error: e.message });
  }
});

// Claude 项目还原：项目 key 重映射 + 文件内路径重写
function restoreProjects(projectsSource, projectsDest, mappings, workspaces, pathMapping) {
  if (!fs.existsSync(projectsSource)) return;
  if (!fs.existsSync(projectsDest)) fs.mkdirSync(projectsDest, { recursive: true });
  const keyToOriginal = {};
  workspaces.forEach(w => { keyToOriginal[pathToProjectKey(w.originalPath).toLowerCase()] = w.originalPath; });

  fs.readdirSync(projectsSource).forEach(oldKey => {
    let newKey = oldKey;
    const original = keyToOriginal[oldKey.toLowerCase()];
    if (original && pathMapping[original]) {
      newKey = pathToProjectKey(pathMapping[original]);
      sendLog(`映射 Claude 项目 key：${oldKey} → ${newKey}`, 'restore');
    } else {
      const remap = homeKeyRemap(oldKey, mappings);
      if (remap) { newKey = remap; sendLog(`按 home 重映射项目 key：${oldKey} → ${newKey}`, 'restore'); }
    }
    const srcPath = pathMod.join(projectsSource, oldKey);
    const dstPath = pathMod.join(projectsDest, newKey);
    copyDirSkipExisting(srcPath, dstPath);
    rewriteProjectFiles(dstPath, mappings);
  });
}

function homeKeyRemap(oldKey, mappings) {
  for (const oldPath of Object.keys(mappings)) {
    const oldPk = pathToProjectKey(oldPath);
    if (oldKey.toLowerCase().startsWith(oldPk.toLowerCase())) {
      return pathToProjectKey(mappings[oldPath]) + oldKey.slice(oldPk.length);
    }
  }
  return null;
}

function rewriteProjectFiles(dir, mappings) {
  if (!Object.keys(mappings).length) return;
  fs.readdirSync(dir).forEach(file => {
    const filePath = pathMod.join(dir, file);
    let st; try { st = fs.statSync(filePath); } catch (e) { return; }
    if (st.isDirectory() && file === 'memory') {
      fs.readdirSync(filePath).forEach(mf => {
        const mp = pathMod.join(filePath, mf);
        if (fs.statSync(mp).isFile() && mf.endsWith('.md')) fs.writeFileSync(mp, rewritePaths(fs.readFileSync(mp, 'utf8'), mappings), 'utf8');
      });
    } else if (st.isFile() && file.endsWith('.jsonl')) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(line => {
        if (!line.trim()) return line;
        try {
          const obj = JSON.parse(line);
          Object.keys(mappings).forEach(oldP => {
            const newP = mappings[oldP];
            if (obj.cwd && obj.cwd.startsWith(oldP)) obj.cwd = obj.cwd.replace(oldP, newP);
            if (obj.attachment && obj.attachment.filename && obj.attachment.filename.startsWith(oldP)) {
              obj.attachment.filename = obj.attachment.filename.replace(oldP, newP);
              const f = obj.attachment.content && obj.attachment.content.file;
              if (f && f.filePath && f.filePath.startsWith(oldP)) f.filePath = f.filePath.replace(oldP, newP);
            }
          });
          return JSON.stringify(obj);
        } catch (e) { return rewritePaths(line, mappings); }
      });
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    }
  });
}

function installMissingExtensions(cli, name, wanted) {
  if (!wanted.length || !cli) return;
  exec(`${cli} --list-extensions`, (err, stdout) => {
    const installed = (!err && stdout) ? new Set(stdout.split('\n').map(x => x.trim().toLowerCase()).filter(Boolean)) : new Set();
    const missing = wanted.filter(e => !installed.has(e.toLowerCase()));
    if (!missing.length) { sendLog(`${name}：${wanted.length} 个扩展已全部安装。`, 'restore'); return; }
    sendLog(`${name}：通过 '${cli}' 安装缺失的 ${missing.length} 个扩展…`, 'restore');
    missing.forEach(ext => exec(`${cli} --install-extension ${ext}`, e =>
      sendLog(e ? `${name}：安装 ${ext} 失败（CLI '${cli}' 不可用？）。` : `${name}：已安装 ${ext}`, e ? 'warning' : 'restore')));
  });
}

function writeMigrationNotes(manifest, snapshotDir, notes) {
  const lines = [];
  lines.push('BridgeSync 迁移说明');
  lines.push('====================');
  lines.push(`还原时间：${new Date().toISOString()}`);
  lines.push(`来源：${manifest.sourceHost}（${manifest.sourceUser}，${manifest.sourceOS}）`);
  lines.push(`本机原配置的快照（可回滚）：${snapshotDir}`);
  lines.push('');
  lines.push('本次还原为非破坏式：目标机已有文件保留，JSON 合并且你的现有值优先。');
  lines.push('');
  if (notes.length) { lines.push('本次提示：'); notes.forEach(n => lines.push(`  - ${n}`)); lines.push(''); }
  lines.push('需要手动处理（工具本身不随备份迁移）：');
  lines.push('  - 安装运行时/CLI：Node.js、各编辑器的命令行（code / cursor / windsurf / antigravity 等）、gh。');
  lines.push('  - rtk：拷贝 rtk 二进制并加入 PATH。');
  lines.push('  - codegraph：npm install -g @colbymchenry/codegraph，每个项目 codegraph init -i 重建索引。');
  lines.push('  - 未迁移登录态的工具需重新登录（Claude、扩展、gh auth login 等）。');
  lines.push('  - 编辑器 globalStorage/workspaceStorage 未迁移（与机器/路径绑定）。');
  if (manifest.includesSecrets) lines.push('  - 本备份含私密数据（凭证/SSH 密钥等），用完请删除 .zip。');
  const notesPath = pathMod.join(os.homedir(), 'BridgeSync-MIGRATION-NOTES.txt');
  try { fs.writeFileSync(notesPath, lines.join('\n'), 'utf8'); sendLog(`迁移说明已写入：${notesPath}`, 'success'); }
  catch (e) { sendLog(`写入迁移说明失败：${e.message}`, 'warning'); }
}

app.listen(port, '127.0.0.1', () => {
  console.log(`BridgeSync 本地后端已启动：http://127.0.0.1:${port}`);
});

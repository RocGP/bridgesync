const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');

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

// Real-time log streaming via Server-Sent Events (SSE)
let logClients = [];
function sendLog(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);
  logClients.forEach(client => {
    client.write(`data: ${JSON.stringify({ message, type })}\n\n`);
  });
}

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  logClients.push(res);
  sendLog('Connected to real-time log terminal.', 'system');

  req.on('close', () => {
    logClients = logClients.filter(client => client !== res);
  });
});

// ---------------------------------------------------------------------------
// OS Path Helpers
// ---------------------------------------------------------------------------
function getClaudePath() {
  return pathMod.join(os.homedir(), '.claude');
}
function getClaudeConfigPath() {
  return pathMod.join(os.homedir(), '.claude.json');
}
function getGeminiPath() {
  return pathMod.join(os.homedir(), '.gemini');
}
function getSshPath() {
  return pathMod.join(os.homedir(), '.ssh');
}
function getGitconfigPath() {
  return pathMod.join(os.homedir(), '.gitconfig');
}
function getAntigravityArgvPath() {
  return pathMod.join(os.homedir(), '.antigravity', 'argv.json');
}

function getClaudeDesktopConfigs() {
  const platform = os.platform();
  const list = [];
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    list.push({ name: 'Claude', path: pathMod.join(local, 'Claude', 'claude_desktop_config.json') });
    list.push({ name: 'Claude-3p', path: pathMod.join(local, 'Claude-3p', 'claude_desktop_config.json') });
  } else if (platform === 'darwin') {
    list.push({ name: 'Claude', path: pathMod.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') });
  } else {
    list.push({ name: 'Claude', path: pathMod.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json') });
  }
  return list;
}

// VS Code-family editors (VS Code + Antigravity IDE share the same on-disk layout).
// Each editor can have several User dirs and several extension dirs across variants.
function getEditors() {
  const platform = os.platform();
  const home = os.homedir();
  let cfgRoot;
  if (platform === 'win32') cfgRoot = process.env.APPDATA || pathMod.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') cfgRoot = pathMod.join(home, 'Library', 'Application Support');
  else cfgRoot = pathMod.join(home, '.config');

  return [
    {
      id: 'vscode',
      name: 'VS Code',
      cli: 'code',
      userPaths: [pathMod.join(cfgRoot, 'Code', 'User')],
      extDirs: [pathMod.join(home, '.vscode', 'extensions')]
    },
    {
      id: 'antigravity-ide',
      name: 'Antigravity IDE',
      cli: 'antigravity',
      userPaths: [
        pathMod.join(cfgRoot, 'Antigravity', 'User'),
        pathMod.join(cfgRoot, 'Antigravity IDE', 'User')
      ],
      extDirs: [
        pathMod.join(home, '.antigravity', 'extensions'),
        pathMod.join(home, '.antigravity-ide', 'extensions')
      ]
    }
  ];
}

// User-dir items worth migrating. workspaceStorage/globalStorage/History are
// machine/path-specific and excluded to avoid bloat and stale state.
const EDITOR_USER_ITEMS = ['settings.json', 'keybindings.json', 'snippets'];

// ~/.gemini holds gigabytes of browser recordings / binaries that are pure
// bloat; keep only the agent's conversations, brain (memory) and configs.
const GEMINI_EXCLUDES = ['tmp', 'cache', 'antigravity-browser-profile', 'browser_recordings', 'bin'];

// Bulky/cache dir names skipped when measuring sizes for the dashboard, so the
// displayed number tracks what actually gets backed up.
const SIZE_EXCLUDES = ['cache', 'downloads', 'node_modules', '.git', 'paste-cache', 'telemetry', 'browser_recordings', 'antigravity-browser-profile'];

// Translate an absolute path to Claude's project-folder key.
function pathToProjectKey(absolutePath) {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// Generic file/dir helpers
// ---------------------------------------------------------------------------
function getDirInfo(dirPath) {
  let size = 0, fileCount = 0, dirCount = 0;
  function traverse(currentPath) {
    try {
      const stats = fs.statSync(currentPath);
      if (stats.isDirectory()) {
        dirCount++;
        fs.readdirSync(currentPath).forEach(file => {
          if (SIZE_EXCLUDES.includes(file)) return;
          traverse(pathMod.join(currentPath, file));
        });
      } else {
        fileCount++;
        size += stats.size;
      }
    } catch (e) { /* ignore permission errors */ }
  }
  traverse(dirPath);
  return { size, fileCount, dirCount };
}

// Plain recursive copy (used for staging into a fresh temp dir).
function copyDirRecursive(src, dest, excludeNames = []) {
  if (excludeNames.includes(pathMod.basename(src))) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(file => {
      copyDirRecursive(pathMod.join(src, file), pathMod.join(dest, file), excludeNames);
    });
  } else {
    const parent = pathMod.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Non-destructive copy: never overwrite a file that already exists on target.
function copyDirSkipExisting(src, dest, excludeNames = []) {
  if (excludeNames.includes(pathMod.basename(src))) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(file => {
      copyDirSkipExisting(pathMod.join(src, file), pathMod.join(dest, file), excludeNames);
    });
  } else {
    if (fs.existsSync(dest)) return; // target wins
    const parent = pathMod.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Deep merge where the target's existing values always win; source only fills
// in keys the target is missing.
function deepMergeTargetWins(target, source) {
  if (Array.isArray(target) || Array.isArray(source)) return target;
  if (typeof target !== 'object' || target === null) return target;
  if (typeof source !== 'object' || source === null) return target;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (!(key in out)) out[key] = source[key];
    else out[key] = deepMergeTargetWins(out[key], source[key]);
  }
  return out;
}

// Write a JSON config non-destructively: if target absent, write source as-is;
// otherwise merge with target winning. `sourceContent` is the (already
// path-rewritten) backup JSON string.
function mergeJsonIntoTarget(sourceContent, targetFile) {
  let source;
  try { source = JSON.parse(sourceContent); }
  catch (e) { sendLog(`Skipped malformed backup JSON for ${pathMod.basename(targetFile)}.`, 'warning'); return false; }

  const parent = pathMod.dirname(targetFile);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, JSON.stringify(source, null, 2), 'utf8');
    return true;
  }
  let target;
  try { target = JSON.parse(fs.readFileSync(targetFile, 'utf8')); }
  catch (e) { sendLog(`Target ${pathMod.basename(targetFile)} is not valid JSON; left untouched.`, 'warning'); return false; }

  const merged = deepMergeTargetWins(target, source);
  fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2), 'utf8');
  return true;
}

// Apply every old->new mapping to a string, covering raw, forward-slash and
// escaped-backslash representations.
function rewritePaths(content, pathMapping) {
  Object.keys(pathMapping).forEach(oldPath => {
    const newPath = pathMapping[oldPath];
    if (!oldPath || !newPath) return;
    content = content.split(oldPath).join(newPath);
    content = content.split(oldPath.replace(/\\/g, '/')).join(newPath.replace(/\\/g, '/'));
    content = content.split(oldPath.replace(/\\/g, '\\\\')).join(newPath.replace(/\\/g, '\\\\'));
  });
  return content;
}

// Single-quote a string for a PowerShell '...' literal.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function runPowerShell(psCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand]);
    child.stdout.on('data', data => sendLog(data.toString().trim()));
    child.stderr.on('data', data => sendLog(data.toString().trim(), 'warning'));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell exited with code ${code}`)));
  });
}

function zipDirectory(sourceDir, outPath) {
  const platform = os.platform();
  sendLog(`Compressing backup directory to: ${pathMod.basename(outPath)}`, 'backup');
  if (platform === 'win32') {
    const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(sourceDir)}, ${psQuote(outPath)})`;
    return runPowerShell(psCommand);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('zip', ['-r', outPath, '.'], { cwd: sourceDir });
    child.stdout.on('data', data => sendLog(data.toString().trim()));
    child.stderr.on('data', data => sendLog(data.toString().trim(), 'warning'));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Zip exited with code ${code}`)));
  });
}

function unzipDirectory(zipPath, targetDir) {
  const platform = os.platform();
  sendLog('Extracting backup file to temporary restore directory...', 'restore');
  if (platform === 'win32') {
    const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(targetDir)})`;
    return runPowerShell(psCommand);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', targetDir]);
    child.stdout.on('data', data => sendLog(data.toString().trim()));
    child.stderr.on('data', data => sendLog(data.toString().trim(), 'warning'));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Unzip exited with code ${code}`)));
  });
}

// List an editor's extensions via its CLI, falling back to scanning ext dirs.
function listEditorExtensions(editor) {
  return new Promise(resolve => {
    exec(`${editor.cli} --list-extensions`, (err, stdout) => {
      if (!err && stdout) {
        return resolve(stdout.split('\n').map(x => x.trim()).filter(Boolean));
      }
      const found = new Set();
      editor.extDirs.forEach(dir => {
        if (!fs.existsSync(dir)) return;
        try {
          fs.readdirSync(dir).forEach(f => {
            if (fs.statSync(pathMod.join(dir, f)).isDirectory()) found.add(f);
          });
        } catch (e) { /* ignore */ }
      });
      resolve([...found]);
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Detect configuration environments
// ---------------------------------------------------------------------------
app.get('/api/detect', async (req, res) => {
  const claudePath = getClaudePath();
  const geminiPath = getGeminiPath();
  const editors = getEditors();

  const results = {
    os: os.platform(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    home: os.homedir(),
    claude: {
      path: claudePath,
      exists: fs.existsSync(claudePath),
      configExists: fs.existsSync(getClaudeConfigPath()),
      desktopConfigs: getClaudeDesktopConfigs().filter(x => fs.existsSync(x.path)).map(x => ({ name: x.name, path: x.path })),
      size: 0, sessionsCount: 0, projects: []
    },
    // Primary editor surfaced as `vscode` for the existing dashboard cards.
    vscode: { path: editors[0].userPaths[0], exists: false, size: 0, extensionsCount: 0, extensionsList: [] },
    editors: [],
    gemini: { path: geminiPath, exists: fs.existsSync(geminiPath), size: 0 },
    ssh: { path: getSshPath(), exists: fs.existsSync(getSshPath()) },
    gitconfig: { path: getGitconfigPath(), exists: fs.existsSync(getGitconfigPath()) }
  };

  // Claude
  if (results.claude.exists) {
    try {
      results.claude.size = getDirInfo(claudePath).size;
      const configPath = getClaudeConfigPath();
      if (fs.existsSync(configPath)) results.claude.size += fs.statSync(configPath).size;
      results.claude.desktopConfigs.forEach(item => { results.claude.size += fs.statSync(item.path).size; });

      const projectsDir = pathMod.join(claudePath, 'projects');
      if (fs.existsSync(projectsDir)) {
        results.claude.projects = fs.readdirSync(projectsDir)
          .filter(p => fs.statSync(pathMod.join(projectsDir, p)).isDirectory())
          .map(p => {
            const files = fs.readdirSync(pathMod.join(projectsDir, p));
            const sessions = files.filter(f => f.endsWith('.jsonl')).length;
            results.claude.sessionsCount += sessions;
            return { key: p, sessions };
          });
      }
    } catch (e) { console.error(e); }
  }

  if (results.gemini.exists) {
    try { results.gemini.size = getDirInfo(geminiPath).size; } catch (e) { console.error(e); }
  }

  // Editors (VS Code + Antigravity IDE)
  for (const editor of editors) {
    const presentUserPaths = editor.userPaths.filter(p => fs.existsSync(p));
    let size = 0;
    presentUserPaths.forEach(p => { try { size += getDirInfo(p).size; } catch (e) {} });
    const extList = await listEditorExtensions(editor);
    const info = {
      id: editor.id, name: editor.name,
      exists: presentUserPaths.length > 0 || extList.length > 0,
      size, extensionsCount: extList.length, extensionsList: extList
    };
    results.editors.push(info);
    if (editor.id === 'vscode') {
      results.vscode = { path: editor.userPaths[0], exists: info.exists, size, extensionsCount: extList.length, extensionsList: extList };
    }
  }

  res.json(results);
});

// ---------------------------------------------------------------------------
// 2. Scan arbitrary workspace path
// ---------------------------------------------------------------------------
app.post('/api/scan-workspace', (req, res) => {
  const { workspacePath } = req.body;
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  const cleanPath = pathMod.resolve(workspacePath);
  if (!fs.existsSync(cleanPath)) return res.status(404).json({ error: 'Directory does not exist' });
  try {
    const info = getDirInfo(cleanPath);
    res.json({ path: cleanPath, name: pathMod.basename(cleanPath), size: info.size, files: info.fileCount, dirs: info.dirCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 3. Backup
// ---------------------------------------------------------------------------
app.post('/api/backup', async (req, res) => {
  const {
    includeClaude, includeClaudeCredentials,
    includeEditors,        // array of editor ids to back up (settings + extensions)
    includeGemini, includeSSH, includeGitconfig,
    customWorkspaces
  } = req.body;

  const editorIds = Array.isArray(includeEditors) ? includeEditors : [];
  const timestamp = Date.now();
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionTempDir = pathMod.join(tempDir, `backup_${timestamp}`);
  const finalZipPath = pathMod.join(backupsDir, `BridgeSync_${dateStr}.zip`);

  try {
    fs.mkdirSync(sessionTempDir, { recursive: true });
    sendLog(`Starting backup process... Temp dir: ${sessionTempDir}`, 'system');

    const manifest = {
      backupTime: new Date().toISOString(),
      sourceOS: os.platform(),
      sourceHost: os.hostname(),
      sourceUser: os.userInfo().username,
      sourceHome: os.homedir(),
      includesCredentials: false,
      contents: {
        claude: false,
        editors: [],   // [{ id, name, userIndices, extensions }]
        gemini: false,
        ssh: false,
        gitconfig: false,
        workspaces: []
      }
    };

    // --- Claude Code CLI ---
    if (includeClaude) {
      sendLog('Backing up Claude Code configurations and project files...', 'backup');
      const claudeSrc = getClaudePath();
      const claudeDest = pathMod.join(sessionTempDir, 'claude');
      if (fs.existsSync(claudeSrc)) {
        fs.mkdirSync(claudeDest, { recursive: true });
        const excludes = ['cache', 'downloads', 'paste-cache', 'telemetry'];
        if (!includeClaudeCredentials) {
          excludes.push('.credentials.json');
          sendLog('Excluding sensitive .credentials.json from backup.', 'backup');
        } else {
          manifest.includesCredentials = true;
          sendLog('WARNING: backup will contain plaintext .credentials.json (auth token). Keep the archive private.', 'warning');
        }
        fs.readdirSync(claudeSrc).forEach(file => {
          if (excludes.includes(file)) return;
          copyDirRecursive(pathMod.join(claudeSrc, file), pathMod.join(claudeDest, file));
        });

        const globalConfigSrc = getClaudeConfigPath();
        if (fs.existsSync(globalConfigSrc)) {
          sendLog('Backing up Claude Code global config & MCP servers (.claude.json)...', 'backup');
          fs.copyFileSync(globalConfigSrc, pathMod.join(sessionTempDir, 'claude.json'));
        }

        getClaudeDesktopConfigs().filter(i => fs.existsSync(i.path)).forEach(item => {
          sendLog(`Backing up Claude Desktop config for ${item.name}...`, 'backup');
          fs.copyFileSync(item.path, pathMod.join(sessionTempDir, `claude_desktop_${item.name}.json`));
        });

        manifest.contents.claude = true;
        sendLog('Claude Code data staged.', 'backup');
      }
    }

    // --- Editors: VS Code + Antigravity IDE ---
    for (const editor of getEditors()) {
      if (!editorIds.includes(editor.id)) continue;
      sendLog(`Backing up ${editor.name} settings & extensions...`, 'backup');
      const editorDestRoot = pathMod.join(sessionTempDir, 'editors', editor.id);
      const userIndices = [];

      editor.userPaths.forEach((userPath, idx) => {
        if (!fs.existsSync(userPath)) return;
        const dest = pathMod.join(editorDestRoot, `user_${idx}`);
        let copiedAny = false;
        EDITOR_USER_ITEMS.forEach(item => {
          const itemPath = pathMod.join(userPath, item);
          if (fs.existsSync(itemPath)) {
            copyDirRecursive(itemPath, pathMod.join(dest, item));
            copiedAny = true;
          }
        });
        if (copiedAny) userIndices.push(idx);
      });

      const extensions = await listEditorExtensions(editor);
      if (extensions.length) sendLog(`Found ${extensions.length} ${editor.name} extensions.`, 'backup');

      // Antigravity argv.json (per-IDE launch args) travels with the IDE.
      if (editor.id === 'antigravity-ide' && fs.existsSync(getAntigravityArgvPath())) {
        copyDirRecursive(getAntigravityArgvPath(), pathMod.join(editorDestRoot, 'argv.json'));
      }

      if (userIndices.length || extensions.length) {
        manifest.contents.editors.push({ id: editor.id, name: editor.name, userIndices, extensions });
        sendLog(`${editor.name} staged.`, 'backup');
      }
    }

    // --- Antigravity / Gemini CLI ---
    if (includeGemini) {
      sendLog('Backing up Antigravity / Gemini CLI configurations (~/.gemini)...', 'backup');
      const geminiSrc = getGeminiPath();
      const geminiDest = pathMod.join(sessionTempDir, 'gemini');
      if (fs.existsSync(geminiSrc)) {
        fs.mkdirSync(geminiDest, { recursive: true });
        fs.readdirSync(geminiSrc).forEach(file => {
          if (GEMINI_EXCLUDES.includes(file)) return;
          copyDirRecursive(pathMod.join(geminiSrc, file), pathMod.join(geminiDest, file), GEMINI_EXCLUDES);
        });
        manifest.contents.gemini = true;
        sendLog('Gemini CLI configurations staged.', 'backup');
      }
    }

    // --- SSH keys ---
    if (includeSSH) {
      const sshSrc = getSshPath();
      if (fs.existsSync(sshSrc)) {
        sendLog('Backing up SSH keys (~/.ssh)...', 'backup');
        copyDirRecursive(sshSrc, pathMod.join(sessionTempDir, 'ssh'));
        manifest.contents.ssh = true;
        manifest.includesCredentials = true;
        sendLog('WARNING: backup contains private SSH keys. Keep the archive private.', 'warning');
      }
    }

    // --- Global gitconfig ---
    if (includeGitconfig && fs.existsSync(getGitconfigPath())) {
      sendLog('Backing up global .gitconfig...', 'backup');
      fs.copyFileSync(getGitconfigPath(), pathMod.join(sessionTempDir, 'gitconfig'));
      manifest.contents.gitconfig = true;
    }

    // --- Custom workspaces ---
    if (customWorkspaces && customWorkspaces.length > 0) {
      const workspacesDest = pathMod.join(sessionTempDir, 'workspaces');
      fs.mkdirSync(workspacesDest, { recursive: true });
      for (const wPath of customWorkspaces) {
        if (fs.existsSync(wPath)) {
          const folderName = pathMod.basename(wPath);
          sendLog(`Staging workspace directory: ${folderName} (${wPath})`, 'backup');
          copyDirRecursive(wPath, pathMod.join(workspacesDest, folderName),
            ['node_modules', '.git', 'dist', 'build', '.next', '.codegraph']);
          manifest.contents.workspaces.push({ originalPath: wPath, folderName });
        } else {
          sendLog(`Workspace directory not found: ${wPath}`, 'warning');
        }
      }
    }

    fs.writeFileSync(pathMod.join(sessionTempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await zipDirectory(sessionTempDir, finalZipPath);

    sendLog('Cleaning up temporary workspace files...', 'system');
    fs.rmSync(sessionTempDir, { recursive: true, force: true });
    sendLog(`Backup completed! Save path: ${finalZipPath}`, 'success');

    res.json({ success: true, filename: pathMod.basename(finalZipPath), size: fs.statSync(finalZipPath).size, time: manifest.backupTime });
  } catch (e) {
    sendLog(`Backup failed: ${e.message}`, 'error');
    if (fs.existsSync(sessionTempDir)) fs.rmSync(sessionTempDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 4. Upload backup & parse manifest
// ---------------------------------------------------------------------------
let activeRestoreSession = null;

app.post('/api/restore-upload', upload.single('backupFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileInfo = req.file;
  const restoreTempPath = pathMod.join(tempDir, `restore_${Date.now()}`);
  try {
    fs.mkdirSync(restoreTempPath, { recursive: true });
    await unzipDirectory(fileInfo.path, restoreTempPath);

    const manifestPath = pathMod.join(restoreTempPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      fs.rmSync(restoreTempPath, { recursive: true, force: true });
      fs.unlinkSync(fileInfo.path);
      return res.status(400).json({ error: 'Invalid backup file: manifest.json is missing.' });
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    activeRestoreSession = { tempPath: restoreTempPath, zipPath: fileInfo.path, manifest };
    res.json({ success: true, manifest });
  } catch (e) {
    sendLog(`Failed to parse restore upload: ${e.message}`, 'error');
    if (fs.existsSync(restoreTempPath)) fs.rmSync(restoreTempPath, { recursive: true, force: true });
    if (fs.existsSync(fileInfo.path)) fs.unlinkSync(fileInfo.path);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 5. Confirm & execute restore (non-destructive)
// ---------------------------------------------------------------------------
function snapshotExisting(snapshotDir) {
  // Copy the target machine's current config so the user can roll back.
  sendLog(`Snapshotting existing target config to ${pathMod.basename(snapshotDir)}/ before restore...`, 'system');
  const targets = [];
  if (fs.existsSync(getClaudePath())) targets.push({ src: getClaudePath(), dest: 'claude' });
  if (fs.existsSync(getClaudeConfigPath())) targets.push({ src: getClaudeConfigPath(), dest: 'claude.json' });
  if (fs.existsSync(getGeminiPath())) targets.push({ src: getGeminiPath(), dest: 'gemini' });
  if (fs.existsSync(getGitconfigPath())) targets.push({ src: getGitconfigPath(), dest: 'gitconfig' });
  getClaudeDesktopConfigs().filter(i => fs.existsSync(i.path)).forEach(i => targets.push({ src: i.path, dest: `claude_desktop_${i.name}.json` }));
  getEditors().forEach(ed => ed.userPaths.forEach((p, idx) => {
    if (fs.existsSync(p)) targets.push({ src: p, dest: pathMod.join('editors', ed.id, `user_${idx}`) });
  }));

  const heavy = ['cache', 'downloads', 'paste-cache', 'telemetry', 'workspaceStorage', 'globalStorage', 'History', 'node_modules'];
  targets.forEach(t => {
    try { copyDirRecursive(t.src, pathMod.join(snapshotDir, t.dest), heavy); }
    catch (e) { sendLog(`Snapshot skipped ${t.dest}: ${e.message}`, 'warning'); }
  });
}

app.post('/api/restore-confirm', async (req, res) => {
  if (!activeRestoreSession) return res.status(400).json({ error: 'No active restore session. Upload the zip file first.' });
  const { pathMapping } = req.body;
  const { tempPath, zipPath, manifest } = activeRestoreSession;
  const c = manifest.contents;
  const skippedNotes = [];

  try {
    sendLog('Initiating non-destructive restoration...', 'system');

    // Snapshot current target config for rollback.
    const snapshotDir = pathMod.join(backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    snapshotExisting(snapshotDir);

    // Build the full set of old->new mappings: per-workspace mappings plus an
    // implicit home-dir remap so untracked project histories also resolve.
    const mappings = {};
    Object.keys(pathMapping || {}).forEach(k => { if (pathMapping[k]) mappings[k] = pathMapping[k]; });
    if (manifest.sourceHome && manifest.sourceHome !== os.homedir()) {
      mappings[manifest.sourceHome] = os.homedir();
    }

    // --- Workspaces (skip-existing so target files are never clobbered) ---
    if (c.workspaces && c.workspaces.length) {
      for (const w of c.workspaces) {
        const targetPath = (pathMapping || {})[w.originalPath];
        if (!targetPath) { sendLog(`Skipping workspace ${w.folderName} (no path mapped).`, 'restore'); continue; }
        const sourceFolder = pathMod.join(tempPath, 'workspaces', w.folderName);
        if (fs.existsSync(sourceFolder)) {
          sendLog(`Restoring workspace ${w.folderName} -> ${targetPath} (existing files preserved)`, 'restore');
          copyDirSkipExisting(sourceFolder, targetPath);
        }
      }
    }

    // --- Claude Code CLI ---
    if (c.claude) {
      sendLog('Restoring Claude Code configurations and history...', 'restore');
      const claudeDest = getClaudePath();
      const claudeSource = pathMod.join(tempPath, 'claude');
      if (!fs.existsSync(claudeDest)) fs.mkdirSync(claudeDest, { recursive: true });

      // Everything except projects/, copied without overwriting existing files.
      fs.readdirSync(claudeSource).forEach(item => {
        if (item === 'projects') return;
        copyDirSkipExisting(pathMod.join(claudeSource, item), pathMod.join(claudeDest, item));
      });

      // Global .claude.json (MCP servers) -> path-rewrite then merge target-wins.
      const backedConfig = pathMod.join(tempPath, 'claude.json');
      if (fs.existsSync(backedConfig)) {
        sendLog('Merging Claude Code global config & MCP servers (.claude.json)...', 'restore');
        const rewritten = rewritePaths(fs.readFileSync(backedConfig, 'utf8'), mappings);
        mergeJsonIntoTarget(rewritten, getClaudeConfigPath());
      }

      // Claude Desktop configs -> path-rewrite then merge target-wins.
      getClaudeDesktopConfigs().forEach(dest => {
        const backedDesk = pathMod.join(tempPath, `claude_desktop_${dest.name}.json`);
        if (fs.existsSync(backedDesk)) {
          sendLog(`Merging Claude Desktop config for ${dest.name}...`, 'restore');
          const rewritten = rewritePaths(fs.readFileSync(backedDesk, 'utf8'), mappings);
          mergeJsonIntoTarget(rewritten, dest.path);
        }
      });

      // Projects: remap folder keys + rewrite in-file paths, skip-existing.
      restoreProjects(pathMod.join(claudeSource, 'projects'), pathMod.join(claudeDest, 'projects'), mappings, c.workspaces || [], pathMapping || {});
      sendLog('Claude Code data restored.', 'success');
    }

    // --- Editors: VS Code + Antigravity IDE ---
    if (c.editors && c.editors.length) {
      const editorMap = {};
      getEditors().forEach(e => { editorMap[e.id] = e; });
      for (const saved of c.editors) {
        const editor = editorMap[saved.id];
        if (!editor) { sendLog(`Unknown editor in backup: ${saved.id}, skipped.`, 'warning'); continue; }
        sendLog(`Restoring ${saved.name} settings & extensions...`, 'restore');

        (saved.userIndices || []).forEach(idx => {
          const srcUser = pathMod.join(tempPath, 'editors', saved.id, `user_${idx}`);
          const destUser = editor.userPaths[idx];
          if (!fs.existsSync(srcUser) || !destUser) return;
          EDITOR_USER_ITEMS.forEach(item => {
            const srcItem = pathMod.join(srcUser, item);
            if (!fs.existsSync(srcItem)) return;
            if (item === 'settings.json') {
              mergeJsonIntoTarget(fs.readFileSync(srcItem, 'utf8'), pathMod.join(destUser, item));
            } else {
              // keybindings.json (array) and snippets: skip-if-exists.
              copyDirSkipExisting(srcItem, pathMod.join(destUser, item));
            }
          });
        });

        const argvSrc = pathMod.join(tempPath, 'editors', saved.id, 'argv.json');
        if (saved.id === 'antigravity-ide' && fs.existsSync(argvSrc)) {
          copyDirSkipExisting(argvSrc, getAntigravityArgvPath());
        }

        installEditorExtensions(editor, saved.extensions || []);
      }
    }

    // --- Antigravity / Gemini CLI ---
    if (c.gemini) {
      sendLog('Restoring Antigravity / Gemini CLI configurations...', 'restore');
      const geminiDest = getGeminiPath();
      const geminiSource = pathMod.join(tempPath, 'gemini');
      if (fs.existsSync(geminiSource)) {
        if (!fs.existsSync(geminiDest)) fs.mkdirSync(geminiDest, { recursive: true });
        fs.readdirSync(geminiSource).forEach(item => {
          if (item === 'projects.json') return; // merged separately below
          copyDirSkipExisting(pathMod.join(geminiSource, item), pathMod.join(geminiDest, item), GEMINI_EXCLUDES);
        });
        const projectsJsonSrc = pathMod.join(geminiSource, 'projects.json');
        if (fs.existsSync(projectsJsonSrc)) {
          const rewritten = rewritePaths(fs.readFileSync(projectsJsonSrc, 'utf8'), mappings);
          mergeJsonIntoTarget(rewritten, pathMod.join(geminiDest, 'projects.json'));
        }
        sendLog('Gemini CLI configurations restored.', 'success');
      }
    }

    // --- SSH keys (never overwrite an existing key/known_hosts) ---
    if (c.ssh) {
      const sshSource = pathMod.join(tempPath, 'ssh');
      if (fs.existsSync(sshSource)) {
        sendLog('Restoring SSH keys (existing files preserved)...', 'restore');
        copyDirSkipExisting(sshSource, getSshPath());
        skippedNotes.push('SSH keys restored to ~/.ssh. On macOS/Linux run: chmod 600 ~/.ssh/* on private keys.');
      }
    }

    // --- Global gitconfig (skip if target already has one) ---
    if (c.gitconfig) {
      const gitSrc = pathMod.join(tempPath, 'gitconfig');
      if (fs.existsSync(gitSrc)) {
        if (fs.existsSync(getGitconfigPath())) {
          skippedNotes.push('~/.gitconfig already existed on this machine and was left untouched. Compare manually if needed.');
          sendLog('~/.gitconfig exists on target; preserved.', 'restore');
        } else {
          fs.copyFileSync(gitSrc, getGitconfigPath());
          sendLog('Global .gitconfig restored.', 'restore');
        }
      }
    }

    writeMigrationNotes(manifest, snapshotDir, skippedNotes);

    sendLog('Cleaning up restore cache...', 'system');
    fs.rmSync(tempPath, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    activeRestoreSession = null;

    sendLog('Restoration completed (non-destructive).', 'success');
    res.json({ success: true, snapshot: snapshotDir });
  } catch (e) {
    sendLog(`Restoration failed: ${e.message}`, 'error');
    res.status(500).json({ error: e.message });
  }
});

// Restore Claude project folders: remap folder keys + rewrite in-file paths.
function restoreProjects(projectsSource, projectsDest, mappings, workspaces, pathMapping) {
  if (!fs.existsSync(projectsSource)) return;
  if (!fs.existsSync(projectsDest)) fs.mkdirSync(projectsDest, { recursive: true });

  // Reverse map: project-key -> original absolute path (from workspaces).
  const keyToOriginal = {};
  workspaces.forEach(w => { keyToOriginal[pathToProjectKey(w.originalPath).toLowerCase()] = w.originalPath; });

  fs.readdirSync(projectsSource).forEach(oldKey => {
    let newKey = oldKey;
    // Rename the folder key when its source path is being remapped.
    const original = keyToOriginal[oldKey.toLowerCase()];
    if (original && pathMapping[original]) {
      newKey = pathToProjectKey(pathMapping[original]);
      sendLog(`Mapping Claude project key: ${oldKey} -> ${newKey}`, 'restore');
    } else if (manifestHomeKeyRemap(oldKey, mappings)) {
      newKey = manifestHomeKeyRemap(oldKey, mappings);
      sendLog(`Remapping project key by home dir: ${oldKey} -> ${newKey}`, 'restore');
    } else {
      sendLog(`Untracked Claude project folder kept as-is: ${oldKey}`, 'restore');
    }

    const srcPath = pathMod.join(projectsSource, oldKey);
    const dstPath = pathMod.join(projectsDest, newKey);
    copyDirSkipExisting(srcPath, dstPath);
    rewriteProjectFiles(dstPath, mappings);
  });
}

// If a project key embeds the source home dir, rewrite it to the target home key.
function manifestHomeKeyRemap(oldKey, mappings) {
  for (const oldPath of Object.keys(mappings)) {
    const oldPk = pathToProjectKey(oldPath);
    if (oldKey.toLowerCase().startsWith(oldPk.toLowerCase())) {
      return pathToProjectKey(mappings[oldPath]) + oldKey.slice(oldPk.length);
    }
  }
  return null;
}

// Rewrite path references inside a project's session logs and memory files.
function rewriteProjectFiles(dir, mappings) {
  if (!Object.keys(mappings).length) return;
  fs.readdirSync(dir).forEach(file => {
    const filePath = pathMod.join(dir, file);
    let stats;
    try { stats = fs.statSync(filePath); } catch (e) { return; }

    if (stats.isDirectory() && file === 'memory') {
      fs.readdirSync(filePath).forEach(memFile => {
        const memPath = pathMod.join(filePath, memFile);
        if (fs.statSync(memPath).isFile() && memFile.endsWith('.md')) {
          fs.writeFileSync(memPath, rewritePaths(fs.readFileSync(memPath, 'utf8'), mappings), 'utf8');
        }
      });
    } else if (stats.isFile() && file.endsWith('.jsonl')) {
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
        } catch (e) {
          return rewritePaths(line, mappings);
        }
      });
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    }
  });
}

// Install only extensions the target editor is missing.
function installEditorExtensions(editor, wanted) {
  if (!wanted.length) return;
  exec(`${editor.cli} --list-extensions`, (err, stdout) => {
    const installed = (!err && stdout) ? new Set(stdout.split('\n').map(x => x.trim().toLowerCase()).filter(Boolean)) : new Set();
    const missing = wanted.filter(ext => !installed.has(ext.toLowerCase()));
    if (!missing.length) { sendLog(`${editor.name}: all ${wanted.length} extensions already installed.`, 'restore'); return; }
    sendLog(`${editor.name}: installing ${missing.length} missing extensions via '${editor.cli}'...`, 'restore');
    missing.forEach(ext => {
      exec(`${editor.cli} --install-extension ${ext}`, (e) => {
        if (e) sendLog(`${editor.name}: failed to install ${ext} (CLI '${editor.cli}' unreachable?).`, 'warning');
        else sendLog(`${editor.name}: installed ${ext}`, 'restore');
      });
    });
  });
}

// Write a human-readable checklist of what could not be migrated automatically.
function writeMigrationNotes(manifest, snapshotDir, skippedNotes) {
  const lines = [];
  lines.push('BridgeSync Migration Notes');
  lines.push('==========================');
  lines.push(`Restored: ${new Date().toISOString()}`);
  lines.push(`Source: ${manifest.sourceHost} (${manifest.sourceUser}, ${manifest.sourceOS})`);
  lines.push(`Pre-restore snapshot of THIS machine's previous config: ${snapshotDir}`);
  lines.push('');
  lines.push('Restore was NON-DESTRUCTIVE: existing files on this machine were kept;');
  lines.push('JSON configs were merged with your existing values winning on conflicts.');
  lines.push('');
  if (skippedNotes.length) {
    lines.push('Notes from this restore:');
    skippedNotes.forEach(n => lines.push(`  - ${n}`));
    lines.push('');
  }
  lines.push('Manual steps NOT handled automatically:');
  lines.push('  - Install runtimes/CLIs: Node.js, VS Code `code` CLI, Antigravity `antigravity` CLI, gh.');
  lines.push('  - Install RTK (rtk) and re-enable its Claude Code hook if you use it.');
  lines.push('  - Rebuild per-project CodeGraph indexes (.codegraph was excluded): run `codegraph init -i`.');
  lines.push('  - Re-login where tokens were not migrated (Claude Code/Desktop, extension auth, gh auth login).');
  lines.push('  - Editor globalStorage/workspaceStorage were NOT migrated (machine/path-specific).');
  if (manifest.includesCredentials) {
    lines.push('  - This backup contained secrets (credentials/SSH keys). Delete the .zip when done.');
  }
  const notesPath = pathMod.join(os.homedir(), 'BridgeSync-MIGRATION-NOTES.txt');
  try {
    fs.writeFileSync(notesPath, lines.join('\n'), 'utf8');
    sendLog(`Migration notes written to: ${notesPath}`, 'success');
  } catch (e) {
    sendLog(`Could not write migration notes: ${e.message}`, 'warning');
  }
}

app.listen(port, '127.0.0.1', () => {
  console.log(`BridgeSync local backend listening at http://127.0.0.1:${port}`);
});

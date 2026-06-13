// 全局状态
const state = {
  os: '', hostname: '', username: '', home: '',
  tools: [],
  addedWorkspaces: [],
  activeUploadManifest: null
};

const CATEGORY_LABEL = {
  editor: '编辑器',
  extension: '扩展型 Agent',
  cli: 'CLI Agent',
  standalone: '独立编辑器',
  keys: '密钥 / 配置'
};

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  connectSSE();
  detectEnvironment();
  initBackupTab();
  initRestoreTab();
});

// ---------------------------------------------------------------------------
// SSE 终端
// ---------------------------------------------------------------------------
function connectSSE() {
  const consoleEl = document.getElementById('terminal-console');
  const pulseEl = document.querySelector('.pulse-indicator');
  const es = new EventSource('/api/logs');
  es.onopen = () => { pulseEl.style.display = 'block'; };
  es.onmessage = (e) => { const d = JSON.parse(e.data); appendTerminalLine(d.message, d.type); };
  es.onerror = () => { pulseEl.style.display = 'none'; };
  document.getElementById('btn-clear-terminal').addEventListener('click', () => {
    consoleEl.innerHTML = '<div class="term-line system">日志已清空。</div>';
  });
}

function appendTerminalLine(text, type = 'info') {
  const consoleEl = document.getElementById('terminal-console');
  const line = document.createElement('div');
  line.className = `term-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const panes = document.querySelectorAll('.tab-pane');
  const pageTitle = document.getElementById('page-title');
  const pageDesc = document.getElementById('page-desc');
  const tabInfo = {
    dashboard: { title: '迁移总览', desc: '检测本机已安装的 AI 工具与配置。' },
    backup: { title: '备份', desc: '打包压缩配置、会话与项目目录。' },
    restore: { title: '还原', desc: '解包备份、自动重装扩展、映射工作区路径。' },
    logs: { title: '运行日志', desc: '系统与任务过程的实时输出。' }
  };
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-tab');
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      panes.forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tabId}`).classList.add('active');
      if (tabInfo[tabId]) { pageTitle.textContent = tabInfo[tabId].title; pageDesc.textContent = tabInfo[tabId].desc; }
    });
  });
}

function switchTab(tabId) {
  const btn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (btn) btn.click();
}

// ---------------------------------------------------------------------------
// 环境检测
// ---------------------------------------------------------------------------
async function detectEnvironment() {
  try {
    appendTerminalLine('正在扫描本机 AI 工具…', 'system');
    const res = await fetch('/api/detect');
    const data = await res.json();
    state.os = data.os; state.hostname = data.hostname; state.username = data.username; state.home = data.home;
    state.tools = data.tools || [];

    document.getElementById('system-os-name').textContent = `${data.os} (${data.hostname})`;
    document.getElementById('system-user-name').textContent = data.username;
    document.getElementById('system-host-name').textContent = data.hostname;

    renderDashboard();
    renderBackupTools();
    recalculateTotalBackupSize();
    const n = state.tools.filter(t => t.exists).length;
    appendTerminalLine(`扫描完成，检测到 ${n} 个工具。`, 'success');
  } catch (e) {
    appendTerminalLine(`扫描失败：${e.message}`, 'error');
  }
}

function detectedTools() { return state.tools.filter(t => t.exists); }

// ---------------------------------------------------------------------------
// 仪表盘：按检测结果渲染卡片
// ---------------------------------------------------------------------------
function renderDashboard() {
  const grid = document.getElementById('dashboard-tools');
  const tools = detectedTools();
  grid.innerHTML = '';
  if (!tools.length) {
    grid.innerHTML = '<div class="glass-card stat-card"><div class="stat-value">未检测到工具</div></div>';
    return;
  }
  tools.forEach(t => {
    const card = document.createElement('div');
    card.className = 'glass-card stat-card glow-blue';
    const ext = t.extCount ? `<div class="detail-item"><span class="lbl">扩展数</span><span class="val">${t.extCount}</span></div>` : '';
    card.innerHTML = `
      <div class="card-header">
        <h3>${escapeHtml(t.name)} ${t.secret ? '🔒' : ''}</h3>
      </div>
      <div class="stat-value">${formatBytes(t.size)}</div>
      <div class="stat-details">
        <div class="detail-item"><span class="lbl">类型</span><span class="val">${CATEGORY_LABEL[t.category] || t.category}</span></div>
        ${ext}
      </div>
      <div class="card-status-bar">已检测</div>`;
    grid.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// 备份：动态勾选项
// ---------------------------------------------------------------------------
function renderBackupTools() {
  const wrap = document.getElementById('backup-tools-list');
  const tools = detectedTools();
  wrap.innerHTML = '';
  if (!tools.length) { wrap.innerHTML = '<div class="empty-row">未检测到任何可备份的工具。</div>'; return; }

  // 按类别分组
  const groups = {};
  tools.forEach(t => { (groups[t.category] = groups[t.category] || []).push(t); });

  Object.keys(groups).forEach(cat => {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.textContent = CATEGORY_LABEL[cat] || cat;
    header.style.cssText = 'grid-column:1/-1; color:#94a3b8; font-size:12px; font-weight:600; margin:6px 0 2px;';
    wrap.appendChild(header);

    groups[cat].forEach(t => {
      const label = document.createElement('label');
      label.className = 'option-checkbox-card';
      const sizeStr = formatBytes(t.size);
      const extStr = t.extCount ? ` · ${t.extCount} 扩展` : '';
      label.innerHTML = `
        <input type="checkbox" class="chk-tool" value="${escapeHtml(t.id)}" ${t.secret ? '' : 'checked'}>
        <div class="card-content">
          <span class="title">${escapeHtml(t.name)} ${t.secret ? '🔒' : ''}</span>
          <p class="desc">${sizeStr}${extStr}${t.secret ? ' · 含私密数据，默认不勾选' : ''}</p>
        </div>`;
      label.querySelector('input').addEventListener('change', recalculateTotalBackupSize);
      wrap.appendChild(label);
    });
  });
}

function checkedToolIds() {
  return Array.from(document.querySelectorAll('.chk-tool:checked')).map(i => i.value);
}

function recalculateTotalBackupSize() {
  let size = 0;
  const ids = new Set(checkedToolIds());
  state.tools.forEach(t => { if (ids.has(t.id)) size += t.size; });
  state.addedWorkspaces.forEach(w => { size += w.size; });
  const el = document.getElementById('backup-total-size');
  if (el) el.textContent = formatBytes(size);
}

function initBackupTab() {
  const addBtn = document.getElementById('btn-add-workspace');
  const pathInput = document.getElementById('txt-workspace-path');
  const executeBtn = document.getElementById('btn-execute-backup');

  addBtn.addEventListener('click', async () => {
    const wPath = pathInput.value.trim();
    if (!wPath) return alert('请输入目录路径。');
    addBtn.disabled = true; addBtn.textContent = '扫描中…';
    appendTerminalLine(`正在扫描工作区路径：${wPath}`, 'system');
    try {
      const res = await fetch('/api/scan-workspace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: wPath })
      });
      const data = await res.json();
      if (res.ok) {
        if (state.addedWorkspaces.find(x => x.path === data.path)) alert('该工作区已添加。');
        else {
          state.addedWorkspaces.push(data);
          renderWorkspacesTable(); recalculateTotalBackupSize(); pathInput.value = '';
          appendTerminalLine(`已添加工作区：${data.name}（${formatBytes(data.size)}）`, 'success');
        }
      } else { alert(`扫描失败：${data.error}`); appendTerminalLine(`工作区扫描错误：${data.error}`, 'error'); }
    } catch (e) { alert(`扫描目录出错：${e.message}`); }
    finally { addBtn.disabled = false; addBtn.textContent = '扫描并添加目录'; }
  });

  executeBtn.addEventListener('click', async () => {
    const selectedTools = checkedToolIds();
    const includeSecrets = document.getElementById('chk-include-secrets').checked;
    const customWorkspaces = state.addedWorkspaces.map(w => w.path);
    if (!selectedTools.length && !customWorkspaces.length) return alert('请至少选择一个工具或工作区。');

    // 是否含私密：勾了 secret 工具 或 勾了 includeSecrets
    const secretTools = state.tools.filter(t => t.secret && selectedTools.includes(t.id));
    if (includeSecrets || secretTools.length) {
      if (!confirm('本次备份将把私密数据（凭证/令牌/SSH 私钥等）以明文打包进 .zip。请确保妥善保管。确认继续？')) return;
    }

    executeBtn.disabled = true; executeBtn.textContent = '备份中…'; switchTab('logs');
    try {
      const res = await fetch('/api/backup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedTools, includeSecrets, customWorkspaces })
      });
      const data = await res.json();
      if (res.ok) alert(`备份压缩包已生成！\n文件名：${data.filename}\n体积：${formatBytes(data.size)}`);
      else alert(`备份失败：${data.error}`);
    } catch (e) { alert(`备份过程中网络错误：${e.message}`); }
    finally { executeBtn.disabled = false; executeBtn.textContent = '生成备份压缩包'; }
  });
}

function renderWorkspacesTable() {
  const tbody = document.getElementById('workspaces-list');
  tbody.innerHTML = '';
  if (!state.addedWorkspaces.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">尚未添加工作区。</td></tr>';
    return;
  }
  state.addedWorkspaces.forEach((w, idx) => {
    const tr = document.createElement('tr');
    const tdPath = document.createElement('td'); tdPath.textContent = w.path; tr.appendChild(tdPath);
    const tdCount = document.createElement('td'); tdCount.textContent = w.files; tr.appendChild(tdCount);
    const tdSize = document.createElement('td'); tdSize.textContent = formatBytes(w.size); tr.appendChild(tdSize);
    const tdAction = document.createElement('td');
    const del = document.createElement('button'); del.className = 'delete-btn'; del.textContent = '删除';
    del.addEventListener('click', () => { state.addedWorkspaces.splice(idx, 1); renderWorkspacesTable(); recalculateTotalBackupSize(); });
    tdAction.appendChild(del); tr.appendChild(tdAction);
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// 还原
// ---------------------------------------------------------------------------
function initRestoreTab() {
  const dropzone = document.getElementById('restore-dropzone');
  const fileInput = document.getElementById('file-restore-upload');
  const confirmBtn = document.getElementById('btn-execute-restore');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#3b82f6'; dropzone.style.backgroundColor = 'rgba(59,130,246,0.05)'; });
  dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'rgba(255,255,255,0.1)'; dropzone.style.backgroundColor = 'transparent'; });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); dropzone.style.borderColor = 'rgba(255,255,255,0.1)'; dropzone.style.backgroundColor = 'transparent';
    if (e.dataTransfer.files.length) handleRestoreUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) handleRestoreUpload(fileInput.files[0]); });

  confirmBtn.addEventListener('click', async () => {
    if (!state.activeUploadManifest) return;
    const pathMapping = {};
    document.querySelectorAll('.mapping-path-input').forEach(input => {
      pathMapping[input.getAttribute('data-original')] = input.value.trim();
    });
    confirmBtn.disabled = true; confirmBtn.textContent = '还原中…'; switchTab('logs');
    try {
      const res = await fetch('/api/restore-confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pathMapping })
      });
      const data = await res.json();
      if (res.ok) {
        alert('还原完成！请查看 home 目录下的 BridgeSync-MIGRATION-NOTES.txt 了解收尾步骤。');
        detectEnvironment();
        document.getElementById('restore-configurator').style.display = 'none';
        dropzone.style.display = 'block';
        state.activeUploadManifest = null;
      } else alert(`还原失败：${data.error}`);
    } catch (e) { alert(`还原过程中网络错误：${e.message}`); }
    finally { confirmBtn.disabled = false; confirmBtn.textContent = '开始还原'; }
  });
}

async function handleRestoreUpload(file) {
  appendTerminalLine(`正在上传备份压缩包：${file.name}（${formatBytes(file.size)}）…`, 'system');
  const formData = new FormData();
  formData.append('backupFile', file);
  try {
    const res = await fetch('/api/restore-upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      state.activeUploadManifest = data.manifest;
      renderRestoreConfigurator(data.manifest);
      appendTerminalLine('备份文件解析成功，请在下方配置路径映射。', 'success');
    } else { alert(`解析备份 ZIP 失败：${data.error}`); appendTerminalLine(`上传备份出错：${data.error}`, 'error'); }
  } catch (e) { alert(`上传备份过程中网络错误：${e.message}`); }
}

function renderRestoreConfigurator(manifest) {
  const configSection = document.getElementById('restore-configurator');
  const dropzone = document.getElementById('restore-dropzone');

  document.getElementById('restore-meta-date').textContent = new Date(manifest.backupTime).toLocaleString();
  document.getElementById('restore-meta-os').textContent = manifest.sourceOS;
  document.getElementById('restore-meta-host').textContent = manifest.sourceHost;
  document.getElementById('restore-meta-user').textContent = manifest.sourceUser;

  // 动态还原清单：按 manifest.tools
  const checklist = document.getElementById('restore-checklist');
  checklist.innerHTML = '';
  (manifest.tools || []).forEach(t => {
    const extItem = (t.items || []).find(it => it.kind === 'editorExtensions');
    const extStr = extItem ? `（${extItem.extensions.length} 扩展）` : '';
    const li = document.createElement('li');
    li.innerHTML = `<div class="dot checked"></div><span>${escapeHtml(t.name)}${extStr}${t.secret ? ' 🔒' : ''}</span>`;
    checklist.appendChild(li);
  });
  if (manifest.workspaces && manifest.workspaces.length) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="dot checked"></div><span>工作区目录（${manifest.workspaces.length}）</span>`;
    checklist.appendChild(li);
  }
  if (!checklist.children.length) {
    checklist.innerHTML = '<li><span style="color:#64748b;">此备份不含可还原内容。</span></li>';
  }

  // 路径映射：仅工作区需要用户填
  const tbody = document.getElementById('path-mappings-list');
  tbody.innerHTML = '';
  (manifest.workspaces || []).forEach(w => {
    const tr = document.createElement('tr');
    const tdOrig = document.createElement('td');
    tdOrig.innerHTML = `<span class="comp-badge wsp">工作区</span><br>${escapeHtml(w.originalPath)}`;
    tr.appendChild(tdOrig);
    const tdTarget = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'mapping-path-input';
    input.setAttribute('data-original', w.originalPath);
    let guessed = w.originalPath;
    if (state.os === 'win32' && w.originalPath.includes('/')) guessed = 'C:\\Projects\\' + w.folderName;
    else if (state.os !== 'win32' && w.originalPath.includes('\\')) guessed = '/Users/' + state.username + '/projects/' + w.folderName;
    input.value = guessed;
    tdTarget.appendChild(input); tr.appendChild(tdTarget);
    tbody.appendChild(tr);
  });
  if (!tbody.children.length) {
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center; color:#64748b;">本次还原无需配置目录映射（工具配置会还原到各自标准位置）。</td></tr>';
  }

  dropzone.style.display = 'none';
  configSection.style.display = 'block';
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0.00 B';
  const k = 1024, dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

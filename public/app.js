// Global application state
const state = {
  os: '',
  hostname: '',
  username: '',
  claude: null,
  vscode: null,
  gemini: null,
  addedWorkspaces: [],
  activeUploadManifest: null
};

// Initialize app when DOM loaded
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  connectSSE();
  detectEnvironment();
  initBackupTab();
  initRestoreTab();
  initModals();
});

// Real-time terminal connection via Server-Sent Events (SSE)
function connectSSE() {
  const consoleEl = document.getElementById('terminal-console');
  const pulseEl = document.querySelector('.pulse-indicator');
  const eventSource = new EventSource('/api/logs');

  eventSource.onopen = () => {
    pulseEl.style.display = 'block';
  };

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    appendTerminalLine(data.message, data.type);
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    pulseEl.style.display = 'none';
  };

  // Clear console action
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

// Tab navigation handler
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const panes = document.querySelectorAll('.tab-pane');
  const pageTitle = document.getElementById('page-title');
  const pageDesc = document.getElementById('page-desc');

  const tabInfo = {
    dashboard: { title: '迁移总览', desc: '系统配置状态与环境检测。' },
    backup: { title: '备份', desc: '打包压缩配置、设置与项目目录。' },
    restore: { title: '还原', desc: '解包备份、自动重装扩展、映射工作区路径。' },
    logs: { title: '运行日志', desc: '系统与任务过程的实时输出。' }
  };

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-tab');

      // Update Nav Class
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      // Update Panes
      panes.forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tabId}`).classList.add('active');

      // Update Header
      if (tabInfo[tabId]) {
        pageTitle.textContent = tabInfo[tabId].title;
        pageDesc.textContent = tabInfo[tabId].desc;
      }
    });
  });
}

// Switch to a specific tab programmatically
function switchTab(tabId) {
  const tabBtn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (tabBtn) tabBtn.click();
}

// Fetch environment settings
async function detectEnvironment() {
  try {
    appendTerminalLine('正在扫描主机配置环境…', 'system');
    const res = await fetch('/api/detect');
    const data = await res.json();

    state.os = data.os;
    state.hostname = data.hostname;
    state.username = data.username;
    state.home = data.home;
    state.claude = data.claude;
    state.vscode = data.vscode;
    state.editors = data.editors || [];
    state.gemini = data.gemini;
 
    // Populate Sidebar
    document.getElementById('system-os-name').textContent = `${data.os} (${data.hostname})`;
    document.getElementById('system-user-name').textContent = data.username;
    document.getElementById('system-host-name').textContent = data.hostname;
 
    // Populate Dashboard
    if (data.claude.exists) {
      document.getElementById('dash-claude-size').textContent = formatBytes(data.claude.size);
      document.getElementById('dash-claude-projects').textContent = data.claude.projects.length;
      document.getElementById('dash-claude-sessions').textContent = data.claude.sessionsCount;
    } else {
      document.getElementById('dash-claude-size').textContent = '未找到';
      document.getElementById('dash-claude-status').textContent = '未启用';
      document.getElementById('dash-claude-status').style.color = '#ef4444';
    }

    if (data.vscode.exists) {
      document.getElementById('dash-vscode-size').textContent = formatBytes(data.vscode.size);
    } else {
      document.getElementById('dash-vscode-size').textContent = '未找到';
      document.getElementById('dash-vscode-status').textContent = '未启用';
      document.getElementById('dash-vscode-status').style.color = '#ef4444';
    }

    if (data.gemini.exists) {
      document.getElementById('dash-gemini-size').textContent = formatBytes(data.gemini.size);
    } else {
      document.getElementById('dash-gemini-size').textContent = '未找到';
      document.getElementById('dash-gemini-status').textContent = '未启用';
      document.getElementById('dash-gemini-status').style.color = '#ef4444';
    }

    document.getElementById('dash-extensions-count').textContent = data.vscode.extensionsCount;

    // Check code accessibility
    const cliCheck = document.getElementById('check-cli-accessible');
    if (data.vscode.extensionsCount > 0) {
      cliCheck.classList.add('checked');
      cliCheck.nextElementSibling.textContent = "VS Code 命令行 'code' 可用";
    } else {
      cliCheck.classList.remove('checked');
      cliCheck.nextElementSibling.textContent = "VS Code 命令行 'code' 不可用";
    }

    updateDashboardChart();
    recalculateTotalBackupSize();
    appendTerminalLine('环境扫描完成。', 'success');

  } catch (e) {
    appendTerminalLine(`环境扫描失败：${e.message}`, 'error');
  }
}

// Update the SVG Donut chart
function updateDashboardChart() {
  const claudeSize = state.claude ? state.claude.size : 0;
  const vscodeSize = state.vscode ? state.vscode.size : 0;
  const geminiSize = state.gemini ? state.gemini.size : 0;
  const total = claudeSize + vscodeSize + geminiSize;
 
  document.getElementById('legend-claude-val').textContent = formatBytes(claudeSize);
  document.getElementById('legend-vscode-val').textContent = formatBytes(vscodeSize);
  document.getElementById('legend-gemini-val').textContent = formatBytes(geminiSize);
 
  const claudeSeg = document.getElementById('chart-claude-segment');
  const vscodeSeg = document.getElementById('chart-vscode-segment');
  const geminiSeg = document.getElementById('chart-gemini-segment');
 
  if (total === 0) {
    claudeSeg.style.strokeDashoffset = '440';
    vscodeSeg.style.strokeDashoffset = '440';
    geminiSeg.style.strokeDashoffset = '440';
    return;
  }
 
  const claudePct = claudeSize / total;
  const vscodePct = vscodeSize / total;
  const geminiPct = geminiSize / total;
 
  const circumference = 440; // 2 * pi * r (r=70)
  
  // Calculate offsets
  const claudeOffset = circumference * (1 - claudePct);
  const vscodeOffset = circumference * (1 - vscodePct);
  const geminiOffset = circumference * (1 - geminiPct);

  const vscodeRotate = claudePct * 360;
  const geminiRotate = (claudePct + vscodePct) * 360;
 
  claudeSeg.style.strokeDashoffset = claudeOffset;
  
  vscodeSeg.style.strokeDashoffset = vscodeOffset;
  vscodeSeg.setAttribute('transform', `rotate(${vscodeRotate} 100 100)`);

  geminiSeg.style.strokeDashoffset = geminiOffset;
  geminiSeg.setAttribute('transform', `rotate(${geminiRotate} 100 100)`);
}

// Recalculate total estimated backup size
function recalculateTotalBackupSize() {
  let size = 0;

  const editorSize = (id) => {
    const e = (state.editors || []).find(x => x.id === id);
    return e ? e.size : 0;
  };

  // Add checked options
  if (document.getElementById('chk-backup-claude').checked && state.claude) {
    size += state.claude.size;
  }
  if (document.getElementById('chk-backup-vscode').checked) {
    size += editorSize('vscode');
  }
  if (document.getElementById('chk-backup-antigravity-ide').checked) {
    size += editorSize('antigravity-ide');
  }
  if (document.getElementById('chk-backup-gemini').checked && state.gemini) {
    size += state.gemini.size;
  }

  // Add custom workspaces
  state.addedWorkspaces.forEach(w => {
    size += w.size;
  });

  document.getElementById('backup-total-size').textContent = formatBytes(size);
}

// Setup backup tab UI elements
function initBackupTab() {
  const addBtn = document.getElementById('btn-add-workspace');
  const pathInput = document.getElementById('txt-workspace-path');
  const executeBtn = document.getElementById('btn-execute-backup');

  // Trigger size calculations on options check/uncheck
  ['chk-backup-claude', 'chk-backup-vscode', 'chk-backup-antigravity-ide', 'chk-backup-gemini', 'chk-backup-ssh', 'chk-backup-gitconfig'].forEach(id => {
    document.getElementById(id).addEventListener('change', recalculateTotalBackupSize);
  });

  // Add workspace button
  addBtn.addEventListener('click', async () => {
    const wPath = pathInput.value.trim();
    if (!wPath) return alert('请输入目录路径。');

    addBtn.disabled = true;
    addBtn.textContent = '扫描中…';
    appendTerminalLine(`正在扫描工作区路径：${wPath}`, 'system');

    try {
      const res = await fetch('/api/scan-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: wPath })
      });

      const data = await res.json();
      if (res.ok) {
        // Avoid duplicates
        if (state.addedWorkspaces.find(x => x.path === data.path)) {
          alert('该工作区已添加。');
        } else {
          state.addedWorkspaces.push(data);
          renderWorkspacesTable();
          recalculateTotalBackupSize();
          pathInput.value = '';
          appendTerminalLine(`已添加工作区：${data.name}（${formatBytes(data.size)}）`, 'success');
        }
      } else {
        alert(`扫描失败：${data.error}`);
        appendTerminalLine(`工作区扫描错误：${data.error}`, 'error');
      }
    } catch (e) {
      alert(`扫描目录出错：${e.message}`);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = '扫描并添加目录';
    }
  });

  // Execute backup button
  executeBtn.addEventListener('click', async () => {
    const includeEditors = [];
    if (document.getElementById('chk-backup-vscode').checked) includeEditors.push('vscode');
    if (document.getElementById('chk-backup-antigravity-ide').checked) includeEditors.push('antigravity-ide');

    const payload = {
      includeClaude: document.getElementById('chk-backup-claude').checked,
      includeClaudeCredentials: document.getElementById('chk-backup-credentials').checked,
      includeEditors,
      includeGemini: document.getElementById('chk-backup-gemini').checked,
      includeSSH: document.getElementById('chk-backup-ssh').checked,
      includeGitconfig: document.getElementById('chk-backup-gitconfig').checked,
      customWorkspaces: state.addedWorkspaces.map(w => w.path)
    };

    if (!payload.includeClaude && includeEditors.length === 0 && !payload.includeGemini && !payload.includeSSH && !payload.includeGitconfig && payload.customWorkspaces.length === 0) {
      return alert('请至少选择一个组件或工作区目录进行备份。');
    }

    if (document.getElementById('chk-backup-credentials').checked || payload.includeSSH) {
      if (!confirm('本次备份将把敏感信息（Claude 令牌 和/或 SSH 私钥）以明文形式打包进 .zip。确认继续？')) return;
    }

    executeBtn.disabled = true;
    executeBtn.textContent = '备份中…';
    switchTab('logs');

    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        alert(`备份压缩包已生成！\n文件名：${data.filename}\n体积：${formatBytes(data.size)}`);
      } else {
        alert(`备份失败：${data.error}`);
      }
    } catch (e) {
      alert(`备份过程中网络错误：${e.message}`);
    } finally {
      executeBtn.disabled = false;
      executeBtn.textContent = '生成备份压缩包';
    }
  });
}

function renderWorkspacesTable() {
  const tbody = document.getElementById('workspaces-list');
  tbody.innerHTML = '';

  if (state.addedWorkspaces.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">尚未添加工作区。在上方输入目录路径以打包。</td>
      </tr>
    `;
    return;
  }

  state.addedWorkspaces.forEach((w, index) => {
    const tr = document.createElement('tr');
    
    const tdPath = document.createElement('td');
    tdPath.textContent = w.path;
    tr.appendChild(tdPath);

    const tdCount = document.createElement('td');
    tdCount.textContent = w.files;
    tr.appendChild(tdCount);

    const tdSize = document.createElement('td');
    tdSize.textContent = formatBytes(w.size);
    tr.appendChild(tdSize);

    const tdAction = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => {
      state.addedWorkspaces.splice(index, 1);
      renderWorkspacesTable();
      recalculateTotalBackupSize();
    });
    tdAction.appendChild(delBtn);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  });
}

// Setup restore tab UI elements
function initRestoreTab() {
  const dropzone = document.getElementById('restore-dropzone');
  const fileInput = document.getElementById('file-restore-upload');
  const confirmBtn = document.getElementById('btn-execute-restore');

  // Interactive dropzone click
  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  // Drag over effects
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#3b82f6';
    dropzone.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    dropzone.style.backgroundColor = 'transparent';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    dropzone.style.backgroundColor = 'transparent';
    if (e.dataTransfer.files.length > 0) {
      handleRestoreUpload(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleRestoreUpload(fileInput.files[0]);
    }
  });

  // Execute restore button
  confirmBtn.addEventListener('click', async () => {
    if (!state.activeUploadManifest) return;

    // Gather path mappings from input fields
    const pathMapping = {};
    const inputFields = document.querySelectorAll('.mapping-path-input');
    
    inputFields.forEach(input => {
      const origPath = input.getAttribute('data-original');
      const targetPath = input.value.trim();
      pathMapping[origPath] = targetPath;
    });

    confirmBtn.disabled = true;
    confirmBtn.textContent = '还原中…';
    switchTab('logs');

    try {
      const res = await fetch('/api/restore-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pathMapping })
      });
      const data = await res.json();
      if (res.ok) {
        alert('还原与配置同步完成！请查看 home 目录下的 BridgeSync-MIGRATION-NOTES.txt 了解收尾步骤。');
        // Reload dashboard stats
        detectEnvironment();
        // Reset upload zone
        document.getElementById('restore-configurator').style.display = 'none';
        dropzone.style.display = 'block';
        state.activeUploadManifest = null;
      } else {
        alert(`还原失败：${data.error}`);
      }
    } catch (e) {
      alert(`还原过程中网络错误：${e.message}`);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '开始还原';
    }
  });
}

// Upload backup ZIP and inspect manifest
async function handleRestoreUpload(file) {
  appendTerminalLine(`正在上传备份压缩包：${file.name}（${formatBytes(file.size)}）…`, 'system');

  const formData = new FormData();
  formData.append('backupFile', file);

  try {
    const res = await fetch('/api/restore-upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (res.ok) {
      state.activeUploadManifest = data.manifest;
      renderRestoreConfigurator(data.manifest);
      appendTerminalLine('备份文件解析成功，请在下方配置路径映射。', 'success');
    } else {
      alert(`解析备份 ZIP 失败：${data.error}`);
      appendTerminalLine(`上传备份出错：${data.error}`, 'error');
    }
  } catch (e) {
    alert(`上传备份过程中网络错误：${e.message}`);
  }
}

// Render the remapping UI after backup parsing
function renderRestoreConfigurator(manifest) {
  const configSection = document.getElementById('restore-configurator');
  const dropzone = document.getElementById('restore-dropzone');
  
  // Set metadata
  document.getElementById('restore-meta-date').textContent = new Date(manifest.backupTime).toLocaleString();
  document.getElementById('restore-meta-os').textContent = manifest.sourceOS;
  document.getElementById('restore-meta-host').textContent = manifest.sourceHost;
  document.getElementById('restore-meta-user').textContent = manifest.sourceUser;

  // Set checklist status indicators based on the new manifest shape.
  const c = manifest.contents;
  const toggle = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? 'flex' : 'none';
  };

  toggle('item-restore-claude', !!c.claude);
  toggle('item-restore-gemini', !!c.gemini);
  toggle('item-restore-ssh', !!c.ssh);
  toggle('item-restore-gitconfig', !!c.gitconfig);

  const editors = c.editors || [];
  const editorItem = document.getElementById('item-restore-editors');
  const extCountEl = document.getElementById('restore-ext-count');
  if (editors.length > 0) {
    editorItem.style.display = 'flex';
    const totalExt = editors.reduce((n, e) => n + ((e.extensions && e.extensions.length) || 0), 0);
    const names = editors.map(e => e.name).join(', ');
    extCountEl.textContent = `${names} · ${totalExt} ext`;
  } else {
    editorItem.style.display = 'none';
  }

  // Populate Path mappings
  const tbody = document.getElementById('path-mappings-list');
  tbody.innerHTML = '';

  let mappingsCount = 0;

  // Render workspaces path mapping
  if (manifest.contents.workspaces && manifest.contents.workspaces.length > 0) {
    manifest.contents.workspaces.forEach(w => {
      mappingsCount++;
      const tr = document.createElement('tr');

      const tdOrig = document.createElement('td');
      tdOrig.innerHTML = `<span class="comp-badge wsp">工作区</span> <br> ${w.originalPath}`;
      tr.appendChild(tdOrig);

      const tdTarget = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'mapping-path-input';
      input.setAttribute('data-original', w.originalPath);
      
      // Smart path mapping helper: adapt separators depending on the host OS
      let guessedPath = w.originalPath;
      if (state.os === 'win32' && w.originalPath.includes('/')) {
        // Mapping Linux/macOS to Windows: convert to Windows format
        guessedPath = 'C:\\Projects\\' + w.folderName;
      } else if (state.os !== 'win32' && w.originalPath.includes('\\')) {
        // Mapping Windows to Linux/macOS
        guessedPath = '/Users/' + state.username + '/projects/' + w.folderName;
      }
      input.value = guessedPath;

      tdTarget.appendChild(input);
      tr.appendChild(tdTarget);

      tbody.appendChild(tr);
    });
  }

  // Render Claude project keys as maps (in case they have corresponding paths)
  if (manifest.contents.claude && manifest.contents.workspaces.length > 0) {
    manifest.contents.workspaces.forEach(w => {
      // Find matching project key
      const projectKey = w.originalPath.replace(/[^a-zA-Z0-9]/g, '-');
      mappingsCount++;

      const tr = document.createElement('tr');
      const tdOrig = document.createElement('td');
      tdOrig.innerHTML = `<span class="comp-badge claude">Claude 会话</span> <br> 项目：${w.folderName}（Key: ${projectKey}）`;
      tr.appendChild(tdOrig);

      const tdTarget = document.createElement('td');
      tdTarget.innerHTML = `<span style="color:#64748b; font-size:12px;">自动映射到上方对应的工作区路径</span>`;
      tr.appendChild(tdTarget);

      tbody.appendChild(tr);
    });
  }

  if (mappingsCount === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="2" style="text-align: center; color: #64748b;">本次备份无需配置目录映射。</td>
      </tr>
    `;
  }

  // Toggle sections
  dropzone.style.display = 'none';
  configSection.style.display = 'block';
}

// Setup extension viewer modal
function initModals() {
  const modal = document.getElementById('extensions-modal');
  const viewBtn = document.getElementById('btn-view-extensions');
  const closeBtn = document.getElementById('modal-close');
  const listEl = document.getElementById('modal-extensions-list');

  viewBtn.addEventListener('click', () => {
    listEl.innerHTML = '';
    const list = state.vscode ? state.vscode.extensionsList : [];
    
    if (list.length === 0) {
      listEl.innerHTML = '<li>未找到扩展。</li>';
    } else {
      list.forEach(ext => {
        const li = document.createElement('li');
        li.textContent = ext;
        listEl.appendChild(li);
      });
    }

    modal.classList.add('open');
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('open');
  });

  window.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('open');
    }
  });
}

// Convert bytes helper
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0.00 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

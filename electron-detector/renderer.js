// ── DOM refs ──
const navBrowse        = document.getElementById('nav-browse');
const navInspector     = document.getElementById('nav-inspector');

const drawerEl         = document.getElementById('drawer');
const drawerScrim      = document.getElementById('drawer-scrim');
const drawerClose      = document.getElementById('drawer-close');
const drawerListEl     = document.getElementById('drawer-list');
const drawerCount      = document.getElementById('drawer-count');
const drawerFilter     = document.getElementById('drawer-filter');
const drawerRefresh    = document.getElementById('drawer-refresh');
const drawerStatus     = document.getElementById('drawer-status');

const pageWorkspace    = document.getElementById('page-workspace');
const pageInspector    = document.getElementById('page-inspector');
const pageChat         = document.getElementById('page-chat');

const workspaceList    = document.getElementById('workspace-list');
const workspaceBadge   = document.getElementById('workspace-badge');
const workspaceTitle   = document.getElementById('workspace-title');
const workspaceViewToggle = document.getElementById('workspace-view-toggle');
const addAutomationBtn = document.getElementById('add-automation-btn');
const automationBackBtn = document.getElementById('automation-back-btn');
const automationBackLabel = document.getElementById('automation-back-label');

const statusBar        = document.getElementById('status-bar');

const elementsList     = document.getElementById('elements-list');
const inspectorBadge   = document.getElementById('inspector-badge');
const inspectorRefresh = document.getElementById('inspector-refresh-btn');
const inspectorBack    = document.getElementById('inspector-back-btn');

// ── State ──
let currentPage        = 'workspace';
let currentApps        = [];        // electron apps with cdpAlive/error fields
let cachedUiaApps      = [];        // UIA apps minus electron exes
let persistentExes     = new Set(); // exes with persistent CDP flag
let selectedUiaExes    = new Set();

let drawerOpen         = false;
let drawerLastFocus    = null;
let drawerFilterText   = '';
let drawerBusy         = false;
let appsLoaded         = false;

let workspaceView      = 'apps';
let automationDrillExe = null;
let automationDrillName = null;
const automationsStore = {};

let elementsCache      = {};
let elementsBusy       = false;

// ── Helpers ──
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function fmtCount(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function showStatus(msg, kind = '') {
  statusBar.textContent = msg;
  statusBar.classList.add('visible');
  statusBar.classList.toggle('error', kind === 'error');
}
function hideStatus() { statusBar.classList.remove('visible'); }

function setDrawerStatus(msg, kind = '') {
  drawerStatus.textContent = msg || '';
  drawerStatus.classList.remove('error', 'success');
  if (kind) drawerStatus.classList.add(kind);
}

// ── Page navigation ──
function switchPage(page) {
  if (page === currentPage) return;
  currentPage = page;
  pageWorkspace.classList.toggle('active', page === 'workspace');
  pageInspector.classList.toggle('active', page === 'inspector');
  pageChat.classList.toggle('active', page === 'chat');
  if (page === 'inspector') refreshElements();
}

navInspector.addEventListener('click', () => switchPage('inspector'));
inspectorBack.addEventListener('click', () => switchPage('workspace'));

// ── Drawer ──
function openDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  drawerLastFocus = document.activeElement;
  drawerScrim.classList.add('open');
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  navBrowse.setAttribute('aria-expanded', 'true');
  setTimeout(() => drawerFilter.focus(), 60);
  if (!appsLoaded) refreshApps();
}

function closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawerScrim.classList.remove('open');
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  navBrowse.setAttribute('aria-expanded', 'false');
  if (drawerLastFocus && drawerLastFocus.focus) drawerLastFocus.focus();
}

navBrowse.addEventListener('click', () => (drawerOpen ? closeDrawer() : openDrawer()));
drawerClose.addEventListener('click', closeDrawer);
drawerScrim.addEventListener('click', closeDrawer);
drawerRefresh.addEventListener('click', () => refreshApps(true));
drawerFilter.addEventListener('input', () => {
  drawerFilterText = drawerFilter.value.trim().toLowerCase();
  renderDrawer();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen) {
    e.stopPropagation();
    closeDrawer();
  }
});

// ── App detection ──
async function checkCdpStatus(apps) {
  return Promise.all(apps.map(async (app) => {
    let alive = false;
    let error = null;
    if (app.DebugEnabled && app.DebugPort) {
      alive = await window.api.checkCdpAlive(app.DebugPort);
      if (!alive) error = `CDP unreachable on port ${app.DebugPort}`;
    } else if (persistentExes.has(app.Exe)) {
      error = 'Flag missing — app restarted without CDP';
    }
    return { ...app, cdpAlive: alive, error };
  }));
}

async function refreshApps(fromDrawer = false) {
  if (drawerBusy) return;
  drawerBusy = true;
  if (fromDrawer) drawerRefresh.classList.add('spinning');

  try {
    const [electronResult, uiaResult, cdpResult] = await Promise.allSettled([
      window.api.detectApps(),
      window.api.detectUiaApps(),
      window.api.getCdpState(),
    ]);

    const electronApps = electronResult.status === 'fulfilled' ? electronResult.value : [];
    const allUiaApps   = uiaResult.status === 'fulfilled' ? uiaResult.value : [];
    const cdpState     = cdpResult.status === 'fulfilled' ? cdpResult.value : { apps: [] };

    persistentExes = new Set((cdpState.apps || []).map(a => a.exe));
    const electronExes = new Set(electronApps.map(a => a.Exe));
    cachedUiaApps = allUiaApps.filter(a => !electronExes.has(a.Exe));

    currentApps = await checkCdpStatus(electronApps);
    appsLoaded = true;

    renderDrawer();
    renderWorkspace();
  } catch (err) {
    setDrawerStatus(`Detection failed: ${err.message}`, 'error');
  } finally {
    drawerBusy = false;
    drawerRefresh.classList.remove('spinning');
  }
}

// ── Drawer render ──
function renderDrawer() {
  if (!appsLoaded) {
    drawerListEl.innerHTML = `<div class="loading"><div class="spinner"></div><p>Detecting apps…</p></div>`;
    drawerCount.textContent = '—';
    return;
  }

  const filter = drawerFilterText;
  const match = (app) => {
    if (!filter) return true;
    const n = (app.Name || '').toLowerCase();
    const e = (app.Exe || '').toLowerCase();
    return n.includes(filter) || e.includes(filter);
  };

  const electron = currentApps.filter(match);
  const uia = cachedUiaApps.filter(match);
  const total = electron.length + uia.length;
  drawerCount.textContent = fmtCount(total, 'app');

  if (total === 0) {
    drawerListEl.innerHTML = filter
      ? `<div class="drawer-empty">No matches for "${escapeHtml(filter)}"</div>`
      : `<div class="drawer-empty">No apps detected</div>`;
    return;
  }

  let html = '';
  let idx = 0;

  if (electron.length > 0) {
    html += `<div class="drawer-section">Electron <span class="drawer-section-count">${electron.length}</span></div>`;
    electron.forEach((app) => {
      html += drawerItem(app, 'electron', idx++);
    });
  }
  if (uia.length > 0) {
    html += `<div class="drawer-section">Win32 <span class="drawer-section-count">${uia.length}</span></div>`;
    uia.forEach((app) => {
      html += drawerItem(app, 'uia', idx++);
    });
  }

  drawerListEl.innerHTML = html;
  drawerListEl.querySelectorAll('.drawer-item').forEach((el) => {
    el.addEventListener('click', () => onDrawerItemClick(el));
  });
}

function drawerItem(app, type, i) {
  const isElectron = type === 'electron';
  const selected = isElectron ? !!app.cdpAlive : selectedUiaExes.has(app.Exe);
  const errored = isElectron && !!app.error;
  let rightHtml = '';
  if (isElectron) {
    if (errored) {
      rightHtml = `<span class="app-status"><span class="dot error"></span>error</span>`;
    } else if (app.cdpAlive) {
      rightHtml = `<span class="app-status"><span class="dot live"></span>live · ${app.DebugPort}</span>`;
    } else {
      rightHtml = `<span class="app-status"><span class="dot idle"></span>idle</span>`;
    }
  } else {
    rightHtml = `<span class="app-status"><span class="dot ${selected ? 'live' : 'idle'}"></span>Win32</span>`;
  }
  return `
    <div class="drawer-item${selected ? ' selected' : ''}${errored ? ' has-error' : ''}"
         data-exe="${escapeHtml(app.Exe)}"
         data-type="${type}"
         style="--row-i:${i}">
      <span class="drawer-check">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </span>
      <div class="drawer-item-body">
        <div class="drawer-item-name">${escapeHtml(app.Name || 'Unknown')}</div>
        <div class="drawer-item-path" title="${escapeHtml(app.Exe || '')}">${escapeHtml(app.Exe || '')}</div>
      </div>
      <div class="drawer-item-right">${rightHtml}</div>
    </div>`;
}

async function onDrawerItemClick(itemEl) {
  if (itemEl.classList.contains('busy')) return;
  const exe = itemEl.dataset.exe;
  const type = itemEl.dataset.type;

  if (type === 'uia') {
    if (selectedUiaExes.has(exe)) selectedUiaExes.delete(exe);
    else selectedUiaExes.add(exe);
    renderDrawer();
    renderWorkspace();
    return;
  }

  // Electron: enabling/disabling CDP requires app restart
  const app = currentApps.find(a => a.Exe === exe);
  if (!app) return;
  const enabling = !app.cdpAlive;
  itemEl.classList.add('busy');
  setDrawerStatus(enabling ? `Restarting ${app.Name} with CDP…` : `Restarting ${app.Name} without CDP…`);

  try {
    const apps = enabling
      ? await window.api.enableCdpApp(exe)
      : await window.api.disableCdpApp(exe);
    const cdpState = await window.api.getCdpState();
    persistentExes = new Set((cdpState.apps || []).map(a => a.exe));
    currentApps = await checkCdpStatus(apps);
    renderDrawer();
    renderWorkspace();

    const updated = currentApps.find(a => a.Exe === exe);
    if (enabling && updated && updated.error) {
      setDrawerStatus(`${app.Name}: ${updated.error}`, 'error');
    } else if (updated && updated.cdpAlive) {
      setDrawerStatus(`${app.Name} · CDP on port ${updated.DebugPort}`, 'success');
      setTimeout(() => setDrawerStatus(''), 3000);
    } else {
      setDrawerStatus(`${app.Name} · CDP off`, 'success');
      setTimeout(() => setDrawerStatus(''), 3000);
    }
  } catch (err) {
    setDrawerStatus(`Error: ${err.message}`, 'error');
  } finally {
    const fresh = drawerListEl.querySelector(`.drawer-item[data-exe="${CSS.escape(exe)}"]`);
    if (fresh) fresh.classList.remove('busy');
  }
}

// ── Workspace render ──
function renderWorkspace() {
  if (!appsLoaded) {
    workspaceList.innerHTML = `<div class="loading"><div class="spinner"></div><p>Loading your apps…</p></div>`;
    workspaceBadge.textContent = '—';
    return;
  }

  const selectedElectron = currentApps.filter(a => a.cdpAlive);
  const selectedUia = cachedUiaApps.filter(a => selectedUiaExes.has(a.Exe));
  const total = selectedElectron.length + selectedUia.length;

  // Header chrome
  if (workspaceView === 'automations' && automationDrillExe) {
    const list = automationsStore[automationDrillExe] || [];
    workspaceBadge.textContent = fmtCount(list.length, 'automation');
    addAutomationBtn.style.display = '';
    automationBackBtn.style.display = '';
    automationBackLabel.textContent = automationDrillName || 'Back';
    renderAutomationsList(list);
    return;
  }
  if (workspaceView === 'automations') {
    workspaceBadge.textContent = fmtCount(total, 'app');
    addAutomationBtn.style.display = 'none';
    automationBackBtn.style.display = 'none';
  } else {
    workspaceBadge.textContent = `${total} active`;
    addAutomationBtn.style.display = 'none';
    automationBackBtn.style.display = 'none';
  }

  if (total === 0) {
    workspaceList.innerHTML = `
      <div class="empty-state">
        <svg class="icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1"></rect>
          <rect x="14" y="3" width="7" height="7" rx="1"></rect>
          <rect x="3" y="14" width="7" height="7" rx="1"></rect>
          <rect x="14" y="14" width="7" height="7" rx="1" stroke-dasharray="2 2"></rect>
        </svg>
        <p>No apps in your workspace yet</p>
        <p class="empty-hint">Open the drawer and tap apps to add them.</p>
        <button class="ghost-btn" id="empty-browse-btn">Browse apps</button>
      </div>`;
    const btn = document.getElementById('empty-browse-btn');
    if (btn) btn.addEventListener('click', openDrawer);
    return;
  }

  let html = '';
  let idx = 0;

  if (selectedElectron.length > 0) {
    html += `<div class="section-header"><span class="section-title">Electron</span><span class="section-count">${selectedElectron.length}</span></div>`;
    selectedElectron.forEach((app) => {
      html += workspaceCard(app, 'electron', idx++);
    });
  }
  if (selectedUia.length > 0) {
    html += `<div class="section-header"><span class="section-title">Win32</span><span class="section-count">${selectedUia.length}</span></div>`;
    selectedUia.forEach((app) => {
      html += workspaceCard(app, 'uia', idx++);
    });
  }

  workspaceList.innerHTML = html;
  workspaceList.querySelectorAll('.app-card').forEach((card) => {
    card.addEventListener('click', () => {
      const exe = card.dataset.exe;
      const name = card.dataset.name;
      if (workspaceView === 'automations') {
        automationDrillExe = exe;
        automationDrillName = name;
        renderWorkspace();
        return;
      }
      if (exe && name) openChat(name, exe);
    });
  });
}

function workspaceCard(app, type, i) {
  const isElectron = type === 'electron';
  const cls = isElectron
    ? (app.error ? 'cdp-error' : (app.cdpAlive ? 'cdp-active' : ''))
    : '';
  const dot = isElectron
    ? (app.error ? 'error' : 'live')
    : 'live';
  const right = isElectron
    ? (app.error
        ? `<span class="app-status"><span class="dot error"></span>error</span>`
        : `<span class="app-status"><span class="dot live"></span>live · ${app.DebugPort}</span>`)
    : `<span class="app-status"><span class="dot live"></span>Win32</span>`;

  return `
    <div class="app-card ${cls}"
         data-exe="${escapeHtml(app.Exe)}"
         data-name="${escapeHtml(app.Name)}"
         style="--row-i:${i}">
      <div class="app-info">
        <div class="app-name">${escapeHtml(app.Name || 'Unknown')}</div>
        <div class="app-meta-row">
          ${app.error ? `<span class="app-error">${escapeHtml(app.error)}</span>` : ''}
          <span class="app-path" title="${escapeHtml(app.Exe || '')}">${escapeHtml(app.Exe || '')}</span>
        </div>
      </div>
      ${right}
    </div>`;
}

function renderAutomationsList(list) {
  if (!list || list.length === 0) {
    workspaceList.innerHTML = `<div class="automation-empty">No automations yet.</div>`;
    return;
  }
  workspaceList.innerHTML = list.map(a =>
    `<div class="automation-entry">${escapeHtml(a.name || 'Untitled')}</div>`
  ).join('');
}

workspaceViewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-btn');
  if (!btn) return;
  const view = btn.dataset.saView;
  if (view === workspaceView && !automationDrillExe) return;
  workspaceView = view;
  automationDrillExe = null;
  automationDrillName = null;
  workspaceViewToggle.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.saView === view);
  });
  renderWorkspace();
});

automationBackBtn.addEventListener('click', () => {
  automationDrillExe = null;
  automationDrillName = null;
  renderWorkspace();
});

addAutomationBtn.addEventListener('click', () => {
  // shell — automation creation not wired in v1
});

// ── Inspector page ──
function setInspectorBusy(state) {
  elementsBusy = state;
  inspectorRefresh.disabled = state;
  inspectorRefresh.classList.toggle('spinning', state);
}

async function refreshElements() {
  if (elementsBusy) return;
  setInspectorBusy(true);
  elementsCache = {};

  try {
    const [electronResult, uiaResult, cdpResult] = await Promise.allSettled([
      window.api.detectApps(),
      window.api.detectUiaApps(),
      window.api.getCdpState(),
    ]);

    const electronApps = electronResult.status === 'fulfilled' ? electronResult.value : [];
    const allUiaApps   = uiaResult.status === 'fulfilled' ? uiaResult.value : [];
    const cdpState     = cdpResult.status === 'fulfilled' ? cdpResult.value : { apps: [] };
    const electronExes = new Set(electronApps.map(a => a.Exe));
    const uiaApps = allUiaApps.filter(a => !electronExes.has(a.Exe) && selectedUiaExes.has(a.Exe));

    const cdpPorts = {};
    (cdpState.apps || []).forEach(a => { cdpPorts[a.exe] = a.port; });

    const enriched = await Promise.all(electronApps.map(async (app) => {
      const port = app.DebugPort || cdpPorts[app.Exe] || null;
      const cdpAlive = port ? await window.api.checkCdpAlive(port) : false;
      return { ...app, cdpPort: cdpAlive ? port : null };
    }));
    const selectedElectron = enriched.filter(a => a.cdpPort);

    renderInspectorPage(selectedElectron, uiaApps);
  } catch (err) {
    elementsList.innerHTML = `<div class="empty-state"><p>Detection failed: ${escapeHtml(err.message)}</p></div>`;
    inspectorBadge.textContent = 'Error';
  } finally {
    setInspectorBusy(false);
  }
}

function renderInspectorPage(electronApps, uiaApps) {
  const total = electronApps.length + uiaApps.length;
  inspectorBadge.textContent = `${total} active`;

  if (total === 0) {
    elementsList.innerHTML = `
      <div class="empty-state">
        <p>No active apps to inspect</p>
        <p class="empty-hint">Add apps in the Browse drawer to inspect their UI tree.</p>
      </div>`;
    return;
  }

  let html = '';
  if (electronApps.length > 0) {
    html += `<div class="section-header"><span class="section-title">Electron</span><span class="section-count">${electronApps.length}</span></div>`;
    electronApps.forEach(app => {
      html += renderElementCard(app, 'electron', app.MainPid, app.cdpPort);
    });
  }
  if (uiaApps.length > 0) {
    html += `<div class="section-header"><span class="section-title">Win32</span><span class="section-count">${uiaApps.length}</span></div>`;
    uiaApps.forEach(app => {
      html += renderElementCard(app, 'uia', app.Pid, null);
    });
  }
  elementsList.innerHTML = html;
  elementsList.querySelectorAll('.el-card-header').forEach(header => {
    header.addEventListener('click', () => toggleElementCard(header.closest('.el-card')));
  });
}

function renderElementCard(app, type, pid, cdpPort) {
  const typeBadge = type === 'electron'
    ? '<span class="el-type-badge electron">Electron</span>'
    : '<span class="el-type-badge uia">UIA</span>';
  const cdpTag = cdpPort
    ? `<span class="meta-tag debug-on">CDP :${cdpPort}</span>`
    : (type === 'electron' ? '<span class="meta-tag debug-off">No CDP</span>' : '');
  return `
    <div class="el-card" data-pid="${pid}" data-port="${cdpPort || ''}" data-app-type="${type}" data-expanded="false">
      <div class="el-card-header">
        <span class="el-arrow">&#9654;</span>
        <div class="el-card-info">
          <span class="el-card-name">${escapeHtml(app.Name)}</span>
          ${typeBadge}
          ${cdpTag}
        </div>
      </div>
      <div class="el-card-body"></div>
    </div>`;
}

async function toggleElementCard(card) {
  const expanded = card.dataset.expanded === 'true';
  const arrow = card.querySelector('.el-arrow');
  const body = card.querySelector('.el-card-body');

  if (expanded) {
    card.dataset.expanded = 'false';
    arrow.innerHTML = '&#9654;';
    body.style.display = 'none';
    return;
  }

  card.dataset.expanded = 'true';
  arrow.innerHTML = '&#9660;';
  body.style.display = 'block';

  const pid = parseInt(card.dataset.pid, 10);
  const port = card.dataset.port ? parseInt(card.dataset.port, 10) : null;
  const appType = card.dataset.appType;

  if (elementsCache[pid]) {
    renderElementsList(body, elementsCache[pid]);
    return;
  }
  if (appType === 'electron' && !port) {
    body.innerHTML = '<div class="el-empty">Enable CDP from the Browse drawer to inspect this app.</div>';
    return;
  }

  body.innerHTML = `<div class="el-loading"><div class="spinner"></div> Inspecting elements…</div>`;
  try {
    const result = await window.api.inspectElements(pid, port);
    const els = result.elements || result;
    if (els && els.length > 0) elementsCache[pid] = result;
    renderElementsList(body, result);
  } catch (err) {
    body.innerHTML = `<div class="el-error">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

function renderElementsList(container, result) {
  const source = result.source || 'uia';
  const elements = result.elements || result;
  if (!elements || elements.length === 0) {
    container.innerHTML = '<div class="el-empty">No elements found</div>';
    return;
  }
  if (source === 'cdp') renderCdpElements(container, elements);
  else renderUiaElements(container, elements);
}

function renderCdpElements(container, elements) {
  const grouped = {};
  elements.forEach(el => {
    const tag = el.Tag || 'UNKNOWN';
    (grouped[tag] ||= []).push(el);
  });
  const sortedTags = Object.keys(grouped).sort((a, b) => {
    const order = ['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA'];
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  let html = `<div class="el-summary">${elements.length} element${elements.length === 1 ? '' : 's'} across ${sortedTags.length} tag${sortedTags.length === 1 ? '' : 's'} <span class="el-source-badge cdp">CDP</span></div>`;
  sortedTags.forEach(tag => {
    const items = grouped[tag];
    html += `<div class="el-group"><div class="el-group-header"><span class="el-group-type">&lt;${escapeHtml(tag.toLowerCase())}&gt;</span><span class="el-group-count">${items.length}</span></div><div class="el-group-items">`;
    items.forEach(el => {
      html += `<div class="el-item">`;
      if (el.Text)      html += `<span class="el-field"><span class="el-label">Text</span> ${escapeHtml(el.Text)}</span>`;
      if (el.AriaLabel) html += `<span class="el-field"><span class="el-label">Aria</span> ${escapeHtml(el.AriaLabel)}</span>`;
      if (el.Id)        html += `<span class="el-field"><span class="el-label">ID</span> <code>${escapeHtml(el.Id)}</code></span>`;
      if (el.Role)      html += `<span class="el-field"><span class="el-label">Role</span> <code>${escapeHtml(el.Role)}</code></span>`;
      if (el.Class)     html += `<span class="el-field"><span class="el-label">Class</span> <code>${escapeHtml(el.Class)}</code></span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  container.innerHTML = html;
}

function renderUiaElements(container, elements) {
  const grouped = {};
  elements.forEach(el => {
    const type = el.Type || 'Unknown';
    (grouped[type] ||= []).push(el);
  });
  const sortedTypes = Object.keys(grouped).sort((a, b) => {
    const order = ['Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'TabItem', 'Hyperlink', 'ListItem', 'TreeItem', 'DataItem'];
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  let html = `<div class="el-summary">${elements.length} element${elements.length === 1 ? '' : 's'} across ${sortedTypes.length} type${sortedTypes.length === 1 ? '' : 's'} <span class="el-source-badge uia">UIA</span></div>`;
  sortedTypes.forEach(type => {
    const items = grouped[type];
    html += `<div class="el-group"><div class="el-group-header"><span class="el-group-type">${escapeHtml(type)}</span><span class="el-group-count">${items.length}</span></div><div class="el-group-items">`;
    items.forEach(el => {
      html += `<div class="el-item">`;
      if (el.Name)         html += `<span class="el-field"><span class="el-label">Name</span> ${escapeHtml(el.Name)}</span>`;
      if (el.AutomationId) html += `<span class="el-field"><span class="el-label">ID</span> <code>${escapeHtml(el.AutomationId)}</code></span>`;
      if (el.ClassName)    html += `<span class="el-field"><span class="el-label">Class</span> <code>${escapeHtml(el.ClassName)}</code></span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  container.innerHTML = html;
}

inspectorRefresh.addEventListener('click', refreshElements);

// ── Codex login ──
const codexBtn         = document.getElementById('codex-login-btn');
const codexInstallErr  = document.getElementById('codex-install-error');
const codexModal       = document.getElementById('codex-modal');
const codexModalMsg    = document.getElementById('codex-modal-msg');
const codexModalSpin   = document.querySelector('.codex-modal-spinner');
const codexModalCancel = document.getElementById('codex-modal-cancel');

function setCodexInstallError(msg) {
  if (msg) {
    codexInstallErr.textContent = msg;
    codexInstallErr.classList.add('visible');
  } else {
    codexInstallErr.textContent = '';
    codexInstallErr.classList.remove('visible');
  }
}

async function refreshCodexStatus() {
  try {
    const status = await window.codex.status();
    if (!status.installed) {
      codexBtn.textContent = 'Sign in to ChatGPT';
      codexBtn.classList.remove('logged-in');
      codexBtn.disabled = true;
      codexBtn.dataset.state = 'out';
      setCodexInstallError('codex CLI not installed — install it and restart');
      return;
    }
    setCodexInstallError(null);
    codexBtn.disabled = false;
    if (status.loggedIn) {
      codexBtn.textContent = 'Sign out';
      codexBtn.classList.add('logged-in');
      codexBtn.dataset.state = 'in';
    } else {
      codexBtn.textContent = 'Sign in to ChatGPT';
      codexBtn.classList.remove('logged-in');
      codexBtn.dataset.state = 'out';
    }
  } catch (err) {
    codexBtn.textContent = 'ChatGPT unavailable';
    codexBtn.disabled = true;
    setCodexInstallError(err.message || 'status check failed');
  }
}

function showCodexModal(msg) {
  codexModalMsg.textContent = msg;
  codexModalMsg.classList.remove('error');
  codexModalSpin.style.display = '';
  codexModalCancel.textContent = 'Cancel';
  codexModal.classList.add('show');
}
function showCodexError(msg) {
  codexModalMsg.textContent = msg;
  codexModalMsg.classList.add('error');
  codexModalSpin.style.display = 'none';
  codexModalCancel.textContent = 'Close';
}
function hideCodexModal() { codexModal.classList.remove('show'); }

codexBtn.addEventListener('click', async () => {
  if (codexBtn.disabled) return;
  if (codexBtn.dataset.state === 'in') {
    codexBtn.disabled = true;
    codexBtn.textContent = 'Signing out…';
    try { await window.codex.logout(); } catch (err) { console.error('logout error', err); }
    await refreshCodexStatus();
    return;
  }
  showCodexModal('Opening browser — waiting for device code…');
  const offCode = window.codex.onDeviceCode(({ code }) => {
    codexModalMsg.innerHTML =
      'Browser opened. Enter this code on the page:<br>' +
      `<div style="font-size:24px;font-weight:600;letter-spacing:2px;margin-top:8px;user-select:all">${code}</div>`;
  });
  try {
    await window.codex.login();
    hideCodexModal();
  } catch (err) {
    showCodexError(err.message || String(err));
  } finally {
    offCode();
  }
  await refreshCodexStatus();
});

codexModalCancel.addEventListener('click', async () => {
  try { await window.codex.cancelLogin(); } catch {}
  hideCodexModal();
});

refreshCodexStatus();

// ── Chat panel ──
const chatBackBtn      = document.getElementById('chat-back-btn');
const chatAppNameEl    = document.getElementById('chat-app-name');
const chatScrollEl     = document.getElementById('chat-scroll');
const chatMessagesEl   = document.getElementById('chat-messages');
const chatInput        = document.getElementById('chat-input');
const chatSendBtn      = document.getElementById('chat-send-btn');
const chatNewBtn       = document.getElementById('chat-new-btn');
const chatWelcomeSub   = document.getElementById('chat-welcome-sub');

let chatCurrentExe     = null;
let chatStore          = {};        // exe → [{role, content, reasoning?, reasoningMs?}]
let chatMetaStore      = {};
let chatStreamContent  = '';
let chatStreamExe      = null;
let chatBusy           = false;

let thinkingBuffer     = '';
let thinkingFallback   = '';
let reasoningStartMs   = 0;
let lastUserMessage    = '';

function resolveAppMeta(exe, name) {
  const electron = currentApps.find(a => a.Exe === exe);
  if (electron) {
    return {
      exe,
      name: name || electron.Name,
      type: 'electron',
      pid: electron.MainPid || null,
      port: (electron.cdpAlive && electron.DebugPort) ? electron.DebugPort : null,
    };
  }
  const uia = cachedUiaApps.find(a => a.Exe === exe);
  if (uia) return { exe, name: name || uia.Name, type: 'uia', pid: uia.Pid || null, port: null };
  return { exe, name: name || exe, type: 'uia', pid: null, port: null };
}

async function openChat(appName, exe) {
  chatCurrentExe = exe;
  chatAppNameEl.textContent = appName;
  if (!chatStore[exe]) chatStore[exe] = [];
  const meta = resolveAppMeta(exe, appName);
  chatMetaStore[exe] = meta;
  chatWelcomeSub.textContent = meta.type === 'electron'
    ? `Scoped to ${appName}. CDP active — I can read DOM, click, type, scroll.`
    : `Scoped to ${appName}. UIA active — I can read UI tree, invoke, set values.`;
  switchPage('chat');
  renderChat();
  chatInput.focus();
  try { await window.agent.ensure(meta); } catch (err) { console.error('agent:ensure', err); }
}

chatBackBtn.addEventListener('click', () => switchPage('workspace'));

chatNewBtn.addEventListener('click', () => {
  if (!chatCurrentExe) return;
  window.chat.reset(chatCurrentExe);
  chatStore[chatCurrentExe] = [];
  chatStreamContent = '';
  chatStreamExe = null;
  thinkingBuffer = '';
  reasoningStartMs = 0;
  hideThinking();
  setChatBusy(false);
  renderChat();
  chatInput.focus();
});

function renderChat() {
  const msgs = chatStore[chatCurrentExe] || [];
  if (msgs.length === 0) {
    chatMessagesEl.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </div>
        <p class="chat-welcome-title">Start a conversation</p>
        <p class="chat-welcome-sub">${escapeHtml(chatWelcomeSub.textContent || '')}</p>
      </div>`;
    return;
  }
  chatMessagesEl.innerHTML = msgs.map((m, i) => renderTurn(m, i)).join('');
  scrollChatToBottom();
}

function renderTurn(m, i) {
  if (m.role === 'user') {
    return `<div class="chat-msg chat-msg-user">${escapeHtml(m.content)}</div>`;
  }
  if (m.role === 'assistant') {
    let reasoning = '';
    if (m.reasoning) {
      const s = Math.max(1, Math.round((m.reasoningMs || 0) / 1000));
      reasoning = `
        <button class="chat-reasoning" data-i="${i}" type="button">
          <span class="chat-reasoning-chevron">›</span>
          <span>Thought for ${s} second${s === 1 ? '' : 's'}</span>
        </button>
        <div class="chat-reasoning-body">${escapeHtml(m.reasoning)}</div>`;
    }
    let trailBlock = '';
    if (Array.isArray(m.trail) && m.trail.length > 0) {
      const n = m.trail.length;
      trailBlock = `
        <button class="chat-trail-toggle" data-i="${i}" type="button">
          <span class="chat-trail-chevron">›</span>
          <span>Show ${n} action${n === 1 ? '' : 's'}</span>
        </button>
        <div class="chat-trail-body">${renderTrailPills(m.trail)}</div>`;
    }
    const hasContent = (m.content || '').trim().length > 0;
    const body = hasContent ? renderMarkdown(m.content) : '';
    const automatable = canAutomate(m);
    const automateBtn = automatable
      ? `<button class="chat-action-btn automate" data-act="automate" title="Save this task as a reusable automation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          <span class="chat-action-label">Save as automation</span>
        </button>`
      : '';
    const actionsCls = automatable ? 'chat-actions persist' : 'chat-actions';
    const msgBlock = hasContent
      ? `<div class="chat-msg chat-msg-assistant" data-i="${i}">${body}</div>
         <div class="${actionsCls}" data-i="${i}">
           <button class="chat-action-btn" data-act="copy" title="Copy">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
           </button>
           <button class="chat-action-btn" data-act="regen" title="Regenerate">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15A9 9 0 1 1 18 6.36L23 11"></path></svg>
           </button>
           ${automateBtn}
         </div>`
      : (m.trail && m.trail.length > 0 ? `<div class="chat-actions persist" data-i="${i}">${automateBtn}</div>` : '');
    return `
      ${reasoning}
      ${trailBlock}
      ${msgBlock}`;
  }
  if (m.role === 'system') {
    return `<div class="chat-msg chat-msg-system">${escapeHtml(m.content)}</div>`;
  }
  return '';
}

function addChatMessage(role, content, extras = {}) {
  if (!chatStore[chatCurrentExe]) chatStore[chatCurrentExe] = [];
  chatStore[chatCurrentExe].push({ role, content, ...extras });
  renderChat();
}

function scrollChatToBottom() {
  chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
}

// Reasoning expand/collapse + actions
chatMessagesEl.addEventListener('click', (e) => {
  const reasoning = e.target.closest('.chat-reasoning');
  if (reasoning) {
    reasoning.classList.toggle('open');
    return;
  }
  const trailToggle = e.target.closest('.chat-trail-toggle');
  if (trailToggle) {
    const open = trailToggle.classList.toggle('open');
    const label = trailToggle.querySelector('span:last-child');
    if (label) {
      const i = parseInt(trailToggle.dataset.i, 10);
      const msg = (chatStore[chatCurrentExe] || [])[i];
      const n = (msg && Array.isArray(msg.trail)) ? msg.trail.length : 0;
      label.textContent = `${open ? 'Hide' : 'Show'} ${n} action${n === 1 ? '' : 's'}`;
    }
    return;
  }
  const copyBlock = e.target.closest('.chat-code-copy');
  if (copyBlock) {
    const code = copyBlock.closest('.chat-code-block').querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => {
      copyBlock.classList.add('copied');
      copyBlock.textContent = 'Copied';
      setTimeout(() => {
        copyBlock.classList.remove('copied');
        copyBlock.textContent = 'Copy';
      }, 1600);
    });
    return;
  }
  const actBtn = e.target.closest('.chat-action-btn');
  if (actBtn) {
    const actions = actBtn.closest('.chat-actions');
    const i = parseInt(actions.dataset.i, 10);
    const msgs = chatStore[chatCurrentExe] || [];
    const msg = msgs[i];
    if (!msg) return;
    const act = actBtn.dataset.act;
    if (act === 'copy') {
      navigator.clipboard.writeText(msg.content || '').then(() => {
        actBtn.classList.add('copied');
        setTimeout(() => actBtn.classList.remove('copied'), 1500);
      });
    } else if (act === 'regen') {
      if (chatBusy) return;
      // Drop the assistant turn and the user turn that produced it; sendChatMessage re-pushes the user turn.
      let cut = i;
      while (cut > 0 && msgs[cut - 1].role !== 'user') cut--;
      if (cut === 0) return;
      const userMsg = msgs[cut - 1];
      chatStore[chatCurrentExe] = msgs.slice(0, cut - 1);
      renderChat();
      sendChatMessage(userMsg.content);
    }
  }
});

// Thinking pill
function showThinking(subtext) {
  let el = document.getElementById('chat-thinking');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-thinking';
    el.id = 'chat-thinking';
    el.innerHTML = `
      <div class="chat-thinking-head">
        <div class="chat-thinking-spinner"></div>
        <span class="chat-thinking-label">Thinking…</span>
      </div>
      <div class="chat-thinking-sub" id="chat-thinking-sub"></div>`;
    chatMessagesEl.appendChild(el);
  } else {
    chatMessagesEl.appendChild(el);
  }
  setThinkingSub(subtext !== undefined ? subtext : thinkingFallback);
  scrollChatToBottom();
}

function setThinkingSub(text) {
  const sub = document.getElementById('chat-thinking-sub');
  if (!sub) return;
  const trimmed = (text || '').trim();
  if (!trimmed) { sub.textContent = ''; sub.style.display = 'none'; return; }
  sub.style.display = '';
  const tail = trimmed.length > 240 ? '…' + trimmed.slice(-240) : trimmed;
  sub.textContent = tail.replace(/\s+/g, ' ');
}

function hideThinking() {
  const el = document.getElementById('chat-thinking');
  if (el) el.remove();
}

const CHAT_SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>';
const CHAT_STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>';

function setChatBusy(state) {
  chatBusy = state;
  chatInput.disabled = state;
  if (state) {
    chatSendBtn.disabled = false;
    chatSendBtn.classList.add('is-stop');
    chatSendBtn.title = 'Stop';
    chatSendBtn.setAttribute('aria-label', 'Stop');
    chatSendBtn.innerHTML = CHAT_STOP_ICON;
  } else {
    chatSendBtn.disabled = false;
    chatSendBtn.classList.remove('is-stop');
    chatSendBtn.title = 'Send (Enter)';
    chatSendBtn.setAttribute('aria-label', 'Send');
    chatSendBtn.innerHTML = CHAT_SEND_ICON;
  }
}

// SSE wiring
window.chat.onChunk((data) => {
  if (data.exe !== chatCurrentExe) return;
  chatStreamContent += data.delta;
  hideThinking();

  let streamMsg = document.getElementById('chat-stream-msg');
  if (!streamMsg) {
    streamMsg = document.createElement('div');
    streamMsg.id = 'chat-stream-msg';
    streamMsg.className = 'chat-msg chat-msg-assistant';
    chatMessagesEl.appendChild(streamMsg);
  }
  streamMsg.innerHTML = renderMarkdown(chatStreamContent);
  scrollChatToBottom();
});

window.chat.onThinking((data) => {
  if (data.exe !== chatCurrentExe) return;
  if (data.reset) thinkingBuffer = '';
  if (data.delta) thinkingBuffer += data.delta;
  if (data.heartbeatMs !== undefined) {
    if (!document.getElementById('chat-thinking')) showThinking(thinkingFallback);
    const secs = Math.round(data.heartbeatMs / 1000);
    const base = thinkingBuffer || thinkingFallback || 'reasoning';
    setThinkingSub(`${base} · ${secs}s elapsed`);
    return;
  }
  if (!document.getElementById('chat-thinking')) showThinking(thinkingBuffer);
  else setThinkingSub(thinkingBuffer || thinkingFallback);
});

window.chat.onTool((data) => {
  if (data.exe !== chatCurrentExe) return;
  hideThinking();
  thinkingFallback = `running ${data.name}…`;
  const summary = formatToolCall(data.name, data.args);
  appendToolLine(`⚙ ${summary}`);
});

window.chat.onToolResult((data) => {
  if (data.exe !== chatCurrentExe) return;
  const ok = data.result && data.result.ok;
  const err = data.result && data.result.error;
  let msg, fallback;
  if (err) {
    msg = `✕ ${escapeHtml(data.name)}: ${escapeHtml(err)}`;
    fallback = `after ${data.name} → error: ${err}`;
  } else if (data.result && data.result.text !== undefined) {
    const t = String(data.result.text).slice(0, 200).replace(/\n/g, ' ');
    msg = `✓ ${escapeHtml(data.name)} → ${escapeHtml(t)}`;
    fallback = `after ${data.name} → "${t.slice(0, 80)}"`;
  } else if (data.result && data.result.snapshot !== undefined) {
    msg = `✓ ${escapeHtml(data.name)} → refreshed (${data.result.refs || 0} refs)`;
    fallback = `after ${data.name} → ${data.result.refs || 0} refs`;
  } else if (data.result && data.result.messages) {
    const n = data.result.count || data.result.messages.length;
    msg = `✓ ${escapeHtml(data.name)} → ${n} messages`;
    fallback = `after ${data.name} → ${n} messages`;
  } else if (data.result && data.result.results) {
    const n = data.result.count || data.result.results.length;
    const sort = data.result.sortMode ? ` (${data.result.sortMode})` : '';
    msg = `✓ ${escapeHtml(data.name)} → ${n} results${escapeHtml(sort)}`;
    fallback = `after ${data.name} → ${n} results${sort}`;
  } else if (ok) {
    msg = `✓ ${escapeHtml(data.name)} ok`;
    fallback = `after ${data.name} → ok`;
  } else {
    msg = `… ${escapeHtml(data.name)} done`;
    fallback = `after ${data.name} → done`;
  }
  appendToolLine(msg);
  thinkingFallback = fallback;
  thinkingBuffer = '';
  showThinking(fallback);
});

function renderTrailPills(trail) {
  return trail.map(t => {
    const callLine = `<div class="chat-tool-line">⚙ ${formatToolCall(t.name, t.args)}</div>`;
    const r = t.result || {};
    let resultLine;
    if (r.error) {
      resultLine = `<div class="chat-tool-line">✕ ${escapeHtml(t.name)}: ${escapeHtml(r.error)}</div>`;
    } else if (r.text !== undefined) {
      const tx = String(r.text).slice(0, 200).replace(/\n/g, ' ');
      resultLine = `<div class="chat-tool-line">✓ ${escapeHtml(t.name)} → ${escapeHtml(tx)}</div>`;
    } else if (r.snapshot !== undefined) {
      resultLine = `<div class="chat-tool-line">✓ ${escapeHtml(t.name)} → refreshed (${r.refs || 0} refs)</div>`;
    } else if (r.messages) {
      const n = r.count || r.messages.length;
      resultLine = `<div class="chat-tool-line">✓ ${escapeHtml(t.name)} → ${n} messages</div>`;
    } else if (r.results) {
      const n = r.count || r.results.length;
      const sort = r.sortMode ? ` (${r.sortMode})` : '';
      resultLine = `<div class="chat-tool-line">✓ ${escapeHtml(t.name)} → ${n} results${escapeHtml(sort)}</div>`;
    } else if (r.ok) {
      resultLine = `<div class="chat-tool-line">✓ ${escapeHtml(t.name)} ok</div>`;
    } else {
      resultLine = `<div class="chat-tool-line">… ${escapeHtml(t.name)} done</div>`;
    }
    return callLine + resultLine;
  }).join('');
}

function formatToolCall(name, args) {
  const parts = [];
  if (args && args.ref) parts.push(args.ref);
  if (args && args.text !== undefined) {
    const t = String(args.text);
    parts.push(`"${t.length > 40 ? t.slice(0, 40) + '…' : t}"`);
  }
  return `${escapeHtml(name)}(${parts.map(p => typeof p === 'string' ? escapeHtml(p) : p).join(', ')})`;
}

function appendToolLine(html) {
  const el = document.createElement('div');
  el.className = 'chat-tool-line';
  el.innerHTML = html;
  chatMessagesEl.appendChild(el);
  scrollChatToBottom();
}

window.chat.onDone((data) => {
  if (data.exe !== chatStreamExe) return;
  hideThinking();

  const targetExe = chatStreamExe;
  const elapsedMs = reasoningStartMs ? (Date.now() - reasoningStartMs) : 0;
  const reasoning = (thinkingBuffer || '').trim();
  const doneTrail = Array.isArray(data && data.trail) ? data.trail : [];
  const finalContent = chatStreamContent || (data && typeof data.content === 'string' ? data.content : '');
  const hasError = !!(data && data.error);

  if (!chatStore[targetExe]) chatStore[targetExe] = [];

  if (finalContent || doneTrail.length > 0) {
    chatStore[targetExe].push({
      role: 'assistant',
      content: finalContent,
      reasoning: reasoning || null,
      reasoningMs: elapsedMs,
      trail: doneTrail,
      userMsg: lastUserMessage || '',
    });
  }

  if (hasError) {
    const isUserStop = data.error === 'Stopped by user';
    chatStore[targetExe].push({
      role: 'system',
      content: isUserStop ? 'Stopped.' : `ChatGPT stopped responding: ${data.error}`,
    });
  }

  chatStreamContent = '';
  chatStreamExe = null;
  thinkingBuffer = '';
  thinkingFallback = '';
  reasoningStartMs = 0;
  setChatBusy(false);

  if (targetExe === chatCurrentExe) {
    renderChat();
  }
});

async function sendChatMessage(forcedText) {
  const text = forcedText !== undefined ? forcedText : chatInput.value.trim();
  if (!text || chatBusy) return;

  if (forcedText === undefined) {
    chatInput.value = '';
    chatInput.style.height = 'auto';
  }
  addChatMessage('user', text);
  lastUserMessage = text;

  thinkingBuffer = '';
  thinkingFallback = 'reading your request…';
  reasoningStartMs = Date.now();
  showThinking(thinkingFallback);
  setChatBusy(true);

  chatStreamContent = '';
  chatStreamExe = chatCurrentExe;

  const meta = chatMetaStore[chatCurrentExe] || resolveAppMeta(chatCurrentExe, chatAppNameEl.textContent);
  chatMetaStore[chatCurrentExe] = meta;

  const apiMessages = (chatStore[chatCurrentExe] || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  try {
    await window.chat.send({ meta, messages: apiMessages });
  } catch (err) {
    hideThinking();
    const streamMsg = document.getElementById('chat-stream-msg');
    if (streamMsg) streamMsg.remove();
    chatStreamContent = '';
    chatStreamExe = null;
    addChatMessage('system', `Error: ${err.message}`);
    setChatBusy(false);
  }
}

chatSendBtn.addEventListener('click', () => {
  if (chatBusy) {
    stopChatMessage();
  } else {
    sendChatMessage();
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!chatBusy) sendChatMessage();
  }
});

async function stopChatMessage() {
  const exe = chatStreamExe || chatCurrentExe;
  if (!exe) return;
  chatSendBtn.disabled = true;
  try {
    await window.chat.stop(exe);
  } catch (err) {
    console.warn('chat.stop failed', err);
  }
}

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
});

// ── Markdown renderer (kept from prior, ChatGPT-style code chrome) ──
const katex = window.katex;

function renderLatex(tex, displayMode) {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false });
  } catch {
    return displayMode ? `<pre>${tex}</pre>` : `<code>${tex}</code>`;
  }
}

function renderMarkdown(text) {
  const codeBlocks = [];
  const inlineCodes = [];
  const mathBlocks = [];

  let src = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `__CBLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang || '', code });
    return token;
  });

  src = src.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `__ICODE_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return token;
  });

  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    const token = `__MATH_${mathBlocks.length}__`;
    mathBlocks.push({ tex: tex.trim(), display: true });
    return token;
  });
  src = src.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
    const token = `__MATH_${mathBlocks.length}__`;
    mathBlocks.push({ tex: tex.trim(), display: true });
    return token;
  });
  src = src.replace(/\\\((.+?)\\\)/g, (_, tex) => {
    const token = `__MATH_${mathBlocks.length}__`;
    mathBlocks.push({ tex: tex.trim(), display: false });
    return token;
  });
  src = src.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_, tex) => {
    const token = `__MATH_${mathBlocks.length}__`;
    mathBlocks.push({ tex: tex.trim(), display: false });
    return token;
  });

  src = escapeHtml(src);

  src = src.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  src = src.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  src = src.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  src = src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/\*(.+?)\*/g, '<em>$1</em>');
  src = src.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  src = src.replace(/(^|\n)((?:- .+(?:\n|$))+)/g, (_, pre, items) => {
    const lis = items.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `${pre}<ul>${lis}</ul>`;
  });
  src = src.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, pre, items) => {
    const lis = items.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `${pre}<ol>${lis}</ol>`;
  });

  src = src.split(/\n{2,}/).map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-3]|ul|ol|blockquote|div)/.test(block)) return block;
    return `<p>${block}</p>`;
  }).join('');

  src = src.replace(/\n/g, '<br>');

  src = src.replace(/__MATH_(\d+)__/g, (_, i) => {
    const m = mathBlocks[parseInt(i)];
    return renderLatex(m.tex, m.display);
  });

  src = src.replace(/__ICODE_(\d+)__/g, (_, i) =>
    `<code class="chat-inline-code">${escapeHtml(inlineCodes[parseInt(i)])}</code>`
  );

  src = src.replace(/__CBLOCK_(\d+)__/g, (_, i) => {
    const b = codeBlocks[parseInt(i)];
    const langLabel = escapeHtml(b.lang) || 'text';
    return `<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${langLabel}</span><button class="chat-code-copy" type="button">Copy</button></div><pre><code>${escapeHtml(b.code)}</code></pre></div>`;
  });

  return src;
}

// ── Automations: success heuristic + button + modals ──

// Match straight ' and curly ’ apostrophes (gpt-5.5 emits both depending on punctuation pass).
const APOS = "['’]";
const FAILURE_REGEX = new RegExp(
  '\\b(' +
    'failed|error|aborted|stuck|gave up|timed out|timeout|expired|' +
    '(?:could|would|should|did|do|does|was|were|is|are|has|have|had|wo|ca)n' + APOS + '?t(?:\\s+(?:click|find|reach|open|complete|finish|submit|locate|navigate|scroll|paste|type|move|jump|load|fetch|read|work))?|' +
    'cannot|unable to|not able to|' +
    'stopped (?:without|before|early|short)|had to stop|ran out of|out of (?:rounds|time|budget)|' +
    '(?:before|until|when)\\s+(?:the\\s+)?(?:tool\\s+)?session\\s+(?:ended|expired|ran out|stopped|finished)|session\\s+(?:ended|expired)\\s+(?:before|without)|' +
    'partial(?:ly)?\\s+(?:complete|completed|completion|done|successful|success)|partial completion|did(?:n' + APOS + '?t)?\\s+(?:finish|complete|work)|not complete|never (?:loaded|opened|clicked|reached)|' +
    'may not (?:be|have|work)|' +
    'try (?:again|regenerating|rephrasing)|regenerate|rephrase|not sure how|' +
    'didn' + APOS + '?t\\s+(?:work|find|reach|click|load|open|complete)|' +
    'isn' + APOS + '?t\\s+(?:working|clickable|visible|loaded|present)' +
  ')\\b',
  'i'
);

function canAutomate(m) {
  if (!m || m.role !== 'assistant') return false;
  if (!Array.isArray(m.trail) || m.trail.length === 0) return false;
  const content = (m.content || '').trim();
  if (!content) return false;
  if (FAILURE_REGEX.test(content)) return false;
  return true;
}

const autoConfirmModal   = document.getElementById('auto-confirm-modal');
const autoConfirmClose   = document.getElementById('auto-confirm-close');
const autoConfirmCancel  = document.getElementById('auto-confirm-cancel');
const autoConfirmGo      = document.getElementById('auto-confirm-go');
const autoConfirmUser    = document.getElementById('auto-confirm-user');
const autoConfirmCount   = document.getElementById('auto-confirm-count');
const autoConfirmPlural  = document.getElementById('auto-confirm-plural');
const autoConfirmTrail   = document.getElementById('auto-confirm-trail');
const autoConfirmReply   = document.getElementById('auto-confirm-reply');

const autoProgressModal  = document.getElementById('auto-progress-modal');
const autoProgressText   = document.getElementById('auto-progress-text');
const autoProgressCancel = document.getElementById('auto-progress-cancel');

const autoReviewModal    = document.getElementById('auto-review-modal');
const autoReviewClose    = document.getElementById('auto-review-close');
const autoReviewName     = document.getElementById('auto-review-name');
const autoReviewCount    = document.getElementById('auto-review-count');
const autoReviewSteps    = document.getElementById('auto-review-steps');
const autoReviewToggleJson = document.getElementById('auto-review-toggle-json');
const autoReviewJsonWrap = document.getElementById('auto-review-json-wrap');
const autoReviewJson     = document.getElementById('auto-review-json');
const autoReviewJsonError = document.getElementById('auto-review-json-error');
const autoReviewJsonSave = document.getElementById('auto-review-json-save');
const autoReviewError    = document.getElementById('auto-review-error');
const autoReviewDiscard  = document.getElementById('auto-review-discard');
const autoReviewSave     = document.getElementById('auto-review-save');

const autoRunModal       = document.getElementById('auto-run-modal');
const autoRunTitle       = document.getElementById('auto-run-title');
const autoRunClose       = document.getElementById('auto-run-close');
const autoRunLog         = document.getElementById('auto-run-log');
const autoRunError       = document.getElementById('auto-run-error');
const autoRunStop        = document.getElementById('auto-run-stop');
const autoRunDone        = document.getElementById('auto-run-done');

let pendingAutomation = null;     // { meta, userMsg, finalReply, trail }
let activeCodexJob    = null;     // jobId for cancel
let reviewState       = null;     // { meta, steps, userMsg, finalReply }
let activeRunId       = null;

function showAutoModal(el) { el.classList.add('show'); }
function hideAutoModal(el) { el.classList.remove('show'); }

function summariseArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    let val = v;
    if (typeof val === 'string') {
      val = val.length > 50 ? val.slice(0, 50) + '…' : val;
      val = JSON.stringify(val);
    } else if (val && typeof val === 'object') {
      val = JSON.stringify(val).slice(0, 60);
    } else {
      val = JSON.stringify(val);
    }
    parts.push(`${k}=${val}`);
  }
  return parts.join(', ');
}

function summariseResult(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.error) return `error: ${r.error}`;
  if (r.snapshot !== undefined) return `${r.refs || 0} refs`;
  if (Array.isArray(r.messages)) return `${r.count || r.messages.length} messages`;
  if (r.text !== undefined) return `"${String(r.text).slice(0, 40)}"`;
  if (r.ok === true) return 'ok';
  return '';
}

// ── Plain-English recipe steps (the non-coder view) ──

const AUTO_TOOLS_CDP = new Set([
  'cdp_find', 'cdp_click', 'cdp_type', 'cdp_paste', 'cdp_press_key',
  'cdp_get_text', 'cdp_get_tree', 'cdp_get_messages',
  'cdp_scroll_to_message', 'cdp_scroll_messages', 'cdp_scroll',
  'cdp_get_search_results', 'cdp_jump_to_search_result',
]);
const AUTO_TOOLS_UIA = new Set(['uia_invoke', 'uia_set_value', 'uia_get_tree']);

function backendFor(meta) {
  if (!meta) return null;
  return meta.type === 'electron' && meta.port ? 'cdp' : 'uia';
}

function truncateText(s, n = 40) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// What did a $capture.fN ref point at? Resolve back to the capturing step's
// query so a "Click it" reads as "Click 'example-community - Screenshot Community'".
function refTargetLabel(ref, steps) {
  const m = /^\$([A-Za-z0-9_]+)\.[efu]\d+$/.exec(String(ref || ''));
  if (m) {
    const src = (steps || []).find(s => s && s.capture === m[1]);
    if (src && src.args && src.args.query) return `"${truncateText(src.args.query, 50)}"`;
  }
  return null;
}

// Deterministic fallback used when a step has no model-written description
// (older saved recipes, or a step the user pasted via the JSON view).
function humanizeStep(step, steps) {
  const t = step && step.tool;
  const a = (step && step.args) || {};
  const target = () => refTargetLabel(a.ref, steps)
    || (a.automationId ? `"${a.automationId}"` : (a.name ? `"${a.name}"` : 'it'));
  switch (t) {
    case 'cdp_find': return a.query ? `Find "${truncateText(a.query, 50)}"` : 'Find an element';
    case 'cdp_click':
    case 'uia_invoke': return `Click ${target()}`;
    case 'cdp_type':
    case 'cdp_paste':
    case 'uia_set_value': return a.text !== undefined ? `Type "${truncateText(a.text)}"` : 'Type text';
    case 'cdp_press_key': return `Press ${a.key || 'a key'}`;
    case 'cdp_get_text': return 'Read the text shown';
    case 'cdp_get_messages': return `Read the ${a.limit ? `latest ${a.limit} ` : ''}messages`;
    case 'cdp_scroll_to_message': return 'Scroll to that message';
    case 'cdp_scroll_messages':
    case 'cdp_scroll': return 'Scroll the list';
    case 'cdp_get_tree':
    case 'uia_get_tree': return 'Look at the screen again';
    case 'cdp_get_search_results': return 'Read the search results';
    case 'cdp_jump_to_search_result': return 'Open that search result';
    default: return t ? `Run ${t}` : 'Step';
  }
}

// Description the user reads: model-written if present, else the fallback.
function stepText(step, steps) {
  const d = step && typeof step.description === 'string' ? step.description.trim() : '';
  return d || humanizeStep(step, steps);
}

// Client-side mirror of main.js validateRecipe — used before applying a hand
// edit of the JSON. The authoritative check still runs in the main process.
function validateRecipeClient(steps, backend) {
  if (!Array.isArray(steps)) return 'Recipe must be a JSON array.';
  if (steps.length === 0) return 'Recipe is empty.';
  const allowed = backend === 'uia' ? AUTO_TOOLS_UIA
    : backend === 'cdp' ? AUTO_TOOLS_CDP
    : new Set([...AUTO_TOOLS_CDP, ...AUTO_TOOLS_UIA]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) return `Step ${i + 1} is not an object.`;
    if (typeof s.tool !== 'string') return `Step ${i + 1} is missing a "tool".`;
    if (!allowed.has(s.tool)) return `Step ${i + 1} uses an unknown tool: ${s.tool}`;
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) return `Step ${i + 1} "args" must be an object.`;
    if (s.capture !== undefined && typeof s.capture !== 'string') return `Step ${i + 1} "capture" must be text.`;
    if (s.description !== undefined && typeof s.description !== 'string') return `Step ${i + 1} "description" must be text.`;
  }
  return null;
}

let stepEditToken = 0;        // bumps on every open/close, invalidates stale edits

// Render the plain-English step list + sync the JSON textarea from reviewState.
function renderReviewSteps() {
  if (!reviewState) return;
  const steps = Array.isArray(reviewState.steps) ? reviewState.steps : [];
  const editable = !reviewState.isError;
  autoReviewCount.textContent = steps.length;
  let html;
  if (steps.length === 0) {
    html = `<div class="auto-modal-step-empty">No steps in this recipe.</div>`;
  } else {
    html = steps.map((s, i) => `
      <div class="auto-modal-step" data-i="${i}">
        <span class="auto-modal-step-idx">${i + 1}</span>
        <span class="auto-modal-step-text" data-edit="${i}">${escapeHtml(stepText(s, steps))}</span>
        <button class="auto-modal-step-edit-btn" data-edit="${i}" title="Change this step">&#9998;</button>
        <button class="auto-modal-step-del-btn" data-del="${i}" title="Remove this step">&#10005;</button>
      </div>`).join('');
  }
  // The add-step affordance lives inside autoReviewSteps so it survives the
  // innerHTML rebuild. Hidden in error mode (there's nothing to add to).
  if (editable) {
    html += `<button class="auto-modal-step-add-btn" data-add-step type="button">+ Add step</button>`;
  }
  autoReviewSteps.innerHTML = html;
  autoReviewJson.value = JSON.stringify(steps, null, 2);
  // any open inline editor is now stale
  stepEditToken++;
}

// Persist edits made while VIEWING a saved automation (it already has an id).
async function persistReviewSteps() {
  if (!reviewState || !reviewState.readOnly || !reviewState.id) return;
  await window.automation.update({
    exe: reviewState.meta.exe,
    id: reviewState.id,
    steps: reviewState.steps,
  });
  refreshAutomationsForApp(reviewState.meta.exe);
}

// Open the inline editor on a step row.
function openStepEditor(idx) {
  if (!reviewState) return;
  const row = autoReviewSteps.querySelector(`.auto-modal-step[data-i="${idx}"]`);
  if (!row || row.classList.contains('editing')) return;
  const myToken = ++stepEditToken;
  const current = stepText(reviewState.steps[idx], reviewState.steps);
  row.classList.add('editing');
  row.innerHTML = `
    <textarea class="auto-modal-step-editor" rows="2"></textarea>
    <div class="auto-modal-step-edit-hint">Describe what this step should do, in plain English. ChatGPT rewrites it for you.</div>
    <div class="auto-modal-step-edit-error" style="display:none;"></div>
    <div class="auto-modal-step-edit-actions">
      <button class="ghost-btn primary" data-step-save>Update step</button>
      <button class="ghost-btn" data-step-cancel>Cancel</button>
    </div>`;
  const ta = row.querySelector('.auto-modal-step-editor');
  const errEl = row.querySelector('.auto-modal-step-edit-error');
  const saveBtn = row.querySelector('[data-step-save]');
  const cancelBtn = row.querySelector('[data-step-cancel]');
  ta.value = current;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => { if (stepEditToken === myToken) renderReviewSteps(); };
  cancelBtn.addEventListener('click', close);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
  });

  saveBtn.addEventListener('click', async () => {
    const instruction = ta.value.trim();
    if (!instruction) { errEl.textContent = 'Type what the step should do.'; errEl.style.display = ''; return; }
    errEl.style.display = 'none';
    saveBtn.disabled = true; cancelBtn.disabled = true;
    saveBtn.innerHTML = `<span class="spinner"></span> Updating…`;
    try {
      const res = await window.automation.editStep({
        meta: reviewState.meta,
        backend: reviewState.backend,
        steps: reviewState.steps,
        index: idx,
        instruction,
      });
      if (stepEditToken !== myToken || !reviewState) return; // editor was abandoned
      reviewState.steps = res.steps;
      try { await persistReviewSteps(); } catch (e) { /* surfaced below */ throw e; }
      renderReviewSteps();
    } catch (err) {
      if (stepEditToken !== myToken) return;
      errEl.textContent = (err && err.message) ? err.message : String(err);
      errEl.style.display = '';
      saveBtn.disabled = false; cancelBtn.disabled = false;
      saveBtn.textContent = 'Update step';
    }
  });
}

// Remove a step from the recipe (plain-English view). Persists immediately when
// viewing a saved automation; updates the in-memory draft otherwise (Save
// applies it). A recipe must keep at least one step — to drop them all, delete
// the whole automation from the Automations list.
async function removeStep(idx) {
  if (!reviewState || reviewState.isError) return;
  const steps = Array.isArray(reviewState.steps) ? reviewState.steps : [];
  if (idx < 0 || idx >= steps.length) return;
  if (steps.length <= 1) {
    autoReviewError.textContent = 'An automation needs at least one step. Delete the whole automation instead.';
    autoReviewError.classList.add('visible');
    return;
  }
  const label = stepText(steps[idx], steps);
  if (!confirm(`Remove this step?\n\n${idx + 1}. ${label}`)) return;
  const prev = steps;
  reviewState.steps = steps.slice(0, idx).concat(steps.slice(idx + 1));
  try {
    await persistReviewSteps();
  } catch (err) {
    reviewState.steps = prev; // roll back if the saved copy couldn't be updated
    autoReviewError.textContent = err.message || String(err);
    autoReviewError.classList.add('visible');
    renderReviewSteps();
    return;
  }
  autoReviewError.classList.remove('visible');
  renderReviewSteps();
}

// Open an inline editor to author a NEW step, appended to the end. The model
// turns the plain-English instruction into one or more real steps (mirrors the
// edit-step flow). The step is spliced in via automation.addStep.
function openAddStepEditor() {
  if (!reviewState || reviewState.isError) return;
  const addBtn = autoReviewSteps.querySelector('[data-add-step]');
  if (!addBtn) return;
  const myToken = ++stepEditToken;
  const insertIndex = Array.isArray(reviewState.steps) ? reviewState.steps.length : 0;

  const row = document.createElement('div');
  row.className = 'auto-modal-step editing adding';
  row.innerHTML = `
    <textarea class="auto-modal-step-editor" rows="2" placeholder="e.g. Open the Settings panel"></textarea>
    <div class="auto-modal-step-edit-hint">Describe the new step in plain English. ChatGPT turns it into actions and adds it to the end.</div>
    <div class="auto-modal-step-edit-error" style="display:none;"></div>
    <div class="auto-modal-step-edit-actions">
      <button class="ghost-btn primary" data-step-add-save>Add step</button>
      <button class="ghost-btn" data-step-add-cancel>Cancel</button>
    </div>`;
  addBtn.replaceWith(row);
  const ta = row.querySelector('.auto-modal-step-editor');
  const errEl = row.querySelector('.auto-modal-step-edit-error');
  const saveBtn = row.querySelector('[data-step-add-save]');
  const cancelBtn = row.querySelector('[data-step-add-cancel]');
  ta.focus();

  const close = () => { if (stepEditToken === myToken) renderReviewSteps(); };
  cancelBtn.addEventListener('click', close);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
  });

  saveBtn.addEventListener('click', async () => {
    const instruction = ta.value.trim();
    if (!instruction) { errEl.textContent = 'Type what the new step should do.'; errEl.style.display = ''; return; }
    errEl.style.display = 'none';
    saveBtn.disabled = true; cancelBtn.disabled = true;
    saveBtn.innerHTML = `<span class="spinner"></span> Adding…`;
    try {
      const res = await window.automation.addStep({
        meta: reviewState.meta,
        backend: reviewState.backend,
        steps: reviewState.steps,
        index: insertIndex,
        instruction,
      });
      if (stepEditToken !== myToken || !reviewState) return; // editor was abandoned
      reviewState.steps = res.steps;
      try { await persistReviewSteps(); } catch (e) { /* surfaced below */ throw e; }
      renderReviewSteps();
    } catch (err) {
      if (stepEditToken !== myToken) return;
      errEl.textContent = (err && err.message) ? err.message : String(err);
      errEl.style.display = '';
      saveBtn.disabled = false; cancelBtn.disabled = false;
      saveBtn.textContent = 'Add step';
    }
  });
}

function openAutomateConfirm(msg) {
  if (!msg || !chatMetaStore[chatCurrentExe]) return;
  pendingAutomation = {
    meta: chatMetaStore[chatCurrentExe],
    userMsg: msg.userMsg || '',
    finalReply: msg.content || '',
    trail: msg.trail || [],
  };
  autoConfirmUser.textContent = pendingAutomation.userMsg || '(no prior user message)';
  autoConfirmReply.textContent = (pendingAutomation.finalReply || '').slice(0, 400);
  autoConfirmCount.textContent = pendingAutomation.trail.length;
  autoConfirmPlural.textContent = pendingAutomation.trail.length === 1 ? '' : 's';
  autoConfirmTrail.innerHTML = pendingAutomation.trail.map((t, i) => {
    const err = t.result && t.result.error;
    return `<div class="auto-modal-trail-row${err ? ' err' : ''}">
      <span class="auto-modal-trail-idx">${i + 1}.</span>
      <span class="auto-modal-trail-name">${escapeHtml(t.name)}</span>
      <span class="auto-modal-trail-args">${escapeHtml(summariseArgs(t.args))} → ${escapeHtml(summariseResult(t.result))}</span>
    </div>`;
  }).join('');
  showAutoModal(autoConfirmModal);
}

function closeAutomateConfirm() {
  hideAutoModal(autoConfirmModal);
  pendingAutomation = null;
}

autoConfirmClose.addEventListener('click', closeAutomateConfirm);
autoConfirmCancel.addEventListener('click', closeAutomateConfirm);

autoConfirmGo.addEventListener('click', async () => {
  if (!pendingAutomation) return;
  const payload = pendingAutomation;
  closeAutomateConfirm();
  autoProgressText.textContent = 'Connecting…';
  showAutoModal(autoProgressModal);
  try {
    const result = await window.automation.create(payload);
    hideAutoModal(autoProgressModal);
    activeCodexJob = null;
    openRecipeReview({
      meta: payload.meta,
      userMsg: payload.userMsg,
      finalReply: payload.finalReply,
      steps: result.steps,
      backend: result.backend,
    });
  } catch (err) {
    hideAutoModal(autoProgressModal);
    activeCodexJob = null;
    showCreateError(err.message || String(err), payload);
  }
});

autoProgressCancel.addEventListener('click', async () => {
  if (activeCodexJob) {
    try { await window.automation.cancelCreate(activeCodexJob); } catch {}
  }
  hideAutoModal(autoProgressModal);
  activeCodexJob = null;
});

window.automation.onCodexProgress((data) => {
  if (data && data.jobId && !activeCodexJob) activeCodexJob = data.jobId;
  if (data && data.bytes !== undefined) {
    autoProgressText.textContent = `Receiving response… ${data.bytes} bytes`;
  } else if (data && data.status) {
    autoProgressText.textContent = data.status;
  }
});

// Collapse the technical (JSON) view back to its default hidden state.
function resetReviewJsonView() {
  autoReviewJsonWrap.hidden = true;
  autoReviewToggleJson.innerHTML = '&#9656; Show technical view (JSON)';
  autoReviewJsonError.textContent = '';
  autoReviewJsonError.classList.remove('visible');
}

function showCreateError(msg, payload) {
  // Reuse review modal layout for error display
  reviewState = { meta: payload.meta, steps: [], userMsg: payload.userMsg, finalReply: payload.finalReply, isError: true };
  autoReviewName.value = '';
  autoReviewName.disabled = false;
  renderReviewSteps();
  autoReviewError.textContent = msg;
  autoReviewError.classList.add('visible');
  autoReviewSave.style.display = 'none';
  autoReviewDiscard.textContent = 'Close';
  autoReviewToggleJson.style.display = 'none';
  resetReviewJsonView();
  showAutoModal(autoReviewModal);
}

function openRecipeReview({ meta, userMsg, finalReply, steps, backend }) {
  reviewState = { meta, steps, userMsg, finalReply, backend: backend || backendFor(meta), isError: false };
  autoReviewName.value = suggestName(userMsg);
  autoReviewName.disabled = false;
  renderReviewSteps();
  autoReviewError.textContent = '';
  autoReviewError.classList.remove('visible');
  autoReviewSave.style.display = '';
  autoReviewDiscard.textContent = 'Discard';
  autoReviewToggleJson.style.display = '';
  resetReviewJsonView();
  showAutoModal(autoReviewModal);
  setTimeout(() => autoReviewName.focus(), 100);
}

function suggestName(userMsg) {
  const cleaned = String(userMsg || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Automation';
  return cleaned.length > 60 ? cleaned.slice(0, 57) + '…' : cleaned;
}

autoReviewClose.addEventListener('click', () => { hideAutoModal(autoReviewModal); reviewState = null; });
autoReviewDiscard.addEventListener('click', () => { hideAutoModal(autoReviewModal); reviewState = null; });

autoReviewSave.addEventListener('click', async () => {
  if (!reviewState || reviewState.isError) return;
  try {
    await window.automation.save({
      exe: reviewState.meta.exe,
      name: autoReviewName.value.trim() || suggestName(reviewState.userMsg),
      steps: reviewState.steps,
      userMsg: reviewState.userMsg,
      finalReply: reviewState.finalReply,
    });
    hideAutoModal(autoReviewModal);
    reviewState = null;
    // Surface a short status in chat
    addChatMessage('system', 'Automation saved. Find it in the Automations tab.');
    refreshAutomationsForApp(chatCurrentExe);
  } catch (err) {
    autoReviewError.textContent = err.message || String(err);
    autoReviewError.classList.add('visible');
  }
});

// Click a step (text or pencil) to edit it in plain English.
autoReviewSteps.addEventListener('click', (e) => {
  if (!reviewState || reviewState.isError) return;
  if (e.target.closest('[data-add-step]')) { openAddStepEditor(); return; }
  const delT = e.target.closest('[data-del]');
  if (delT) {
    const di = parseInt(delT.dataset.del, 10);
    if (Number.isInteger(di)) removeStep(di);
    return;
  }
  const t = e.target.closest('[data-edit]');
  if (!t) return;
  const idx = parseInt(t.dataset.edit, 10);
  if (Number.isInteger(idx)) openStepEditor(idx);
});

// Toggle the technical (JSON) view.
autoReviewToggleJson.addEventListener('click', () => {
  const willShow = autoReviewJsonWrap.hidden;
  autoReviewJsonWrap.hidden = !willShow;
  autoReviewToggleJson.innerHTML = willShow ? '&#9662; Hide technical view (JSON)' : '&#9656; Show technical view (JSON)';
  if (willShow && reviewState) {
    autoReviewJson.value = JSON.stringify(reviewState.steps || [], null, 2);
    autoReviewJsonError.textContent = '';
    autoReviewJsonError.classList.remove('visible');
  }
});

// Apply hand-edited JSON back into the recipe.
autoReviewJsonSave.addEventListener('click', async () => {
  if (!reviewState || reviewState.isError) return;
  let parsed;
  try { parsed = JSON.parse(autoReviewJson.value); }
  catch (err) {
    autoReviewJsonError.textContent = 'That is not valid JSON: ' + (err.message || err);
    autoReviewJsonError.classList.add('visible');
    return;
  }
  const problem = validateRecipeClient(parsed, reviewState.backend);
  if (problem) {
    autoReviewJsonError.textContent = problem;
    autoReviewJsonError.classList.add('visible');
    return;
  }
  reviewState.steps = parsed;
  try {
    await persistReviewSteps();
  } catch (err) {
    autoReviewJsonError.textContent = err.message || String(err);
    autoReviewJsonError.classList.add('visible');
    return;
  }
  autoReviewJsonError.textContent = '';
  autoReviewJsonError.classList.remove('visible');
  renderReviewSteps();
});

// Hook into existing chat-actions click delegation
chatMessagesEl.addEventListener('click', (e) => {
  const actBtn = e.target.closest('.chat-action-btn[data-act="automate"]');
  if (!actBtn) return;
  const actions = actBtn.closest('.chat-actions');
  const i = parseInt(actions.dataset.i, 10);
  const msgs = chatStore[chatCurrentExe] || [];
  const msg = msgs[i];
  if (!msg) return;
  openAutomateConfirm(msg);
});

// ── Automations tab: disk-backed list, run, delete ──

async function refreshAutomationsForApp(exe) {
  if (!exe) return;
  try {
    automationsStore[exe] = await window.automation.list(exe);
  } catch (err) {
    console.error('automation:list failed', err);
    automationsStore[exe] = [];
  }
  if (workspaceView === 'automations' && automationDrillExe === exe) renderWorkspace();
}

async function refreshAllAutomations() {
  const exes = [
    ...currentApps.filter(a => a.cdpAlive).map(a => a.Exe),
    ...cachedUiaApps.filter(a => selectedUiaExes.has(a.Exe)).map(a => a.Exe),
  ];
  for (const exe of exes) {
    try { automationsStore[exe] = await window.automation.list(exe); }
    catch {}
  }
  if (workspaceView === 'automations') renderWorkspace();
}

const __origRenderAutomationsList = renderAutomationsList;
renderAutomationsList = function (list) {
  if (!list || list.length === 0) {
    workspaceList.innerHTML = `<div class="automation-empty">No automations yet for this app.<br><span style="opacity:.7">Run a task in chat, then click the ⚡ button on the reply.</span></div>`;
    return;
  }
  workspaceList.innerHTML = list.map(a => {
    const sub = `${a.steps.length} step${a.steps.length === 1 ? '' : 's'} · saved ${formatRelative(a.createdAt)}`;
    return `
      <div class="automation-entry" data-id="${escapeHtml(a.id)}">
        <div class="automation-entry-info">
          <div class="automation-entry-name">${escapeHtml(a.name)}</div>
          <div class="automation-entry-sub" title="${escapeHtml(a.userMsg || '')}">${escapeHtml(sub)}</div>
        </div>
        <div class="automation-entry-actions">
          <button class="automation-entry-btn run" data-act="run">▶ Run</button>
          <button class="automation-entry-btn" data-act="view">View</button>
          <button class="automation-entry-btn danger" data-act="delete">Delete</button>
        </div>
      </div>`;
  }).join('');
  workspaceList.querySelectorAll('.automation-entry').forEach(row => {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = row.dataset.id;
      const act = btn.dataset.act;
      handleAutomationAction(act, id);
    });
  });
};

function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

async function handleAutomationAction(act, id) {
  const exe = automationDrillExe;
  if (!exe) return;
  const list = automationsStore[exe] || [];
  const entry = list.find(a => a.id === id);
  if (!entry) return;

  if (act === 'delete') {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    try {
      await window.automation.remove({ exe, id });
      await refreshAutomationsForApp(exe);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
    return;
  }
  if (act === 'view') {
    const meta = resolveAppMeta(exe, entry.name);
    reviewState = { meta, steps: entry.steps.slice(), userMsg: entry.userMsg, finalReply: entry.finalReply, backend: backendFor(meta), isError: false, readOnly: true, id: entry.id };
    autoReviewName.value = entry.name;
    autoReviewName.disabled = true;
    renderReviewSteps();
    autoReviewError.textContent = '';
    autoReviewError.classList.remove('visible');
    autoReviewSave.style.display = 'none';
    autoReviewDiscard.textContent = 'Close';
    autoReviewToggleJson.style.display = '';
    resetReviewJsonView();
    showAutoModal(autoReviewModal);
    return;
  }
  if (act === 'run') {
    const meta = resolveAppMeta(exe, entry.name);
    if (meta.type === 'electron' && !meta.port) {
      alert('This app needs CDP enabled to run automations. Enable it from the Browse drawer.');
      return;
    }
    runAutomation(entry, meta);
  }
}

let runStepTexts = [];   // plain-English label per step for the active run

function runAutomation(entry, meta) {
  autoRunTitle.textContent = `Running: ${entry.name}`;
  autoRunLog.innerHTML = '';
  autoRunError.textContent = '';
  autoRunError.classList.remove('visible');
  autoRunStop.style.display = '';
  autoRunDone.style.display = 'none';
  autoRunClose.style.display = 'none';
  showAutoModal(autoRunModal);
  // Pre-fill rows so user sees the plan, in plain English
  runStepTexts = entry.steps.map((s) => stepText(s, entry.steps));
  entry.steps.forEach((s, i) => {
    appendRunRow(i, runStepTexts[i], '', 'pending');
  });
  window.automation.run({ exe: meta.exe, id: entry.id, meta })
    .then((r) => {
      // run-done event will fire via SSE
      if (r && r.ok === false && !activeRunId) {
        // Synchronous failure without a runId — show error
        autoRunError.textContent = r.error || 'failed';
        autoRunError.classList.add('visible');
        autoRunStop.style.display = 'none';
        autoRunDone.style.display = '';
        autoRunClose.style.display = '';
      }
    })
    .catch((err) => {
      autoRunError.textContent = err.message || String(err);
      autoRunError.classList.add('visible');
      autoRunStop.style.display = 'none';
      autoRunDone.style.display = '';
      autoRunClose.style.display = '';
    });
}

function appendRunRow(i, name, argsDesc, status, detail) {
  const id = `auto-run-row-${i}`;
  let row = document.getElementById(id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'auto-modal-runlog-row';
    row.id = id;
    row.innerHTML = `
      <span class="auto-modal-runlog-idx">${i + 1}.</span>
      <span class="auto-modal-runlog-name"></span>
      <span class="auto-modal-runlog-status"></span>
      <span class="auto-modal-runlog-detail"></span>`;
    autoRunLog.appendChild(row);
  }
  row.querySelector('.auto-modal-runlog-name').textContent = name;
  const statusEl = row.querySelector('.auto-modal-runlog-status');
  statusEl.className = `auto-modal-runlog-status ${status}`;
  statusEl.textContent = status === 'pending' ? '…' : status === 'start' ? '▶' : status === 'ok' ? '✓' : status === 'error' ? '✕' : status === 'stopped' ? '◼' : '';
  const detailEl = row.querySelector('.auto-modal-runlog-detail');
  detailEl.textContent = detail !== undefined ? detail : argsDesc;
  autoRunLog.scrollTop = autoRunLog.scrollHeight;
}

window.automation.onRunStart((data) => {
  activeRunId = data && data.runId;
});

window.automation.onRunStep((data) => {
  if (!data) return;
  const detail = data.status === 'error'
    ? `error: ${data.error || ''}`
    : data.status === 'ok' && data.result
      ? summariseResult(data.result)
      : summariseArgs(data.args || {});
  const label = runStepTexts[data.i] || data.name;
  appendRunRow(data.i, label, '', data.status, detail);
});

window.automation.onRunDone((data) => {
  activeRunId = null;
  autoRunStop.style.display = 'none';
  autoRunDone.style.display = '';
  autoRunClose.style.display = '';
  if (data && data.ok === false) {
    autoRunError.textContent = data.error || 'failed';
    autoRunError.classList.add('visible');
  }
});

autoRunStop.addEventListener('click', () => {
  if (activeRunId) window.automation.stop(activeRunId);
  autoRunStop.style.display = 'none';
});
autoRunClose.addEventListener('click', () => { hideAutoModal(autoRunModal); });
autoRunDone.addEventListener('click', () => { hideAutoModal(autoRunModal); });

// Reset name input disable state when reopening
autoReviewModal.addEventListener('animationstart', () => {
  if (!reviewState || !reviewState.readOnly) autoReviewName.disabled = false;
});

// Refresh automations whenever the Automations view becomes active
const __origWorkspaceViewToggle = workspaceViewToggle;
__origWorkspaceViewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-btn');
  if (!btn) return;
  if (btn.dataset.saView === 'automations') refreshAllAutomations();
});

// Also refresh when drilling into a specific app's automations
const __origRenderWorkspace = renderWorkspace;
renderWorkspace = function () {
  __origRenderWorkspace.call(this);
  if (workspaceView === 'automations' && automationDrillExe && !automationsStore[automationDrillExe]) {
    refreshAutomationsForApp(automationDrillExe);
  }
};

// ── Init ──
refreshApps();

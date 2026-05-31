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
// Persisted across windows (overlay + main share the file:// origin localStorage)
// so the overlay's "selected apps only" list includes Win32 picks made in the
// main window. Electron picks persist separately via cdpAlive / cdp-state.json.
const UIA_SEL_KEY = 'autobot.selectedUiaExes';
function loadSelectedUiaExes() {
  try {
    const raw = localStorage.getItem(UIA_SEL_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function saveSelectedUiaExes() {
  try { localStorage.setItem(UIA_SEL_KEY, JSON.stringify([...selectedUiaExes])); } catch {}
}
let selectedUiaExes    = loadSelectedUiaExes();

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

// True when an enumerated Windows app is the ChatGPT desktop app — used to
// hide it everywhere (Apps grid, drawer, launcher candidates). Direct chat
// supersedes app-scoped automation of ChatGPT: see SPEC.md and CLAUDE.md.
// Matches the same loose patterns the old findGptApp used so renames and
// minor branding tweaks (ChatGPT, ChatGPT Desktop, GPT, etc.) all hit.
function isChatGptApp(app) {
  if (!app) return false;
  const name = String(app.Name || app.name || '').toLowerCase();
  const exe  = String(app.Exe  || app.exe  || '').toLowerCase();
  return /chat\s*gpt/.test(name) || /\bgpt\b/.test(name) || /chatgpt/.test(exe);
}

// Mirror of appKey() in main.js — derive the canonical per-app key from an exe
// path so the /app pill carries the same key the backend registers under.
function appKeyFor(exe) {
  exe = String(exe || '');
  const baseFull = exe.split(/[\\/]/).pop() || '';
  const dot = baseFull.lastIndexOf('.');
  const base = (dot > 0 ? baseFull.slice(0, dot) : baseFull).toLowerCase();
  const slug = base.replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'app';
  let h = 0;
  for (let i = 0; i < exe.length; i++) h = (h * 31 + exe.charCodeAt(i)) | 0;
  const suffix = Math.abs(h).toString(36).slice(0, 6);
  return `${slug}_${suffix}`;
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

let refreshAppsInFlight = null;
async function refreshApps(fromDrawer = false) {
  // Coalesce concurrent calls. Without this, a hotkey-triggered refresh that
  // arrives while the initial preload refresh is still running would early-
  // return on `drawerBusy`, resolving to undefined immediately. The overlay's
  // `.then(refreshSuggestions)` would then run against still-empty
  // currentApps/cachedUiaApps and the launcher would show no selected apps.
  // Returning the in-flight promise makes the caller wait for real data.
  if (refreshAppsInFlight) {
    if (fromDrawer) drawerRefresh.classList.add('spinning');
    try { return await refreshAppsInFlight; }
    finally { if (fromDrawer) drawerRefresh.classList.remove('spinning'); }
  }
  drawerBusy = true;
  if (fromDrawer) drawerRefresh.classList.add('spinning');

  refreshAppsInFlight = (async () => {
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
    }
  })();

  try { await refreshAppsInFlight; }
  finally {
    drawerBusy = false;
    drawerRefresh.classList.remove('spinning');
    refreshAppsInFlight = null;
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

  const electron = currentApps.filter(app => !isChatGptApp(app) && match(app));
  const uia = cachedUiaApps.filter(app => !isChatGptApp(app) && match(app));
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
    saveSelectedUiaExes();
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

  const selectedElectron = currentApps.filter(a => a.cdpAlive && !isChatGptApp(a));
  const selectedUia = cachedUiaApps.filter(a => selectedUiaExes.has(a.Exe) && !isChatGptApp(a));
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

  const iconHtml = app.Icon
    ? `<img class="app-icon" src="${app.Icon}" alt="" />`
    : `<div class="app-icon app-icon-fallback">${escapeHtml((app.Name || '?').trim().charAt(0).toUpperCase() || '?')}</div>`;

  return `
    <div class="app-card ${cls}"
         data-exe="${escapeHtml(app.Exe)}"
         data-name="${escapeHtml(app.Name)}"
         style="--row-i:${i}">
      ${iconHtml}
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

// Sentinel "exe" used for the direct GPT-5.5 chat (no real app is selected).
// Mirrors DIRECT_CHAT_ID in main.js — all chat:* IPC events carry this same
// string in `data.exe`, so chatStore / chatMetaStore / event filtering all key
// off it identically to a real exe path. Real exe paths are absolute Windows
// paths so this sentinel will never collide.
const DIRECT_CHAT_ID   = '__direct__';
const DIRECT_CHAT_NAME = 'Direct chat — GPT-5.5';

let chatCurrentExe     = null;
let chatStore          = {};        // exe → [{role, content, reasoning?, reasoningMs?, sources?}]
let chatMetaStore      = {};
let chatStreamContent  = '';
let chatStreamExe      = null;
let chatBusy           = false;
let chatStreamSources  = [];        // collected URL citations for the streaming assistant msg

let thinkingBuffer     = '';
let thinkingFallback   = '';
let reasoningStartMs   = 0;
let lastUserMessage    = '';
let lastRenderedCount  = 0;        // last msg count rendered; used to flag fresh bubbles
let chatStreamEl       = null;     // ref to currently-streaming assistant bubble

// Empty-state source of truth. Composer-only mode kicks in when the thread is
// empty AND no stream is mid-flight. Used by sizing + CSS class toggling.
function chatIsEmpty() {
  const msgs = (chatStore && chatCurrentExe && chatStore[chatCurrentExe]) || [];
  return msgs.length === 0 && !chatStreamContent;
}

function updateChatEmptyClass() {
  if (!pageChat) return;
  const empty = chatIsEmpty();
  pageChat.classList.toggle('chat-empty', empty);
  // Inline overlay chat: same flag on .launcher-card so the moved #chat-scroll
  // can collapse in empty state (the original pageChat.chat-empty selectors no
  // longer match because chat-scroll has been reparented out of #page-chat).
  const card = document.getElementById('launcher-card');
  if (card) {
    const wasEmpty = card.classList.contains('chat-empty');
    card.classList.toggle('chat-empty', empty);
    // On the empty→non-empty flip, bypass the MutationObserver's 60ms debounce
    // so the window grows up in the same frame as the bubble appears.
    if (wasEmpty !== empty && typeof window.__overlaySizeForChat === 'function') {
      window.__overlaySizeForChat({ immediate: true });
    }
  }
}

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

async function openChat(appName, exe, metaOverride) {
  chatCurrentExe = exe;
  chatAppNameEl.textContent = appName;
  if (!chatStore[exe]) chatStore[exe] = [];
  // Prefer caller-supplied meta (overlay's selApp carries the live CDP port
  // captured at selection time) to avoid a resolveAppMeta race when
  // currentApps has been mutated by an in-flight refreshApps().
  let meta;
  if (metaOverride && metaOverride.type) {
    meta = { exe, name: appName, type: metaOverride.type, pid: metaOverride.pid || null, port: metaOverride.port || null };
    // Fall back to resolveAppMeta only if override lacks a port for an electron app
    // (e.g. CDP died between selection and submit) — try to recover a fresh port.
    if (meta.type === 'electron' && !meta.port) {
      const resolved = resolveAppMeta(exe, appName);
      if (resolved.port) meta = resolved;
    }
  } else {
    meta = resolveAppMeta(exe, appName);
  }
  chatMetaStore[exe] = meta;
  chatWelcomeSub.textContent = meta.type === 'electron'
    ? `Scoped to ${appName}. CDP active — I can read DOM, click, type, scroll.`
    : `Scoped to ${appName}. UIA active — I can read UI tree, invoke, set values.`;
  switchPage('chat');
  renderChat();
  chatInput.focus();
  refreshWindowPicker(meta);
  // Persist the currently-bound exe for the overlay's restore-on-reopen path.
  // sessionStorage is per-window; harmless in the main window (no view='chat'
  // key is ever written there, so the restore branch never fires).
  try { sessionStorage.setItem('autobot.overlay.exe', String(exe || '')); } catch {}
  try { await window.agent.ensure(meta); } catch (err) { console.error('agent:ensure', err); }
}

// Open the direct GPT-5.5 chat (no app selected). Hydrates the in-memory store
// from logs/direct-gpt.json so the conversation survives an app restart, then
// hands off to the same chat UI the app-scoped flow uses. The window picker is
// hidden and agent.ensure is skipped — direct mode has no app context.
async function openDirectChat() {
  chatCurrentExe = DIRECT_CHAT_ID;
  chatAppNameEl.textContent = DIRECT_CHAT_NAME;
  const meta = { exe: DIRECT_CHAT_ID, name: 'GPT-5.5', type: 'direct', pid: null, port: null };
  chatMetaStore[DIRECT_CHAT_ID] = meta;
  chatWelcomeSub.textContent = 'Talking directly to GPT-5.5. No app context — ask anything. Web search is on; attached files work.';
  try {
    const state = await window.chat.loadDirect();
    const messages = (state && Array.isArray(state.messages)) ? state.messages : [];
    chatStore[DIRECT_CHAT_ID] = messages.map(m => ({ role: m.role, content: m.content }));
  } catch (err) {
    console.warn('loadDirect failed', err);
    if (!chatStore[DIRECT_CHAT_ID]) chatStore[DIRECT_CHAT_ID] = [];
  }
  switchPage('chat');
  hideWindowPicker();
  renderChat();
  chatInput.focus();
  // Persist exe for the overlay restore-on-reopen path (see openChat).
  try { sessionStorage.setItem('autobot.overlay.exe', DIRECT_CHAT_ID); } catch {}
}

chatBackBtn.addEventListener('click', () => switchPage('workspace'));

// ── Window picker (multi-window apps, e.g. several Chrome windows) ──
// Surfaces above the composer ONLY when the open chat is scoped to an Electron
// app with live CDP that currently exposes more than one window/tab. Picking a
// window calls chat:select-window, which sets the same per-port active target
// the model's cdp_select_window tool uses — so every snapshot/click/type after
// the choice acts on the window the user picked.
const windowPicker      = document.getElementById('chat-window-picker');
const cwpTrigger        = document.getElementById('cwp-trigger');
const cwpTriggerLabel   = document.getElementById('cwp-trigger-label');
const cwpTriggerMeta    = document.getElementById('cwp-trigger-meta');
const cwpPanel          = document.getElementById('cwp-panel');
const cwpPanelTitle     = document.getElementById('cwp-panel-title');
const cwpRefresh        = document.getElementById('cwp-refresh');
const cwpList           = document.getElementById('cwp-list');

let cwpMeta             = null;   // meta of the app the picker is bound to
let cwpWindows         = [];     // [{index, id, title, url, active}]
let cwpActiveId        = null;   // id of the currently selected window
let cwpOpen            = false;
let cwpBusy            = false;
let cwpToken           = 0;       // invalidates stale async loads on app switch

const CWP_CHECK_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function hostFromUrl(u) {
  try { return new URL(u).host || ''; } catch { return ''; }
}

function hideWindowPicker() {
  closeWindowPanel();
  windowPicker.hidden = true;
  windowPicker.classList.remove('intro');
  cwpMeta = null;
  cwpWindows = [];
  cwpActiveId = null;
}

// Pull the live window list for `meta` and show/hide the picker accordingly.
async function refreshWindowPicker(meta, { fromRefreshBtn = false } = {}) {
  // Only meaningful for an Electron app with CDP alive.
  if (!meta || meta.type !== 'electron' || !meta.port) { hideWindowPicker(); return; }
  const myToken = ++cwpToken;
  cwpMeta = meta;
  if (fromRefreshBtn) cwpRefresh.classList.add('spinning');
  try {
    const res = await window.chat.listWindows(meta.port);
    if (myToken !== cwpToken) return; // user switched apps mid-flight
    const windows = (res && Array.isArray(res.windows)) ? res.windows : [];
    // One (or zero) window → nothing to pick; keep the composer uncluttered.
    if (windows.length < 2) { hideWindowPicker(); return; }
    cwpWindows = windows;
    const active = (res && res.active) || windows.find(w => w.active) || null;
    cwpActiveId = active ? active.id : (cwpActiveId || windows[0].id);
    const wasHidden = windowPicker.hidden;
    windowPicker.hidden = false;
    if (wasHidden) {
      windowPicker.classList.remove('intro');
      void windowPicker.offsetWidth; // restart the entrance animation
      windowPicker.classList.add('intro');
    }
    renderWindowPicker();
  } catch (err) {
    console.warn('window picker list failed', err);
    if (myToken === cwpToken) hideWindowPicker();
  } finally {
    if (myToken === cwpToken) cwpRefresh.classList.remove('spinning');
  }
}

function renderWindowPicker() {
  const active = cwpWindows.find(w => w.id === cwpActiveId) || cwpWindows[0] || null;
  if (active) {
    const host = hostFromUrl(active.url);
    cwpTriggerLabel.textContent = active.title || host || 'Untitled window';
    cwpTriggerMeta.textContent = host && host !== (active.title || '') ? host : '';
  } else {
    cwpTriggerLabel.textContent = 'Select a window';
    cwpTriggerMeta.textContent = '';
  }
  const n = cwpWindows.length;
  cwpPanelTitle.textContent = `${n} open window${n === 1 ? '' : 's'}`;

  if (n === 0) {
    cwpList.innerHTML = `<div class="cwp-empty">No open windows detected.</div>`;
    return;
  }
  cwpList.innerHTML = cwpWindows.map((w, i) => {
    const selected = w.id === cwpActiveId;
    const host = hostFromUrl(w.url);
    const title = w.title || host || 'Untitled window';
    const tabs = w.tabCount > 1 ? `${w.tabCount} tabs` : '';
    const sub = [host, tabs].filter(Boolean).join(' · ');
    return `
      <button class="cwp-row${selected ? ' selected' : ''}" type="button" role="option"
              aria-selected="${selected}" data-id="${escapeHtml(w.id)}" style="--row-i:${i}">
        <span class="cwp-row-dot"></span>
        <span class="cwp-row-body">
          <span class="cwp-row-title">${escapeHtml(title)}</span>
          ${sub ? `<span class="cwp-row-url">${escapeHtml(sub)}</span>` : ''}
        </span>
        <span class="cwp-row-check">${selected ? CWP_CHECK_SVG : ''}</span>
      </button>`;
  }).join('');
}

function openWindowPanel() {
  if (cwpOpen) return;
  cwpOpen = true;
  windowPicker.classList.add('open');
  cwpTrigger.setAttribute('aria-expanded', 'true');
  // Refresh the list in the background — windows may have opened/closed since
  // the panel was last populated. The open animation runs immediately.
  if (cwpMeta) refreshWindowPicker(cwpMeta);
}

function closeWindowPanel() {
  if (!cwpOpen) return;
  cwpOpen = false;
  windowPicker.classList.remove('open');
  cwpTrigger.setAttribute('aria-expanded', 'false');
}

cwpTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  cwpOpen ? closeWindowPanel() : openWindowPanel();
});

cwpRefresh.addEventListener('click', (e) => {
  e.stopPropagation();
  if (cwpMeta) refreshWindowPicker(cwpMeta, { fromRefreshBtn: true });
});

cwpList.addEventListener('click', async (e) => {
  const row = e.target.closest('.cwp-row');
  if (!row || cwpBusy) return;
  const id = row.dataset.id;
  if (!id || !cwpMeta || !cwpMeta.port) return;
  if (id === cwpActiveId) { closeWindowPanel(); return; }
  cwpBusy = true;
  const prev = cwpActiveId;
  cwpActiveId = id;             // optimistic — reflect the choice instantly
  renderWindowPicker();
  closeWindowPanel();
  try {
    const res = await window.chat.selectWindow({ port: cwpMeta.port, id });
    if (!res || res.error) {
      cwpActiveId = prev;        // roll back; the window likely closed
      renderWindowPicker();
      refreshWindowPicker(cwpMeta);
    }
  } catch (err) {
    console.warn('window picker select failed', err);
    cwpActiveId = prev;
    renderWindowPicker();
  } finally {
    cwpBusy = false;
  }
});

// Close the panel on an outside click or Escape.
document.addEventListener('click', (e) => {
  if (cwpOpen && !windowPicker.contains(e.target)) closeWindowPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cwpOpen) { e.stopPropagation(); closeWindowPanel(); }
});

async function resetCurrentChat() {
  if (!chatCurrentExe) return;
  if (chatCurrentExe === DIRECT_CHAT_ID) {
    try { await window.chat.resetDirect(); } catch (err) { console.warn('resetDirect failed', err); }
  } else {
    window.chat.reset(chatCurrentExe);
  }
  chatStore[chatCurrentExe] = [];
  chatStreamContent = '';
  chatStreamExe = null;
  chatStreamEl = null;
  chatStreamSources = [];
  thinkingBuffer = '';
  reasoningStartMs = 0;
  hideThinking();
  setChatBusy(false);
  lastRenderedCount = 0;
  renderChat();
  updateChatEmptyClass();
  // In overlay mode, a reset returns to the launcher's "Search an app or type
  // a prompt" view instead of leaving the user staring at the empty-state chat.
  if (typeof window.__enterLauncher === 'function') {
    try { window.__enterLauncher('chat'); return; } catch (err) { console.warn('enterLauncher failed', err); }
  }
  // Shrink overlay window back to composer-only (empty-state height).
  try {
    if (typeof window.__overlaySizeForChat === 'function') {
      window.__overlaySizeForChat({ immediate: true });
    }
  } catch {}
  chatInput.focus();
}

chatNewBtn.addEventListener('click', resetCurrentChat);

function renderChat() {
  const msgs = chatStore[chatCurrentExe] || [];
  const grew = msgs.length > lastRenderedCount;
  if (msgs.length === 0) {
    chatMessagesEl.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </div>
        <p class="chat-welcome-title">Start a conversation</p>
        <p class="chat-welcome-sub">${escapeHtml(chatWelcomeSub.textContent || '')}</p>
      </div>`;
    lastRenderedCount = 0;
    updateChatEmptyClass();
    return;
  }
  chatMessagesEl.innerHTML = msgs.map((m, i) => renderTurn(m, i)).join('');
  // Flag newly-appended bubble with enter animation (only when count grew, so
  // a full rerender on chat entry doesn't replay animations on the history).
  if (grew) {
    const bubbles = chatMessagesEl.querySelectorAll('.chat-msg');
    const last = bubbles[bubbles.length - 1];
    if (last) {
      last.classList.add('bubble-enter');
      setTimeout(() => { try { last.classList.remove('bubble-enter'); } catch {} }, 220);
    }
  }
  lastRenderedCount = msgs.length;
  updateChatEmptyClass();
  scrollChatToBottom();
}

// User text may carry inline tab references as `[tab:<id> "<title>"]` tokens
// (inserted via the /tab pill). Show them as read-only pills in the sent bubble;
// the stored content keeps the raw token so the model and logs see the tab id.
function renderUserContent(content) {
  const esc = escapeHtml(content == null ? '' : String(content));
  // escapeHtml (textContent→innerHTML) escapes & < > but NOT ", so the quotes in
  // the serialised [tab:id "title"] token survive as literal " — match those.
  return esc.replace(/\[tab:([^\s\]]+)\s+(?:&quot;|")([\s\S]*?)(?:&quot;|")\]/g, (_, id, title) => {
    const label = (title && title.trim()) || id;
    return `<span class="chat-tab-pill chat-tab-pill-static" title="${title}">`
      + `<span class="chat-tab-pill-icon">${TAB_GLYPH_SVG}</span>`
      + `<span class="chat-tab-pill-label">${label}</span></span>`;
  }).replace(/\[file:([a-f0-9-]+)\s+(?:&quot;|")([\s\S]*?)(?:&quot;|")\]/g, (_, id, fileName) => {
    const label = fileName || 'file';
    return `<span class="chat-file-pill chat-file-pill-static" title="${label}">`
      + `<span class="chat-file-pill-icon">${FILE_GLYPH_SVG}</span>`
      + `<span class="chat-file-pill-label">${label}</span></span>`;
  }).replace(/\[app:([^\s\]]+)\s+(?:&quot;|")([\s\S]*?)(?:&quot;|")\]/g, (_, key, appName) => {
    const label = (appName && appName.trim()) || key;
    return `<span class="chat-app-pill chat-app-pill-static" title="${label}">`
      + `<span class="chat-app-pill-icon">${APP_GLYPH_SVG}</span>`
      + `<span class="chat-app-pill-label">${label}</span></span>`;
  });
}

function renderTurn(m, i) {
  if (m.role === 'user') {
    return `<div class="chat-msg chat-msg-user">${renderUserContent(m.content)}</div>`;
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
    const sourcesBlock = renderSourcesBlock(m.sources);
    const automatable = canAutomate(m);
    const automateBtn = automatable
      ? `<button class="chat-action-btn automate" data-act="automate" title="Save this task as a reusable automation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          <span class="chat-action-label">Save as automation</span>
        </button>`
      : '';
    const actionsCls = automatable ? 'chat-actions persist' : 'chat-actions';
    const msgBlock = hasContent
      ? `<div class="chat-msg chat-msg-assistant" data-i="${i}">${body}${sourcesBlock}</div>
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

// Footer chips for web_search citations attached to an assistant turn. Empty
// string when there are none so the markup stays clean. Titles fall back to the
// hostname; clicks are routed through window.shell.openExternal (delegated).
function renderSourcesBlock(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const chips = sources.map(s => {
    if (!s || !s.url) return '';
    let host = '';
    try { host = new URL(s.url).host; } catch { host = s.url; }
    const label = (s.title && s.title.trim()) || host;
    return `<a class="chat-source-chip" data-href="${escapeHtml(s.url)}" href="${escapeHtml(s.url)}" title="${escapeHtml(s.url)}" rel="noopener">${escapeHtml(label)}</a>`;
  }).filter(Boolean).join('');
  if (!chips) return '';
  return `<div class="chat-sources"><div class="chat-sources-label">Sources</div><div class="chat-sources-list">${chips}</div></div>`;
}

function addChatMessage(role, content, extras = {}) {
  if (!chatStore[chatCurrentExe]) chatStore[chatCurrentExe] = [];
  chatStore[chatCurrentExe].push({ role, content, ...extras });
  renderChat();
  updateChatEmptyClass();
}

function scrollChatToBottom() {
  chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
}

// Reasoning expand/collapse + actions
chatMessagesEl.addEventListener('click', (e) => {
  // Route http(s) anchors inside chat messages (assistant markdown links,
  // web_search citation chips) through the OS browser. Without this, an in-app
  // click would navigate the renderer window itself and break the chat UI.
  const link = e.target.closest('a[href]');
  if (link) {
    const url = link.dataset.href || link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(url)) {
      e.preventDefault();
      try { window.shell.openExternal(url); } catch (err) { console.warn('openExternal failed', err); }
      return;
    }
  }
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
  // Keep the composer editable + clickable at all times so the user can queue
  // their next message while the model is still streaming. Send is still
  // gated by `if (chatBusy) return` in sendChatMessage.
  chatInput.contentEditable = 'true';
  if (state) {
    closeTabMenu();
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
let chatChunkRaf = 0;
function flushStreamMarkdown() {
  chatChunkRaf = 0;
  const el = document.getElementById('chat-stream-msg');
  if (!el) return;
  el.innerHTML = renderMarkdown(chatStreamContent);
  scrollChatToBottom();
}
window.chat.onChunk((data) => {
  if (data.exe !== chatCurrentExe) return;
  const wasEmpty = !chatStreamContent;
  chatStreamContent += data.delta;
  hideThinking();

  let streamMsg = document.getElementById('chat-stream-msg');
  if (!streamMsg) {
    streamMsg = document.createElement('div');
    streamMsg.id = 'chat-stream-msg';
    streamMsg.className = 'chat-msg chat-msg-assistant streaming';
    chatMessagesEl.appendChild(streamMsg);
    chatStreamEl = streamMsg;
  }
  // Coalesce per-token innerHTML swaps into one rAF. Multiple chunks arriving
  // in the same frame collapse to a single DOM rewrite + MutationObserver
  // burst, which collapses to a single scheduleChatResize call.
  if (!chatChunkRaf) chatChunkRaf = requestAnimationFrame(flushStreamMarkdown);
  if (wasEmpty) updateChatEmptyClass(); // first chunk flips empty→non-empty
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
  if (data.name === 'ask_user') return; // rendered as a clarify card, not a tool line
  hideThinking();
  if (data.name === 'web_search') {
    const q = (data.args && typeof data.args.query === 'string') ? data.args.query.slice(0, 120) : '';
    thinkingFallback = q ? `searching the web for "${q}"…` : 'searching the web…';
    appendToolLine(`🌐 web_search ${escapeHtml(q ? `"${q}"` : '')}`);
    return;
  }
  thinkingFallback = `running ${data.name}…`;
  const summary = formatToolCall(data.name, data.args);
  appendToolLine(`⚙ ${summary}`);
});

// Inline URL citations from the hosted web_search tool. Collected for the
// currently streaming assistant turn, deduplicated by URL, then rendered as a
// Sources footer when chat:done lands. Ignore events for stale streams.
window.chat.onCitation((data) => {
  if (data.exe !== chatStreamExe) return;
  if (!data.url) return;
  if (chatStreamSources.some(s => s.url === data.url)) return;
  chatStreamSources.push({ url: data.url, title: data.title || '' });
});

window.chat.onToolResult((data) => {
  if (data.exe !== chatCurrentExe) return;
  if (data.name === 'ask_user') return; // card already reflects the answer
  const ok = data.result && data.result.ok;
  const err = data.result && data.result.error;
  let msg, fallback;
  if (data.name === 'web_search' && !err) {
    const n = (data.result && (data.result.count || (Array.isArray(data.result.sources) && data.result.sources.length))) || 0;
    msg = `✓ web_search → ${n} source${n === 1 ? '' : 's'}`;
    fallback = `web search returned ${n} source${n === 1 ? '' : 's'}`;
    if (data.result && Array.isArray(data.result.sources)) {
      for (const s of data.result.sources) {
        if (s && s.url && !chatStreamSources.some(x => x.url === s.url)) {
          chatStreamSources.push({ url: s.url, title: s.title || '' });
        }
      }
    }
    appendToolLine(msg);
    thinkingFallback = fallback;
    thinkingBuffer = '';
    showThinking(fallback);
    return;
  }
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

// Clarifying-question card (mid-turn). Appended directly to the message list like
// tool lines — transient until chat:done re-renders, after which the Q&A persists
// via the turn trail (ask_user shows there). Answering does NOT call renderChat.
window.chat.onAsk((data) => {
  if (data.exe !== chatCurrentExe) return;
  hideThinking();

  const old = document.getElementById('chat-clarify-card');
  if (old) old.remove();

  const exe = data.exe;
  const card = document.createElement('div');
  card.className = 'chat-clarify-card';
  card.id = 'chat-clarify-card';

  const q = document.createElement('div');
  q.className = 'chat-clarify-question';
  q.textContent = data.question || 'Which option do you want?';
  card.appendChild(q);

  const opts = Array.isArray(data.options) ? data.options : [];
  if (opts.length) {
    const optsRow = document.createElement('div');
    optsRow.className = 'chat-clarify-options';
    opts.forEach((opt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-clarify-chip';
      chip.textContent = opt;
      chip.addEventListener('click', () => answerClarify(card, opt));
      optsRow.appendChild(chip);
    });
    card.appendChild(optsRow);
  }

  const customRow = document.createElement('div');
  customRow.className = 'chat-clarify-custom';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-clarify-input';
  input.placeholder = opts.length ? 'Or type a custom answer…' : 'Type your answer…';
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'chat-clarify-send';
  sendBtn.innerHTML = CHAT_SEND_ICON;
  sendBtn.disabled = true;
  const sync = () => { sendBtn.disabled = !input.value.trim(); };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) answerClarify(card, input.value); }
  });
  sendBtn.addEventListener('click', () => { if (input.value.trim()) answerClarify(card, input.value); });
  customRow.appendChild(input);
  customRow.appendChild(sendBtn);
  card.appendChild(customRow);

  chatMessagesEl.appendChild(card);
  scrollChatToBottom();
  // Let the user answer via the card; main composer stays disabled (busy).
  setTimeout(() => { try { input.focus(); } catch {} }, 0);

  card._exe = exe;
});

function answerClarify(card, answer) {
  const text = (answer || '').trim();
  if (!text || card.classList.contains('answered')) return;
  const exe = card._exe || chatCurrentExe;
  window.chat.answer({ exe, answer: text });
  card.classList.add('answered');
  card.querySelectorAll('.chat-clarify-chip').forEach((c) => {
    c.disabled = true;
    if (c.textContent === text) c.classList.add('chosen');
  });
  const input = card.querySelector('.chat-clarify-input');
  const sendBtn = card.querySelector('.chat-clarify-send');
  if (input) { input.disabled = true; if (!card.querySelector('.chat-clarify-chip.chosen')) input.value = text; }
  if (sendBtn) sendBtn.disabled = true;
  // Model resumes the turn.
  thinkingFallback = 'thinking…';
  thinkingBuffer = '';
  showThinking(thinkingFallback);
}

function renderTrailPills(trail) {
  return trail.map(t => {
    if (t.name === 'ask_user') {
      const q = (t.args && t.args.question) ? String(t.args.question) : 'clarifying question';
      const r = t.result || {};
      const ans = r.answer !== undefined ? `→ "${String(r.answer)}"` : (r.aborted ? '→ (cancelled)' : (r.error ? '→ (no answer)' : ''));
      return `<div class="chat-tool-line">❓ ${escapeHtml(q)} ${escapeHtml(ans)}</div>`;
    }
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
  // Drain any pending coalesced markdown render so the final bubble paints
  // the complete content before chat:done's renderChat() replaces it.
  if (chatChunkRaf) { cancelAnimationFrame(chatChunkRaf); flushStreamMarkdown(); }
  // Stop the streaming pulse on the in-flight assistant bubble.
  try {
    if (chatStreamEl && chatStreamEl.classList) chatStreamEl.classList.remove('streaming');
    const liveStream = document.getElementById('chat-stream-msg');
    if (liveStream) liveStream.classList.remove('streaming');
  } catch {}
  chatStreamEl = null;

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
      sources: chatStreamSources.slice(),
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
  chatStreamSources = [];
  thinkingBuffer = '';
  thinkingFallback = '';
  reasoningStartMs = 0;
  setChatBusy(false);

  if (targetExe === chatCurrentExe) {
    renderChat();
  }
  updateChatEmptyClass();
});

async function sendChatMessage(forcedText, forcedApps) {
  const text = forcedText !== undefined ? forcedText : serializeChatInput().trim();
  if (!text || chatBusy) return;

  // Extract file attachments + /app references before clearing the input
  let fileAttachments = [];
  let appRefs = [];
  if (forcedText === undefined) {
    const filePills = chatInput.querySelectorAll('.chat-file-pill');
    fileAttachments = [...filePills].map(p => ({ type: 'file', id: p.dataset.fileId })).filter(a => a.id);
    const appPills = chatInput.querySelectorAll('.chat-app-pill');
    const seenApp = new Set();
    appPills.forEach(p => {
      const exe = p.dataset.appExe;
      if (!exe || seenApp.has(exe)) return;
      seenApp.add(exe);
      const m = resolveAppMeta(exe, p.dataset.appName);
      appRefs.push({ key: p.dataset.appKey || appKeyFor(exe), exe: m.exe, name: m.name, type: m.type, pid: m.pid, port: m.port });
    });
    closeTabMenu();
    closeAppMenu();
    clearChatInput();
    // Click-Send moves focus to the button; Enter keeps it on the input.
    // Always pull focus back so the user can keep typing without re-clicking.
    try { chatInput.focus(); } catch {}
  }
  // Overlay launcher path sends the first message via forcedText and resolves
  // /app tokens itself (the composer there is the plain #launcher-input, not the
  // pill-aware #chat-input), so honour an explicit apps[] when provided.
  if (forcedText !== undefined && Array.isArray(forcedApps)) appRefs = forcedApps;
  addChatMessage('user', text);
  lastUserMessage = text;

  thinkingBuffer = '';
  thinkingFallback = 'reading your request…';
  reasoningStartMs = Date.now();
  showThinking(thinkingFallback);
  setChatBusy(true);

  chatStreamContent = '';
  chatStreamExe = chatCurrentExe;
  chatStreamSources = [];

  const isDirect = chatCurrentExe === DIRECT_CHAT_ID;
  const meta = isDirect
    ? (chatMetaStore[DIRECT_CHAT_ID] || { exe: DIRECT_CHAT_ID, name: 'GPT-5.5', type: 'direct', pid: null, port: null })
    : (chatMetaStore[chatCurrentExe] || resolveAppMeta(chatCurrentExe, chatAppNameEl.textContent));
  chatMetaStore[chatCurrentExe] = meta;

  const apiMessages = (chatStore[chatCurrentExe] || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  try {
    if (isDirect) {
      await window.chat.sendDirect({ messages: apiMessages, attachments: fileAttachments, apps: appRefs });
    } else {
      await window.chat.send({ meta, messages: apiMessages, attachments: fileAttachments, apps: appRefs });
    }
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
  // A pill is contentEditable=false; Chromium often won't delete it on Backspace/
  // Delete. Remove an adjacent pill ourselves so the key works as expected.
  if ((e.key === 'Backspace' || e.key === 'Delete')) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const pill = e.key === 'Backspace' ? pillBeforeCaret(range) : pillAfterCaret(range);
      if (pill) {
        e.preventDefault();
        const newRange = document.createRange();
        newRange.setStartBefore(pill);
        newRange.collapse(true);
        pill.remove();
        // If nothing meaningful is left, reset so the :empty placeholder returns.
        if (!chatInput.querySelector('.chat-tab-pill, .chat-file-pill, .chat-app-pill') && chatInput.textContent.trim() === '') {
          chatInput.innerHTML = '';
          chatInput.focus();
        } else {
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
        evaluateTabTrigger();
        return;
      }
    }
  }
  // /file command: Space or Tab after `/file` opens the native file picker.
  if ((e.key === ' ' || e.key === 'Tab') && !chatBusy) {
    const ctx = getSlashContext();
    if (ctx && shouldOfferFilePicker(ctx)) {
      e.preventDefault();
      openFilePicker(ctx);
      return;
    }
  }
  // While the /app menu is open, hijack navigation keys (Space falls through so
  // the user can type a filter after `/app `).
  if (appMenuState !== 'closed' && appMenuItems.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      appMenuActiveIdx = Math.min(appMenuItems.length - 1, appMenuActiveIdx + 1);
      renderAppMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      appMenuActiveIdx = Math.max(0, appMenuActiveIdx - 1);
      renderAppMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickApp(appMenuActiveIdx);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAppMenu();
      return;
    }
  }
  // While the /tab menu is open, hijack navigation keys.
  if (tabMenuState !== 'closed' && tabMenuItems.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      tabMenuActiveIdx = Math.min(tabMenuItems.length - 1, tabMenuActiveIdx + 1);
      renderTabMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      tabMenuActiveIdx = Math.max(0, tabMenuActiveIdx - 1);
      renderTabMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickTab(tabMenuActiveIdx);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTabMenu();
      return;
    }
  }
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
  // contenteditable grows on its own (CSS max-height + scroll). Drop any stray
  // <br> left behind when the field is emptied so the :empty placeholder shows.
  if (chatInput.textContent === '' && chatInput.querySelector('br')) chatInput.innerHTML = '';
  evaluateTabTrigger();
  evaluateAppTrigger();
});

// ── `/tab` mention: reference Chrome tabs inline as pills ──────────────────────
// Typing `/tab` (in a CDP/Chrome chat) pops an animated dropdown of the selected
// window's tabs. Picking one drops an inline pill into the composer. On send the
// pill serialises to `[tab:<targetId> "<title>"]` — the model resolves it via
// cdp_select_window({id}), and the logged user message carries the tab id.
const tabMenuEl     = document.getElementById('chat-tab-menu');
const tabMenuListEl = document.getElementById('chat-tab-menu-list');

let tabMenuState     = 'closed';   // 'closed' | 'loading' | 'open'
let tabMenuItems     = [];
let tabMenuActiveIdx = 0;
let activeTrigger    = null;        // { node, slashOffset, caretOffset }
let tabMenuToken     = 0;

const TAB_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M2 9h20"></path><path d="M6 6.5h.01M9 6.5h.01"></path></svg>';

const FILE_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';

const APP_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>';

// Serialise the composer to plain text, turning pills into [tab:id "title"] tokens
// and contenteditable's per-line <div> wrappers back into newlines.
function serializeChatInput() {
  let out = '';
  const walk = (parent) => {
    parent.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.classList && n.classList.contains('chat-tab-pill')) {
          const id = n.dataset.tabId || '';
          const title = (n.dataset.tabTitle || '').replace(/"/g, "'");
          out += `[tab:${id} "${title}"]`;
        } else if (n.classList && n.classList.contains('chat-file-pill')) {
          const id = n.dataset.fileId || '';
          const name = (n.dataset.fileName || '').replace(/"/g, "'");
          out += `[file:${id} "${name}"]`;
        } else if (n.classList && n.classList.contains('chat-app-pill')) {
          const key = n.dataset.appKey || '';
          const name = (n.dataset.appName || '').replace(/"/g, "'");
          out += `[app:${key} "${name}"]`;
        } else if (n.tagName === 'BR') {
          out += '\n';
        } else if (n.tagName === 'DIV' || n.tagName === 'P') {
          if (out && !out.endsWith('\n')) out += '\n';
          walk(n);
        } else {
          walk(n);
        }
      }
    });
  };
  walk(chatInput);
  return out;
}

function clearChatInput() {
  chatInput.innerHTML = '';
}

// Is the caret sitting right after a `/tab`-style slash token? Returns its text
// node + offsets so we can later splice in a pill.
function getSlashContext() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !chatInput.contains(node)) return null;
  const before = node.nodeValue.slice(0, range.startOffset);
  const m = /(^|\s)\/([a-zA-Z]*)$/.exec(before);
  if (!m) return null;
  const query = m[2].toLowerCase();
  return { node, query, slashOffset: range.startOffset - query.length - 1, caretOffset: range.startOffset };
}

function shouldOfferTabMenu(ctx) {
  const q = ctx.query;
  if (!(q.length >= 1 && ('tab'.startsWith(q) || q.startsWith('tab')))) return false;
  const meta = chatMetaStore[chatCurrentExe];
  return !!(meta && meta.type === 'electron' && meta.port);
}

function shouldOfferFilePicker(ctx) {
  return ctx.query === 'file';
}

function evaluateTabTrigger() {
  if (chatBusy) { if (tabMenuState !== 'closed') closeTabMenu(); return; }
  const ctx = getSlashContext();
  if (ctx && shouldOfferTabMenu(ctx)) {
    if (tabMenuState === 'closed') {
      openTabMenu(ctx);
    } else {
      activeTrigger = ctx;
      if (tabMenuState === 'open') positionTabMenu();
    }
  } else if (tabMenuState !== 'closed') {
    closeTabMenu();
  }
}

async function openTabMenu(ctx) {
  const meta = chatMetaStore[chatCurrentExe];
  if (!meta || meta.type !== 'electron' || !meta.port) return;
  tabMenuState = 'loading';
  activeTrigger = ctx;
  const myToken = ++tabMenuToken;
  let tabs = [];
  try {
    const res = await window.chat.listTabs(meta.port);
    tabs = (res && Array.isArray(res.tabs)) ? res.tabs : [];
  } catch { tabs = []; }
  if (myToken !== tabMenuToken || !activeTrigger) return; // closed / superseded mid-fetch
  if (!tabs.length) { closeTabMenu(); return; }
  tabMenuItems = tabs;
  tabMenuActiveIdx = tabs.findIndex(t => t.active);
  if (tabMenuActiveIdx < 0) tabMenuActiveIdx = 0;
  renderTabMenu();
  tabMenuEl.hidden = false;
  tabMenuState = 'open';
  positionTabMenu();
}

function closeTabMenu() {
  tabMenuState = 'closed';
  tabMenuToken++;          // invalidate any in-flight fetch
  tabMenuEl.hidden = true;
  tabMenuItems = [];
  activeTrigger = null;
}

function renderTabMenu() {
  if (!tabMenuItems.length) {
    tabMenuListEl.innerHTML = `<div class="chat-tab-menu-empty">No open tabs in this window.</div>`;
    return;
  }
  tabMenuListEl.innerHTML = tabMenuItems.map((t, i) => {
    const host = hostFromUrl(t.url);
    const title = t.title || host || 'Untitled tab';
    return `
      <button type="button" role="option" class="chat-tab-row${i === tabMenuActiveIdx ? ' active' : ''}"
              data-i="${i}" aria-selected="${i === tabMenuActiveIdx}">
        <span class="chat-tab-row-icon">${TAB_GLYPH_SVG}</span>
        <span class="chat-tab-row-body">
          <span class="chat-tab-row-title">${escapeHtml(title)}</span>
          ${host ? `<span class="chat-tab-row-url">${escapeHtml(host)}</span>` : ''}
        </span>
      </button>`;
  }).join('');
  const activeRow = tabMenuListEl.querySelector('.chat-tab-row.active');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

// Anchor the menu just above the caret line, inside the composer wrap.
function positionTabMenu() {
  // In overlay chat mode chatInput is reparented into .launcher-input-stack;
  // the original .chat-input-wrap is no longer the ancestor. Fall back to
  // whichever positioned container actually holds chatInput.
  const wrap = chatInput.closest('.chat-input-wrap, .launcher-input-stack, .launcher-row');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  let caretRect = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const rects = sel.getRangeAt(0).getClientRects();
    if (rects.length) caretRect = rects[rects.length - 1];
  }
  if (!caretRect || (!caretRect.width && !caretRect.height)) caretRect = chatInput.getBoundingClientRect();
  const left = Math.max(8, Math.min(caretRect.left - wrapRect.left, wrapRect.width - 16));
  tabMenuEl.style.left = left + 'px';
  tabMenuEl.style.bottom = (wrapRect.bottom - caretRect.top + 6) + 'px';
  tabMenuEl.style.top = 'auto';
}

function buildTabPill(tab) {
  const span = document.createElement('span');
  span.className = 'chat-tab-pill';
  span.contentEditable = 'false';
  span.dataset.tabId = tab.id || '';
  span.dataset.tabTitle = tab.title || '';
  span.dataset.tabUrl = tab.url || '';
  const label = (tab.title || hostFromUrl(tab.url) || 'tab').trim();
  span.title = label + (tab.url ? ` — ${tab.url}` : '');
  const icon = document.createElement('span');
  icon.className = 'chat-tab-pill-icon';
  icon.innerHTML = TAB_GLYPH_SVG;
  const text = document.createElement('span');
  text.className = 'chat-tab-pill-label';
  text.textContent = label;
  span.appendChild(icon);
  span.appendChild(text);
  return span;
}

function pickTab(i) {
  const tab = tabMenuItems[i];
  if (tab) replaceTriggerWithPill(tab);
}

function isTabPill(n) {
  return n && n.nodeType === Node.ELEMENT_NODE && n.classList && n.classList.contains('chat-tab-pill');
}
function isAnyPill(n) {
  return n && n.nodeType === Node.ELEMENT_NODE && n.classList &&
    (n.classList.contains('chat-tab-pill') || n.classList.contains('chat-file-pill') || n.classList.contains('chat-app-pill'));
}
const isEmptyText = (n) => n && n.nodeType === Node.TEXT_NODE && n.nodeValue === '';

// The pill immediately before the (collapsed) caret, if any — skipping empty
// text nodes contenteditable leaves behind around inline non-editable spans.
function pillBeforeCaret(range) {
  const { startContainer: node, startOffset: off } = range;
  let prev;
  if (node.nodeType === Node.TEXT_NODE) {
    if (off > 0) return null;               // real chars sit before the caret
    prev = node.previousSibling;
  } else {
    if (off === 0) return null;
    prev = node.childNodes[off - 1];
  }
  while (isEmptyText(prev)) prev = prev.previousSibling;
  return isAnyPill(prev) ? prev : null;
}

// The pill immediately after the caret, for forward-delete.
function pillAfterCaret(range) {
  const { startContainer: node, startOffset: off } = range;
  let next;
  if (node.nodeType === Node.TEXT_NODE) {
    if (off < node.nodeValue.length) return null;
    next = node.nextSibling;
  } else {
    next = node.childNodes[off];
  }
  while (isEmptyText(next)) next = next.nextSibling;
  return isAnyPill(next) ? next : null;
}

// Splice the slash token (e.g. "/tab") out of its text node and drop a pill in
// its place, leaving the caret after a trailing space.
function replaceTriggerWithPill(tab) {
  const ctx = activeTrigger;
  closeTabMenu();
  if (!ctx || !chatInput.contains(ctx.node) || ctx.node.nodeType !== Node.TEXT_NODE) return;
  const { node, slashOffset, caretOffset } = ctx;
  const full = node.nodeValue;
  const parent = node.parentNode;

  const beforeNode = document.createTextNode(full.slice(0, slashOffset));
  const pill = buildTabPill(tab);
  const spaceNode = document.createTextNode(' ');
  const afterNode = document.createTextNode(full.slice(caretOffset));

  parent.insertBefore(beforeNode, node);
  parent.insertBefore(pill, node);
  parent.insertBefore(spaceNode, node);
  parent.insertBefore(afterNode, node);
  parent.removeChild(node);

  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(spaceNode, spaceNode.length);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  chatInput.focus();
}

// Click a row (mousedown so the editor keeps focus/caret).
tabMenuListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  e.preventDefault();
  pickTab(parseInt(row.dataset.i, 10));
});
tabMenuListEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  const i = parseInt(row.dataset.i, 10);
  if (i !== tabMenuActiveIdx) { tabMenuActiveIdx = i; renderTabMenu(); }
});

// Caret moved away from the token (arrows, click) → re-evaluate / close.
document.addEventListener('selectionchange', () => {
  if (tabMenuState === 'closed' || document.activeElement !== chatInput) return;
  const ctx = getSlashContext();
  if (!ctx || !shouldOfferTabMenu(ctx)) { closeTabMenu(); return; }
  activeTrigger = ctx;
  if (tabMenuState === 'open') positionTabMenu();
});

// Click outside the menu and editor → close.
document.addEventListener('mousedown', (e) => {
  if (tabMenuState === 'closed') return;
  if (tabMenuEl.contains(e.target) || chatInput.contains(e.target)) return;
  closeTabMenu();
});

// ── `/app` mention: reference any running app inline as a pill ────────────────
// Typing `/app` (in app-scoped OR direct chat) pops a dropdown of running apps,
// reusing the same detected list as the overlay launcher. Picking one drops an
// inline pill. On send each pill serialises to `[app:<key> "<name>"]` and the
// app's live meta is collected into payload.apps so the model can select_app it.
const appMenuEl     = document.getElementById('chat-app-menu');
const appMenuListEl = document.getElementById('chat-app-menu-list');

let appMenuState     = 'closed';   // 'closed' | 'open'
let appMenuItems     = [];
let appMenuActiveIdx = 0;
let appTrigger       = null;       // { node, filter, slashOffset, caretOffset }

// Detected running apps, minus ChatGPT, optionally filtered by substring.
// Mirrors the overlay launcher's candidate list (electron + UIA).
function appMenuCandidates(filter) {
  const out = [];
  for (const a of currentApps) {
    if (isChatGptApp(a)) continue;
    const cdp = !!(a.cdpAlive && a.DebugPort);
    out.push({ exe: a.Exe, name: a.Name, backend: cdp ? 'cdp' : 'uia' });
  }
  for (const a of cachedUiaApps) {
    if (isChatGptApp(a)) continue;
    if (out.some(o => o.exe === a.Exe)) continue;
    out.push({ exe: a.Exe, name: a.Name, backend: 'uia' });
  }
  const f = (filter || '').trim().toLowerCase();
  const filtered = f ? out.filter(o => (o.name || '').toLowerCase().includes(f) || (o.exe || '').toLowerCase().includes(f)) : out;
  return filtered.slice(0, 50);
}

// Caret context for /app. Two phases: typing the command word itself (/a../app)
// with no trailing text, OR `/app <filter>` to filter the list by name.
function getAppContext() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !chatInput.contains(node)) return null;
  const before = node.nodeValue.slice(0, range.startOffset);
  // Phase 2: "/app " or "/app <filter>" (a space already separates the filter)
  let m = /(^|\s)\/app[ \t]+([^\n]*)$/i.exec(before);
  if (m) {
    const tokenLen = m[0].length - (m[1] ? m[1].length : 0);
    return { node, filter: m[2], slashOffset: range.startOffset - tokenLen, caretOffset: range.startOffset };
  }
  // Phase 1: typing the command word (/a, /ap, /app) with no trailing text
  m = /(^|\s)\/([a-zA-Z]*)$/.exec(before);
  if (m) {
    const q = m[2].toLowerCase();
    if (q.length >= 1 && ('app'.startsWith(q) || q.startsWith('app'))) {
      return { node, filter: '', slashOffset: range.startOffset - m[2].length - 1, caretOffset: range.startOffset };
    }
  }
  return null;
}

function evaluateAppTrigger() {
  if (chatBusy) { if (appMenuState !== 'closed') closeAppMenu(); return; }
  const ctx = getAppContext();
  if (ctx) {
    openAppMenu(ctx);
  } else if (appMenuState !== 'closed') {
    closeAppMenu();
  }
}

function openAppMenu(ctx) {
  appTrigger = ctx;
  const items = appMenuCandidates(ctx.filter);
  appMenuItems = items;
  if (appMenuActiveIdx >= items.length) appMenuActiveIdx = 0;
  if (!items.length) {
    appMenuListEl.innerHTML = `<div class="chat-tab-menu-empty">No running apps match${ctx.filter ? ` “${escapeHtml(ctx.filter)}”` : ''}.</div>`;
  } else {
    renderAppMenu();
  }
  appMenuEl.hidden = false;
  appMenuState = 'open';
  positionAppMenu();
}

function closeAppMenu() {
  appMenuState = 'closed';
  appMenuEl.hidden = true;
  appMenuItems = [];
  appMenuActiveIdx = 0;
  appTrigger = null;
}

function renderAppMenu() {
  appMenuListEl.innerHTML = appMenuItems.map((a, i) => {
    const base = (a.exe || '').split(/[\\/]/).pop() || a.exe || '';
    return `
      <button type="button" role="option" class="chat-tab-row${i === appMenuActiveIdx ? ' active' : ''}"
              data-i="${i}" aria-selected="${i === appMenuActiveIdx}">
        <span class="chat-tab-row-icon">${APP_GLYPH_SVG}</span>
        <span class="chat-tab-row-body">
          <span class="chat-tab-row-title">${escapeHtml(a.name || base)}</span>
          <span class="chat-tab-row-url">${escapeHtml(base)} · ${a.backend}</span>
        </span>
      </button>`;
  }).join('');
  const activeRow = appMenuListEl.querySelector('.chat-tab-row.active');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

function positionAppMenu() {
  const wrap = chatInput.closest('.chat-input-wrap, .launcher-input-stack, .launcher-row');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  let caretRect = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const rects = sel.getRangeAt(0).getClientRects();
    if (rects.length) caretRect = rects[rects.length - 1];
  }
  if (!caretRect || (!caretRect.width && !caretRect.height)) caretRect = chatInput.getBoundingClientRect();
  const left = Math.max(8, Math.min(caretRect.left - wrapRect.left, wrapRect.width - 16));
  appMenuEl.style.left = left + 'px';
  appMenuEl.style.bottom = (wrapRect.bottom - caretRect.top + 6) + 'px';
  appMenuEl.style.top = 'auto';
}

function buildAppPill(app) {
  const span = document.createElement('span');
  span.className = 'chat-app-pill';
  span.contentEditable = 'false';
  span.dataset.appExe = app.exe || '';
  span.dataset.appName = app.name || '';
  span.dataset.appKey = appKeyFor(app.exe || '');
  const label = (app.name || (app.exe || '').split(/[\\/]/).pop() || 'app').trim();
  span.title = label + (app.exe ? ` — ${app.exe}` : '');
  const icon = document.createElement('span');
  icon.className = 'chat-app-pill-icon';
  icon.innerHTML = APP_GLYPH_SVG;
  const text = document.createElement('span');
  text.className = 'chat-app-pill-label';
  text.textContent = label;
  span.appendChild(icon);
  span.appendChild(text);
  return span;
}

function pickApp(i) {
  const app = appMenuItems[i];
  if (app) insertAppPill(app);
}

// Splice the slash token (e.g. "/app" or "/app disc") out of its text node and
// drop a pill in its place, leaving the caret after a trailing space.
function insertAppPill(app) {
  const ctx = appTrigger;
  closeAppMenu();
  if (!ctx || !chatInput.contains(ctx.node) || ctx.node.nodeType !== Node.TEXT_NODE) return;
  const { node, slashOffset, caretOffset } = ctx;
  const full = node.nodeValue;
  const parent = node.parentNode;
  const beforeNode = document.createTextNode(full.slice(0, slashOffset));
  const pill = buildAppPill(app);
  const spaceNode = document.createTextNode(' ');
  const afterNode = document.createTextNode(full.slice(caretOffset));
  parent.insertBefore(beforeNode, node);
  parent.insertBefore(pill, node);
  parent.insertBefore(spaceNode, node);
  parent.insertBefore(afterNode, node);
  parent.removeChild(node);
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(spaceNode, spaceNode.length);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  chatInput.focus();
}

appMenuListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  e.preventDefault();
  pickApp(parseInt(row.dataset.i, 10));
});
appMenuListEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  const i = parseInt(row.dataset.i, 10);
  if (i !== appMenuActiveIdx) { appMenuActiveIdx = i; renderAppMenu(); }
});
document.addEventListener('selectionchange', () => {
  if (appMenuState === 'closed' || document.activeElement !== chatInput) return;
  const ctx = getAppContext();
  if (!ctx) { closeAppMenu(); return; }
  appTrigger = ctx;
  positionAppMenu();
});
document.addEventListener('mousedown', (e) => {
  if (appMenuState === 'closed') return;
  if (appMenuEl.contains(e.target) || chatInput.contains(e.target)) return;
  closeAppMenu();
});

// ── `/file` command: attach local files as inline pills ──────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

let filePickerOpen = false;

async function openFilePicker(ctx) {
  if (filePickerOpen) return;
  filePickerOpen = true;
  // Save context for race-condition guard
  const savedNode = ctx.node;
  const savedText = ctx.node.nodeValue;
  try {
    const res = await window.chat.pickFile();
    // Back-compat: old shape returned array directly.
    const files = Array.isArray(res) ? res : (res && res.files) || [];
    const skipped = (res && res.skipped) || [];
    const canceled = !!(res && res.canceled);

    if (canceled) {
      if (chatInput.contains(savedNode) && savedNode.nodeValue === savedText) {
        removeSlashToken(ctx);
      }
      chatInput.focus();
      return;
    }

    if (skipped.length) {
      const summary = skipped.map(s => `${s.name}: ${s.reason}`).join('; ');
      showStatus(`${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped — ${summary}`, 'error');
      setTimeout(hideStatus, 6000);
    }

    if (!files.length) {
      // Nothing accepted — strip /file text so user can retry.
      if (chatInput.contains(savedNode) && savedNode.nodeValue === savedText) {
        removeSlashToken(ctx);
      }
      chatInput.focus();
      return;
    }

    // Focus the editor so caret-based inserts have a valid selection.
    chatInput.focus();
    // Insert pills
    let isFirst = true;
    for (const file of files) {
      if (isFirst && chatInput.contains(savedNode) && savedNode.nodeValue === savedText) {
        replaceTriggerWithFilePill(ctx, file);
        isFirst = false;
      } else {
        insertFilePillAtCaret(file);
      }
    }
  } catch (err) {
    showStatus(`File picker failed: ${err && err.message ? err.message : err}`, 'error');
    setTimeout(hideStatus, 6000);
  } finally {
    filePickerOpen = false;
  }
}

function removeSlashToken(ctx) {
  if (!ctx || !chatInput.contains(ctx.node)) return;
  const { node, slashOffset, caretOffset } = ctx;
  const full = node.nodeValue;
  node.nodeValue = full.slice(0, slashOffset) + full.slice(caretOffset);
}

function buildFilePill(file) {
  const span = document.createElement('span');
  span.className = 'chat-file-pill';
  span.contentEditable = 'false';
  span.dataset.fileId = file.id;
  span.dataset.fileName = file.name;
  span.title = `${file.name} (${formatBytes(file.size)})`;
  const icon = document.createElement('span');
  icon.className = 'chat-file-pill-icon';
  icon.innerHTML = FILE_GLYPH_SVG;
  const text = document.createElement('span');
  text.className = 'chat-file-pill-label';
  text.textContent = file.name;
  span.appendChild(icon);
  span.appendChild(text);
  return span;
}

function replaceTriggerWithFilePill(ctx, file) {
  const { node, slashOffset, caretOffset } = ctx;
  const full = node.nodeValue || '';
  const before = full.slice(0, slashOffset);
  const after = full.slice(caretOffset);
  const pill = buildFilePill(file);
  const parent = node.parentNode;
  if (before) {
    const pre = document.createTextNode(before);
    parent.insertBefore(pre, node);
  }
  parent.insertBefore(pill, node);
  const trailing = document.createTextNode(after ? ' ' + after : ' ');
  parent.insertBefore(trailing, node);
  parent.removeChild(node);
  // Place caret after trailing space
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(trailing, 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertFilePillAtCaret(file) {
  const pill = buildFilePill(file);
  const trailing = document.createTextNode(' ');
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    chatInput.appendChild(pill);
    chatInput.appendChild(trailing);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(trailing);
  range.insertNode(pill);
  // Move caret after trailing space
  const newRange = document.createRange();
  newRange.setStartAfter(trailing);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

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
const autoRunComplete      = document.getElementById('auto-run-complete');
const autoRunCompleteTitle = document.getElementById('auto-run-complete-title');
const autoRunCompleteSub   = document.getElementById('auto-run-complete-sub');
const autoRunCompleteBtn   = document.getElementById('auto-run-complete-btn');

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
  'cdp_get_text', 'cdp_get_tree', 'cdp_get_messages', 'cdp_react',
  'cdp_scroll_to_message', 'cdp_scroll_messages', 'cdp_scroll',
  'cdp_get_search_results', 'cdp_set_search_sort', 'cdp_jump_to_search_result',
]);
const AUTO_TOOLS_UIA = new Set(['uia_invoke', 'uia_set_value', 'uia_get_tree']);
// Tools whose message_id must be a live ref ($cap.…) or index — never a baked
// snowflake. Mirrors main.js MESSAGE_ID_TOOLS.
const MSG_ID_TOOLS = new Set(['cdp_react', 'cdp_scroll_to_message', 'cdp_jump_to_search_result']);

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
    case 'cdp_react': return a.emoji ? `React with :${a.emoji}:` : 'React to that message';
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
    if (s.forEach !== undefined) {
      const fe = s.forEach;
      if (!fe || typeof fe !== 'object' || Array.isArray(fe)) return `Step ${i + 1} "forEach" must be an object.`;
      if (typeof fe.from !== 'string' || !fe.from) return `Step ${i + 1} "forEach.from" must name a prior capture.`;
      if (!MSG_ID_TOOLS.has(s.tool)) return `Step ${i + 1} "forEach" is only valid on ${[...MSG_ID_TOOLS].join('/')}.`;
    }
    if (MSG_ID_TOOLS.has(s.tool) && s.args && typeof s.args.message_id === 'string') {
      const mid = s.args.message_id.trim();
      if (mid && mid[0] !== '$' && /\d{17,}/.test(mid)) {
        return `Step ${i + 1} (${s.tool}) has a hard-coded message id. Reference a live message instead — e.g. "$msgs.images.last", or a "forEach" on the step. (Capture a cdp_get_messages step as "msgs" first.)`;
      }
    }
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
let runCursor    = null; // moving outline that tracks the current step
let runStepCount = 0;    // total steps in the active run (for completion copy)

// Slide the outline box over row `i`. State drives its color: 'running'
// (in flight), 'done' (succeeded), 'failed' (errored). Pass null to hide it.
function moveRunCursor(i, state) {
  if (!runCursor) return;
  if (i == null) {
    runCursor.classList.remove('visible', 'running', 'done', 'failed');
    return;
  }
  const row = document.getElementById(`auto-run-row-${i}`);
  if (!row) return;
  runCursor.style.top    = `${row.offsetTop}px`;
  runCursor.style.height = `${row.offsetHeight}px`;
  runCursor.classList.add('visible');
  runCursor.classList.remove('running', 'done', 'failed');
  if (state) runCursor.classList.add(state);
  // Don't follow every step. Only scroll once the active row gets within
  // ~2 steps of the bottom edge, then reveal it with 2 steps of lookahead.
  const stride        = row.offsetHeight + 4;            // row height + flex gap
  const lookahead     = 2 * stride;
  const rowBottom     = row.offsetTop + row.offsetHeight;
  const visibleBottom = autoRunLog.scrollTop + autoRunLog.clientHeight;
  if (rowBottom + lookahead > visibleBottom) {
    const maxScroll = autoRunLog.scrollHeight - autoRunLog.clientHeight;
    const target    = Math.max(0, Math.min(maxScroll, rowBottom + lookahead - autoRunLog.clientHeight));
    autoRunLog.scrollTo({ top: target, behavior: 'smooth' });
  }
}

function runAutomation(entry, meta) {
  autoRunTitle.textContent = `Running: ${entry.name}`;
  autoRunLog.innerHTML = '';
  autoRunError.textContent = '';
  autoRunError.classList.remove('visible');
  autoRunComplete.classList.remove('show', 'failed');
  autoRunStop.style.display = '';
  autoRunDone.style.display = 'none';
  autoRunClose.style.display = 'none';
  showAutoModal(autoRunModal);
  // Pre-fill rows so user sees the plan, in plain English
  runStepTexts = entry.steps.map((s) => stepText(s, entry.steps));
  runStepCount = entry.steps.length;
  entry.steps.forEach((s, i) => {
    appendRunRow(i, runStepTexts[i], '', 'pending');
  });
  // One reusable outline element, layered behind the rows' text
  runCursor = document.createElement('div');
  runCursor.className = 'auto-modal-runlog-cursor';
  autoRunLog.appendChild(runCursor);
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
  statusEl.textContent = status === 'pending' ? '…' : status === 'start' ? '▶' : status === 'ok' ? '✓' : status === 'error' ? '✕' : status === 'stopped' ? '◼' : status === 'retry' ? '⟳' : '';
  const detailEl = row.querySelector('.auto-modal-runlog-detail');
  detailEl.textContent = detail !== undefined ? detail : argsDesc;
}

window.automation.onRunStart((data) => {
  activeRunId = data && data.runId;
});

window.automation.onRunStep((data) => {
  if (!data) return;
  const detail = data.status === 'error'
    ? `error: ${data.error || ''}`
    : data.status === 'retry'
      ? (data.forEach
          ? `${data.attempt || 0} of ${data.total || '?'} done…`
          : `waiting for UI to update… (retry ${data.attempt || 1})`)
      : data.status === 'ok' && data.result
        ? summariseResult(data.result)
        : summariseArgs(data.args || {});
  const label = runStepTexts[data.i] || data.name;
  appendRunRow(data.i, label, '', data.status, detail);

  // Drive the moving outline + row emphasis off the step status
  const row = document.getElementById(`auto-run-row-${data.i}`);
  if (data.status === 'start' || data.status === 'retry') {
    document.querySelectorAll('.auto-modal-runlog-row.active')
      .forEach((r) => { r.classList.remove('active'); r.classList.add('is-done'); });
    if (row) { row.classList.add('active'); row.classList.remove('is-done'); }
    moveRunCursor(data.i, 'running');
  } else if (data.status === 'ok') {
    moveRunCursor(data.i, 'done');
  } else if (data.status === 'error') {
    if (row) row.classList.remove('active');
    moveRunCursor(data.i, 'failed');
  }
});

window.automation.onRunDone((data) => {
  activeRunId = null;
  autoRunStop.style.display = 'none';
  autoRunDone.style.display = '';
  autoRunClose.style.display = '';
  document.querySelectorAll('.auto-modal-runlog-row.active')
    .forEach((r) => r.classList.remove('active'));

  const ok = !(data && data.ok === false);
  if (!ok) {
    autoRunError.textContent = data.error || 'failed';
    autoRunError.classList.add('visible');
    moveRunCursor(null);
  }
  showRunComplete(ok, data && data.error);
});

// Pop the success/failure card over the run modal once the script ends.
function showRunComplete(ok, errMsg) {
  autoRunComplete.classList.toggle('failed', !ok);
  if (ok) {
    autoRunCompleteTitle.textContent = 'Automation complete';
    autoRunCompleteSub.textContent =
      runStepCount ? `All ${runStepCount} step${runStepCount === 1 ? '' : 's'} finished.` : 'Done.';
  } else {
    autoRunCompleteTitle.textContent = 'Automation failed';
    autoRunCompleteSub.textContent = errMsg || 'A step did not complete.';
  }
  // Force a reflow so the SVG draw animations restart on every run
  void autoRunComplete.offsetWidth;
  autoRunComplete.classList.add('show');
}

autoRunStop.addEventListener('click', () => {
  if (activeRunId) window.automation.stop(activeRunId);
  autoRunStop.style.display = 'none';
});
autoRunClose.addEventListener('click', () => { hideAutoModal(autoRunModal); });
autoRunDone.addEventListener('click', () => { hideAutoModal(autoRunModal); });
autoRunCompleteBtn.addEventListener('click', () => {
  // Only dismiss the overlay — leave the run log (and any error) visible
  // underneath. The foot Close button is what exits the modal.
  autoRunComplete.classList.remove('show');
});

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

// ════════════════════════════════════════════════════════════════════════
// Overlay mode — hotkey-activated quick-entry launcher.
//
// The same index.html/renderer.js runs in two windows. `?mode=overlay` turns
// this window into the frameless launcher: a bottom-pinned bar where the user
// searches an app (autocomplete + ghost text + dropdown), then either types a
// task (Chat mode) or an automation name (Automation mode, entered via a
// double-tap of the hotkey). Chat reuses openChat()/sendChatMessage(); runs
// reuse runAutomation(). Everything below is inert unless mode === 'overlay'.
// ════════════════════════════════════════════════════════════════════════
(function initOverlayMode() {
  const APP_MODE = new URLSearchParams(location.search).get('mode') || 'settings';
  document.body.dataset.mode = APP_MODE;
  if (APP_MODE !== 'overlay') return;

  const OVERLAY_PAD = 16;                 // matches .launcher padding in CSS
  let cfg = { width: 600, collapsedHeight: 72, dropdownMaxHeight: 280, chatHeight: 540, runHeight: 560 };
  let WIN_W = cfg.width;

  const launcher        = document.getElementById('launcher');
  const launcherCard    = document.getElementById('launcher-card');
  const launcherBackdrop= document.getElementById('launcher-backdrop');
  const lRow            = launcherCard.querySelector('.launcher-row');
  const lInput          = document.getElementById('launcher-input');
  const lGhost          = document.getElementById('launcher-ghost');
  const lDropdown       = document.getElementById('launcher-dropdown');
  const lAppPill        = document.getElementById('launcher-app-pill');
  const lAppPillIcon    = document.getElementById('launcher-app-pill-icon');
  const lAppPillName    = document.getElementById('launcher-app-pill-name');
  const lAppPillX       = document.getElementById('launcher-app-pill-x');
  const lModeChip       = document.getElementById('launcher-mode-chip');
  const lHint           = document.getElementById('launcher-hint');
  const lSettingsBtn    = document.getElementById('launcher-settings-btn');
  const lCloseBtn       = document.getElementById('launcher-close-btn');
  const lFoot           = document.getElementById('launcher-foot');

  // State
  let mode      = 'chat';        // 'chat' | 'automation'
  let stage     = 'app';         // 'app' | 'task'
  let view      = 'launcher';    // 'launcher' | 'chat'
  let selApp    = null;          // {name, exe, type, icon}
  let items     = [];            // current dropdown candidates
  let activeIdx = -1;            // highlighted dropdown row
  let autos     = [];            // automation entries for selApp (automation mode)
  let allowOverlayClose = true;  // mirrors top-level config.allowOverlayClose
  // `/app` reference mode inside the launcher task input: when the user types
  // `/app` mid-prompt, the dropdown lists running apps (same as initial app
  // selection) and picking one inserts an [app:key "name"] token into lInput.
  let lAppMode  = false;         // dropdown currently showing /app candidates
  let lAppCtx   = null;          // { filter, start, end } caret span of the /app token
  const launcherAppRefs = new Map(); // exe → resolved meta, for submit-time apps[]

  function applyCloseBtnVisibility() {
    if (lCloseBtn) lCloseBtn.hidden = allowOverlayClose;
  }

  window.overlay.getConfig().then((c) => {
    if (c && c.overlay) { cfg = { ...cfg, ...c.overlay }; WIN_W = cfg.width; }
    if (c) { allowOverlayClose = c.allowOverlayClose !== false; applyCloseBtnVisibility(); }
  }).catch(() => {});

  // ── App candidates (selected apps only — matches the workspace view) ──
  // Electron selection = live CDP attach (cdpAlive); Win32 selection = selectedUiaExes.
  // Without this filter the overlay listed every detected app instead of the
  // user's chosen workspace apps.
  function appCandidates() {
    const out = [];
    const seen = new Set();
    for (const a of currentApps) {
      if (!a.Exe || seen.has(a.Exe) || !a.cdpAlive) continue;
      if (isChatGptApp(a)) continue;        // direct GPT chat supersedes app-scoping ChatGPT
      seen.add(a.Exe);
      out.push({
        name: a.Name || a.Exe,
        exe: a.Exe,
        type: 'electron',
        icon: a.Icon || '',
        // Capture live CDP port + pid at selection time so a later refreshApps()
        // race can't strip them before openChat() resolves meta. Without these,
        // resolveAppMeta(exe) may read a stale row → meta.port=null → /tab gate
        // refuses to open the picker (shouldOfferTabMenu requires meta.port).
        port: a.DebugPort || null,
        pid: a.MainPid || null,
      });
    }
    for (const a of cachedUiaApps) {
      if (!a.Exe || seen.has(a.Exe) || !selectedUiaExes.has(a.Exe)) continue;
      if (isChatGptApp(a)) continue;
      seen.add(a.Exe);
      out.push({ name: a.Name || a.Exe, exe: a.Exe, type: 'uia', icon: a.Icon || '', port: null, pid: a.Pid || null });
    }
    return out;
  }

  // Skip app selection and open the Autobot direct chat with GPT-5.5. The
  // chat is appless: no CDP/UIA snapshot, no scope guard, no per-app tools.
  // Optional `msg` is sent as the first turn; empty just drops the user into
  // the direct chat panel to type.
  async function chatWithGptDirect(msg) {
    showChatView();
    try {
      await openDirectChat();
    } catch (err) {
      console.warn('openDirectChat failed', err);
    }
    const t = (msg || '').trim();
    if (t) sendChatMessage(t);
  }

  // prefix matches first, then substring; cap to keep the dropdown tight
  function filterApps(q) {
    const all = appCandidates();
    if (!q) return all.slice(0, 8);
    const ql = q.toLowerCase();
    const pre = [], sub = [];
    for (const a of all) {
      const nl = a.name.toLowerCase();
      if (nl.startsWith(ql)) pre.push(a);
      else if (nl.includes(ql)) sub.push(a);
    }
    return [...pre, ...sub].slice(0, 8);
  }

  function filterAutos(q) {
    if (!q) return autos.slice(0, 8);
    const ql = q.toLowerCase();
    const pre = [], sub = [];
    for (const a of autos) {
      const nl = (a.name || '').toLowerCase();
      const sl = (a.slug || '').toLowerCase();
      if (nl.startsWith(ql) || sl.startsWith(ql)) pre.push(a);
      else if (nl.includes(ql) || sl.includes(ql)) sub.push(a);
    }
    return [...pre, ...sub].slice(0, 8);
  }

  // ── Window sizing ──
  let lastSyncedH = -1;
  let syncRAF     = 0;
  function syncLauncherSize() {
    if (view === 'chat') return; // chat mode is driven by sizeForChat()
    if (syncRAF) cancelAnimationFrame(syncRAF);
    syncRAF = requestAnimationFrame(() => {
      syncRAF = 0;
      const h = Math.ceil(launcherCard.getBoundingClientRect().height) + OVERLAY_PAD * 2;
      // Dedupe: every keystroke calls renderDropdown -> syncLauncherSize, but the
      // dropdown height only changes when row-count changes. Skipping no-op
      // resizes prevents the frameless transparent window from repainting on
      // each keystroke, which read as a full-UI flicker.
      if (h === lastSyncedH) return;
      const prev = lastSyncedH;
      lastSyncedH = h;
      // Tween only when transitioning to/from the collapsed state (dropdown
      // opening/closing). Steady-state launcher keystrokes that nudge the
      // height by a row reapply bounds instantly — 16-step tweens on a
      // frameless transparent window otherwise read as a flicker per keystroke.
      const instant = prev > 0;
      window.overlay.resize(WIN_W, h, { anchor: 'bottom', instant });
    });
  }
  // ── Inline chat sizing (top-anchored, content-driven, capped) ──
  // The chat panel replaces the app-list region. The window keeps its top edge
  // pinned and grows downward as messages accumulate. Main is the authority on
  // the actual cap (fresh work area per resize); we propose a generous target
  // and let main floor it. A min-delta gate + 60ms debounce prevents the
  // streaming MutationObserver from re-tweening on every token.
  let chatChromePx     = 130;     // re-measured at enter and on composer resize
  // Bottom-anchored growth: window pins to the bottom, messages stack above the
  // composer. Cache last sent payload so delta-gate can also fire on empty flip.
  let lastSent         = { w: 0, h: 0, empty: false };
  let chatResizeTimer  = null;
  let chatResizeRAF    = null;
  let chatScrollObs    = null;
  let chatComposerObs  = null;
  function chatWinW() { return Math.max(WIN_W, cfg.chatWidth || 760); }
  function chatMinH() { return cfg.chatMinHeight || 280; }
  function chatMaxFrac() { return cfg.chatMaxHeightFrac || 0.72; }
  function measureChatChrome() { /* unused in static-composer layout */ }
  // Cached availableUp the bottom-anchored resize can grant. Updated on enter
  // and after each resize so chat-scroll's max-height tracks the true cap
  // instead of overshooting and clipping content off-screen above the card.
  let cachedAvailH = 0;
  async function refreshAvailH() {
    try { cachedAvailH = await window.overlay.maxHeight(); } catch {}
  }
  function sizeForChat(opts) {
    const immediate = !!(opts && opts.immediate);
    const empty = chatIsEmpty();
    const w = chatWinW();
    // Static-composer layout: launcher-card is `display:flex` inside `.launcher`
    // (position:fixed, inset:0) so its height is upper-bounded by the window.
    // Measuring cardH and then sizing the window to it is circular — when the
    // window is small, chat-scroll's flex slot collapses (to ~52px) even though
    // chat-messages.scrollHeight is much larger. Instead, compute the window
    // target directly from content: chat-messages.scrollHeight + composer +
    // foot + picker (if any) + overlay padding, capped at 72% of screen height.
    let target;
    if (empty) {
      // Clear any inline cap from a previous non-empty pass so the empty card
      // hugs lRow + foot only.
      chatScrollEl.style.maxHeight = '';
      const cardH = Math.ceil(launcherCard.getBoundingClientRect().height);
      target = cardH + OVERLAY_PAD * 2;
    } else {
      const lRowH = Math.ceil(lRow.getBoundingClientRect().height) || 52;
      const footEl = document.querySelector('.launcher-foot');
      const footH = footEl ? Math.ceil(footEl.getBoundingClientRect().height) : 30;
      const cwpVisible = chatWindowPickerEl && !chatWindowPickerEl.hidden
        && chatWindowPickerEl.parentNode === launcherCard;
      const cwpH = cwpVisible ? Math.ceil(chatWindowPickerEl.getBoundingClientRect().height) + 6 : 0;
      const screenH = (window.screen && window.screen.availHeight) || 900;
      const chromeH = lRowH + footH + cwpH + 6 + OVERLAY_PAD * 2;
      const screenCap = Math.floor(screenH * 0.85);
      // Use the lower of (screen-fraction cap) and (what main can actually
      // grant from current window position). Without the main cap we'd ask
      // for a window taller than the desktop and the card would overflow
      // off-screen above the viewport.
      const availCap = cachedAvailH > 0 ? cachedAvailH : screenCap;
      const maxWinH = Math.min(screenCap, availCap);
      const maxScrollH = Math.max(120, maxWinH - chromeH);
      const msgsH = Math.ceil(chatMessagesEl.scrollHeight);
      const scrollH = Math.min(msgsH + 4, maxScrollH);
      // Drive chat-scroll height from JS so the old CSS 72vh trap (vh derived
      // from the window we are about to resize) can't fight us. Card sums to
      // its children; window matches card + overlay padding. No dead space.
      chatScrollEl.style.maxHeight = scrollH + 'px';
      target = scrollH + chromeH;
    }
    const flipped = empty !== lastSent.empty;
    // During GPT streaming, scrollHeight grows by a few px per token. Each
    // setBounds on the transparent frameless overlay = one DWM repaint = one
    // visible flicker, so coalesce growth into multi-line hops (~120px ≈ 5
    // lines). Non-streaming UI keeps the tight 6px gate so launcher / msg-list
    // edits feel responsive.
    const streaming = !!chatStreamExe;
    const minDelta = streaming ? 120 : 6;
    if (!immediate && !flipped && Math.abs(target - lastSent.h) < minDelta && w === lastSent.w) return;
    lastSent = { w, h: target, empty };
    const atBottom = chatScrollEl.scrollTop + chatScrollEl.clientHeight >= chatScrollEl.scrollHeight - 24;
    // Every resize is instant. The tween used to run 16 setBounds × 14ms on
    // the empty↔non-empty flip and the first chat-mode size to look smooth,
    // but each tween step DWM-repaints the transparent frameless window — the
    // animation IS the flicker. One setBounds = one flicker; tweening turns a
    // single state change into ~16 visible flashes. Static target only.
    window.overlay.resize(w, target, { anchor: 'bottom', instant: true });
    // setBounds is synchronous on the main side but the renderer hasn't seen
    // the new viewport yet. Refresh the cap and re-pin scroll on the next tick.
    setTimeout(() => { refreshAvailH(); }, 32);
    if (atBottom) requestAnimationFrame(() => { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; });
  }
  function scheduleChatResize() {
    // Trailing-edge throttle: if a tick is already pending, let it fire
    // instead of resetting it. Pure debounce here meant a continuous token
    // stream (chunks faster than `delay`) kept pushing the timer forward and
    // the window never grew until the stream paused or finished — chat view
    // stayed collapsed for the whole reply. Throttling guarantees a resize
    // lands at most `delay`ms after the first dirty chunk, mid-stream.
    if (chatResizeTimer) return;
    // Streaming bursts MutationObserver callbacks per token. A 60ms tick still
    // lets ~16 setBounds/sec through, which DWM-flickers the transparent
    // frameless window. Stretch to ~200ms while a turn is streaming so growth
    // lands in discrete steps; 60ms for normal edits.
    const delay = chatStreamExe ? 200 : 60;
    chatResizeTimer = setTimeout(() => {
      chatResizeTimer = null;
      if (chatResizeRAF) cancelAnimationFrame(chatResizeRAF);
      chatResizeRAF = requestAnimationFrame(() => { chatResizeRAF = null; sizeForChat(); });
    }, delay);
  }
  function attachChatObservers() {
    if (!chatScrollObs) {
      chatScrollObs = new MutationObserver(() => {
        updateChatEmptyClass();
        scheduleChatResize();
      });
      chatScrollObs.observe(chatScrollEl, { childList: true, subtree: true, characterData: true });
    }
    if (!chatComposerObs && typeof ResizeObserver !== 'undefined') {
      chatComposerObs = new ResizeObserver(() => { scheduleChatResize(); });
      chatComposerObs.observe(launcherCard);
    }
  }
  function detachChatObservers() {
    try { chatScrollObs && chatScrollObs.disconnect(); } catch {}
    try { chatComposerObs && chatComposerObs.disconnect(); } catch {}
    chatScrollObs = null;
    chatComposerObs = null;
    if (chatResizeTimer) { clearTimeout(chatResizeTimer); chatResizeTimer = null; }
    if (chatResizeRAF) { cancelAnimationFrame(chatResizeRAF); chatResizeRAF = null; }
  }
  function sizeForRun()   { window.overlay.resize(WIN_W, cfg.runHeight, { center: true }); }

  // ── Inline chat panel: static-composer mode ──
  // The launcher-row at the bottom IS the composer — across both launcher and
  // chat. On enter we slot #chat-input (and its sibling #chat-tab-menu) into
  // the .launcher-input-stack so the contenteditable + pill/slash/file logic
  // keep working, hide the underlying #launcher-input, and reparent #chat-scroll
  // (plus #chat-window-picker when applicable) above lRow inside .launcher-card.
  // No DOM duplication; restore swaps everything back on exit.
  let inlineChatActive = false;
  // Saved parent/anchor pairs for each reparented node so exit can restore.
  let inlineSaved = null;       // { chatInput, tabMenu, chatScroll, windowPicker }
  const inputStack = lRow.querySelector('.launcher-input-stack');
  const chatInputEl = document.getElementById('chat-input');
  const chatTabMenuEl = document.getElementById('chat-tab-menu');
  const chatAppMenuEl = document.getElementById('chat-app-menu');
  const chatWindowPickerEl = document.getElementById('chat-window-picker');
  const chatHeaderEl = pageChat.querySelector('.chat-header');
  const chatComposerEl = pageChat.querySelector('.chat-composer');
  function saveAnchor(node) {
    if (!node) return null;
    return { parent: node.parentNode, next: node.nextSibling };
  }
  function restoreAnchor(node, anchor) {
    if (!node || !anchor || !anchor.parent) return;
    if (anchor.next && anchor.next.parentNode === anchor.parent) {
      anchor.parent.insertBefore(node, anchor.next);
    } else {
      anchor.parent.appendChild(node);
    }
  }
  function enterInlineChat() {
    if (inlineChatActive) { sizeForChat({ immediate: true }); return; }
    inlineChatActive = true;
    view = 'chat';
    document.body.dataset.overlayView = 'chat';
    lDropdown.hidden = true;
    inlineSaved = {
      chatInput: saveAnchor(chatInputEl),
      tabMenu: saveAnchor(chatTabMenuEl),
      appMenu: saveAnchor(chatAppMenuEl),
      chatScroll: saveAnchor(chatScrollEl),
      windowPicker: saveAnchor(chatWindowPickerEl),
    };
    // Slot chat-input into the launcher-input-stack so lRow remains the visible
    // composer; lInput + ghost stay in the DOM but hidden via .has-chat-input.
    if (chatInputEl && inputStack) inputStack.appendChild(chatInputEl);
    if (chatTabMenuEl && inputStack) inputStack.appendChild(chatTabMenuEl);
    if (chatAppMenuEl && inputStack) inputStack.appendChild(chatAppMenuEl);
    // Reparent chat-scroll and the multi-window picker above lRow.
    if (chatScrollEl) launcherCard.insertBefore(chatScrollEl, lRow);
    if (chatWindowPickerEl) launcherCard.insertBefore(chatWindowPickerEl, chatScrollEl || lRow);
    // pageChat still in main tree but its children moved out — keep .active off
    // so chat-empty / chat-header CSS quirks elsewhere don't kick in.
    pageChat.classList.remove('active', 'chat-enter', 'chat-leave', 'inline-enter');
    inputStack.classList.add('has-chat-input');
    currentPage = 'chat';
    updateChatEmptyClass();
    setHint();
    lastSent = { w: 0, h: 0, empty: false };
    window.__overlaySizeForChat = sizeForChat;
    chatScrollEl.classList.add('chat-enter');
    refreshAvailH().then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          measureChatChrome();
          sizeForChat({ immediate: true });
          attachChatObservers();
        });
      });
    });
    try { sessionStorage.setItem('autobot.overlay.view', 'chat'); } catch {}
    try { sessionStorage.setItem('autobot.overlay.exe', String(chatCurrentExe || '')); } catch {}
    if (chatInputEl) chatInputEl.focus();
  }
  function exitInlineChat() {
    if (!inlineChatActive) return;
    inlineChatActive = false;
    chatScrollEl.classList.remove('chat-enter');
    chatScrollEl.classList.add('chat-leave');
    setTimeout(() => {
      detachChatObservers();
      lastSent = { w: 0, h: 0, empty: false };
      pageChat.classList.remove('active', 'inline-enter', 'chat-leave', 'chat-empty');
      chatScrollEl.classList.remove('chat-leave');
      // Drop the inline max-height sizeForChat set during chat mode; next
      // enter re-derives it from the new chat-messages content.
      chatScrollEl.style.maxHeight = '';
      inputStack.classList.remove('has-chat-input');
      // Restore all four reparented nodes to their original anchors.
      if (inlineSaved) {
        restoreAnchor(chatInputEl, inlineSaved.chatInput);
        restoreAnchor(chatTabMenuEl, inlineSaved.tabMenu);
        restoreAnchor(chatAppMenuEl, inlineSaved.appMenu);
        restoreAnchor(chatScrollEl, inlineSaved.chatScroll);
        restoreAnchor(chatWindowPickerEl, inlineSaved.windowPicker);
      }
      inlineSaved = null;
      try { delete window.__overlaySizeForChat; } catch { window.__overlaySizeForChat = undefined; }
      document.body.dataset.overlayView = 'launcher';
      syncLauncherSize();
    }, 140);
    try { sessionStorage.removeItem('autobot.overlay.view'); } catch {}
    try { sessionStorage.removeItem('autobot.overlay.exe'); } catch {}
  }

  // ── Dropdown render ──
  const ICON_PLACEHOLDER =
    '<span class="ld-icon-fallback"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"></rect></svg></span>';

  // Stable identity per item so we can detect when the row set is unchanged
  // and patch in place instead of wiping innerHTML. Wiping re-mounts every
  // row, which re-fires the .ld-row entrance keyframe and reads as a list-
  // wide flicker on each keystroke / arrow-nav.
  function rowKeyFor(it) {
    if (mode === 'automation' && stage === 'task') return `auto|${it.slug || it.name || ''}`;
    return `app|${it.type || ''}|${it.exe || it.path || it.name || ''}`;
  }
  function rowHtmlFor(it, i) {
    const active = i === activeIdx ? ' active' : '';
    if (mode === 'automation' && stage === 'task') {
      const sub = it.userMsg ? escapeHtml(String(it.userMsg).slice(0, 60)) : `${(it.steps || []).length} steps`;
      return `<div class="ld-row${active}" role="option" data-i="${i}">
        <span class="ld-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span>
        <span class="ld-text"><span class="ld-name">${escapeHtml(it.name)}</span><span class="ld-sub">${sub}</span></span>
      </div>`;
    }
    const iconHtml = it.icon ? `<img class="ld-icon-img" src="${it.icon}" alt="">` : ICON_PLACEHOLDER;
    return `<div class="ld-row${active}" role="option" data-i="${i}">
      ${iconHtml}
      <span class="ld-text"><span class="ld-name">${escapeHtml(it.name)}</span><span class="ld-sub">${it.type === 'electron' ? 'Electron · CDP' : 'Win32 · UIA'}</span></span>
      <span class="ld-enter">hit <kbd>tab</kbd></span>
    </div>`;
  }

  let lastRowKeys = [];
  function renderDropdown() {
    if (!items.length) { lDropdown.hidden = true; lDropdown.innerHTML = ''; lastRowKeys = []; syncLauncherSize(); return; }
    lDropdown.hidden = false;
    lDropdown.style.maxHeight = cfg.dropdownMaxHeight + 'px';
    const keys = items.map(rowKeyFor);
    const sameSet = keys.length === lastRowKeys.length
      && lDropdown.children.length === keys.length
      && keys.every((k, i) => k === lastRowKeys[i]);
    if (sameSet) {
      // Patch in place: only flip .active. Existing nodes stay alive so the
      // ldRowIn entrance keyframe does not re-fire.
      for (let i = 0; i < keys.length; i++) {
        const row = lDropdown.children[i];
        const shouldActive = i === activeIdx;
        if (row.classList.contains('active') !== shouldActive) row.classList.toggle('active', shouldActive);
      }
    } else {
      lDropdown.innerHTML = items.map((it, i) => rowHtmlFor(it, i)).join('');
      lastRowKeys = keys;
    }
    // No visible scrollbar, so keep the active row on screen as the user
    // arrows through the list (block:'nearest' avoids jumping when in view).
    const activeRow = lDropdown.children[activeIdx];
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
    syncLauncherSize();
  }

  function setGhost() {
    const v = lInput.value;
    // No inline ghost while picking a /app reference — the input holds the whole
    // prompt, not just an app name, so ghosting the app name would corrupt it.
    if (lAppMode) { lGhost.textContent = ''; return; }
    if (!v || activeIdx > 0) { lGhost.textContent = ''; return; }
    const top = items[0];
    if (top && top.gptDirect) { lGhost.textContent = ''; return; }
    const label = top ? (mode === 'automation' && stage === 'task' ? top.name : top.name) : '';
    if (label && label.toLowerCase().startsWith(v.toLowerCase()) && label.length > v.length) {
      lGhost.textContent = v + label.slice(v.length);
    } else {
      lGhost.textContent = '';
    }
  }

  // Caret context for a `/app` token in the launcher TASK input. Two phases like
  // the chat composer: typing the command word (/a../app) or `/app <filter>`.
  function lAppContext() {
    if (stage !== 'task' || mode === 'automation') return null;
    const caret = (lInput.selectionStart == null) ? lInput.value.length : lInput.selectionStart;
    const before = lInput.value.slice(0, caret);
    let m = /(^|\s)\/app[ \t]+([^\n]*)$/i.exec(before);
    if (m) { const tokLen = m[0].length - (m[1] ? m[1].length : 0); return { filter: m[2], start: caret - tokLen, end: caret }; }
    m = /(^|\s)\/([a-zA-Z]*)$/.exec(before);
    if (m) { const word = m[2].toLowerCase(); if (word.length >= 1 && ('app'.startsWith(word) || word.startsWith('app'))) return { filter: '', start: caret - m[2].length - 1, end: caret }; }
    return null;
  }

  function refreshSuggestions() {
    const q = lInput.value.trim();
    if (stage === 'app') {
      items = filterApps(q);
      lAppMode = false; lAppCtx = null;
    }
    else if (mode === 'automation') { items = filterAutos(q); lAppMode = false; lAppCtx = null; }
    else {
      // chat task stage: free text, EXCEPT a `/app` token opens the app list.
      const actx = lAppContext();
      if (actx) { lAppMode = true; lAppCtx = actx; items = filterApps(actx.filter.trim()); }
      else { lAppMode = false; lAppCtx = null; items = []; }
    }
    activeIdx = items.length ? 0 : -1;
    renderDropdown();
    setGhost();
  }

  function completeGhost() {
    if (lGhost.textContent) { lInput.value = lGhost.textContent; lGhost.textContent = ''; refreshSuggestions(); return true; }
    if (items[activeIdx]) { lInput.value = items[activeIdx].name; lGhost.textContent = ''; refreshSuggestions(); return true; }
    return false;
  }

  // ── Stage transitions ──
  function setModeChip() {
    lModeChip.textContent = mode === 'automation' ? 'Automation' : 'Chat';
    lModeChip.dataset.mode = mode;
    launcherCard.dataset.mode = mode;
  }
  function setHint() {
    if (view === 'chat') {
      lHint.textContent = 'Enter to send · Shift+Enter for newline · Esc to close · Hold Esc to clear chat';
      return;
    }
    if (stage === 'app') lHint.textContent = '↑↓ navigate · Tab to pick an app · Enter to chat with GPT-5.5 · Esc to close';
    else if (mode === 'automation') lHint.textContent = `Run an automation on ${selApp ? selApp.name : ''} · Enter to run`;
    else lHint.textContent = `Ask ${selApp ? selApp.name : 'the app'} to do something · Enter to send`;
  }

  function enterLauncher(nextMode) {
    // If we were in inline chat, unmount it (DOM reparent + state clear)
    // before resetting the launcher.
    const wasInline = inlineChatActive;
    if (inlineChatActive) exitInlineChat();
    view = 'launcher';
    mode = nextMode === 'automation' ? 'automation' : 'chat';
    stage = 'app';
    selApp = null;
    autos = [];
    lAppPill.hidden = true;
    lInput.value = '';
    lGhost.textContent = '';
    lInput.placeholder = 'Search an app or type a prompt…';
    // hide chat page if it was open
    pageChat.classList.remove('active');
    pageWorkspace.classList.remove('active');
    pageInspector.classList.remove('active');
    // switchPage() short-circuits when currentPage matches the target, so the
    // class removals above would silently no-op the next switchPage('chat').
    // Reset to a sentinel so any later page switch actually re-applies .active.
    currentPage = 'launcher';
    launcher.hidden = false;
    launcherCard.classList.remove('anim');
    void launcherCard.offsetWidth;          // reflow so the entrance anim replays each show
    launcherCard.classList.add('anim');
    setModeChip();
    setHint();
    refreshSuggestions();
    lInput.focus();
    // When exiting inline chat, .has-chat-input keeps lInput display:none until
    // exitInlineChat's 140ms restoration timeout removes the class. The focus()
    // above is dropped because the element isn't focusable yet. Re-focus once
    // the DOM is restored so the user can type immediately after Esc-hold reset.
    if (wasInline) {
      setTimeout(() => { try { lInput.focus(); } catch {} }, 160);
    }
    syncLauncherSize();
  }

  // Exposed for module-scope callers (e.g. resetCurrentChat) so a chat reset
  // can return to the launcher's "Search an app or type a prompt" view instead
  // of sitting in the empty inline-chat state.
  window.__enterLauncher = enterLauncher;

  async function selectApp(app) {
    selApp = app;
    lAppPill.hidden = false;
    lAppPillName.textContent = app.name;
    if (app.icon) { lAppPillIcon.src = app.icon; lAppPillIcon.style.display = ''; }
    else lAppPillIcon.style.display = 'none';
    stage = 'task';
    lInput.value = '';
    lGhost.textContent = '';
    lDropdown.hidden = true;
    items = [];
    if (mode === 'automation') {
      lInput.placeholder = 'Automation name…';
      try { autos = await window.automation.list(app.exe) || []; } catch { autos = []; }
      refreshSuggestions();
    } else {
      lInput.placeholder = `Message ${app.name}…`;
    }
    setHint();
    lInput.focus();
    syncLauncherSize();
  }

  function popApp() {
    if (stage !== 'task') return;
    stage = 'app';
    selApp = null;
    autos = [];
    lAppPill.hidden = true;
    lInput.value = '';
    lInput.placeholder = 'Search an app or type a prompt…';
    setHint();
    refreshSuggestions();
    lInput.focus();
  }

  function showChatView() {
    // Inline chat lives inside .launcher-card now — keep launcher visible so
    // its bottom edge anchors the window and the chat grows upward above it.
    enterInlineChat();
  }

  // Replace the active `/app` token in lInput with `[app:key "name"]` and record
  // the app's resolved meta so submit can hand it to the backend as apps[].
  function pickLauncherApp(app) {
    const ctx = lAppCtx;
    if (!ctx || !app) return;
    const key = appKeyFor(app.exe);
    const token = `[app:${key} "${String(app.name || '').replace(/"/g, "'")}"] `;
    const v = lInput.value;
    lInput.value = v.slice(0, ctx.start) + token + v.slice(ctx.end);
    launcherAppRefs.set(app.exe, { key, exe: app.exe, name: app.name, type: app.type, pid: app.pid || null, port: app.port || null });
    const pos = ctx.start + token.length;
    lAppMode = false; lAppCtx = null; items = []; activeIdx = -1;
    lDropdown.hidden = true; lGhost.textContent = '';
    lInput.focus();
    try { lInput.setSelectionRange(pos, pos); } catch {}
    refreshSuggestions();
  }

  // Scan a task string for [app:key "name"] tokens → resolved apps[] for the
  // backend. Prefers the meta captured at pick time; falls back to live lookup.
  function collectLauncherApps(text) {
    const out = []; const seen = new Set();
    const re = /\[app:([^\s\]]+)\s+"([^"]*)"\]/g;
    let m;
    while ((m = re.exec(text))) {
      const key = m[1], name = m[2];
      let meta = null;
      for (const v of launcherAppRefs.values()) { if (v.key === key) { meta = v; break; } }
      if (!meta) {
        const c = appCandidates().find(a => appKeyFor(a.exe) === key || String(a.name || '').toLowerCase() === name.toLowerCase());
        if (c) meta = { key: appKeyFor(c.exe), exe: c.exe, name: c.name, type: c.type, pid: c.pid || null, port: c.port || null };
      }
      if (meta && !seen.has(meta.exe)) { seen.add(meta.exe); out.push(meta); }
    }
    return out;
  }

  // ── Submit ──
  async function submitChat(task) {
    if (!selApp || !task.trim()) return;
    showChatView();
    try {
      // Pass selApp through so openChat skips resolveAppMeta(exe) and uses the
      // CDP port captured when the user selected the app. Without this, a
      // racing refreshApps() can land a row with cdpAlive=false → meta.port
      // null → /tab picker silently refuses to open.
      await openChat(selApp.name, selApp.exe, selApp);
    } catch (e) { /* openChat handles its own errors */ }
    const apps = collectLauncherApps(task);
    sendChatMessage(task.trim(), apps);
  }

  function submitAutomation(q) {
    if (!selApp) return;
    const ql = q.trim().toLowerCase();
    let entry = items[activeIdx]
      || autos.find(a => (a.name || '').toLowerCase() === ql || (a.slug || '').toLowerCase() === ql)
      || filterAutos(q.trim())[0];
    if (!entry) { lHint.textContent = 'No matching automation. ↑↓ to pick from the list.'; return; }
    const meta = resolveAppMeta(selApp.exe, selApp.name);
    if (meta.type === 'electron' && !meta.port) {
      lHint.textContent = '⚠ This app needs CDP enabled — turn it on in Settings.';
      return;
    }
    // Grow + center so the run modal fits, then run (reuses runAutomation()).
    sizeForRun();
    runAutomation(entry, meta);
  }

  // ── Input events ──
  lInput.addEventListener('input', () => {
    activeIdx = items.length ? 0 : -1;
    refreshSuggestions();
  });

  lInput.addEventListener('keydown', (e) => {
    const hasList = !lDropdown.hidden && items.length;
    // `/app` reference picking: Enter/Tab insert the highlighted app token,
    // Escape dismisses the app list without leaving the task stage. Arrow keys
    // fall through to the normal list navigation below.
    if (lAppMode && items.length) {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickLauncherApp(items[activeIdx] || items[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); lAppMode = false; lAppCtx = null; items = []; activeIdx = -1; lDropdown.hidden = true; lGhost.textContent = ''; setHint(); syncLauncherSize(); return; }
    }
    if (e.key === 'ArrowDown' && hasList) {
      e.preventDefault(); activeIdx = (activeIdx + 1) % items.length; renderDropdown(); setGhost(); return;
    }
    if (e.key === 'ArrowUp' && hasList) {
      e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % items.length; renderDropdown(); setGhost(); return;
    }
    if (e.key === 'Tab') {
      // App stage: Tab picks the highlighted/ghost app (autocomplete-to-select).
      // Automation stage: Tab fills the ghosted automation name into the input.
      if (stage === 'app') {
        e.preventDefault();
        const typed = lInput.value.trim();
        const pick = items[activeIdx] || (lGhost.textContent ? items[0] : null) || filterApps(typed)[0];
        if (pick && pick.gptDirect) { chatWithGptDirect(typed); return; }
        if (pick) { selectApp(pick); return; }
        return;
      }
      if (mode === 'automation' && completeGhost()) { e.preventDefault(); return; }
    }
    if (e.key === 'Escape') {
      if (stage === 'task') { e.preventDefault(); popApp(); return; }
      if (allowOverlayClose) { e.preventDefault(); window.overlay.dismiss(); }
      return;
    }
    if (e.key === 'Backspace' && lInput.value === '' && stage === 'task') {
      e.preventDefault(); popApp(); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (stage === 'app') {
        // Enter is reserved for direct GPT-5.5 chat. App selection uses Tab.
        chatWithGptDirect(lInput.value.trim());
        return;
      }
      if (mode === 'automation') { submitAutomation(lInput.value); return; }
      // chat task
      submitChat(lInput.value);
      return;
    }
  });

  lDropdown.addEventListener('click', (e) => {
    const row = e.target.closest('.ld-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (Number.isNaN(i) || !items[i]) return;
    if (lAppMode) { pickLauncherApp(items[i]); return; }
    if (stage === 'app') {
      if (items[i].gptDirect) chatWithGptDirect(lInput.value.trim());
      else selectApp(items[i]);
    }
    else if (mode === 'automation') { activeIdx = i; submitAutomation(items[i].name); }
  });

  lAppPillX.addEventListener('click', popApp);
  // Gear menu: in launcher view, click opens Settings directly. In chat view,
  // it toggles a small popover with Reset / Pick different app / Settings.
  const gearMenuEl     = document.getElementById('launcher-gear-menu');
  const gearResetBtn   = document.getElementById('launcher-gear-reset');
  const gearPickBtn    = document.getElementById('launcher-gear-pick');
  const gearSettingsBtn= document.getElementById('launcher-gear-settings');
  function closeGearMenu() { if (gearMenuEl) gearMenuEl.hidden = true; }
  function openGearMenu() {
    if (!gearMenuEl) return;
    // Item visibility depends on whether the current chat is app-scoped.
    if (gearPickBtn) gearPickBtn.hidden = !(chatCurrentExe && chatCurrentExe !== DIRECT_CHAT_ID);
    gearMenuEl.hidden = false;
  }
  lSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view !== 'chat') { window.overlay.openSettings(); return; }
    if (gearMenuEl && gearMenuEl.hidden) openGearMenu(); else closeGearMenu();
  });
  document.addEventListener('click', (e) => {
    if (!gearMenuEl || gearMenuEl.hidden) return;
    if (gearMenuEl.contains(e.target) || lSettingsBtn.contains(e.target)) return;
    closeGearMenu();
  });
  if (gearResetBtn) gearResetBtn.addEventListener('click', () => {
    closeGearMenu();
    // Reuse the existing chat-reset path (chatNewBtn click handler).
    chatNewBtn.click();
  });
  if (gearPickBtn) gearPickBtn.addEventListener('click', () => {
    closeGearMenu();
    enterLauncher('chat');
  });
  if (gearSettingsBtn) gearSettingsBtn.addEventListener('click', () => {
    closeGearMenu();
    window.overlay.openSettings();
  });
  lCloseBtn.addEventListener('click', () => window.overlay.dismiss());
  launcherBackdrop.addEventListener('click', () => { if (allowOverlayClose) window.overlay.dismiss(); });

  // ── Drag the overlay by its footer/hint bar ──
  // The window is frameless and uses JS-driven dragging (CSS app-region drag
  // can't snap and fights the always-on-top/click behavior). On mousedown we
  // capture the window's top-left + the screen cursor offset, then on each
  // mousemove report the new desired top-left to main (which applies the
  // horizontal-center snap + on-screen clamp). setDragging suppresses the
  // blur-dismiss while a drag is live.
  (function wireFooterDrag() {
    let dragging = false;
    let startScreenX = 0, startScreenY = 0;   // cursor position when drag began
    let startWinX = 0, startWinY = 0;         // window top-left when drag began

    function onMouseMove(e) {
      if (!dragging) return;
      const x = startWinX + (e.screenX - startScreenX);
      const y = startWinY + (e.screenY - startScreenY);
      window.overlay.moveTo(x, y);
    }
    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      window.overlay.setDragging(false);
    }
    lFoot.addEventListener('mousedown', async (e) => {
      // Ignore drags that start on the settings gear or close X (button clicks).
      if (e.button !== 0 || (lSettingsBtn && lSettingsBtn.contains(e.target)) || (lCloseBtn && lCloseBtn.contains(e.target))) return;
      e.preventDefault();
      startScreenX = e.screenX;
      startScreenY = e.screenY;
      const pos = await window.overlay.getPosition();
      startWinX = pos.x; startWinY = pos.y;
      dragging = true;
      window.overlay.setDragging(true);
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    });
  })();

  // Chat back button → return to the launcher (instead of the hidden workspace).
  chatBackBtn.addEventListener('click', () => { if (view === 'chat') enterLauncher('chat'); });

  // Chat-view Esc:
  //   - Tap (release < 1s): dismiss the overlay (original behaviour).
  //   - Hold ≥ 1s: reset the current chat. While held, the tray icon shows a
  //     circular progress ring driven by setResetProgress IPC.
  //
  // chatBusy / allowOverlayClose gating mirrors the prior tap-only handler so
  // an in-flight stream still blocks dismissal. The reset gesture itself is
  // NOT gated by chatBusy — when the model is stuck in a loop, hold-Esc is the
  // user's escape hatch (chat:reset / chat:reset-direct destroy the in-flight
  // request, so it's safe to fire mid-stream).
  const ESC_HOLD_MS = 1000;
  let escHoldStart = 0;
  let escHoldTimer = null;
  let escHoldRaf = null;
  let escResetFired = false;
  // After a hold-to-reset fires, the user often keeps the Esc key down for a
  // beat. Without this guard the next key-repeat lands on the launcher's Esc
  // handler and dismisses the overlay. Stay suppressed until we see keyup.
  let escSuppressUntilKeyup = false;

  // Composer-icon circular progress ring. Lives inside the .launcher-logo span
  // so it stays anchored to the green bolt regardless of layout shifts. The
  // ring is hidden via opacity (not display) so we never reflow during a hold.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RING_R = 13;
  const RING_C = 2 * Math.PI * RING_R;
  const launcherLogoEl = launcherCard.querySelector('.launcher-logo');
  let ringSvg = null, ringArc = null;
  if (launcherLogoEl) {
    ringSvg = document.createElementNS(SVG_NS, 'svg');
    ringSvg.setAttribute('class', 'launcher-logo-ring');
    ringSvg.setAttribute('viewBox', '0 0 32 32');
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'track');
    track.setAttribute('cx', '16'); track.setAttribute('cy', '16'); track.setAttribute('r', String(RING_R));
    ringArc = document.createElementNS(SVG_NS, 'circle');
    ringArc.setAttribute('class', 'arc');
    ringArc.setAttribute('cx', '16'); ringArc.setAttribute('cy', '16'); ringArc.setAttribute('r', String(RING_R));
    ringArc.setAttribute('stroke-dasharray', String(RING_C));
    ringArc.setAttribute('stroke-dashoffset', String(RING_C));
    ringSvg.appendChild(track);
    ringSvg.appendChild(ringArc);
    launcherLogoEl.appendChild(ringSvg);
  }
  function setLogoRing(p) {
    if (!ringSvg || !ringArc) return;
    const v = Math.max(0, Math.min(1, p || 0));
    if (v > 0) ringSvg.classList.add('is-active');
    else ringSvg.classList.remove('is-active');
    ringArc.setAttribute('stroke-dashoffset', String(RING_C * (1 - v)));
  }

  function cancelEscHold() {
    if (escHoldTimer) { clearTimeout(escHoldTimer); escHoldTimer = null; }
    if (escHoldRaf) { cancelAnimationFrame(escHoldRaf); escHoldRaf = null; }
    escHoldStart = 0;
    setLogoRing(0);
    try { window.overlay.setResetProgress(0); } catch {}
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Swallow every Esc keydown (chat or launcher view) until the user
    // releases the key after a hold-to-reset. Prevents the held key from
    // immediately exiting the overlay once the reset drops us into launcher.
    if (escSuppressUntilKeyup) { e.preventDefault(); e.stopPropagation(); return; }
    if (view !== 'chat' || !allowOverlayClose) return;
    if (e.repeat) { e.preventDefault(); return; }
    if (escHoldTimer) { e.preventDefault(); return; }
    e.preventDefault();
    escResetFired = false;
    escHoldStart = performance.now();
    const tick = () => {
      if (!escHoldStart) return;
      const elapsed = performance.now() - escHoldStart;
      const p = Math.min(1, elapsed / ESC_HOLD_MS);
      setLogoRing(p);
      try { window.overlay.setResetProgress(p); } catch {}
      if (p < 1) escHoldRaf = requestAnimationFrame(tick);
    };
    escHoldRaf = requestAnimationFrame(tick);
    escHoldTimer = setTimeout(() => {
      escHoldTimer = null;
      escResetFired = true;
      escSuppressUntilKeyup = true;
      setLogoRing(1);
      try { window.overlay.setResetProgress(1); } catch {}
      Promise.resolve(resetCurrentChat()).finally(() => {
        setLogoRing(0);
        try { window.overlay.setResetProgress(0); } catch {}
      });
    }, ESC_HOLD_MS);
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Escape') return;
    const wasHolding = escHoldStart > 0 || escResetFired;
    const didReset = escResetFired;
    cancelEscHold();
    escResetFired = false;
    escSuppressUntilKeyup = false;
    if (!wasHolding) return;
    if (didReset) return; // suppress dismiss after a successful reset
    if (view === 'chat' && !chatBusy && allowOverlayClose) window.overlay.dismiss();
  }, true);
  // Window losing focus aborts the hold (the user can't see the progress and
  // we should not silently reset on a keyup we'll never receive).
  //
  // Do NOT use capture phase here. Element-level blurs (chatInput losing focus
  // when resetCurrentChat → enterLauncher → lInput.focus() steals it) would
  // otherwise bubble up in capture and clear escSuppressUntilKeyup mid-hold,
  // which then lets the still-held Esc fall through to the launcher's keydown
  // handler and dismiss the overlay. Bind to the window's own blur only.
  window.addEventListener('blur', () => {
    if (escHoldStart || escHoldTimer) cancelEscHold();
    escSuppressUntilKeyup = false;
  });

  // ── Show / hide from the hotkey ──
  window.overlay.onShow((data) => {
    window.overlay.getConfig().then((c) => {
      if (c) {
        allowOverlayClose = c.allowOverlayClose !== false;
        applyCloseBtnVisibility();
      }
    }).catch(() => {});
    // Pick up Win32 selection changes made in the main window since this
    // (preloaded) overlay window first loaded its in-memory copy.
    selectedUiaExes = loadSelectedUiaExes();
    const reqMode = (data && data.mode) || 'chat';
    // Restore an in-flight chat instead of resetting it out from under a stream.
    if (reqMode === 'chat' && chatBusy && chatCurrentExe) { showChatView(); lInput.blur(); return; }
    // Restore a paused conversation when reopening the overlay — covers both
    // the "dismissed mid-chat" case and the user picking the hotkey to come
    // back to an existing thread. sessionStorage is wiped on app restart.
    let restored = false;
    try {
      const persistedView = sessionStorage.getItem('autobot.overlay.view');
      const persistedExe  = sessionStorage.getItem('autobot.overlay.exe');
      if (reqMode === 'chat' && persistedView === 'chat' && persistedExe && chatStore[persistedExe] && chatStore[persistedExe].length) {
        chatCurrentExe = persistedExe;
        const meta = chatMetaStore[persistedExe];
        if (persistedExe === DIRECT_CHAT_ID) chatAppNameEl.textContent = DIRECT_CHAT_NAME;
        else if (meta) chatAppNameEl.textContent = meta.name || persistedExe;
        renderChat();
        showChatView();
        lInput.blur();
        restored = true;
      }
    } catch {}
    if (restored) return;
    enterLauncher(reqMode);
    // Re-detect on every show. The main window's "My apps" edits (CDP toggles
    // for Electron, selectedUiaExes for Win32) don't push to the preloaded
    // overlay's currentApps/cachedUiaApps, so newly added apps would never
    // appear in candidates without this refresh.
    refreshApps().then(() => {
      if (view === 'launcher' && stage === 'app') refreshSuggestions();
    }).catch(() => {});
  });
  window.overlay.onHide(() => {
    // Keep chat state for restore; just clear the launcher input.
    if (view === 'launcher') { lInput.value = ''; lGhost.textContent = ''; }
  });

  // Refresh the running-apps list shortly after load so suggestions are warm.
  setTimeout(() => { refreshApps().then(() => { if (view === 'launcher' && stage === 'app') refreshSuggestions(); }); }, 50);

  // Initial paint.
  enterLauncher('chat');
})();

// ════════════════════════════════════════════════════════════════════════
// Settings-window extras — overlay hotkey rebinding + open logs folder.
// Inert in overlay mode (the navbar is hidden there).
// ════════════════════════════════════════════════════════════════════════
(function initSettingsExtras() {
  const APP_MODE = new URLSearchParams(location.search).get('mode') || 'settings';
  if (APP_MODE === 'overlay') return;
  if (!window.overlay) return;

  const hotkeyBtn = document.getElementById('nav-hotkey');
  const logsBtn   = document.getElementById('nav-logs');

  // Pretty-print an Electron accelerator for the button label.
  function prettyAccel(a) {
    return (a || '')
      .replace(/CommandOrControl|CmdOrCtrl/gi, 'Ctrl')
      .replace(/Control/gi, 'Ctrl')
      .replace(/\+/g, ' + ');
  }

  let capturing = false;
  function setLabel(accel) { if (hotkeyBtn) hotkeyBtn.textContent = `Hotkey: ${prettyAccel(accel) || '—'}`; }

  if (hotkeyBtn) {
    let savedLabelAccel = '';
    window.overlay.getConfig().then((c) => {
      savedLabelAccel = (c && c.hotkey) || '';
      setLabel(savedLabelAccel);
    }).catch(() => setLabel(''));

    // Translate a DOM KeyboardEvent into an Electron accelerator string.
    // Returns null when the event is a modifier-only press or doesn't carry
    // a usable key (IME composition, dead keys, OS-reserved combos).
    function accelFromEvent(e) {
      const raw = e.key;
      if (!raw || raw === 'Unidentified' || raw === 'Process' || raw === 'Dead') return null;
      if (raw === 'Control' || raw === 'Shift' || raw === 'Alt' || raw === 'Meta') return null;
      const parts = [];
      if (e.ctrlKey) parts.push('Control');
      if (e.altKey)  parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Super');
      let key = raw;
      if (key === ' ' || key === 'Spacebar') key = 'Space';
      else if (key === 'ArrowUp') key = 'Up';
      else if (key === 'ArrowDown') key = 'Down';
      else if (key === 'ArrowLeft') key = 'Left';
      else if (key === 'ArrowRight') key = 'Right';
      else if (typeof key === 'string' && key.length === 1) key = key.toUpperCase();
      parts.push(key);
      return parts.join('+');
    }

    hotkeyBtn.addEventListener('click', async () => {
      if (capturing) return;
      capturing = true;
      hotkeyBtn.textContent = 'Press a key combo…  (Esc to cancel)';
      hotkeyBtn.classList.add('capturing');

      // Suspend the currently-bound globalShortcut so the user can press it
      // here (and any combo it overlaps) without the OS-level accelerator
      // swallowing the keystroke and popping the overlay instead.
      try { await window.overlay.suspendHotkey(); } catch {}

      // Safety: if anything strands us in capture state (focus loss, IPC hang,
      // unexpected error), drop out after 15s so the button isn't bricked.
      const safetyTimer = setTimeout(() => {
        if (capturing) {
          finish();
          setLabel(savedLabelAccel);
          showStatus('Hotkey capture timed out — try again.', 'error');
        }
      }, 15000);

      const onKey = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const k = e.key;
        if (k === 'Escape') {
          finish();
          setLabel(savedLabelAccel);
          return;
        }
        // Refuse Tab — it traps focus navigation and is rarely a useful global hotkey.
        if (k === 'Tab') return;
        const accel = accelFromEvent(e);
        if (!accel) return;
        finish();
        let res;
        try {
          res = await window.overlay.setHotkey(accel);
        } catch (err) {
          setLabel(savedLabelAccel);
          showStatus(`Couldn't bind ${prettyAccel(accel)} — ${err && err.message || err}`, 'error');
          return;
        }
        if (res && res.ok) {
          savedLabelAccel = res.hotkey;
          setLabel(res.hotkey);
          showStatus(`Overlay hotkey set to ${prettyAccel(res.hotkey)}`);
        } else {
          setLabel((res && res.hotkey) || savedLabelAccel);
          showStatus(`Couldn't bind ${prettyAccel(accel)} — ${(res && res.error) || 'in use by another app'}`, 'error');
        }
      };
      function finish() {
        capturing = false;
        hotkeyBtn.classList.remove('capturing');
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onBlur, true);
        clearTimeout(safetyTimer);
        // Restore the OS-level hotkey. If setHotkey succeeded, main rebound to
        // the new accel before this call so resume is effectively a no-op;
        // otherwise it restores the previous binding.
        Promise.resolve(window.overlay.resumeHotkey()).catch(() => {});
      }
      // Window losing focus mid-capture (user clicked away) cancels cleanly.
      const onBlur = () => {
        if (!capturing) return;
        finish();
        setLabel(savedLabelAccel);
      };
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onBlur, true);
    });
  }

  if (logsBtn) {
    logsBtn.addEventListener('click', async () => {
      const res = await window.overlay.openLogs();
      if (res && !res.ok) showStatus(`Couldn't open logs: ${res.error}`, 'error');
    });
  }
})();

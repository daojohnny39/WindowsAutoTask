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

      // Self-heal: a transient CDP startup race (e.g. Notion's slow HTTP-listener bind)
      // can flag an app "error" on a single probe. Re-probe error'd apps once, shortly after.
      if (!window.__cdpSelfHealPending && currentApps.some((a) => a.error && a.DebugEnabled && a.DebugPort)) {
        window.__cdpSelfHealPending = true;
        setTimeout(() => {
          window.__cdpSelfHealPending = false;
          refreshApps();
        }, 4000);
      }
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

// ── Nav close (settings window) ──
const navCloseBtn = document.getElementById('nav-close-btn');
if (navCloseBtn) navCloseBtn.addEventListener('click', () => window.close());

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

// ── Screenshot pending state (per-context) ─────────────────────────────────
const pendingShotIdsByContext     = new Map(); // ownerId -> Set<string>
const pendingTurnShotIdsByContext = new Map(); // ownerId -> Set<string>
function getOwnerIdForChat() {
  return chatCurrentExe || DIRECT_CHAT_ID;
}
function trackShot(ownerId, id) {
  if (!pendingShotIdsByContext.has(ownerId)) pendingShotIdsByContext.set(ownerId, new Set());
  pendingShotIdsByContext.get(ownerId).add(id);
}
function untrackShot(ownerId, id) {
  const s = pendingShotIdsByContext.get(ownerId);
  if (s) s.delete(id);
}

function handleOrphanShot(pill) {
  const id = pill.dataset.shotId;
  const ownerId = pill.dataset.ownerId;
  if (!id || !ownerId) return;
  // If id is pending for an in-flight turn, do NOT release — main releases after request finally
  const turnSet = pendingTurnShotIdsByContext.get(ownerId);
  if (turnSet && turnSet.has(id)) return;
  try { window.chat.releaseScreenshot(id); } catch {}
  untrackShot(ownerId, id);
}

function observeShotPillRemoval(container) {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList && node.classList.contains('chat-shot-pill')) {
          handleOrphanShot(node);
        }
        const nested = node.querySelectorAll ? node.querySelectorAll('.chat-shot-pill') : [];
        nested.forEach(handleOrphanShot);
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

// Wire up after DOM is defined (chatInput is defined just above)
observeShotPillRemoval(chatInput);
// Launcher input is inside an IIFE; observe lazily once it exists in the DOM
const _lInputEl = document.getElementById('launcher-input');
if (_lInputEl) observeShotPillRemoval(_lInputEl);

// Per-turn token used to drop stale chat:* IPC events after a Stop / Reset.
// Backend stamps every chat:* send with the turnId it received from sendChatMessage;
// renderer keeps `currentTurnId` and discards events whose id no longer matches.
// Plain `data.exe` filtering is not enough — direct chat reuses DIRECT_CHAT_ID
// across turns, so a late chat:chunk from an aborted stream would contaminate the
// next turn's bubble without this guard.
let currentTurnId = 0;
let nextTurnId    = 1;

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
  if (typeof destroyLiveActivity === 'function') destroyLiveActivity();
  closeClarify(); // switching chats drops any pending choice menu
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
  if (typeof destroyLiveActivity === 'function') destroyLiveActivity();
  closeClarify(); // switching chats drops any pending choice menu
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

chatBackBtn.addEventListener('click', () => { closeAutoPanel(); switchPage('workspace'); });

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

// Build a Set of hosts that appear more than once across the tab list.
// Used to decide row primary: host-first by default, title-first when many
// tabs share the same host (e.g. 5 GitHub repos).
function tabSharedHostSet(tabs) {
  const counts = new Map();
  for (const t of tabs) {
    const h = hostFromUrl(t.url);
    if (!h) continue;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  const shared = new Set();
  for (const [h, n] of counts) if (n > 1) shared.add(h);
  return shared;
}

function tabPrimaryLabel(tab, sharedHosts) {
  const url = (tab.url || '').trim();
  if (url === 'chrome://newtab/' || url.startsWith('chrome://new-tab')) return 'New Tab';
  if (url === 'about:blank' || url === '') {
    return (tab.title || '').trim() || 'Untitled tab';
  }
  const host = hostFromUrl(url);
  const title = (tab.title || '').trim();
  // Many tabs from same host AND we have a title → prefer the title so the
  // user can tell them apart (e.g. 5 github.com repos).
  if (host && sharedHosts && sharedHosts.has(host) && title) return title;
  return host || title || 'Untitled tab';
}

function tabSecondaryLabel(tab, windowCount, primary) {
  const title = (tab.title || '').trim();
  const parts = [];
  if (title && title !== primary) parts.push(title);
  if ((windowCount || 1) > 1 && tab.windowIndex) parts.push(`Window ${tab.windowIndex}`);
  return parts.join(' · ');
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
  closeAutoPanel(); // drop any in-flight automation surface before clearing the chat it was scoped to
  // Invalidate any in-flight turn BEFORE telling main to abort. Stale chat:chunk /
  // chat:done events from the cancelled stream arrive a few ticks later, but
  // currentTurnId=0 makes the renderer drop them so they cannot contaminate the
  // next turn's bubble or push partial content into chatStore.
  currentTurnId = 0;
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
  if (typeof destroyLiveActivity === 'function') destroyLiveActivity();
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
    const shots = Array.isArray(m.screenshots) ? m.screenshots : [];
    let shotsBlock = '';
    if (shots.length) {
      const chips = shots.map(s => {
        const w = Number.isFinite(s.w) ? s.w : 0;
        const h = Number.isFinite(s.h) ? s.h : 0;
        const dims = (w && h) ? (w + '\xd7' + h) : '';
        const src = s.thumbDataUrl || '';
        const imgEl = src
          ? `<img class="chat-msg-shot-thumb" src="${escapeHtml(src)}" alt="">`
          : `<span class="chat-msg-shot-thumb chat-msg-shot-thumb-fallback">${SHOT_GLYPH_SVG}</span>`;
        return `<span class="chat-msg-shot" title="Screenshot${dims ? ' ' + dims : ''}">`
          + imgEl
          + `<span class="chat-msg-shot-label">Screenshot${dims ? ' ' + dims : ''}</span>`
          + `</span>`;
      }).join('');
      shotsBlock = `<div class="chat-msg-shots">${chips}</div>`;
    }
    // When the bubble carries screenshots and the model-side fallback text
    // ("Screenshot attached.") was auto-inserted, skip rendering the redundant
    // line — the chip already labels the attachment.
    const rawC = m.content || '';
    const showText = rawC.length > 0 && !(shots.length && rawC === 'Screenshot attached.');
    const textBlock = showText
      ? `<div class="chat-msg-user-text">${renderUserContent(rawC)}</div>`
      : '';
    return `<div class="chat-msg chat-msg-user${shots.length ? ' has-shots' : ''}">${shotsBlock}${textBlock}</div>`;
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
        <span class="chat-thinking-hint">Esc to stop</span>
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
  if (data.turnId != null && data.turnId !== currentTurnId) return; // stale stream after Stop/Reset
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
  if (data.turnId != null && data.turnId !== currentTurnId) return;
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
  if (data.turnId != null && data.turnId !== currentTurnId) return;
  if (data.name === 'ask_user') return; // rendered as a clarify card, not a tool line
  hideThinking();
  // Cancel any pending error-flash revert; the new start phrase takes over the top line.
  if (liveErrorFlashTimer) { clearTimeout(liveErrorFlashTimer); liveErrorFlashTimer = null; }
  const args = data.args || {};
  const label = data.label || null;
  const ctx = { args, label, result: null };
  const phrase = phraseForToolStart(data.name, ctx);
  thinkingFallback = `${phrase.charAt(0).toLowerCase() + phrase.slice(1)}…`;

  ensureLiveActivity();
  const entry = getOrCreateTrailEntry(data.callId, {
    name: data.name,
    args,
    label,
    result: null,
    refInfo: null,
    _startPhrase: phrase,
  });
  // If the call id was re-fired (defensive), refresh start fields.
  entry.name = data.name;
  entry.args = args;
  entry.label = label;
  entry._startPhrase = phrase;
  liveActivity.topEntry = entry;
  clearTopLineError();
  const glyph = data.name === 'web_search' ? '🌐' : '⚙';
  setTopLine(glyph, phrase, '');
  if (liveActivity.expanded) {
    // If this is a re-fired callId, update the existing row; otherwise append.
    if (entry.callId && liveActivity.bodyEl.querySelector(
      `.chat-live-body-row[data-call-id="${CSS.escape(entry.callId)}"]`
    )) {
      updateBodyRow(entry);
    } else {
      appendBodyRow(entry);
    }
  }
  refreshLiveToggle();
  repinAboveThinking();

  // pendingToolPills back-fills sparse result payloads (args/label may not be re-sent).
  if (data.callId) {
    pendingToolPills.set(data.callId, { name: data.name, args, label, exe: data.exe });
  }
  scrollChatToBottom();
});

// Inline URL citations from the hosted web_search tool. Collected for the
// currently streaming assistant turn, deduplicated by URL, then rendered as a
// Sources footer when chat:done lands. Ignore events for stale streams.
window.chat.onCitation((data) => {
  if (data.exe !== chatStreamExe) return;
  if (data.turnId != null && data.turnId !== currentTurnId) return;
  if (!data.url) return;
  if (chatStreamSources.some(s => s.url === data.url)) return;
  chatStreamSources.push({ url: data.url, title: data.title || '' });
});

window.chat.onToolResult((data) => {
  // Always settle the pending pill — even if this result belongs to a stale
  // exe (user switched chats mid-turn). Otherwise the Map leaks one entry
  // per orphaned tool call until reload.
  const pending = data.callId ? pendingToolPills.get(data.callId) : null;
  if (data.callId) pendingToolPills.delete(data.callId);
  if (data.exe !== chatCurrentExe) return;
  if (data.turnId != null && data.turnId !== currentTurnId) return;
  if (data.name === 'ask_user') return; // card already reflects the answer
  const args = data.args || (pending && pending.args) || {};
  const label = data.label || (pending && pending.label) || null;
  const errorRaw = data.errorRaw || (data.result && data.result.error) || null;
  const ctx = { args, label, result: data.result || null, error: errorRaw };

  // Side-effect for web_search: thread the sources into the in-flight bubble.
  if (data.name === 'web_search' && !errorRaw && data.result && Array.isArray(data.result.sources)) {
    for (const s of data.result.sources) {
      if (s && s.url && !chatStreamSources.some(x => x.url === s.url)) {
        chatStreamSources.push({ url: s.url, title: s.title || '' });
      }
    }
  }

  const donePhrase = errorRaw ? phraseForToolFail(data.name, ctx) : phraseForToolDone(data.name, ctx);
  thinkingFallback = donePhrase.charAt(0).toLowerCase() + donePhrase.slice(1);
  thinkingBuffer = '';

  // Update / settle the live trail entry. If this result arrives without a
  // matching start (rare — sparse payload, or strip rebuilt after a renderChat
  // wipe lost in-flight entries), synthesize one so the body still shows it.
  ensureLiveActivity();
  let entry = data.callId ? liveActivity.byCallId.get(data.callId) : null;
  if (!entry) {
    entry = getOrCreateTrailEntry(data.callId, {
      name: data.name,
      args,
      label,
      result: null,
      refInfo: null,
      _startPhrase: phraseForToolStart(data.name, ctx),
    });
  }
  entry.result = data.result || { ok: !errorRaw };
  entry.args = entry.args || args;
  entry.label = entry.label || label;
  if (errorRaw) entry._failPhrase = donePhrase;
  else entry._donePhrase = donePhrase;
  updateBodyRow(entry);
  refreshLiveToggle();

  if (errorRaw) {
    // Flash ✕ + raw-error tooltip on top line for ~1.2s, then revert to the
    // last-known running start phrase (or the just-settled start phrase if
    // nothing else is in flight). Next onTool cancels the timer.
    setTopLineError(donePhrase, String(errorRaw));
    if (liveErrorFlashTimer) clearTimeout(liveErrorFlashTimer);
    const revertEntry = entry;
    liveErrorFlashTimer = setTimeout(() => {
      liveErrorFlashTimer = null;
      if (!liveActivity || !liveActivity.flashingFail) return;
      clearTopLineError();
      const glyph = revertEntry.name === 'web_search' ? '🌐' : '⚙';
      setTopLine(glyph, revertEntry._startPhrase || phraseForToolStart(revertEntry.name, ctx), '');
    }, 1200);
  }
  // On success, top line stays as last-started action (user choice). When the
  // model goes back to reasoning between tools, the thinking pill paints below.

  showThinking(thinkingFallback);
  repinAboveThinking();
});

// Clarifying-question handling (mid-turn `ask_user`). The question text is shown
// as a transient `#chat-clarify-card` in the message list (scrollback context +
// where the chosen answer is stamped). The CHOICES render in a floating
// `#chat-clarify-menu` above the composer — same look + keyboard model as the
// app-selector dropdown: Up/Down highlight, Enter submits the highlight. The user
// can also type a custom answer in the main composer and hit Enter; an empty
// composer + Enter submits the highlighted choice. Choices stay mouse-clickable.
const CLARIFY_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M9 12l2 2 4-4"></path></svg>';

// { exe, callId, options:[], idx } while an ask_user clarify awaits an answer.
let clarifyState = null;

window.chat.onAsk((data) => {
  if (data.exe !== chatCurrentExe) return;
  if (data.turnId != null && data.turnId !== currentTurnId) return;
  hideThinking();
  // Clear any competing UI: a stale slash/app/tab dropdown or a previous
  // unanswered clarify (rapid re-ask) must not overlap or get mis-stamped.
  closeSlash();
  closeClarify();
  const old = document.getElementById('chat-clarify-card');
  if (old) old.remove();

  const exe = data.exe;
  const options = (Array.isArray(data.options) ? data.options : [])
    .map((o) => String(o == null ? '' : o).trim()).filter(Boolean);

  // Transient transcript card — question only; answer is stamped on submit.
  const card = document.createElement('div');
  card.className = 'chat-clarify-card';
  card.id = 'chat-clarify-card';
  const q = document.createElement('div');
  q.className = 'chat-clarify-question';
  q.textContent = data.question || 'Which option do you want?';
  card.appendChild(q);
  chatMessagesEl.appendChild(card);
  scrollChatToBottom();

  clarifyState = { exe, callId: data.callId || null, options, idx: 0 };

  if (options.length) {
    renderClarifyMenu();
    clarifyMenuEl.hidden = false;
    // Composer becomes the custom-answer escape hatch while choices are shown.
    try { chatInput.dataset.placeholder = 'Type a Custom Answer…'; } catch {}
    // No positionMenu — clarify menu pins full-width above .chat-input-wrap via CSS
    // (app-selector look), unlike the caret-anchored slash/app/tab popovers.
    if (typeof window.__overlaySizeForChat === 'function') {
      requestAnimationFrame(() => window.__overlaySizeForChat({ immediate: true }));
    }
  }
  // Focus the main composer so typing a custom answer works immediately.
  setTimeout(() => { try { chatInput.focus(); } catch {} }, 0);
});

function renderClarifyMenu() {
  if (!clarifyState || !clarifyState.options.length) return;
  // Render rows in the launcher app-selector look (.ld-row): icon tile, bold
  // label, and a "hit enter" badge that appears on the active row. Identical
  // visual + keyboard model to the overlay app picker.
  const rows = clarifyMenuListEl.children;
  if (rows.length === clarifyState.options.length) {
    // Patch in place: only flip .active so the ldRowIn entrance keyframe does
    // not re-fire on every arrow press (would read as a list-wide flicker).
    for (let i = 0; i < rows.length; i++) {
      const on = i === clarifyState.idx;
      rows[i].classList.toggle('active', on);
      rows[i].setAttribute('aria-selected', on);
    }
  } else {
    clarifyMenuListEl.innerHTML = clarifyState.options.map((opt, i) => `
      <div class="ld-row${i === clarifyState.idx ? ' active' : ''}" role="option"
           data-i="${i}" aria-selected="${i === clarifyState.idx}">
        <span class="ld-icon">${CLARIFY_GLYPH_SVG}</span>
        <span class="ld-text"><span class="ld-name">${escapeHtml(opt)}</span></span>
        <span class="ld-enter">hit <kbd>enter</kbd></span>
      </div>`).join('');
  }
  const ar = clarifyMenuListEl.querySelector('.ld-row.active');
  if (ar) ar.scrollIntoView({ block: 'nearest' });
}

// Hide the floating choice menu and drop pending state. Idempotent — safe to
// call from turn-end / context-switch sites even when no clarify is pending.
function closeClarify() {
  clarifyState = null;
  if (clarifyMenuEl) {
    clarifyMenuEl.hidden = true;
    clarifyMenuListEl.innerHTML = '';
  }
  // Restore the default composer placeholder after a clarify closes.
  try { chatInput.dataset.placeholder = 'Send a message…'; } catch {}
  if (typeof window.__overlaySizeForChat === 'function') {
    requestAnimationFrame(() => window.__overlaySizeForChat({ immediate: true }));
  }
}

function answerClarify(answer) {
  // Capture-then-null so a key-repeat Enter or a fast mouse click can't double-submit.
  const state = clarifyState;
  if (!state) return;
  const text = String(answer == null ? '' : answer).trim();
  if (!text) return; // empty highlight w/ no options → ignore
  clarifyState = null;
  window.chat.answer({ exe: state.exe, answer: text });

  // Stamp the chosen answer onto the transcript card.
  const card = document.getElementById('chat-clarify-card');
  if (card && !card.classList.contains('answered')) {
    card.classList.add('answered');
    const ans = document.createElement('div');
    ans.className = 'chat-clarify-answer';
    ans.textContent = text;
    card.appendChild(ans);
  }

  // Consume any typed custom text and tear down the floating menu.
  clearChatInput();
  closeClarify();
  try { chatInput.focus(); } catch {}

  // Model resumes the turn.
  thinkingFallback = 'thinking…';
  thinkingBuffer = '';
  showThinking(thinkingFallback);
}

// ── Tool pill phrasebook ─────────────────────────────────────────────────────
// Turns raw tool calls into plain English a non-technical user can follow.
// Each entry has start/done/fail producers; each takes a ctx
// { args, label, result, error } and returns a plain string.
// All ctx fields are optional — old saved trails lacking `label`/`callId`
// still render gracefully via fallbacks.
function _truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function _cap(s) {
  s = String(s == null ? '' : s);
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
function _modsPrefix(mods) {
  if (!Array.isArray(mods) || !mods.length) return '';
  return mods.map(_cap).join('+') + '+';
}
function _humanizeUnknownTool(name) {
  return String(name || '')
    .replace(/^(cdp|uia|notion)_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase()) || 'tool';
}

const TOOL_PHRASES = {
  cdp_list_windows: {
    start: () => 'Checking open windows',
    done: ({ result }) => {
      const n = (result && (result.count || (Array.isArray(result.windows) && result.windows.length))) || 0;
      return n ? `Found ${n} open window${n === 1 ? '' : 's'}` : 'Found no open windows';
    },
    fail: () => "Couldn't list open windows",
  },
  cdp_select_window: {
    start: ({ args = {} }) => typeof args.index === 'number' ? `Switching to window #${args.index + 1}` : 'Switching window',
    done: ({ args = {}, result }) => {
      const title = result && result.active && result.active.title;
      if (title) return `Switched to "${_truncate(title, 60)}"`;
      if (typeof args.index === 'number') return `Switched to window #${args.index + 1}`;
      return 'Switched window';
    },
    fail: () => "Couldn't switch window",
  },
  cdp_get_tree: {
    start: ({ args = {} }) => args.region ? `Scanning the ${args.region} area` : 'Scanning the page',
    done: ({ result }) => `Scanned the page (${(result && result.refs) || 0} elements)`,
    fail: () => "Couldn't scan the page",
  },
  cdp_find: {
    start: ({ args = {} }) => args.query ? `Searching the page for "${_truncate(args.query, 60)}"` : 'Searching the page',
    done: ({ args = {}, result }) => {
      const n = (result && (result.count || (Array.isArray(result.results) && result.results.length))) || 0;
      const q = args.query ? ` for "${_truncate(args.query, 40)}"` : '';
      return `Found ${n} match${n === 1 ? '' : 'es'}${q}`;
    },
    fail: () => "Couldn't search the page",
  },
  cdp_click: {
    start: ({ args = {}, label }) => {
      const target = label || 'an element';
      const mods = _modsPrefix(args.modifiers);
      if (mods) return `${mods}clicking ${target}`;
      if (args.button === 'middle') return `Middle-clicking ${target}`;
      if (args.button === 'right') return `Right-clicking ${target}`;
      return `Clicking ${target}`;
    },
    done: ({ args = {}, label }) => {
      const target = label || 'an element';
      const mods = _modsPrefix(args.modifiers);
      if (mods) return `${mods}clicked ${target}`;
      if (args.button === 'middle') return `Middle-clicked ${target}`;
      if (args.button === 'right') return `Right-clicked ${target}`;
      return `Clicked ${target}`;
    },
    fail: ({ label }) => `Couldn't click ${label || 'that element'}`,
  },
  cdp_open_notion_page: {
    start: () => 'Opening a Notion page',
    done: () => 'Opened the Notion page',
    fail: () => "Couldn't open the Notion page",
  },
  cdp_open_in_new_tab: {
    start: ({ args = {} }) => {
      const what = args.pageName ? `"${_truncate(args.pageName, 30)}"` : args.url ? _truncate(args.url, 40) : 'a page';
      return `Opening ${what} in a new tab`;
    },
    done: ({ args = {} }) => {
      const what = args.pageName ? `"${_truncate(args.pageName, 30)}"` : args.url ? _truncate(args.url, 40) : 'the page';
      return `Opened ${what} in a new tab`;
    },
    fail: ({ args = {} }) => {
      const what = args.pageName ? `"${_truncate(args.pageName, 30)}"` : args.url ? _truncate(args.url, 40) : 'the page';
      return `Couldn't open ${what} in a new tab`;
    },
  },
  notion_tasklist_read: {
    start: () => 'Reading the Notion task list',
    done: ({ result }) => {
      const n = (result && (result.count
        || (Array.isArray(result.tasks) && result.tasks.length)
        || (Array.isArray(result.rows) && result.rows.length))) || 0;
      return `Read ${n} task${n === 1 ? '' : 's'}`;
    },
    fail: () => "Couldn't read the task list",
  },
  notion_task_toggle: {
    start: ({ args = {} }) => args.checked === false ? 'Unchecking a task' : args.checked === true ? 'Checking off a task' : 'Toggling a task',
    done: ({ args = {} }) => args.checked === false ? 'Unchecked the task' : args.checked === true ? 'Checked off the task' : 'Toggled the task',
    fail: () => "Couldn't toggle the task",
  },
  cdp_type: {
    start: ({ args = {}, label }) => `Typing "${_truncate(args.text, 40)}" into ${label || 'a field'}`,
    done: ({ args = {}, label }) => `Typed "${_truncate(args.text, 40)}" into ${label || 'a field'}`,
    fail: ({ label }) => `Couldn't type into ${label || 'that field'}`,
  },
  cdp_paste: {
    start: ({ args = {}, label }) => `Pasting "${_truncate(args.text, 40)}" into ${label || 'a field'}`,
    done: ({ args = {}, label }) => `Pasted "${_truncate(args.text, 40)}" into ${label || 'a field'}`,
    fail: ({ label }) => `Couldn't paste into ${label || 'that field'}`,
  },
  cdp_press_key: {
    start: ({ args = {} }) => `Pressing ${_modsPrefix(args.modifiers)}${args.key || 'a key'}`,
    done: ({ args = {} }) => `Pressed ${_modsPrefix(args.modifiers)}${args.key || 'a key'}`,
    fail: ({ args = {} }) => `Couldn't press ${args.key || 'that key'}`,
  },
  cdp_get_text: {
    start: ({ label }) => `Reading text from ${label || 'an element'}`,
    done: ({ result }) => {
      const t = result && typeof result.text === 'string' ? result.text.slice(0, 80).replace(/\n/g, ' ') : '';
      return t ? `Read "${t}"` : 'Read text';
    },
    fail: () => "Couldn't read text",
  },
  cdp_get_messages: {
    start: ({ args = {} }) => `Reading the last ${args.limit || 25} messages`,
    done: ({ result }) => {
      const n = (result && (result.count || (Array.isArray(result.messages) && result.messages.length))) || 0;
      return `Read ${n} message${n === 1 ? '' : 's'}`;
    },
    fail: () => "Couldn't read messages",
  },
  cdp_react: {
    start: ({ args = {} }) => `Adding :${args.emoji || 'reaction'}: reaction`,
    done: ({ args = {} }) => `Reacted with :${args.emoji || 'an emoji'}:`,
    fail: ({ args = {} }) => `Couldn't react with :${args.emoji || 'that emoji'}:`,
  },
  cdp_scroll_to_message: {
    start: () => 'Jumping to that message',
    done: () => 'Jumped to that message',
    fail: () => "Couldn't jump to that message",
  },
  cdp_scroll: {
    start: ({ args = {} }) => `Scrolling ${args.direction || 'up'}`,
    done: ({ args = {} }) => `Scrolled ${args.direction || 'up'}`,
    fail: ({ args = {} }) => (`Couldn't scroll ${args.direction || ''}`).trim(),
  },
  cdp_scroll_messages: {
    start: ({ args = {} }) => `Scrolling messages ${args.direction || 'up'}`,
    done: ({ args = {} }) => `Scrolled messages ${args.direction || 'up'}`,
    fail: () => "Couldn't scroll messages",
  },
  cdp_get_search_results: {
    start: () => 'Reading the search results panel',
    done: ({ result }) => {
      const n = (result && (result.count || (Array.isArray(result.results) && result.results.length))) || 0;
      const sort = result && result.sortMode ? ` (${result.sortMode})` : '';
      return `Read ${n} search result${n === 1 ? '' : 's'}${sort}`;
    },
    fail: () => "Couldn't read search results",
  },
  cdp_set_search_sort: {
    start: ({ args = {} }) => `Sorting search results by ${args.order || 'newest'}`,
    done: ({ args = {} }) => `Sorted search results by ${args.order || 'newest'}`,
    fail: () => "Couldn't change the search sort",
  },
  cdp_jump_to_search_result: {
    start: () => 'Jumping to that search result',
    done: () => 'Jumped to that search result',
    fail: () => "Couldn't jump to that search result",
  },
  cdp_get_pins: {
    start: () => 'Reading pinned messages',
    done: ({ result }) => {
      const n = (result && (result.count || (Array.isArray(result.pins) && result.pins.length))) || 0;
      return `Read ${n} pinned message${n === 1 ? '' : 's'}`;
    },
    fail: () => "Couldn't read pinned messages",
  },
  cdp_jump_to_pin: {
    start: () => 'Jumping to that pinned message',
    done: () => 'Jumped to that pinned message',
    fail: () => "Couldn't jump to that pinned message",
  },
  cdp_open_image: {
    start: () => 'Opening that image full-screen',
    done: () => 'Opened that image full-screen',
    fail: () => "Couldn't open that image",
  },
  cdp_jump_to_reply_source: {
    start: () => 'Jumping to the original message',
    done: () => 'Jumped to the original message',
    fail: () => "Couldn't find the original message",
  },
  uia_invoke: {
    start: ({ label }) => `Clicking ${label || 'an element'}`,
    done: ({ label }) => `Clicked ${label || 'an element'}`,
    fail: ({ label }) => `Couldn't click ${label || 'that element'}`,
  },
  uia_set_value: {
    start: ({ args = {}, label }) => `Typing "${_truncate(args.text, 40)}" into ${label || 'a field'}`,
    done: ({ args = {}, label }) => `Typed "${_truncate(args.text, 40)}" into ${label || 'a field'}`,
    fail: ({ label }) => `Couldn't type into ${label || 'that field'}`,
  },
  uia_get_tree: {
    start: () => 'Scanning the window',
    done: ({ result }) => `Scanned the window (${(result && result.refs) || 0} elements)`,
    fail: () => "Couldn't scan the window",
  },
  web_search: {
    start: ({ args = {} }) => args.query ? `Searching the web for "${_truncate(args.query, 60)}"` : 'Searching the web',
    done: ({ result }) => {
      const n = (result && (result.count || (Array.isArray(result.sources) && result.sources.length))) || 0;
      return `Found ${n} web source${n === 1 ? '' : 's'}`;
    },
    fail: () => 'Web search failed',
  },
  select_app: {
    start: ({ args = {} }) => `Switching to ${args.app || 'another app'}`,
    done: ({ args = {}, result }) => {
      const name = (result && (result.activeName || (result.active && result.active.name))) || args.app || 'the app';
      return `Switched to ${name}`;
    },
    fail: ({ args = {} }) => `Couldn't switch to ${args.app || 'that app'}`,
  },
};

function phraseForToolStart(name, ctx) {
  const entry = TOOL_PHRASES[name];
  if (entry && typeof entry.start === 'function') {
    try { return entry.start(ctx || {}); } catch {}
  }
  return `Running ${_humanizeUnknownTool(name)}`;
}
function phraseForToolDone(name, ctx) {
  const entry = TOOL_PHRASES[name];
  if (entry && typeof entry.done === 'function') {
    try { return entry.done(ctx || {}); } catch {}
  }
  return `Did ${_humanizeUnknownTool(name)}`;
}
function phraseForToolFail(name, ctx) {
  const entry = TOOL_PHRASES[name];
  if (entry && typeof entry.fail === 'function') {
    try { return entry.fail(ctx || {}); } catch {}
  }
  return `Couldn't ${_humanizeUnknownTool(name).toLowerCase()}`;
}

// Pair tool start/result by callId so a sparse `chat:tool-result` payload can
// recover args/label that were known only at start time. Entries are deleted
// unconditionally in onToolResult — even when the result belongs to a stale
// exe — so the Map can't accumulate orphans across chats.
const pendingToolPills = new Map(); // callId → { name, args, label, exe }

// ── Live activity strip ─────────────────────────────────────────────────────
// One persistent block per in-flight turn, pinned above the thinking pill.
// Top line shows the most recently started action (⚙ phrase…); a toggle below
// expands the full pill history (⚙ start + ✓/✕ result pairs) so the user can
// inspect what GPT did so far without waiting for chat:done. On chat:done /
// chat switch / abort, the strip is destroyed and the canonical "Show N
// actions" trail block (rendered by renderTurn) takes over.
//
// Trail entries are shape-compatible with the persisted m.trail entries used
// by renderTrailPills: { name, args, result, refInfo, callId, label }. State
// is derived (result == null → running, result.error → failed, else done).
// Cached phrases live on _startPhrase / _donePhrase / _failPhrase so a later
// expand paints the right text even after the entry settled.
let liveActivity = null;
let liveErrorFlashTimer = null;
let _liveBodyIdCounter = 0;

function buildLiveActivityEl() {
  const el = document.createElement('div');
  el.className = 'chat-live-activity';
  const bodyId = `chat-live-body-${++_liveBodyIdCounter}`;
  el.innerHTML = `
    <div class="chat-live-current" aria-live="polite">
      <span class="chat-live-glyph">⚙</span>
      <span class="chat-live-phrase"></span>
    </div>
    <button class="chat-live-toggle" type="button" aria-expanded="false" aria-controls="${bodyId}">
      <span class="chat-live-chevron">›</span>
      <span class="chat-live-count">Show 0 actions</span>
    </button>
    <div class="chat-live-body" id="${bodyId}" hidden></div>`;
  return {
    el,
    phraseEl: el.querySelector('.chat-live-phrase'),
    glyphEl: el.querySelector('.chat-live-glyph'),
    currentEl: el.querySelector('.chat-live-current'),
    toggleEl: el.querySelector('.chat-live-toggle'),
    countEl: el.querySelector('.chat-live-count'),
    bodyEl: el.querySelector('.chat-live-body'),
  };
}

// Pin the strip directly above the thinking pill so the visual order is
// stable: [strip] → [thinking pill] → [next message]. Without this, calling
// chatMessagesEl.appendChild(thinkingEl) (from showThinking) after the strip
// was already appended would push the strip above thinking — which is what we
// want — but a later strip rebuild could land below. Re-pin on every mutation.
function repinAboveThinking() {
  if (!liveActivity || !liveActivity.el) return;
  const thinkingEl = document.getElementById('chat-thinking');
  if (thinkingEl && thinkingEl.parentNode === chatMessagesEl) {
    if (liveActivity.el.nextSibling !== thinkingEl) {
      chatMessagesEl.insertBefore(liveActivity.el, thinkingEl);
    }
  } else if (liveActivity.el.parentNode !== chatMessagesEl
             || liveActivity.el !== chatMessagesEl.lastChild) {
    chatMessagesEl.appendChild(liveActivity.el);
  }
}

function ensureLiveActivity() {
  if (liveActivity && liveActivity.el && liveActivity.el.isConnected) {
    repinAboveThinking();
    return liveActivity;
  }
  // First call of the turn, or a mid-stream renderChat() wiped the element.
  // Rebuild DOM from preserved state if any.
  const prior = liveActivity;
  const parts = buildLiveActivityEl();
  liveActivity = {
    ...parts,
    expanded: prior ? !!prior.expanded : false,
    trail: prior ? prior.trail : [],
    byCallId: prior ? prior.byCallId : new Map(),
    topEntry: prior ? prior.topEntry || null : null,
    topStatePhrase: prior ? prior.topStatePhrase || '' : '',
    topStateGlyph: prior ? prior.topStateGlyph || '⚙' : '⚙',
    topStateTitle: prior ? prior.topStateTitle || '' : '',
    flashingFail: prior ? !!prior.flashingFail : false,
  };
  // Repaint preserved state.
  liveActivity.glyphEl.textContent = liveActivity.topStateGlyph || '⚙';
  liveActivity.phraseEl.textContent = liveActivity.topStatePhrase || '';
  liveActivity.currentEl.title = liveActivity.topStateTitle || '';
  liveActivity.currentEl.classList.toggle('error', !!liveActivity.flashingFail);
  refreshLiveToggle();
  if (liveActivity.expanded) {
    liveActivity.bodyEl.hidden = false;
    liveActivity.toggleEl.setAttribute('aria-expanded', 'true');
    liveActivity.toggleEl.classList.add('open');
    repaintLiveBody();
  }
  liveActivity.toggleEl.addEventListener('click', onLiveToggleClick);
  repinAboveThinking();
  return liveActivity;
}

function refreshLiveToggle() {
  if (!liveActivity) return;
  const n = liveActivity.trail.length;
  const verb = liveActivity.expanded ? 'Hide' : 'Show';
  liveActivity.countEl.textContent = `${verb} ${n} action${n === 1 ? '' : 's'}`;
  // Hide toggle entirely when there's nothing yet.
  liveActivity.toggleEl.style.display = n > 0 ? '' : 'none';
}

function onLiveToggleClick() {
  if (!liveActivity) return;
  liveActivity.expanded = !liveActivity.expanded;
  liveActivity.bodyEl.hidden = !liveActivity.expanded;
  liveActivity.toggleEl.setAttribute('aria-expanded', String(liveActivity.expanded));
  liveActivity.toggleEl.classList.toggle('open', liveActivity.expanded);
  if (liveActivity.expanded) repaintLiveBody();
  refreshLiveToggle();
  // Don't auto-scroll/auto-focus — streaming content should not steal focus.
}

// Build the row markup for one trail entry. `running` entries render only the
// start line (no result row yet); settled entries render the canonical pair.
function liveBodyRowHtml(entry) {
  const args = entry.args || {};
  const label = entry.label || _labelFromRefInfo(entry.refInfo) || null;
  const result = entry.result || null;
  const error = (result && result.error) || null;
  const ctx = { args, label, result, error };
  const startPhrase = entry._startPhrase || phraseForToolStart(entry.name, ctx);
  const startLine = `<div class="chat-tool-line">⚙ ${escapeHtml(startPhrase)}…</div>`;
  if (!result) return startLine;
  const finalPhrase = error
    ? (entry._failPhrase || phraseForToolFail(entry.name, ctx))
    : (entry._donePhrase || phraseForToolDone(entry.name, ctx));
  const glyph = error ? '✕' : '✓';
  const titleAttr = error ? ` title="${escapeHtml(String(error))}"` : '';
  const resultLine = `<div class="chat-tool-line"${titleAttr}>${glyph} ${escapeHtml(finalPhrase)}</div>`;
  return startLine + resultLine;
}

function repaintLiveBody() {
  if (!liveActivity) return;
  const html = liveActivity.trail.map(entry => {
    return `<div class="chat-live-body-row" data-call-id="${escapeHtml(entry.callId || '')}">${liveBodyRowHtml(entry)}</div>`;
  }).join('');
  liveActivity.bodyEl.innerHTML = html;
}

function appendBodyRow(entry) {
  if (!liveActivity || !liveActivity.expanded) return;
  const row = document.createElement('div');
  row.className = 'chat-live-body-row';
  if (entry.callId) row.dataset.callId = entry.callId;
  row.innerHTML = liveBodyRowHtml(entry);
  liveActivity.bodyEl.appendChild(row);
}

function updateBodyRow(entry) {
  if (!liveActivity || !liveActivity.expanded) return;
  if (!entry.callId) { repaintLiveBody(); return; }
  const row = liveActivity.bodyEl.querySelector(
    `.chat-live-body-row[data-call-id="${CSS.escape(entry.callId)}"]`
  );
  if (!row) { appendBodyRow(entry); return; }
  row.innerHTML = liveBodyRowHtml(entry);
}

function getOrCreateTrailEntry(callId, init) {
  if (!liveActivity) return null;
  let key = callId || `local:${liveActivity.trail.length}`;
  let entry = liveActivity.byCallId.get(key);
  if (entry) {
    Object.assign(entry, init);
    return entry;
  }
  entry = { callId: callId || null, ...init };
  liveActivity.trail.push(entry);
  liveActivity.byCallId.set(key, entry);
  return entry;
}

function setTopLine(glyph, phrase, title) {
  if (!liveActivity) return;
  liveActivity.glyphEl.textContent = glyph;
  liveActivity.phraseEl.textContent = phrase ? `${phrase}…` : '';
  liveActivity.currentEl.title = title || '';
  liveActivity.topStateGlyph = glyph;
  liveActivity.topStatePhrase = phrase || '';
  liveActivity.topStateTitle = title || '';
}

function setTopLineError(phrase, title) {
  if (!liveActivity) return;
  liveActivity.glyphEl.textContent = '✕';
  liveActivity.phraseEl.textContent = phrase || '';
  liveActivity.currentEl.title = title || '';
  liveActivity.currentEl.classList.add('error');
  liveActivity.topStateGlyph = '✕';
  liveActivity.topStatePhrase = phrase || '';
  liveActivity.topStateTitle = title || '';
  liveActivity.flashingFail = true;
}

function clearTopLineError() {
  if (!liveActivity) return;
  liveActivity.currentEl.classList.remove('error');
  liveActivity.flashingFail = false;
}

function destroyLiveActivity() {
  if (liveErrorFlashTimer) { clearTimeout(liveErrorFlashTimer); liveErrorFlashTimer = null; }
  if (liveActivity && liveActivity.el) {
    try { liveActivity.toggleEl.removeEventListener('click', onLiveToggleClick); } catch {}
    try { liveActivity.el.remove(); } catch {}
  }
  liveActivity = null;
}

// Renderer-side mirror of main.js humanLabelFromRefInfo, used to humanize old
// saved trail entries that pre-date the persisted `label` field.
function _labelFromRefInfo(refInfo) {
  if (!refInfo) return null;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const aria = clean(refInfo.aria);
  const text = clean(refInfo.text);
  const name = clean(refInfo.name);
  const autoId = clean(refInfo.automationId);
  const id = clean(refInfo.id);
  const role = clean(refInfo.role).toLowerCase();
  const ctrl = clean(refInfo.controlType).toLowerCase();
  const tag = clean(refInfo.tag).toLowerCase();
  let label = aria || name || text || autoId || id;
  if (!label) return null;
  if (label.length > 60) label = label.slice(0, 57) + '…';
  let kind = '';
  if (role === 'button' || ctrl === 'button' || tag === 'button') kind = 'button';
  else if (role === 'link' || ctrl === 'hyperlink' || tag === 'a') kind = 'link';
  else if (role === 'textbox' || role === 'searchbox' || ctrl === 'edit' || tag === 'input' || tag === 'textarea') kind = 'field';
  else if (role === 'checkbox' || ctrl === 'checkbox') kind = 'checkbox';
  else if (role === 'tab' || ctrl === 'tabitem') kind = 'tab';
  else if (role === 'menuitem') kind = 'menu item';
  else if (role === 'listitem' || role === 'option') kind = 'item';
  if (kind && !label.toLowerCase().includes(kind)) label = `${label} ${kind}`;
  return label;
}

function renderTrailPills(trail) {
  return trail.map(t => {
    if (t.name === 'ask_user') {
      const q = (t.args && t.args.question) ? String(t.args.question) : 'clarifying question';
      const r = t.result || {};
      const ans = r.answer !== undefined ? `→ "${String(r.answer)}"` : (r.aborted ? '→ (cancelled)' : (r.error ? '→ (no answer)' : ''));
      return `<div class="chat-tool-line">❓ ${escapeHtml(q)} ${escapeHtml(ans)}</div>`;
    }
    const args = t.args || {};
    const label = t.label || _labelFromRefInfo(t.refInfo) || null;
    const result = t.result || null;
    const error = (result && result.error) || null;
    const ctx = { args, label, result, error };
    const startPhrase = phraseForToolStart(t.name, ctx);
    const finalPhrase = error ? phraseForToolFail(t.name, ctx) : phraseForToolDone(t.name, ctx);
    const glyph = error ? '✕' : '✓';
    const titleAttr = error ? ` title="${escapeHtml(String(error))}"` : '';
    const callLine = `<div class="chat-tool-line">⚙ ${escapeHtml(startPhrase)}…</div>`;
    const resultLine = `<div class="chat-tool-line"${titleAttr}>${glyph} ${escapeHtml(finalPhrase)}</div>`;
    return callLine + resultLine;
  }).join('');
}

window.chat.onDone((data) => {
  if (data.exe !== chatStreamExe) return;
  if (data.turnId != null && data.turnId !== currentTurnId) return; // stale stream finalized after Stop/Reset
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
  closeClarify(); // turn ended (done/abort) — drop any stale choice menu
  // Destroy live activity strip BEFORE renderChat — the canonical "Show N
  // actions" trail block on the assistant turn takes over.
  destroyLiveActivity();

  if (targetExe === chatCurrentExe) {
    renderChat();
  }
  updateChatEmptyClass();

  // Release screenshot ids that were in-flight for this turn
  const doneOwnerId = targetExe || null;
  if (doneOwnerId) {
    const turnSet = pendingTurnShotIdsByContext.get(doneOwnerId);
    if (turnSet && turnSet.size) {
      for (const id of turnSet) { try { window.chat.releaseScreenshot(id); } catch {} }
      turnSet.clear();
    }
  }
});

async function sendChatMessage(forcedText, forcedApps, forcedAttachments) {
  const rawText = forcedText !== undefined ? forcedText : serializeChatInput().trim();
  const forcedShots = (forcedText !== undefined && Array.isArray(forcedAttachments))
    ? forcedAttachments.filter(a => a && a.type === 'image' && a.id)
    : [];
  const hasShots = (forcedText === undefined && chatInput.querySelectorAll('.chat-shot-pill').length > 0)
    || forcedShots.length > 0;
  if ((!rawText && !hasShots) || chatBusy) return;
  const text = rawText || (hasShots ? 'Screenshot attached.' : rawText);
  // Capture ownerId before any async/DOM work so the catch can reference it
  const sendOwnerId = getOwnerIdForChat();

  // Extract file attachments, image attachments, + /app references before clearing the input
  let fileAttachments = [];
  let imageAttachments = [];
  let shotMeta = []; // { thumbDataUrl, w, h } per screenshot — kept for in-bubble preview
  let appRefs = [];
  if (forcedText === undefined) {
    const filePills = chatInput.querySelectorAll('.chat-file-pill');
    fileAttachments = [...filePills].map(p => ({ type: 'file', id: p.dataset.fileId })).filter(a => a.id);
    const shotPills = chatInput.querySelectorAll('.chat-shot-pill');
    const seenShot = new Set();
    shotPills.forEach(p => {
      const id = p.dataset.shotId;
      if (!id || seenShot.has(id)) return;
      seenShot.add(id);
      imageAttachments.push({ type: 'image', id });
      const w = parseInt(p.dataset.shotW || '0', 10) || 0;
      const h = parseInt(p.dataset.shotH || '0', 10) || 0;
      shotMeta.push({ thumbDataUrl: p.dataset.shotThumb || '', w, h });
    });
    const appPills = chatInput.querySelectorAll('.chat-app-pill');
    const seenApp = new Set();
    appPills.forEach(p => {
      const exe = p.dataset.appExe;
      if (!exe || seenApp.has(exe)) return;
      seenApp.add(exe);
      const m = resolveAppMeta(exe, p.dataset.appName);
      appRefs.push({ key: p.dataset.appKey || appKeyFor(exe), exe: m.exe, name: m.name, type: m.type, pid: m.pid, port: m.port });
    });
    // Move image ids to pendingTurnShotIdsByContext BEFORE clearChatInput so
    // the MutationObserver's handleOrphanShot sees them as in-flight and skips release.
    const pending = pendingShotIdsByContext.get(sendOwnerId);
    if (pending && imageAttachments.length) {
      if (!pendingTurnShotIdsByContext.has(sendOwnerId)) pendingTurnShotIdsByContext.set(sendOwnerId, new Set());
      const turnSet = pendingTurnShotIdsByContext.get(sendOwnerId);
      for (const a of imageAttachments) {
        pending.delete(a.id);
        turnSet.add(a.id);
      }
    }
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
  // Same story for /screenshot pills captured in the launcher pre-app-pick:
  // chatInput is empty, so the caller hands the ids over directly. Migrate
  // them into the turn set so onDone releases (and handleOrphanShot, when the
  // pill is later torn out of lInput by enterLauncher's reset, treats the id
  // as in-flight instead of releasing it twice).
  if (forcedShots.length) {
    if (!pendingTurnShotIdsByContext.has(sendOwnerId)) pendingTurnShotIdsByContext.set(sendOwnerId, new Set());
    const turnSet = pendingTurnShotIdsByContext.get(sendOwnerId);
    const pending = pendingShotIdsByContext.get(sendOwnerId);
    for (const a of forcedShots) {
      imageAttachments.push({ type: 'image', id: a.id });
      if (pending) pending.delete(a.id);
      turnSet.add(a.id);
      // Launcher path: forcedAttachments carries thumb/dims via lScrapeShotAttachments
      const w = Number.isFinite(a.w) ? a.w : (parseInt(a.w || '0', 10) || 0);
      const h = Number.isFinite(a.h) ? a.h : (parseInt(a.h || '0', 10) || 0);
      shotMeta.push({ thumbDataUrl: a.thumbDataUrl || '', w, h });
    }
  }
  const userExtras = shotMeta.length ? { screenshots: shotMeta } : {};
  addChatMessage('user', text, userExtras);
  lastUserMessage = text;

  // Fresh turn — drop any leftover strip from a previous turn that wasn't
  // explicitly torn down (defensive; onDone normally clears it).
  destroyLiveActivity();
  thinkingBuffer = '';
  thinkingFallback = 'reading your request…';
  reasoningStartMs = Date.now();
  showThinking(thinkingFallback);
  setChatBusy(true);

  chatStreamContent = '';
  chatStreamExe = chatCurrentExe;
  chatStreamSources = [];

  const turnId = nextTurnId++;
  currentTurnId = turnId;

  const isDirect = chatCurrentExe === DIRECT_CHAT_ID;
  const meta = isDirect
    ? (chatMetaStore[DIRECT_CHAT_ID] || { exe: DIRECT_CHAT_ID, name: 'GPT-5.5', type: 'direct', pid: null, port: null })
    : (chatMetaStore[chatCurrentExe] || resolveAppMeta(chatCurrentExe, chatAppNameEl.textContent));
  chatMetaStore[chatCurrentExe] = meta;

  const apiMessages = (chatStore[chatCurrentExe] || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const allAttachments = [...fileAttachments, ...imageAttachments];

  try {
    if (isDirect) {
      await window.chat.sendDirect({ turnId, messages: apiMessages, attachments: allAttachments, apps: appRefs });
    } else {
      await window.chat.send({ turnId, meta, messages: apiMessages, attachments: allAttachments, apps: appRefs });
    }
  } catch (err) {
    // Release any pending-for-turn screenshot ids on failure
    if (forcedText === undefined) {
      const turnSet = pendingTurnShotIdsByContext.get(sendOwnerId);
      if (turnSet) {
        for (const id of turnSet) { try { window.chat.releaseScreenshot(id); } catch {} }
        turnSet.clear();
      }
    }
    hideThinking();
    destroyLiveActivity();
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
        if (!chatInput.querySelector('.chat-tab-pill, .chat-file-pill, .chat-app-pill, .chat-shot-pill') && chatInput.textContent.trim() === '') {
          chatInput.innerHTML = '';
          chatInput.focus();
        } else {
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
        evaluateSlash();
        return;
      }
    }
  }
  // Clarify pending (mid-turn ask_user): own Up/Down/Tab/Enter like a modal.
  // Up/Down highlight a choice, Tab submits the highlight, Enter submits a typed
  // custom answer (or the highlight when the composer is empty). Letters/Shift+
  // Enter fall through so the user can type a multiline custom answer.
  if (clarifyState) {
    const opts = clarifyState.options;
    if (e.key === 'ArrowDown' && opts.length) {
      e.preventDefault();
      clarifyState.idx = Math.min(opts.length - 1, clarifyState.idx + 1);
      renderClarifyMenu();
      return;
    }
    if (e.key === 'ArrowUp' && opts.length) {
      e.preventDefault();
      clarifyState.idx = Math.max(0, clarifyState.idx - 1);
      renderClarifyMenu();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const custom = serializeChatInput().trim();
      if (custom) answerClarify(custom);
      else if (opts.length) answerClarify(opts[clarifyState.idx]);
      return; // never falls through to sendChatMessage
    }
    // Esc: no special handling — global hold-Esc still aborts the turn, which
    // fires onDone → closeClarify() cleanup.
  }
  // Slash palette open: arrow keys navigate, Tab/Enter commits highlighted cmd,
  // Esc closes. Letters fall through to contenteditable so the filter shrinks
  // or grows naturally; evaluateSlash on the input event keeps the menu in sync.
  if (slashState === 'palette' && slashPaletteItems.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashPaletteIdx = Math.min(slashPaletteItems.length - 1, slashPaletteIdx + 1);
      renderPaletteMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashPaletteIdx = Math.max(0, slashPaletteIdx - 1);
      renderPaletteMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const cmd = slashPaletteItems[slashPaletteIdx];
      if (cmd) commitSlashCmd(cmd);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlash();
      return;
    }
  }
  // Arg picker open: arrow keys / Tab / Enter pick. Backspace at the splice
  // anchor with no filter chars exits arg mode (the user has rubbed out the
  // whole reference; one more Backspace dismisses the picker).
  if (slashState === 'arg') {
    if (e.key === 'ArrowDown' && argItems.length) {
      e.preventDefault();
      argIdx = Math.min(argItems.length - 1, argIdx + 1);
      renderArgMenu();
      return;
    }
    if (e.key === 'ArrowUp' && argItems.length) {
      e.preventDefault();
      argIdx = Math.max(0, argIdx - 1);
      renderArgMenu();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && argItems.length) {
      e.preventDefault();
      pickArgItem();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlash();
      return;
    }
    if (e.key === 'Backspace' && slashAnchor && chatInput.contains(slashAnchor.node)) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        if (r.startContainer === slashAnchor.node && r.startOffset === slashAnchor.offset) {
          e.preventDefault();
          closeSlash();
          return;
        }
      }
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
  evaluateSlash();
});

// ── Slash-command palette + arg picker ─────────────────────────────────────
// Single state machine drives three flows:
//   phase 'palette' — typing `/` opens a list of commands (/app /tab /file…).
//                     Type to filter; Tab/Enter commits the highlighted cmd
//                     and splices the literal `/cmd` text out of the composer.
//   phase 'arg'     — for commands that take a reference argument (/app, /tab)
//                     the dropdown swaps to the matching candidate list; chars
//                     typed at the splice anchor become the filter; Tab/Enter
//                     inserts the chosen pill at that anchor.
//   /file commits straight to the OS file dialog — no arg phase.
// Pill DOM and on-the-wire serialisation are unchanged; this only restructures
// the input UX that used to live in three separate detectors (/app, /tab, /file).
const slashMenuEl     = document.getElementById('chat-slash-menu');
const slashMenuListEl = document.getElementById('chat-slash-menu-list');
const tabMenuEl       = document.getElementById('chat-tab-menu');
const tabMenuListEl   = document.getElementById('chat-tab-menu-list');
const clarifyMenuEl      = document.getElementById('chat-clarify-menu');
const clarifyMenuListEl  = document.getElementById('chat-clarify-menu-list');
const clarifyMenuTitleEl = document.getElementById('chat-clarify-menu-title');

const TAB_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M2 9h20"></path><path d="M6 6.5h.01M9 6.5h.01"></path></svg>';

const FILE_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';

const APP_GLYPH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>';

const SHOT_GLYPH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 4l-2 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-2-2H9zm3 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';

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
const SLASH_COMMANDS = [
  { name: 'app',        label: '/app',        hint: 'Reference a running app',   glyph: APP_GLYPH_SVG,  arg: 'app'  },
  { name: 'tab',        label: '/tab',        hint: 'Reference a Chrome tab',    glyph: TAB_GLYPH_SVG,  arg: 'tab',
    guard: () => {
      // Caret-after-`/app`-pill scopes to that app instead of the chat's primary.
      const meta = scopedMetaForSlash();
      return !!(meta && meta.type === 'electron' && meta.port);
    } },
  { name: 'file',       label: '/file',       hint: 'Attach a file',             glyph: FILE_GLYPH_SVG, arg: 'file' },
  { name: 'screenshot', label: '/screenshot', hint: 'Capture a screen region',   glyph: SHOT_GLYPH_SVG, arg: null, immediate: true },
];

// When a slash sits to the right of a `/app` pill in the composer, subsequent
// `/`-commands (e.g. `/tab`) scope to THAT app rather than the chat's primary
// exe. Returns the scoping exe, or null if the caret has no preceding /app pill.
let slashScopedExe = null;

function findScopedExeFromCtx(ctx) {
  if (!ctx || !ctx.node || !chatInput.contains(ctx.node)) return null;
  const pills = chatInput.querySelectorAll('.chat-app-pill');
  let last = null;
  for (const p of pills) {
    if (p.compareDocumentPosition(ctx.node) & Node.DOCUMENT_POSITION_FOLLOWING) last = p;
  }
  return last ? (last.dataset.appExe || null) : null;
}

function scopedMetaForSlash() {
  const exe = slashScopedExe || chatCurrentExe;
  if (!exe) return null;
  return chatMetaStore[exe] || resolveAppMeta(exe);
}

const appMenuEl     = document.getElementById('chat-app-menu');
const appMenuListEl = document.getElementById('chat-app-menu-list');

// Two-phase slash machine.
//  palette  user sees `/cmd` while typing; Tab/Enter commits.
//  arg      `/cmd` text already removed; caret sits at `slashAnchor`,
//           subsequent text up to the caret is the filter.
let slashState        = 'closed';   // 'closed' | 'palette' | 'arg'
let slashCmd          = null;       // 'app' | 'tab' (no arg phase for /file)
let slashAnchor       = null;       // { node, offset } where the spliced /cmd was
let slashFilter       = '';
let slashPaletteCtx   = null;       // { node, slashOffset, caretOffset, query }
let slashPaletteItems = [];
let slashPaletteIdx   = 0;
let argItems          = [];
let argIdx            = 0;
let tabFetchToken     = 0;
let cachedTabs        = [];
let cachedWindowCount = 1;
let isComposingChat   = false;

function detectSlashAtCaret() {
  if (chatBusy || isComposingChat) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !chatInput.contains(node)) return null;
  const before = node.nodeValue.slice(0, range.startOffset);
  // Slash must sit at start-of-node OR after whitespace -- filters URLs
  // (`https://`), Windows-ish path runs, and accidental mid-word slashes.
  const m = /(^|\s)\/([a-zA-Z]*)$/.exec(before);
  if (!m) return null;
  return {
    node,
    slashOffset: range.startOffset - m[2].length - 1,
    caretOffset: range.startOffset,
    query: m[2],
  };
}

function evaluateSlash() {
  if (chatBusy) { if (slashState !== 'closed') closeSlash(); return; }
  if (slashState === 'arg') {
    if (!slashAnchor || !chatInput.contains(slashAnchor.node) ||
        slashAnchor.node.nodeType !== Node.TEXT_NODE) { closeSlash(); return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) { closeSlash(); return; }
    const r = sel.getRangeAt(0);
    if (r.startContainer !== slashAnchor.node) { closeSlash(); return; }
    if (r.startOffset < slashAnchor.offset) { closeSlash(); return; }
    slashFilter = slashAnchor.node.nodeValue.slice(slashAnchor.offset, r.startOffset);
    refreshArgItems();
    positionArgMenu();
    return;
  }
  const ctx = detectSlashAtCaret();
  if (ctx) openPalette(ctx);
  else if (slashState !== 'closed') closeSlash();
}

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
  const filtered = f
    ? out.filter(o => (o.name || '').toLowerCase().includes(f) || (o.exe || '').toLowerCase().includes(f))
    : out;
  return filtered.slice(0, 50);
}

function filterArgTabs(q) {
  const ql = (q || '').trim().toLowerCase();
  if (!ql) return cachedTabs.slice(0, 50);
  const pre = [], sub = [];
  for (const t of cachedTabs) {
    const title = (t.title || '').toLowerCase();
    const url = (t.url || '').toLowerCase();
    if (title.startsWith(ql) || url.startsWith(ql)) pre.push(t);
    else if (title.includes(ql) || url.includes(ql)) sub.push(t);
  }
  return [...pre, ...sub].slice(0, 50);
}

async function loadTabsForArg(initial) {
  const meta = scopedMetaForSlash();
  if (!meta || meta.type !== 'electron' || !meta.port) { closeSlash(); return; }
  const my = ++tabFetchToken;
  if (initial) { cachedTabs = []; argItems = []; renderArgMenu(); }
  let tabs = [];
  let res = null;
  try {
    res = await window.chat.listTabs(meta.port);
    tabs = (res && Array.isArray(res.tabs)) ? res.tabs : [];
  } catch { tabs = []; }
  if (my !== tabFetchToken || slashState !== 'arg' || slashCmd !== 'tab') return;
  cachedTabs = tabs;
  cachedWindowCount = (res && typeof res.windowCount === 'number') ? res.windowCount : 1;
  argItems = filterArgTabs(slashFilter);
  const activeI = argItems.findIndex(t => t.active);
  argIdx = activeI >= 0 ? activeI : 0;
  renderArgMenu();
}

function openPalette(ctx) {
  const wasOpen = slashState === 'palette';
  slashState = 'palette';
  slashPaletteCtx = ctx;
  slashFilter = ctx.query;
  slashScopedExe = findScopedExeFromCtx(ctx);
  if (!wasOpen) slashPaletteIdx = 0;
  refreshPaletteItems();
  appMenuEl.hidden = true;
  tabMenuEl.hidden = true;
  slashMenuEl.hidden = false;
  positionMenu(slashMenuEl);
}

function refreshPaletteItems() {
  const q = (slashFilter || '').toLowerCase();
  const visible = SLASH_COMMANDS.filter(c => {
    if (c.guard && !c.guard()) return false;
    if (!q) return true;
    return c.name.startsWith(q);
  });
  slashPaletteItems = visible;
  if (slashPaletteIdx >= visible.length) slashPaletteIdx = Math.max(0, visible.length - 1);
  if (!visible.length) {
    slashMenuListEl.innerHTML = `<div class="chat-tab-menu-empty">No matching commands.</div>`;
  } else {
    renderPaletteMenu();
  }
}

function renderPaletteMenu() {
  slashMenuListEl.innerHTML = slashPaletteItems.map((c, i) => `
      <button type="button" role="option" class="chat-tab-row${i === slashPaletteIdx ? ' active' : ''}"
              data-i="${i}" aria-selected="${i === slashPaletteIdx}">
        <span class="chat-tab-row-icon">${c.glyph}</span>
        <span class="chat-tab-row-body">
          <span class="chat-tab-row-title">${c.label}</span>
          <span class="chat-tab-row-url">${escapeHtml(c.hint)}</span>
        </span>
      </button>`).join('');
  const active = slashMenuListEl.querySelector('.chat-tab-row.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// Anchor the menu just above the caret line, inside the composer wrap.
function positionMenu(el) {
  // In overlay chat mode chatInput is reparented into .launcher-input-stack;
  // the original .chat-input-wrap is no longer the ancestor.
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
  el.style.left = left + 'px';
  el.style.bottom = (wrapRect.bottom - caretRect.top + 6) + 'px';
  el.style.top = 'auto';
}

function positionArgMenu() {
  if (slashCmd === 'app') positionMenu(appMenuEl);
  else if (slashCmd === 'tab') positionMenu(tabMenuEl);
}

function closeSlash() {
  slashState = 'closed';
  slashCmd = null;
  slashAnchor = null;
  slashFilter = '';
  slashPaletteCtx = null;
  slashPaletteItems = [];
  slashScopedExe = null;
  argItems = [];
  argIdx = 0;
  tabFetchToken++;
  cachedWindowCount = 1;
  slashMenuEl.hidden = true;
  appMenuEl.hidden = true;
  tabMenuEl.hidden = true;
}

// Compat shims for the few legacy callsites that still reach for the old names.
function closeTabMenu() { closeSlash(); }
function closeAppMenu() { closeSlash(); }

function commitSlashCmd(cmd) {
  const ctx = slashPaletteCtx;
  if (!ctx || !chatInput.contains(ctx.node) || ctx.node.nodeType !== Node.TEXT_NODE) {
    closeSlash();
    return;
  }
  const { node, slashOffset, caretOffset } = ctx;
  const full = node.nodeValue;
  node.nodeValue = full.slice(0, slashOffset) + full.slice(caretOffset);
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(node, slashOffset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  slashMenuEl.hidden = true;
  slashPaletteCtx = null;
  slashPaletteItems = [];

  // Immediate commands (e.g. /screenshot) do not enter arg phase
  if (cmd.immediate && cmd.name === 'screenshot') {
    console.log('[screenshot] commit', cmd.name);
    slashState = 'closed';
    slashCmd = null;
    slashAnchor = null;
    slashFilter = '';
    takeChatScreenshot();
    return;
  }

  if (cmd.arg === 'file') {
    slashState = 'closed';
    slashCmd = null;
    slashAnchor = null;
    slashFilter = '';
    openFilePicker({ node, offset: slashOffset });
    return;
  }
  slashState = 'arg';
  slashCmd = cmd.arg;
  slashAnchor = { node, offset: slashOffset };
  slashFilter = '';
  argItems = [];
  argIdx = 0;
  if (cmd.arg === 'app') {
    refreshArgItems();
    appMenuEl.hidden = false;
    positionArgMenu();
  } else if (cmd.arg === 'tab') {
    loadTabsForArg(true);
    tabMenuEl.hidden = false;
    positionArgMenu();
  }
  chatInput.focus();
}

function refreshArgItems() {
  if (slashCmd === 'app') {
    argItems = appMenuCandidates(slashFilter);
    if (argIdx >= argItems.length) argIdx = 0;
    renderArgMenu();
  } else if (slashCmd === 'tab') {
    argItems = filterArgTabs(slashFilter);
    if (argIdx >= argItems.length) argIdx = 0;
    renderArgMenu();
  }
}

function renderArgMenu() {
  if (slashCmd === 'app') {
    if (!argItems.length) {
      const f = slashFilter.trim();
      appMenuListEl.innerHTML = `<div class="chat-tab-menu-empty">No running apps match${f ? ` "${escapeHtml(f)}"` : ''}.</div>`;
      return;
    }
    appMenuListEl.innerHTML = argItems.map((a, i) => {
      const base = (a.exe || '').split(/[\\/]/).pop() || a.exe || '';
      return `
      <button type="button" role="option" class="chat-tab-row${i === argIdx ? ' active' : ''}"
              data-i="${i}" aria-selected="${i === argIdx}">
        <span class="chat-tab-row-icon">${APP_GLYPH_SVG}</span>
        <span class="chat-tab-row-body">
          <span class="chat-tab-row-title">${escapeHtml(a.name || base)}</span>
          <span class="chat-tab-row-url">${escapeHtml(base)} - ${a.backend}</span>
        </span>
      </button>`;
    }).join('');
    const ar = appMenuListEl.querySelector('.chat-tab-row.active');
    if (ar) ar.scrollIntoView({ block: 'nearest' });
  } else if (slashCmd === 'tab') {
    if (!argItems.length) {
      tabMenuListEl.innerHTML = `<div class="chat-tab-menu-empty">No open tabs match.</div>`;
      return;
    }
    const sharedHosts = tabSharedHostSet(argItems);
    tabMenuListEl.innerHTML = argItems.map((t, i) => {
      const primary = tabPrimaryLabel(t, sharedHosts);
      const secondary = tabSecondaryLabel(t, cachedWindowCount, primary);
      const tip = [(t.title || '').trim(), (t.url || '').trim()].filter(Boolean).join(' — ');
      return `
      <button type="button" role="option" class="chat-tab-row${i === argIdx ? ' active' : ''}"
              data-i="${i}" aria-selected="${i === argIdx}" title="${escapeHtml(tip)}">
        <span class="chat-tab-row-icon">${TAB_GLYPH_SVG}</span>
        <span class="chat-tab-row-body">
          <span class="chat-tab-row-title">${escapeHtml(primary)}</span>
          ${secondary ? `<span class="chat-tab-row-url">${escapeHtml(secondary)}</span>` : ''}
        </span>
      </button>`;
    }).join('');
    const ar = tabMenuListEl.querySelector('.chat-tab-row.active');
    if (ar) ar.scrollIntoView({ block: 'nearest' });
  }
}

function buildTabPill(tab) {
  const span = document.createElement('span');
  span.className = 'chat-tab-pill';
  span.contentEditable = 'false';
  span.dataset.tabId = tab.id || '';
  span.dataset.tabTitle = tab.title || '';
  span.dataset.tabUrl = tab.url || '';
  const label = tabPrimaryLabel(tab, null);
  const tip = [(tab.title || '').trim(), (tab.url || '').trim()].filter(Boolean).join(' — ');
  span.title = tip || label;
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

function buildAppPill(app) {
  const span = document.createElement('span');
  span.className = 'chat-app-pill';
  span.contentEditable = 'false';
  span.dataset.appExe = app.exe || '';
  span.dataset.appName = app.name || '';
  span.dataset.appKey = appKeyFor(app.exe || '');
  const label = (app.name || (app.exe || '').split(/[\\/]/).pop() || 'app').trim();
  span.title = label + (app.exe ? ` - ${app.exe}` : '');
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

function buildScreenshotPill({ id, thumbDataUrl, w, h, ownerId }) {
  const pill = document.createElement('span');
  pill.className = 'chat-shot-pill';
  pill.contentEditable = 'false';
  pill.dataset.attachmentType = 'image';
  pill.dataset.attachmentId = id;
  pill.dataset.shotId = id;
  pill.dataset.ownerId = ownerId;
  // Stash full thumb + dims so sendChatMessage can carry them into the
  // user-message store (renders a visible attachment block in the bubble).
  if (thumbDataUrl) pill.dataset.shotThumb = thumbDataUrl;
  if (Number.isFinite(w)) pill.dataset.shotW = String(w);
  if (Number.isFinite(h)) pill.dataset.shotH = String(h);

  const img = document.createElement('img');
  img.className = 'chat-shot-thumb';
  img.src = thumbDataUrl;
  img.alt = '';
  img.width = 20;
  img.height = 20;
  pill.appendChild(img);

  const label = document.createElement('span');
  label.className = 'chat-shot-label';
  label.textContent = 'Screenshot ' + w + '\xd7' + h;
  pill.appendChild(label);

  const x = document.createElement('button');
  x.className = 'chat-pill-x';
  x.type = 'button';
  x.setAttribute('aria-label', 'Remove screenshot');
  x.textContent = '\xd7';
  x.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { window.chat.releaseScreenshot(id); } catch {}
    untrackShot(ownerId, id);
    pill.remove();
  });
  pill.appendChild(x);

  return pill;
}

function isTabPill(n) {
  return n && n.nodeType === Node.ELEMENT_NODE && n.classList && n.classList.contains('chat-tab-pill');
}
function isAnyPill(n) {
  return n && n.nodeType === Node.ELEMENT_NODE && n.classList &&
    (n.classList.contains('chat-tab-pill') || n.classList.contains('chat-file-pill') ||
     n.classList.contains('chat-app-pill') || n.classList.contains('chat-shot-pill'));
}
const isEmptyText = (n) => n && n.nodeType === Node.TEXT_NODE && n.nodeValue === '';

// The pill immediately before the (collapsed) caret, if any -- skipping empty
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

// Insert the chosen pill at the splice anchor, removing any filter chars the
// user typed in arg mode. Caret lands after the trailing space.
function insertPillAtAnchor(buildPill, payload) {
  if (!slashAnchor || !chatInput.contains(slashAnchor.node) ||
      slashAnchor.node.nodeType !== Node.TEXT_NODE) { closeSlash(); return; }
  const { node, offset } = slashAnchor;
  let caretOff = offset + (slashFilter || '').length;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && sel.isCollapsed && sel.getRangeAt(0).startContainer === node) {
    caretOff = Math.max(offset, sel.getRangeAt(0).startOffset);
  }
  const full = node.nodeValue;
  const before = full.slice(0, offset);
  const after = full.slice(caretOff);
  const parent = node.parentNode;
  const beforeNode = document.createTextNode(before);
  const pill = buildPill(payload);
  const spaceNode = document.createTextNode(' ');
  const afterNode = document.createTextNode(after);
  parent.insertBefore(beforeNode, node);
  parent.insertBefore(pill, node);
  parent.insertBefore(spaceNode, node);
  parent.insertBefore(afterNode, node);
  parent.removeChild(node);
  const r = document.createRange();
  r.setStart(spaceNode, 1);
  r.collapse(true);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  closeSlash();
  chatInput.focus();
}

function pickArgItem(idx) {
  if (typeof idx === 'number') argIdx = idx;
  if (argIdx < 0 || argIdx >= argItems.length) return;
  if (slashCmd === 'app') insertPillAtAnchor(buildAppPill, argItems[argIdx]);
  else if (slashCmd === 'tab') insertPillAtAnchor(buildTabPill, argItems[argIdx]);
}

// Legacy aliases used by sendChatMessage's pill collection and a couple of
// other callsites.
function pickApp(i) { pickArgItem(i); }
function pickTab(i) { pickArgItem(i); }

// Mousedown (preserves editor focus) + mousemove highlight on every menu.
slashMenuListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  e.preventDefault();
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i) && slashPaletteItems[i]) commitSlashCmd(slashPaletteItems[i]);
});
slashMenuListEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i) && i !== slashPaletteIdx) { slashPaletteIdx = i; renderPaletteMenu(); }
});
appMenuListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  e.preventDefault();
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i)) pickArgItem(i);
});
appMenuListEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i) && i !== argIdx) { argIdx = i; renderArgMenu(); }
});
tabMenuListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  e.preventDefault();
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i)) pickArgItem(i);
});
tabMenuListEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.chat-tab-row');
  if (!row) return;
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i) && i !== argIdx) { argIdx = i; renderArgMenu(); }
});
clarifyMenuListEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.ld-row');
  if (!row || !clarifyState) return;
  e.preventDefault(); // keep composer focus
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i) && clarifyState.options[i]) answerClarify(clarifyState.options[i]);
});
clarifyMenuListEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.ld-row');
  if (!row || !clarifyState) return;
  const i = parseInt(row.dataset.i, 10);
  if (!Number.isNaN(i) && i !== clarifyState.idx) { clarifyState.idx = i; renderClarifyMenu(); }
});

document.addEventListener('selectionchange', () => {
  if (slashState === 'closed' || document.activeElement !== chatInput) return;
  evaluateSlash();
});
document.addEventListener('mousedown', (e) => {
  if (slashState === 'closed') return;
  if (slashMenuEl.contains(e.target) || appMenuEl.contains(e.target) ||
      tabMenuEl.contains(e.target) || chatInput.contains(e.target)) return;
  closeSlash();
});
chatInput.addEventListener('compositionstart', () => { isComposingChat = true; });
chatInput.addEventListener('compositionend', () => { isComposingChat = false; evaluateSlash(); });

// ── `/file` command: attach local files as inline pills ──────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

let filePickerOpen = false;

// `anchor` is { node, offset } pointing at the caret position where `/file`
// just got spliced out by commitSlashCmd. The first picked file replaces that
// caret spot; subsequent files insert at the moving caret. Caller is expected
// to have already removed the `/file` text — this function does NOT undo on
// cancel (there's nothing to undo).
async function openFilePicker(anchor) {
  if (filePickerOpen) return;
  filePickerOpen = true;
  try {
    const res = await window.chat.pickFile();
    const files = Array.isArray(res) ? res : (res && res.files) || [];
    const skipped = (res && res.skipped) || [];

    if (skipped.length) {
      const summary = skipped.map(s => `${s.name}: ${s.reason}`).join('; ');
      showStatus(`${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped — ${summary}`, 'error');
      setTimeout(hideStatus, 6000);
    }
    if (!files.length) { chatInput.focus(); return; }

    chatInput.focus();
    let isFirst = true;
    for (const file of files) {
      const anchorLive = anchor && chatInput.contains(anchor.node) &&
                         anchor.node.nodeType === Node.TEXT_NODE;
      if (isFirst && anchorLive) {
        replaceAnchorWithFilePill(anchor, file);
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

function replaceAnchorWithFilePill(anchor, file) {
  const { node, offset } = anchor;
  const full = node.nodeValue || '';
  const before = full.slice(0, offset);
  const after = full.slice(offset);
  const pill = buildFilePill(file);
  const parent = node.parentNode;
  if (before) parent.insertBefore(document.createTextNode(before), node);
  parent.insertBefore(pill, node);
  const trailing = document.createTextNode(after ? ' ' + after : ' ');
  parent.insertBefore(trailing, node);
  parent.removeChild(node);
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(trailing, 1);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
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

// ── Screenshot capture helpers ──────────────────────────────────────────────

async function takeChatScreenshot() {
  if (chatBusy) return;
  // Save caret so we can restore it after the OS region picker steals focus
  const sel = window.getSelection();
  let savedRange = null;
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    if (chatInput.contains(r.startContainer)) savedRange = r.cloneRange();
  }
  const ownerId = getOwnerIdForChat();
  try {
    const result = await window.chat.captureScreenshot({ ownerId });
    if (!result || !result.id) return; // user cancelled
    const pill = buildScreenshotPill({ ...result, ownerId });
    // Restore caret into chatInput, then insert pill using same mechanism as /file
    try { chatInput.focus(); } catch {}
    if (savedRange) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(savedRange);
    }
    // Insert pill at caret (mirrors insertFilePillAtCaret)
    const trailing = document.createTextNode(' ');
    const curSel = window.getSelection();
    if (!curSel || curSel.rangeCount === 0) {
      chatInput.appendChild(pill);
      chatInput.appendChild(trailing);
    } else {
      const range = curSel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(trailing);
      range.insertNode(pill);
      const newRange = document.createRange();
      newRange.setStartAfter(trailing);
      newRange.collapse(true);
      curSel.removeAllRanges();
      curSel.addRange(newRange);
    }
    trackShot(ownerId, result.id);
  } catch (err) {
    console.error('[screenshot] capture failed:', err);
    showStatus('Screenshot failed: ' + String(err && err.message || err), 'error');
    setTimeout(hideStatus, 6000);
  }
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

// Inline automation panel (replaces the create-flow confirm/progress/review
// modals). The workspace "view saved" path still uses #auto-review-modal as a
// thin shell — the review form (#auto-review-form) is reparented between the
// two on demand so we don't duplicate DOM.
const pageChatEl         = document.getElementById('page-chat');
const autoPanel          = document.getElementById('auto-panel');
const autoReviewForm     = document.getElementById('auto-review-form');
const autoReviewPanelHost = document.getElementById('auto-review-panel-host');
const autoReviewModalHost = document.getElementById('auto-review-modal-host');

const autoConfirmClose   = document.getElementById('auto-confirm-close');
const autoConfirmCancel  = document.getElementById('auto-confirm-cancel');
const autoConfirmGo      = document.getElementById('auto-confirm-go');
const autoConfirmUser    = document.getElementById('auto-confirm-user');
const autoConfirmCount   = document.getElementById('auto-confirm-count');
const autoConfirmPlural  = document.getElementById('auto-confirm-plural');
const autoConfirmTrail   = document.getElementById('auto-confirm-trail');
const autoConfirmReply   = document.getElementById('auto-confirm-reply');

const autoProgressText   = document.getElementById('auto-progress-text');
const autoProgressCancel = document.getElementById('auto-progress-cancel');

const autoReviewModal      = document.getElementById('auto-review-modal');
const autoReviewModalClose = document.getElementById('auto-review-modal-close');
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

function syncAutoModalChrome() {
  const anyOpen = !!document.querySelector('.auto-modal.show');
  document.body.classList.toggle('auto-modal-open', anyOpen);
}
function showAutoModal(el) {
  el.classList.add('show');
  syncAutoModalChrome();
}
function hideAutoModal(el) {
  el.classList.remove('show');
  syncAutoModalChrome();
}

// Inline automation panel — confirm → progress → review live in one surface
// that takes over the chat-scroll slot inside #page-chat. Escape closes the
// panel and restores the chat (handler at the global keydown listener).
function ensureReviewFormIn(host) {
  if (autoReviewForm.parentElement !== host) host.appendChild(autoReviewForm);
}
function openAutoPanel(state) {
  if (state === 'review') ensureReviewFormIn(autoReviewPanelHost);
  autoPanel.dataset.state = state;
  autoPanel.hidden = false;
  pageChatEl.classList.add('auto-panel-open');
  // Overlay mode hides #page-chat and reparents #chat-scroll into the launcher
  // card. To stay visible in that mode we slot the panel into the same parent.
  // Body-level data attr drives the chat-scroll hide rule so it works in both
  // overlay (chat-scroll lives in .launcher-card) and main-window modes.
  const slot = chatScrollEl.parentElement;
  if (slot && slot !== pageChatEl && autoPanel.parentElement !== slot) {
    slot.insertBefore(autoPanel, chatScrollEl);
  }
  document.body.dataset.autoPanel = 'open';
  // Snap the overlay window to max-chat height immediately. sizeForChat reads
  // maxScrollH (not panel.scrollHeight) when the panel is up, so this is one
  // setBounds — no per-rAF growth pass as the body lays out.
  if (typeof window.__overlaySizeForChat === 'function') {
    window.__overlaySizeForChat({ immediate: true });
  }
}
function closeAutoPanel() {
  if (autoPanel.hidden) return false;
  const wasState = autoPanel.dataset.state;
  // Progress state with an in-flight codex job: cancel before tearing down.
  if (wasState === 'progress' && activeCodexJob) {
    try { window.automation.cancelCreate(activeCodexJob); } catch {}
    activeCodexJob = null;
  }
  autoPanel.hidden = true;
  delete autoPanel.dataset.state;
  pageChatEl.classList.remove('auto-panel-open');
  delete document.body.dataset.autoPanel;
  autoPanel.style.height = '';
  autoPanel.style.maxHeight = '';
  // Return the panel to its home parent (#page-chat above .chat-composer) so
  // it doesn't follow chat-scroll if the user back-navigates the overlay.
  if (autoPanel.parentElement !== pageChatEl) {
    const composer = pageChatEl.querySelector('.chat-composer');
    if (composer) pageChatEl.insertBefore(autoPanel, composer);
    else pageChatEl.appendChild(autoPanel);
  }
  // Resize overlay back to chat content now that the panel is gone.
  if (typeof window.__overlaySizeForChat === 'function') {
    requestAnimationFrame(() => window.__overlaySizeForChat({ immediate: true }));
  }
  pendingAutomation = null;
  // Only clear reviewState if we were in/leaving the review state — the modal
  // (workspace-view) path owns reviewState independently.
  if (wasState === 'review') reviewState = null;
  resetReviewJsonView();
  return true;
}
function isAutoPanelOpen() { return !autoPanel.hidden; }

// Workspace "view saved" path — drops the review form into the modal host.
function openReviewModal() {
  ensureReviewFormIn(autoReviewModalHost);
  showAutoModal(autoReviewModal);
}
function closeReviewModal() {
  hideAutoModal(autoReviewModal);
  reviewState = null;
  resetReviewJsonView();
}
function isReviewModalOpen() { return autoReviewModal.classList.contains('show'); }

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
  openAutoPanel('confirm');
}

autoConfirmClose.addEventListener('click', closeAutoPanel);
autoConfirmCancel.addEventListener('click', closeAutoPanel);

autoConfirmGo.addEventListener('click', async () => {
  if (!pendingAutomation) return;
  const payload = pendingAutomation;
  // Transition confirm → progress without leaving the panel.
  autoProgressText.textContent = 'Connecting…';
  openAutoPanel('progress');
  try {
    const result = await window.automation.create(payload);
    activeCodexJob = null;
    openRecipeReview({
      meta: payload.meta,
      userMsg: payload.userMsg,
      finalReply: payload.finalReply,
      steps: result.steps,
      backend: result.backend,
    });
  } catch (err) {
    activeCodexJob = null;
    showCreateError(err.message || String(err), payload);
  }
});

autoProgressCancel.addEventListener('click', () => { closeAutoPanel(); });

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
  // Reuse review form layout for error display
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
  openAutoPanel('review');
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
  openAutoPanel('review');
  setTimeout(() => autoReviewName.focus(), 100);
}

function suggestName(userMsg) {
  const cleaned = String(userMsg || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Automation';
  return cleaned.length > 60 ? cleaned.slice(0, 57) + '…' : cleaned;
}

// Discard/close/save handlers branch on where the moveable form currently
// lives — panel (create flow) vs modal (workspace view saved).
function closeActiveReviewSurface() {
  if (autoReviewForm.parentElement === autoReviewModalHost) closeReviewModal();
  else closeAutoPanel();
}
autoReviewClose.addEventListener('click', closeAutoPanel);              // panel head X
autoReviewModalClose.addEventListener('click', closeReviewModal);        // modal head X
autoReviewDiscard.addEventListener('click', closeActiveReviewSurface);   // form foot Discard

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
    closeActiveReviewSurface();
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
    openReviewModal();
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
autoRunClose.addEventListener('click', () => { hideAutoModal(autoRunModal); window.__overlayResetAfterRun?.(); });
autoRunDone.addEventListener('click', () => { hideAutoModal(autoRunModal); window.__overlayResetAfterRun?.(); });
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

  let cfg = { width: 600, collapsedHeight: 90, dropdownMaxHeight: 280, chatHeight: 540, runHeight: 560 };
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

  // ── lInput shim ──
  // lInput is a contenteditable <div> so it can host inline pill spans for
  // /app and /tab references. The rest of the launcher code was written
  // against the prior <input> API, so we install getters/setters that present
  // the same surface (value, selectionStart, selectionEnd, setSelectionRange,
  // placeholder) but operate over serialized text that includes pill tokens.
  function lTokenForPill(el) {
    if (el.classList.contains('chat-app-pill')) {
      const key = el.dataset.appKey || '';
      const name = (el.dataset.appName || '').replace(/"/g, "'");
      return `[app:${key} "${name}"]`;
    }
    if (el.classList.contains('chat-tab-pill')) {
      const id = el.dataset.tabId || '';
      const title = (el.dataset.tabTitle || '').replace(/"/g, "'");
      return `[tab:${id} "${title}"]`;
    }
    // Screenshot pills are attachments, not part of the message text — scraped
    // separately at submit time. Serialising them would inject the visible
    // "Screenshot WxH×" label into the prompt and the value-shim caret math.
    if (el.classList.contains('chat-shot-pill')) return '';
    return el.textContent || '';
  }
  function lSerialize(root) {
    let out = '';
    const walk = (parent) => {
      parent.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          out += n.nodeValue;
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.classList && n.classList.contains('chat-shot-pill')) {
            // skip — screenshots are scraped as attachments, not message text
          } else if (n.classList && (n.classList.contains('chat-app-pill') || n.classList.contains('chat-tab-pill'))) {
            out += lTokenForPill(n);
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
    walk(root);
    return out;
  }
  function lOffsetToRange(target) {
    let remaining = target;
    const result = { node: lInput, offset: 0 };
    const visit = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        if (remaining <= n.nodeValue.length) {
          result.node = n; result.offset = remaining;
          return true;
        }
        remaining -= n.nodeValue.length;
        return false;
      }
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.classList && n.classList.contains('chat-shot-pill')) {
          // Zero-width in the text-shim: caret never lands "inside" a shot pill
          // and its visible label doesn't count toward offsets. Skip children.
          return false;
        }
        if (n.classList && (n.classList.contains('chat-app-pill') || n.classList.contains('chat-tab-pill'))) {
          const len = lTokenForPill(n).length;
          if (remaining < len) {
            const parent = n.parentNode;
            const idx = Array.prototype.indexOf.call(parent.childNodes, n);
            result.node = parent;
            result.offset = remaining === 0 ? idx : idx + 1;
            return true;
          }
          remaining -= len;
          return false;
        }
        for (const c of n.childNodes) {
          if (visit(c)) return true;
        }
      }
      return false;
    };
    if (!visit(lInput)) {
      result.node = lInput;
      result.offset = lInput.childNodes.length;
    }
    return result;
  }
  function lRangeToOffset(node, offset) {
    if (!lInput.contains(node) && node !== lInput) return 0;
    const r = document.createRange();
    r.setStart(lInput, 0);
    r.setEnd(node, offset);
    const tmp = document.createElement('div');
    tmp.appendChild(r.cloneContents());
    return lSerialize(tmp).length;
  }
  function lCaretOffset(which) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!lInput.contains(range.startContainer)) return 0;
    const node = which === 'end' ? range.endContainer : range.startContainer;
    const off  = which === 'end' ? range.endOffset    : range.startOffset;
    return lRangeToOffset(node, off);
  }
  function lApplyCaret(start, end) {
    if (end == null) end = start;
    const s = lOffsetToRange(start);
    const e = lOffsetToRange(end);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  Object.defineProperty(lInput, 'value', {
    configurable: true,
    get() { return lSerialize(lInput); },
    set(v) {
      lInput.innerHTML = '';
      if (v) lInput.appendChild(document.createTextNode(String(v)));
    },
  });
  Object.defineProperty(lInput, 'selectionStart', {
    configurable: true,
    get() { return lCaretOffset('start'); },
  });
  Object.defineProperty(lInput, 'selectionEnd', {
    configurable: true,
    get() { return lCaretOffset('end'); },
  });
  Object.defineProperty(lInput, 'placeholder', {
    configurable: true,
    get() { return lInput.dataset.placeholder || ''; },
    set(v) { lInput.dataset.placeholder = String(v == null ? '' : v); },
  });
  lInput.setSelectionRange = function (s, e) {
    try { lApplyCaret(s, e); } catch {}
  };
  function lPillBeforeCaret(range) {
    const { startContainer: node, startOffset: off } = range;
    let prev;
    if (node.nodeType === Node.TEXT_NODE) {
      if (off > 0) return null;
      prev = node.previousSibling;
    } else {
      if (off === 0) return null;
      prev = node.childNodes[off - 1];
    }
    while (prev && prev.nodeType === Node.TEXT_NODE && prev.nodeValue === '') prev = prev.previousSibling;
    return (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList &&
      (prev.classList.contains('chat-app-pill') || prev.classList.contains('chat-tab-pill'))) ? prev : null;
  }
  function lPillAfterCaret(range) {
    const { startContainer: node, startOffset: off } = range;
    let next;
    if (node.nodeType === Node.TEXT_NODE) {
      if (off < node.nodeValue.length) return null;
      next = node.nextSibling;
    } else {
      next = node.childNodes[off];
    }
    while (next && next.nodeType === Node.TEXT_NODE && next.nodeValue === '') next = next.nextSibling;
    return (next && next.nodeType === Node.ELEMENT_NODE && next.classList &&
      (next.classList.contains('chat-app-pill') || next.classList.contains('chat-tab-pill'))) ? next : null;
  }
  // Splice the active /app or /tab arg span and insert a pill DOM node in
  // place of the literal `[app:...]` / `[tab:...]` token. start/end are
  // text-space offsets (the same ones the rest of the launcher reasons in).
  function lInsertPill(start, end, pill) {
    const sPos = lOffsetToRange(start);
    const ePos = lOffsetToRange(end);
    const r = document.createRange();
    r.setStart(sPos.node, sPos.offset);
    r.setEnd(ePos.node, ePos.offset);
    r.deleteContents();
    r.insertNode(pill);
    const space = document.createTextNode(' ');
    pill.parentNode.insertBefore(space, pill.nextSibling);
    const newR = document.createRange();
    newR.setStart(space, 1);
    newR.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(newR);
  }

  // State
  let mode      = 'chat';        // 'chat' | 'automation'
  let stage     = 'app';         // 'app' | 'task'
  let view      = 'launcher';    // 'launcher' | 'chat'
  let selApp    = null;          // {name, exe, type, icon}
  let items     = [];            // current dropdown candidates
  let activeIdx = -1;            // highlighted dropdown row
  let autos     = [];            // automation entries for selApp (automation mode)
  let allowOverlayClose = true;  // mirrors top-level config.allowOverlayClose
  // Slash-command palette + arg picker for the launcher task input. Two phases:
  //  palette → user typed `/` and the dropdown lists matching commands.
  //  arg     → cmd committed; `/cmd` text already spliced out, lInput chars
  //            between lSlashAnchor and the caret are the filter.
  // lAppMode / lTabMode below stay around as derived booleans because the
  // dropdown row renderer (rowHtmlFor) already keys off them.
  let lSlashState  = 'closed';   // 'closed' | 'palette' | 'arg'
  let lSlashCmd    = null;       // 'app' | 'tab'
  let lSlashAnchor = -1;         // position in lInput.value where the splice was
  let lSlashPalCtx = null;       // { slashOffset, caretOffset, query }
  let lAppMode  = false;         // derived: arg-phase /app picker is up
  let lAppCtx   = null;          // derived: { filter, start, end } for current arg span
  const launcherAppRefs = new Map(); // exe → resolved meta, for submit-time apps[]
  let lTabMode    = false;       // derived: arg-phase /tab picker is up
  let lTabCtx     = null;        // derived: { filter, start, end } for current arg span
  let lTabAllTabs = [];          // cached tab list for the active /tab session
  let lTabWindowCount = 1;       // last seen window count from listTabs
  let lTabToken   = 0;           // bumped to invalidate in-flight fetches
  // When the caret sits right of a `/app` pill in lInput, subsequent `/`-cmds
  // (e.g. `/tab`) scope to THAT app instead of the launcher's selApp primary.
  let lSlashScopedExe = null;
  const L_SLASH_COMMANDS = [
    { name: 'app',        label: '/app',        hint: 'Reference a running app', arg: 'app' },
    { name: 'tab',        label: '/tab',        hint: 'Reference a Chrome tab',  arg: 'tab',
      guard: () => {
        const meta = lScopedAppMeta();
        return !!(meta && meta.type === 'electron' && meta.port);
      } },
    { name: 'screenshot', label: '/screenshot', hint: 'Capture a screen region', arg: null, immediate: true },
  ];

  // Walk lInput pills, return the last `/app` pill whose serialised text offset
  // ends before `offset` (i.e. is positioned before the slash caret).
  function lFindScopedExeAtSlash(offset) {
    const pills = lInput.querySelectorAll('.chat-app-pill');
    if (!pills.length) return null;
    let last = null;
    for (const p of pills) {
      const parent = p.parentNode;
      const idx = Array.prototype.indexOf.call(parent.childNodes, p);
      const pillEnd = lRangeToOffset(parent, idx + 1);
      if (pillEnd <= offset) last = p;
    }
    return last ? (last.dataset.appExe || null) : null;
  }

  function lScopedAppMeta() {
    if (lSlashScopedExe) {
      const ref = launcherAppRefs.get(lSlashScopedExe);
      if (ref) return ref;
      const r = resolveAppMeta(lSlashScopedExe);
      if (r) return r;
    }
    return selApp || null;
  }
  let lComposing = false;

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
        // resolveAppMeta(exe) may read a stale row → meta.port=null → the /tab
        // palette entry's guard hides itself and the picker never opens.
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
  async function chatWithGptDirect(msg, attachments) {
    showChatView();
    try {
      await openDirectChat();
    } catch (err) {
      console.warn('openDirectChat failed', err);
    }
    const t = (msg || '').trim();
    const att = Array.isArray(attachments) ? attachments.filter(a => a && a.id) : [];
    if (t || att.length) {
      sendChatMessage(t || 'Screenshot attached.', [], att);
    }
    // Clearing lInput here would orphan the shot pills; the MutationObserver
    // honours pendingTurnShotIdsByContext (sendChatMessage migrates ids into
    // it before any await), so the next enterLauncher() reset is safe.
    if (att.length) {
      try { lInput.innerHTML = ''; } catch {}
    }
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
      // offsetHeight ignores the in-flight `launcherIn` scale() transform;
      // getBoundingClientRect would return the shrunk box mid-animation and
      // cache a too-small height, clipping the card top on the next reopen.
      const h = Math.ceil(launcherCard.offsetHeight);
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
    // When the inline automation panel is up, it occupies the chat-scroll slot
    // and drives window height instead. chat-scroll is hidden via the
    // body[data-auto-panel] CSS rule, but the panel still needs the same
    // chromeH + natural-content + maxHeight clamp logic to fit on-screen.
    const panelOpen = !autoPanel.hidden;
    const empty = panelOpen ? false : chatIsEmpty();
    const w = chatWinW();
    const streaming = !panelOpen && !!chatStreamExe;
    const flipped = empty !== lastSent.empty;

    if (empty) {
      // Empty card hugs lRow + foot only. Clear any inline height/cap from a
      // previous non-empty pass so the next sizeForChat from a small content
      // size starts fresh.
      chatScrollEl.style.height = '';
      chatScrollEl.style.maxHeight = '';
      const cardH = Math.ceil(launcherCard.getBoundingClientRect().height);
      const target = cardH;
      if (!immediate && !flipped && Math.abs(target - lastSent.h) < 6 && w === lastSent.w) return;
      lastSent = { w, h: target, empty };
      window.overlay.resize(w, target, { anchor: 'bottom', instant: true });
      setTimeout(() => { refreshAvailH(); }, 32);
      return;
    }

    const lRowH = Math.ceil(lRow.getBoundingClientRect().height) || 52;
    const footEl = document.querySelector('.launcher-foot');
    const footH = footEl ? Math.ceil(footEl.getBoundingClientRect().height) : 30;
    const cwpVisible = chatWindowPickerEl && !chatWindowPickerEl.hidden
      && chatWindowPickerEl.parentNode === launcherCard;
    const cwpH = cwpVisible ? Math.ceil(chatWindowPickerEl.getBoundingClientRect().height) + 6 : 0;
    // Clarify menu, when present, slots into launcherCard between chat-scroll
    // and lRow as a static flex child (see CSS `.launcher-card > .chat-clarify-menu`).
    // Its height is real overlay chrome — if we don't subtract it from the
    // scroll cap, the window comes back too short on the next reopen and the
    // top of chat-scroll gets clipped off-viewport above the card.
    const clarifyVisible = chatClarifyMenuEl && !chatClarifyMenuEl.hidden
      && chatClarifyMenuEl.parentNode === launcherCard;
    const clarifyH = clarifyVisible ? Math.ceil(chatClarifyMenuEl.getBoundingClientRect().height) + 6 : 0;
    const screenH = (window.screen && window.screen.availHeight) || 900;
    const chromeH = lRowH + footH + cwpH + clarifyH + 6;
    const screenCap = Math.floor(screenH * 0.85);
    // Use the lower of (screen-fraction cap) and (what main can actually
    // grant from current window position). Without the main cap we'd ask
    // for a window taller than the desktop and the card would overflow
    // off-screen above the viewport.
    const availCap = cachedAvailH > 0 ? cachedAvailH : screenCap;
    const maxWinH = Math.min(screenCap, availCap);
    const maxScrollH = Math.max(120, maxWinH - chromeH);
    // Panel surface drives sizing when open; otherwise use chat-messages.
    // Panel always takes the full available slot (maxScrollH) — sizing it to
    // content would animate through several growth steps as the body lays out
    // (head/foot first, then trail, then quote), which reads as a slow expand.
    // One snap to max gets the user there in a single overlay resize.
    const targetEl  = panelOpen ? autoPanel : chatScrollEl;
    const msgsH = panelOpen ? maxScrollH : Math.ceil(chatMessagesEl.scrollHeight);
    const naturalScrollH = Math.min(msgsH + (panelOpen ? 0 : 4), maxScrollH);
    const naturalTarget = naturalScrollH + chromeH;

    // Drive chat-scroll inner height from JS so CSS `transition: height 220ms`
    // can interpolate between pulse values. With explicit px height the
    // browser tweens token-by-token growth instead of snapping per render.
    // maxHeight cap keeps long replies from overshooting the window.
    targetEl.style.height = naturalScrollH + 'px';
    targetEl.style.maxHeight = maxScrollH + 'px';

    const atBottom = chatScrollEl.scrollTop + chatScrollEl.clientHeight >= chatScrollEl.scrollHeight - 24;

    if (streaming) {
      // Streaming path: snap window to maxWinH ONCE on first growth pass and
      // hold for the rest of the stream. Zero further setBounds = zero DWM
      // flicker. The visible card grows smoothly via the CSS height
      // transition above — card sits at bottom of window (anchor:'bottom' +
      // flex flex-end), so growth happens upward into the transparent halo.
      // chat:done flips chatStreamExe → null; the next sizeForChat falls
      // through to the idle branch below and shrinks the window back to
      // natural fit in one setBounds.
      if (!immediate && lastSent.h >= maxWinH && !flipped && w === lastSent.w) {
        if (atBottom) requestAnimationFrame(() => { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; });
        return;
      }
      lastSent = { w, h: maxWinH, empty };
      window.overlay.resize(w, maxWinH, { anchor: 'bottom', instant: true });
      setTimeout(() => { refreshAvailH(); }, 32);
      requestAnimationFrame(() => { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; });
      return;
    }

    // Idle path (not streaming): window matches natural content size. 6px
    // deadband so launcher composer keystrokes don't re-resize.
    if (!immediate && !flipped && Math.abs(naturalTarget - lastSent.h) < 6 && w === lastSent.w) return;
    lastSent = { w, h: naturalTarget, empty };
    window.overlay.resize(w, naturalTarget, { anchor: 'bottom', instant: true });
    setTimeout(() => { refreshAvailH(); }, 32);
    if (atBottom) requestAnimationFrame(() => { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; });
  }
  function scheduleChatResize() {
    // Trailing-edge throttle: if a tick is already pending, let it fire
    // instead of resetting it. Pure debounce meant a continuous token stream
    // (chunks faster than `delay`) kept pushing the timer forward and the
    // window never grew until the stream paused. Throttling guarantees a
    // resize lands at most `delay`ms after the first dirty chunk.
    if (chatResizeTimer) return;
    // Uniform 60ms throttle. Streaming path no longer calls setBounds per
    // pulse (snap-once-and-hold to maxWinH), so DWM flicker concern is gone.
    // The CSS height transition on .launcher-card > #chat-scroll interpolates
    // between 60ms pulse values, animating mid-stream growth smoothly.
    const delay = 60;
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
  // Grow upward from current bottom edge so the run modal fits inside the
  // overlay window without re-centering on screen. Centering would (a) make the
  // modal appear mid-screen instead of docked at the launcher's position, and
  // (b) cause hideOverlay → saveOverlayPos to persist the centered bounds —
  // shifting every subsequent hotkey-open of the overlay.
  function sizeForRun()   {
    window.overlay.resize(WIN_W, cfg.runHeight, { anchor: 'bottom' });
    lastSyncedH = -1; // window now differs from launcher card height; force next syncLauncherSize to actually resize
  }
  // Exposed so the autoRun modal close handlers (which live outside this IIFE)
  // can shrink the overlay back to the launcher's natural height after a run.
  window.__overlayResetAfterRun = () => { lastSyncedH = -1; syncLauncherSize(); };

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
  const chatClarifyMenuEl = document.getElementById('chat-clarify-menu');
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
    if (inlineChatActive) {
      refreshAvailH().then(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => sizeForChat({ immediate: true }));
        });
      });
      return;
    }
    inlineChatActive = true;
    view = 'chat';
    document.body.dataset.overlayView = 'chat';
    lDropdown.hidden = true;
    inlineSaved = {
      chatInput: saveAnchor(chatInputEl),
      tabMenu: saveAnchor(chatTabMenuEl),
      appMenu: saveAnchor(chatAppMenuEl),
      clarifyMenu: saveAnchor(chatClarifyMenuEl),
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
    // Clarify menu sits between chat-scroll and lRow — full-width across the
    // launcher card, same slot/look as the launcher-dropdown app-selector. The
    // question card lives in chat-scroll (transcript) and therefore renders
    // just ABOVE this choices panel. Slotting clarify into .launcher-input-stack
    // would constrain width to the middle column only; inserting it BEFORE
    // chat-scroll would put choices above the question, which we don't want.
    if (chatClarifyMenuEl) launcherCard.insertBefore(chatClarifyMenuEl, lRow);
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
      // Drop the inline height + max-height sizeForChat set during chat mode;
      // next enter re-derives them from the new chat-messages content. Also
      // strip them in the empty branch of sizeForChat for the same reason.
      chatScrollEl.style.height = '';
      chatScrollEl.style.maxHeight = '';
      inputStack.classList.remove('has-chat-input');
      // Restore all four reparented nodes to their original anchors.
      if (inlineSaved) {
        restoreAnchor(chatInputEl, inlineSaved.chatInput);
        restoreAnchor(chatTabMenuEl, inlineSaved.tabMenu);
        restoreAnchor(chatAppMenuEl, inlineSaved.appMenu);
        restoreAnchor(chatClarifyMenuEl, inlineSaved.clarifyMenu);
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
    if (it && it.slashCmd) return `slash|${it.slashCmd.name}`;
    if (lTabMode) return `tab|${it.id || it.url || it.title || ''}`;
    if (mode === 'automation' && stage === 'task') return `auto|${it.slug || it.name || ''}`;
    return `app|${it.type || ''}|${it.exe || it.path || it.name || ''}`;
  }
  function rowHtmlFor(it, i) {
    const active = i === activeIdx ? ' active' : '';
    if (it && it.slashCmd) {
      const slashIcon = '<span class="ld-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span>';
      return `<div class="ld-row${active}" role="option" data-i="${i}">
        ${slashIcon}
        <span class="ld-text"><span class="ld-name">${escapeHtml(it.name)}</span><span class="ld-sub">${escapeHtml(it.hint || '')}</span></span>
        <span class="ld-enter">hit <kbd>tab</kbd></span>
      </div>`;
    }
    if (lTabMode) {
      const sharedHosts = tabSharedHostSet(items);
      const primary = tabPrimaryLabel(it, sharedHosts);
      const secondary = tabSecondaryLabel(it, lTabWindowCount, primary);
      const tip = [(it.title || '').trim(), (it.url || '').trim()].filter(Boolean).join(' — ');
      const tabIcon = '<span class="ld-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M2 9h20"></path><path d="M6 6.5h.01M9 6.5h.01"></path></svg></span>';
      return `<div class="ld-row${active}" role="option" data-i="${i}" title="${escapeHtml(tip)}">
        ${tabIcon}
        <span class="ld-text"><span class="ld-name">${escapeHtml(primary)}</span>${secondary ? `<span class="ld-sub">${escapeHtml(secondary)}</span>` : ''}</span>
        <span class="ld-enter">hit <kbd>tab</kbd></span>
      </div>`;
    }
    if (mode === 'automation' && stage === 'task') {
      const sub = it.userMsg ? escapeHtml(String(it.userMsg).slice(0, 60)) : `${(it.steps || []).length} steps`;
      return `<div class="ld-row${active}" role="option" data-i="${i}">
        <span class="ld-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span>
        <span class="ld-text"><span class="ld-name">${escapeHtml(it.name)}</span><span class="ld-sub">${sub}</span></span>
        <span class="ld-enter">hit <kbd>enter</kbd></span>
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
    // No inline ghost while picking a /app or /tab reference — the input holds
    // the whole prompt, not just a name, so ghosting it would corrupt it.
    if (lSlashState !== 'closed' || lAppMode || lTabMode) { lGhost.textContent = ''; return; }
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

  // Detect a `/[cmd]` token at the caret. Returns the splice span + the
  // characters typed after the slash so the palette can filter against them.
  function lDetectSlash() {
    if (mode === 'automation' || lComposing) return null;
    // Allow /screenshot in app-stage too (palette filters out /app and /tab there).
    if (stage !== 'task' && stage !== 'app') return null;
    if (lInput.selectionStart !== lInput.selectionEnd) return null; // bail on range selection
    const caret = (lInput.selectionStart == null) ? lInput.value.length : lInput.selectionStart;
    const before = lInput.value.slice(0, caret);
    // Slash sits at start-of-input OR right after whitespace -- filters URLs
    // and accidental mid-word slashes the same way the chat composer does.
    const m = /(^|\s)\/([a-zA-Z]*)$/.exec(before);
    if (!m) return null;
    return {
      slashOffset: caret - m[2].length - 1,
      caretOffset: caret,
      query: m[2],
    };
  }

  function lFilterPalette(query) {
    const q = (query || '').toLowerCase();
    return L_SLASH_COMMANDS.filter(c => {
      // /app and /tab need a scoped app — only useful after one is selected.
      if (stage !== 'task' && c.name !== 'screenshot') return false;
      if (c.guard && !c.guard()) return false;
      if (!q) return true;
      return c.name.startsWith(q);
    });
  }

  // Scrape any /screenshot pills present in lInput into the attachments shape
  // sendChatMessage expects. Used by the launcher's app-stage Enter / click
  // paths because chatInput is empty at that point — sendChatMessage's own
  // pill scrape only looks at chatInput.
  function lScrapeShotAttachments() {
    const out = [];
    const seen = new Set();
    lInput.querySelectorAll('.chat-shot-pill').forEach((p) => {
      const id = p.dataset.shotId;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const w = parseInt(p.dataset.shotW || '0', 10) || 0;
      const h = parseInt(p.dataset.shotH || '0', 10) || 0;
      out.push({ type: 'image', id, thumbDataUrl: p.dataset.shotThumb || '', w, h });
    });
    return out;
  }

  async function takeLauncherScreenshot() {
    const realOwner = (selApp && selApp.exe) ? appKeyFor(selApp.exe) : DIRECT_CHAT_ID;
    try {
      const result = await window.chat.captureScreenshot({ ownerId: realOwner });
      if (!result || !result.id) return;
      const pill = buildScreenshotPill({ ...result, ownerId: realOwner });
      // Insert pill at current caret position in lInput using lInsertPill
      const caret = (lInput.selectionStart == null) ? lInput.value.length : lInput.selectionStart;
      lInsertPill(caret, caret, pill);
      trackShot(realOwner, result.id);
    } catch (err) {
      console.error('[screenshot] capture failed:', err);
      lHint.textContent = 'Screenshot failed: ' + String(err && err.message || err);
    }
  }

  // Commit a palette command: splice `/cmd` text out of lInput, anchor the
  // caret at that position, enter arg phase.
  function lCommitSlashCmd(cmd) {
    const ctx = lSlashPalCtx;
    if (!ctx || !cmd) return;
    // Splice the literal "/cmd" text out in DOM space so any pre-existing
    // pills survive (the value setter would otherwise flatten them to text).
    const s = lOffsetToRange(ctx.slashOffset);
    const e = lOffsetToRange(ctx.caretOffset);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    r.deleteContents();
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    lSlashPalCtx = null;

    // Immediate commands (e.g. /screenshot) do not enter arg phase
    if (cmd.immediate && cmd.name === 'screenshot') {
      console.log('[screenshot] commit', cmd.name);
      lSlashState = 'closed';
      lSlashCmd   = null;
      lSlashAnchor = -1;
      items = []; activeIdx = -1;
      lDropdown.hidden = true;
      takeLauncherScreenshot();
      return;
    }

    lSlashAnchor = ctx.slashOffset;
    lSlashState  = 'arg';
    lSlashCmd    = cmd.arg;
    if (cmd.arg === 'tab' && (!lTabAllTabs || !lTabAllTabs.length)) loadLauncherTabs();
    refreshSuggestions();
  }

  function lCloseSlash() {
    lSlashState  = 'closed';
    lSlashCmd    = null;
    lSlashAnchor = -1;
    lSlashPalCtx = null;
    lSlashScopedExe = null;
    lAppMode = false; lAppCtx = null;
    lTabMode = false; lTabCtx = null;
  }

  function filterTabs(q) {
    if (!q) return lTabAllTabs.slice(0, 8);
    const ql = q.toLowerCase();
    const pre = [], sub = [];
    for (const t of lTabAllTabs) {
      const title = (t.title || '').toLowerCase();
      const url = (t.url || '').toLowerCase();
      if (title.startsWith(ql) || url.startsWith(ql)) pre.push(t);
      else if (title.includes(ql) || url.includes(ql)) sub.push(t);
    }
    return [...pre, ...sub].slice(0, 8);
  }

  async function loadLauncherTabs() {
    const meta = lScopedAppMeta();
    if (!meta || !meta.port) { lTabAllTabs = []; lTabWindowCount = 1; return; }
    const myToken = ++lTabToken;
    let tabs = [];
    let res = null;
    try {
      res = await window.chat.listTabs(meta.port);
      tabs = (res && Array.isArray(res.tabs)) ? res.tabs : [];
    } catch { tabs = []; }
    if (myToken !== lTabToken) return; // superseded
    lTabAllTabs = tabs;
    lTabWindowCount = (res && typeof res.windowCount === 'number') ? res.windowCount : 1;
    if (lSlashState === 'arg' && lSlashCmd === 'tab') {
      refreshSuggestions();
    }
  }

  function refreshSuggestions() {
    const q = lInput.value.trim();
    if (stage === 'app') {
      // /screenshot is usable pre-app-pick. Detect first; fall back to app filter
      // only when there's no slash token at the caret.
      const ctx = lDetectSlash();
      if (ctx) {
        lSlashState = 'palette';
        lSlashPalCtx = ctx;
        lSlashScopedExe = null;
        const cmds = lFilterPalette(ctx.query);
        items = cmds.map(c => ({ slashCmd: c, name: c.label, hint: c.hint }));
        lAppMode = false; lAppCtx = null;
        lTabMode = false; lTabCtx = null;
      } else {
        lCloseSlash();
        items = filterApps(q);
      }
    }
    else if (mode === 'automation') {
      items = filterAutos(q);
      lCloseSlash();
    }
    else {
      // chat task stage: drive the slash machine.
      if (lSlashState === 'arg') {
        const caret = (lInput.selectionStart == null) ? lInput.value.length : lInput.selectionStart;
        if (lSlashAnchor < 0 || caret < lSlashAnchor) {
          lCloseSlash();
          items = [];
        } else {
          const filter = lInput.value.slice(lSlashAnchor, caret);
          if (lSlashCmd === 'app') {
            items = filterApps(filter.trim());
            lAppMode = true;  lAppCtx = { filter, start: lSlashAnchor, end: caret };
            lTabMode = false; lTabCtx = null;
          } else if (lSlashCmd === 'tab') {
            items = filterTabs(filter.trim());
            lTabMode = true;  lTabCtx = { filter, start: lSlashAnchor, end: caret };
            lAppMode = false; lAppCtx = null;
          } else {
            items = [];
          }
        }
      } else {
        const ctx = lDetectSlash();
        if (ctx) {
          lSlashState  = 'palette';
          lSlashPalCtx = ctx;
          const prevScope = lSlashScopedExe;
          lSlashScopedExe = lFindScopedExeAtSlash(ctx.slashOffset);
          // Bust the /tab cache when the active scope changes — otherwise
          // the previous scope's tabs would re-show for the new app pill.
          if (prevScope !== lSlashScopedExe) { lTabAllTabs = []; lTabWindowCount = 1; lTabToken++; }
          const cmds = lFilterPalette(ctx.query);
          items = cmds.map(c => ({ slashCmd: c, name: c.label, hint: c.hint }));
          lAppMode = false; lAppCtx = null;
          lTabMode = false; lTabCtx = null;
        } else {
          lCloseSlash();
          items = [];
        }
      }
    }
    activeIdx = items.length ? 0 : -1;
    renderDropdown();
    setGhost();
  }

  function completeGhost() {
    const caretToEnd = () => {
      try { lInput.focus(); const n = lInput.value.length; lInput.setSelectionRange(n, n); } catch {}
    };
    if (lGhost.textContent) { lInput.value = lGhost.textContent; lGhost.textContent = ''; refreshSuggestions(); caretToEnd(); return true; }
    if (items[activeIdx]) { lInput.value = items[activeIdx].name; lGhost.textContent = ''; refreshSuggestions(); caretToEnd(); return true; }
    return false;
  }

  // ── Stage transitions ──
  function setModeChip() {
    lModeChip.textContent = mode === 'automation' ? 'Automation' : 'Chat';
    lModeChip.dataset.mode = mode;
    launcherCard.dataset.mode = mode;
  }
  // Hint builder — wrap keyboard keys in <kbd> so they read as real keys.
  // Pass strings as text, objects {k:'Enter'} as kbd pills, or arrays for combos
  // like ['Shift','Enter'] which render as `<kbd>Shift</kbd>+<kbd>Enter</kbd>`.
  const K = (...keys) => ({ k: keys });
  function setHintParts(target, parts) {
    target.replaceChildren();
    for (const p of parts) {
      if (p == null || p === '') continue;
      if (typeof p === 'string' || typeof p === 'number') {
        target.appendChild(document.createTextNode(String(p)));
        continue;
      }
      if (p && Array.isArray(p.k)) {
        p.k.forEach((key, i) => {
          if (i > 0) target.appendChild(document.createTextNode('+'));
          const el = document.createElement('kbd');
          el.textContent = key;
          target.appendChild(el);
        });
      }
    }
  }
  function setHint() {
    if (view === 'chat') {
      setHintParts(lHint, [
        K('Enter'), ' to send · ',
        K('Shift', 'Enter'), ' for newline · ',
        K('Esc'), ' to close · Hold ', K('Esc'), ' to clear chat',
      ]);
      return;
    }
    if (stage === 'app') {
      setHintParts(lHint, [
        K('↑'), K('↓'), ' navigate · ',
        K('Tab'), ' to pick an app · ',
        K('Enter'), ' to chat with GPT-5.5 · ',
        K('Esc'), ' to close',
      ]);
    } else if (mode === 'automation') {
      setHintParts(lHint, [
        `Run an automation on ${selApp ? selApp.name : ''} · `,
        K('Enter'), ' to run · ',
        K('Tab'), ' to edit · Hold ', K('Tab'), ' to delete',
      ]);
    } else {
      setHintParts(lHint, [
        `Ask ${selApp ? selApp.name : 'the app'} to do something · `,
        K('Enter'), ' to send',
      ]);
    }
  }

  function enterLauncher(nextMode, opts) {
    // animate=false is the in-place mode toggle path: the launcher is already
    // on-screen, so replaying the entrance fade + forcing a resize would read
    // as a view switch / flicker. Only a real overlay show/boot animates.
    const animate = !opts || opts.animate !== false;
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
    if (animate) {
      launcherCard.classList.remove('anim');
      void launcherCard.offsetWidth;        // reflow so the entrance anim replays each show
      launcherCard.classList.add('anim');
    }
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
    // Force a fresh resize on every overlay show: the dedup in syncLauncherSize
    // would otherwise skip the corrective resize when the collapsed card
    // measures the same as the prior session, leaving the window stuck at
    // showOverlay's collapsedHeight and clipping the top. Skip the force on an
    // in-place mode toggle (animate=false) — there the window is already sized
    // and a redundant tween reads as a flicker; syncLauncherSize's dedup still
    // resizes if the height genuinely changed (e.g. exiting inline chat).
    if (animate) lastSyncedH = 0;
    syncLauncherSize();
  }

  // Exposed for module-scope callers (e.g. resetCurrentChat) so a chat reset
  // can return to the launcher's "Search an app or type a prompt" view instead
  // of sitting in the empty inline-chat state.
  window.__enterLauncher = enterLauncher;

  async function selectApp(app) {
    selApp = app;
    lTabAllTabs = []; lTabWindowCount = 1; lTabToken++;        // drop any prior app's tab cache
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
    lTabAllTabs = []; lTabWindowCount = 1; lTabToken++;
    lCloseSlash();
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

  // Replace the active /app arg span in lInput with `[app:key "name"]` and
  // record the app's resolved meta so submit can hand it to the backend as
  // apps[]. The span runs from lSlashAnchor (the spliced /cmd position) to the
  // current caret.
  function pickLauncherApp(app) {
    if (!app) return;
    const start = (lSlashAnchor >= 0) ? lSlashAnchor : (lAppCtx ? lAppCtx.start : -1);
    const end = (lInput.selectionStart != null) ? lInput.selectionStart : lInput.value.length;
    if (start < 0) return;
    const pill = buildAppPill(app);
    lInsertPill(start, end, pill);
    launcherAppRefs.set(app.exe, { key: pill.dataset.appKey, exe: app.exe, name: app.name, type: app.type, pid: app.pid || null, port: app.port || null });
    lCloseSlash();
    items = []; activeIdx = -1;
    lDropdown.hidden = true; lGhost.textContent = '';
    lInput.focus();
    refreshSuggestions();
  }

  // Same idea for /tab: splice the arg span with `[tab:<id> "<title>"]`. The
  // backend forwards this token; the model interprets it via
  // cdp_select_window({ id }) before issuing tab-scoped tools.
  function pickLauncherTab(tab) {
    if (!tab) return;
    const start = (lSlashAnchor >= 0) ? lSlashAnchor : (lTabCtx ? lTabCtx.start : -1);
    const end = (lInput.selectionStart != null) ? lInput.selectionStart : lInput.value.length;
    if (start < 0) return;
    const pill = buildTabPill(tab);
    lInsertPill(start, end, pill);
    lCloseSlash();
    items = []; activeIdx = -1;
    lDropdown.hidden = true; lGhost.textContent = '';
    lInput.focus();
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
    if (!entry) { setHintParts(lHint, ['No matching automation. ', K('↑'), K('↓'), ' to pick from the list.']); return; }
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
  lInput.addEventListener('compositionstart', () => { lComposing = true; });
  lInput.addEventListener('compositionend', () => { lComposing = false; refreshSuggestions(); });

  // Paste in a contenteditable copies rich HTML by default — sanitize to plain
  // text so pasted tokens behave like typed ones (the slash machine reasons in
  // text-space; stray <span>s or images would break that).
  lInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      sel.getRangeAt(0).deleteContents();
      sel.getRangeAt(0).insertNode(document.createTextNode(text));
      sel.collapseToEnd();
    }
    lInput.dispatchEvent(new Event('input', { bubbles: true }));
  });

  lInput.addEventListener('keydown', (e) => {
    const hasList = !lDropdown.hidden && items.length;
    // Pills are contentEditable=false; Chromium often won't delete them on
    // Backspace/Delete. Remove the adjacent pill ourselves so the key works.
    if ((e.key === 'Backspace' || e.key === 'Delete')) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed && lInput.contains(sel.getRangeAt(0).startContainer)) {
        const range = sel.getRangeAt(0);
        const pill = e.key === 'Backspace' ? lPillBeforeCaret(range) : lPillAfterCaret(range);
        if (pill) {
          e.preventDefault();
          // Drop the tracking entry so collectLauncherApps doesn't resurrect it.
          if (pill.classList.contains('chat-app-pill')) {
            const key = pill.dataset.appKey || '';
            for (const [exe, meta] of launcherAppRefs) {
              if (meta.key === key) { launcherAppRefs.delete(exe); break; }
            }
          }
          const newRange = document.createRange();
          newRange.setStartBefore(pill);
          newRange.collapse(true);
          pill.remove();
          if (lInput.textContent.trim() === '' && !lInput.querySelector('.chat-app-pill, .chat-tab-pill')) {
            lInput.innerHTML = '';
          } else {
            sel.removeAllRanges();
            sel.addRange(newRange);
          }
          refreshSuggestions();
          return;
        }
      }
    }
    // Slash palette: Tab/Enter commits highlighted cmd, Esc closes. Arrow keys
    // fall through to the generic list nav below.
    if (lSlashState === 'palette' && items.length) {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const it = items[activeIdx] || items[0];
        if (it && it.slashCmd) lCommitSlashCmd(it.slashCmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        lCloseSlash(); items = []; activeIdx = -1;
        lDropdown.hidden = true; lGhost.textContent = '';
        setHint(); syncLauncherSize();
        return;
      }
    }
    // Arg picker: Tab/Enter picks; Esc closes; Backspace at the splice anchor
    // (no filter chars left) exits arg mode -- one more backspace dismisses the
    // picker cleanly. The /cmd text is already spliced, so nothing to restore.
    if (lSlashState === 'arg') {
      if ((e.key === 'Enter' || e.key === 'Tab') && items.length) {
        e.preventDefault();
        if (lSlashCmd === 'app') pickLauncherApp(items[activeIdx] || items[0]);
        else if (lSlashCmd === 'tab') pickLauncherTab(items[activeIdx] || items[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        lCloseSlash(); items = []; activeIdx = -1;
        lDropdown.hidden = true; lGhost.textContent = '';
        setHint(); syncLauncherSize();
        return;
      }
      if (e.key === 'Backspace') {
        const caret = (lInput.selectionStart == null) ? lInput.value.length : lInput.selectionStart;
        const selEnd = (lInput.selectionEnd == null) ? caret : lInput.selectionEnd;
        if (caret === lSlashAnchor && selEnd === caret) {
          e.preventDefault();
          lCloseSlash(); items = []; activeIdx = -1;
          lDropdown.hidden = true; lGhost.textContent = '';
          setHint(); syncLauncherSize();
          return;
        }
      }
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
      if (mode === 'automation' && stage === 'task') {
        e.preventDefault();
        if (tabSuppressUntilKeyup) return;
        if (e.repeat) return;
        if (tabHoldTimer) return;
        const target = items[activeIdx] || items[0] || null;
        if (!target || !target.id || !selApp) {
          // Nothing to hold-delete — fall back to plain autocomplete.
          completeGhost();
          return;
        }
        tabHoldTarget = target;
        tabHoldStart = performance.now();
        tabDeleteFired = false;
        tabPrevHint = true;
        if (lHint) lHint.textContent = `Hold to delete "${target.name}" · release to cancel`;
        const tick = () => {
          if (!tabHoldStart) return;
          const p = Math.min(1, (performance.now() - tabHoldStart) / TAB_HOLD_MS);
          setLogoRing(p);
          if (p < 1) tabHoldRaf = requestAnimationFrame(tick);
        };
        tabHoldRaf = requestAnimationFrame(tick);
        tabHoldTimer = setTimeout(async () => {
          tabHoldTimer = null;
          if (!tabHoldTarget) { cancelTabHold(); return; }
          const t = tabHoldTarget;
          tabDeleteFired = true;
          tabSuppressUntilKeyup = true;
          setLogoRing(1);
          try {
            await window.automation.remove({ exe: selApp.exe, id: t.id });
            if (typeof refreshAutomationsForApp === 'function') {
              try { await refreshAutomationsForApp(selApp.exe); } catch {}
            }
            try { autos = await window.automation.list(selApp.exe) || []; } catch { autos = []; }
            refreshSuggestions();
            setHint();
            tabPrevHint = false;
          } catch (err) {
            if (lHint) lHint.textContent = `Delete failed: ${err && err.message ? err.message : err}`;
          } finally {
            setLogoRing(0);
            tabHoldTarget = null;
            tabHoldStart = 0;
            if (tabHoldRaf) { cancelAnimationFrame(tabHoldRaf); tabHoldRaf = null; }
          }
        }, TAB_HOLD_MS);
        return;
      }
      if (mode === 'automation' && completeGhost()) { e.preventDefault(); return; }
    }
    if (e.key === 'Escape') {
      if (tabHoldStart || tabHoldTimer) { cancelTabHold(); if (lHint && tabPrevHint) { setHint(); tabPrevHint = false; } }
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
        // Forward any /screenshot pills captured here so the direct chat send
        // attaches them — chatInput is empty at this point so sendChatMessage
        // can't scrape them itself.
        chatWithGptDirect(lInput.value.trim(), lScrapeShotAttachments());
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
    if (lSlashState === 'palette' && items[i].slashCmd) { lCommitSlashCmd(items[i].slashCmd); return; }
    if (lAppMode) { pickLauncherApp(items[i]); return; }
    if (lTabMode) { pickLauncherTab(items[i]); return; }
    if (stage === 'app') {
      if (items[i].gptDirect) chatWithGptDirect(lInput.value.trim(), lScrapeShotAttachments());
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
  chatBackBtn.addEventListener('click', () => { if (view === 'chat') { closeAutoPanel(); enterLauncher('chat'); } });

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

  // Tab-hold-to-delete (automation+task stage only). Tap-Tab still autocompletes
  // via completeGhost() — distinguished on keyup by elapsed time. Mirrors the
  // Esc-hold pattern above (rAF ring + setTimeout fire + suppressUntilKeyup).
  const TAB_HOLD_MS = 1000;
  let tabHoldStart = 0;
  let tabHoldTimer = null;
  let tabHoldRaf = null;
  let tabDeleteFired = false;
  let tabHoldTarget = null;
  let tabSuppressUntilKeyup = false;
  let tabPrevHint = false;
  function cancelTabHold() {
    if (tabHoldTimer) { clearTimeout(tabHoldTimer); tabHoldTimer = null; }
    if (tabHoldRaf) { cancelAnimationFrame(tabHoldRaf); tabHoldRaf = null; }
    tabHoldStart = 0;
    tabHoldTarget = null;
    setLogoRing(0);
  }
  lInput.addEventListener('keyup', (e) => {
    if (e.key !== 'Tab') return;
    if (tabSuppressUntilKeyup) { tabSuppressUntilKeyup = false; return; }
    if (!tabHoldStart) return;
    const armed = !tabDeleteFired;
    cancelTabHold();
    if (lHint && tabPrevHint) { setHint(); tabPrevHint = false; }
    tabDeleteFired = false;
    if (armed) completeGhost();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.isComposing || e.keyCode === 229) return; // IME composition cancel — not ours
    // Swallow every Esc keydown (chat or launcher view) until the user
    // releases the key after a hold-to-reset. Prevents the held key from
    // immediately exiting the overlay once the reset drops us into launcher.
    if (escSuppressUntilKeyup) { e.preventDefault(); e.stopPropagation(); return; }
    // Inline automation panel owns Esc when open: close it and restore chat.
    // Exception: the inline step-editor textarea handles its own Esc to close
    // just the editor without collapsing the whole panel.
    if (isAutoPanelOpen()) {
      if (e.target && e.target.classList && e.target.classList.contains('auto-modal-step-editor')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeAutoPanel();
      return;
    }
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
    if (e.isComposing || e.keyCode === 229) return; // IME composition cancel — not ours
    const wasHolding = escHoldStart > 0 || escResetFired;
    const didReset = escResetFired;
    cancelEscHold();
    escResetFired = false;
    escSuppressUntilKeyup = false;
    if (!wasHolding) return;
    if (didReset) return; // suppress dismiss after a successful reset
    // Tap-Esc during an in-flight stream stops the model (keeps transcript).
    // Backend: chat:stop sets the abort flag + req.destroy(); the round loop
    // breaks at the next check and emits chat:done so the renderer clears state.
    if (view === 'chat' && chatBusy) { stopChatMessage(); return; }
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
  // Strip the closing class on every show so a re-summon during the close
  // fade snaps back to fully opaque without any half-state flash.
  window.overlay.onToggleMode(() => {
    if (autoRunModal && autoRunModal.classList.contains('show')) return;
    enterLauncher(mode === 'automation' ? 'chat' : 'automation', { animate: false });
  });

  window.overlay.onShow((data) => {
    document.body.classList.remove('overlay-closing');
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
    // A hidden automation run modal can still be mounted when the user closes
    // the overlay via hotkey/blur before pressing the modal's Close button.
    // Do not rebuild the launcher underneath it on the next hotkey summon:
    // overlay-mode modals use a transparent backdrop to preserve rounded-window
    // transparency, so launcher pixels would otherwise show through above the
    // run sheet.
    if (autoRunModal && autoRunModal.classList.contains('show')) {
      syncAutoModalChrome();
      sizeForRun();
      lInput.blur();
      return;
    }
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
        if (typeof destroyLiveActivity === 'function' && persistedExe !== chatCurrentExe) destroyLiveActivity();
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
    // Hide immediately. Leaving the transparent native window visible during a
    // close fade gives Windows/Electron time to paint the top gutter strip.
    try { window.overlay.finishHide(); } catch {}
  });

  // Refresh the running-apps list at load so suggestions are warm by first
  // hotkey press. Runs immediately (not behind a 50 ms setTimeout) — even with
  // backgroundThrottling disabled on the hidden overlay window, deferring
  // the kickoff burns time the user's first-summon clock is already counting.
  refreshApps().then(() => { if (view === 'launcher' && stage === 'app') refreshSuggestions(); }).catch(() => {});

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

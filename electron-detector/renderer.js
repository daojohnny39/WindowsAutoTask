const appList = document.getElementById('app-list');
const countBadge = document.getElementById('count-badge');
const refreshBtn = document.getElementById('refresh-btn');
const statusBar = document.getElementById('status-bar');
const viewToggle = document.getElementById('view-toggle');
const navLinks = document.getElementById('nav-links');
const pageApps = document.getElementById('page-apps');
const pageElements = document.getElementById('page-elements');
const elementsList = document.getElementById('elements-list');
const elementsBadge = document.getElementById('elements-badge');
const elementsRefreshBtn = document.getElementById('elements-refresh-btn');
const pageSelectedApps = document.getElementById('page-selected-apps');
const pageChat = document.getElementById('page-chat');
const selectedAppsList = document.getElementById('selected-apps-list');
const selectedAppsBadge = document.getElementById('selected-apps-badge');
const selectedAppsRefreshBtn = document.getElementById('selected-apps-refresh-btn');
const selectedAppsViewToggle = document.getElementById('selected-apps-view-toggle');
const addAutomationBtn = document.getElementById('add-automation-btn');
const automationBackBtn = document.getElementById('automation-back-btn');
const automationBackLabel = document.getElementById('automation-back-label');

let selectedAppsView = 'apps';
let automationDrillExe = null;
let automationDrillName = null;
const automationsStore = {};

let busy = false;
let currentApps = [];
let cachedUiaApps = [];
let persistentExes = new Set();
let selectedUiaExes = new Set();
let currentView = 'all';
let currentPage = 'apps';
let elementsCache = {};
let elementsBusy = false;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Navbar ──

navLinks.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-link');
  if (!btn || btn.dataset.page === currentPage) return;
  switchPage(btn.dataset.page);
});

function switchPage(page) {
  currentPage = page;
  navLinks.querySelectorAll('.nav-link').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  pageApps.classList.toggle('active', page === 'apps');
  pageSelectedApps.classList.toggle('active', page === 'selected-apps');
  pageElements.classList.toggle('active', page === 'elements');
  pageChat.classList.remove('active');

  if (page === 'elements') {
    refreshElements();
  } else if (page === 'selected-apps') {
    refreshSelectedApps();
  }
}

// ── Apps Page ──

function renderElectronCard(app, i, showCheckbox = true) {
  const cardClass = app.error ? ' cdp-error' : (app.cdpAlive ? ' cdp-active' : '');
  const checked = app.cdpAlive ? 'checked' : '';
  const checkboxHtml = showCheckbox ? `
      <label class="app-checkbox">
        <input type="checkbox" ${checked} data-exe="${escapeHtml(app.Exe)}" data-index="${i}" data-type="electron">
        <span class="checkmark"></span>
      </label>` : '';
  return `
    <div class="app-card${cardClass}${showCheckbox ? '' : ' no-checkbox'}" data-index="${i}" data-exe="${escapeHtml(app.Exe)}" data-name="${escapeHtml(app.Name)}">${checkboxHtml}
      <div class="app-info">
        <div class="app-name">${escapeHtml(app.Name)}</div>
        ${app.error ? `<div class="app-error">${escapeHtml(app.error)}</div>` : ''}
      </div>
    </div>`;
}

function renderUiaCard(app, showCheckbox = true) {
  const checked = selectedUiaExes.has(app.Exe) ? 'checked' : '';
  const checkboxHtml = showCheckbox ? `
      <label class="app-checkbox">
        <input type="checkbox" ${checked} data-exe="${escapeHtml(app.Exe)}" data-type="uia">
        <span class="checkmark"></span>
      </label>` : '';
  return `
    <div class="app-card uia-app${selectedUiaExes.has(app.Exe) ? ' uia-selected' : ''}${showCheckbox ? '' : ' no-checkbox'}" data-exe="${escapeHtml(app.Exe)}" data-name="${escapeHtml(app.Name)}">${checkboxHtml}
      <div class="app-info">
        <div class="app-name">${escapeHtml(app.Name)}</div>
        <div class="app-window-title">${escapeHtml(app.WindowTitle || '')}</div>
      </div>
    </div>`;
}

function renderAll(electronApps, uiaApps) {
  const total = electronApps.length + uiaApps.length;
  countBadge.textContent = `${total} app${total === 1 ? '' : 's'}`;

  if (total === 0) {
    appList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9678;</div>
        <p>No apps detected</p>
      </div>`;
    return;
  }

  let html = '';

  html += `<div class="section-header">
    <span class="section-title">Electron Apps</span>
    <span class="section-count">${electronApps.length}</span>
  </div>`;

  if (electronApps.length === 0) {
    html += '<div class="section-empty">No Electron apps running</div>';
  } else {
    html += electronApps.map((app, i) => renderElectronCard(app, i)).join('');
  }

  html += `<div class="section-header">
    <span class="section-title">Automatable Apps</span>
    <span class="section-count">${uiaApps.length}</span>
  </div>`;

  if (uiaApps.length === 0) {
    html += '<div class="section-empty">No other automatable apps detected</div>';
  } else {
    html += uiaApps.map(app => renderUiaCard(app)).join('');
  }

  appList.innerHTML = html;

  appList.querySelectorAll('.app-checkbox input[data-type="electron"]').forEach(cb => {
    cb.addEventListener('change', handleAppCheckbox);
  });
  appList.querySelectorAll('.app-checkbox input[data-type="uia"]').forEach(cb => {
    cb.addEventListener('change', handleUiaCheckbox);
  });
}

function handleUiaCheckbox(e) {
  const cb = e.currentTarget;
  const exe = cb.dataset.exe;
  if (cb.checked) {
    selectedUiaExes.add(exe);
  } else {
    selectedUiaExes.delete(exe);
  }
  if (currentView === 'selected') {
    renderSelectedView();
  } else {
    renderAll(currentApps, cachedUiaApps);
  }
}

async function checkAllCdpStatus(apps) {
  return Promise.all(apps.map(async (app) => {
    let alive = false;
    let error = null;
    if (app.DebugEnabled && app.DebugPort) {
      alive = await window.api.checkCdpAlive(app.DebugPort);
      if (!alive) {
        error = `CDP unreachable on port ${app.DebugPort}`;
      }
    } else if (persistentExes.has(app.Exe)) {
      error = 'Flag missing — app restarted without CDP';
    }
    return { ...app, cdpAlive: alive, error };
  }));
}

function showStatus(msg) {
  statusBar.textContent = msg;
  statusBar.classList.add('visible');
}

function hideStatus() {
  statusBar.classList.remove('visible');
}

function setBusy(state) {
  busy = state;
  refreshBtn.disabled = state;
  if (state) {
    refreshBtn.classList.add('spinning');
  } else {
    refreshBtn.classList.remove('spinning');
  }
}

async function refresh() {
  if (busy) return;
  setBusy(true);
  hideStatus();

  try {
    const [electronResult, uiaResult, cdpResult] = await Promise.allSettled([
      window.api.detectApps(),
      window.api.detectUiaApps(),
      window.api.getCdpState(),
    ]);

    const electronApps = electronResult.status === 'fulfilled' ? electronResult.value : [];
    const allUiaApps = uiaResult.status === 'fulfilled' ? uiaResult.value : [];
    const cdpState = cdpResult.status === 'fulfilled' ? cdpResult.value : { apps: [] };

    persistentExes = new Set((cdpState.apps || []).map(a => a.exe));

    const electronExes = new Set(electronApps.map(a => a.Exe));
    cachedUiaApps = allUiaApps.filter(a => !electronExes.has(a.Exe));

    const appsWithStatus = await checkAllCdpStatus(electronApps);
    currentApps = appsWithStatus;
    if (currentView === 'selected') {
      renderSelectedView();
    } else {
      renderAll(appsWithStatus, cachedUiaApps);
    }
  } catch (err) {
    appList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <p>Detection failed: ${escapeHtml(err.message)}</p>
      </div>`;
    countBadge.textContent = 'Error';
  } finally {
    setBusy(false);
  }
}

async function handleAppCheckbox(e) {
  const cb = e.currentTarget;
  const exe = cb.dataset.exe;
  const index = parseInt(cb.dataset.index, 10);
  const app = currentApps[index];
  const enabling = cb.checked;

  cb.disabled = true;
  showStatus(enabling
    ? `Restarting ${app.Name} with CDP...`
    : `Restarting ${app.Name} without CDP...`);

  try {
    const apps = enabling
      ? await window.api.enableCdpApp(exe)
      : await window.api.disableCdpApp(exe);

    const cdpState = await window.api.getCdpState();
    persistentExes = new Set((cdpState.apps || []).map(a => a.exe));

    const appsWithStatus = await checkAllCdpStatus(apps);
    currentApps = appsWithStatus;
    if (currentView === 'selected') {
      renderSelectedView();
    } else {
      renderAll(appsWithStatus, cachedUiaApps);
    }

    const updated = appsWithStatus.find(a => a.Exe === exe);
    if (enabling && updated && updated.error) {
      showStatus(`${app.Name}: ${updated.error}`);
    } else if (updated && updated.cdpAlive) {
      showStatus(`${app.Name}: CDP On (port ${updated.DebugPort})`);
      setTimeout(hideStatus, 3000);
    } else {
      showStatus(`${app.Name}: CDP Off`);
      setTimeout(hideStatus, 3000);
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`);
    cb.checked = !enabling;
    cb.disabled = false;
  }
}

function renderSelectedView() {
  const selectedElectron = currentApps.filter(app => app.cdpAlive);
  const selectedUia = cachedUiaApps.filter(app => selectedUiaExes.has(app.Exe));
  const total = selectedElectron.length + selectedUia.length;

  countBadge.textContent = `${total} selected`;

  if (total === 0) {
    appList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9745;</div>
        <p>No apps selected</p>
        <p class="empty-hint">Enable CDP on apps in the All view</p>
      </div>`;
    return;
  }

  let html = '';

  if (selectedElectron.length > 0) {
    html += `<div class="section-header">
      <span class="section-title">Electron Apps</span>
      <span class="section-count">${selectedElectron.length}</span>
    </div>`;
    html += selectedElectron.map((app) => {
      const origIndex = currentApps.indexOf(app);
      return renderElectronCard(app, origIndex);
    }).join('');
  }

  if (selectedUia.length > 0) {
    html += `<div class="section-header">
      <span class="section-title">Automatable Apps</span>
      <span class="section-count">${selectedUia.length}</span>
    </div>`;
    html += selectedUia.map(app => renderUiaCard(app)).join('');
  }

  appList.innerHTML = html;

  appList.querySelectorAll('.app-checkbox input[data-type="electron"]').forEach(cb => {
    cb.addEventListener('change', handleAppCheckbox);
  });
  appList.querySelectorAll('.app-checkbox input[data-type="uia"]').forEach(cb => {
    cb.addEventListener('change', handleUiaCheckbox);
  });
}

function switchView(view) {
  currentView = view;
  viewToggle.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (view === 'selected') {
    renderSelectedView();
  } else {
    renderAll(currentApps, cachedUiaApps);
  }
}

viewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-btn');
  if (btn && btn.dataset.view !== currentView) {
    switchView(btn.dataset.view);
  }
});

refreshBtn.addEventListener('click', refresh);

// ── Elements Page ──

function setElementsBusy(state) {
  elementsBusy = state;
  elementsRefreshBtn.disabled = state;
  if (state) {
    elementsRefreshBtn.classList.add('spinning');
  } else {
    elementsRefreshBtn.classList.remove('spinning');
  }
}

async function refreshElements() {
  if (elementsBusy) return;
  setElementsBusy(true);
  elementsCache = {};

  try {
    const [electronResult, uiaResult, cdpResult] = await Promise.allSettled([
      window.api.detectApps(),
      window.api.detectUiaApps(),
      window.api.getCdpState(),
    ]);

    const electronApps = electronResult.status === 'fulfilled' ? electronResult.value : [];
    const allUiaApps = uiaResult.status === 'fulfilled' ? uiaResult.value : [];
    const cdpState = cdpResult.status === 'fulfilled' ? cdpResult.value : { apps: [] };
    const electronExes = new Set(electronApps.map(a => a.Exe));
    const uiaApps = allUiaApps.filter(a => !electronExes.has(a.Exe) && selectedUiaExes.has(a.Exe));

    const cdpPorts = {};
    (cdpState.apps || []).forEach(a => { cdpPorts[a.exe] = a.port; });

    const enriched = await Promise.all(electronApps.map(async (app) => {
      let port = app.DebugPort || cdpPorts[app.Exe] || null;
      let cdpAlive = false;
      if (port) {
        cdpAlive = await window.api.checkCdpAlive(port);
      }
      return { ...app, cdpPort: cdpAlive ? port : null };
    }));

    const selectedElectron = enriched.filter(a => a.cdpPort);

    renderElementsPage(selectedElectron, uiaApps);
  } catch (err) {
    elementsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <p>Detection failed: ${escapeHtml(err.message)}</p>
      </div>`;
    elementsBadge.textContent = 'Error';
  } finally {
    setElementsBusy(false);
  }
}

function renderElementsPage(electronApps, uiaApps) {
  const total = electronApps.length + uiaApps.length;
  elementsBadge.textContent = `${total} selected`;

  if (total === 0) {
    elementsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9745;</div>
        <p>No apps selected</p>
        <p class="empty-hint">Select apps on the Apps page to inspect their elements</p>
      </div>`;
    return;
  }

  let html = '';

  if (electronApps.length > 0) {
    html += `<div class="section-header">
      <span class="section-title">Electron Apps</span>
      <span class="section-count">${electronApps.length}</span>
    </div>`;
    electronApps.forEach(app => {
      html += renderElementCard(app, 'electron', app.MainPid, app.cdpPort);
    });
  }

  if (uiaApps.length > 0) {
    html += `<div class="section-header">
      <span class="section-title">Automatable Apps</span>
      <span class="section-count">${uiaApps.length}</span>
    </div>`;
    uiaApps.forEach(app => {
      html += renderElementCard(app, 'uia', app.Pid, null);
    });
  }

  elementsList.innerHTML = html;

  elementsList.querySelectorAll('.el-card-header').forEach(header => {
    header.addEventListener('click', () => {
      toggleElementCard(header.closest('.el-card'));
    });
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
    body.innerHTML = '<div class="el-empty">Enable CDP on the Apps page to inspect this app\'s DOM elements</div>';
    return;
  }

  body.innerHTML = `<div class="el-loading"><div class="spinner"></div> Inspecting elements...</div>`;

  try {
    const result = await window.api.inspectElements(pid, port);
    const els = result.elements || result;
    if (els && els.length > 0) {
      elementsCache[pid] = result;
    }
    renderElementsList(body, result);
  } catch (err) {
    body.innerHTML = `<div class="el-error">Failed to inspect: ${escapeHtml(err.message)}</div>`;
  }
}

function renderElementsList(container, result) {
  const source = result.source || 'uia';
  const elements = result.elements || result;

  if (!elements || elements.length === 0) {
    container.innerHTML = '<div class="el-empty">No elements found</div>';
    return;
  }

  if (source === 'cdp') {
    renderCdpElements(container, elements);
  } else {
    renderUiaElements(container, elements);
  }
}

function renderCdpElements(container, elements) {
  const grouped = {};
  elements.forEach(el => {
    const tag = el.Tag || 'UNKNOWN';
    if (!grouped[tag]) grouped[tag] = [];
    grouped[tag].push(el);
  });

  const sortedTags = Object.keys(grouped).sort((a, b) => {
    const order = ['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA'];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  let html = `<div class="el-summary">${elements.length} element${elements.length === 1 ? '' : 's'} across ${sortedTags.length} tag${sortedTags.length === 1 ? '' : 's'} <span class="el-source-badge cdp">CDP</span></div>`;

  sortedTags.forEach(tag => {
    const items = grouped[tag];
    html += `<div class="el-group">
      <div class="el-group-header">
        <span class="el-group-type">&lt;${escapeHtml(tag.toLowerCase())}&gt;</span>
        <span class="el-group-count">${items.length}</span>
      </div>
      <div class="el-group-items">`;

    items.forEach(el => {
      html += `<div class="el-item">`;
      if (el.Text) {
        html += `<span class="el-field"><span class="el-label">Text</span> ${escapeHtml(el.Text)}</span>`;
      }
      if (el.AriaLabel) {
        html += `<span class="el-field"><span class="el-label">Aria</span> ${escapeHtml(el.AriaLabel)}</span>`;
      }
      if (el.Id) {
        html += `<span class="el-field"><span class="el-label">ID</span> <code>${escapeHtml(el.Id)}</code></span>`;
      }
      if (el.Role) {
        html += `<span class="el-field"><span class="el-label">Role</span> <code>${escapeHtml(el.Role)}</code></span>`;
      }
      if (el.Class) {
        html += `<span class="el-field"><span class="el-label">Class</span> <code>${escapeHtml(el.Class)}</code></span>`;
      }
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
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(el);
  });

  const sortedTypes = Object.keys(grouped).sort((a, b) => {
    const order = ['Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'TabItem', 'Hyperlink', 'ListItem', 'TreeItem', 'DataItem'];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  let html = `<div class="el-summary">${elements.length} element${elements.length === 1 ? '' : 's'} across ${sortedTypes.length} type${sortedTypes.length === 1 ? '' : 's'} <span class="el-source-badge uia">UIA</span></div>`;

  sortedTypes.forEach(type => {
    const items = grouped[type];
    html += `<div class="el-group">
      <div class="el-group-header">
        <span class="el-group-type">${escapeHtml(type)}</span>
        <span class="el-group-count">${items.length}</span>
      </div>
      <div class="el-group-items">`;

    items.forEach(el => {
      html += `<div class="el-item">`;
      if (el.Name) {
        html += `<span class="el-field"><span class="el-label">Name</span> ${escapeHtml(el.Name)}</span>`;
      }
      if (el.AutomationId) {
        html += `<span class="el-field"><span class="el-label">ID</span> <code>${escapeHtml(el.AutomationId)}</code></span>`;
      }
      if (el.ClassName) {
        html += `<span class="el-field"><span class="el-label">Class</span> <code>${escapeHtml(el.ClassName)}</code></span>`;
      }
      html += `</div>`;
    });

    html += `</div></div>`;
  });

  container.innerHTML = html;
}

elementsRefreshBtn.addEventListener('click', refreshElements);

// ── Selected Apps Page ──

let selectedAppsBusy = false;

function setSelectedAppsBusy(state) {
  selectedAppsBusy = state;
  selectedAppsRefreshBtn.disabled = state;
  if (state) {
    selectedAppsRefreshBtn.classList.add('spinning');
  } else {
    selectedAppsRefreshBtn.classList.remove('spinning');
  }
}

async function refreshSelectedApps() {
  if (selectedAppsBusy) return;
  setSelectedAppsBusy(true);

  try {
    const [electronResult, uiaResult, cdpResult] = await Promise.allSettled([
      window.api.detectApps(),
      window.api.detectUiaApps(),
      window.api.getCdpState(),
    ]);

    const electronApps = electronResult.status === 'fulfilled' ? electronResult.value : [];
    const allUiaApps = uiaResult.status === 'fulfilled' ? uiaResult.value : [];
    const cdpState = cdpResult.status === 'fulfilled' ? cdpResult.value : { apps: [] };

    persistentExes = new Set((cdpState.apps || []).map(a => a.exe));

    const electronExes = new Set(electronApps.map(a => a.Exe));
    cachedUiaApps = allUiaApps.filter(a => !electronExes.has(a.Exe));

    const appsWithStatus = await checkAllCdpStatus(electronApps);
    currentApps = appsWithStatus;

    renderSelectedAppsPage(appsWithStatus, cachedUiaApps);
  } catch (err) {
    selectedAppsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <p>Detection failed: ${escapeHtml(err.message)}</p>
      </div>`;
    selectedAppsBadge.textContent = 'Error';
  } finally {
    setSelectedAppsBusy(false);
  }
}

let lastSelectedElectron = [];
let lastSelectedUia = [];

function renderSelectedAppsPage(electronApps, uiaApps) {
  const selectedElectron = electronApps.filter(app => app.cdpAlive);
  const selectedUia = uiaApps.filter(app => selectedUiaExes.has(app.Exe));
  lastSelectedElectron = selectedElectron;
  lastSelectedUia = selectedUia;
  renderSelectedAppsView();
}

function updateSelectedAppsHeader() {
  if (selectedAppsView === 'automations' && automationDrillExe) {
    const list = automationsStore[automationDrillExe] || [];
    selectedAppsBadge.textContent = `${list.length} automation${list.length === 1 ? '' : 's'}`;
    addAutomationBtn.style.display = '';
    automationBackBtn.style.display = '';
    automationBackLabel.textContent = automationDrillName || 'Back';
  } else if (selectedAppsView === 'automations') {
    const total = lastSelectedElectron.length + lastSelectedUia.length;
    selectedAppsBadge.textContent = `${total} app${total === 1 ? '' : 's'}`;
    addAutomationBtn.style.display = 'none';
    automationBackBtn.style.display = 'none';
  } else {
    const total = lastSelectedElectron.length + lastSelectedUia.length;
    selectedAppsBadge.textContent = `${total} selected`;
    addAutomationBtn.style.display = 'none';
    automationBackBtn.style.display = 'none';
  }
}

function renderSelectedAppsView() {
  updateSelectedAppsHeader();

  if (selectedAppsView === 'automations' && automationDrillExe) {
    renderAutomationsList();
    return;
  }

  const selectedElectron = lastSelectedElectron;
  const selectedUia = lastSelectedUia;
  const total = selectedElectron.length + selectedUia.length;

  if (total === 0) {
    selectedAppsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9745;</div>
        <p>No apps selected</p>
        <p class="empty-hint">Enable CDP on Electron apps or check UIA apps in the All Apps view</p>
      </div>`;
    return;
  }

  let html = '';

  if (selectedElectron.length > 0) {
    html += `<div class="section-header">
      <span class="section-title">Electron Apps</span>
      <span class="section-count">${selectedElectron.length}</span>
    </div>`;
    html += selectedElectron.map((app) => {
      const origIndex = currentApps.indexOf(app);
      return renderElectronCard(app, origIndex, false);
    }).join('');
  }

  if (selectedUia.length > 0) {
    html += `<div class="section-header">
      <span class="section-title">Automatable Apps</span>
      <span class="section-count">${selectedUia.length}</span>
    </div>`;
    html += selectedUia.map(app => renderUiaCard(app, false)).join('');
  }

  selectedAppsList.innerHTML = html;
}

function renderAutomationsList() {
  const list = automationsStore[automationDrillExe] || [];
  if (list.length === 0) {
    selectedAppsList.innerHTML = `<div class="automation-empty">No automations.</div>`;
    return;
  }
  selectedAppsList.innerHTML = list.map(a =>
    `<div class="automation-entry">${escapeHtml(a.name || 'Untitled')}</div>`
  ).join('');
}

selectedAppsViewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-btn');
  if (!btn) return;
  const view = btn.dataset.saView;
  if (view === selectedAppsView && !automationDrillExe) return;
  selectedAppsView = view;
  automationDrillExe = null;
  automationDrillName = null;
  selectedAppsViewToggle.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.saView === view);
  });
  renderSelectedAppsView();
});

automationBackBtn.addEventListener('click', () => {
  automationDrillExe = null;
  automationDrillName = null;
  renderSelectedAppsView();
});

addAutomationBtn.addEventListener('click', () => {
  // shell button — no behavior wired yet
});

selectedAppsRefreshBtn.addEventListener('click', refreshSelectedApps);

// ── Codex Login ──

const codexBtn = document.getElementById('codex-login-btn');
const codexInstallError = document.getElementById('codex-install-error');
const codexModal = document.getElementById('codex-modal');
const codexModalMsg = document.getElementById('codex-modal-msg');
const codexModalSpinner = document.querySelector('.codex-modal-spinner');
const codexModalCancel = document.getElementById('codex-modal-cancel');

function setCodexInstallError(msg) {
  if (msg) {
    codexInstallError.textContent = msg;
    codexInstallError.classList.add('visible');
  } else {
    codexInstallError.textContent = '';
    codexInstallError.classList.remove('visible');
  }
}

async function refreshCodexStatus() {
  try {
    const status = await window.codex.status();
    if (!status.installed) {
      codexBtn.textContent = 'Login with ChatGPT';
      codexBtn.classList.remove('logged-in');
      codexBtn.disabled = true;
      codexBtn.dataset.state = 'out';
      setCodexInstallError('codex CLI not installed — install it and restart');
      return;
    }
    setCodexInstallError(null);
    codexBtn.disabled = false;
    if (status.loggedIn) {
      codexBtn.textContent = 'Logout Codex';
      codexBtn.classList.add('logged-in');
      codexBtn.dataset.state = 'in';
    } else {
      codexBtn.textContent = 'Login with ChatGPT';
      codexBtn.classList.remove('logged-in');
      codexBtn.dataset.state = 'out';
    }
  } catch (err) {
    codexBtn.textContent = 'Codex unavailable';
    codexBtn.disabled = true;
    setCodexInstallError(err.message || 'status check failed');
  }
}

function showCodexModal(msg) {
  codexModalMsg.textContent = msg;
  codexModalMsg.classList.remove('error');
  codexModalSpinner.style.display = '';
  codexModalCancel.textContent = 'Cancel';
  codexModal.classList.add('show');
}

function showCodexError(msg) {
  codexModalMsg.textContent = msg;
  codexModalMsg.classList.add('error');
  codexModalSpinner.style.display = 'none';
  codexModalCancel.textContent = 'Close';
}

function hideCodexModal() {
  codexModal.classList.remove('show');
}

codexBtn.addEventListener('click', async () => {
  if (codexBtn.disabled) return;

  if (codexBtn.dataset.state === 'in') {
    codexBtn.disabled = true;
    codexBtn.textContent = 'Logging out...';
    try {
      await window.codex.logout();
    } catch (err) {
      console.error('logout error', err);
    }
    await refreshCodexStatus();
    return;
  }

  showCodexModal('Opening browser — waiting for device code...');
  const offCode = window.codex.onDeviceCode(({ code }) => {
    codexModalMsg.innerHTML =
      'Browser opened. Enter this code on the page:<br>' +
      `<div style="font-size:24px;font-weight:bold;letter-spacing:2px;margin-top:8px;user-select:all">${code}</div>`;
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

// ── Chat Panel ──

const chatBackBtn = document.getElementById('chat-back-btn');
const chatAppNameEl = document.getElementById('chat-app-name');
const chatMessagesEl = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

let chatCurrentExe = null;
let chatStore = {};
let chatMetaStore = {};
let chatStreamContent = '';
let chatStreamExe = null;
let chatBusy = false;

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
  if (uia) {
    return { exe, name: name || uia.Name, type: 'uia', pid: uia.Pid || null, port: null };
  }
  return { exe, name: name || exe, type: 'uia', pid: null, port: null };
}

async function openChat(appName, exe) {
  chatCurrentExe = exe;
  chatAppNameEl.textContent = appName;
  if (!chatStore[exe]) chatStore[exe] = [];

  const meta = resolveAppMeta(exe, appName);
  chatMetaStore[exe] = meta;

  navLinks.querySelectorAll('.nav-link').forEach(btn => btn.classList.remove('active'));
  pageApps.classList.remove('active');
  pageSelectedApps.classList.remove('active');
  pageElements.classList.remove('active');
  pageChat.classList.add('active');

  renderChat();
  chatInput.focus();

  try {
    await window.agent.ensure(meta);
  } catch (err) {
    console.error('agent:ensure failed', err);
  }
}

const chatNewBtn = document.getElementById('chat-new-btn');

chatBackBtn.addEventListener('click', () => {
  pageChat.classList.remove('active');
  switchPage('selected-apps');
});

chatNewBtn.addEventListener('click', () => {
  if (!chatCurrentExe) return;
  window.chat.reset(chatCurrentExe);
  chatStore[chatCurrentExe] = [];
  chatStreamContent = '';
  chatStreamExe = null;
  const streamMsg = document.getElementById('chat-stream-msg');
  if (streamMsg) streamMsg.remove();
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
        <div class="chat-welcome-icon">&#9672;</div>
        <p>Start a conversation</p>
      </div>`;
    return;
  }
  chatMessagesEl.innerHTML = msgs.map(m => {
    const html = renderMarkdown(m.content);
    return `<div class="chat-msg chat-msg-${m.role}">${html}</div>`;
  }).join('');
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function addChatMessage(role, content) {
  if (!chatStore[chatCurrentExe]) chatStore[chatCurrentExe] = [];
  chatStore[chatCurrentExe].push({ role, content });
  renderChat();
}

let thinkingBuffer = '';
let thinkingFallbackText = '';

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
      <div class="chat-thinking-sub" id="chat-thinking-sub"></div>
    `;
    chatMessagesEl.appendChild(el);
  } else {
    chatMessagesEl.appendChild(el);
  }
  setThinkingSub(subtext !== undefined ? subtext : thinkingFallbackText);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function setThinkingSub(text) {
  const sub = document.getElementById('chat-thinking-sub');
  if (!sub) return;
  const trimmed = (text || '').trim();
  if (!trimmed) {
    sub.textContent = '';
    sub.style.display = 'none';
    return;
  }
  sub.style.display = '';
  const tail = trimmed.length > 240 ? '…' + trimmed.slice(-240) : trimmed;
  sub.textContent = tail.replace(/\s+/g, ' ');
}

function hideThinking() {
  const el = document.getElementById('chat-thinking');
  if (el) el.remove();
  thinkingBuffer = '';
}

function resetThinkingBuffer() {
  thinkingBuffer = '';
}

function setChatBusy(state) {
  chatBusy = state;
  chatSendBtn.disabled = state;
  chatInput.disabled = state;
}

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
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
});

window.chat.onThinking((data) => {
  if (data.exe !== chatCurrentExe) return;
  if (data.reset) thinkingBuffer = '';
  if (data.delta) thinkingBuffer += data.delta;
  if (data.heartbeatMs !== undefined) {
    if (!document.getElementById('chat-thinking')) showThinking(thinkingFallbackText);
    const secs = Math.round(data.heartbeatMs / 1000);
    const base = thinkingBuffer || thinkingFallbackText || 'reasoning';
    setThinkingSub(`${base} · ${secs}s elapsed`);
    return;
  }
  if (!document.getElementById('chat-thinking')) showThinking(thinkingBuffer);
  else setThinkingSub(thinkingBuffer || thinkingFallbackText);
});

window.chat.onTool((data) => {
  if (data.exe !== chatCurrentExe) return;
  hideThinking();
  thinkingFallbackText = `running ${data.name}…`;
  const summary = formatToolCall(data.name, data.args);
  appendToolLine(`&#9881;&#65039; ${summary}`);
});

window.chat.onToolResult((data) => {
  if (data.exe !== chatCurrentExe) return;
  const ok = data.result && data.result.ok;
  const err = data.result && data.result.error;
  let msg;
  let fallback;
  if (err) {
    msg = `&#10060; ${escapeHtml(data.name)}: ${escapeHtml(err)}`;
    fallback = `after ${data.name} → error: ${err}`;
  } else if (data.result && data.result.text !== undefined) {
    const t = String(data.result.text).slice(0, 200).replace(/\n/g, ' ');
    msg = `&#10003; ${escapeHtml(data.name)} &rarr; ${escapeHtml(t)}`;
    fallback = `after ${data.name} → "${t.slice(0, 80)}"`;
  } else if (data.result && data.result.snapshot !== undefined) {
    msg = `&#10003; ${escapeHtml(data.name)} &rarr; refreshed (${data.result.refs || 0} refs)`;
    fallback = `after ${data.name} → ${data.result.refs || 0} refs`;
  } else if (data.result && data.result.messages) {
    const n = data.result.count || data.result.messages.length;
    msg = `&#10003; ${escapeHtml(data.name)} &rarr; ${n} messages`;
    fallback = `after ${data.name} → ${n} messages`;
  } else if (ok) {
    msg = `&#10003; ${escapeHtml(data.name)} ok`;
    fallback = `after ${data.name} → ok`;
  } else {
    msg = `&#8230; ${escapeHtml(data.name)} done`;
    fallback = `after ${data.name} → done`;
  }
  appendToolLine(msg);
  thinkingFallbackText = fallback;
  resetThinkingBuffer();
  showThinking(fallback);
});

function formatToolCall(name, args) {
  const parts = [];
  if (args.ref) parts.push(args.ref);
  if (args.text !== undefined) {
    const t = String(args.text);
    parts.push(`"${t.length > 40 ? t.slice(0, 40) + '...' : t}"`);
  }
  return `${escapeHtml(name)}(${parts.map(p => typeof p === 'string' ? escapeHtml(p) : p).join(', ')})`;
}

function appendToolLine(html) {
  const el = document.createElement('div');
  el.className = 'chat-tool-line';
  el.innerHTML = html;
  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

window.chat.onDone((data) => {
  if (data.exe !== chatStreamExe) return;
  hideThinking();
  thinkingFallbackText = '';
  const streamMsg = document.getElementById('chat-stream-msg');
  if (streamMsg) streamMsg.removeAttribute('id');

  const targetExe = chatStreamExe;
  if (chatStreamContent && chatStore[targetExe]) {
    chatStore[targetExe].push({ role: 'assistant', content: chatStreamContent });
  }
  chatStreamContent = '';
  chatStreamExe = null;
  setChatBusy(false);

  if (data && data.error) {
    const msg = `ChatGPT stopped responding: ${data.error}`;
    if (targetExe === chatCurrentExe) {
      addChatMessage('system', msg);
    } else {
      if (!chatStore[targetExe]) chatStore[targetExe] = [];
      chatStore[targetExe].push({ role: 'system', content: msg });
    }
  }
});

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || chatBusy) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  addChatMessage('user', text);
  resetThinkingBuffer();
  thinkingFallbackText = 'reading your request…';
  showThinking(thinkingFallbackText);
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

chatSendBtn.addEventListener('click', sendChatMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
});

chatMessagesEl.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.chat-code-copy');
  if (!copyBtn) return;
  const code = copyBtn.closest('.chat-code-block').querySelector('code');
  navigator.clipboard.writeText(code.textContent).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });
});

selectedAppsList.addEventListener('click', (e) => {
  if (e.target.closest('.app-checkbox')) return;
  const card = e.target.closest('.app-card');
  if (!card || !card.classList.contains('no-checkbox')) return;
  const exe = card.dataset.exe;
  const name = card.dataset.name;
  if (selectedAppsView === 'automations') {
    if (exe) {
      automationDrillExe = exe;
      automationDrillName = name || exe;
      renderSelectedAppsView();
    }
    return;
  }
  if (exe && name) openChat(name, exe);
});

// ── Markdown Renderer ──

const katex = require('katex');

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

  src = src.replace(/__ICODE_(\d+)__/g, (_, i) => {
    return `<code class="chat-inline-code">${escapeHtml(inlineCodes[parseInt(i)])}</code>`;
  });

  src = src.replace(/__CBLOCK_(\d+)__/g, (_, i) => {
    const b = codeBlocks[parseInt(i)];
    const langLabel = escapeHtml(b.lang) || 'text';
    return `<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${langLabel}</span><button class="chat-code-copy">Copy</button></div><pre><code>${escapeHtml(b.code)}</code></pre></div>`;
  });

  return src;
}

// ── Init ──

refresh();

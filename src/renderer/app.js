'use strict';

// Renderer entry. Owns the DOM only — every privileged action goes through
// the narrow `window.dbm` bridge exposed by preload.

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

const state = {
  servers: [],
  targets: [],
  selectedTargetId: null,
  collapsedServers: new Set(),
  connections: {}, // serverId -> boolean (connected)
  composeProjectsByServer: {}, // serverId -> { projects:[...], composeBin, composeVersion }
  dumps: [],
  activity: [],
  runtime: null,
  logs: [],            // ring buffer of recent log entries
  logsMax: 1000,
  logFilter: 'all',    // 'all' | 'info' | 'warn' | 'error' | 'debug'
  logSearch: '',
  logsDrawerOpen: false,
  logsAutoscroll: true,
  logErrorCount: 0,
  logsOpenIds: new Set(),
  activeBackup: null, // { opId, targetId, serverId, startedAt, bytes, history, phase, estimate, tickInterval }
};

// ---------- bootstrap ----------

(async function init() {
  try {
    state.runtime = await window.dbm.ping();
    const rt = state.runtime.runtime;
    if (rt.version) $('appVersion').textContent = 'v' + rt.version;
    $('runtime').textContent =
      'electron ' + rt.electron +
      ' · node ' + rt.node +
      ' · ' + rt.platform;
    if (!rt.safeStorageAvailable) {
      $('statusLeft').textContent = 'OS keychain unavailable — encryption disabled';
    }
  } catch (err) {
    $('runtime').textContent = 'ipc error';
    console.error(err);
  }

  window.dbm.backup.onProgress(onBackupProgress);
  window.dbm.discovery.onProgress(onDiscoveryProgress);
  window.dbm.logs.onEvent(onLogEvent);
  initUpdater();
  installRendererErrorCapture();
  initLogsDrawer();
  // Seed the buffer with recent history so opening the drawer isn't empty.
  try {
    const tail = await window.dbm.logs.tail(200);
    state.logs = tail;
    state.logErrorCount = tail.filter((e) => e.level === 'error').length;
    renderLogsBadge();
  } catch { /* logs are nice-to-have, don't block boot */ }

  // Privacy dialog (first-run only)
  window.dbm.privacy.onShow(() => { $('privacyModal').hidden = false; });
  $('privacyCheck').addEventListener('change', (e) => {
    $('privacyAcceptBtn').disabled = !e.target.checked;
  });
  $('privacyAcceptBtn').addEventListener('click', async () => {
    await window.dbm.privacy.accept();
    $('privacyModal').hidden = true;
  });

  // Sidebar
  $('btnNewServer').addEventListener('click', () => openServerModal());
  $('btnNewServerEmpty').addEventListener('click', () => openServerModal());
  $('btnNewTarget').addEventListener('click', () => openTargetModal());

  // Target view actions
  $('btnEditTarget').addEventListener('click', () => {
    const t = selectedTarget(); if (t) openTargetModal(t);
  });
  $('btnDeleteTarget').addEventListener('click', onDeleteTarget);
  $('btnBackupNow').addEventListener('click', onBackupNow);
  $('btnViewDb').addEventListener('click', onViewDb);
  $('uriRevealBtn').addEventListener('click', () => {
    const inp = $('uriInput');
    const revealing = inp.type === 'password';
    inp.type = revealing ? 'text' : 'password';
    const icon = $('uriEyeIcon');
    icon.innerHTML = revealing
      ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  });
  $('viewDbModalClose').addEventListener('click', closeViewDbModal);
  $('viewDbPrev').addEventListener('click', () => viewDbChangePage(-1));
  $('viewDbDocPrev').addEventListener('click', () => viewDbChangePage(-1));
  $('viewDbDocNext').addEventListener('click', () => viewDbChangePage(1));
  $('viewDbNext').addEventListener('click', () => viewDbChangePage(1));
  $('opCancelBtn').addEventListener('click', onCancelBackup);
  $('opDismissBtn').addEventListener('click', dismissOpPanel);

  // Server modal
  $('serverModalClose').addEventListener('click', closeServerModal);
  $('serverFormCancel').addEventListener('click', closeServerModal);
  $('serverForm').addEventListener('submit', onServerSubmit);
  $('btnPickKey').addEventListener('click', onPickKey);

  // Target modal
  $('targetModalClose').addEventListener('click', closeTargetModal);
  $('targetFormCancel').addEventListener('click', closeTargetModal);
  $('targetForm').addEventListener('submit', onTargetSubmit);
  for (const btn of document.querySelectorAll('#targetForm .segmented__btn')) {
    btn.addEventListener('click', () => selectKind(btn.dataset.kind));
  }
  $('targetServerPicker').addEventListener('change', onTargetServerChange);
  document.querySelector('#targetForm select[name="engine"]').addEventListener('change', (e) => selectEngine(e.target.value));
  // Installed kind: engine change also updates default port
  $('installedServerPicker').addEventListener('change', () => {});
  $('composeProjectSelect').addEventListener('change', onComposeProjectChange);
  $('composeServiceSelect').addEventListener('change', onComposeServiceChange);
  $('composeRefresh').addEventListener('click', () => refreshComposePickers({ force: true }));
  $('composeLoadBtn').addEventListener('click', () => refreshComposePickers({ force: true }));

  // Discover modal
  $('discoverModalClose').addEventListener('click', closeDiscoverModal);
  $('discoverCancel').addEventListener('click', closeDiscoverModal);
  $('discoverConfirm').addEventListener('click', onDiscoverConfirm);

  // Passphrase
  $('passCancel').addEventListener('click', () => closePassModal(null));
  $('passForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.elements.passphrase.value;
    closePassModal(v);
  });

  // Settings
  $('btnSettings').addEventListener('click', openSettingsModal);
  $('settingsModalClose').addEventListener('click', closeSettingsModal);
  $('settingsModalDone').addEventListener('click', closeSettingsModal);
  $('settingsChangeDumpsDir').addEventListener('click', onChangeDumpsDir);

  // Restore modal
  $('restoreModalClose').addEventListener('click', closeRestoreModal);
  $('restoreModalCancel').addEventListener('click', closeRestoreModal);
  $('restoreModalConfirm').addEventListener('click', onRestoreConfirm);
  $('restoreTargetPicker').addEventListener('change', onRestoreTargetChange);
  $('restoreDbPicker').addEventListener('change', onRestoreDbChange);

  // Dump list — delegated click handler.
  $('dumpList').addEventListener('click', onDumpListClick);

  // Ensure the dump folder is picked before the first dumps:list.
  try {
    const { dumpsDir } = await window.dbm.settings.ensureDumpsDir();
    state.dumpsDir = dumpsDir;
  } catch (err) {
    console.warn('ensureDumpsDir failed', err);
  }

  await refreshAll();
})();

// ---------- data ----------

async function refreshAll() {
  state.servers = await window.dbm.servers.list();
  state.targets = await window.dbm.targets.list();
  state.dumps = await window.dbm.dumps.list();
  state.activity = await window.dbm.audit.tail(20);
  state.connections = await window.dbm.connection.statusAll();
  if (state.selectedTargetId && !state.targets.find((t) => t.id === state.selectedTargetId)) {
    state.selectedTargetId = null;
  }
  if (!state.selectedTargetId && state.targets.length) state.selectedTargetId = state.targets[0].id;
  renderAll();
}

function selectedTarget() {
  return state.targets.find((t) => t.id === state.selectedTargetId) || null;
}

function selectedServer() {
  const t = selectedTarget(); if (!t || !t.serverId) return null;
  return state.servers.find((s) => s.id === t.serverId) || null;
}

function dumpsForSelected() {
  const t = selectedTarget(); if (!t) return [];
  // Sidecars use `sourceProfileId` for backward compat; that field now holds the Target id.
  return state.dumps.filter((d) => d.sourceProfileId === t.id);
}

// ---------- render ----------

function renderAll() {
  renderServerTree();
  renderMainPanel();
  renderActivity();
}

function renderServerTree() {
  const tree = $('serverTree');
  const empty = $('serverEmpty');
  if (state.servers.length === 0 && state.targets.length === 0) {
    tree.innerHTML = ''; empty.hidden = false; return;
  }
  empty.hidden = true;

  // Group: targets-by-server. Targets without a serverId go in a synthetic "Standalone" group.
  const byServer = new Map();
  for (const s of state.servers) byServer.set(s.id, []);
  const standalone = [];
  for (const t of state.targets) {
    if (t.serverId && byServer.has(t.serverId)) byServer.get(t.serverId).push(t);
    else standalone.push(t);
  }

  // Split servers into VPS (ssh) and LOCAL groups. Render VPS first.
  const vpsServers = state.servers.filter((s) => s.kind !== 'local');
  const localServers = state.servers.filter((s) => s.kind === 'local');
  const groups = [];
  if (vpsServers.length) groups.push({ label: 'VPS', servers: vpsServers });
  if (localServers.length) groups.push({ label: 'LOCAL', servers: localServers });

  const parts = [];
  const renderServer = (server) => {
    const targets = byServer.get(server.id) || [];
    const collapsed = state.collapsedServers.has(server.id);
    const caret = collapsed ? '▸' : '▾';
    const isLocal = server.kind === 'local';
    const connected = !!state.connections[server.id];

    // Icon: monitor for local, server-rack for VPS
    const iconClass = isLocal ? 'tree__server-icon--local' : (connected ? 'tree__server-icon--ssh tree__server-icon--on' : 'tree__server-icon--ssh');
    const icon = isLocal
      ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="10" rx="1.5"/><path d="M5 15h6M8 12v3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="4" rx="1"/><rect x="1" y="9" width="14" height="4" rx="1"/><circle cx="13" cy="4" r="0.8" fill="currentColor" stroke="none"/><circle cx="13" cy="11" r="0.8" fill="currentColor" stroke="none"/></svg>';

    // Subtitle: host info or local description
    const subtitle = isLocal
      ? (server.wslDistro ? 'WSL · ' + server.wslDistro : 'Docker · localhost')
      : ((server.user || 'user') + '@' + (server.host || '?') + (server.port && server.port !== 22 ? ':' + server.port : ''));
    const subClass = isLocal ? 'tree__server-sub--local' : (connected ? 'tree__server-sub--on' : '');

    // Status badge pill
    const badge = isLocal
      ? '<span class="tree__badge tree__badge--local">local</span>'
      : (connected
          ? '<span class="tree__badge tree__badge--ssh-on">ready</span>'
          : '<span class="tree__badge tree__badge--ssh">ssh</span>');

    const connectBtn = isLocal
      ? '<button class="iconbtn iconbtn--xs" data-action="probe" title="Probe docker">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5"/><path d="M8 5v3l2 1"/></svg>' +
        '</button>'
      : connected
        ? '<button class="iconbtn iconbtn--xs" data-action="disconnect" title="Disconnect">' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>' +
          '</button>'
        : '<button class="iconbtn iconbtn--xs iconbtn--accent" data-action="connect" title="Connect">' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10L4 12a2.5 2.5 0 003.5 3.5L10 13M10 6l2-2a2.5 2.5 0 00-3.5-3.5L6 3M6 10l4-4"/></svg>' +
          '</button>';

    parts.push(
      '<div class="tree__server' + (collapsed ? ' tree__server--collapsed' : '') + (isLocal ? ' tree__server--local' : '') + '" data-server-id="' + server.id + '">' +
        '<div class="tree__server-row" data-action="toggle">' +
          '<span class="tree__caret">' + caret + '</span>' +
          '<span class="tree__server-icon ' + iconClass + '">' + icon + '</span>' +
          '<span class="tree__server-info">' +
            '<span class="tree__server-name">' + escapeHtml(server.name) + '</span>' +
            '<span class="tree__server-sub ' + subClass + '">' + escapeHtml(subtitle) + '</span>' +
          '</span>' +
          badge +
          '<span class="tree__server-meta mono">' + targets.length + '</span>' +
          '<span class="tree__server-actions">' +
            connectBtn +
            '<button class="iconbtn iconbtn--xs" data-action="discover" title="Discover databases">' +
              '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M14 14l-3.5-3.5"/></svg>' +
            '</button>' +
            '<button class="iconbtn iconbtn--xs" data-action="edit-server" title="Edit server">' +
              '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8.5 8.5L2 14l.5-3.5L11 2z"/></svg>' +
            '</button>' +
            '<button class="iconbtn iconbtn--xs" data-action="delete-server" title="Delete server">' +
              '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4"/></svg>' +
            '</button>' +
          '</span>' +
        '</div>'
    );
    if (!collapsed) {
      if (targets.length === 0) {
        parts.push('<div class="tree__empty">No targets yet.</div>');
      } else {
        // Sort prod first, then staging, then dev.
        const order = { prod: 0, staging: 1, dev: 2 };
        targets.sort((a, b) => (order[a.envTag] - order[b.envTag]) || a.name.localeCompare(b.name));
        for (const t of targets) parts.push(targetRow(t));
      }
    }
    parts.push('</div>');
  };

  for (const group of groups) {
    parts.push('<div class="tree__section">' + group.label + '</div>');
    for (const server of group.servers) renderServer(server);
  }

  if (standalone.length) {
    parts.push(
      '<div class="tree__server">' +
      '<div class="tree__server-row">' +
        '<span class="tree__caret">▾</span>' +
        '<span></span>' +
        '<span class="tree__server-info"><span class="tree__server-name">Standalone</span></span>' +
        '<span class="tree__server-meta mono">' + standalone.length + '</span>' +
      '</div>'
    );
    for (const t of standalone) parts.push(targetRow(t));
    parts.push('</div>');
  }

  tree.innerHTML = parts.join('');

  // Wire interactions.
  for (const row of tree.querySelectorAll('.tree__server-row')) {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      const serverId = row.parentElement.dataset.serverId;
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'toggle') {
        if (state.collapsedServers.has(serverId)) state.collapsedServers.delete(serverId);
        else state.collapsedServers.add(serverId);
        renderServerTree();
      } else if (action === 'connect') {
        e.stopPropagation();
        connectServer(serverId);
      } else if (action === 'disconnect') {
        e.stopPropagation();
        disconnectServer(serverId);
      } else if (action === 'probe') {
        e.stopPropagation();
        probeLocalServer(serverId);
      } else if (action === 'discover') {
        e.stopPropagation();
        startDiscovery(serverId);
      } else if (action === 'edit-server') {
        e.stopPropagation();
        const server = state.servers.find((s) => s.id === serverId);
        if (server) openServerModal(server);
      } else if (action === 'delete-server') {
        e.stopPropagation();
        deleteServer(serverId);
      }
    });
  }
  for (const li of tree.querySelectorAll('.tree__target')) {
    li.addEventListener('click', () => { state.selectedTargetId = li.dataset.id; renderAll(); });
  }
}

function targetRow(t) {
  const sel = t.id === state.selectedTargetId ? ' tree__target--selected' : '';
  const dot = t.envTag === 'prod' ? '<span class="tree__dot tree__dot--prod" aria-hidden="true"></span>' : '<span class="tree__dot"></span>';
  return (
    '<div class="tree__target' + sel + '" data-id="' + t.id + '">' +
      dot +
      '<span class="tree__target-name">' + escapeHtml(t.name) + '</span>' +
      '<span class="tree__target-tag tag tag--' + t.envTag + '">' + t.envTag + '</span>' +
    '</div>'
  );
}

function renderMainPanel() {
  const t = selectedTarget();
  if (!t) {
    $('mainEmpty').hidden = false;
    $('profileView').hidden = true;
    $('appBarTitle').textContent = 'Tunnex';
    return;
  }
  $('mainEmpty').hidden = true;
  $('profileView').hidden = false;
  $('appBarTitle').textContent = 'Tunnex — ' + t.name + ' [' + t.envTag + ']';

  $('pvName').textContent = t.name;
  const tag = $('pvTag');
  tag.textContent = t.envTag;
  tag.className = 'tag tag--' + t.envTag;
  $('btnViewDb').textContent = t.engine === 'mongo' ? 'View Collections' : 'View DB';

  const server = selectedServer();
  let kindLabel;
  if (t.kind === 'docker-compose-vps') {
    kindLabel = server
      ? 'docker-compose · ' + _serverLabel(server, t) + ' · service: ' + (t.vps && t.vps.service)
      : 'docker-compose (orphan: server missing)';
  } else if (t.kind === 'installed') {
    const ins = t.installed || {};
    const srvPart = server ? ' via ' + server.name : ' (local)';
    kindLabel = 'installed · ' + (ins.host || 'localhost') + (ins.port ? ':' + ins.port : '') + srvPart;
  } else {
    kindLabel = 'external-uri';
  }
  $('pvSub').textContent = t.engine + ' · ' + kindLabel + ' · db: ' + t.dbName;

  const ds = dumpsForSelected();
  $('dumpCount').textContent = String(ds.length);
  const list = $('dumpList');
  const empty = $('dumpEmpty');
  if (ds.length === 0) { list.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  list.innerHTML = ds.map((d) => (
    '<li class="dump-list__item" data-path="' + escapeHtml(d.path) + '">' +
      '<span class="dump-list__name">' +
        escapeHtml(d.sourceProfileName || t.name) +
        '<span class="dump-list__db mono">· db: ' + escapeHtml(d.dbName || t.dbName) + '</span>' +
      '</span>' +
      '<span class="dump-list__when mono">' + formatTs(d.createdAt) + '</span>' +
      '<span class="dump-list__size mono">' + formatBytes(d.byteSize) + '</span>' +
      '<span class="dump-list__hash mono" title="' + escapeHtml(d.sha256Ciphertext) + '">' +
        escapeHtml(d.sha256Ciphertext.slice(0, 12)) + '…' +
      '</span>' +
      '<span class="dump-list__actions">' +
        '<button class="btn btn--ghost" data-action="restore">Restore…</button>' +
        '<button class="btn btn--ghost" data-action="download">Download…</button>' +
        '<button class="btn btn--danger" data-action="delete">Delete</button>' +
      '</span>' +
    '</li>'
  )).join('');
}

function renderActivity() {
  const ul = $('activityList');
  const empty = $('activityEmpty');
  if (state.activity.length === 0) { ul.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  ul.innerHTML = state.activity.map((a) => {
    const icon = a.ok ? '<span class="activity-list__ok">✓</span>' : '<span class="activity-list__err">!</span>';
    const subtitle = a.ok
      ? (a.bytesOut ? formatBytes(a.bytesOut) : (a.projectCount != null ? a.projectCount + ' projects' : ''))
      : escapeHtml(a.error || 'failed');
    const name = a.profileName || a.serverName || '—';
    return (
      '<li class="activity-list__item">' +
        '<div class="activity-list__row">' + icon +
          '<span class="activity-list__op">' + escapeHtml(a.op) + '</span>' +
          '<span class="activity-list__name">' + escapeHtml(name) + '</span>' +
        '</div>' +
        '<div class="activity-list__meta mono">' + formatTs(a.ts) + (subtitle ? ' · ' + subtitle : '') + '</div>' +
      '</li>'
    );
  }).join('');
}

// ---------- server modal ----------

let editingServerId = null;

function setServerModalKind(kind) {
  const form = $('serverForm');
  form.elements.kind.value = kind;
  for (const btn of form.querySelectorAll('[data-server-kind]')) {
    btn.classList.toggle('segmented__btn--active', btn.dataset.serverKind === kind);
  }
  for (const block of form.querySelectorAll('[data-show-when-server-kind]')) {
    block.hidden = block.dataset.showWhenServerKind !== kind;
  }
  // SSH fields are required only when in SSH mode.
  for (const el of [form.elements.host, form.elements.user, form.elements.privateKeyPath]) {
    if (el) el.required = (kind === 'ssh');
  }
  if (kind === 'local') populateWslDistros();
}

function updateComposeHints(server) {
  const pathHint = $('vpsComposePathHint');
  const loadHint = $('composeLoadHint');
  if (server.kind === 'local') {
    if (pathHint) {
      pathHint.innerHTML = server.wslDistro
        ? 'Path inside the <span class="mono">' + escapeHtml(server.wslDistro) + '</span> WSL distro (e.g. <span class="mono">/home/user/project</span>). Use <strong>Load projects</strong> below to auto-fill.'
        : 'Path on this machine containing <span class="mono">docker-compose.yml</span>. Use <strong>Load projects</strong> below to auto-fill.';
    }
    if (loadHint) {
      loadHint.textContent = 'No passphrase needed — runs locally. You can also fill the fields above manually.';
    }
  } else {
    if (pathHint) {
      pathHint.innerHTML = 'Directory on the VPS containing <span class="mono">docker-compose.yml</span>.';
    }
    if (loadHint) {
      loadHint.textContent = 'Requires entering the SSH passphrase. You can also fill the fields above manually.';
    }
  }
}

function serverPickerSubtitle(s) {
  if (s.kind === 'local') {
    return s.wslDistro ? 'local · WSL: ' + s.wslDistro : 'local';
  }
  return s.host || 'ssh';
}

function buildServerOptionsHtml(servers, { includeNoneOption = false } = {}) {
  const locals = servers.filter((s) => s.kind === 'local');
  const sshs = servers.filter((s) => s.kind === 'ssh');
  const opt = (s) =>
    '<option value="' + s.id + '">' +
      escapeHtml(s.name) + ' (' + escapeHtml(serverPickerSubtitle(s)) + ')' +
    '</option>';
  const parts = [];
  if (includeNoneOption) parts.push('<option value="">(this machine)</option>');
  if (locals.length) parts.push('<optgroup label="LOCAL">' + locals.map(opt).join('') + '</optgroup>');
  if (sshs.length) parts.push('<optgroup label="VPS">' + sshs.map(opt).join('') + '</optgroup>');
  return parts.join('');
}

async function populateWslDistros() {
  const sel = $('serverWslDistro');
  if (!sel) return;
  // Preserve current selection across re-population.
  const current = sel.value;
  try {
    const res = await window.dbm.wsl.listDistros();
    const distros = (res && res.distros) || [];
    sel.innerHTML = '<option value="">— Run on Windows directly (Docker Desktop) —</option>'
      + distros.map((d) => '<option value="' + escapeHtml(d.name) + '">' + escapeHtml(d.name) + '</option>').join('');
    if (current) sel.value = current;
    sel.disabled = false;
    if (!distros.length && (res && res.error)) {
      // No distros / WSL not installed — leave dropdown with just the
      // "direct" option. The hint text under the field explains the choice.
    }
  } catch {
    sel.disabled = true;
  }
}

function openServerModal(existing) {
  editingServerId = existing ? existing.id : null;
  const form = $('serverForm');
  form.reset();
  $('serverFormError').hidden = true;
  $('serverModalTitle').textContent = existing ? 'Edit server' : 'New server';

  // Wire the segmented control once (lazily). Re-binding is harmless because
  // the buttons stay the same DOM nodes.
  for (const btn of form.querySelectorAll('[data-server-kind]')) {
    btn.onclick = () => setServerModalKind(btn.dataset.serverKind);
  }

  const kind = existing ? (existing.kind || 'ssh') : 'ssh';
  setServerModalKind(kind);

  if (existing) {
    form.elements.name.value = existing.name;
    if (kind === 'ssh') {
      form.elements.host.value = existing.host || '';
      form.elements.port.value = existing.port || 22;
      form.elements.user.value = existing.user || '';
      form.elements.privateKeyPath.value = existing.privateKeyPath || '';
    } else if (kind === 'local' && existing.wslDistro) {
      // Will be set onto the dropdown after populateWslDistros resolves —
      // store on the element as a pending value the populator will honor.
      const sel = $('serverWslDistro');
      if (sel) sel.value = existing.wslDistro;
    }
    form.elements.sudoForDocker.checked = !!existing.sudoForDocker;
  } else {
    form.elements.port.value = '22';
  }
  $('serverModal').hidden = false;
  setTimeout(() => form.elements.name.focus(), 0);
}

function closeServerModal() { $('serverModal').hidden = true; editingServerId = null; }

async function onServerSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  const kind = f.kind.value || 'ssh';
  const input = { name: f.name.value.trim(), kind, sudoForDocker: f.sudoForDocker.checked };
  if (kind === 'ssh') {
    input.host = f.host.value.trim();
    input.port = Number(f.port.value) || 22;
    input.user = f.user.value.trim();
    input.privateKeyPath = f.privateKeyPath.value.trim();
  } else if (kind === 'local') {
    input.wslDistro = (f.wslDistro && f.wslDistro.value) || null;
  }
  try {
    if (editingServerId) await window.dbm.servers.update(editingServerId, input);
    else await window.dbm.servers.create(input);
    closeServerModal();
    await refreshAll();
  } catch (err) {
    const errEl = $('serverFormError');
    errEl.textContent = err.message || String(err);
    errEl.hidden = false;
  }
}

// Make sure the server is connected (cache valid). Tries an empty passphrase
// first so unencrypted keys never show the prompt. Returns true on success,
// false if the user cancelled or auth failed irrecoverably.
async function ensureConnected(serverId) {
  if (state.connections[serverId]) return true;
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return false;

  flashStatus('Connecting to ' + server.name + '…');
  const silent = await window.dbm.connection.test(serverId, '');
  if (silent.ok) {
    state.connections[serverId] = true;
    renderServerTree();
    flashStatus('Ready to use ' + server.name + ' (passphrase cached)');
    return true;
  }

  // ssh2 rejected the empty-passphrase attempt. Most likely the key is
  // encrypted — prompt. (If the failure was a host-key TOFU rejection, the
  // user already cancelled the native dialog; either way, ask for the
  // passphrase as the next step.)
  const entered = await askPassphrase(server.name);
  if (entered === null) { flashStatus('Idle'); return false; }

  flashStatus('Authenticating with ' + server.name + '…');
  const res = await window.dbm.connection.test(serverId, entered);
  if (res.ok) {
    state.connections[serverId] = true;
    renderServerTree();
    flashStatus('Ready to use ' + server.name + ' (passphrase cached)');
    return true;
  }
  state.connections[serverId] = false;
  renderServerTree();
  flashStatus('Connect failed: ' + (res.error || 'unknown'));
  await showDockerSetupHelp(res.code, res.error);
  return false;
}

async function connectServer(id) { await ensureConnected(id); }

async function probeLocalServer(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server) return;
  flashStatus('Probing ' + server.name + '…');
  const res = await window.dbm.connection.test(id, '');
  if (res.ok) {
    state.connections[id] = true;
    renderServerTree();
    flashStatus('Local docker ready' + (res.dockerComposeVersion ? ' · v' + res.dockerComposeVersion : ''));
  } else {
    state.connections[id] = false;
    renderServerTree();
    flashStatus('Probe failed: ' + (res.error || 'unknown'));
    await showDockerSetupHelp(res.code, res.error);
  }
}

async function disconnectServer(id) {
  await window.dbm.connection.disconnect(id);
  state.connections[id] = false;
  renderServerTree();
  const server = state.servers.find((s) => s.id === id);
  flashStatus('Disconnected from ' + (server ? server.name : 'server'));
}

let statusFlashTimer = null;
function flashStatus(msg) {
  $('statusLeft').textContent = msg;
  if (statusFlashTimer) clearTimeout(statusFlashTimer);
  statusFlashTimer = setTimeout(() => { $('statusLeft').textContent = 'Idle'; }, 4000);
}

// Returns true if the error was recognized and a dialog was shown.
// A packaged Electron app cannot prompt the user for a sudo password (no TTY,
// and showing a per-command GUI prompt is poor UX). Instead, surface a clear
// dialog with the one-time fix command for users to run in a terminal.
async function showDockerSetupHelp(code, fallbackMessage) {
  const fixCmd = 'sudo usermod -aG docker $USER';
  const details = {
    DOCKER_UNAVAILABLE: {
      title: 'Docker is not accessible',
      message: 'This app needs access to Docker without a password prompt.',
      detail:
        'Either Docker is not installed/running, or your user is not in the docker group.\n\n' +
        'Fix (one-time):\n  ' + fixCmd + '\n\nThen log out and back in (or reboot) and try again.',
    },
    DOCKER_SUDO_PASSWORD_REQUIRED: {
      title: 'Docker requires a password',
      message: 'Docker is only reachable via sudo, but a GUI app cannot prompt for the password.',
      detail:
        'Recommended fix (one-time): add your user to the docker group so sudo is no longer needed.\n\n' +
        '  ' + fixCmd + '\n\nThen log out and back in (or reboot).\n\n' +
        'Alternative: configure passwordless sudo (NOPASSWD) for docker in /etc/sudoers.',
    },
  };
  const info = details[code];
  if (!info) return false;
  const ans = await window.dbm.dialog.confirm({
    title: info.title,
    message: info.message,
    detail: info.detail + (fallbackMessage ? '\n\n(' + fallbackMessage + ')' : ''),
    confirmLabel: 'Copy fix command',
    cancelLabel: 'Close',
  });
  if (ans.ok) {
    try { await navigator.clipboard.writeText(fixCmd); flashStatus('Fix command copied to clipboard'); }
    catch { flashStatus('Could not copy — run: ' + fixCmd); }
  }
  return true;
}

async function deleteServer(id) {
  const server = state.servers.find((s) => s.id === id); if (!server) return;
  const targets = state.targets.filter((t) => t.serverId === id);
  const msg = targets.length
    ? 'Delete server "' + server.name + '"?\n' + targets.length + ' target(s) on this server will also be removed. Existing dumps stay on disk.'
    : 'Delete server "' + server.name + '"?';
  if (!confirm(msg)) return;
  await window.dbm.servers.remove(id, targets.length > 0);
  await refreshAll();
}

async function onPickKey() {
  try {
    const picked = await window.dbm.dialog.pickKeyFile();
    if (picked) $('serverForm').elements.privateKeyPath.value = picked;
  } catch (err) {
    const errEl = $('serverFormError');
    errEl.textContent = 'Could not open file picker: ' + (err.message || String(err));
    errEl.hidden = false;
  }
}

// ---------- target modal ----------

let editingTargetId = null;

function openTargetModal(existing, defaults) {
  editingTargetId = existing ? existing.id : null;
  const form = $('targetForm');
  form.reset();
  $('targetFormError').hidden = true;
  // Always start with URI hidden when modal opens
  $('uriInput').type = 'password';
  $('uriEyeIcon').innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  $('targetModalTitle').textContent = existing ? 'Edit target' : 'New target';

  // Populate server pickers (docker-compose and installed share the same server list).
  const picker = $('targetServerPicker');
  picker.innerHTML = state.servers.length
    ? buildServerOptionsHtml(state.servers)
    : '<option value="">No servers — add one first</option>';

  const instPicker = $('installedServerPicker');
  instPicker.innerHTML = buildServerOptionsHtml(state.servers, { includeNoneOption: true });

  if (existing) {
    form.elements.name.value = existing.name;
    form.elements.envTag.value = existing.envTag;
    form.elements.engine.value = existing.engine;
    form.elements.dbName.value = existing.dbName;
    selectKind(existing.kind);
    selectEngine(existing.engine || 'postgres');
    if (existing.kind === 'docker-compose-vps') {
      if (existing.serverId) form.elements.serverId.value = existing.serverId;
      form.elements.vps_composeProjectPath.value = (existing.vps && existing.vps.composeProjectPath) || '';
      form.elements.vps_service.value = (existing.vps && existing.vps.service) || '';
      form.elements.vps_pgUser.value = (existing.vps && existing.vps.pgUser) || '';
      const cl = existing.vps && existing.vps.compressionLevel;
      form.elements.vps_compressionLevel.value = cl == null ? '' : String(cl);
      // Mongo fields
      form.elements.vps_mongoUser.value = (existing.vps && existing.vps.mongoUser) || '';
      form.elements.vps_mongoAuthDb.value = (existing.vps && existing.vps.mongoAuthDb) || 'admin';
      // mongoPassword is never pre-filled (re-enter to change)
    } else if (existing.kind === 'installed') {
      const ins = existing.installed || {};
      $('installedServerPicker').value = existing.serverId || '';
      form.elements.installed_host.value = ins.host || 'localhost';
      form.elements.installed_port.value = ins.port ? String(ins.port) : '';
      form.elements.installed_dbUser.value = ins.dbUser || '';
      form.elements.installed_mongoAuthDb.value = ins.mongoAuthDb || 'admin';
      // dbPassword never pre-filled
    } else if (existing.kind === 'external-uri' && existing.hasUri) {
      window.dbm.targets.getUri(existing.id).then((res) => {
        if (res.ok && res.uri) $('uriInput').value = res.uri;
      }).catch(() => {});
    }
  } else {
    selectKind((defaults && defaults.kind) || 'docker-compose-vps');
    if (defaults) {
      if (defaults.serverId) form.elements.serverId.value = defaults.serverId;
      if (defaults.envTag) form.elements.envTag.value = defaults.envTag;
      if (defaults.name) form.elements.name.value = defaults.name;
      if (defaults.dbName) form.elements.dbName.value = defaults.dbName;
      if (defaults.composeProjectPath) form.elements.vps_composeProjectPath.value = defaults.composeProjectPath;
      if (defaults.service) form.elements.vps_service.value = defaults.service;
      if (defaults.pgUser) form.elements.vps_pgUser.value = defaults.pgUser;
    }
  }
  $('targetModal').hidden = false;
  setTimeout(() => form.elements.name.focus(), 0);
  // Fire-and-forget: populate the project dropdown if we already have a
  // cached SSH session for the selected server. Programmatic .value
  // assignment above doesn't fire 'change' — dispatch it so the same path
  // runs whether the server was set programmatically or by the user.
  $('targetServerPicker').dispatchEvent(new Event('change'));
}

function closeTargetModal() {
  $('targetModal').hidden = true;
  editingTargetId = null;
  hideComposePickers();
}

function selectKind(kind) {
  $('targetForm').elements.kind.value = kind;
  for (const btn of document.querySelectorAll('#targetForm .segmented__btn')) {
    btn.classList.toggle('segmented__btn--active', btn.dataset.kind === kind);
  }
  for (const el of document.querySelectorAll('#targetForm [data-show-when]')) {
    el.hidden = el.dataset.showWhen !== kind;
  }
  // Re-apply engine visibility whenever kind changes.
  selectEngine($('targetForm').elements.engine.value || 'postgres');
}

function selectEngine(engine) {
  for (const el of document.querySelectorAll('#targetForm [data-show-engine]')) {
    el.hidden = el.dataset.showEngine !== engine;
  }
  // Update URI placeholder for the engine type.
  const uriInput = document.querySelector('#targetForm input[name="uri"]');
  if (uriInput) {
    uriInput.placeholder = engine === 'mongo'
      ? 'mongodb://user:pass@host:27017/db'
      : 'postgresql://user:pass@host:5432/db';
  }
  // Update installed default port hint.
  const portInput = $('installed_port');
  if (portInput && !portInput.value) {
    portInput.placeholder = engine === 'mongo' ? '27017' : '5432';
  }
}

async function onTargetSubmit(e) {
  e.preventDefault();
  const f = e.target.elements;
  const kind = f.kind.value;
  const input = {
    name: f.name.value.trim(),
    envTag: f.envTag.value,
    engine: f.engine.value,
    kind,
    dbName: f.dbName.value.trim(),
  };
  if (kind === 'docker-compose-vps') {
    if (!f.serverId.value) {
      const err = $('targetFormError');
      err.textContent = 'Add a server first.';
      err.hidden = false;
      return;
    }
    input.serverId = f.serverId.value;
    input.vps = {
      composeProjectPath: f.vps_composeProjectPath.value.trim() || null,
      service: f.vps_service.value.trim(),
      pgUser: f.vps_pgUser.value.trim() || null,
      compressionLevel: f.vps_compressionLevel.value === '' ? null : Number(f.vps_compressionLevel.value),
      mongoUser: f.vps_mongoUser.value.trim() || null,
      mongoPassword: f.vps_mongoPassword.value || null,
      mongoAuthDb: f.vps_mongoAuthDb.value.trim() || 'admin',
    };
  } else if (kind === 'installed') {
    const srvId = $('installedServerPicker').value;
    input.serverId = srvId || null;
    input.installed = {
      host: f.installed_host.value.trim() || 'localhost',
      port: f.installed_port.value.trim() || null,
      dbUser: f.installed_dbUser.value.trim() || null,
      dbPassword: f.installed_dbPassword.value || null,
      mongoAuthDb: f.installed_mongoAuthDb.value.trim() || 'admin',
    };
  } else {
    input.uri = f.uri.value;
  }
  try {
    let rec;
    if (editingTargetId) rec = await window.dbm.targets.update(editingTargetId, input);
    else rec = await window.dbm.targets.create(input);
    state.selectedTargetId = rec.id;
    closeTargetModal();
    await refreshAll();
  } catch (err) {
    const errEl = $('targetFormError');
    errEl.textContent = err.message || String(err);
    errEl.hidden = false;
  }
}

// ---------- compose project / service pickers (Target modal) ----------

function hideComposePickers() {
  $('composeProjectPickerWrap').hidden = true;
  $('composeServicePickerWrap').hidden = true;
  $('composeLoadFromServer').hidden = true;
  $('composePickerStatus').hidden = true;
}

function showComposeStatus(text) {
  $('composePickerStatus').hidden = false;
  $('composePickerStatusText').textContent = text;
}

function onTargetServerChange() {
  // If the user picked a server different from the one originally saved on
  // the target being edited, the previously-saved compose project path and
  // service belong to the old server and would show up as a misleading
  // "(current)" option. Clear them so the new server's project list drives
  // the selection.
  const form = $('targetForm');
  const newServerId = form.elements.serverId.value;
  const original = editingTargetId
    ? state.targets.find((t) => t.id === editingTargetId)
    : null;
  const originalServerId = original ? original.serverId : null;
  if (editingTargetId && newServerId !== originalServerId) {
    form.elements.vps_composeProjectPath.value = '';
    form.elements.vps_service.value = '';
  }
  refreshComposePickers();
}

async function refreshComposePickers(opts = {}) {
  const form = $('targetForm');
  const kind = form.elements.kind.value;
  if (kind !== 'docker-compose-vps') return hideComposePickers();
  const serverId = form.elements.serverId.value;
  if (!serverId) return hideComposePickers();
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return hideComposePickers();

  updateComposeHints(server);
  hideComposePickers();

  // For local servers there's no passphrase to cache or prompt for — go
  // straight to listProjects on every modal open. For SSH servers we keep the
  // existing "wait for the user to click Load" gate so we don't trigger a
  // passphrase prompt the moment they open the modal.
  const isLocal = server.kind === 'local';
  if (!isLocal && !state.connections[serverId] && !opts.force) {
    $('composeLoadFromServer').hidden = false;
    return;
  }

  showComposeStatus('Listing compose projects on ' + server.name + '…');

  if (!isLocal) {
    const ok = await ensureConnected(serverId);
    if (!ok) { hideComposePickers(); return; }
  }

  const res = await window.dbm.compose.listProjects(serverId, '');
  if (!res.ok) {
    hideComposePickers();
    $('composeLoadFromServer').hidden = false;
    showComposeStatus('Could not list projects: ' + res.error + '. Type the path manually below.');
    return;
  }

  state.connections[serverId] = true;
  state.composeProjectsByServer[serverId] = { projects: res.projects, composeBin: res.composeBin, composeVersion: res.composeVersion };

  renderServerTree(); // refresh status dot

  populateComposePickers(server, res.projects);
}

function populateComposePickers(server, projects) {
  $('composePickerStatus').hidden = true;
  $('composeLoadFromServer').hidden = true;

  const select = $('composeProjectSelect');
  const currentPath = $('targetForm').elements.vps_composeProjectPath.value;

  // Build options. Tag each option with its project metadata via a JSON blob in
  // a `data-` attribute; reading from the option keeps state local to the DOM.
  const opts = [];
  if (!projects.length) {
    opts.push('<option value="" disabled selected>No running compose projects found</option>');
  } else {
    opts.push('<option value="">— pick a project —</option>');
    let matchedExisting = false;
    for (const p of projects) {
      const isCurrent = p.path && p.path === currentPath;
      if (isCurrent) matchedExisting = true;
      opts.push(
        '<option value="' + escapeHtml(p.name) + '"' +
        ' data-path="' + escapeHtml(p.path || '') + '"' +
        ' data-services="' + escapeHtml(JSON.stringify(p.services || [])) + '"' +
        (isCurrent ? ' selected' : '') +
        '>' + escapeHtml(p.name) + (p.path ? ' — ' + escapeHtml(p.path) : '') + '</option>'
      );
    }
    // If the existing path doesn't match any listed project, add it as a
    // "current value" option so the user doesn't lose it on save.
    if (currentPath && !matchedExisting) {
      opts.push('<option value="__current__" data-path="' + escapeHtml(currentPath) + '" selected>(current) ' + escapeHtml(currentPath) + '</option>');
    }
  }
  select.innerHTML = opts.join('');

  $('composeProjectPickerWrap').hidden = false;
  $('composePickerSource').textContent = server.name;

  // If a project is pre-selected, populate the service picker now.
  if (select.selectedOptions[0] && select.selectedOptions[0].dataset.services) {
    populateComposeServicePicker(select.selectedOptions[0]);
  } else {
    $('composeServicePickerWrap').hidden = true;
  }
}

function onComposeProjectChange(e) {
  const opt = e.target.selectedOptions[0];
  if (!opt || !opt.value) return;
  const path = opt.dataset.path || '';
  $('targetForm').elements.vps_composeProjectPath.value = path;
  populateComposeServicePicker(opt);
}

function populateComposeServicePicker(opt) {
  let services = [];
  try { services = JSON.parse(opt.dataset.services || '[]'); } catch { /* ignore */ }
  const wrap = $('composeServicePickerWrap');
  const select = $('composeServiceSelect');
  if (!services.length) { wrap.hidden = true; return; }

  const currentService = $('targetForm').elements.vps_service.value;
  const opts = ['<option value="">— pick a service —</option>'];
  let matched = false;
  for (const s of services) {
    const flag = s.isPostgres ? ' [postgres]' : s.isMongo ? ' [mongo]' : '';
    const isCurrent = s.name === currentService;
    if (isCurrent) matched = true;
    opts.push(
      '<option value="' + escapeHtml(s.name) + '"' + (isCurrent ? ' selected' : '') + '>' +
        escapeHtml(s.name) + (s.image ? ' — ' + escapeHtml(s.image) : '') + flag +
      '</option>'
    );
  }
  if (currentService && !matched) {
    opts.push('<option value="' + escapeHtml(currentService) + '" selected>(current) ' + escapeHtml(currentService) + '</option>');
  }
  select.innerHTML = opts.join('');
  wrap.hidden = false;

  // Auto-fill the service input if there's exactly one matching service for
  // the selected engine (postgres or mongo).
  if (!currentService) {
    const engine = $('targetForm').elements.engine.value || 'postgres';
    const matching = engine === 'mongo'
      ? services.filter((s) => s.isMongo)
      : services.filter((s) => s.isPostgres);
    if (matching.length === 1) {
      select.value = matching[0].name;
      $('targetForm').elements.vps_service.value = matching[0].name;
    }
  }
}

function onComposeServiceChange(e) {
  $('targetForm').elements.vps_service.value = e.target.value;
}

// ---------- delete target ----------

async function onDeleteTarget() {
  const t = selectedTarget(); if (!t) return;
  if (!confirm('Delete target "' + t.name + '"? Existing dumps stay on disk.')) return;
  await window.dbm.targets.remove(t.id);
  state.selectedTargetId = null;
  await refreshAll();
}

// ---------- View DB ----------

const vdb = {
  targetId: null, engine: 'postgres', passphrase: null,
  schema: null, table: null, collection: null,
  page: 0, hasMore: false,
};

async function onViewDb() {
  const t = selectedTarget(); if (!t) return;
  const server = selectedServer();

  let pass;
  if (server && server.kind === 'ssh' && server.privateKeyPath) {
    pass = await askPassphrase(server.name);
    if (pass === null) return;
  }

  vdb.targetId = t.id;
  vdb.engine = t.engine || 'postgres';
  vdb.passphrase = pass || null;
  vdb.schema = null; vdb.table = null; vdb.collection = null;
  vdb.page = 0; vdb.hasMore = false;

  const isMongo = vdb.engine === 'mongo';
  $('viewDbTitle').textContent = 'View DB — ' + escapeHtml(t.dbName);
  $('viewDbSidebarHead').textContent = isMongo ? 'Collections' : 'Tables';
  $('viewDbTableList').innerHTML = '';
  $('viewDbLoading').hidden = false;
  $('viewDbError').hidden = true;
  $('viewDbEmpty').hidden = false;
  $('viewDbDataWrap').hidden = true;
  $('viewDbDocWrap').hidden = true;
  $('viewDbDataLoading').hidden = true;
  $('viewDbDataError').hidden = true;
  $('viewDbModal').hidden = false;

  if (isMongo) {
    const res = await window.dbm.db.listCollections(t.id, pass || undefined);
    $('viewDbLoading').hidden = true;
    if (!res.ok) {
      $('viewDbError').textContent = res.error || 'Failed to list collections.';
      $('viewDbError').hidden = false;
      return;
    }
    renderViewDbCollectionList(res.collections || []);
  } else {
    const res = await window.dbm.db.listTables(t.id, pass || undefined);
    $('viewDbLoading').hidden = true;
    if (!res.ok) {
      $('viewDbError').textContent = res.error || 'Failed to list tables.';
      $('viewDbError').hidden = false;
      return;
    }
    renderViewDbTableList(res.tables || []);
  }
}

// --- PostgreSQL table list ---

function renderViewDbTableList(tables) {
  const ul = $('viewDbTableList');
  $('viewDbEmpty').textContent = 'Select a table to view its data.';
  if (!tables.length) {
    ul.innerHTML = '<li style="pointer-events:none;color:var(--text-faint)">No tables found.</li>';
    return;
  }
  ul.innerHTML = tables.map((tbl) =>
    '<li data-schema="' + escapeHtml(tbl.schema) + '" data-table="' + escapeHtml(tbl.table) + '">' +
      '<span class="viewdb__tbl-schema">' + escapeHtml(tbl.schema) + '.</span>' +
      escapeHtml(tbl.table) +
      '<span class="viewdb__tbl-rows">' + (tbl.approxRows >= 0 ? tbl.approxRows.toLocaleString() : '') + '</span>' +
    '</li>'
  ).join('');
  ul.onclick = (e) => {
    const li = e.target.closest('li[data-table]');
    if (!li) return;
    ul.querySelectorAll('li').forEach((el) => el.classList.remove('is-active'));
    li.classList.add('is-active');
    selectViewDbTable(li.dataset.schema, li.dataset.table);
  };
}

async function selectViewDbTable(schema, table) {
  vdb.schema = schema; vdb.table = table; vdb.page = 0;
  await fetchViewDbPage();
}

async function fetchViewDbPage() {
  $('viewDbEmpty').hidden = true;
  $('viewDbDataWrap').hidden = true;
  $('viewDbDataLoading').hidden = false;
  $('viewDbDataError').hidden = true;

  const res = await window.dbm.db.queryTable(
    vdb.targetId, vdb.schema, vdb.table, vdb.page * 50, vdb.passphrase || undefined
  );
  $('viewDbDataLoading').hidden = true;
  if (!res.ok) {
    $('viewDbDataError').textContent = res.error || 'Failed to fetch rows.';
    $('viewDbDataError').hidden = false;
    return;
  }
  renderViewDbGrid(res);
}

function renderViewDbGrid({ columns, rows, hasMore }) {
  vdb.hasMore = !!hasMore;
  $('viewDbHead').innerHTML =
    '<tr>' + (columns || []).map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>';
  $('viewDbBody').innerHTML = (rows || []).map((row) =>
    '<tr>' + row.map((cell) =>
      cell === null || cell === ''
        ? '<td class="is-null">NULL</td>'
        : '<td title="' + escapeHtml(cell) + '">' + escapeHtml(cell) + '</td>'
    ).join('') + '</tr>'
  ).join('');
  const pageNum = vdb.page + 1;
  $('viewDbPageLabel').textContent = rows.length === 0 ? 'No rows' : 'Page ' + pageNum;
  $('viewDbPrev').disabled = vdb.page === 0;
  $('viewDbNext').disabled = !hasMore;
  $('viewDbDataWrap').hidden = false;
}

// --- MongoDB collection list + document view ---

function renderViewDbCollectionList(collections) {
  const ul = $('viewDbTableList');
  $('viewDbEmpty').textContent = 'Select a collection to view its documents.';
  if (!collections.length) {
    ul.innerHTML = '<li style="pointer-events:none;color:var(--text-faint)">No collections found.</li>';
    return;
  }
  ul.innerHTML = collections.map((col) =>
    '<li data-collection="' + escapeHtml(col) + '">' + escapeHtml(col) + '</li>'
  ).join('');
  ul.onclick = (e) => {
    const li = e.target.closest('li[data-collection]');
    if (!li) return;
    ul.querySelectorAll('li').forEach((el) => el.classList.remove('is-active'));
    li.classList.add('is-active');
    selectViewDbCollection(li.dataset.collection);
  };
}

async function selectViewDbCollection(collection) {
  vdb.collection = collection; vdb.page = 0;
  await fetchViewDbDocPage();
}

async function fetchViewDbDocPage() {
  $('viewDbEmpty').hidden = true;
  $('viewDbDocWrap').hidden = true;
  $('viewDbDataLoading').hidden = false;
  $('viewDbDataError').hidden = true;

  const res = await window.dbm.db.queryCollection(
    vdb.targetId, vdb.collection, vdb.page * 50, vdb.passphrase || undefined
  );
  $('viewDbDataLoading').hidden = true;
  if (!res.ok) {
    $('viewDbDataError').textContent = res.error || 'Failed to fetch documents.';
    $('viewDbDataError').hidden = false;
    return;
  }
  renderViewDbDocs(res);
}

function renderViewDbDocs({ documents, hasMore }) {
  vdb.hasMore = !!hasMore;
  const list = $('viewDbDocList');
  if (!documents || !documents.length) {
    list.innerHTML = '<div class="viewdb__doc-empty">No documents.</div>';
    $('viewDbDocWrap').hidden = false;
    $('viewDbDocPrev').disabled = true;
    $('viewDbDocNext').disabled = true;
    $('viewDbDocPageLabel').textContent = 'Empty collection';
    return;
  }
  list.innerHTML = documents.map((doc) => {
    let pretty;
    try { pretty = JSON.stringify(doc, null, 2); }
    catch { pretty = String(doc); }
    return '<pre class="viewdb__doc">' + escapeHtml(pretty) + '</pre>';
  }).join('');
  $('viewDbDocPageLabel').textContent = 'Page ' + (vdb.page + 1);
  $('viewDbDocPrev').disabled = vdb.page === 0;
  $('viewDbDocNext').disabled = !hasMore;
  $('viewDbDocWrap').hidden = false;
}

function viewDbChangePage(delta) {
  const next = vdb.page + delta;
  if (next < 0) return;
  if (delta > 0 && !vdb.hasMore) return;
  vdb.page = next;
  if (vdb.engine === 'mongo') fetchViewDbDocPage();
  else fetchViewDbPage();
}

function closeViewDbModal() {
  $('viewDbModal').hidden = true;
  Object.assign(vdb, { targetId: null, engine: 'postgres', passphrase: null,
    schema: null, table: null, collection: null, page: 0, hasMore: false });
}

// ---------- passphrase modal ----------

let passResolver = null;
function askPassphrase(label) {
  $('passHint').textContent =
    'Enter the SSH key passphrase for "' + label + '". It is held in memory only and never written to disk.';
  $('passForm').reset();
  $('passModal').hidden = false;
  setTimeout(() => $('passForm').elements.passphrase.focus(), 0);
  return new Promise((res) => { passResolver = res; });
}
function closePassModal(val) {
  $('passModal').hidden = true;
  const r = passResolver; passResolver = null;
  if (r) r(val);
}

// ---------- backup ----------

const PHASE_LABELS = {
  queued:                'Queued — waiting for another backup on this server…',
  opening:               'Starting backup…',
  connecting:            'Opening SSH connection…',
  'ssh-connecting':      'Opening SSH connection…',
  'ssh:tcp-connecting':  'Reaching VPS (TCP)…',
  'ssh:handshake':       'Negotiating SSH (handshake)…',
  'ssh:host-key-check':  'Verifying host key…',
  'ssh:authenticated':   'Authenticated — preparing pg_dump…',
  authenticated:         'Authenticated — preparing pg_dump…',
  'starting-dump':       'Running pg_dump inside container…',
  'starting-restore':    'Starting pg_restore…',
  waiting:               'Waiting for pg_dump to produce data…',
  streaming:             'Streaming dump…',
  stalled:               'Stalled — no data from pg_dump',
  finalizing:            'Finalizing — pg_restore processing data…',
  done:                  'Completed',
  error:                 'Failed',
  cancelled:             'Cancelled',
};

const CONNECT_PHASES = new Set([
  'opening', 'connecting', 'ssh-connecting',
  'ssh:tcp-connecting', 'ssh:handshake', 'ssh:host-key-check',
  'finalizing',
]);

async function onBackupNow() {
  const t = selectedTarget(); if (!t) return;
  const server = selectedServer();
  if (t.kind === 'docker-compose-vps' && !server) {
    showOpError('This target has no server attached. Edit the target to fix.');
    return;
  }
  // For external-uri targets we don't need a server at all — the backend runs
  // pg_dump locally.

  // Skip the pre-flight connection.test entirely. backup:start surfaces
  // NEED_PASSPHRASE if the cached/empty passphrase doesn't unlock the key, and
  // we prompt + retry here. That collapses what used to be two SSH handshakes
  // (test, then the real backup) into one in the happy path.
  startOpPanel(t, server);
  let res = await window.dbm.backup.start(t.id, '');
  if (!res.ok && res.code === 'NEED_PASSPHRASE') {
    const entered = await askPassphrase((server && server.name) || t.name);
    if (entered === null) {
      finishOp(false, null, 'Cancelled by user', 'cancelled');
      return;
    }
    // New op for the retry — clear the panel state so onBackupProgress accepts
    // the next opId.
    startOpPanel(t, server);
    res = await window.dbm.backup.start(t.id, entered);
    if (res.ok && server) state.connections[server.id] = true;
  } else if (res.ok && server) {
    state.connections[server.id] = true;
  }

  const b = state.activeBackup;
  if (!res.ok && b && !b.userCancelled && b.phase !== 'error' && b.phase !== 'cancelled') {
    showOpError(res.error);
  }
  renderServerTree();
  await refreshAll();
}

function priorDumpEstimate(targetId) {
  // Look at the largest prior dump for this target — most representative for the
  // upper-bound. (Backups usually grow slowly.) Returns ciphertext byte size.
  const matches = state.dumps.filter((d) => d.sourceProfileId === targetId && d.byteSize);
  if (!matches.length) return null;
  return matches.reduce((m, d) => Math.max(m, d.byteSize), 0);
}

function startOpPanel(target, server) {
  // Tear down any previous op state.
  if (state.activeBackup && state.activeBackup.tickInterval) {
    clearInterval(state.activeBackup.tickInterval);
  }
  state.activeBackup = {
    opId: null,
    targetId: target.id,
    serverId: server ? server.id : null,
    startedAt: Date.now(),
    bytes: 0,
    history: [],          // recent { t, b } samples for rate calc
    phase: 'connecting',
    estimate: priorDumpEstimate(target.id),
    tickInterval: setInterval(tickOpPanel, 500),
  };

  $('opPanel').hidden = false;
  $('opError').hidden = true;
  $('opCancelBtn').hidden = false;
  $('opDismissBtn').hidden = true;
  setBarIndeterminate(true);
  setBarClass(null);
  applyPhase('connecting');
  $('opBytes').textContent = '';
  $('opRate').textContent = '';
  $('opElapsed').textContent = '';
  $('opEta').textContent = '';
  $('opRateSep').hidden = true;
  $('opElapsedSep').hidden = true;
  $('opEtaSep').hidden = true;
}

function setBarIndeterminate(on) {
  const el = $('opBar');
  el.classList.toggle('op-panel__bar-inner--indeterminate', !!on);
  if (on) el.style.width = '';
}

function setBarClass(kind) {
  const el = $('opBar');
  el.classList.toggle('op-panel__bar-inner--done', kind === 'done');
  el.classList.toggle('op-panel__bar-inner--error', kind === 'error');
}

function applyPhase(phase) {
  $('opPhase').textContent = PHASE_LABELS[phase] || phase;
}

function onBackupProgress(ev) {
  if (!ev) return;
  const b = state.activeBackup;
  if (!b) return;
  if (!b.opId) b.opId = ev.opId;
  if (ev.opId !== b.opId) return;
  if (b.userCancelled) return;

  // Stall events change the label and bar style but don't end the operation.
  if (ev.phase === 'stalled') {
    b.stalled = true;
    applyPhase('stalled');
    $('opBar').classList.add('op-panel__bar-inner--stalled');
    return;
  }
  if (ev.phase === 'resumed') {
    b.stalled = false;
    applyPhase('streaming');
    $('opBar').classList.remove('op-panel__bar-inner--stalled');
    return;
  }

  // Phase transitions that don't carry bytes.
  if (ev.phase && ev.phase !== 'streaming') {
    b.phase = ev.phase;
    applyPhase(ev.phase);
    if (ev.phase === 'done') return finishOp(true, ev.meta);
    if (ev.phase === 'error') {
      finishOp(false, null, ev.error);
      showDockerSetupHelp(ev.code, ev.error);
      return;
    }
    if (ev.phase === 'cancelled') return finishOp(false, null, 'Cancelled', 'cancelled');
    return;
  }

  // Streaming.
  b.phase = 'streaming';
  applyPhase('streaming');
  if (typeof ev.bytes === 'number') {
    b.bytes = ev.bytes;
    b.lastByteAt = Date.now();
    b.history.push({ t: Date.now(), b: ev.bytes });
    // Keep last 10 seconds of samples.
    const cutoff = Date.now() - 10_000;
    while (b.history.length > 1 && b.history[0].t < cutoff) b.history.shift();
  }
  if (b.estimate) {
    const pct = Math.min(99, Math.round((b.bytes / b.estimate) * 100));
    setBarIndeterminate(false);
    $('opBar').style.width = pct + '%';
  } else {
    setBarIndeterminate(true);
  }
}

function tickOpPanel() {
  const b = state.activeBackup;
  if (!b) return;
  const elapsedMs = Date.now() - b.startedAt;
  $('opElapsedSep').hidden = false;
  $('opElapsed').textContent = formatDuration(elapsedMs);

  // Heartbeat: while we're in a connect sub-phase, append "(still working…)"
  // after 3s so the indeterminate bar isn't the only sign of life.
  if (CONNECT_PHASES.has(b.phase) && elapsedMs > 3_000) {
    const base = PHASE_LABELS[b.phase] || b.phase;
    $('opPhase').textContent = base + ' (' + formatDuration(elapsedMs) + ' elapsed)';
  }

  if (b.bytes > 0) {
    $('opBytes').textContent = formatBytes(b.bytes) + (b.estimate ? ' / ~' + formatBytes(b.estimate) : '');
  } else {
    $('opBytes').textContent = '';
  }

  // Rate over rolling window, but only if at least one sample is recent.
  // Otherwise we'd display a stale "55 KB/s" from a long-finished burst.
  const FRESH_MS = 5_000;
  const lastSampleAge = b.lastByteAt ? Date.now() - b.lastByteAt : Infinity;
  if (b.history.length >= 2 && lastSampleAge < FRESH_MS) {
    const first = b.history[0], last = b.history[b.history.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt > 0.25) {
      const rate = (last.b - first.b) / dt;
      $('opRateSep').hidden = false;
      $('opRate').textContent = formatBytes(rate) + '/s';
      if (b.estimate && b.bytes < b.estimate && rate > 0) {
        const remaining = b.estimate - b.bytes;
        const etaMs = (remaining / rate) * 1000;
        $('opEtaSep').hidden = false;
        $('opEta').textContent = 'ETA ' + formatDuration(etaMs);
      }
    }
  } else {
    // During finalizing pg_restore is processing — don't show "idle Xs" which looks like it's stuck.
    if (b.phase === 'finalizing') {
      $('opRate').textContent = 'pg_restore working…';
      $('opRateSep').hidden = false;
    } else {
      $('opRate').textContent = b.lastByteAt ? 'idle ' + formatDuration(lastSampleAge) : '';
      $('opRateSep').hidden = !b.lastByteAt;
    }
    $('opEta').textContent = '';
    $('opEtaSep').hidden = true;
  }
}

function finishOp(ok, meta, error, mode) {
  const b = state.activeBackup;
  if (b && b.tickInterval) { clearInterval(b.tickInterval); b.tickInterval = null; }
  $('opCancelBtn').hidden = true;
  $('opDismissBtn').hidden = false;
  setBarIndeterminate(false);
  if (ok) {
    setBarClass('done');
    $('opBar').style.width = '100%';
    applyPhase('done');
    if (meta && typeof meta.byteSize === 'number') {
      $('opBytes').textContent = formatBytes(meta.byteSize);
    }
  } else {
    setBarClass('error');
    $('opBar').style.width = '0';
    applyPhase(mode === 'cancelled' ? 'cancelled' : 'error');
    if (error) {
      const el = $('opError');
      el.textContent = error;
      el.hidden = false;
    }
  }
  if (b) b.phase = ok ? 'done' : (mode || 'error');
}

function dismissOpPanel() {
  if (state.activeBackup && state.activeBackup.tickInterval) {
    clearInterval(state.activeBackup.tickInterval);
  }
  state.activeBackup = null;
  $('opPanel').hidden = true;
}

function onCancelBackup() {
  const b = state.activeBackup; if (!b) return;
  // Fire-and-forget: the backend will tear down at its own pace (kill the
  // remote pg_dump, close the SSH channel, delete the partial file). We don't
  // block the UI on that — the user clicked Cancel and should see the result
  // immediately.
  if (b.opId) { try { window.dbm.backup.cancel(b.opId); } catch {} }
  b.userCancelled = true;
  finishOp(false, null, 'Cancelled by user', 'cancelled');
}

function showOpError(msg) {
  $('opPanel').hidden = false;
  $('opError').hidden = false;
  $('opError').textContent = msg || 'unknown error';
  $('opCancelBtn').hidden = true;
  $('opDismissBtn').hidden = false;
  setBarClass('error');
  setBarIndeterminate(false);
  $('opBar').style.width = '0';
  applyPhase('error');
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return m + 'm ' + (rem ? rem + 's' : '00s');
  const h = Math.floor(m / 60), rm = m % 60;
  return h + 'h ' + rm + 'm';
}

// ---------- discovery ----------

let activeDiscoveryServerId = null;
let lastDiscoveryResult = null;

async function startDiscovery(serverId) {
  const server = state.servers.find((s) => s.id === serverId); if (!server) return;
  activeDiscoveryServerId = serverId;
  lastDiscoveryResult = null;

  $('discoverServerName').textContent = server.name;
  $('discoverProgress').hidden = false;
  $('discoverResults').hidden = true;
  $('discoverError').hidden = true;
  $('discoverConfirm').disabled = true;
  $('discoverSelectedCount').textContent = '';
  $('discoverPhase').textContent = 'Connecting…';
  $('discoverBar').style.width = '15%';
  $('discoverModal').hidden = false;

  // Local servers don't need an SSH passphrase; skip ensureConnected.
  if (server.kind !== 'local') {
    const ok = await ensureConnected(serverId);
    if (!ok) { closeDiscoverModal(); return; }
  }

  const res = await window.dbm.discovery.run(serverId, '');
  if (!res.ok) {
    const err = $('discoverError');
    err.textContent = res.error || 'discovery failed';
    err.hidden = false;
    $('discoverPhase').textContent = 'Failed';
    $('discoverBar').style.width = '0';
    await showDockerSetupHelp(res.code, res.error);
    return;
  }
  lastDiscoveryResult = res.result;
  // Discovery success implies a working connection.
  state.connections[serverId] = true;

  // Mark already-tracked DBs.
  const existing = await window.dbm.targets.existingDbsForServer(serverId);
  const existingKey = new Set(existing.map((e) =>
    [e.composeProjectPath || '', e.projectName || '', e.service || '', e.dbName || ''].join('::')
  ));
  renderDiscoveryResults(res.result, existingKey);
}

function onDiscoveryProgress(ev) {
  if (!ev) return;
  const labels = {
    connecting: 'Connecting…',
    'probing-docker': 'Probing docker compose version…',
    'listing-projects': 'Listing compose projects…',
    'reading-project': 'Reading project: ' + (ev.message || ''),
    'reading-databases': 'Listing databases: ' + (ev.message || ''),
    done: 'Done',
  };
  $('discoverPhase').textContent = labels[ev.phase] || ev.phase;
  if (ev.phase !== 'done') {
    const cur = parseFloat($('discoverBar').style.width) || 15;
    $('discoverBar').style.width = Math.min(95, cur + 8) + '%';
  } else {
    $('discoverBar').style.width = '100%';
  }
}

function renderDiscoveryResults(result, existingKey) {
  $('discoverProgress').hidden = true;
  $('discoverResults').hidden = false;
  const body = $('discoverResults');

  if (!result.projects.length) {
    body.innerHTML = '<div class="empty"><p class="empty__text">No running compose projects with a Postgres service found.</p></div>';
    return;
  }

  const parts = [];
  parts.push('<div class="discover__meta mono">' + escapeHtml(result.composeBin) + ' · ' + escapeHtml(result.composeVersion || 'v?') + '</div>');

  for (const proj of result.projects) {
    parts.push('<div class="discover__project">' +
      '<div class="discover__project-head"><span class="discover__project-name">' + escapeHtml(proj.name) + '</span>' +
        (proj.composeFile ? '<span class="discover__path mono">' + escapeHtml(proj.composeFile) + '</span>' : '') +
      '</div>');
    if (proj.error) {
      parts.push('<div class="discover__error">' + escapeHtml(proj.error) + '</div>');
    } else if (!proj.services || !proj.services.length) {
      parts.push('<div class="discover__note">No Postgres service found.</div>');
    } else {
      for (const svc of proj.services) {
        parts.push('<div class="discover__service">' +
          '<div class="discover__service-head"><span class="mono">' + escapeHtml(svc.name) + '</span> · ' +
            '<span class="discover__image mono">' + escapeHtml(svc.image || '') + '</span> · ' +
            '<span class="discover__pguser mono">user: ' + escapeHtml(svc.pgUser) + '</span>' +
          '</div>');
        if (svc.error) {
          parts.push('<div class="discover__error">' + escapeHtml(svc.error) + '</div>');
        } else if (!svc.databases.length) {
          parts.push('<div class="discover__note">No user databases.</div>');
        } else {
          for (const db of svc.databases) {
            const key = [proj.composeProjectPath || '', proj.name || '', svc.name || '', db].join('::');
            const already = existingKey.has(key);
            parts.push(
              '<label class="discover__db' + (already ? ' discover__db--existing' : '') + '">' +
                '<input type="checkbox" ' + (already ? 'checked disabled ' : '') +
                  'data-project="' + escapeHtml(proj.name) +
                  '" data-path="' + escapeHtml(proj.composeProjectPath || '') +
                  '" data-service="' + escapeHtml(svc.name) +
                  '" data-pguser="' + escapeHtml(svc.pgUser) +
                  '" data-db="' + escapeHtml(db) + '" />' +
                '<span class="discover__db-name mono">' + escapeHtml(db) + '</span>' +
                (already ? '<span class="discover__db-flag">already tracked</span>' : '') +
              '</label>'
            );
          }
        }
        parts.push('</div>');
      }
    }
    parts.push('</div>');
  }

  body.innerHTML = parts.join('');

  for (const cb of body.querySelectorAll('input[type=checkbox]:not([disabled])')) {
    cb.addEventListener('change', updateDiscoverSelectionCount);
  }
  updateDiscoverSelectionCount();
}

function updateDiscoverSelectionCount() {
  const count = $('discoverResults').querySelectorAll('input[type=checkbox]:checked:not([disabled])').length;
  $('discoverSelectedCount').textContent = count ? count + ' selected' : '';
  $('discoverConfirm').disabled = count === 0;
}

async function onDiscoverConfirm() {
  if (!activeDiscoveryServerId) return;
  const inputs = [];
  for (const cb of $('discoverResults').querySelectorAll('input[type=checkbox]:checked:not([disabled])')) {
    inputs.push({
      name: cb.dataset.project + ' — ' + cb.dataset.db,
      envTag: 'prod', // sensible default; user can edit
      engine: 'postgres',
      kind: 'docker-compose-vps',
      dbName: cb.dataset.db,
      serverId: activeDiscoveryServerId,
      vps: {
        composeProjectPath: cb.dataset.path || null,
        projectName: cb.dataset.project || null,
        service: cb.dataset.service,
        pgUser: cb.dataset.pguser || null,
      },
    });
  }
  if (!inputs.length) return;
  try {
    await window.dbm.targets.createMany(inputs);
    closeDiscoverModal();
    await refreshAll();
  } catch (err) {
    const errEl = $('discoverError');
    errEl.textContent = err.message || String(err);
    errEl.hidden = false;
  }
}

function closeDiscoverModal() {
  $('discoverModal').hidden = true;
  activeDiscoveryServerId = null;
  lastDiscoveryResult = null;
}

// ---------- logs drawer ----------

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

function initLogsDrawer() {
  $('logsToggleBtn').addEventListener('click', toggleLogsDrawer);
  $('logsCloseBtn').addEventListener('click', () => setLogsDrawer(false));
  $('logsClearBtn').addEventListener('click', () => {
    state.logs = []; state.logErrorCount = 0; state.logsOpenIds.clear();
    renderLogs(); renderLogsBadge();
  });
  $('logsAutoscrollBtn').addEventListener('click', () => {
    state.logsAutoscroll = !state.logsAutoscroll;
    $('logsAutoscrollBtn').textContent = 'Autoscroll: ' + (state.logsAutoscroll ? 'on' : 'off');
  });
  $('logsSearch').addEventListener('input', (e) => {
    state.logSearch = e.target.value.trim().toLowerCase();
    renderLogs();
  });
  for (const chip of document.querySelectorAll('.logs-drawer__filters .chip')) {
    chip.addEventListener('click', () => {
      state.logFilter = chip.dataset.level;
      for (const c of document.querySelectorAll('.logs-drawer__filters .chip')) {
        c.classList.toggle('chip--active', c === chip);
      }
      renderLogs();
    });
  }
  $('logsBody').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    const id = row.dataset.id;
    if (state.logsOpenIds.has(id)) state.logsOpenIds.delete(id); else state.logsOpenIds.add(id);
    renderLogs();
  });
}

function toggleLogsDrawer() { setLogsDrawer(!state.logsDrawerOpen); }
function setLogsDrawer(open) {
  state.logsDrawerOpen = open;
  $('logsDrawer').hidden = !open;
  $('logsToggleBtn').classList.toggle('status-bar__btn--active', open);
  if (open) renderLogs();
}

function onLogEvent(entry) {
  if (!entry || !entry.id) return;
  state.logs.push(entry);
  if (state.logs.length > state.logsMax) state.logs = state.logs.slice(-state.logsMax);
  if (entry.level === 'error') state.logErrorCount += 1;
  renderLogsBadge();
  if (state.logsDrawerOpen) appendLogRow(entry);
}

function renderLogsBadge() {
  const total = state.logs.length;
  $('logsBadge').textContent = state.logErrorCount > 0 ? state.logErrorCount + '!' : String(total);
  $('logsBadge').classList.toggle('status-bar__badge--error', state.logErrorCount > 0);
}

function logRowHtml(e) {
  const open = state.logsOpenIds.has(e.id);
  const ts = formatLogTs(e.ts);
  const compName = escapeHtml(e.component || 'app');
  const detailsHtml = open && e.details
    ? '<div class="log-row__details">' + escapeHtml(JSON.stringify(e.details, null, 2)) + '</div>'
    : '';
  return (
    '<div class="log-row log-row--' + e.level + (open ? ' log-row--open' : '') + '" data-id="' + e.id + '">' +
      '<span class="log-row__ts">' + ts + '</span>' +
      '<span class="log-row__lvl log-row__lvl--' + e.level + '">' + e.level + '</span>' +
      '<span class="log-row__comp">' + compName + '</span>' +
      '<span class="log-row__msg">' + escapeHtml(e.message || '') + '</span>' +
      detailsHtml +
    '</div>'
  );
}

function rowPasses(e) {
  if (state.logFilter !== 'all') {
    // Show selected level + anything more severe.
    if (LEVEL_RANK[e.level] < LEVEL_RANK[state.logFilter]) return false;
  }
  if (state.logSearch) {
    const hay = (e.message + ' ' + e.component + ' ' + (e.details ? JSON.stringify(e.details) : '')).toLowerCase();
    if (!hay.includes(state.logSearch)) return false;
  }
  return true;
}

function renderLogs() {
  const body = $('logsBody');
  const visible = state.logs.filter(rowPasses);
  $('logsCount').textContent = visible.length + (visible.length === state.logs.length ? '' : ' / ' + state.logs.length);
  if (!visible.length) {
    body.innerHTML = '<div class="log-empty">No log entries match.</div>';
    return;
  }
  body.innerHTML = visible.map(logRowHtml).join('');
  if (state.logsAutoscroll) body.scrollTop = body.scrollHeight;
}

function appendLogRow(entry) {
  if (!rowPasses(entry)) return;
  const body = $('logsBody');
  if (body.querySelector('.log-empty')) body.innerHTML = '';
  body.insertAdjacentHTML('beforeend', logRowHtml(entry));
  if (state.logsAutoscroll) body.scrollTop = body.scrollHeight;
  // Keep DOM bounded.
  const rows = body.querySelectorAll('.log-row');
  if (rows.length > state.logsMax) rows[0].remove();
  const visibleCount = body.querySelectorAll('.log-row').length;
  $('logsCount').textContent = visibleCount + (visibleCount === state.logs.length ? '' : ' / ' + state.logs.length);
}

function formatLogTs(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function installRendererErrorCapture() {
  const send = (level, message, details) => {
    // Always push locally so the drawer sees it immediately…
    onLogEvent({
      id: 'r-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
      ts: new Date().toISOString(),
      level, component: 'renderer', message, details,
    });
    // …and forward to main so the file/log persists across reloads.
    try { window.dbm.logs.append({ level, component: 'renderer', message, details }); } catch {}
  };
  window.addEventListener('error', (ev) => {
    send('error', ev.message || 'window.onerror', {
      filename: ev.filename, lineno: ev.lineno, colno: ev.colno,
      stack: ev.error && ev.error.stack,
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason || {};
    send('error', 'Unhandled promise rejection: ' + (r.message || String(r)), {
      stack: r.stack,
    });
  });
}

// ---------- formatting ----------

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 10 ? 0 : 1) + ' ' + u[i];
}

function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ---------- settings modal ----------

async function openSettingsModal() {
  try {
    const res = await window.dbm.settings.get('dumpsDir');
    $('settingsDumpsDir').value = (res && res.dumpsDir) || state.dumpsDir || '';
  } catch { /* leave blank */ }
  $('settingsModal').hidden = false;
}

function closeSettingsModal() { $('settingsModal').hidden = true; }

async function onChangeDumpsDir() {
  // Count current dumps so we can ask whether to migrate.
  const existingCount = state.dumps.length;
  const currentDir = $('settingsDumpsDir').value || '';

  let doMigrate = false;
  if (existingCount > 0) {
    const ans = await window.dbm.dialog.confirm({
      title: 'Move existing dumps?',
      message: 'Move ' + existingCount + ' existing dump file' + (existingCount === 1 ? '' : 's') + ' to the new folder?',
      detail: 'From: ' + currentDir + '\n\nChoose "Move" to migrate the files. Choose "Keep" to leave them at the old path (they will no longer appear in the list).',
      confirmLabel: 'Move',
      cancelLabel: 'Keep at old path',
    });
    doMigrate = ans.ok;
  }

  const res = await window.dbm.settings.pickDumpsDir({ migrate: doMigrate });
  if (res.cancelled || !res.ok) return;
  state.dumpsDir = res.dumpsDir;
  $('settingsDumpsDir').value = res.dumpsDir;
  if (res.migrated && res.migrated.errors && res.migrated.errors.length) {
    flashStatus('Moved ' + res.migrated.moved.length + ' files, ' + res.migrated.errors.length + ' errors — see Logs');
  } else if (res.migrated) {
    flashStatus('Moved ' + res.migrated.moved.length + ' files to new folder');
  } else {
    flashStatus('Dumps folder set to ' + res.dumpsDir);
  }
  await refreshAll();
}

// ---------- dump list actions ----------

async function onDumpListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const li = btn.closest('li.dump-list__item');
  if (!li) return;
  const dumpPath = li.dataset.path;
  const action = btn.dataset.action;
  if (action === 'delete') return onDeleteDump(dumpPath);
  if (action === 'download') return onDownloadDump(dumpPath);
  if (action === 'restore') return openRestoreModal(dumpPath);
}

async function onDeleteDump(dumpPath) {
  const fname = dumpPath.split(/[\\/]/).pop();
  const ans = await window.dbm.dialog.confirm({
    title: 'Delete dump',
    message: 'Delete dump "' + fname + '"?',
    detail: 'This removes the encrypted dump file and its sidecar. This cannot be undone.',
    danger: true,
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
  });
  if (!ans.ok) return;
  const res = await window.dbm.dumps.remove(dumpPath);
  if (!res.ok) flashStatus('Delete failed: ' + (res.error || 'unknown'));
  else flashStatus('Deleted ' + fname);
  await refreshAll();
}

async function onDownloadDump(dumpPath) {
  const res = await window.dbm.dumps.download(dumpPath);
  if (res.cancelled) return;
  if (!res.ok) {
    flashStatus('Download failed: ' + (res.error || 'unknown'));
    return;
  }
  flashStatus('Saved decrypted dump to ' + res.outPath);
}

// ---------- restore modal ----------

let pendingRestoreDumpPath = null;

function _serverLabel(server, target) {
  if (!server) return '(local URI)';
  if (server.kind === 'local') {
    return server.wslDistro ? 'local · WSL: ' + server.wslDistro : 'local (Docker)';
  }
  return (server.user || '') + '@' + (server.host || '') + ':' + (server.port || 22);
}

function _targetOptionLabel(t) {
  const server = state.servers.find((s) => s.id === t.serverId) || null;
  return t.name + ' [' + t.envTag + '] — ' + t.dbName + ' (' + _serverLabel(server, t) + ')';
}

function openRestoreModal(dumpPath) {
  pendingRestoreDumpPath = dumpPath;
  const dump = state.dumps.find((d) => d.path === dumpPath);
  if (!dump) { flashStatus('Cannot restore: dump not found'); return; }

  // Dump info line
  const fname = dump.path.split(/[\\/]/).pop();
  $('restoreModalDumpInfo').textContent =
    fname + '\n' + formatTs(dump.createdAt) + ' · ' + formatBytes(dump.byteSize);

  // Build target picker filtered to only targets matching the dump's engine
  const dumpEngine = dump.engine || 'postgres';
  const compatTargets = state.targets.filter((t) => (t.engine || 'postgres') === dumpEngine);
  if (!compatTargets.length) {
    flashStatus('No ' + (dumpEngine === 'mongo' ? 'MongoDB' : 'PostgreSQL') + ' targets to restore into.');
    return;
  }

  const localTargets = compatTargets.filter((t) => {
    const s = state.servers.find((x) => x.id === t.serverId);
    return (s && s.kind === 'local') || t.kind === 'external-uri';
  });
  const vpsTargets = compatTargets.filter((t) => {
    const s = state.servers.find((x) => x.id === t.serverId);
    return s && s.kind === 'ssh';
  });

  const makeOption = (t) =>
    '<option value="' + escapeHtml(t.id) + '">' + escapeHtml(_targetOptionLabel(t)) + '</option>';
  const parts = [];
  if (localTargets.length) parts.push('<optgroup label="LOCAL">' + localTargets.map(makeOption).join('') + '</optgroup>');
  if (vpsTargets.length) parts.push('<optgroup label="VPS">' + vpsTargets.map(makeOption).join('') + '</optgroup>');
  $('restoreTargetPicker').innerHTML = parts.join('');

  // Pre-select: source dump's target, or current selected target
  const sourceId = dump.sourceProfileId;
  const preferred = compatTargets.find((t) => t.id === sourceId) ||
                    compatTargets.find((t) => t.id === state.selectedTargetId) ||
                    compatTargets[0];
  $('restoreTargetPicker').value = preferred.id;

  // Load the DB list for the pre-selected target; default to the dump's dbName
  const sourceDumpDbName = dump.dbName || preferred.dbName;
  _loadRestoreDatabases(preferred, sourceDumpDbName);

  $('restoreCleanFirst').checked = false;
  $('restoreModalError').hidden = true;
  $('restoreModal').hidden = false;
}

// Populate #restoreDbPicker for the given target, pre-selecting defaultDbName.
async function _loadRestoreDatabases(t, defaultDbName) {
  const dbPicker = $('restoreDbPicker');
  const dbHint = $('restoreDbHint');

  if (t.kind === 'external-uri' && (t.engine || 'postgres') !== 'mongo') {
    dbPicker.innerHTML = '<option value="' + escapeHtml(t.dbName) + '">' + escapeHtml(t.dbName) + ' (from URI)</option>';
    dbPicker.disabled = true;
    dbHint.textContent = 'Database is encoded in the URI and cannot be changed.';
    return;
  }
  dbPicker.disabled = false;
  dbPicker.innerHTML = '<option value="">Loading databases…</option>';
  dbHint.textContent = '';

  const res = await window.dbm.db.listDatabases(t.id);
  if (!res.ok) {
    dbPicker.innerHTML = '<option value="' + escapeHtml(t.dbName) + '">' + escapeHtml(t.dbName) + ' (default)</option>';
    dbHint.textContent = 'Could not load DB list: ' + res.error;
    return;
  }
  const dbs = res.databases || [];
  if (!dbs.length) {
    dbPicker.innerHTML = '<option value="' + escapeHtml(t.dbName) + '">' + escapeHtml(t.dbName) + '</option>';
    return;
  }
  dbPicker.innerHTML = dbs.map((db) =>
    '<option value="' + escapeHtml(db) + '"' + (db === t.dbName ? ' data-default="1"' : '') + '>' +
      escapeHtml(db) + (db === t.dbName ? ' ✓' : '') +
    '</option>'
  ).join('');
  // Select defaultDbName if it exists in the list, else fall back to target's dbName
  const toSelect = (defaultDbName && dbs.includes(defaultDbName)) ? defaultDbName
    : (dbs.includes(t.dbName) ? t.dbName : dbs[0]);
  dbPicker.value = toSelect;
  dbHint.textContent = toSelect === t.dbName
    ? 'Restoring into the same database as the original target.'
    : 'Restoring into a different database than the original target.';
}

function onRestoreTargetChange() {
  const id = $('restoreTargetPicker').value;
  const t = state.targets.find((x) => x.id === id);
  if (!t) return;
  _loadRestoreDatabases(t, '');
}

function onRestoreDbChange() {
  const targetId = $('restoreTargetPicker').value;
  const t = state.targets.find((x) => x.id === targetId);
  const selectedDb = $('restoreDbPicker').value;
  if (!t || !selectedDb) return;
  $('restoreDbHint').textContent = selectedDb === t.dbName
    ? 'Restoring into the same database as the original target.'
    : 'Restoring into a different database than the original target.';
}

function closeRestoreModal() {
  $('restoreModal').hidden = true;
  pendingRestoreDumpPath = null;
  $('restoreDbPicker').disabled = false;
}

async function onRestoreConfirm() {
  const dumpPath = pendingRestoreDumpPath;
  if (!dumpPath) return;

  const targetId = $('restoreTargetPicker').value;
  const t = state.targets.find((x) => x.id === targetId);
  if (!t) { closeRestoreModal(); return; }
  const server = state.servers.find((s) => s.id === t.serverId) || null;
  if (t.kind === 'docker-compose-vps' && !server) { closeRestoreModal(); return; }

  const dbNameOverride = $('restoreDbPicker').value || null;
  const cleanFirst = $('restoreCleanFirst').checked;
  closeRestoreModal();

  startOpPanel(t, server);
  let res = await window.dbm.restore.start(dumpPath, { targetId: t.id, cleanFirst, passphrase: '', dbNameOverride });
  if (!res.ok && res.code === 'NEED_PASSPHRASE') {
    const entered = await askPassphrase((server && server.name) || t.name);
    if (entered === null) {
      finishOp(false, null, 'Cancelled by user', 'cancelled');
      return;
    }
    startOpPanel(t, server);
    res = await window.dbm.restore.start(dumpPath, { targetId: t.id, cleanFirst, passphrase: entered, dbNameOverride });
    if (res.ok && server) state.connections[server.id] = true;
  } else if (res.ok && server) {
    state.connections[server.id] = true;
  }
  const b = state.activeBackup;
  if (!res.ok && b && !b.userCancelled && b.phase !== 'error' && b.phase !== 'cancelled') {
    showOpError(res.error);
  }
  renderServerTree();
  await refreshAll();
}

// ---------- auto-update banner ----------

function initUpdater() {
  if (!window.dbm || !window.dbm.updates) return;
  const banner = $('updateBanner');
  const text = $('updateBannerText');
  const bar = $('updateBannerBar');
  const barInner = $('updateBannerBarInner');
  const actions = $('updateBannerActions');
  if (!banner) return;

  function showDownloading(payload) {
    banner.hidden = false;
    banner.classList.remove('update-banner--error');
    const pct = payload && typeof payload.percent === 'number' ? Math.round(payload.percent) : 0;
    text.textContent = 'Downloading update… ' + pct + '%';
    bar.hidden = false;
    barInner.style.width = pct + '%';
    actions.hidden = true;
  }
  function showReady(version) {
    banner.hidden = false;
    banner.classList.remove('update-banner--error');
    text.textContent = 'Update ' + (version ? 'v' + version + ' ' : '') + 'ready to install.';
    bar.hidden = true;
    actions.hidden = false;
  }
  function showError(message) {
    banner.hidden = false;
    banner.classList.add('update-banner--error');
    text.textContent = 'Update failed: ' + message;
    bar.hidden = true;
    actions.hidden = true;
    setTimeout(() => {
      if (banner.classList.contains('update-banner--error')) banner.hidden = true;
    }, 10000);
  }
  function hide() { banner.hidden = true; }

  window.dbm.updates.on('checking', () => { /* silent */ });
  window.dbm.updates.on('available', (payload) => showDownloading({ percent: 0, ...(payload || {}) }));
  window.dbm.updates.on('progress', showDownloading);
  window.dbm.updates.on('ready', (payload) => showReady(payload && payload.version));
  window.dbm.updates.on('none', () => { /* nothing to do */ });
  window.dbm.updates.on('error', (payload) => showError(payload && payload.message || 'unknown error'));

  $('updateRestartBtn').addEventListener('click', () => { window.dbm.updates.installNow(); });
  $('updateDismissBtn').addEventListener('click', hide);
}

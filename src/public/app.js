// Ragearr web UI - plain JS, no build step, matching the rest of this
// project's stack (see CONTRIBUTING.md).

const state = {
  wantedLists: [],
  currentListId: null,
  allTracks: [],
  qualityProfiles: [],
  defaultQualityProfileId: 'balanced_1080p',
  expandedTrackId: null,
  expandedCandidates: [],
  manualImportTrackId: null,
  manualImportQuery: '',
  manualImportFiles: [],
  importListPreview: null,
  currentUser: null,
  authType: null,
  users: [],
};

const API_KEY_STORAGE = 'ragearrApiKey';
const SESSION_TOKEN_STORAGE = 'ragearrSessionToken';
let apiKeyRequest = null;

function authHeaders(body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const sessionToken = localStorage.getItem(SESSION_TOKEN_STORAGE);
  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
    return headers;
  }
  const apiKey = localStorage.getItem(API_KEY_STORAGE);
  if (apiKey) headers['X-Api-Key'] = apiKey;
  return headers;
}

function askForApiKey() {
  if (apiKeyRequest) return apiKeyRequest;
  const modal = document.getElementById('apiKeyModal');
  const form = document.getElementById('apiKeyForm');
  const usernameInput = document.getElementById('loginUsernameInput');
  const passwordInput = document.getElementById('loginPasswordInput');
  const input = document.getElementById('apiKeyInput');
  const cancelBtn = document.getElementById('apiKeyCancelBtn');
  const error = document.getElementById('apiKeyError');

  apiKeyRequest = new Promise((resolve) => {
    function cleanup(value) {
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      modal.hidden = true;
      apiKeyRequest = null;
      resolve(value);
    }
    function onSubmit(e) {
      e.preventDefault();
      const apiKey = input.value.trim();
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (apiKey) {
        localStorage.removeItem(SESSION_TOKEN_STORAGE);
        localStorage.setItem(API_KEY_STORAGE, apiKey);
        state.currentUser = { username: 'api-key', role: 'admin' };
        state.authType = 'api_key';
        renderCurrentUser();
        cleanup(apiKey);
        return;
      }
      if (!username || !password) {
        error.textContent = 'Username/password or API key is required.';
        error.hidden = false;
        return;
      }
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          localStorage.removeItem(API_KEY_STORAGE);
          localStorage.setItem(SESSION_TOKEN_STORAGE, data.token);
          state.currentUser = data.user;
          state.authType = 'session';
          renderCurrentUser();
          cleanup(data.token);
        })
        .catch((err) => {
          error.textContent = err.message;
          error.hidden = false;
        });
    }
    function onCancel() {
      cleanup(null);
    }

    error.hidden = true;
    error.textContent = '';
    usernameInput.value = '';
    passwordInput.value = '';
    input.value = '';
    modal.hidden = false;
    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    setTimeout(() => input.focus(), 0);
  });
  return apiKeyRequest;
}

async function api(path, method, body, retriedAuth) {
  const res = await fetch('/api' + path, {
    method: method || 'GET',
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no body */
  }
  if (res.status === 401 && !retriedAuth) {
    localStorage.removeItem(API_KEY_STORAGE);
    localStorage.removeItem(SESSION_TOKEN_STORAGE);
    if (await askForApiKey()) return api(path, method, body, true);
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function apiFetch(path, options = {}, retriedAuth) {
  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers: authHeaders(options.body),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && !retriedAuth) {
    localStorage.removeItem(API_KEY_STORAGE);
    localStorage.removeItem(SESSION_TOKEN_STORAGE);
    if (await askForApiKey()) return apiFetch(path, options, true);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch (e) {
      /* no body */
    }
    throw new Error(message);
  }
  return res;
}

function formatBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue; // skip null/undefined so e.g. disabled isn't set as "null"
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

// ------------------------------------------------------------- Sidebar ----

const VIEW_TITLES = { tracks: 'Tracks', concerts: 'Concerts', activity: 'Activity', settings: 'Settings' };

document.querySelectorAll('.sidebar-item').forEach((item) => {
  item.querySelector('a').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.sidebar-item').forEach((i) => i.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('view-' + item.dataset.view).classList.add('active');
    document.getElementById('pageTitle').textContent = VIEW_TITLES[item.dataset.view] || '';
  });
});

function renderCurrentUser() {
  const chip = document.getElementById('userChip');
  const label = document.getElementById('currentUserLabel');
  if (!state.currentUser) {
    chip.hidden = true;
    label.textContent = '';
    return;
  }
  chip.hidden = false;
  label.textContent = `${state.currentUser.username} (${state.currentUser.role})`;
}

async function loadAuthStatus() {
  const res = await fetch('/api/auth/status', { headers: authHeaders() });
  const status = await res.json();
  state.currentUser = status.user;
  state.authType = status.authType;
  renderCurrentUser();
  return status;
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    if (localStorage.getItem(SESSION_TOKEN_STORAGE)) await api('/auth/logout', 'POST');
  } catch (e) {
    /* logout is best effort */
  }
  localStorage.removeItem(SESSION_TOKEN_STORAGE);
  localStorage.removeItem(API_KEY_STORAGE);
  state.currentUser = null;
  state.authType = null;
  renderCurrentUser();
  await askForApiKey();
  location.reload();
});

// -------------------------------------------------------------- Tracks ----

async function loadWantedLists() {
  state.wantedLists = await api('/wanted-lists');
  const select = document.getElementById('wantedListSelect');
  select.innerHTML = '';
  select.appendChild(el('option', { value: '' }, document.createTextNode('All lists')));
  for (const l of state.wantedLists) {
    select.appendChild(el('option', { value: l.id }, document.createTextNode(`${l.name} (${l.source_type})`)));
  }
  if (state.currentListId) select.value = state.currentListId;
}

document.getElementById('wantedListSelect').addEventListener('change', (e) => {
  state.currentListId = e.target.value || null;
  loadTracks();
});

document.getElementById('newListBtn').addEventListener('click', async () => {
  const name = prompt('New wanted list name:');
  if (!name) return;
  const created = await api('/wanted-lists', 'POST', { name });
  await loadWantedLists();
  state.currentListId = String(created.id);
  document.getElementById('wantedListSelect').value = state.currentListId;
  loadTracks();
});

document.getElementById('addTrackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    wanted_list_id: state.currentListId || null,
    artist: form.artist.value.trim(),
    track_name: form.track_name.value.trim(),
    album: form.album.value.trim() || null,
    duration_sec: form.duration_sec.value ? parseFloat(form.duration_sec.value) : null,
    monitored: form.monitored.checked,
    quality_profile: form.quality_profile.value || state.defaultQualityProfileId,
  };
  await api('/tracks', 'POST', body);
  form.reset();
  form.monitored.checked = true;
  loadTracks();
});

function importListPayload() {
  const form = document.getElementById('importListForm');
  return {
    name: form.name.value.trim(),
    url: form.url.value.trim(),
    text: form.text.value,
  };
}

function renderImportListPreview(preview) {
  const summary = document.getElementById('importListSummary');
  const target = document.getElementById('importListPreview');
  const importBtn = document.getElementById('importListSubmitBtn');
  target.innerHTML = '';
  state.importListPreview = preview;
  const counts = preview.counts || {};
  const sourceLabel =
    preview.source_type === 'youtube_playlist' ? 'YouTube playlist: ' :
    preview.source_type === 'spotify_playlist' ? 'Spotify playlist: ' :
    preview.source_type === 'spotify_export' ? 'Spotify export: ' :
    '';
  summary.textContent = `${sourceLabel}${counts.importable || 0} importable, ${counts.duplicateExisting || 0} already tracked, ${counts.duplicateInImport || 0} duplicate in list.`;
  importBtn.disabled = !counts.importable;

  if (!preview.rows?.length) {
    target.appendChild(el('p', { class: 'hint', text: 'No valid rows found.' }));
    return;
  }
  const rows = preview.rows.slice(0, 80).map((row) =>
    el(
      'tr',
      { class: row.importable ? '' : 'muted-row' },
      el('td', { text: row.importable ? 'Import' : row.duplicateExisting ? 'Already tracked' : 'Duplicate' }),
      el('td', { text: row.artist }),
      el('td', { text: row.track_name }),
      el('td', { text: row.album || '' })
    )
  );
  target.appendChild(
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'arr-table import-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Result' }), el('th', { text: 'Artist' }), el('th', { text: 'Track' }), el('th', { text: 'Album' }))),
        el('tbody', {}, ...rows)
      )
    )
  );
}

document.getElementById('importListForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = importListPayload();
  if (!payload.url && !payload.text.trim()) {
    alert('Paste a list or enter a URL first.');
    return;
  }
  const btn = e.submitter || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Previewing...';
  try {
    renderImportListPreview(await api('/import-lists/preview', 'POST', payload));
  } catch (err) {
    alert('Preview failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Preview';
});

document.getElementById('importListSubmitBtn').addEventListener('click', async () => {
  const payload = importListPayload();
  if (!payload.name) {
    alert('List name is required.');
    return;
  }
  if (!state.importListPreview?.counts?.importable) {
    alert('Preview the list first.');
    return;
  }
  const btn = document.getElementById('importListSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Importing...';
  try {
    const result = await api('/import-lists/import', 'POST', payload);
    document.getElementById('importListSummary').textContent = `Imported ${result.imported}; skipped ${result.skipped}.`;
    state.currentListId = String(result.wanted_list_id);
    await loadWantedLists();
    document.getElementById('wantedListSelect').value = state.currentListId;
    await loadTracks();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Import';
});

function tierBadge(tier) {
  return el('span', { class: `tier tier-${tier || 'unknown'}`, text: tier || '?' });
}

function statusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function statusClass(status) {
  if (status === 'imported') return 'status-ok';
  if (status === 'downloading' || status === 'searching' || status === 'approved' || status === 'candidates_found') {
    return 'status-active';
  }
  if (status === 'no_match' || status === 'failed') return 'status-warn';
  return 'status-muted';
}

function qualityProfile(id) {
  return state.qualityProfiles.find((p) => p.id === id) || state.qualityProfiles.find((p) => p.id === state.defaultQualityProfileId) || null;
}

function profileName(id) {
  return qualityProfile(id)?.name || id || 'Default';
}

function renderTrackStats(filteredCount) {
  const total = state.allTracks.length;
  const have = state.allTracks.filter((t) => t.status === 'imported').length;
  const unmonitored = state.allTracks.filter((t) => !Number(t.monitored)).length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statMissing').textContent = total - have;
  document.getElementById('statHave').textContent = have;
  document.getElementById('statUnmonitored').textContent = unmonitored;
  document.getElementById('tracksResultCount').textContent = `${filteredCount} shown`;
}

function thumbnailImg(src, label, className) {
  if (!src) return el('div', { class: `${className} thumb-empty`, text: 'MV' });
  const img = el('img', { src, alt: label || '', loading: 'lazy' });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', { class: `${className} thumb-empty`, text: 'MV' }));
  });
  return el('div', { class: className }, img);
}

function candidateRow(track, c) {
  const selectBtn = el('button', {
    class: 'secondary',
    text: c.selected ? 'Selected' : 'Select',
    disabled: c.selected ? 'true' : null,
    onclick: async (e) => {
      e.stopPropagation();
      selectBtn.textContent = 'Selecting…';
      selectBtn.disabled = true;
      try {
        await api(`/candidates/${c.id}/select`, 'POST');
      } catch (err) {
        alert('Select failed: ' + err.message);
        selectBtn.textContent = 'Select';
        selectBtn.disabled = false;
        return;
      }
      // Selecting queues the actual download as a background job (see
      // jobQueue.js) instead of blocking this request for the real
      // download's full duration - polls the job here just to keep this
      // specific button's own text meaningful while it runs; the Activity
      // tab is the real place to watch it, and other tracks stay fully
      // usable in the meantime instead of the whole UI waiting on one file.
      let jobId;
      try {
        const result = await api(`/tracks/${track.id}/download`, 'POST');
        jobId = result.jobId;
      } catch (err) {
        alert('Download failed to start: ' + err.message);
        state.expandedCandidates = await api(`/tracks/${track.id}/candidates`);
        await loadTracks();
        return;
      }
      selectBtn.textContent = 'Queued…';
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        let job;
        try {
          job = await api(`/jobs/${jobId}`);
        } catch (err) {
          break; // job row vanished or request failed - stop polling, fall through to refresh
        }
        if (job.status === 'done') break;
        if (job.status === 'failed') {
          alert('Download failed: ' + (job.message || 'unknown error'));
          break;
        }
        selectBtn.textContent = job.message || (job.status === 'running' ? 'Downloading…' : 'Queued…');
      }
      state.expandedCandidates = await api(`/tracks/${track.id}/candidates`);
      await loadTracks();
    },
  });
  return el(
    'div',
    { class: 'candidate-row' },
    thumbnailImg(c.thumbnail_url, c.title, 'candidate-thumb'),
    tierBadge(c.tier),
    el('a', { href: c.url, target: '_blank', class: 'candidate-title', text: c.title, onclick: (e) => e.stopPropagation() }),
    el('span', { class: 'candidate-meta', text: c.origin || '' }),
    el('span', { class: 'candidate-meta', text: c.score != null ? String(c.score) : '' }),
    selectBtn
  );
}

async function toggleTrackCandidates(track) {
  if (state.expandedTrackId === track.id) {
    state.expandedTrackId = null;
    renderTracksGrid();
    return;
  }
  try {
    state.expandedCandidates = await api(`/tracks/${track.id}/candidates`);
  } catch (err) {
    alert('Failed to load candidates: ' + err.message);
    return;
  }
  state.expandedTrackId = track.id;
  renderTracksGrid();
}

function pathTail(pathValue) {
  if (!pathValue) return '';
  const parts = String(pathValue).split('/');
  return parts[parts.length - 1] || pathValue;
}

function formatRootFile(file) {
  return file.rootFolderName ? `${file.rootFolderName}/${file.filePath}` : file.filePath;
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

async function loadManualImportFiles(track, query) {
  state.manualImportTrackId = track.id;
  state.manualImportQuery = query || `${track.artist} ${track.track_name}`;
  state.manualImportFiles = await api(`/tracks/${track.id}/manual-import/files?q=${encodeURIComponent(state.manualImportQuery)}`);
  renderTracksGrid();
}

function manualImportPanel(track) {
  const result = state.manualImportFiles || {};
  const input = el('input', {
    type: 'search',
    value: state.manualImportQuery || '',
    placeholder: 'Search existing library files...',
    onkeydown: async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      await loadManualImportFiles(track, e.target.value.trim());
    },
  });
  const searchBtn = el('button', {
    class: 'secondary',
    text: 'Search',
    onclick: async () => loadManualImportFiles(track, input.value.trim()),
  });
  const closeBtn = el('button', {
    class: 'secondary',
    text: 'Close',
    onclick: () => {
      state.manualImportTrackId = null;
      state.manualImportFiles = [];
      renderTracksGrid();
    },
  });
  const rows = (result.files || []).map((file) => {
    const ext = file.filePath.includes('.') ? file.filePath.split('.').pop() : 'mkv';
    const safeArtist = sanitizeFilename(track.artist);
    const targetPath = `${safeArtist}/${safeArtist} - ${sanitizeFilename(track.track_name)}.${ext}`;
    const attachBtn = el('button', {
      class: 'secondary',
      text: 'Attach',
      onclick: async () => {
        if (!confirm(`Attach this existing file to "${track.artist} - ${track.track_name}"?\n\n${formatRootFile(file)}`)) return;
        attachBtn.disabled = true;
        attachBtn.textContent = 'Attaching...';
        try {
          await api(`/tracks/${track.id}/manual-import`, 'POST', { filePath: file.filePath, rootFolderId: file.rootFolderId });
          state.manualImportTrackId = null;
          state.manualImportFiles = [];
          await loadTracks();
        } catch (err) {
          alert('Manual import failed: ' + err.message);
          attachBtn.disabled = false;
          attachBtn.textContent = 'Attach';
        }
      },
    });
    const moveBtn = el('button', {
      class: 'secondary',
      text: 'Move & rename',
      onclick: async () => {
        if (!confirm(`Move and rename this file for "${track.artist} - ${track.track_name}"?\n\nFrom: ${formatRootFile(file)}\nTo: ${file.rootFolderName ? `${file.rootFolderName}/` : ''}${targetPath}`)) return;
        moveBtn.disabled = true;
        moveBtn.textContent = 'Moving...';
        try {
          await api(`/tracks/${track.id}/manual-import`, 'POST', { filePath: file.filePath, rootFolderId: file.rootFolderId, moveRename: true });
          state.manualImportTrackId = null;
          state.manualImportFiles = [];
          await loadTracks();
        } catch (err) {
          alert('Manual import failed: ' + err.message);
          moveBtn.disabled = false;
          moveBtn.textContent = 'Move & rename';
        }
      },
    });
    return el(
      'div',
      { class: 'manual-file-row' },
      el('div', { class: 'manual-file-main' }, el('div', { class: 'manual-file-name', text: file.filename }), el('div', { class: 'manual-file-path', text: formatRootFile(file) })),
      el('div', { class: 'manual-file-actions' }, attachBtn, moveBtn)
    );
  });
  return el(
    'div',
    { class: 'manual-import-panel' },
    el('div', { class: 'manual-import-toolbar row' }, input, searchBtn, closeBtn),
    rows.length ? el('div', { class: 'manual-file-list' }, ...rows) : el('p', { class: 'hint', text: 'No matching files found.' })
  );
}

function trackRow(t) {
  const expanded = state.expandedTrackId === t.id;

  const monitorBtn = el('button', {
    class: Number(t.monitored) ? 'icon-btn monitored' : 'icon-btn unmonitored',
    title: Number(t.monitored) ? 'Monitored' : 'Unmonitored',
    'aria-label': Number(t.monitored) ? 'Monitored' : 'Unmonitored',
    text: Number(t.monitored) ? '●' : '○',
    onclick: async () => {
      try {
        await api(`/tracks/${t.id}`, 'PATCH', { monitored: !Number(t.monitored) });
        await loadTracks();
      } catch (err) {
        alert('Monitor toggle failed: ' + err.message);
      }
    },
  });

  const searchBtn = el('button', {
    class: 'table-action',
    text: 'Search',
    onclick: async () => {
      searchBtn.textContent = 'Searching…';
      searchBtn.disabled = true;
      try {
        await api(`/tracks/${t.id}/search`, 'POST');
        if (expanded) state.expandedCandidates = await api(`/tracks/${t.id}/candidates`);
      } catch (err) {
        alert('Search failed: ' + err.message);
      }
      loadTracks();
    },
  });
  const viewBtn = el('button', {
    class: 'table-action',
    text: expanded ? 'Close' : 'Candidates',
    onclick: () => toggleTrackCandidates(t),
  });
  const importBtn = el('button', {
    class: 'table-action',
    text: state.manualImportTrackId === t.id ? 'Close import' : 'Import',
    onclick: async () => {
      if (state.manualImportTrackId === t.id) {
        state.manualImportTrackId = null;
        state.manualImportFiles = [];
        renderTracksGrid();
        return;
      }
      try {
        await loadManualImportFiles(t);
      } catch (err) {
        alert('Manual import search failed: ' + err.message);
      }
    },
  });
  const deleteBtn = el('button', {
    class: 'table-action danger',
    text: 'Delete',
    onclick: async () => {
      if (!confirm(`Delete "${t.artist} - ${t.track_name}" from Ragearr?`)) return;
      // Only ask about the file when one actually exists - nothing to
      // choose otherwise (e.g. a track that never found/downloaded a video).
      let deleteFile = true;
      if (t.matched_file_path) {
        deleteFile = confirm('Also delete the file from your library on disk? This cannot be undone.');
      }
      deleteBtn.textContent = 'Deleting…';
      deleteBtn.disabled = true;
      try {
        const result = await api(`/tracks/${t.id}`, 'DELETE', { deleteFile });
        if (result.warning) alert(result.warning);
      } catch (err) {
        alert('Delete failed: ' + err.message);
        deleteBtn.textContent = 'Delete';
        deleteBtn.disabled = false;
        return;
      }
      if (state.expandedTrackId === t.id) state.expandedTrackId = null;
      await loadTracks();
    },
  });

  const rows = [
    el(
      'tr',
      { class: expanded ? 'track-row expanded' : 'track-row' },
      el('td', { class: 'monitor-col' }, monitorBtn),
      el('td', { class: 'art-col' }, thumbnailImg(t.thumbnail_url, `${t.artist} - ${t.track_name}`, 'track-thumb')),
      el('td', { class: 'artist-col' }, el('span', { class: 'cell-title', title: t.artist, text: t.artist })),
      el('td', { class: 'title-col' }, el('span', { class: 'cell-title', title: t.track_name, text: t.track_name }), t.album ? el('span', { class: 'cell-subtitle', title: t.album, text: t.album }) : null),
      el('td', { class: 'status-col' }, el('span', { class: `status-chip ${statusClass(t.status)}`, text: statusLabel(t.status) })),
      el('td', { class: 'quality-col' }, el('span', { class: 'quality-chip', title: qualityProfile(t.quality_profile)?.description || '', text: profileName(t.quality_profile) })),
      el(
        'td',
        { class: 'file-col' },
        t.matched_file_path
          ? el('span', { class: 'path-chip', title: t.matched_file_path, text: pathTail(t.matched_file_path) })
          : el('span', { class: 'dim', text: 'Missing' })
      ),
      el('td', { class: 'actions-col row-actions' }, searchBtn, viewBtn, importBtn, deleteBtn)
    ),
  ];

  if (expanded) {
    const candidateRows = state.expandedCandidates.length
      ? state.expandedCandidates.map((c) => candidateRow(t, c))
      : [el('p', { class: 'hint', text: 'No candidates yet — try Search.' })];
    rows.push(
      el(
        'tr',
        { class: 'candidate-detail-row' },
        el('td', { colspan: '8' }, el('div', { class: 'candidates-expand' }, ...candidateRows))
      )
    );
  }
  if (state.manualImportTrackId === t.id) {
    rows.push(
      el(
        'tr',
        { class: 'candidate-detail-row' },
        el('td', { colspan: '8' }, manualImportPanel(t))
      )
    );
  }

  return rows;
}

function renderTracksGrid() {
  const filterText = document.getElementById('tracksFilterInput').value.trim().toLowerCase();
  const statusFilter = document.getElementById('tracksStatusFilter').value;
  const tbody = document.getElementById('tracksTableBody');
  const emptyHint = document.getElementById('tracksEmptyHint');
  tbody.innerHTML = '';

  const filtered = state.allTracks.filter((t) => {
    if (statusFilter === 'have' && t.status !== 'imported') return false;
    if (statusFilter === 'missing' && t.status === 'imported') return false;
    if (statusFilter === 'unmonitored' && Number(t.monitored)) return false;
    if (filterText) {
      const haystack = `${t.artist} ${t.track_name}`.toLowerCase();
      if (!haystack.includes(filterText)) return false;
    }
    return true;
  });

  renderTrackStats(filtered.length);
  for (const t of filtered) {
    for (const row of trackRow(t)) tbody.appendChild(row);
  }
  emptyHint.hidden = filtered.length > 0;
}

async function loadTracks() {
  const qs = state.currentListId ? `?wanted_list_id=${state.currentListId}` : '';
  state.allTracks = await api('/tracks' + qs);
  renderTracksGrid();
}

document.getElementById('tracksFilterInput').addEventListener('input', renderTracksGrid);
document.getElementById('tracksStatusFilter').addEventListener('change', renderTracksGrid);

// ------------------------------------------------------------ Concerts ----

document.getElementById('concertSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const artist = e.target.artist.value.trim();
  const warningEl = document.getElementById('concertSearchWarning');
  warningEl.hidden = true;
  const grid = document.getElementById('concertResultsGrid');
  grid.innerHTML = '';
  grid.appendChild(el('p', { class: 'hint', text: 'Searching…' }));
  try {
    const { results, warning } = await api('/concerts/search?artist=' + encodeURIComponent(artist));
    if (warning) {
      warningEl.textContent = warning;
      warningEl.hidden = false;
    }
    grid.innerHTML = '';
    if (results.length === 0) {
      grid.appendChild(el('p', { class: 'hint', text: 'No results.' }));
    }
    for (const r of results) {
      const grabBtn = el('button', {
        text: 'Grab',
        onclick: async (e2) => {
          e2.stopPropagation();
          grabBtn.textContent = 'Grabbing…';
          grabBtn.disabled = true;
          haveBtn.disabled = true;
          try {
            const result = await api('/concerts/grabs', 'POST', {
              artist,
              release_title: r.title,
              indexer_id: r.indexerId,
              indexer_name: r.indexer,
              guid: r.guid,
              download_url: r.downloadUrl,
              metadata: { size: r.size, seeders: r.seeders },
            });
            if (result.warning) alert(result.warning);
            loadGrabs();
          } catch (err) {
            alert('Grab failed: ' + err.message);
          }
          grabBtn.textContent = 'Grab';
          grabBtn.disabled = false;
          haveBtn.disabled = false;
        },
      });
      // For a release already sitting on the target system (grabbed some
      // other way before Ragearr existed, or manually) - records it in
      // Grabbed for tracking without touching rTorrent/downloading anything.
      const haveBtn = el('button', {
        text: 'Have it',
        class: 'secondary',
        onclick: async (e2) => {
          e2.stopPropagation();
          haveBtn.disabled = true;
          grabBtn.disabled = true;
          try {
            await api('/concerts/grabs', 'POST', {
              artist,
              release_title: r.title,
              indexer_id: r.indexerId,
              indexer_name: r.indexer,
              guid: r.guid,
              metadata: { size: r.size, seeders: r.seeders },
              already_owned: true,
            });
            loadGrabs();
          } catch (err) {
            alert('Failed to record: ' + err.message);
          }
          haveBtn.disabled = false;
          grabBtn.disabled = false;
        },
      });
      grid.appendChild(
        el(
          'div',
          { class: 'media-card' },
          el(
            'div',
            { class: 'thumb-wrap' },
            el('span', { class: 'thumb-placeholder', text: '🎤' })
          ),
          el(
            'div',
            { class: 'info' },
            el('div', { class: 'title', text: r.title }),
            el('div', { class: 'subtitle', text: `${r.indexer} · ${formatBytes(r.size)} · ${r.seeders} seeders` })
          ),
          el('div', { class: 'card-actions' }, grabBtn, haveBtn)
        )
      );
    }
  } catch (err) {
    grid.innerHTML = '';
    warningEl.textContent = err.message;
    warningEl.hidden = false;
  }
});

async function loadGrabs() {
  const grabs = await api('/concerts/grabs');
  const grid = document.getElementById('grabsGrid');
  grid.innerHTML = '';
  for (const g of grabs) {
    // Same as Tracks: 'imported' can mean Ragearr grabbed+found it itself,
    // or a library scan found it on disk - either way it's a real "have it".
    const have = g.status === 'imported';
    const badge = have
      ? el('span', { class: 'badge badge-have', title: g.matched_path || '', text: 'Have it' })
      : el('span', { class: 'badge badge-progress', text: g.status });
    grid.appendChild(
      el(
        'div',
        { class: 'media-card' },
        el(
          'div',
          { class: 'thumb-wrap' },
          el('span', { class: 'thumb-placeholder', text: '🎤' }),
          badge
        ),
        el(
          'div',
          { class: 'info' },
          el('div', { class: 'title', text: g.release_title }),
          el('div', { class: 'subtitle', text: `${g.artist} · ${new Date(g.created_at + 'Z').toLocaleDateString()}` })
        )
      )
    );
  }
}

document.getElementById('scanConcertsLibraryBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanConcertsLibraryBtn');
  const resultEl = document.getElementById('scanConcertsLibraryResult');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  resultEl.hidden = true;
  try {
    const result = await api('/library/scan-concerts', 'POST');
    resultEl.textContent = `Scanned ${result.entriesScanned} release(s) across ${result.rootsScanned || 1} root folder(s) — ${result.grabsMatched} already tracked, ${result.grabsAdded} newly added.`;
    resultEl.hidden = false;
    loadGrabs();
  } catch (err) {
    alert('Scan failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Scan library';
});

// ------------------------------------------------------------ Settings ----

function healthStatusLabel(status) {
  return status === 'ok' ? 'OK' : status === 'warn' ? 'Warning' : 'Fail';
}

function healthRow(item) {
  return el(
    'div',
    { class: `health-row health-${item.status}` },
    el('span', { class: 'health-dot', title: healthStatusLabel(item.status) }),
    el(
      'div',
      { class: 'health-copy' },
      el('div', { class: 'health-title', text: item.label }),
      el('div', { class: 'health-message', text: item.message || '' }),
      item.details ? el('div', { class: 'health-detail', text: item.details }) : null
    ),
    el('span', { class: 'health-state', text: healthStatusLabel(item.status) })
  );
}

async function loadSystemHealth() {
  const btn = document.getElementById('refreshHealthBtn');
  const summary = document.getElementById('healthSummary');
  const list = document.getElementById('healthList');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  summary.className = 'health-summary';
  summary.textContent = 'Checking system health...';
  list.innerHTML = '';
  try {
    const health = await api('/system/health');
    summary.classList.add(`health-${health.status}`);
    summary.textContent = `${health.counts.ok || 0} OK, ${health.counts.warn || 0} warning(s), ${health.counts.fail || 0} failure(s)`;
    for (const item of health.checks || []) list.appendChild(healthRow(item));
  } catch (err) {
    summary.classList.add('health-fail');
    summary.textContent = 'Health check failed: ' + err.message;
  }
  btn.disabled = false;
  btn.textContent = 'Refresh';
}

document.getElementById('refreshHealthBtn').addEventListener('click', loadSystemHealth);

function renderConnectionResult(containerId, status, message, details) {
  const node = document.getElementById(containerId);
  node.hidden = false;
  node.className = `connection-test connection-${status}`;
  node.innerHTML = '';
  node.appendChild(el('div', { class: 'connection-message', text: message }));
  if (details) node.appendChild(details);
}

async function runConnectionTest(buttonId, containerId, path, renderDetails) {
  const btn = document.getElementById(buttonId);
  btn.disabled = true;
  btn.textContent = 'Testing...';
  renderConnectionResult(containerId, 'warn', 'Testing connection...');
  try {
    const result = await api(path, 'POST');
    renderConnectionResult(containerId, 'ok', result.message || 'Connection OK.', renderDetails ? renderDetails(result) : null);
    await loadSystemHealth();
  } catch (err) {
    renderConnectionResult(containerId, 'fail', err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Test';
}

function prowlarrDetails(result) {
  const categories = result.musicVideoCategories || [];
  if (categories.length === 0) return el('div', { class: 'connection-detail', text: 'No music-video categories discovered.' });
  return el(
    'div',
    { class: 'connection-detail' },
    ...categories.map((c) =>
      el('div', { text: `${c.indexerName}: ${c.categoryName} (${c.categoryId})` })
    )
  );
}

function libraryDetails(result) {
  return el(
    'div',
    { class: 'connection-detail' },
    ...(result.paths || []).map((p) => el('div', { text: `${p.label}: ${p.status === 'ok' ? 'OK' : p.message}` }))
  );
}

function renderUsers() {
  const target = document.getElementById('usersList');
  target.innerHTML = '';
  if (!state.users.length) {
    target.textContent = 'No users configured yet. Use the API key to create the first admin user.';
    return;
  }
  for (const user of state.users) {
    const roleSelect = el(
      'select',
      {
        onchange: async (e) => {
          try {
            await api(`/users/${user.id}`, 'PATCH', { role: e.target.value });
            await loadUsers();
          } catch (err) {
            alert('User update failed: ' + err.message);
          }
        },
      },
      el('option', { value: 'user', text: 'User' }),
      el('option', { value: 'admin', text: 'Admin' })
    );
    roleSelect.value = user.role;

    const resetBtn = el('button', {
      class: 'secondary compact',
      text: 'Reset password',
      onclick: async () => {
        const password = prompt(`New password for ${user.username}:`);
        if (!password) return;
        try {
          await api(`/users/${user.id}`, 'PATCH', { password });
          alert('Password updated.');
        } catch (err) {
          alert('Password update failed: ' + err.message);
        }
      },
    });
    const deleteBtn = el('button', {
      class: 'secondary compact danger',
      text: 'Delete',
      onclick: async () => {
        if (!confirm(`Delete user ${user.username}?`)) return;
        try {
          await api(`/users/${user.id}`, 'DELETE');
          await loadUsers();
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      },
    });
    target.appendChild(
      el(
        'div',
        { class: 'user-row' },
        el('div', {}, el('strong', { text: user.username }), el('span', { class: 'muted-inline', text: user.last_login_at ? `Last login ${new Date(user.last_login_at + 'Z').toLocaleString()}` : 'Never logged in' })),
        roleSelect,
        resetBtn,
        deleteBtn
      )
    );
  }
}

async function loadUsers() {
  const form = document.getElementById('createUserForm');
  try {
    const result = await api('/users');
    state.users = result.users || [];
    form.hidden = false;
    renderUsers();
  } catch (err) {
    state.users = [];
    form.hidden = true;
    const target = document.getElementById('usersList');
    target.textContent = err.message === 'admin access required' ? 'Admin access is required to manage users.' : `Users unavailable: ${err.message}`;
  }
}

document.getElementById('createUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/users', 'POST', {
      username: form.username.value.trim(),
      password: form.password.value,
      role: form.role.value,
    });
    form.reset();
    await loadUsers();
  } catch (err) {
    alert('Create user failed: ' + err.message);
  }
});

document.getElementById('spotifySettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const current = await api('/settings/spotify');
  const body = {
    clientId: form.clientId.value.trim() || current.clientId,
    clientSecret: form.clientSecret.value.trim() || undefined,
  };
  if (!body.clientId || (!body.clientSecret && !current.configured)) {
    alert('Client ID and client secret are required the first time you configure Spotify.');
    return;
  }
  await api('/settings/spotify', 'PUT', body);
  form.clientSecret.value = '';
  await loadSpotifySettings();
});

document.getElementById('testSpotifyBtn').addEventListener('click', () => {
  runConnectionTest('testSpotifyBtn', 'spotifyTestResult', '/settings/spotify/test');
});

async function loadSpotifySettings() {
  const cfg = await api('/settings/spotify');
  const form = document.getElementById('spotifySettingsForm');
  if (cfg.clientId) form.clientId.value = cfg.clientId;
  document.getElementById('spotifyCurrentValue').textContent = cfg.configured
    ? `Configured for client ${cfg.clientId}.`
    : 'Not configured yet. Spotify playlist URLs need client credentials; CSV exports still work without them.';
}

document.getElementById('prowlarrSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const current = await api('/settings/prowlarr');
  const body = {
    baseUrl: form.baseUrl.value.trim() || current.baseUrl,
    apiKey: form.apiKey.value.trim() || undefined,
  };
  if (!body.apiKey) {
    alert('API key is required the first time you configure this.');
    return;
  }
  await api('/settings/prowlarr', 'PUT', body);
  form.apiKey.value = '';
  loadProwlarrSettings();
});

document.getElementById('testProwlarrBtn').addEventListener('click', () => {
  runConnectionTest('testProwlarrBtn', 'prowlarrTestResult', '/settings/prowlarr/test', prowlarrDetails);
});

async function loadProwlarrSettings() {
  const cfg = await api('/settings/prowlarr');
  const el2 = document.getElementById('prowlarrCurrentValue');
  if (cfg.baseUrl) {
    el2.textContent = `Current: ${cfg.baseUrl} (key: ${cfg.apiKey || 'not set'})`;
    document.querySelector('#prowlarrSettingsForm [name=baseUrl]').value = cfg.baseUrl;
  } else {
    el2.textContent = 'Not configured yet.';
  }
}

document.getElementById('notificationsSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/settings/notifications', 'PUT', {
    discordWebhookUrl: form.discordWebhookUrl.value.trim(),
    events: {
      onCandidateFound: form.onCandidateFound.checked,
      onNoMatch: form.onNoMatch.checked,
      onDownloadImported: form.onDownloadImported.checked,
      onDownloadFailed: form.onDownloadFailed.checked,
      onLibraryScan: form.onLibraryScan.checked,
    },
  });
  form.discordWebhookUrl.value = '';
  await loadNotificationSettings();
  alert('Saved.');
});

document.getElementById('testNotificationBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testNotificationBtn');
  btn.disabled = true;
  btn.textContent = 'Testing...';
  try {
    await api('/settings/notifications/test', 'POST');
    alert('Test notification sent.');
  } catch (err) {
    alert('Test failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Test';
});

async function loadNotificationSettings() {
  const cfg = await api('/settings/notifications');
  const form = document.getElementById('notificationsSettingsForm');
  const events = cfg.events || {};
  form.onCandidateFound.checked = events.onCandidateFound !== false;
  form.onNoMatch.checked = events.onNoMatch !== false;
  form.onDownloadImported.checked = events.onDownloadImported !== false;
  form.onDownloadFailed.checked = events.onDownloadFailed !== false;
  form.onLibraryScan.checked = events.onLibraryScan === true;
  document.getElementById('notificationsCurrentValue').textContent = cfg.configured
    ? `Discord configured: ${cfg.discordWebhookUrl}`
    : 'Discord is not configured yet.';
}

document.getElementById('downloadClientSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/settings/download-client', 'PUT', {
    type: form.type.value,
    host: form.host.value.trim(),
    user: form.user.value.trim(),
    sshKeyPath: form.sshKeyPath.value.trim(),
    socketPath: form.socketPath.value.trim(),
    baseUrl: form.baseUrl.value.trim(),
    username: form.username.value.trim(),
    password: form.password.value,
    category: form.category.value.trim(),
    savePath: form.savePath.value.trim(),
  });
  form.password.value = '';
  alert('Saved.');
});

document.getElementById('testDownloadClientBtn').addEventListener('click', () => {
  runConnectionTest('testDownloadClientBtn', 'downloadClientTestResult', '/settings/download-client/test');
});

function renderDownloadClientFields(type) {
  document.querySelectorAll('[data-client-fields]').forEach((group) => {
    group.hidden = group.dataset.clientFields !== type;
  });
}

document.getElementById('downloadClientTypeSelect').addEventListener('change', (e) => {
  renderDownloadClientFields(e.target.value);
});

async function loadDownloadClientSettings() {
  const cfg = await api('/settings/download-client');
  const form = document.getElementById('downloadClientSettingsForm');
  const select = document.getElementById('downloadClientTypeSelect');
  select.innerHTML = '';
  for (const type of cfg.supportedTypes || [{ id: 'rtorrent', name: 'rTorrent' }]) {
    select.appendChild(el('option', { value: type.id }, document.createTextNode(type.name)));
  }
  select.value = cfg.type || 'rtorrent';
  renderDownloadClientFields(select.value);
  form.host.value = cfg.host || '';
  form.user.value = cfg.user || '';
  form.sshKeyPath.value = cfg.sshKeyPath || '';
  form.socketPath.value = cfg.socketPath || '';
  form.baseUrl.value = cfg.baseUrl || '';
  form.username.value = cfg.username || '';
  form.password.value = '';
  form.password.placeholder = cfg.passwordConfigured ? 'Configured - leave blank to keep current' : 'Leave blank to keep current';
  form.category.value = cfg.category || '';
  form.savePath.value = cfg.savePath || '';
}

function fillQualitySelect(select, selectedId) {
  select.innerHTML = '';
  for (const profile of state.qualityProfiles) {
    select.appendChild(
      el(
        'option',
        { value: profile.id, title: profile.description },
        document.createTextNode(`${profile.name} (${profile.cutoff})`)
      )
    );
  }
  select.value = selectedId || state.defaultQualityProfileId;
}

async function loadQualitySettings() {
  const cfg = await api('/quality-profiles');
  state.qualityProfiles = cfg.profiles || [];
  state.defaultQualityProfileId = cfg.defaultProfileId || 'balanced_1080p';
  fillQualitySelect(document.getElementById('addTrackQualityProfile'), state.defaultQualityProfileId);
  fillQualitySelect(document.getElementById('defaultQualityProfileSelect'), state.defaultQualityProfileId);
  const current = qualityProfile(state.defaultQualityProfileId);
  document.getElementById('qualityCurrentValue').textContent = current
    ? `Current default: ${current.name} - ${current.description}`
    : 'No default quality profile configured.';
}

document.getElementById('qualitySettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/settings/quality', 'PUT', { defaultProfileId: form.defaultProfileId.value });
  await loadQualitySettings();
  alert('Saved.');
});

function listToText(values) {
  return (values || []).join('\n');
}

async function loadCandidateRulesSettings() {
  const cfg = await api('/settings/candidate-rules');
  const form = document.getElementById('candidateRulesForm');
  form.preferredPhrases.value = listToText(cfg.preferredPhrases);
  form.penalizedPhrases.value = listToText(cfg.penalizedPhrases);
  form.excludedPhrases.value = listToText(cfg.excludedPhrases);
  form.preferredScore.value = cfg.preferredScore;
  form.penaltyScore.value = cfg.penaltyScore;
  form.highTierScore.value = cfg.highTierScore;
  form.mediumTierScore.value = cfg.mediumTierScore;
  form.minFallbackViews.value = cfg.minFallbackViews;
  document.getElementById('candidateRulesCurrentValue').textContent =
    `High >= ${cfg.highTierScore}, medium >= ${cfg.mediumTierScore}, fallback views >= ${cfg.minFallbackViews}.`;
}

document.getElementById('candidateRulesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/settings/candidate-rules', 'PUT', {
    preferredPhrases: form.preferredPhrases.value,
    penalizedPhrases: form.penalizedPhrases.value,
    excludedPhrases: form.excludedPhrases.value,
    preferredScore: form.preferredScore.value,
    penaltyScore: form.penaltyScore.value,
    highTierScore: form.highTierScore.value,
    mediumTierScore: form.mediumTierScore.value,
    minFallbackViews: form.minFallbackViews.value,
  });
  await loadCandidateRulesSettings();
  alert('Saved.');
});

document.getElementById('librarySettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/settings/library', 'PUT', {
    musicVideoRootFolders: form.musicVideoRootFolders.value.trim(),
    concertRootFolders: form.concertRootFolders.value.trim(),
  });
  alert('Saved.');
  await loadLibrarySettings();
  await loadSystemHealth();
});

document.getElementById('testLibraryBtn').addEventListener('click', () => {
  runConnectionTest('testLibraryBtn', 'libraryTestResult', '/settings/library/test', libraryDetails);
});

async function loadLibrarySettings() {
  const cfg = await api('/settings/library');
  const form = document.getElementById('librarySettingsForm');
  form.musicVideoRootFolders.value = (cfg.musicVideoRootFolders || [])
    .map((root) => `${root.name} | ${root.path}`)
    .join('\n');
  form.concertRootFolders.value = (cfg.concertRootFolders || [])
    .map((root) => `${root.name} | ${root.path}`)
    .join('\n');
}

let selectedBackup = null;

function backupCountsText(counts) {
  const c = counts || {};
  return `${c.tracks || 0} tracks, ${c.wanted_lists || 0} wanted lists, ${c.candidates || 0} candidates, ${c.concert_grabs || 0} concert grabs, ${c.settings || 0} settings, ${c.jobs || 0} jobs`;
}

function backupSummaryDetails(summary) {
  return el(
    'div',
    { class: 'connection-detail' },
    el('div', { text: `Exported: ${summary.exportedAt ? new Date(summary.exportedAt).toLocaleString() : 'unknown'}` }),
    el('div', { text: backupCountsText(summary.counts) })
  );
}

document.getElementById('exportBackupBtn').addEventListener('click', async () => {
  const btn = document.getElementById('exportBackupBtn');
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    const res = await apiFetch('/backup/export');
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `ragearr-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    renderConnectionResult('backupSummary', 'ok', `Exported ${filename}`);
  } catch (err) {
    renderConnectionResult('backupSummary', 'fail', 'Export failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Export backup';
});

document.getElementById('restoreBackupFile').addEventListener('change', async (e) => {
  selectedBackup = null;
  document.getElementById('restoreBackupActions').hidden = true;
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    const preview = await api('/backup/preview', 'POST', { backup });
    selectedBackup = backup;
    renderConnectionResult('backupSummary', 'warn', `Selected ${file.name}`, backupSummaryDetails(preview.summary));
    document.getElementById('restoreBackupActions').hidden = false;
  } catch (err) {
    renderConnectionResult('backupSummary', 'fail', 'Backup preview failed: ' + err.message);
  }
});

document.getElementById('restoreBackupBtn').addEventListener('click', async () => {
  if (!selectedBackup) return;
  const typed = prompt('Type RESTORE to replace Ragearr data with the selected backup.');
  if (typed !== 'RESTORE') return;
  const btn = document.getElementById('restoreBackupBtn');
  btn.disabled = true;
  btn.textContent = 'Restoring...';
  try {
    const result = await api('/backup/restore', 'POST', { backup: selectedBackup, confirm: 'RESTORE' });
    renderConnectionResult('backupSummary', 'ok', 'Backup restored.', backupSummaryDetails(result.summary));
    selectedBackup = null;
    document.getElementById('restoreBackupActions').hidden = true;
    await loadWantedLists();
    await loadTracks();
    await loadGrabs();
    await loadJobs();
    await loadProwlarrSettings();
    await loadSpotifySettings();
    await loadNotificationSettings();
    await loadDownloadClientSettings();
    await loadCandidateRulesSettings();
    await loadLibrarySettings();
    await loadSystemHealth();
  } catch (err) {
    renderConnectionResult('backupSummary', 'fail', 'Restore failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Restore selected backup';
});

// -------------------------------------------------------- Library scan ----

document.getElementById('scanLibraryBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanLibraryBtn');
  const resultEl = document.getElementById('scanLibraryResult');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  resultEl.hidden = true;
  try {
    const result = await api('/library/scan-music-videos', 'POST');
    resultEl.textContent = `Scanned ${result.filesScanned} file(s) across ${result.rootsScanned || 1} root folder(s) — ${result.tracksMatched} already tracked, ${result.tracksAdded} newly added.`;
    resultEl.hidden = false;
    loadTracks();
  } catch (err) {
    alert('Scan failed: ' + err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Scan library';
});

// ------------------------------------------------------------- Activity ----

const JOB_STATUS_LABEL = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' };

function jobRow(job) {
  return el(
    'div',
    { class: 'job-row' },
    el('span', { class: `badge job-badge job-${job.status}`, text: JOB_STATUS_LABEL[job.status] || job.status }),
    el(
      'div',
      { class: 'job-info' },
      el('div', { class: 'title', text: job.label }),
      el('div', { class: 'feat-note', text: job.message || '' })
    ),
    el('span', { class: 'job-time', text: new Date(job.updated_at + 'Z').toLocaleTimeString() })
  );
}

async function loadJobs() {
  const jobs = await api('/jobs');
  const list = document.getElementById('activityList');
  const emptyHint = document.getElementById('activityEmptyHint');
  list.innerHTML = '';
  for (const j of jobs) list.appendChild(jobRow(j));
  emptyHint.hidden = jobs.length > 0;
}

// -------------------------------------------------------------- Init ----

(async function init() {
  await loadAuthStatus();
  await loadQualitySettings();
  await loadWantedLists();
  await loadTracks();
  await loadGrabs();
  await loadJobs();
  await loadProwlarrSettings();
  await loadSpotifySettings();
  await loadNotificationSettings();
  await loadDownloadClientSettings();
  await loadCandidateRulesSettings();
  await loadLibrarySettings();
  await loadUsers();
  await loadSystemHealth();

  setInterval(loadJobs, 3000);
})();

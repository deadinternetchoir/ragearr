// Ragearr web UI - plain JS, no build step, matching the rest of this
// project's stack (see CONTRIBUTING.md).

const state = {
  wantedLists: [],
  currentListId: null,
};

async function api(path, method, body) {
  const res = await fetch('/api' + path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no body */
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
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

// ---------------------------------------------------------------- Tabs ----

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
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
  };
  await api('/tracks', 'POST', body);
  form.reset();
  loadTracks();
});

function tierBadge(tier) {
  return el('span', { class: `tier tier-${tier || 'unknown'}`, text: tier || '?' });
}

async function loadTracks() {
  const qs = state.currentListId ? `?wanted_list_id=${state.currentListId}` : '';
  const tracks = await api('/tracks' + qs);
  const tbody = document.querySelector('#tracksTable tbody');
  tbody.innerHTML = '';
  for (const t of tracks) {
    const searchBtn = el('button', {
      class: 'secondary',
      text: 'Search',
      onclick: async () => {
        searchBtn.textContent = 'Searching…';
        searchBtn.disabled = true;
        try {
          await api(`/tracks/${t.id}/search`, 'POST');
        } catch (err) {
          alert('Search failed: ' + err.message);
        }
        loadTracks();
      },
    });
    const viewBtn = el('button', {
      class: 'secondary',
      text: 'View candidates',
      onclick: () => showCandidates(t),
    });
    tbody.appendChild(
      el(
        'tr',
        {},
        el('td', { text: t.artist }),
        el('td', { text: t.track_name }),
        el('td', {}, el('span', { class: 'status-pill', text: t.status })),
        el('td', { class: 'row' }, searchBtn, viewBtn)
      )
    );
  }
}

async function showCandidates(track) {
  const panel = document.getElementById('candidatesPanel');
  document.getElementById('candidatesTrackLabel').textContent = `${track.artist} - ${track.track_name}`;
  const candidates = await api(`/tracks/${track.id}/candidates`);
  const tbody = document.getElementById('candidatesTableBody');
  tbody.innerHTML = '';
  for (const c of candidates) {
    const selectBtn = el('button', {
      text: c.selected ? 'Selected' : 'Select',
      disabled: c.selected ? 'true' : null,
      onclick: async () => {
        await api(`/candidates/${c.id}/select`, 'POST');
        showCandidates(track);
        loadTracks();
      },
    });
    tbody.appendChild(
      el(
        'tr',
        {},
        el('td', {}, tierBadge(c.tier)),
        el('td', {}, el('a', { href: c.url, target: '_blank', text: c.title })),
        el('td', { text: c.origin || '' }),
        el('td', { text: c.score != null ? String(c.score) : '' }),
        el('td', {}, selectBtn)
      )
    );
  }
  panel.hidden = false;
}

document.getElementById('closeCandidatesBtn').addEventListener('click', () => {
  document.getElementById('candidatesPanel').hidden = true;
});

// ------------------------------------------------------------ Concerts ----

document.getElementById('concertSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const artist = e.target.artist.value.trim();
  const warningEl = document.getElementById('concertSearchWarning');
  warningEl.hidden = true;
  const tbody = document.querySelector('#concertResultsTable tbody');
  tbody.innerHTML = '<tr><td colspan="5">Searching…</td></tr>';
  try {
    const { results, warning } = await api('/concerts/search?artist=' + encodeURIComponent(artist));
    if (warning) {
      warningEl.textContent = warning;
      warningEl.hidden = false;
    }
    tbody.innerHTML = '';
    if (results.length === 0) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '5', text: 'No results.' })));
    }
    for (const r of results) {
      const grabBtn = el('button', {
        text: 'Grab',
        onclick: async () => {
          grabBtn.textContent = 'Grabbing…';
          grabBtn.disabled = true;
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
        },
      });
      tbody.appendChild(
        el(
          'tr',
          {},
          el('td', { text: r.title }),
          el('td', { text: r.indexer }),
          el('td', { text: formatBytes(r.size) }),
          el('td', { text: String(r.seeders) }),
          el('td', {}, grabBtn)
        )
      );
    }
  } catch (err) {
    tbody.innerHTML = '';
    warningEl.textContent = err.message;
    warningEl.hidden = false;
  }
});

async function loadGrabs() {
  const grabs = await api('/concerts/grabs');
  const tbody = document.querySelector('#grabsTable tbody');
  tbody.innerHTML = '';
  for (const g of grabs) {
    tbody.appendChild(
      el(
        'tr',
        {},
        el('td', { text: g.artist }),
        el('td', { text: g.release_title }),
        el('td', {}, el('span', { class: 'status-pill', text: g.status })),
        el('td', { text: new Date(g.created_at + 'Z').toLocaleString() })
      )
    );
  }
}

// ------------------------------------------------------------ Settings ----

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

document.getElementById('rtorrentSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/settings/rtorrent', 'PUT', {
    host: form.host.value.trim(),
    user: form.user.value.trim(),
    sshKeyPath: form.sshKeyPath.value.trim(),
    socketPath: form.socketPath.value.trim(),
  });
  alert('Saved.');
});

async function loadRtorrentSettings() {
  const cfg = await api('/settings/rtorrent');
  const form = document.getElementById('rtorrentSettingsForm');
  if (cfg.host) form.host.value = cfg.host;
  if (cfg.user) form.user.value = cfg.user;
  if (cfg.sshKeyPath) form.sshKeyPath.value = cfg.sshKeyPath;
  if (cfg.socketPath) form.socketPath.value = cfg.socketPath;
}

// -------------------------------------------------------------- Init ----

(async function init() {
  await loadWantedLists();
  await loadTracks();
  await loadGrabs();
  await loadProwlarrSettings();
  await loadRtorrentSettings();
})();

// Prowlarr integration — powers the "Concerts" feature (full concert/live-show
// acquisition), NOT per-track music video search. See docs/prowlarr-notes.md
// for why: indexer "Music Video" categories are populated with full concert
// films/live DVD rips, not individual song clips — searching a specific track
// there reliably returns nothing, while an artist-level search returns real,
// relevant concert releases.

const https = require('https');
const http = require('http');

function makeClient({ baseUrl, apiKey }) {
  const base = baseUrl.replace(/\/$/, '');
  const isHttps = base.startsWith('https://');
  const lib = isHttps ? https : http;

  function get(reqPath, params = {}) {
    return new Promise((resolve, reject) => {
      // `new URLSearchParams(x)` accepts a plain object OR another
      // URLSearchParams instance and preserves repeated keys either way
      // (needed for indexerIds/categories, which are repeatable params).
      const qs = new URLSearchParams(params);
      qs.set('apikey', apiKey);
      const url = `${base}${reqPath}?${qs.toString()}`;
      lib
        .get(url, { headers: { Accept: 'application/json' }, timeout: 20000 }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`Prowlarr HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error('Prowlarr returned invalid JSON: ' + body.slice(0, 200)));
            }
          });
        })
        .on('error', reject)
        .on('timeout', function () {
          this.destroy(new Error('timeout'));
        });
    });
  }

  /**
   * Find indexers with a genuine music-video-named category (not a
   * false-positive match on something like "XXX/WMV"), and that category's
   * id on each indexer. Cached per-client-instance for the process lifetime;
   * call refreshMusicVideoCategories() if indexers change.
   */
  let _mvCategoryCache = null;

  async function refreshMusicVideoCategories() {
    const indexers = await get('/api/v1/indexer');
    const result = []; // [{ indexerId, indexerName, categoryId, categoryName }]
    for (const idx of indexers) {
      if (!idx.enable) continue;
      const cats = (idx.capabilities && idx.capabilities.categories) || [];
      for (const c of cats) {
        if (/music.?video/i.test(c.name || '')) {
          result.push({ indexerId: idx.id, indexerName: idx.name, categoryId: c.id, categoryName: c.name });
        }
      }
    }
    _mvCategoryCache = result;
    return result;
  }

  async function getMusicVideoCategories() {
    if (!_mvCategoryCache) await refreshMusicVideoCategories();
    return _mvCategoryCache;
  }

  /**
   * Search for concert/live-show releases by artist name across whatever
   * indexers have a real music-video category configured. Returns raw
   * Prowlarr release objects — no per-track relevance filtering here, since
   * this is an artist-level browse, not a specific-item match.
   */
  async function searchConcerts(artistName) {
    const mvCats = await getMusicVideoCategories();
    if (mvCats.length === 0) {
      return { results: [], warning: 'No indexer with a music-video category is configured.' };
    }
    const params = new URLSearchParams();
    params.append('query', artistName);
    params.append('type', 'search');
    for (const c of mvCats) {
      params.append('indexerIds', String(c.indexerId));
      params.append('categories', String(c.categoryId));
    }
    const results = await get('/api/v1/search', params);
    return { results, warning: null };
  }

  return { get, getMusicVideoCategories, refreshMusicVideoCategories, searchConcerts };
}

module.exports = { makeClient };

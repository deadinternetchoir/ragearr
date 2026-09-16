const http = require('http');
const https = require('https');
const settings = require('./settings');

const DEFAULT_EVENTS = {
  onCandidateFound: true,
  onNoMatch: true,
  onDownloadImported: true,
  onDownloadFailed: true,
  onLibraryScan: false,
};

function getConfig() {
  const cfg = settings.get('notifications') || {};
  return {
    discordWebhookUrl: cfg.discordWebhookUrl || '',
    events: { ...DEFAULT_EVENTS, ...(cfg.events || {}) },
  };
}

function publicConfig() {
  const cfg = getConfig();
  return {
    configured: Boolean(cfg.discordWebhookUrl),
    discordWebhookUrl: maskWebhook(cfg.discordWebhookUrl),
    events: cfg.events,
  };
}

function saveConfig(input) {
  const current = getConfig();
  const next = {
    discordWebhookUrl:
      typeof input.discordWebhookUrl === 'string' && input.discordWebhookUrl.trim()
        ? input.discordWebhookUrl.trim()
        : current.discordWebhookUrl,
    events: normalizeEvents(input.events || input),
  };

  settings.set('notifications', next);
  return publicConfig();
}

function normalizeEvents(input) {
  const events = { ...DEFAULT_EVENTS };
  for (const key of Object.keys(DEFAULT_EVENTS)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) events[key] = Boolean(input[key]);
  }
  return events;
}

function maskWebhook(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const token = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return `${parsed.origin}${parsed.pathname.slice(0, Math.max(0, parsed.pathname.length - token.length))}${token.slice(0, 4)}...`;
  } catch {
    return 'configured';
  }
}

function trackLabel(track) {
  return `${track.artist} - ${track.track_name}`;
}

function eventPayload(eventName, payload = {}) {
  const track = payload.track;
  const titleByEvent = {
    onCandidateFound: 'Candidate found',
    onNoMatch: 'No match found',
    onDownloadImported: 'Download imported',
    onDownloadFailed: 'Download failed',
    onLibraryScan: 'Library scan complete',
    test: 'Ragearr test notification',
  };

  const fields = [];
  if (track) fields.push({ name: 'Track', value: trackLabel(track), inline: false });
  if (payload.candidate?.title) fields.push({ name: 'Candidate', value: payload.candidate.title, inline: false });
  if (payload.candidate?.url) fields.push({ name: 'URL', value: payload.candidate.url, inline: false });
  if (payload.error) fields.push({ name: 'Error', value: String(payload.error).slice(0, 1000), inline: false });
  if (payload.scan) {
    for (const [name, value] of Object.entries(payload.scan)) {
      fields.push({ name, value: String(value), inline: true });
    }
  }

  return {
    username: 'Ragearr',
    embeds: [
      {
        title: titleByEvent[eventName] || 'Ragearr notification',
        description: payload.message || '',
        color: eventName === 'onDownloadFailed' ? 0xd9534f : eventName === 'onNoMatch' ? 0xf0ad4e : 0x5cb85c,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function notify(eventName, payload) {
  const cfg = getConfig();
  if (!cfg.discordWebhookUrl) return { skipped: true, reason: 'not configured' };
  if (eventName !== 'test' && !cfg.events[eventName]) return { skipped: true, reason: 'event disabled' };
  await postJson(cfg.discordWebhookUrl, eventPayload(eventName, payload));
  return { ok: true };
}

function postJson(rawUrl, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      reject(new Error('invalid Discord webhook URL'));
      return;
    }

    const payload = Buffer.from(JSON.stringify(body));
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(new Error(`webhook returned HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('webhook timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function notifyAndLog(eventName, payload) {
  notify(eventName, payload).catch((err) => {
    console.warn(`[notifications] ${eventName} failed: ${err.message}`);
  });
}

module.exports = {
  getConfig,
  publicConfig,
  saveConfig,
  notify,
  notifyAndLog,
};

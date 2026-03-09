const summaryCards = document.getElementById('summaryCards');
const statusBars = document.getElementById('statusBars');
const dailyTrend = document.getElementById('dailyTrend');
const runsTbody = document.getElementById('runsTbody');
const controlResult = document.getElementById('controlResult');
const refreshBtn = document.getElementById('refreshBtn');
const autoRefresh = document.getElementById('autoRefresh');

const discoveryMode = document.getElementById('discoveryMode');
const topicInput = document.getElementById('topicInput');
const queryInput = document.getElementById('queryInput');
const tokenInput = document.getElementById('tokenInput');
const triggerBtn = document.getElementById('triggerBtn');
const retryBtn = document.getElementById('retryBtn');

let timer = null;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function card(label, value) {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}

function renderSummary(data) {
  const s = data.summary || {};
  summaryCards.innerHTML = [
    card('Total Runs', s.total_runs ?? 0),
    card('Published', s.published_runs ?? 0),
    card('Rejected', s.rejected_runs ?? 0),
    card('Failed', s.failed_runs ?? 0),
    card(`Runs (${data.window_hours || 24}h)`, s.recent_runs ?? 0),
    card('Publish Rate', `${s.publish_rate ?? 0}%`),
  ].join('');

  const breakdown = Array.isArray(data.status_breakdown) ? data.status_breakdown : [];
  const maxCount = Math.max(1, ...breakdown.map((x) => Number(x.count || 0)));
  statusBars.innerHTML = breakdown
    .map((x) => {
      const count = Number(x.count || 0);
      const width = Math.round((count / maxCount) * 100);
      return `
      <div class="status-row">
        <div>${esc(x.status)}</div>
        <div class="bar"><span style="width:${width}%"></span></div>
        <div>${count}</div>
      </div>`;
    })
    .join('');

  const trend = Array.isArray(data.daily_trend) ? data.daily_trend : [];
  const maxTrend = Math.max(1, ...trend.map((x) => Number(x.count || 0)));
  dailyTrend.innerHTML = trend
    .map((x) => {
      const count = Number(x.count || 0);
      const width = Math.round((count / maxTrend) * 100);
      return `
      <div class="day-row">
        <div>${esc(x.day)}</div>
        <div class="bar"><span style="width:${width}%"></span></div>
        <div>${count}</div>
      </div>`;
    })
    .join('');
}

function statusBadge(status) {
  const cls = `badge ${String(status || '').replaceAll(/[^a-z0-9_]/gi, '_')}`;
  return `<span class="${cls}">${esc(status || 'unknown')}</span>`;
}

function renderRuns(data) {
  const runs = Array.isArray(data.runs) ? data.runs : [];
  runsTbody.innerHTML = runs
    .map((run) => {
      const updated = run.updated_at ? new Date(run.updated_at).toLocaleString() : '';
      const devto = run.devto_url ? `<a href="${esc(run.devto_url)}" target="_blank" rel="noreferrer">link</a>` : '-';
      const medium = run.medium_url ? `<a href="${esc(run.medium_url)}" target="_blank" rel="noreferrer">link</a>` : '-';
      const score = Number.isFinite(Number(run.review_score)) ? Number(run.review_score) : 0;

      return `
      <tr>
        <td>${esc(updated)}</td>
        <td>${statusBadge(run.status)}</td>
        <td>${esc(run.topic)}</td>
        <td>${esc(score)}</td>
        <td>${devto}</td>
        <td>${medium}</td>
        <td><code>${esc(run.run_id)}</code></td>
      </tr>`;
    })
    .join('');
}

async function refreshAll() {
  try {
    const [summary, runs] = await Promise.all([
      getJson('/api/summary?hours=24&days=14'),
      getJson('/api/runs?limit=30'),
    ]);
    renderSummary(summary);
    renderRuns(runs);
  } catch (error) {
    controlResult.textContent = `Refresh failed: ${error.message}`;
  }
}

function readToken() {
  return tokenInput.value.trim();
}

async function runControl(url, payload) {
  const token = readToken();
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-control-token'] = token;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  controlResult.textContent = JSON.stringify(
    {
      status: response.status,
      ok: response.ok,
      data: parsed,
    },
    null,
    2,
  );

  await refreshAll();
}

triggerBtn.addEventListener('click', async () => {
  const mode = discoveryMode.value;
  const payload = {
    discovery_mode: mode,
    topic: topicInput.value.trim(),
    discovery_query: queryInput.value.trim(),
    requester: 'dashboard_user',
    source: 'dashboard',
  };
  await runControl('/api/control/trigger', payload);
});

retryBtn.addEventListener('click', async () => {
  await runControl('/api/control/retry-last-failed', {});
});

refreshBtn.addEventListener('click', refreshAll);

autoRefresh.addEventListener('change', () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (autoRefresh.checked) {
    timer = setInterval(refreshAll, 15000);
  }
});

refreshAll();
timer = setInterval(refreshAll, 15000);

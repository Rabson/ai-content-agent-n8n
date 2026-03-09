import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3012);
const CONTROL_TOKEN = (process.env.DASHBOARD_CONTROL_TOKEN || '').trim();
const N8N_WEBHOOK_URL = process.env.DASHBOARD_WEBHOOK_URL || 'http://n8n:5678/webhook/content-topic-intake';
const RECENT_RUN_LIMIT = Number(process.env.DASHBOARD_RECENT_RUN_LIMIT || 30);

const pool = new Pool({
  host: process.env.DB_POSTGRESDB_HOST || process.env.PGHOST || 'postgres',
  port: Number(process.env.DB_POSTGRESDB_PORT || process.env.PGPORT || 5432),
  database: process.env.DB_POSTGRESDB_DATABASE || process.env.PGDATABASE || 'n8n',
  user: process.env.DB_POSTGRESDB_USER || process.env.PGUSER || 'n8n',
  password: process.env.DB_POSTGRESDB_PASSWORD || process.env.PGPASSWORD || 'n8npass',
  max: 10,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function mapRunRow(row) {
  const state = row.state && typeof row.state === 'object' ? row.state : {};
  const publish = state.publish && typeof state.publish === 'object' ? state.publish : {};
  const review = state.review && typeof state.review === 'object' ? state.review : {};

  const devtoUrl = publish.devto && publish.devto.url ? publish.devto.url : null;
  const mediumUrl = publish.medium && publish.medium.url ? publish.medium.url : null;

  return {
    run_id: row.run_id,
    status: row.status,
    topic: row.topic,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    updated_at: row.updated_at,
    review_score: typeof review.score === 'number' ? review.score : Number(review.score || 0),
    devto_url: devtoUrl,
    medium_url: mediumUrl,
    state,
  };
}

function requireControlToken(req, res, next) {
  if (!CONTROL_TOKEN) {
    return next();
  }
  const token = (req.headers['x-control-token'] || '').toString().trim();
  if (token !== CONTROL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized control token' });
  }
  return next();
}

async function fetchJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'dashboard', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/summary', async (req, res) => {
  const hours = toInt(req.query.hours, 24);
  const days = toInt(req.query.days, 14);

  try {
    const summaryPromise = pool.query(
      `
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'published')::int AS published_runs,
        COUNT(*) FILTER (WHERE status IN ('topic_rejected', 'rejected_input', 'no_topic_selected'))::int AS rejected_runs,
        COUNT(*) FILTER (WHERE status = 'publish_failed')::int AS failed_runs,
        COUNT(*) FILTER (WHERE updated_at >= NOW() - ($1::text || ' hours')::interval)::int AS recent_runs
      FROM content_runs;
      `,
      [String(hours)],
    );

    const statusBreakdownPromise = pool.query(
      `
      SELECT status, COUNT(*)::int AS count
      FROM content_runs
      WHERE updated_at >= NOW() - ($1::text || ' hours')::interval
      GROUP BY status
      ORDER BY count DESC, status ASC;
      `,
      [String(hours)],
    );

    const dailyPromise = pool.query(
      `
      SELECT TO_CHAR(date_trunc('day', updated_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
      FROM content_runs
      WHERE updated_at >= NOW() - ($1::text || ' days')::interval
      GROUP BY date_trunc('day', updated_at)
      ORDER BY date_trunc('day', updated_at) ASC;
      `,
      [String(days)],
    );

    const [summaryResult, statusResult, dailyResult] = await Promise.all([
      summaryPromise,
      statusBreakdownPromise,
      dailyPromise,
    ]);

    const summary = summaryResult.rows[0] || {
      total_runs: 0,
      published_runs: 0,
      rejected_runs: 0,
      failed_runs: 0,
      recent_runs: 0,
    };

    const processed =
      Number(summary.published_runs || 0) +
      Number(summary.rejected_runs || 0) +
      Number(summary.failed_runs || 0);
    const publishRate = processed > 0 ? Number(summary.published_runs || 0) / processed : 0;

    res.json({
      window_hours: hours,
      trend_days: days,
      summary: {
        ...summary,
        publish_rate: Number((publishRate * 100).toFixed(2)),
      },
      status_breakdown: statusResult.rows,
      daily_trend: dailyResult.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load summary', detail: error.message });
  }
});

app.get('/api/runs', async (req, res) => {
  const limit = toInt(req.query.limit, RECENT_RUN_LIMIT);
  const status = (req.query.status || '').toString().trim();

  try {
    const params = [];
    let sql = `
      SELECT run_id, status, topic, idempotency_key, state, created_at, updated_at
      FROM content_runs
    `;

    if (status) {
      params.push(status);
      sql += ` WHERE status = $${params.length}`;
    }

    params.push(limit);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

    const result = await pool.query(sql, params);
    res.json({
      count: result.rows.length,
      runs: result.rows.map(mapRunRow),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load runs', detail: error.message });
  }
});

app.get('/api/runs/:runId', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT run_id, status, topic, idempotency_key, state, created_at, updated_at
      FROM content_runs
      WHERE run_id = $1
      LIMIT 1;
      `,
      [req.params.runId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Run not found' });
    }

    return res.json({ run: mapRunRow(result.rows[0]) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load run', detail: error.message });
  }
});

app.post('/api/control/trigger', requireControlToken, async (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const discoveryModeRaw = (payload.discovery_mode || 'manual').toString().toLowerCase();
  const discoveryMode = discoveryModeRaw === 'api' ? 'api' : 'manual';
  const topic = (payload.topic || '').toString().trim();
  const discoveryQuery = (payload.discovery_query || '').toString().trim();

  if (discoveryMode === 'manual' && !topic) {
    return res.status(400).json({ error: 'topic is required for manual mode' });
  }

  if (discoveryMode === 'api' && !discoveryQuery) {
    return res.status(400).json({ error: 'discovery_query is required for api mode' });
  }

  const triggerPayload = {
    discovery_mode: discoveryMode,
    topic,
    discovery_query: discoveryQuery,
    requester: payload.requester || 'dashboard_user',
    source: payload.source || 'dashboard',
    third_party_provider: payload.third_party_provider || 'tavily',
  };

  try {
    const result = await fetchJson(N8N_WEBHOOK_URL, triggerPayload);
    return res.status(result.status).json({
      forwarded_to: N8N_WEBHOOK_URL,
      trigger_payload: triggerPayload,
      upstream: result,
    });
  } catch (error) {
    return res.status(502).json({ error: 'Failed to trigger n8n webhook', detail: error.message });
  }
});

app.post('/api/control/retry-last-failed', requireControlToken, async (_req, res) => {
  try {
    const failed = await pool.query(
      `
      SELECT run_id, topic, status, updated_at
      FROM content_runs
      WHERE status IN ('topic_rejected', 'publish_failed', 'no_topic_selected', 'rejected_input')
      ORDER BY updated_at DESC
      LIMIT 1;
      `,
    );

    if (failed.rowCount === 0) {
      return res.status(404).json({ error: 'No failed/rejected run found to retry' });
    }

    const row = failed.rows[0];
    const retryPayload = {
      discovery_mode: 'manual',
      topic: row.topic,
      requester: 'dashboard_retry',
      source: 'dashboard_retry',
      idempotency_key: `retry-${row.run_id}-${Date.now()}`,
    };

    const result = await fetchJson(N8N_WEBHOOK_URL, retryPayload);
    return res.status(result.status).json({
      retried_from_run: {
        run_id: row.run_id,
        topic: row.topic,
        status: row.status,
        updated_at: row.updated_at,
      },
      upstream: result,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Retry failed', detail: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard service listening on http://0.0.0.0:${PORT}`);
});

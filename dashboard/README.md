# Dashboard Service

Local dashboard for the single-user AI content workflow.

## Features

- Live status overview from `content_runs`
- Status breakdown + daily trend analytics
- Recent runs table with publish URLs
- Control actions:
  - trigger new run (manual/api discovery)
  - retry latest failed/rejected run

## Endpoints

- `GET /health`
- `GET /api/summary?hours=24&days=14`
- `GET /api/runs?limit=30`
- `GET /api/runs/:runId`
- `POST /api/control/trigger`
- `POST /api/control/retry-last-failed`

## Security

If `DASHBOARD_CONTROL_TOKEN` is set, control endpoints require header:

- `x-control-token: <token>`

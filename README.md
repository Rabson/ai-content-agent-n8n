# AI Content Agent (Single Workflow, Single User)

This repo is configured as one production-style n8n workflow for one user.

## Flow

`Topic discovery (manual or API) -> filtering & scoring -> topic research -> topic review -> publish (Dev.to + Medium) -> LinkedIn summary`

## Workflow files

- `workflows/WF_Content_Orchestrator.json`
- `workflows/bundle.workflows.json` (single-workflow bundle)
- `workflows/postgres.credentials.json` (credential import file for Postgres nodes)

## Run n8n

```bash
make n8n-up
make n8n-ps
```

This starts:

- `n8n` on `http://localhost:5678`
- `dashboard` on `http://localhost:3012`

If your Docker engine cannot pull `n8n:2.11.1`, use:

```bash
make n8n-up-compat
```

## Generate + import workflow

```bash
make generate-single-user-workflow
make n8n-import-postgres-credential
make n8n-import-bundle-live
```

`n8n-import-bundle-live` imports bundle, publishes workflow, and restarts n8n.

## Sync n8n UI edits back to JSON

Edits made in the n8n editor are stored in Postgres, not auto-written to repo files.

Pull live workflow changes back into repo:

```bash
make n8n-export-main
```

This updates:

- `workflows/WF_Content_Orchestrator.json`
- `workflows/bundle.workflows.json`

The export step strips runtime metadata (timestamps/shared/version counters) to keep git diffs focused on functional workflow changes.

## Webhook

- `POST /webhook/content-topic-intake`

### Manual topic example

```bash
curl -X POST http://localhost:5678/webhook/content-topic-intake \
  -H "content-type: application/json" \
  -d '{
    "discovery_mode": "manual",
    "topic": "OAuth 2.0 vs OIDC vs SSO for modern SaaS architecture",
    "requester": "single_user",
    "source": "manual"
  }'
```

### API discovery example

```bash
curl -X POST http://localhost:5678/webhook/content-topic-intake \
  -H "content-type: application/json" \
  -d '{
    "discovery_mode": "api",
    "discovery_query": "identity and access management trends 2026",
    "third_party_provider": "tavily",
    "requester": "single_user",
    "source": "api"
  }'
```

## Required env vars

Set in `.env`:

- `OPENAI_API_KEY`
- `TAVILY_API_KEY`
- `DEVTO_API_KEY`
- `MEDIUM_USER_ID`
- `MEDIUM_ACCESS_TOKEN`

Optional overrides are listed in `.env.example` (`*_API_URL`, model, etc).

## Dashboard (Status + Analytics + Controls)

Open:

- `http://localhost:3012`

Dashboard features:

- System summary cards (total/published/rejected/failed/publish rate)
- Status breakdown and daily trend
- Recent runs table with Dev.to/Medium links
- Controls:
  - trigger a new run (`manual` or `api` discovery)
  - retry latest failed/rejected run

If `DASHBOARD_CONTROL_TOKEN` is set in `.env`, controls require the same token in the UI.

## Useful commands

```bash
make help
make generate-single-user-workflow
make n8n-up
make n8n-import-postgres-credential
make n8n-import-bundle-live
make n8n-export-main
make n8n-workflow-ids
make n8n-logs
make dashboard-health
make dashboard-logs
```

## DB Sync Scripts (Local Docker + External)

Single script:

- `scripts/db-sync.sh`

Modes:

- `local` uses Docker Postgres container (`LOCAL_POSTGRES_*`)
- `external` uses `.env` `POSTGRES_*`

If external DB version is newer than local pg client, set:

- `EXTERNAL_PG_CLIENT_IMAGE` (example: `postgres:17-alpine`)

Examples:

```bash
# Apply schema
scripts/db-sync.sh local apply-schema
scripts/db-sync.sh external apply-schema

# Dump schema
scripts/db-sync.sh local dump-schema
scripts/db-sync.sh external dump-schema

# Dump content tables data
scripts/db-sync.sh local dump-content-data
scripts/db-sync.sh external dump-content-data

# Restore SQL file
scripts/db-sync.sh local restore-file tmp/db/external_content_data_YYYYMMDD_HHMMSS.sql
scripts/db-sync.sh external restore-file tmp/db/local_content_data_YYYYMMDD_HHMMSS.sql
```

Make wrappers:

```bash
make db-local-apply-schema
make db-local-dump-schema
make db-local-dump-content
make db-local-restore-file SQL_FILE=tmp/db/file.sql

make db-external-apply-schema
make db-external-dump-schema
make db-external-dump-content
make db-external-restore-file SQL_FILE=tmp/db/file.sql
```

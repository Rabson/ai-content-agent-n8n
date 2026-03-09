# n8n Workflow Import Guide (Single Workflow)

## Files

- `bundle.workflows.json`: bundle with one workflow (`WF_Content_Orchestrator`)
- `WF_Content_Orchestrator.json`: main single-user workflow
- `postgres.credentials.json`: Postgres credential for state persistence nodes

## Flow

`Topic discovery (manual/api) -> filtering & scoring -> topic research -> topic review -> Dev.to publish -> Medium publish -> LinkedIn summary`

## Import order

1. Import credentials:
   - `n8n import:credentials --input=/workflows/postgres.credentials.json`
2. Import bundle:
   - `n8n import:workflow --input=/workflows/bundle.workflows.json`
3. Publish workflow:
   - `n8n publish:workflow --id=Xlc6ZFLdozHji7p7`
4. Restart n8n.

## Notes

- No `Execute Workflow` node linking is required.
- Webhook endpoint: `POST /webhook/content-topic-intake`
- Postgres credential name/id in workflow export:
  - `Local Postgres (n8n)` / `f3dc8f0f-1f70-47f5-bf25-10b0d2e55111`

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
   - `n8n publish:workflow --id=<workflow_id>`
4. Restart n8n.

## Export back from live n8n

If you edit the workflow in n8n UI and want to persist those edits in git-managed JSON files:

- `make n8n-export-main MAIN_WORKFLOW_ID=<workflow_id>`

This rewrites:

- `workflows/WF_Content_Orchestrator.json` (single object)
- `workflows/bundle.workflows.json` (array bundle)

The sync script removes volatile runtime metadata from exported JSON so commits stay clean.

## Notes

- No `Execute Workflow` node linking is required.
- Additional `WF_Approval`, `WF_Research`, `WF_Writing`, `WF_Review`, `WF_Publish`, `WF_Log_Event`, and `WF_Error_Handler` files are kept as modular reference exports; the default deploy/import path uses only `WF_Content_Orchestrator` via `bundle.workflows.json`.
- Webhook endpoint: `POST /webhook/content-topic-intake`
- Postgres credential name/id in workflow export:
  - `External Postgres (n8n)` / `f3dc8f0f-1f70-47f5-bf25-10b0d2e55111`

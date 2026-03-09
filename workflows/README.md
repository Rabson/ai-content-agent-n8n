# n8n Workflow Import Guide

## Files
- `bundle.workflows.json`: import all workflows at once.
- `postgres.credentials.json`: local Postgres credential import for Postgres nodes.
- `WF_Content_Orchestrator.json`: main workflow.
- `WF_Research.json`, `WF_Writing.json`, `WF_Review.json`, `WF_Approval.json`, `WF_Approval_Callback.json`, `WF_Publish.json`, `WF_Log_Event.json`, `WF_Error_Handler.json`: sub-workflows.

## Import
1. In n8n, go to **Workflows** -> **Import from File**.
2. Import `bundle.workflows.json`.
3. Import credential using CLI:
   - `n8n import:credentials --input=/workflows/postgres.credentials.json`
4. Publish each imported workflow (`n8n 2.11.x`):
   - `n8n publish:workflow --id=<workflow-id>`
5. Restart n8n.

## Execute Workflow Node Linking
The main orchestrator uses env vars in `Execute Workflow` nodes:
- `WF_RESEARCH_ID`
- `WF_WRITING_ID`
- `WF_REVIEW_ID`
- `WF_APPROVAL_ID`
- `WF_PUBLISH_ID`

Set these env vars to the actual workflow IDs in your n8n instance, OR manually open each `Execute Workflow` node and select the target workflow from the dropdown.

## Required Infrastructure
- Postgres table `content_runs` and `content_events` (queries are already wired in persist/log nodes).
- HTTP endpoints or credentials for:
  - OpenAI API
  - Tavily/SerpAPI-like search provider
  - Slack/email/webhook approval dispatch
  - Publishing endpoint (Dev.to / Hashnode / Ghost)

## Suggested ENV Variables
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional, default in nodes)
- `OPENAI_API_URL` (optional)
- `TAVILY_API_KEY`
- `TAVILY_API_URL` (optional)
- `NOTIFICATION_WEBHOOK_URL`
- `ERROR_ALERT_WEBHOOK_URL`
- `APPROVAL_SHARED_SECRET`
- `APPROVAL_CALLBACK_URL`
- `SLACK_APPROVAL_WEBHOOK_URL`
- `EMAIL_API_URL`
- `APPROVER_EMAIL`
- `APPROVAL_FORM_DISPATCH_URL`
- `DEVTO_API_KEY`, `DEVTO_API_URL`
- `HASHNODE_API_KEY`, `HASHNODE_API_URL`, `HASHNODE_PUBLICATION_ID`
- `GHOST_ADMIN_TOKEN`, `GHOST_API_URL`

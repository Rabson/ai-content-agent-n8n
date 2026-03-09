# AI Content Agent (n8n)

Production-style n8n workflow system for AI-assisted blog publishing:

`Topic -> Supervisor -> Research -> Writer -> Review -> Human Approval -> Publish`

## What is implemented

- Supervisor/manager routing logic in `WF_Content_Orchestrator`
- Agent handoffs through `Execute Workflow` nodes
- Human approval flow (Slack, Email, Webhook/Form + callback)
- Input/output guardrails (rule-based + AI-assisted)
- Tool integrations (LLM, web research, publish APIs, notifications)
- Persistent state in Postgres (`content_runs`, `content_events`)
- Modular sub-workflows + reusable logging/error workflows
- Multi-platform publishing (Dev.to, Hashnode, Ghost)

## Workflow set

| Workflow | Purpose |
|---|---|
| `WF_Content_Orchestrator` | Main orchestrator (intake, supervisor decisions, routing, final response) |
| `WF_Research` | Search + research synthesis |
| `WF_Writing` | Draft generation (title/summary/sections/markdown) |
| `WF_Review` | Quality/policy/hallucination review |
| `WF_Approval` | Human approval dispatch + wait + state readback |
| `WF_Approval_Callback` | Approve/reject callback endpoint |
| `WF_Publish` | Dev.to/Hashnode/Ghost publishing |
| `WF_Log_Event` | Structured run event logging |
| `WF_Error_Handler` | Error capture + alerting |

Workflow exports are in `workflows/`, including `workflows/bundle.workflows.json`.

## Runtime setup

Prerequisites:
- Docker Desktop
- Make

Start stack:
```bash
make n8n-up
```

If Docker is older and `n8n:2.11.1` fails with `archive/tar: invalid tar header`:
```bash
make n8n-up-compat
```

Check status:
```bash
make n8n-ps
```

## Import and wire workflows

1. Open n8n (`http://localhost:5678`).
2. Import `workflows/bundle.workflows.json`.
3. Import Postgres credential used by all Postgres nodes:
```bash
make n8n-import-postgres-credential
```
4. Publish imported workflows (required on n8n 2.11.x for webhook registration):
```bash
make n8n-publish-workflows
```
5. Ensure env-based sub-workflow IDs are set in `.env`:
   - `WF_RESEARCH_ID`
   - `WF_WRITING_ID`
   - `WF_REVIEW_ID`
   - `WF_APPROVAL_ID`
   - `WF_PUBLISH_ID`
6. Restart n8n if env vars changed:
```bash
make n8n-restart
```

Shortcut for import + publish + restart:
```bash
make n8n-import-bundle-live
```

List imported workflow IDs:
```bash
make n8n-workflow-ids
```

## Trigger the system

Main intake webhook path: `POST /webhook/content-topic-intake`

Example:
```bash
curl -X POST http://localhost:5678/webhook/content-topic-intake \
  -H "content-type: application/json" \
  -d '{
    "topic": "Write a blog on OAuth 2.0 vs OIDC vs SSO",
    "requester": "editor@company.com",
    "platform": "devto",
    "source": "api"
  }'
```

## Core data contract (state object)

```json
{
  "run_id": "1709999999999-ab12cd34",
  "idempotency_key": "oauth-2-oidc-sso-1709999999999",
  "status": "approved_for_publish",
  "topic": "Write a blog on OAuth 2.0 vs OIDC vs SSO",
  "title": "OAuth 2.0 vs OIDC vs SSO: How They Actually Fit Together",
  "summary": "Practical comparison with architecture-level guidance.",
  "research": {
    "notes": ["..."],
    "sources": [{"title": "RFC 6749", "url": "https://datatracker.ietf.org/doc/html/rfc6749", "snippet": "..."}],
    "citations": ["RFC 6749", "OpenID Connect Core 1.0"],
    "gaps": [],
    "confidence": "high"
  },
  "sections": [{"heading": "OAuth 2.0", "bullets": ["..."]}],
  "markdown_content": "# OAuth 2.0 vs OIDC vs SSO\n\n...",
  "review": {
    "quality_score": 88,
    "strengths": ["clear distinctions"],
    "feedback": ["add one implementation caveat"],
    "missing_sections": [],
    "policy_violations": [],
    "hallucination_risk": "low",
    "recommended_action": "approve_for_human"
  },
  "approval": {
    "status": "approved",
    "approver": "editor@company.com",
    "channel": "slack",
    "comments": "Looks good",
    "decided_at": "2026-03-09T10:20:30.000Z",
    "token": "redacted",
    "callback_url": "https://your-n8n-instance/webhook/content-approval-callback"
  },
  "publish": {
    "status": "published",
    "platform": "devto",
    "url": "https://dev.to/example/oauth-oidc-sso",
    "article_id": "123456",
    "published_at": "2026-03-09T10:22:00.000Z",
    "provider_response": {}
  },
  "timestamps": {
    "created_at": "2026-03-09T10:00:00.000Z",
    "updated_at": "2026-03-09T10:22:00.000Z",
    "started_at": "2026-03-09T10:00:00.000Z",
    "finished_at": "2026-03-09T10:22:00.000Z"
  }
}
```

## Environment variables

Set values in `.env`:
- OpenAI: `OPENAI_API_KEY`, optional `OPENAI_MODEL`
- Research tool: `TAVILY_API_KEY`
- Approval/notifications: `SLACK_APPROVAL_WEBHOOK_URL`, `EMAIL_API_URL`, `APPROVER_EMAIL`, `APPROVAL_CALLBACK_URL`, `NOTIFICATION_WEBHOOK_URL`, `ERROR_ALERT_WEBHOOK_URL`
- Publishing: `DEVTO_API_KEY`, `HASHNODE_API_KEY`, `HASHNODE_PUBLICATION_ID`, `GHOST_ADMIN_TOKEN`

## Useful commands

```bash
make help
make n8n-up
make n8n-up-compat
make n8n-ps
make n8n-logs
make n8n-import-bundle
make n8n-import-postgres-credential
make n8n-publish-workflows
make n8n-import-bundle-live
make n8n-workflow-ids
make n8n-doctor
make n8n-down
```

## Notes

- Workflow JSON is generated by `scripts/generate-workflows.mjs`.
- Regenerate after edits:
```bash
node scripts/generate-workflows.mjs
```
- If you regenerate workflows, re-bind the Postgres credential in exported files:
```bash
make bind-postgres-cred-files
```
- Docker stack is defined in `infra/docker-compose.yml` and `infra/initdb/`.

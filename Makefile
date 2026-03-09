SHELL := /bin/zsh

INFRA_DIR := infra
ENV_FILE := .env
COMPOSE_FILE := $(INFRA_DIR)/docker-compose.yml
WORKFLOW_BUNDLE := workflows/bundle.workflows.json
N8N_CONTAINER := ai-content-n8n-n8n-1
POSTGRES_CONTAINER := ai-content-n8n-postgres-1
DASHBOARD_CONTAINER := ai-content-n8n-dashboard-1
MAIN_WORKFLOW_ID := Xlc6ZFLdozHji7p7
N8N_IMAGE_COMPAT := n8nio/n8n:1.60.1
PG_CREDENTIAL_ID ?= f3dc8f0f-1f70-47f5-bf25-10b0d2e55111
PG_CREDENTIAL_NAME ?= Local Postgres (n8n)
LIVE_EXPORT_TMP := /tmp/WF_Content_Orchestrator.live.json

.PHONY: help generate-single-user-workflow n8n-pull n8n-pull-compat n8n-up n8n-up-compat n8n-up-recreate n8n-down n8n-ps n8n-logs n8n-restart n8n-import-bundle n8n-import-postgres-credential n8n-publish-workflows n8n-import-bundle-live n8n-export-main n8n-status n8n-workflow-ids n8n-doctor bind-postgres-cred-files dashboard-health dashboard-logs

help: ## Show available targets
	@awk 'BEGIN {FS=":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf " - %s\n", $$1 " — " $$2}' Makefile

generate-single-user-workflow: ## Generate single-user single-workflow bundle
	node scripts/generate-single-user-workflow.mjs

n8n-pull: ## Pull n8n/postgres images
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) pull

n8n-pull-compat: ## Pull compatibility n8n image for older Docker engines
	docker pull $(N8N_IMAGE_COMPAT)

n8n-up: ## Start stack in background using N8N_IMAGE from .env
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d

n8n-up-compat: ## Start stack with temporary compatibility image (n8nio/n8n:1.60.1)
	N8N_IMAGE=$(N8N_IMAGE_COMPAT) docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d

n8n-up-recreate: ## Recreate n8n service with current env/image
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d --force-recreate n8n

n8n-down: ## Stop stack
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) down

n8n-ps: ## Show stack status
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) ps

n8n-logs: ## Tail n8n, postgres, and dashboard logs
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) logs --no-color --tail=120 n8n postgres dashboard

n8n-restart: ## Restart n8n service
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) restart n8n

n8n-import-bundle: ## Import bundle.workflows.json into running n8n
	docker exec $(N8N_CONTAINER) n8n import:workflow --input=/workflows/bundle.workflows.json

n8n-import-postgres-credential: ## Import local Postgres credential into n8n
	docker exec $(N8N_CONTAINER) n8n import:credentials --input=/workflows/postgres.credentials.json

n8n-publish-workflows: ## Publish single orchestrator workflow (needed for n8n 2.11 webhook registration)
	@echo "Publishing $(MAIN_WORKFLOW_ID)"
	@docker exec $(N8N_CONTAINER) n8n publish:workflow --id=$(MAIN_WORKFLOW_ID)

n8n-import-bundle-live: ## Import bundle, publish workflows, and restart n8n
	$(MAKE) n8n-import-bundle
	$(MAKE) n8n-publish-workflows
	$(MAKE) n8n-restart

n8n-export-main: ## Export live orchestrator and sanitize runtime metadata for local workflow files
	docker exec $(N8N_CONTAINER) n8n export:workflow --id=$(MAIN_WORKFLOW_ID) --output=$(LIVE_EXPORT_TMP) --pretty
	docker cp $(N8N_CONTAINER):$(LIVE_EXPORT_TMP) workflows/.live-export.json
	node scripts/sync-live-export.mjs workflows/.live-export.json workflows/WF_Content_Orchestrator.json workflows/bundle.workflows.json
	rm -f workflows/.live-export.json

bind-postgres-cred-files: ## Bind Postgres credential in exported workflow files
	node scripts/bind-postgres-credential.mjs "$(PG_CREDENTIAL_ID)" "$(PG_CREDENTIAL_NAME)"

n8n-workflow-ids: ## List imported workflow IDs from Postgres
	docker exec $(POSTGRES_CONTAINER) psql -U n8n -d n8n -c "SELECT id, name, active FROM workflow_entity WHERE name LIKE 'WF_%' ORDER BY name;"

n8n-status: ## Quick health/status check
	@echo "Stack status:"
	@docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) ps
	@echo ""
	@echo "n8n root page check (inside container):"
	@docker exec $(N8N_CONTAINER) sh -lc "wget -qO- http://127.0.0.1:5678/ | head -n 2"
	@echo ""
	@echo "dashboard health check (inside container):"
	@docker exec $(DASHBOARD_CONTAINER) sh -lc "wget -qO- http://127.0.0.1:3012/health | head -n 2"

n8n-doctor: ## Print Docker+n8n compatibility diagnostics
	@echo "Docker Server Version: $$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"
	@echo "Configured N8N_IMAGE: $$(grep '^N8N_IMAGE=' $(ENV_FILE) | cut -d'=' -f2-)"
	@echo "If n8n:2.x pull fails with 'invalid tar header', update Docker Desktop or use 'make n8n-up-compat'."

dashboard-health: ## Query dashboard health endpoint from inside dashboard container
	docker exec $(DASHBOARD_CONTAINER) sh -lc "wget -qO- http://127.0.0.1:3012/health"

dashboard-logs: ## Tail only dashboard logs
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) logs --no-color --tail=120 dashboard

db-local-apply-schema: ## Apply infra/initdb schema to local Docker Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh local apply-schema

db-local-dump-schema: ## Dump schema from local Docker Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh local dump-schema

db-local-dump-content: ## Dump content_runs/content_events data from local Docker Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh local dump-content-data

db-local-restore-file: ## Restore SQL file into local Docker Postgres. Usage: make db-local-restore-file SQL_FILE=tmp/db/file.sql
	@test -n "$(SQL_FILE)" || (echo "SQL_FILE is required" && exit 1)
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh local restore-file "$(SQL_FILE)"

db-external-apply-schema: ## Apply infra/initdb schema to external Postgres from .env POSTGRES_*
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh external apply-schema

db-external-dump-schema: ## Dump schema from external Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh external dump-schema

db-external-dump-content: ## Dump content_runs/content_events data from external Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh external dump-content-data

db-external-restore-file: ## Restore SQL file into external Postgres. Usage: make db-external-restore-file SQL_FILE=tmp/db/file.sql
	@test -n "$(SQL_FILE)" || (echo "SQL_FILE is required" && exit 1)
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh external restore-file "$(SQL_FILE)"

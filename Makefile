SHELL := /bin/zsh

INFRA_DIR := infra
ENV_FILE := .env
COMPOSE_FILE := $(INFRA_DIR)/docker-compose.yml
N8N_CONTAINER := ai-content-n8n-n8n-1
DASHBOARD_CONTAINER := ai-content-n8n-dashboard-1
LIVE_EXPORT_TMP := /tmp/WF_Content_Orchestrator.live.json

.PHONY: help generate-single-user-workflow n8n-pull n8n-up n8n-up-recreate n8n-down n8n-ps n8n-logs n8n-restart n8n-import-bundle n8n-import-postgres-credential n8n-publish-workflows n8n-import-bundle-live n8n-export-main n8n-status n8n-workflow-ids n8n-doctor dashboard-health dashboard-logs db-apply-schema db-dump-schema db-dump-content db-apply-content db-restore-file db-query

help: ## Show available targets
	@awk 'BEGIN {FS=":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf " - %s\n", $$1 " — " $$2}' Makefile

generate-single-user-workflow: ## Generate single-user single-workflow bundle
	node scripts/generate-single-user-workflow.mjs

n8n-pull: ## Pull stack images
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) pull

n8n-up: ## Start stack in background using N8N_IMAGE from .env
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d

n8n-up-recreate: ## Recreate n8n service with current env/image
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d --force-recreate n8n

n8n-down: ## Stop stack
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) down

n8n-ps: ## Show stack status
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) ps

n8n-logs: ## Tail n8n and dashboard logs
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) logs --no-color --tail=120 n8n dashboard

n8n-restart: ## Restart n8n service
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) restart n8n

n8n-import-bundle: ## Import bundle.workflows.json into running n8n
	docker exec $(N8N_CONTAINER) n8n import:workflow --input=/workflows/bundle.workflows.json

n8n-import-postgres-credential: ## Import Postgres credential into n8n
	docker exec $(N8N_CONTAINER) n8n import:credentials --input=/workflows/postgres.credentials.json

n8n-publish-workflows: ## Publish workflow. Usage: make n8n-publish-workflows MAIN_WORKFLOW_ID=<workflow_id>
	@test -n "$(MAIN_WORKFLOW_ID)" || (echo "MAIN_WORKFLOW_ID is required. Example: make n8n-publish-workflows MAIN_WORKFLOW_ID=Xlc6ZFLdozHji7p7" && exit 1)
	@echo "Publishing $(MAIN_WORKFLOW_ID)"
	@docker exec $(N8N_CONTAINER) n8n publish:workflow --id=$(MAIN_WORKFLOW_ID)

n8n-import-bundle-live: ## Import bundle, publish workflow, and restart n8n. Usage: make n8n-import-bundle-live MAIN_WORKFLOW_ID=<workflow_id>
	@test -n "$(MAIN_WORKFLOW_ID)" || (echo "MAIN_WORKFLOW_ID is required. Example: make n8n-import-bundle-live MAIN_WORKFLOW_ID=Xlc6ZFLdozHji7p7" && exit 1)
	$(MAKE) n8n-import-bundle
	$(MAKE) n8n-publish-workflows MAIN_WORKFLOW_ID="$(MAIN_WORKFLOW_ID)"
	$(MAKE) n8n-restart

n8n-export-main: ## Export one workflow and sync local JSON files. Usage: make n8n-export-main MAIN_WORKFLOW_ID=<workflow_id>
	@test -n "$(MAIN_WORKFLOW_ID)" || (echo "MAIN_WORKFLOW_ID is required. Example: make n8n-export-main MAIN_WORKFLOW_ID=Xlc6ZFLdozHji7p7" && exit 1)
	docker exec $(N8N_CONTAINER) n8n export:workflow --id=$(MAIN_WORKFLOW_ID) --output=$(LIVE_EXPORT_TMP) --pretty
	docker cp $(N8N_CONTAINER):$(LIVE_EXPORT_TMP) workflows/.live-export.json
	node scripts/sync-live-export.mjs workflows/.live-export.json workflows/WF_Content_Orchestrator.json workflows/bundle.workflows.json
	rm -f workflows/.live-export.json

n8n-workflow-ids: ## List imported workflow IDs from external Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh query "SELECT id, name, active FROM workflow_entity WHERE name LIKE 'WF_%' ORDER BY name;"

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
	@echo "If image pulls fail, ensure Docker Desktop and registry access are healthy."

dashboard-health: ## Query dashboard health endpoint from inside dashboard container
	docker exec $(DASHBOARD_CONTAINER) sh -lc "wget -qO- http://127.0.0.1:3012/health"

dashboard-logs: ## Tail only dashboard logs
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) logs --no-color --tail=120 dashboard

db-apply-schema: ## Apply infra/initdb schema to external Postgres from .env POSTGRES_*
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh apply-schema

db-dump-schema: ## Dump schema from external Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh dump-schema

db-dump-content: ## Dump content_runs/content_events data from external Postgres
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh dump-content-data

db-apply-content: ## Apply SQL content dump file into external Postgres. Usage: make db-apply-content SQL_FILE=tmp/db/file.sql
	@test -n "$(SQL_FILE)" || (echo "SQL_FILE is required" && exit 1)
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh restore-file "$(SQL_FILE)"

db-restore-file: ## Restore SQL file into external Postgres. Usage: make db-restore-file SQL_FILE=tmp/db/file.sql
	@test -n "$(SQL_FILE)" || (echo "SQL_FILE is required" && exit 1)
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh restore-file "$(SQL_FILE)"

db-query: ## Execute ad-hoc SQL query. Usage: make db-query SQL=\"SELECT 1;\"
	@test -n "$(SQL)" || (echo "SQL is required" && exit 1)
	ENV_FILE=$(ENV_FILE) scripts/db-sync.sh query "$(SQL)"

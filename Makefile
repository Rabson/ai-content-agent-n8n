SHELL := /bin/zsh

INFRA_DIR := infra
ENV_FILE := .env
COMPOSE_FILE := $(INFRA_DIR)/docker-compose.yml
WORKFLOW_BUNDLE := workflows/bundle.workflows.json
N8N_CONTAINER := ai-content-n8n-n8n-1
POSTGRES_CONTAINER := ai-content-n8n-postgres-1
N8N_IMAGE_COMPAT := n8nio/n8n:1.60.1
PG_CREDENTIAL_ID ?= f3dc8f0f-1f70-47f5-bf25-10b0d2e55111
PG_CREDENTIAL_NAME ?= Local Postgres (n8n)

.PHONY: help n8n-pull n8n-pull-compat n8n-up n8n-up-compat n8n-up-recreate n8n-down n8n-ps n8n-logs n8n-restart n8n-import-bundle n8n-import-postgres-credential n8n-publish-workflows n8n-import-bundle-live n8n-status n8n-workflow-ids n8n-doctor bind-postgres-cred-files

help: ## Show available targets
	@awk 'BEGIN {FS=":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf " - %s\n", $$1 " — " $$2}' Makefile

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

n8n-logs: ## Tail n8n and postgres logs
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) logs --no-color --tail=120 n8n postgres

n8n-restart: ## Restart n8n service
	docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE) restart n8n

n8n-import-bundle: ## Import bundle.workflows.json into running n8n
	docker exec $(N8N_CONTAINER) n8n import:workflow --input=/workflows/bundle.workflows.json

n8n-import-postgres-credential: ## Import local Postgres credential into n8n
	docker exec $(N8N_CONTAINER) n8n import:credentials --input=/workflows/postgres.credentials.json

n8n-publish-workflows: ## Publish all WF_* workflows (needed for n8n 2.11 webhook registration)
	@for id in $$(docker exec $(POSTGRES_CONTAINER) psql -U n8n -d n8n -At -c "SELECT id FROM workflow_entity WHERE name LIKE 'WF_%' ORDER BY name;"); do \
		echo "Publishing $$id"; \
		docker exec $(N8N_CONTAINER) n8n publish:workflow --id=$$id; \
	done

n8n-import-bundle-live: ## Import bundle, publish workflows, and restart n8n
	$(MAKE) n8n-import-bundle
	$(MAKE) n8n-publish-workflows
	$(MAKE) n8n-restart

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

n8n-doctor: ## Print Docker+n8n compatibility diagnostics
	@echo "Docker Server Version: $$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"
	@echo "Configured N8N_IMAGE: $$(grep '^N8N_IMAGE=' $(ENV_FILE) | cut -d'=' -f2-)"
	@echo "If n8n:2.x pull fails with 'invalid tar header', update Docker Desktop or use 'make n8n-up-compat'."

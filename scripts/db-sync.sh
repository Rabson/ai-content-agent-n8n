#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

MODE="${1:-}"
ACTION="${2:-}"
ARG1="${3:-}"
ARG2="${4:-}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR_DEFAULT="${ROOT_DIR}/tmp/db"

LOCAL_POSTGRES_CONTAINER="${LOCAL_POSTGRES_CONTAINER:-ai-content-n8n-postgres-1}"
LOCAL_POSTGRES_USER="${LOCAL_POSTGRES_USER:-n8n}"
LOCAL_POSTGRES_DB="${LOCAL_POSTGRES_DB:-n8n}"

POSTGRES_HOST="${POSTGRES_HOST:-}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
POSTGRES_DB="${POSTGRES_DB:-}"
EXTERNAL_PG_CLIENT_IMAGE="${EXTERNAL_PG_CLIENT_IMAGE:-postgres:17-alpine}"

usage() {
  cat <<USAGE
Usage:
  scripts/db-sync.sh <mode> <action> [arg]

Modes:
  local     Docker-based local Postgres container
  external  External Postgres using POSTGRES_* vars from .env

Actions:
  apply-schema [schema_file]
    Apply schema SQL file (default: infra/initdb/001_content_tables.sql)

  dump-schema [output_file]
    Dump DB schema to file (default: tmp/db/<mode>_schema_<timestamp>.sql)

  dump-content-data [output_file]
    Dump data-only for content tables (content_runs, content_events)

  restore-file <input_file>
    Restore SQL file into selected DB

  query <sql>
    Execute ad-hoc SQL query

Examples:
  scripts/db-sync.sh local apply-schema
  scripts/db-sync.sh local dump-content-data
  scripts/db-sync.sh external dump-schema
  scripts/db-sync.sh external restore-file tmp/db/local_content_data_20260310_101000.sql
  scripts/db-sync.sh external query "SELECT count(*) FROM content_runs;"
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: command not found: $1" >&2
    exit 1
  fi
}

require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Error: file not found: $file" >&2
    exit 1
  fi
}

ensure_external_env() {
  local missing=()
  [[ -z "${POSTGRES_HOST}" ]] && missing+=("POSTGRES_HOST")
  [[ -z "${POSTGRES_PORT}" ]] && missing+=("POSTGRES_PORT")
  [[ -z "${POSTGRES_USER}" ]] && missing+=("POSTGRES_USER")
  [[ -z "${POSTGRES_PASSWORD}" ]] && missing+=("POSTGRES_PASSWORD")
  [[ -z "${POSTGRES_DB}" ]] && missing+=("POSTGRES_DB")

  if (( ${#missing[@]} > 0 )); then
    echo "Error: missing external DB env vars: ${missing[*]}" >&2
    exit 1
  fi
}

ensure_local_container() {
  if ! docker inspect "${LOCAL_POSTGRES_CONTAINER}" >/dev/null 2>&1; then
    cat >&2 <<MSG
Error: local Postgres container not found: ${LOCAL_POSTGRES_CONTAINER}
Start local DB with:
  docker compose --env-file .env -f infra/docker-compose.yml --profile localdb up -d postgres
MSG
    exit 1
  fi
}

run_local_psql() {
  docker exec -i "${LOCAL_POSTGRES_CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -U "${LOCAL_POSTGRES_USER}" -d "${LOCAL_POSTGRES_DB}" "$@"
}

run_local_pg_dump() {
  docker exec -i "${LOCAL_POSTGRES_CONTAINER}" \
    pg_dump -U "${LOCAL_POSTGRES_USER}" -d "${LOCAL_POSTGRES_DB}" "$@"
}

run_external_psql() {
  docker run --rm -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" \
    "${EXTERNAL_PG_CLIENT_IMAGE}" \
    psql -v ON_ERROR_STOP=1 \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" "$@"
}

run_external_pg_dump() {
  docker run --rm -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" \
    "${EXTERNAL_PG_CLIENT_IMAGE}" \
    pg_dump \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" "$@"
}

apply_schema() {
  local schema_file="${1:-${ROOT_DIR}/infra/initdb/001_content_tables.sql}"
  require_file "${schema_file}"

  if [[ "${MODE}" == "local" ]]; then
    ensure_local_container
    run_local_psql -f - < "${schema_file}"
  else
    ensure_external_env
    run_external_psql -f - < "${schema_file}"
  fi

  echo "Applied schema: ${schema_file} -> ${MODE}"
}

dump_schema() {
  mkdir -p "${ROOT_DIR}/tmp/db"
  local output_file="${1:-${OUT_DIR_DEFAULT}/${MODE}_schema_${TIMESTAMP}.sql}"

  if [[ "${MODE}" == "local" ]]; then
    ensure_local_container
    run_local_pg_dump --schema-only > "${output_file}"
  else
    ensure_external_env
    run_external_pg_dump --schema-only > "${output_file}"
  fi

  echo "Schema dump written: ${output_file}"
}

dump_content_data() {
  mkdir -p "${ROOT_DIR}/tmp/db"
  local output_file="${1:-${OUT_DIR_DEFAULT}/${MODE}_content_data_${TIMESTAMP}.sql}"

  if [[ "${MODE}" == "local" ]]; then
    ensure_local_container
    run_local_pg_dump --data-only --inserts --column-inserts -t content_runs -t content_events > "${output_file}"
  else
    ensure_external_env
    run_external_pg_dump --data-only --inserts --column-inserts -t content_runs -t content_events > "${output_file}"
  fi

  echo "Content data dump written: ${output_file}"
}

restore_file() {
  local input_file="${1:-}"
  if [[ -z "${input_file}" ]]; then
    echo "Error: restore-file requires input SQL file path" >&2
    exit 1
  fi
  require_file "${input_file}"

  if [[ "${MODE}" == "local" ]]; then
    ensure_local_container
    run_local_psql -f - < "${input_file}"
  else
    ensure_external_env
    run_external_psql -f - < "${input_file}"
  fi

  echo "Restored SQL file: ${input_file} -> ${MODE}"
}

query_sql() {
  local sql="${1:-}"
  if [[ -z "${sql}" ]]; then
    echo "Error: query requires SQL string" >&2
    exit 1
  fi

  if [[ "${MODE}" == "local" ]]; then
    ensure_local_container
    run_local_psql -c "${sql}"
  else
    ensure_external_env
    run_external_psql -c "${sql}"
  fi
}

main() {
  require_cmd docker
  require_cmd date

  if [[ -z "${MODE}" || -z "${ACTION}" ]]; then
    usage
    exit 1
  fi

  if [[ "${MODE}" != "local" && "${MODE}" != "external" ]]; then
    echo "Error: mode must be local or external" >&2
    exit 1
  fi

  case "${ACTION}" in
    apply-schema)
      apply_schema "${ARG1}"
      ;;
    dump-schema)
      dump_schema "${ARG1}"
      ;;
    dump-content-data)
      dump_content_data "${ARG1}"
      ;;
    restore-file)
      restore_file "${ARG1}"
      ;;
    query)
      query_sql "${ARG1}"
      ;;
    *)
      echo "Error: unknown action: ${ACTION}" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"

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

ACTION="${1:-}"
ARG1="${2:-}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR_DEFAULT="${ROOT_DIR}/tmp/db"

POSTGRES_HOST="${POSTGRES_HOST:-}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
POSTGRES_DB="${POSTGRES_DB:-}"
PG_CLIENT_IMAGE="postgres:17-alpine"

usage() {
  cat <<USAGE
Usage:
  scripts/db-sync.sh <action> [arg]

Actions:
  apply-schema [schema_file]
    Apply schema SQL file (default: infra/initdb/001_content_tables.sql)

  dump-schema [output_file]
    Dump DB schema to file (default: tmp/db/external_schema_<timestamp>.sql)

  dump-content-data [output_file]
    Dump data-only for content tables (content_runs, content_events)

  restore-file <input_file>
    Restore SQL file into configured external DB

  query <sql>
    Execute ad-hoc SQL query

Examples:
  scripts/db-sync.sh apply-schema
  scripts/db-sync.sh dump-content-data
  scripts/db-sync.sh dump-schema
  scripts/db-sync.sh restore-file tmp/db/external_content_data_20260310_101000.sql
  scripts/db-sync.sh query "SELECT count(*) FROM content_runs;"
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

run_external_psql() {
  docker run --rm -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" \
    "${PG_CLIENT_IMAGE}" \
    psql -v ON_ERROR_STOP=1 \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" "$@"
}

run_external_pg_dump() {
  docker run --rm -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" \
    "${PG_CLIENT_IMAGE}" \
    pg_dump \
      -h "${POSTGRES_HOST}" \
      -p "${POSTGRES_PORT}" \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" "$@"
}

apply_schema() {
  local schema_file="${1:-${ROOT_DIR}/infra/initdb/001_content_tables.sql}"
  require_file "${schema_file}"

  ensure_external_env
  run_external_psql -f - < "${schema_file}"

  echo "Applied schema: ${schema_file} -> external"
}

dump_schema() {
  mkdir -p "${ROOT_DIR}/tmp/db"
  local output_file="${1:-${OUT_DIR_DEFAULT}/external_schema_${TIMESTAMP}.sql}"

  ensure_external_env
  run_external_pg_dump --schema-only > "${output_file}"

  echo "Schema dump written: ${output_file}"
}

dump_content_data() {
  mkdir -p "${ROOT_DIR}/tmp/db"
  local output_file="${1:-${OUT_DIR_DEFAULT}/external_content_data_${TIMESTAMP}.sql}"

  ensure_external_env
  run_external_pg_dump --data-only --inserts --column-inserts -t content_runs -t content_events > "${output_file}"

  echo "Content data dump written: ${output_file}"
}

restore_file() {
  local input_file="${1:-}"
  if [[ -z "${input_file}" ]]; then
    echo "Error: restore-file requires input SQL file path" >&2
    exit 1
  fi
  require_file "${input_file}"

  ensure_external_env
  run_external_psql -f - < "${input_file}"

  echo "Restored SQL file: ${input_file} -> external"
}

query_sql() {
  local sql="${1:-}"
  if [[ -z "${sql}" ]]; then
    echo "Error: query requires SQL string" >&2
    exit 1
  fi

  ensure_external_env
  run_external_psql -c "${sql}"
}

main() {
  require_cmd docker
  require_cmd date

  if [[ -z "${ACTION}" ]]; then
    usage
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

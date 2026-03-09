# Summary

Date: 2026-03-09

## Change made

Updated the project to a **single workflow for a single user** with the requested topic pipeline.

## Current mode

- Active design target: one workflow (`WF_Content_Orchestrator`)
- Bundle file now intended to carry one workflow for import
- Inline steps include:
  - topic discovery (manual or third-party API)
  - filtering & scoring
  - topic research
  - topic review
  - publish to Dev.to
  - publish to Medium
  - generate LinkedIn summary

## New generator

- Added: `scripts/generate-single-user-workflow.mjs`
- Added Make target: `make generate-single-user-workflow`

## Dashboard added

- Added local dashboard service (`dashboard/`) with:
  - run status overview
  - analytics (status mix + daily trend)
  - control actions (trigger run, retry last failed)
- Wired into Docker Compose on `http://localhost:3012`
- Added Make helpers:
  - `make dashboard-health`
  - `make dashboard-logs`

## Notes

- Postgres credential binding is still required for Postgres nodes.
- On n8n 2.11.x, workflows must be published after import for production webhook registration.

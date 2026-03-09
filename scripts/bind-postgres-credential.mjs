import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const credentialId = process.env.PG_CRED_ID ?? process.argv[2];
const credentialName = process.env.PG_CRED_NAME ?? process.argv[3] ?? 'Local Postgres (n8n)';
const workflowsDir = process.env.WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');

if (!credentialId) {
  console.error('Usage: node scripts/bind-postgres-credential.mjs <credentialId> [credentialName]');
  process.exit(1);
}

const files = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => join(workflowsDir, name));

let fileCount = 0;
let nodeCount = 0;

function bindWorkflow(workflow) {
  if (!workflow?.nodes || !Array.isArray(workflow.nodes)) return 0;

  let changed = 0;
  for (const node of workflow.nodes) {
    if (node?.type !== 'n8n-nodes-base.postgres') continue;

    node.credentials ??= {};
    node.credentials.postgres = {
      id: credentialId,
      name: credentialName,
    };
    changed += 1;
  }
  return changed;
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);

  let changed = 0;
  if (Array.isArray(parsed)) {
    for (const workflow of parsed) changed += bindWorkflow(workflow);
  } else {
    changed += bindWorkflow(parsed);
  }

  if (changed > 0) {
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    fileCount += 1;
    nodeCount += changed;
  }
}

console.log(`Bound Postgres credential to ${nodeCount} node(s) in ${fileCount} file(s).`);

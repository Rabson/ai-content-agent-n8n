import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [
  sourceArg = 'workflows/.live-export.json',
  mainArg = 'workflows/WF_Content_Orchestrator.json',
  bundleArg = 'workflows/bundle.workflows.json',
] = process.argv.slice(2);

const sourcePath = resolve(process.cwd(), sourceArg);
const mainPath = resolve(process.cwd(), mainArg);
const bundlePath = resolve(process.cwd(), bundleArg);

const raw = readFileSync(sourcePath, 'utf8');
const parsed = JSON.parse(raw);

const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
  throw new Error(`Invalid workflow export shape in ${sourcePath}`);
}

// Remove n8n DB/runtime metadata that creates noisy diffs when exporting from UI.
function sanitizeWorkflow(rawWorkflow) {
  const clone = JSON.parse(JSON.stringify(rawWorkflow));

  const volatileTopLevelKeys = [
    'updatedAt',
    'createdAt',
    'description',
    'isArchived',
    'activeVersionId',
    'versionCounter',
    'triggerCount',
    'shared',
    'versionMetadata',
  ];

  for (const key of volatileTopLevelKeys) {
    delete clone[key];
  }

  if (clone.meta && typeof clone.meta === 'object') {
    delete clone.meta.generatedAt;
    if (Object.keys(clone.meta).length === 0) {
      delete clone.meta;
    }
  }

  return clone;
}

const sanitized = sanitizeWorkflow(workflow);

writeFileSync(mainPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
writeFileSync(bundlePath, `${JSON.stringify([sanitized], null, 2)}\n`, 'utf8');

console.log(`Synced live export -> ${mainArg} and ${bundleArg}`);

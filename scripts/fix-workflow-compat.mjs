import { readFileSync, writeFileSync } from 'node:fs';

const inFile = process.argv[2] ?? '/tmp/wf-all.json';
const outFile = process.argv[3] ?? '/tmp/wf-all-fixed.json';

const fallbackByNodeName = {
  'Route Action': 6,
  'Approval Decision': 2,
  'Approval Channel': 0,
  'Approved or Rejected?': 2,
  'Platform Route': 0,
};

const truncateConnectionIndex = {
  'Route Action': 10,
  'Approval Decision': 3,
  'Approval Channel': 3,
  'Approved or Rejected?': 3,
  'Platform Route': 3,
};

const data = JSON.parse(readFileSync(inFile, 'utf8'));
const workflows = Array.isArray(data) ? data : [data];

for (const wf of workflows) {
  for (const node of wf.nodes ?? []) {
    if (node.type === 'n8n-nodes-base.if') {
      const conds = node.parameters?.conditions;
      if (conds && typeof conds === 'object') {
        for (const [k, arr] of Object.entries(conds)) {
          if (Array.isArray(arr)) {
            for (const c of arr) {
              if (c && typeof c === 'object' && c.operation == null) {
                c.operation = k === 'dateTime' ? 'after' : 'equal';
              }
            }
          }
        }
      }
    }

    if (node.type === 'n8n-nodes-base.switch') {
      const p = node.parameters ?? {};
      if (Array.isArray(p.rules)) {
        const convertedRules = p.rules.map((r, i) => ({
          operation: r.operation ?? 'equal',
          value2: r.value2,
          outputKey: r.outputKey ?? String(i),
        }));

        node.typeVersion = 2;
        node.parameters = {
          ...p,
          mode: 'rules',
          rules: { rules: convertedRules },
          options: {
            ...(p.options ?? {}),
            fallbackOutput: fallbackByNodeName[node.name] ?? -1,
          },
        };
        delete node.parameters.fallbackOutput;
      }
    }
  }

  for (const [nodeName, cutTo] of Object.entries(truncateConnectionIndex)) {
    const conn = wf.connections?.[nodeName]?.main;
    if (Array.isArray(conn) && conn.length > cutTo) {
      wf.connections[nodeName].main = conn.slice(0, cutTo);
    }
  }
}

writeFileSync(outFile, JSON.stringify(Array.isArray(data) ? workflows : workflows[0], null, 2) + '\n');
console.log(`Patched ${workflows.length} workflow(s): ${inFile} -> ${outFile}`);

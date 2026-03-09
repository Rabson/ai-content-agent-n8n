import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'workflows');
mkdirSync(outDir, { recursive: true });

const nowIso = new Date().toISOString();
const workflowIdByName = {
  WF_Content_Orchestrator: 'Xlc6ZFLdozHji7p7',
  WF_Research: 'NbYRm4o71mJb4oVF',
  WF_Writing: 'BLFjsXtkK2wNSFtX',
  WF_Review: 'l4LkiyInweNhjbAY',
  WF_Approval: 'OffiJWXlGPfaHCyM',
  WF_Approval_Callback: 'kURHDIEDPlXF39O9',
  WF_Publish: 'wBncL3VOpQEd9Zwz',
  WF_Log_Event: 'mT0yc9iBnl4VFyRR',
  WF_Error_Handler: 'lZ6iKwe9lN4fmwPC',
};

function n({
  name,
  type,
  parameters = {},
  position = [0, 0],
  typeVersion = 1,
  continueOnFail = false,
  alwaysOutputData = false,
  webhookId,
  notes,
  notesInFlow,
}) {
  const node = {
    id: randomUUID(),
    name,
    type,
    typeVersion,
    position,
    parameters,
  };
  if (continueOnFail) node.continueOnFail = true;
  if (alwaysOutputData) node.alwaysOutputData = true;
  if (webhookId) node.webhookId = webhookId;
  if (notes) node.notes = notes;
  if (typeof notesInFlow === 'boolean') node.notesInFlow = notesInFlow;
  return node;
}

function connect(connections, from, outputIndex, to, inputIndex = 0) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= outputIndex) {
    connections[from].main.push([]);
  }
  connections[from].main[outputIndex].push({
    node: to,
    type: 'main',
    index: inputIndex,
  });
}

function wf(name, nodes, connections, extra = {}) {
  return {
    id: extra.id ?? workflowIdByName[name] ?? randomUUID(),
    name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveExecutionProgress: true,
      saveManualExecutions: true,
      timezone: 'UTC',
      ...extra.settings,
    },
    staticData: null,
    pinData: {},
    active: false,
    tags: [],
    versionId: randomUUID(),
    meta: {
      templateCredsSetupCompleted: false,
      generatedAt: nowIso,
    },
  };
}

const upsertRunQuery = `
INSERT INTO content_runs (run_id, status, topic, idempotency_key, state, updated_at)
VALUES (
  '{{$json.run_id}}',
  '{{$json.status}}',
  '{{$json.topic}}',
  '{{ $json.idempotency_key || "" }}',
  '{{ JSON.stringify($json).replace(/'/g, "''") }}'::jsonb,
  NOW()
)
ON CONFLICT (run_id)
DO UPDATE SET
  status = EXCLUDED.status,
  topic = EXCLUDED.topic,
  idempotency_key = EXCLUDED.idempotency_key,
  state = EXCLUDED.state,
  updated_at = NOW();
`.trim();

function createMainWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Topic Intake',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: randomUUID(),
      parameters: {
        httpMethod: 'POST',
        path: 'content-topic-intake',
        responseMode: 'responseNode',
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Normalize Input',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      parameters: {
        jsCode: `
const payload = $json.body ?? $json;
const topic = (payload.topic ?? '').toString().trim();
const platform = (payload.platform ?? 'devto').toString().toLowerCase();
const requester = (payload.requester ?? 'anonymous').toString();
const source = (payload.source ?? 'api').toString();

if (!topic) {
  return [{
    json: {
      topic: '',
      requester,
      platform,
      source,
      idempotency_key: payload.idempotency_key ?? '',
      status: 'rejected_input',
      input_guardrail: {
        allow: false,
        rules: {
          allow: false,
          blocked_terms: ['missing_topic'],
          reason: 'Topic is required.',
        },
        ai: {
          allow: false,
          categories: ['invalid_input'],
          reason: 'Topic is required.',
          confidence: 1,
        },
      },
      response: {
        status: 'rejected_input',
        message: 'Topic is required.',
      },
    },
  }];
}

const normalizedTopic = topic.replace(/\\s+/g, ' ').trim();
const slugBase = normalizedTopic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const idempotencyKey = (payload.idempotency_key ?? (slugBase + '-' + Date.now())).toString();

return [{
  json: {
    topic: normalizedTopic,
    requester,
    platform,
    source,
    idempotency_key: idempotencyKey,
  },
}];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Init Run State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [480, 0],
      parameters: {
        jsCode: `
const now = new Date().toISOString();
const random = Math.random().toString(36).slice(2, 10);
const runId = Date.now() + '-' + random;

return [{
  json: {
    run_id: runId,
    status: $json.status ?? 'received',
    topic: $json.topic,
    title: '',
    summary: '',
    requester: $json.requester,
    source: $json.source,
    platform: $json.platform,
    idempotency_key: $json.idempotency_key,
    research: {
      notes: [],
      sources: [],
      citations: [],
      gaps: [],
      confidence: 'unknown',
    },
    sections: [],
    markdown_content: '',
    review: {
      quality_score: 0,
      strengths: [],
      feedback: [],
      missing_sections: [],
      policy_violations: [],
      hallucination_risk: 'unknown',
      recommended_action: 'revise',
    },
    approval: {
      status: 'not_requested',
      approver: '',
      channel: 'slack',
      comments: '',
      decided_at: '',
      token: '',
      callback_url: '',
    },
    publish: {
      status: 'not_started',
      platform: $json.platform,
      url: '',
      article_id: '',
      published_at: '',
      provider_response: {},
    },
    input_guardrail: {
      allow: true,
      rules: null,
      ai: null,
    },
    output_guardrail: {
      guardrail_pass: false,
      violations: [],
      risk_level: 'unknown',
      hallucination_risk: 'unknown',
      missing_required_sections: [],
      action: 'revise',
    },
    supervisor: {
      next_action: 'RUN_RESEARCH',
      reason: 'Initial state',
      required_updates: [],
      priority: 'normal',
      retryable: true,
      decided_at: now,
    },
    revision_count: 0,
    max_revision_attempts: 2,
    cost_metrics: {
      prompt_tokens: 0,
      completion_tokens: 0,
      estimated_usd: 0,
    },
    timestamps: {
      created_at: now,
      updated_at: now,
      started_at: now,
      finished_at: '',
    },
  },
}];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Persist Run Created',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [720, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
      notes: 'Configure Postgres credentials before production use.',
      notesInFlow: true,
    }),
  );

  nodes.push(
    n({
      name: 'Input Rule Guardrail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 40],
      parameters: {
        jsCode: `
const topic = ($json.topic ?? '').toLowerCase();
const blockedPatterns = [
  { key: 'malware_generation', re: /\\b(malware|ransomware|keylogger|botnet|trojan builder)\\b/ },
  { key: 'illegal_hacking', re: /\\b(exploit zero day|bypass firewall|credential stuffing|phishing kit|sql injection payload)\\b/ },
  { key: 'fake_medical_advice', re: /\\b(fake medical|fabricate diagnosis|unsafe dosage|pretend doctor advice)\\b/ },
  { key: 'plagiarism_request', re: /\\b(plagiarize|copy exact article|rewrite this to avoid plagiarism checker)\\b/ },
];

const hits = blockedPatterns.filter((p) => p.re.test(topic)).map((p) => p.key);
const allow = hits.length === 0;

$json.input_guardrail = {
  ...($json.input_guardrail ?? {}),
  rules: {
    allow,
    blocked_terms: hits,
    reason: allow ? 'No blocked input patterns detected.' : 'Blocked by deterministic input rules.',
  },
};

if (!allow) {
  $json.status = 'rejected_input';
}
$json.timestamps.updated_at = new Date().toISOString();

return [{ json: $json }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Input AI Guardrail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [960, 40],
      parameters: {
        jsCode: `
const topic = ($json.topic ?? '').toLowerCase();
let allow = true;
let reason = 'No high-risk intent detected.';
const categories = [];
let confidence = 0.82;

if (/\\b(generate exploit|undetectable malware|steal credentials|bank account takeover)\\b/.test(topic)) {
  allow = false;
  categories.push('cyber_abuse');
  reason = 'High-risk cyber abuse intent detected.';
  confidence = 0.98;
}
if (/\\b(prescribe medication without doctor|fake medical treatment)\\b/.test(topic)) {
  allow = false;
  categories.push('unsafe_medical');
  reason = 'Unsafe medical request detected.';
  confidence = 0.95;
}
if (/\\b(copy this article exactly|pass ai detector plagiarism)\\b/.test(topic)) {
  allow = false;
  categories.push('plagiarism');
  reason = 'Plagiarism-like intent detected.';
  confidence = 0.94;
}

const ruleAllow = $json.input_guardrail?.rules?.allow ?? true;

$json.input_guardrail = {
  ...($json.input_guardrail ?? {}),
  allow: Boolean(ruleAllow && allow),
  ai: {
    allow,
    categories,
    reason,
    confidence,
  },
};

if (!$json.input_guardrail.allow) {
  $json.status = 'rejected_input';
  $json.response = {
    status: 'rejected_input',
    run_id: $json.run_id,
    message: 'Topic blocked by guardrails.',
    categories: [
      ...($json.input_guardrail.rules?.blocked_terms ?? []),
      ...($json.input_guardrail.ai?.categories ?? []),
    ],
  };
}

$json.timestamps.updated_at = new Date().toISOString();
return [{ json: $json }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Input Allowed?',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [1200, 40],
      parameters: {
        conditions: {
          boolean: [
            {
              value1: '={{$json.input_guardrail.allow}}',
              value2: true,
            },
          ],
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Supervisor Decision',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1440, 40],
      parameters: {
        jsCode: `
const review = $json.review ?? {};
const approval = $json.approval ?? {};
const publish = $json.publish ?? {};

let nextAction = 'RUN_RESEARCH';
let reason = 'Research notes missing.';

if ($json.input_guardrail?.allow === false || String($json.status || '').startsWith('rejected')) {
  nextAction = 'REJECT_TOPIC';
  reason = 'Input guardrail failed.';
} else if (!Array.isArray($json.research?.notes) || $json.research.notes.length === 0) {
  nextAction = 'RUN_RESEARCH';
  reason = 'Research is required before writing.';
} else if (!$json.markdown_content || !$json.markdown_content.trim()) {
  nextAction = 'RUN_WRITING';
  reason = 'Draft content missing.';
} else if (!review.quality_score) {
  nextAction = 'RUN_REVIEW';
  reason = 'Draft not reviewed yet.';
} else if (
  (review.quality_score ?? 0) < 80 ||
  (review.policy_violations ?? []).length > 0 ||
  review.hallucination_risk === 'high' ||
  $json.output_guardrail?.guardrail_pass === false
) {
  if (($json.revision_count ?? 0) >= ($json.max_revision_attempts ?? 2)) {
    nextAction = 'END_FAILED';
    reason = 'Max revision attempts reached.';
  } else {
    nextAction = 'REQUEST_REVISION';
    reason = 'Quality or policy checks require revision.';
  }
} else if (approval.status === 'approved' && publish.status !== 'published') {
  nextAction = 'PUBLISH';
  reason = 'Approved for publishing.';
} else if (approval.status === 'rejected') {
  nextAction = 'END_REJECTED';
  reason = 'Human approval rejected the content.';
} else if (publish.status === 'published') {
  nextAction = 'END_SUCCESS';
  reason = 'Publishing complete.';
} else {
  nextAction = 'SEND_HUMAN_APPROVAL';
  reason = 'Awaiting human approval.';
}

$json.supervisor = {
  next_action: nextAction,
  reason,
  required_updates: [],
  priority: 'normal',
  retryable: true,
  decided_at: new Date().toISOString(),
};

$json.timestamps.updated_at = new Date().toISOString();
return [{ json: $json }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Route Action',
      type: 'n8n-nodes-base.switch',
      typeVersion: 1,
      position: [1680, 40],
      parameters: {
        dataType: 'string',
        value1: '={{$json.supervisor.next_action}}',
        rules: [
          { operation: 'equal', value2: 'RUN_RESEARCH' },
          { operation: 'equal', value2: 'RUN_WRITING' },
          { operation: 'equal', value2: 'RUN_REVIEW' },
          { operation: 'equal', value2: 'REQUEST_REVISION' },
          { operation: 'equal', value2: 'SEND_HUMAN_APPROVAL' },
          { operation: 'equal', value2: 'PUBLISH' },
          { operation: 'equal', value2: 'REJECT_TOPIC' },
          { operation: 'equal', value2: 'END_REJECTED' },
          { operation: 'equal', value2: 'END_SUCCESS' },
          { operation: 'equal', value2: 'END_FAILED' },
        ],
        fallbackOutput: 10,
      },
    }),
  );

  nodes.push(
    n({
      name: 'Run Research',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1,
      position: [1920, -220],
      parameters: {
        workflowId: '={{$env.WF_RESEARCH_ID}}',
        options: {
          waitForSubWorkflow: true,
        },
      },
      notes: 'Set WF_RESEARCH_ID in n8n environment or switch to static workflow ID.',
      notesInFlow: true,
    }),
  );

  nodes.push(
    n({
      name: 'Persist After Research',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [2160, -300],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Run Writing',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1,
      position: [1920, -60],
      parameters: {
        workflowId: '={{$env.WF_WRITING_ID}}',
        options: {
          waitForSubWorkflow: true,
        },
      },
      notes: 'Set WF_WRITING_ID in n8n environment or switch to static workflow ID.',
      notesInFlow: true,
    }),
  );

  nodes.push(
    n({
      name: 'Persist After Writing',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [2160, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Run Review',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1,
      position: [1920, 100],
      parameters: {
        workflowId: '={{$env.WF_REVIEW_ID}}',
        options: {
          waitForSubWorkflow: true,
        },
      },
      notes: 'Set WF_REVIEW_ID in n8n environment or switch to static workflow ID.',
      notesInFlow: true,
    }),
  );

  nodes.push(
    n({
      name: 'Output Rule Guardrail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2160, 100],
      parameters: {
        jsCode: `
const content = ($json.markdown_content ?? '').trim();
const headings = [...content.matchAll(/^##?\\s+(.+)$/gm)].map((m) => m[1]);
const wordCount = content ? content.split(/\\s+/).length : 0;
const hasIntro = /(^|\\n)#\\s+/.test(content) || /introduction/i.test(content);
const hasConclusion = /conclusion/i.test(content);

const missing = [];
if (wordCount < 600) missing.push('minimum_word_count_600');
if (!hasIntro) missing.push('missing_intro');
if (!hasConclusion) missing.push('missing_conclusion');
if (headings.length < 4) missing.push('minimum_4_headings');

$json.output_guardrail = {
  ...($json.output_guardrail ?? {}),
  rule_checks: {
    word_count: wordCount,
    heading_count: headings.length,
    has_intro: hasIntro,
    has_conclusion: hasConclusion,
  },
  missing_required_sections: missing,
};

return [{ json: $json }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Output AI Guardrail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2400, 100],
      parameters: {
        jsCode: `
const review = $json.review ?? {};
const missing = $json.output_guardrail?.missing_required_sections ?? [];
const policyViolations = review.policy_violations ?? [];
const lowQuality = (review.quality_score ?? 0) < 80;
const highHallucination = review.hallucination_risk === 'high';

let guardrailPass = true;
const violations = [];
if (policyViolations.length > 0) {
  guardrailPass = false;
  violations.push(...policyViolations);
}
if (missing.length > 0) {
  guardrailPass = false;
  violations.push('missing_required_sections');
}
if (lowQuality) {
  guardrailPass = false;
  violations.push('low_quality_score');
}
if (highHallucination) {
  guardrailPass = false;
  violations.push('high_hallucination_risk');
}

$json.output_guardrail = {
  ...($json.output_guardrail ?? {}),
  guardrail_pass: guardrailPass,
  violations,
  risk_level: highHallucination ? 'high' : (lowQuality ? 'medium' : 'low'),
  hallucination_risk: review.hallucination_risk ?? 'unknown',
  action: guardrailPass ? 'pass' : 'revise',
};

return [{ json: $json }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Quality Gate',
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [2640, 100],
      parameters: {
        conditions: {
          boolean: [
            {
              value1: '={{$json.output_guardrail.guardrail_pass}}',
              value2: true,
            },
          ],
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Revision Counter',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2880, 180],
      parameters: {
        jsCode: `
$json.revision_count = Number($json.revision_count ?? 0) + 1;
$json.status = 'revision_requested';
$json.timestamps.updated_at = new Date().toISOString();

if ($json.revision_count > ($json.max_revision_attempts ?? 2)) {
  $json.status = 'failed';
  $json.supervisor = {
    ...($json.supervisor ?? {}),
    next_action: 'END_FAILED',
    reason: 'Max revisions exceeded.',
    decided_at: new Date().toISOString(),
  };
}

return [{ json: $json }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Need Human Approval',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1,
      position: [1920, 260],
      parameters: {
        workflowId: '={{$env.WF_APPROVAL_ID}}',
        options: {
          waitForSubWorkflow: true,
        },
      },
      notes: 'Set WF_APPROVAL_ID in n8n environment or switch to static workflow ID.',
      notesInFlow: true,
    }),
  );

  nodes.push(
    n({
      name: 'Approval Decision',
      type: 'n8n-nodes-base.switch',
      typeVersion: 1,
      position: [2160, 260],
      parameters: {
        dataType: 'string',
        value1: '={{$json.approval.status}}',
        rules: [
          { operation: 'equal', value2: 'approved' },
          { operation: 'equal', value2: 'rejected' },
          { operation: 'equal', value2: 'pending' },
        ],
        fallbackOutput: 3,
      },
    }),
  );

  nodes.push(
    n({
      name: 'Run Publish',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1,
      position: [1920, 420],
      parameters: {
        workflowId: '={{$env.WF_PUBLISH_ID}}',
        options: {
          waitForSubWorkflow: true,
        },
      },
      notes: 'Set WF_PUBLISH_ID in n8n environment or switch to static workflow ID.',
      notesInFlow: true,
    }),
  );

  nodes.push(
    n({
      name: 'Persist Final State',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [2160, 520],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Notify Result',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2400, 420],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.NOTIFICATION_WEBHOOK_URL || "https://example.com/hooks/content-status"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            {
              name: 'Content-Type',
              value: 'application/json',
            },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { run_id: $json.run_id, status: $json.status, topic: $json.topic, approval_status: $json.approval?.status, publish_status: $json.publish?.status, published_url: $json.publish?.url || null, updated_at: new Date().toISOString() } }}',
        options: {
          timeout: 30000,
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return API Response',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [2640, 420],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ $json.response || { run_id: $json.run_id, status: $json.status, topic: $json.topic, title: $json.title, approval_status: $json.approval?.status, publish_status: $json.publish?.status, published_url: $json.publish?.url || null, revision_count: $json.revision_count, updated_at: $json.timestamps?.updated_at } }}',
        options: {},
      },
    }),
  );

  connect(connections, 'Topic Intake', 0, 'Normalize Input');
  connect(connections, 'Normalize Input', 0, 'Init Run State');
  connect(connections, 'Init Run State', 0, 'Persist Run Created');
  connect(connections, 'Init Run State', 0, 'Input Rule Guardrail');
  connect(connections, 'Input Rule Guardrail', 0, 'Input AI Guardrail');
  connect(connections, 'Input AI Guardrail', 0, 'Input Allowed?');

  // Input allowed -> supervisor
  connect(connections, 'Input Allowed?', 0, 'Supervisor Decision');

  // Input blocked -> finalization
  connect(connections, 'Input Allowed?', 1, 'Persist Final State');
  connect(connections, 'Input Allowed?', 1, 'Notify Result');
  connect(connections, 'Input Allowed?', 1, 'Return API Response');

  connect(connections, 'Supervisor Decision', 0, 'Route Action');

  // Route outputs
  connect(connections, 'Route Action', 0, 'Run Research');
  connect(connections, 'Route Action', 1, 'Run Writing');
  connect(connections, 'Route Action', 2, 'Run Review');
  connect(connections, 'Route Action', 3, 'Revision Counter');
  connect(connections, 'Route Action', 4, 'Need Human Approval');
  connect(connections, 'Route Action', 5, 'Run Publish');

  // End branches
  connect(connections, 'Route Action', 6, 'Persist Final State');
  connect(connections, 'Route Action', 6, 'Notify Result');
  connect(connections, 'Route Action', 6, 'Return API Response');

  connect(connections, 'Route Action', 7, 'Persist Final State');
  connect(connections, 'Route Action', 7, 'Notify Result');
  connect(connections, 'Route Action', 7, 'Return API Response');

  connect(connections, 'Route Action', 8, 'Persist Final State');
  connect(connections, 'Route Action', 8, 'Notify Result');
  connect(connections, 'Route Action', 8, 'Return API Response');

  connect(connections, 'Route Action', 9, 'Persist Final State');
  connect(connections, 'Route Action', 9, 'Notify Result');
  connect(connections, 'Route Action', 9, 'Return API Response');

  connect(connections, 'Route Action', 10, 'Persist Final State');
  connect(connections, 'Route Action', 10, 'Notify Result');
  connect(connections, 'Route Action', 10, 'Return API Response');

  connect(connections, 'Run Research', 0, 'Persist After Research');
  connect(connections, 'Run Research', 0, 'Supervisor Decision');

  connect(connections, 'Run Writing', 0, 'Persist After Writing');
  connect(connections, 'Run Writing', 0, 'Supervisor Decision');

  connect(connections, 'Run Review', 0, 'Output Rule Guardrail');
  connect(connections, 'Output Rule Guardrail', 0, 'Output AI Guardrail');
  connect(connections, 'Output AI Guardrail', 0, 'Quality Gate');

  // Quality pass -> supervisor, fail -> revision
  connect(connections, 'Quality Gate', 0, 'Supervisor Decision');
  connect(connections, 'Quality Gate', 1, 'Revision Counter');

  connect(connections, 'Revision Counter', 0, 'Supervisor Decision');

  connect(connections, 'Need Human Approval', 0, 'Approval Decision');

  // Approved -> supervisor for publish decision
  connect(connections, 'Approval Decision', 0, 'Supervisor Decision');

  // Rejected -> finalize
  connect(connections, 'Approval Decision', 1, 'Persist Final State');
  connect(connections, 'Approval Decision', 1, 'Notify Result');
  connect(connections, 'Approval Decision', 1, 'Return API Response');

  // Pending -> loop approval workflow
  connect(connections, 'Approval Decision', 2, 'Need Human Approval');
  connect(connections, 'Approval Decision', 3, 'Need Human Approval');

  connect(connections, 'Run Publish', 0, 'Persist Final State');
  connect(connections, 'Run Publish', 0, 'Notify Result');
  connect(connections, 'Run Publish', 0, 'Return API Response');

  return wf('WF_Content_Orchestrator', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'orchestrator' }],
  });
}

function createResearchWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Search API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [240, 0],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.TAVILY_API_URL || "https://api.tavily.com/search"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '={{$env.TAVILY_API_KEY ? `Bearer ${$env.TAVILY_API_KEY}` : ""}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { query: $json.topic, max_results: 8, include_answer: false, search_depth: "advanced" } }}',
        options: {
          timeout: 45000,
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Research Synthesizer',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 0],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '={{`Bearer ${$env.OPENAI_API_KEY || ""}`}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ {
  model: $env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: 0.2,
  response_format: { type: 'json_object' },
  messages: [
    {
      role: 'system',
      content: 'You are ResearchAgent. Return ONLY JSON: {"research":{"notes":["string"],"sources":[{"title":"string","url":"string","snippet":"string"}],"citations":["string"],"gaps":["string"],"confidence":"high|medium|low"}}'
    },
    {
      role: 'user',
      content: JSON.stringify({
        topic: $items('Execute Workflow Trigger', 0, 0)[0].json.topic,
        search_results: $json,
      })
    }
  ]
} }`,
        options: {
          timeout: 60000,
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Merge Research Into State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 0],
      parameters: {
        jsCode: `
const state = $items('Execute Workflow Trigger', 0, 0)[0].json;

let parsed;
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {
    research: {
      notes: ['Research synthesis parser fallback triggered.'],
      sources: [],
      citations: [],
      gaps: ['AI parser fallback: inspect Search API response manually.'],
      confidence: 'low',
    },
  };
}

const research = parsed.research ?? {};
const merged = {
  ...state,
  status: 'researched',
  research: {
    notes: Array.isArray(research.notes) ? research.notes : [],
    sources: Array.isArray(research.sources) ? research.sources : [],
    citations: Array.isArray(research.citations) ? research.citations : [],
    gaps: Array.isArray(research.gaps) ? research.gaps : [],
    confidence: research.confidence ?? 'low',
  },
};
merged.timestamps = {
  ...(merged.timestamps ?? {}),
  updated_at: new Date().toISOString(),
};

return [{ json: merged }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Persist Research',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [960, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return Researched State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [960, 40],
      parameters: {
        jsCode: 'return items;',
      },
    }),
  );

  connect(connections, 'Execute Workflow Trigger', 0, 'Search API');
  connect(connections, 'Search API', 0, 'Research Synthesizer');
  connect(connections, 'Research Synthesizer', 0, 'Merge Research Into State');
  connect(connections, 'Merge Research Into State', 0, 'Persist Research');
  connect(connections, 'Merge Research Into State', 0, 'Return Researched State');

  return wf('WF_Research', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'research' }],
  });
}

function createWritingWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Writer Agent',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [240, 0],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '={{`Bearer ${$env.OPENAI_API_KEY || ""}`}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ {
  model: $env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: 0.4,
  response_format: { type: 'json_object' },
  messages: [
    {
      role: 'system',
      content: 'You are WriterAgent. Return ONLY JSON: {"title":"string","summary":"string","sections":[{"heading":"string","bullets":["string"]}],"markdown_content":"string"}. Use research notes only.'
    },
    {
      role: 'user',
      content: JSON.stringify($json)
    }
  ]
} }`,
        options: {
          timeout: 90000,
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Writer Format Validator',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [480, 0],
      parameters: {
        jsCode: `
const state = $items('Execute Workflow Trigger', 0, 0)[0].json;

let parsed;
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {};
}

const fallbackTitle = (state.topic ?? 'Untitled Topic') + ' - Practical Guide';
const fallbackSummary = 'Draft generated with fallback writer formatter. Please review before publishing.';
const fallbackSections = [
  { heading: 'Introduction', bullets: ['Context and problem statement'] },
  { heading: 'Core Concepts', bullets: ['Definitions', 'Comparisons'] },
  { heading: 'Implementation Guidance', bullets: ['Practical decisions'] },
  { heading: 'Conclusion', bullets: ['Key takeaways'] },
];

const markdown = (parsed.markdown_content ?? '').toString().trim();

const merged = {
  ...state,
  status: 'drafted',
  title: (parsed.title ?? fallbackTitle).toString(),
  summary: (parsed.summary ?? fallbackSummary).toString(),
  sections: Array.isArray(parsed.sections) && parsed.sections.length > 0 ? parsed.sections : fallbackSections,
  markdown_content: markdown || ('# ' + fallbackTitle + '\\n\\n' + fallbackSummary + '\\n\\n## Introduction\\n\\nDraft fallback content generated because writer output was empty.'),
};

merged.timestamps = {
  ...(merged.timestamps ?? {}),
  updated_at: new Date().toISOString(),
};

return [{ json: merged }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Persist Draft',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [720, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return Draft State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 40],
      parameters: {
        jsCode: 'return items;',
      },
    }),
  );

  connect(connections, 'Execute Workflow Trigger', 0, 'Writer Agent');
  connect(connections, 'Writer Agent', 0, 'Writer Format Validator');
  connect(connections, 'Writer Format Validator', 0, 'Persist Draft');
  connect(connections, 'Writer Format Validator', 0, 'Return Draft State');

  return wf('WF_Writing', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'writing' }],
  });
}

function createReviewWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Review Agent',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [240, 0],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '={{`Bearer ${$env.OPENAI_API_KEY || ""}`}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ {
  model: $env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: 0.1,
  response_format: { type: 'json_object' },
  messages: [
    {
      role: 'system',
      content: 'You are ReviewAgent. Return ONLY JSON: {"review":{"quality_score":0,"strengths":["string"],"feedback":["string"],"missing_sections":["string"],"policy_violations":["string"],"hallucination_risk":"low|medium|high","recommended_action":"approve_for_human|revise|reject"}}'
    },
    {
      role: 'user',
      content: JSON.stringify($json)
    }
  ]
} }`,
        options: {
          timeout: 60000,
        },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Review Gate Rules',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [480, 0],
      parameters: {
        jsCode: `
const state = $items('Execute Workflow Trigger', 0, 0)[0].json;

let parsed;
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {};
}

const review = parsed.review ?? {};
const quality = Number(review.quality_score ?? 0);
const missingSections = Array.isArray(review.missing_sections) ? review.missing_sections : [];
const policyViolations = Array.isArray(review.policy_violations) ? review.policy_violations : [];
const hallucinationRisk = review.hallucination_risk ?? 'medium';

const merged = {
  ...state,
  status: 'reviewed',
  review: {
    quality_score: Number.isFinite(quality) ? quality : 0,
    strengths: Array.isArray(review.strengths) ? review.strengths : [],
    feedback: Array.isArray(review.feedback) ? review.feedback : ['No feedback generated.'],
    missing_sections: missingSections,
    policy_violations: policyViolations,
    hallucination_risk: hallucinationRisk,
    recommended_action: review.recommended_action ?? (quality >= 80 && policyViolations.length === 0 ? 'approve_for_human' : 'revise'),
  },
};

merged.timestamps = {
  ...(merged.timestamps ?? {}),
  updated_at: new Date().toISOString(),
};

return [{ json: merged }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Persist Review',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [720, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return Reviewed State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 40],
      parameters: {
        jsCode: 'return items;',
      },
    }),
  );

  connect(connections, 'Execute Workflow Trigger', 0, 'Review Agent');
  connect(connections, 'Review Agent', 0, 'Review Gate Rules');
  connect(connections, 'Review Gate Rules', 0, 'Persist Review');
  connect(connections, 'Review Gate Rules', 0, 'Return Reviewed State');

  return wf('WF_Review', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'review' }],
  });
}

function createApprovalCallbackWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Approval Callback',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: randomUUID(),
      parameters: {
        httpMethod: 'POST',
        path: 'content-approval-callback',
        responseMode: 'responseNode',
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Validate token + decision',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      parameters: {
        jsCode: `
const payload = $json.body ?? $json;
const decisionRaw = (payload.decision ?? '').toString().toLowerCase();
const decision = decisionRaw === 'approve' ? 'approved' : (decisionRaw === 'reject' ? 'rejected' : 'pending');

const runId = (payload.run_id ?? '').toString();
const token = (payload.token ?? '').toString();

if (!runId || !token) {
  return [{
    json: {
      statusCode: 400,
      ok: false,
      message: 'run_id and token are required',
      decision: 'pending',
      run_id: runId,
    },
  }];
}

const approvedToken = ($env.APPROVAL_SHARED_SECRET ?? '').toString();
if (approvedToken && token !== approvedToken) {
  return [{
    json: {
      statusCode: 403,
      ok: false,
      message: 'Invalid approval token',
      decision: 'pending',
      run_id: runId,
    },
  }];
}

return [{
  json: {
    run_id: runId,
    decision,
    approver: (payload.approver ?? 'human-reviewer').toString(),
    comments: (payload.comments ?? '').toString(),
    channel: (payload.channel ?? 'webhook').toString(),
    decided_at: new Date().toISOString(),
    statusCode: 200,
    ok: true,
    message: 'Approval callback accepted',
  },
}];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Update approval state',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [480, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: `
UPDATE content_runs
SET
  state = jsonb_set(
    jsonb_set(
      jsonb_set(state, '{approval,status}', to_jsonb('{{$json.decision}}'::text), true),
      '{approval,approver}', to_jsonb('{{$json.approver}}'::text), true
    ),
    '{approval,decided_at}', to_jsonb('{{$json.decided_at}}'::text), true
  ),
  status = CASE WHEN '{{$json.decision}}' = 'approved' THEN 'approved_for_publish' WHEN '{{$json.decision}}' = 'rejected' THEN 'approval_rejected' ELSE status END,
  updated_at = NOW()
WHERE run_id = '{{$json.run_id}}';
        `.trim(),
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Approval Callback Response',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [480, 40],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ { ok: $json.ok, message: $json.message, run_id: $json.run_id, decision: $json.decision } }}',
        options: {
          responseCode: '={{$json.statusCode || 200}}',
        },
      },
    }),
  );

  connect(connections, 'Approval Callback', 0, 'Validate token + decision');
  connect(connections, 'Validate token + decision', 0, 'Update approval state');
  connect(connections, 'Validate token + decision', 0, 'Approval Callback Response');

  return wf('WF_Approval_Callback', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'approval' }],
  });
}

function createApprovalWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Generate approval token',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      parameters: {
        jsCode: `
const state = { ...$json };
const token = ($env.APPROVAL_SHARED_SECRET ?? Math.random().toString(36).slice(2, 12)).toString();
const callbackBase = ($env.APPROVAL_CALLBACK_URL ?? 'https://your-n8n-instance/webhook/content-approval-callback').toString();

state.approval = {
  ...(state.approval ?? {}),
  status: state.approval?.status && state.approval.status !== 'not_requested' ? state.approval.status : 'pending',
  token,
  callback_url: callbackBase,
  requested_at: new Date().toISOString(),
};
state.status = state.approval.status === 'approved' ? 'approved_for_publish' : 'awaiting_approval';
state.timestamps = {
  ...(state.timestamps ?? {}),
  updated_at: new Date().toISOString(),
};

return [{ json: state }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Persist pending approval',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [480, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Approval Channel',
      type: 'n8n-nodes-base.switch',
      typeVersion: 1,
      position: [480, 40],
      parameters: {
        dataType: 'string',
        value1: '={{$json.approval.channel || "slack"}}',
        rules: [
          { operation: 'equal', value2: 'slack' },
          { operation: 'equal', value2: 'email' },
          { operation: 'equal', value2: 'webhook' },
        ],
        fallbackOutput: 3,
      },
    }),
  );

  nodes.push(
    n({
      name: 'Send Slack Approval',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, -80],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.SLACK_APPROVAL_WEBHOOK_URL || "https://example.com/slack-webhook"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Content-Type', value: 'application/json' }],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { text: `Approval required for run ${$json.run_id}: ${$json.title || $json.topic}`, attachments: [{ text: `Approve: ${$json.approval.callback_url}?run_id=${$json.run_id}&decision=approve&token=${$json.approval.token}` }, { text: `Reject: ${$json.approval.callback_url}?run_id=${$json.run_id}&decision=reject&token=${$json.approval.token}` }] } }}',
        options: { timeout: 30000 },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Send Email Approval',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, 0],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.EMAIL_API_URL || "https://example.com/send-email"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Content-Type', value: 'application/json' }],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { to: $env.APPROVER_EMAIL || "editor@example.com", subject: `Approval needed: ${$json.title || $json.topic}`, html: `<p>Run: ${$json.run_id}</p><p><a href="${$json.approval.callback_url}?run_id=${$json.run_id}&decision=approve&token=${$json.approval.token}">Approve</a></p><p><a href="${$json.approval.callback_url}?run_id=${$json.run_id}&decision=reject&token=${$json.approval.token}">Reject</a></p>` } }}',
        options: { timeout: 30000 },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Send Webhook/Form Approval',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, 80],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.APPROVAL_FORM_DISPATCH_URL || "https://example.com/approval-form-dispatch"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Content-Type', value: 'application/json' }],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { run_id: $json.run_id, title: $json.title || $json.topic, summary: $json.summary, callback_url: $json.approval.callback_url, token: $json.approval.token } }}',
        options: { timeout: 30000 },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Wait 5m',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [960, 0],
      parameters: {
        resume: 'timeInterval',
        amount: 5,
        unit: 'minutes',
      },
    }),
  );

  nodes.push(
    n({
      name: 'Read approval state',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [1200, 0],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: `SELECT state FROM content_runs WHERE run_id = '{{$json.run_id}}' LIMIT 1;`,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Approval State Mapper',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1440, 0],
      parameters: {
        jsCode: `
const original = $items('Generate approval token', 0, 0)[0].json;
let state = null;

if (Array.isArray($json) && $json.length > 0 && $json[0].state) {
  state = $json[0].state;
} else if ($json.state) {
  state = $json.state;
}

if (typeof state === 'string') {
  try {
    state = JSON.parse(state);
  } catch (error) {
    state = null;
  }
}

const merged = state && typeof state === 'object'
  ? { ...original, ...state, approval: { ...(original.approval ?? {}), ...(state.approval ?? {}) } }
  : { ...original };

merged.approval = {
  ...(merged.approval ?? {}),
  status: merged.approval?.status ?? 'pending',
};

merged.timestamps = {
  ...(merged.timestamps ?? {}),
  updated_at: new Date().toISOString(),
};

return [{ json: merged }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Approved or Rejected?',
      type: 'n8n-nodes-base.switch',
      typeVersion: 1,
      position: [1680, 0],
      parameters: {
        dataType: 'string',
        value1: '={{$json.approval.status}}',
        rules: [
          { operation: 'equal', value2: 'approved' },
          { operation: 'equal', value2: 'rejected' },
          { operation: 'equal', value2: 'pending' },
        ],
        fallbackOutput: 3,
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return Approval State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1920, -80],
      parameters: {
        jsCode: `
const out = { ...$json };
out.status = out.approval?.status === 'approved' ? 'approved_for_publish' : (out.approval?.status === 'rejected' ? 'approval_rejected' : 'awaiting_approval');
out.timestamps = {
  ...(out.timestamps ?? {}),
  updated_at: new Date().toISOString(),
};
return [{ json: out }];
        `.trim(),
      },
    }),
  );

  connect(connections, 'Execute Workflow Trigger', 0, 'Generate approval token');
  connect(connections, 'Generate approval token', 0, 'Persist pending approval');
  connect(connections, 'Generate approval token', 0, 'Approval Channel');

  connect(connections, 'Approval Channel', 0, 'Send Slack Approval');
  connect(connections, 'Approval Channel', 1, 'Send Email Approval');
  connect(connections, 'Approval Channel', 2, 'Send Webhook/Form Approval');
  connect(connections, 'Approval Channel', 3, 'Send Slack Approval');

  connect(connections, 'Send Slack Approval', 0, 'Wait 5m');
  connect(connections, 'Send Email Approval', 0, 'Wait 5m');
  connect(connections, 'Send Webhook/Form Approval', 0, 'Wait 5m');

  connect(connections, 'Wait 5m', 0, 'Read approval state');
  connect(connections, 'Read approval state', 0, 'Approval State Mapper');
  connect(connections, 'Approval State Mapper', 0, 'Approved or Rejected?');

  connect(connections, 'Approved or Rejected?', 0, 'Return Approval State');
  connect(connections, 'Approved or Rejected?', 1, 'Return Approval State');
  connect(connections, 'Approved or Rejected?', 2, 'Wait 5m');
  connect(connections, 'Approved or Rejected?', 3, 'Wait 5m');

  return wf('WF_Approval', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'approval' }],
  });
}

function createPublishWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Platform Route',
      type: 'n8n-nodes-base.switch',
      typeVersion: 1,
      position: [240, 0],
      parameters: {
        dataType: 'string',
        value1: '={{($json.platform || $json.publish?.platform || "devto").toLowerCase()}}',
        rules: [
          { operation: 'equal', value2: 'devto' },
          { operation: 'equal', value2: 'hashnode' },
          { operation: 'equal', value2: 'ghost' },
        ],
        fallbackOutput: 3,
      },
    }),
  );

  nodes.push(
    n({
      name: 'Publish to Dev.to',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, -120],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.DEVTO_API_URL || "https://dev.to/api/articles"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'api-key', value: '={{$env.DEVTO_API_KEY || ""}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { article: { title: $json.title, published: true, body_markdown: $json.markdown_content, tags: ["oauth","security","sso"] } } }}',
        options: { timeout: 45000 },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Publish to Hashnode',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 0],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.HASHNODE_API_URL || "https://gql.hashnode.com"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '={{$env.HASHNODE_API_KEY ? `Bearer ${$env.HASHNODE_API_KEY}` : ""}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { query: "mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }", variables: { input: { title: $json.title, contentMarkdown: $json.markdown_content, publicationId: $env.HASHNODE_PUBLICATION_ID || "" } } } }}',
        options: { timeout: 45000 },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Publish to Ghost',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 120],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.GHOST_API_URL || "https://your-ghost-site/ghost/api/admin/posts/?source=html"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '={{`Ghost ${$env.GHOST_ADMIN_TOKEN || ""}`}}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { posts: [{ title: $json.title, html: $json.markdown_content, status: "published" }] } }}',
        options: { timeout: 45000 },
      },
    }),
  );

  nodes.push(
    n({
      name: 'Normalize publish response',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 0],
      parameters: {
        jsCode: `
const state = $items('Execute Workflow Trigger', 0, 0)[0].json;
let response = $json;

// Detect which node produced this payload.
const fromDevto = typeof response?.id !== 'undefined' && typeof response?.url === 'string';
const fromHashnode = response?.data?.publishPost?.post;
const fromGhost = response?.posts?.[0];

let url = '';
let articleId = '';
let status = 'publish_failed';

if (fromDevto) {
  url = response.url ?? '';
  articleId = String(response.id ?? '');
  status = url ? 'published' : 'publish_failed';
} else if (fromHashnode) {
  url = fromHashnode.url ?? '';
  articleId = String(fromHashnode.id ?? '');
  status = url ? 'published' : 'publish_failed';
} else if (fromGhost) {
  url = fromGhost.url ?? '';
  articleId = String(fromGhost.id ?? '');
  status = articleId ? 'published' : 'publish_failed';
}

const merged = {
  ...state,
  status: status === 'published' ? 'published' : 'publish_failed',
  publish: {
    ...(state.publish ?? {}),
    status,
    platform: state.platform ?? state.publish?.platform ?? 'devto',
    url,
    article_id: articleId,
    published_at: status === 'published' ? new Date().toISOString() : '',
    provider_response: response,
  },
};

merged.timestamps = {
  ...(merged.timestamps ?? {}),
  updated_at: new Date().toISOString(),
  finished_at: status === 'published' ? new Date().toISOString() : merged.timestamps?.finished_at ?? '',
};

return [{ json: merged }];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Persist publish',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [960, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: upsertRunQuery,
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return Published State',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [960, 40],
      parameters: {
        jsCode: 'return items;',
      },
    }),
  );

  connect(connections, 'Execute Workflow Trigger', 0, 'Platform Route');
  connect(connections, 'Platform Route', 0, 'Publish to Dev.to');
  connect(connections, 'Platform Route', 1, 'Publish to Hashnode');
  connect(connections, 'Platform Route', 2, 'Publish to Ghost');
  connect(connections, 'Platform Route', 3, 'Publish to Dev.to');

  connect(connections, 'Publish to Dev.to', 0, 'Normalize publish response');
  connect(connections, 'Publish to Hashnode', 0, 'Normalize publish response');
  connect(connections, 'Publish to Ghost', 0, 'Normalize publish response');

  connect(connections, 'Normalize publish response', 0, 'Persist publish');
  connect(connections, 'Normalize publish response', 0, 'Return Published State');

  return wf('WF_Publish', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'publish' }],
  });
}

function createLoggingWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Build Log Event',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      parameters: {
        jsCode: `
const now = new Date().toISOString();
const payload = $json.payload ?? $json;

return [{
  json: {
    run_id: payload.run_id ?? 'unknown',
    stage: payload.stage ?? 'unknown',
    level: payload.level ?? 'info',
    message: payload.message ?? 'workflow event',
    payload,
    created_at: now,
  },
}];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Insert Event Log',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [480, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: `
INSERT INTO content_events (run_id, stage, level, message, payload)
VALUES (
  '{{$json.run_id}}',
  '{{$json.stage}}',
  '{{$json.level}}',
  '{{$json.message}}',
  '{{ JSON.stringify($json.payload).replace(/'/g, "''") }}'::jsonb
);
        `.trim(),
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Return Logged Event',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [480, 40],
      parameters: {
        jsCode: 'return items;',
      },
    }),
  );

  connect(connections, 'Execute Workflow Trigger', 0, 'Build Log Event');
  connect(connections, 'Build Log Event', 0, 'Insert Event Log');
  connect(connections, 'Build Log Event', 0, 'Return Logged Event');

  return wf('WF_Log_Event', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'logging' }],
  });
}

function createErrorHandlerWorkflow() {
  const nodes = [];
  const connections = {};

  nodes.push(
    n({
      name: 'Error Trigger',
      type: 'n8n-nodes-base.errorTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
  );

  nodes.push(
    n({
      name: 'Build Error Event',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 0],
      parameters: {
        jsCode: `
const err = $json.execution?.error ?? $json.error ?? {};
const runId = $json.execution?.id ? String($json.execution.id) : 'unknown';

return [{
  json: {
    run_id: runId,
    stage: 'workflow_error',
    level: 'error',
    message: err.message ?? 'Unhandled workflow error',
    payload: {
      workflow: $json.workflow ?? null,
      error: err,
      execution: $json.execution ?? null,
    },
    created_at: new Date().toISOString(),
  },
}];
        `.trim(),
      },
    }),
  );

  nodes.push(
    n({
      name: 'Insert Error Log',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [480, -120],
      continueOnFail: true,
      parameters: {
        operation: 'executeQuery',
        query: `
INSERT INTO content_events (run_id, stage, level, message, payload)
VALUES (
  '{{$json.run_id}}',
  '{{$json.stage}}',
  '{{$json.level}}',
  '{{$json.message}}',
  '{{ JSON.stringify($json.payload).replace(/'/g, "''") }}'::jsonb
);
        `.trim(),
        options: {},
      },
    }),
  );

  nodes.push(
    n({
      name: 'Alert Ops Channel',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 40],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{$env.ERROR_ALERT_WEBHOOK_URL || "https://example.com/hooks/workflow-errors"}}',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Content-Type', value: 'application/json' }],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ { run_id: $json.run_id, stage: $json.stage, level: $json.level, message: $json.message, created_at: $json.created_at } }}',
        options: {
          timeout: 30000,
        },
      },
    }),
  );

  connect(connections, 'Error Trigger', 0, 'Build Error Event');
  connect(connections, 'Build Error Event', 0, 'Insert Error Log');
  connect(connections, 'Build Error Event', 0, 'Alert Ops Channel');

  return wf('WF_Error_Handler', nodes, connections, {
    tags: [{ name: 'content-ai' }, { name: 'ops' }],
  });
}

const workflows = [
  createMainWorkflow(),
  createResearchWorkflow(),
  createWritingWorkflow(),
  createReviewWorkflow(),
  createApprovalWorkflow(),
  createApprovalCallbackWorkflow(),
  createPublishWorkflow(),
  createLoggingWorkflow(),
  createErrorHandlerWorkflow(),
];

function applyCompatibilityFixes(flows) {
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

  for (const wf of flows) {
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
}

applyCompatibilityFixes(workflows);

for (const flow of workflows) {
  const fileName = `${flow.name}.json`;
  writeFileSync(join(outDir, fileName), `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
}

writeFileSync(join(outDir, 'bundle.workflows.json'), `${JSON.stringify(workflows, null, 2)}\n`, 'utf8');

console.log(`Generated ${workflows.length} workflow files + bundle at ${outDir}`);

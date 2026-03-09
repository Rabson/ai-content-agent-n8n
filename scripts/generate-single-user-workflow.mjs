import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'workflows');
mkdirSync(outDir, { recursive: true });

const nowIso = new Date().toISOString();
const WORKFLOW_ID = 'Xlc6ZFLdozHji7p7';
const WORKFLOW_NAME = 'WF_Content_Orchestrator';
const POSTGRES_CREDENTIAL_ID = 'f3dc8f0f-1f70-47f5-bf25-10b0d2e55111';
const POSTGRES_CREDENTIAL_NAME = 'Local Postgres (n8n)';

function n({
  name,
  type,
  parameters = {},
  position = [0, 0],
  typeVersion = 1,
  continueOnFail = false,
  webhookId,
  credentials,
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
  if (webhookId) node.webhookId = webhookId;
  if (credentials) node.credentials = credentials;
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

function pgCredentials() {
  return {
    postgres: {
      id: POSTGRES_CREDENTIAL_ID,
      name: POSTGRES_CREDENTIAL_NAME,
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
    name: 'Normalize Discovery Input',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [240, 0],
    parameters: {
      jsCode: `
const payload = $json.body ?? $json;
const manualTopic = (payload.topic ?? '').toString().trim();
const modeRaw = (payload.discovery_mode ?? (manualTopic ? 'manual' : 'api')).toString().toLowerCase();
const mode = modeRaw === 'api' ? 'api' : 'manual';
const requester = (payload.requester ?? 'single_user').toString();
const source = (payload.source ?? 'api').toString();
const discoveryQuery = (payload.discovery_query ?? manualTopic ?? 'authentication and identity').toString().trim();
const now = new Date().toISOString();
const runId = Date.now() + '-' + Math.random().toString(36).slice(2, 10);

const state = {
  run_id: runId,
  idempotency_key: (payload.idempotency_key ?? ('run-' + runId)).toString(),
  status: 'discovery_ready',
  requester,
  source,
  topic: '',
  title: '',
  summary: '',
  markdown_content: '',
  discovery: {
    mode,
    query: discoveryQuery,
    third_party_provider: (payload.third_party_provider ?? 'tavily').toString(),
    topic_candidates: [],
    scored_topics: [],
    blocked_topics: [],
    selected_topic: '',
    selected_score: 0,
  },
  research: {
    notes: [],
    sources: [],
    citations: [],
    confidence: 'unknown',
  },
  review: {
    approved: false,
    score: 0,
    rationale: '',
    risks: [],
    improvements: [],
  },
  publish: {
    devto: { status: 'not_started', url: '', article_id: '', provider_response: {} },
    medium: { status: 'not_started', url: '', article_id: '', provider_response: {} },
  },
  linkedin: {
    summary: '',
    hashtags: [],
  },
  response: {},
  timestamps: {
    created_at: now,
    updated_at: now,
    finished_at: '',
  },
};

if (mode === 'manual') {
  if (!manualTopic) {
    state.status = 'rejected_input';
    state.response = {
      run_id: state.run_id,
      status: state.status,
      message: 'When discovery_mode=manual, topic is required.',
    };
    state.timestamps.finished_at = now;
  } else {
    const normalized = manualTopic.replace(/\\s+/g, ' ').trim();
    state.discovery.topic_candidates = [
      {
        topic: normalized,
        source: 'manual',
        reason: 'Provided directly by user.',
      },
    ];
  }
}

return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Discovery Source Router',
    type: 'n8n-nodes-base.switch',
    typeVersion: 2,
    position: [480, 0],
    parameters: {
      dataType: 'string',
      value1: '={{$json.discovery.mode}}',
      rules: {
        rules: [
          { operation: 'equal', value2: 'manual', outputKey: '0' },
          { operation: 'equal', value2: 'api', outputKey: '1' },
        ],
      },
      mode: 'rules',
      options: {
        fallbackOutput: 0,
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Fetch Topics API',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [720, 120],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.TOPIC_DISCOVERY_API_URL || "https://api.tavily.com/search"}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Authorization', value: '={{$env.TOPIC_DISCOVERY_API_KEY ? ("Bearer " + $env.TOPIC_DISCOVERY_API_KEY) : ""}}' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ { api_key: $env.TOPIC_DISCOVERY_API_KEY || "", query: $items("Normalize Discovery Input", 0, 0)[0].json.discovery.query, max_results: 12 } }}',
      options: {
        timeout: 45000,
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Build API Topic Candidates',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [960, 120],
    parameters: {
      jsCode: `
const state = { ...$items('Normalize Discovery Input', 0, 0)[0].json };
const response = $json ?? {};

const results = Array.isArray(response.results) ? response.results : [];
const candidates = [];

for (const item of results) {
  const title = (item.title ?? '').toString().trim();
  const content = (item.content ?? '').toString().trim();
  const topic = title || content.slice(0, 120);
  if (!topic) continue;
  candidates.push({
    topic: topic.replace(/\\s+/g, ' ').trim(),
    source: 'third_party_api',
    reason: (item.url ?? 'external source').toString(),
  });
}

if (candidates.length === 0 && state.discovery.query) {
  candidates.push({
    topic: state.discovery.query,
    source: 'query_fallback',
    reason: 'No discovery results returned by API.',
  });
}

state.discovery.topic_candidates = candidates;
state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Filter & Score Topics',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1200, 0],
    parameters: {
      jsCode: `
const state = { ...$json };
const query = (state.discovery?.query ?? '').toLowerCase();
const candidates = Array.isArray(state.discovery?.topic_candidates) ? state.discovery.topic_candidates : [];

const blockedPatterns = [
  /\\b(malware|ransomware|keylogger|botnet|trojan builder)\\b/i,
  /\\b(exploit zero day|bypass firewall|credential stuffing|phishing kit|sql injection payload)\\b/i,
  /\\b(fake medical|fabricate diagnosis|unsafe dosage|pretend doctor advice)\\b/i,
  /\\b(plagiarize|copy exact article|rewrite this to avoid plagiarism checker)\\b/i,
];

const scored = [];
const blocked = [];
for (const candidate of candidates) {
  const topic = (candidate.topic ?? '').toString().replace(/\\s+/g, ' ').trim();
  if (!topic) continue;
  if (topic.length < 12) continue;

  if (blockedPatterns.some((re) => re.test(topic))) {
    blocked.push(topic);
    continue;
  }

  let score = 20;
  if (candidate.source === 'manual') score += 35;
  if (topic.length >= 20 && topic.length <= 90) score += 15;

  const queryTerms = query.split(/\\s+/).filter(Boolean);
  for (const term of queryTerms) {
    if (term.length > 3 && topic.toLowerCase().includes(term)) score += 4;
  }

  if (/\\b(vs|comparison|guide|best practices|architecture|checklist|tutorial)\\b/i.test(topic)) score += 12;
  if (/\\b(oauth|oidc|sso|jwt|auth|security|api)\\b/i.test(topic)) score += 10;

  scored.push({
    topic,
    source: candidate.source ?? 'unknown',
    reason: candidate.reason ?? '',
    score,
  });
}

scored.sort((a, b) => b.score - a.score);
const selected = scored[0] ?? null;

state.discovery.scored_topics = scored.slice(0, 10);
state.discovery.blocked_topics = blocked;
state.discovery.selected_topic = selected?.topic ?? '';
state.discovery.selected_score = selected?.score ?? 0;
state.topic = selected?.topic ?? '';

if (selected) {
  state.status = 'topic_selected';
} else {
  state.status = 'no_topic_selected';
  state.response = {
    run_id: state.run_id,
    status: state.status,
    message: 'No viable topic after filtering and scoring.',
    blocked_topics: blocked,
  };
  state.timestamps.finished_at = new Date().toISOString();
}

state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Topic Selected?',
    type: 'n8n-nodes-base.if',
    typeVersion: 1,
    position: [1440, 0],
    parameters: {
      conditions: {
        string: [
          {
            value1: '={{$json.status}}',
            operation: 'equal',
            value2: 'topic_selected',
          },
        ],
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Persist After Discovery',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [1680, -160],
    continueOnFail: true,
    credentials: pgCredentials(),
    parameters: {
      operation: 'executeQuery',
      query: upsertRunQuery,
      options: {},
    },
  }),
);

nodes.push(
  n({
    name: 'Topic Research Search',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1920, -160],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.TAVILY_API_URL || "https://api.tavily.com/search"}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ { api_key: $env.TAVILY_API_KEY || "", query: $json.topic, max_results: 10 } }}',
      options: {
        timeout: 45000,
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Topic Research Synthesizer',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2160, -160],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: '={{"Bearer " + ($env.OPENAI_API_KEY || "")}}' },
          { name: 'Content-Type', value: 'application/json' },
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
      content: 'Return ONLY JSON: {"research":{"notes":["string"],"sources":[{"title":"string","url":"string","snippet":"string"}],"citations":["string"],"confidence":"high|medium|low"}}'
    },
    {
      role: 'user',
      content: JSON.stringify({ topic: ($node["Topic Selected?"] && $node["Topic Selected?"].json && $node["Topic Selected?"].json.topic) || "", search_results: $json })
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
    name: 'Merge Topic Research',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2400, -160],
    parameters: {
      jsCode: `
const state = { ...(($node['Topic Selected?'] && $node['Topic Selected?'].json) || {}) };
let parsed = {};
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {};
}
if (!state.timestamps || typeof state.timestamps !== 'object') state.timestamps = {};

const research = parsed.research ?? {};
state.status = 'researched';
state.research = {
  notes: Array.isArray(research.notes) ? research.notes : [],
  sources: Array.isArray(research.sources) ? research.sources : [],
  citations: Array.isArray(research.citations) ? research.citations : [],
  confidence: research.confidence ?? 'low',
};
state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Topic Review Agent',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2640, -160],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: '={{"Bearer " + ($env.OPENAI_API_KEY || "")}}' },
          { name: 'Content-Type', value: 'application/json' },
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
      content: 'Return ONLY JSON: {"review":{"approved":true,"score":0,"rationale":"string","risks":["string"],"improvements":["string"]}}'
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
    name: 'Merge Topic Review',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2880, -160],
    parameters: {
      jsCode: `
const state = { ...(($node['Merge Topic Research'] && $node['Merge Topic Research'].json) || {}) };
let parsed = {};
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {};
}
if (!state.timestamps || typeof state.timestamps !== 'object') state.timestamps = {};

const review = parsed.review ?? {};
const score = Number(review.score ?? 0);
state.status = 'reviewed';
state.review = {
  approved: Boolean(review.approved),
  score: Number.isFinite(score) ? score : 0,
  rationale: (review.rationale ?? '').toString(),
  risks: Array.isArray(review.risks) ? review.risks : [],
  improvements: Array.isArray(review.improvements) ? review.improvements : [],
};

state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Topic Review Pass?',
    type: 'n8n-nodes-base.if',
    typeVersion: 1,
    position: [3120, -160],
    parameters: {
      conditions: {
        boolean: [
          {
            value1: '={{$json.review.approved && ($json.review.score || 0) >= 70}}',
            value2: true,
            operation: 'equal',
          },
        ],
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Mark Topic Rejected',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [3360, 20],
    parameters: {
      jsCode: `
if (!$json.timestamps || typeof $json.timestamps !== 'object') $json.timestamps = {};
$json.status = 'topic_rejected';
$json.response = {
  run_id: $json.run_id,
  status: $json.status,
  topic: $json.topic,
  review: $json.review,
  message: 'Topic review did not pass quality threshold.',
};
$json.timestamps.updated_at = new Date().toISOString();
$json.timestamps.finished_at = new Date().toISOString();
return [{ json: $json }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Draft Article Agent',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [3360, -300],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: '={{"Bearer " + ($env.OPENAI_API_KEY || "")}}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ {
  model: $env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: 0.35,
  response_format: { type: 'json_object' },
  messages: [
    {
      role: 'system',
      content: 'Return ONLY JSON: {"title":"string","summary":"string","markdown_content":"string"}'
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
    name: 'Merge Draft Article',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [3600, -300],
    parameters: {
      jsCode: `
const state = { ...(($node['Merge Topic Review'] && $node['Merge Topic Review'].json) || {}) };
let parsed = {};
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {};
}
if (!state.timestamps || typeof state.timestamps !== 'object') state.timestamps = {};

const fallbackTitle = (state.topic || 'Untitled Topic') + ' - Practical Guide';
const fallbackSummary = 'Auto-generated summary.';
const fallbackMarkdown = '# ' + fallbackTitle + '\\n\\n' + fallbackSummary;

state.title = (parsed.title ?? fallbackTitle).toString();
state.summary = (parsed.summary ?? fallbackSummary).toString();
state.markdown_content = (parsed.markdown_content ?? '').toString().trim() || fallbackMarkdown;
state.status = 'draft_ready_for_publish';
state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Publish to Dev.to',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [3840, -420],
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
      jsonBody: '={{ { article: { title: $json.title, published: true, body_markdown: $json.markdown_content, tags: ["n8n","ai","blog"] } } }}',
      options: {
        timeout: 45000,
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Merge Dev.to Publish Result',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [4080, -420],
    parameters: {
      jsCode: `
const state = { ...(($node['Merge Draft Article'] && $node['Merge Draft Article'].json) || {}) };
const response = $json ?? {};
if (!state.timestamps || typeof state.timestamps !== 'object') state.timestamps = {};
if (!state.publish || typeof state.publish !== 'object') state.publish = {};
if (!state.publish.devto || typeof state.publish.devto !== 'object') state.publish.devto = {};

const url = (response.url ?? '').toString();
const articleId = response.id != null ? String(response.id) : '';
state.publish.devto = {
  status: url ? 'published' : 'publish_failed',
  url,
  article_id: articleId,
  provider_response: response,
};
state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Publish to Medium',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [4320, -420],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.MEDIUM_API_URL || ("https://api.medium.com/v1/users/" + ($env.MEDIUM_USER_ID || "") + "/posts")}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Authorization', value: '={{"Bearer " + ($env.MEDIUM_ACCESS_TOKEN || "")}}' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ { title: $json.title, contentFormat: "markdown", content: $json.markdown_content, publishStatus: "public", tags: ["n8n","ai","content"] } }}',
      options: {
        timeout: 45000,
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Merge Medium Publish Result',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [4560, -420],
    parameters: {
      jsCode: `
const state = { ...(($node['Merge Dev.to Publish Result'] && $node['Merge Dev.to Publish Result'].json) || {}) };
const response = $json ?? {};
const data = response.data ?? response;
if (!state.timestamps || typeof state.timestamps !== 'object') state.timestamps = {};
if (!state.publish || typeof state.publish !== 'object') state.publish = {};
if (!state.publish.medium || typeof state.publish.medium !== 'object') state.publish.medium = {};

const url = (data.url ?? data.canonicalUrl ?? '').toString();
const articleId = data.id != null ? String(data.id) : '';
state.publish.medium = {
  status: url || articleId ? 'published' : 'publish_failed',
  url,
  article_id: articleId,
  provider_response: response,
};
state.timestamps.updated_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Generate LinkedIn Summary',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [4800, -420],
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{$env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions"}}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: '={{"Bearer " + ($env.OPENAI_API_KEY || "")}}' },
          { name: 'Content-Type', value: 'application/json' },
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
      content: 'Return ONLY JSON: {"linkedin_summary":"string","hashtags":["string"]}'
    },
    {
      role: 'user',
      content: JSON.stringify({ topic: $json.topic, title: $json.title, summary: $json.summary })
    }
  ]
} }`,
      options: {
        timeout: 45000,
      },
    },
  }),
);

nodes.push(
  n({
    name: 'Merge LinkedIn Summary',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [5040, -420],
    parameters: {
      jsCode: `
const state = { ...(($node['Merge Medium Publish Result'] && $node['Merge Medium Publish Result'].json) || {}) };
let parsed = {};
try {
  const content = $json.choices?.[0]?.message?.content ?? '{}';
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (error) {
  parsed = {};
}
if (!state.timestamps || typeof state.timestamps !== 'object') state.timestamps = {};
if (!state.publish || typeof state.publish !== 'object') state.publish = {};
if (!state.publish.devto || typeof state.publish.devto !== 'object') state.publish.devto = {};
if (!state.publish.medium || typeof state.publish.medium !== 'object') state.publish.medium = {};
if (!state.review || typeof state.review !== 'object') state.review = {};

state.linkedin = {
  summary: (parsed.linkedin_summary ?? '').toString(),
  hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
};

const devtoOk = state.publish?.devto?.status === 'published';
const mediumOk = state.publish?.medium?.status === 'published';
state.status = devtoOk || mediumOk ? 'published' : 'publish_failed';

state.response = {
  run_id: state.run_id,
  status: state.status,
  selected_topic: state.topic,
  review_score: state.review?.score ?? 0,
  devto_url: state.publish?.devto?.url || null,
  medium_url: state.publish?.medium?.url || null,
  linkedin_summary: state.linkedin.summary || '',
};

state.timestamps.updated_at = new Date().toISOString();
state.timestamps.finished_at = new Date().toISOString();
return [{ json: state }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Mark No Topic Selected',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1680, 160],
    parameters: {
      jsCode: `
if (!$json.timestamps || typeof $json.timestamps !== 'object') $json.timestamps = {};
$json.status = 'no_topic_selected';
$json.response = $json.response || {
  run_id: $json.run_id,
  status: $json.status,
  message: 'No topic selected after filtering and scoring.',
};
$json.timestamps.updated_at = new Date().toISOString();
$json.timestamps.finished_at = new Date().toISOString();
return [{ json: $json }];
      `.trim(),
    },
  }),
);

nodes.push(
  n({
    name: 'Persist Final State',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [5280, -120],
    continueOnFail: true,
    credentials: pgCredentials(),
    parameters: {
      operation: 'executeQuery',
      query: upsertRunQuery,
      options: {},
    },
  }),
);

nodes.push(
  n({
    name: 'Return API Response',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1,
    position: [5520, -120],
    parameters: {
      respondWith: 'json',
      responseBody: '={{$json.response}}',
      options: {},
    },
  }),
);

connect(connections, 'Topic Intake', 0, 'Normalize Discovery Input');
connect(connections, 'Normalize Discovery Input', 0, 'Discovery Source Router');
connect(connections, 'Discovery Source Router', 0, 'Filter & Score Topics');
connect(connections, 'Discovery Source Router', 1, 'Fetch Topics API');
connect(connections, 'Fetch Topics API', 0, 'Build API Topic Candidates');
connect(connections, 'Build API Topic Candidates', 0, 'Filter & Score Topics');
connect(connections, 'Filter & Score Topics', 0, 'Topic Selected?');
connect(connections, 'Topic Selected?', 0, 'Persist After Discovery');
connect(connections, 'Topic Selected?', 1, 'Mark No Topic Selected');
connect(connections, 'Mark No Topic Selected', 0, 'Persist Final State');
connect(connections, 'Mark No Topic Selected', 0, 'Return API Response');
connect(connections, 'Topic Selected?', 0, 'Topic Research Search');
connect(connections, 'Topic Research Search', 0, 'Topic Research Synthesizer');
connect(connections, 'Topic Research Synthesizer', 0, 'Merge Topic Research');
connect(connections, 'Merge Topic Research', 0, 'Topic Review Agent');
connect(connections, 'Topic Review Agent', 0, 'Merge Topic Review');
connect(connections, 'Merge Topic Review', 0, 'Topic Review Pass?');
connect(connections, 'Topic Review Pass?', 0, 'Draft Article Agent');
connect(connections, 'Topic Review Pass?', 1, 'Mark Topic Rejected');
connect(connections, 'Mark Topic Rejected', 0, 'Persist Final State');
connect(connections, 'Mark Topic Rejected', 0, 'Return API Response');
connect(connections, 'Draft Article Agent', 0, 'Merge Draft Article');
connect(connections, 'Merge Draft Article', 0, 'Publish to Dev.to');
connect(connections, 'Publish to Dev.to', 0, 'Merge Dev.to Publish Result');
connect(connections, 'Merge Dev.to Publish Result', 0, 'Publish to Medium');
connect(connections, 'Publish to Medium', 0, 'Merge Medium Publish Result');
connect(connections, 'Merge Medium Publish Result', 0, 'Generate LinkedIn Summary');
connect(connections, 'Generate LinkedIn Summary', 0, 'Merge LinkedIn Summary');
connect(connections, 'Merge LinkedIn Summary', 0, 'Persist Final State');
connect(connections, 'Merge LinkedIn Summary', 0, 'Return API Response');

const workflow = {
  id: WORKFLOW_ID,
  name: WORKFLOW_NAME,
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    saveExecutionProgress: true,
    saveManualExecutions: true,
    timezone: 'UTC',
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

writeFileSync(join(outDir, `${WORKFLOW_NAME}.json`), `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
writeFileSync(join(outDir, 'bundle.workflows.json'), `${JSON.stringify([workflow], null, 2)}\n`, 'utf8');

console.log(`Generated single-user workflow at ${outDir}/${WORKFLOW_NAME}.json and bundle.workflows.json`);

// Declarative test dataset for the Confluence DC test environment.
//
// Each space has a homepage (created by Confluence) whose body is replaced with
// `home`, and a tree of pages under it. Page titles are unique per space, which
// is how the seeder stays idempotent.
//
// Node shape: { title, body?: string | (ctx) => string, labels?, attachments?, children? }
// ctx = { userKey } (the admin's user key, for mentions)

// ---- storage-format helpers -------------------------------------------------
const macro = (name, params = {}, inner = '') =>
  `<ac:structured-macro ac:name="${name}">${Object.entries(params)
    .map(([k, v]) => `<ac:parameter ac:name="${k}">${v}</ac:parameter>`)
    .join('')}${inner}</ac:structured-macro>`;
const rich = (html) => `<ac:rich-text-body>${html}</ac:rich-text-body>`;
const plain = (text) => `<ac:plain-text-body><![CDATA[${text}]]></ac:plain-text-body>`;
const panel = (type, title, html) => macro(type, title ? { title } : {}, rich(html));
const code = (language, text, title) => macro('code', { language, ...(title ? { title } : {}) }, plain(text));
const status = (colour, title) => macro('status', { colour, title });
const link = (title, spaceKey) =>
  `<ac:link><ri:page${spaceKey ? ` ri:space-key="${spaceKey}"` : ''} ri:content-title="${title}" /></ac:link>`;
const image = (filename) => `<ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
const mention = (userKey) => `<ac:link><ri:user ri:userkey="${userKey}" /></ac:link>`;
const table = (header, rows) =>
  `<table><tbody><tr>${header.map((h) => `<th>${h}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
const tasks = (items) =>
  `<ac:task-list>${items
    .map(([done, text]) => `<ac:task><ac:task-status>${done ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${text}</ac:task-body></ac:task>`)
    .join('')}</ac:task-list>`;
const para = (...lines) => lines.map((l) => `<p>${l}</p>`).join('');

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const png = (filename) => ({ filename, content: PNG, type: 'image/png' });
const text = (filename, content) => ({ filename, content: Buffer.from(content), type: 'text/plain' });

// ---- generators ----------------------------------------------------------------
const service = (name, lang, team) => ({
  title: `${name} Service`,
  labels: ['service', name.toLowerCase()],
  body: para(`The ${name} service is owned by ${team}.`) + table(['Field', 'Value'], [['Language', lang], ['Tier', '1'], ['Status', status('Green', 'LIVE')]]),
  children: [
    {
      title: `${name} API Reference`,
      labels: ['api'],
      body:
        `<h2>Endpoints</h2>` +
        table(['Method', 'Path', 'Description'], [['GET', `/v2/${name.toLowerCase()}`, 'List'], ['POST', `/v2/${name.toLowerCase()}`, 'Create'], ['DELETE', `/v2/${name.toLowerCase()}/{id}`, 'Remove']]) +
        code('bash', `curl -H "Authorization: Bearer $TOKEN" https://api.example.test/v2/${name.toLowerCase()}`),
    },
    {
      title: `${name} Runbook`,
      labels: ['runbook'],
      body: panel('warning', 'Paging policy', para('Page the owning team before restarting.')) + `<ol><li>Check dashboards</li><li>Drain traffic</li><li>Restart pods</li></ol>`,
    },
    {
      title: `${name} Changelog`,
      body: `<h2>v2.1.0</h2><ul><li>Added pagination</li></ul><h2>v2.0.0</h2><ul><li>Breaking: renamed fields</li></ul>`,
    },
  ],
});

const adr = (n, title, state) => ({
  title: `ADR-${String(n).padStart(3, '0')}: ${title}`,
  labels: ['adr'],
  body:
    para(`Status: ${status(state === 'Accepted' ? 'Green' : state === 'Superseded' ? 'Grey' : 'Yellow', state.toUpperCase())}`) +
    `<h2>Context</h2>` + para(`Why we needed to decide on ${title.toLowerCase()}.`) +
    `<h2>Decision</h2>` + para(`We chose option ${n % 3 === 0 ? 'C' : n % 2 === 0 ? 'B' : 'A'}.`) +
    `<h2>Consequences</h2><ul><li>Positive outcome</li><li>Trade-off accepted</li></ul>`,
});

const incident = (id, title, sev) => ({
  title: `INC-${id}: ${title}`,
  labels: ['incident', `sev${sev}`],
  body:
    macro('toc', {}) +
    `<h2>Summary</h2>` + para(`${title}. Severity ${status(sev === 1 ? 'Red' : 'Yellow', `SEV${sev}`)}.`) +
    `<h2>Timeline</h2>` + table(['Time (UTC)', 'Event'], [['09:00', 'Alert fired'], ['09:07', 'Incident declared'], ['10:15', 'Mitigated']]) +
    `<h2>Action items</h2>` + tasks([[true, 'Add alerting'], [false, 'Write regression test']]),
});

const longBody = () =>
  Array.from({ length: 40 }, (_, i) => `<h2>Section ${i + 1}</h2>` + para(`Paragraph ${i + 1}: ` + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8))).join('');

// ---- spaces --------------------------------------------------------------------
export const spaces = [
  {
    key: 'PLAT',
    name: 'Platform Engineering',
    description: 'Deep page hierarchy, services, ADRs and incidents',
    home: para('Welcome to Platform Engineering.') + macro('children', { depth: '2' }),
    pages: [
      {
        title: 'Architecture Overview',
        labels: ['architecture', 'reference'],
        attachments: [png('architecture-diagram.png'), text('capacity-notes.txt', 'Capacity planning notes for 2026.\n')],
        body: (ctx) =>
          `<h1>Architecture Overview</h1>` +
          para(`Maintained by ${mention(ctx.userKey)}. This page exercises <strong>every common macro</strong>.`) +
          panel('info', 'Heads up', para('Info panels become alerts.')) +
          panel('warning', 'Careful', para('Do not deploy on Fridays.')) +
          panel('note', '', para('A note panel without a title.')) +
          panel('tip', 'Pro tip', para('Use the service catalog.')) +
          macro('panel', { title: 'Generic panel', borderStyle: 'solid' }, rich(para('Generic panel body.'))) +
          `<h2>Code</h2>` +
          code('typescript', "import express from 'express';\nconst app = express();\napp.listen(3000);", 'server.ts') +
          code('python', 'def handler(event):\n    return {"ok": True}') +
          code('sql', 'SELECT id, title FROM pages WHERE space = \'PLAT\';') +
          macro('noformat', {}, plain('raw   preformatted\n  text block')) +
          `<h2>Status</h2>` + para(`Gateway ${status('Green', 'ACTIVE')} Legacy ${status('Red', 'DEPRECATED')} Search ${status('Blue', 'BETA')}`) +
          `<h2>Components</h2>` +
          table(['Component', 'Owner', 'Language'], [['API Gateway', 'Platform', 'Go'], ['Billing', 'Payments', 'Java'], ['Web UI', 'Frontend', 'TypeScript']]) +
          macro('expand', { title: 'Show legacy details' }, rich(para('Legacy monolith retired in 2024.') + '<ul><li>Item one</li><li>Item two</li></ul>')) +
          macro('excerpt', {}, rich(para('Platform architecture in one sentence.'))) +
          macro('jira', { server: 'Example JIRA', key: 'PLAT-123' }) +
          `<h2>Diagram</h2>` + para(image('architecture-diagram.png')) +
          para(`Related: ${link('Gateway Service')} and ${link('On-Call Handbook', 'OPS')}.`),
        children: [
          {
            title: 'Architecture Decision Records',
            body: macro('children', {}),
            children: [
              adr(1, 'Use PostgreSQL', 'Accepted'),
              adr(2, 'Adopt Kubernetes', 'Accepted'),
              adr(3, 'Event Bus Selection', 'Superseded'),
              adr(4, 'GraphQL Gateway', 'Proposed'),
              adr(5, 'Monorepo Layout', 'Accepted'),
              adr(6, 'Feature Flags', 'Accepted'),
              adr(7, 'Observability Stack', 'Proposed'),
              adr(8, 'Secrets Management', 'Accepted'),
            ],
          },
        ],
      },
      {
        title: 'Services',
        body: '',
        children: [service('Gateway', 'Go', 'Platform'), service('Billing', 'Java', 'Payments'), service('Auth', 'Kotlin', 'Identity')],
      },
      {
        title: 'Runbooks',
        body: '',
        labels: ['runbook'],
        children: [
          {
            title: 'Database Runbooks',
            body: '',
            children: [
              {
                title: 'Database Failover',
                labels: ['runbook', 'database'],
                body: para('Steps to fail over the primary database.') + '<ol><li>Page the DBA.</li><li>Promote the replica.</li><li>Update DNS.</li></ol>' + code('bash', 'pg_ctl promote -D /var/lib/postgresql/data') + para(`See also ${link('Architecture Overview')}.`),
              },
              {
                title: 'Database Backups',
                body: para('Nightly backups with 30-day retention.'),
                children: [{ title: 'Restore Drill', body: tasks([[true, 'Restore to staging'], [false, 'Verify row counts']]) }],
              },
            ],
          },
          {
            title: 'Incident Response',
            body: macro('panel', { title: 'Severity levels' }, rich('<ul><li>SEV1 - outage</li><li>SEV2 - degraded</li><li>SEV3 - minor</li></ul>')),
            children: [
              {
                title: 'Incidents 2026',
                body: '',
                children: [
                  { title: 'Incidents 2026 Q1', body: '', children: [incident(1001, 'Gateway latency spike', 2), incident(1002, 'Billing double charge', 1)] },
                  { title: 'Incidents 2026 Q2', body: '', children: [incident(1003, 'Auth token outage', 1), incident(1004, 'Search index lag', 3)] },
                ],
              },
              { title: 'Postmortem Template', labels: ['template'], body: macro('toc', {}) + '<h2>Summary</h2><h2>Timeline</h2><h2>Action items</h2>' },
            ],
          },
        ],
      },
      {
        title: 'Onboarding',
        body: para('Start here.'),
        children: [
          {
            title: 'Onboarding Week 1',
            body: '',
            children: [
              {
                title: 'Onboarding Day 1',
                body: para('Laptop, badges, accounts.'),
                children: [
                  {
                    title: 'Access Requests',
                    body: tasks([[false, 'GitLab'], [false, 'Vault'], [false, 'VPN']]),
                    children: [
                      {
                        title: 'VPN Setup',
                        body: code('bash', 'sudo openvpn --config corp.ovpn'),
                        children: [{ title: 'VPN Troubleshooting', body: panel('tip', '', para('Restart the client first.')) }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { title: 'Unrestricted Access Guide', body: para('Public guide. Must stay visible: canary for substring matching of the "Restricted/" ignore rule.') },
        ],
      },
      {
        title: 'Restricted',
        body: panel('warning', '', para('Everything below is excluded by .confluenceignore (subtree rule).')),
        children: [
          { title: 'Production Credentials', body: para('db_password = not-a-real-password') },
          { title: 'Security Audit 2026', body: para('Findings are confidential.'), children: [{ title: 'Pen Test Findings', body: para('Fake finding details.') }] },
        ],
      },
      { title: 'Vendor Contracts (Sensitive)', body: para('Excluded by the *Sensitive* title glob.') },
    ],
  },
  {
    key: 'OPS',
    name: 'Operations',
    description: 'Tables, duplicate titles across spaces, unicode and long pages',
    home: para('Operations home.') + macro('children', {}),
    pages: [
      {
        title: 'On-Call Handbook',
        labels: ['oncall'],
        body:
          para(`Escalate per ${link('Incident Response', 'PLAT')}.`) +
          table(['Week', 'Primary', 'Secondary'], [['41', 'Alice', 'Bob'], ['42', 'Carol', 'Dan'], ['43', 'Erin', 'Frank']]),
        children: [
          { title: 'Escalation Matrix', body: table(['Severity', 'Response', 'Escalate after'], [['SEV1', '5 min', '15 min'], ['SEV2', '30 min', '2 h'], ['SEV3', 'Next day', '-']]) },
          { title: 'Pager Rotations', body: '', children: [{ title: 'EMEA Rotation', body: para('EMEA schedule.') }, { title: 'AMER Rotation', body: para('AMER schedule.') }] },
        ],
      },
      {
        title: 'Service Level Objectives',
        body:
          table(['Service', 'SLO', 'Current'], [['Gateway', '99.95%', '99.97%'], ['Billing', '99.9%', '99.85%']]) +
          '<h2>Nested table</h2>' +
          `<table><tbody><tr><th>Region</th><th>Detail</th></tr><tr><td>EU</td><td>${table(['Zone', 'Uptime'], [['eu-1', '99.99%'], ['eu-2', '99.90%']])}</td></tr></tbody></table>`,
      },
      // Same title exists in PLAT: tests that pages are keyed by id/space, not title.
      { title: 'Database Failover', body: para('OPS view of database failover (duplicate title of a PLAT page).') },
      { title: 'Q&A / FAQ: Ünïcödé — “Quotes” & Symbols', body: para('Special characters: &lt;tag&gt; &amp; ampersand, emoji 🚀, CJK 漢字.') },
      { title: 'Very Long Page', body: longBody() },
      // Leak-guard fixtures (ADR-022). The key is AWS's published example, built
      // from parts so no secret scanner flags this file; the contacts are invented.
      {
        title: 'Deploy Notes',
        labels: ['guard-fixture'],
        body: para('Deployment uses the CI role.') + code('bash', ['export AWS_ACCESS_KEY_ID=', 'AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')),
      },
      {
        title: 'Team Contacts',
        labels: ['guard-fixture'],
        body: table(['Role', 'Name', 'Contact'], [['On-call lead', 'Sam Rivera', 'sam.rivera@example.com'], ['Escalation', 'Ana Ortiz', '+1 415-555-0132']]),
      },
      {
        title: 'Capacity Planning',
        attachments: [text('capacity.csv', 'service,cpu,mem\ngateway,4,8\nbilling,8,16\n'), png('capacity-chart.png')],
        body: para('See attached CSV.') + para(image('capacity-chart.png')),
      },
    ],
  },
  {
    key: 'PEOPLE',
    name: 'People and HR',
    description: 'Policies plus id- and path-based exclusions',
    home: para('People team home.'),
    pages: [
      {
        title: 'Policies',
        body: macro('children', {}),
        children: [
          { title: 'Remote Work Policy', labels: ['policy'], body: para('Up to 5 days remote per week.') },
          { title: 'Travel Policy', labels: ['policy'], body: table(['Class', 'Allowed'], [['Economy', 'Yes'], ['Business', 'Flights over 6h']]) },
          { title: 'Salary Bands', labels: ['compensation'], body: table(['Level', 'Band'], [['L1', 'fake-range-a'], ['L2', 'fake-range-b']]) },
        ],
      },
      {
        title: 'Interviews',
        body: para('Interview process overview. Visible.'),
        children: [
          { title: 'Interview Guide', body: para('Visible guide for interviewers.') },
          {
            title: 'Internal',
            body: para('Excluded by the Interviews/Internal/ path rule.'),
            children: [{ title: 'Candidate Feedback', body: para('Fake candidate notes.') }],
          },
        ],
      },
      { title: 'Benefits Overview', body: para('Health, dental, vision.') },
    ],
  },
];

// ---- .confluenceignore fixtures ------------------------------------------------
// `{{id:Title}}` is replaced with the page's real id after seeding.
export const ignoreFiles = {
  PLAT: ['# Subtree rule: the Restricted page and everything below it', 'Restricted/', '# Title glob', '*Sensitive*'],
  OPS: ['# No exclusions in OPS: every page must stay visible'],
  PEOPLE: ['# Exclude one page by id', 'id:{{id:Salary Bands}}', '# Exclude a nested path subtree', 'Interviews/Internal/'],
};

// Expected outcome per page title, used by the e2e tests.
export const expectations = {
  PLAT: {
    excluded: ['Restricted', 'Production Credentials', 'Security Audit 2026', 'Pen Test Findings', 'Vendor Contracts (Sensitive)'],
    visible: ['Architecture Overview', 'VPN Troubleshooting', 'Gateway Service', 'INC-1003: Auth token outage'],
    // Known issue: ExclusionManager.matchesPattern falls back to an unanchored
    // substring regex, so "Restricted/" also hides "Unrestricted Access Guide".
    knownIssueVisible: ['Unrestricted Access Guide'],
  },
  OPS: {
    excluded: [],
    visible: ['On-Call Handbook', 'Database Failover', 'Very Long Page', 'EMEA Rotation'],
    // What the outbound guard must do with these pages (ADR-022).
    guard: { blocked: { 'Deploy Notes': 'AWS access key' }, redacted: { 'Team Contacts': ['sam.rivera@example.com', '+1 415-555-0132'] } },
  },
  PEOPLE: {
    excluded: ['Salary Bands', 'Internal', 'Candidate Feedback'],
    visible: ['Policies', 'Remote Work Policy', 'Interviews', 'Interview Guide', 'Benefits Overview'],
    // Salary Bands carries "compensation" but is excluded, so no tag lists it.
    tags: { policy: ['Remote Work Policy', 'Travel Policy'] },
  },
};

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { canonicalPath, cleanText, containsPath, MulticaClient, repoKey, restoreState, uniqueMatch } from '../multica-mode/core.ts';

// Resolve the same host-supplied TypeBox as pi, without adding a dependency.
const agent = fileURLToPath(new URL('../../', import.meta.url));
const hostInstall = process.env.PI_TEST_HOST_INSTALL || join(agent, 'install');
const version = readFileSync(join(hostInstall, 'current-version'), 'utf8').trim();
const hostRequire = createRequire(join(hostInstall, 'releases', version, 'package.json'));
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'typebox' ? { url: new URL(`file://${hostRequire.resolve('typebox')}`).href, shortCircuit: true } : next(specifier, context);
} });
const { default: register } = await import('../multica-mode/index.ts');
// These fixtures model a human session against a fake service. Do not inherit
// the managed runner's service binding or credential mode in this test process.
delete process.env.MULTICA_TOKEN;
delete process.env.MULTICA_SERVER_URL;
const cwd = canonicalPath(process.cwd());
const target = { id: 'p', workspace_id: 'w', title: '项目', workspaceName: '工作区', profile: '', serverUrl: 'https://api.example.com', cwd };
const issue = { id: 'i', workspace_id: 'w', project_id: 'p', identifier: 'CERE-1', title: '测试任务', status: 'todo', description: '目标', labels: [] };
const ok = value => ({ code: 0, killed: false, stdout: JSON.stringify(value), stderr: '' });

function fixture(options = {}) {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git') return { code: 1, killed: false, stdout: '', stderr: 'no remote' };
    const op = args.slice(0, 3).join(' ');
    if (options.fail) return { code: 1, killed: false, stdout: '', stderr: 'network unavailable' };
    if (op.startsWith('daemon status')) return ok({ daemon_id: 'd', server_url: target.serverUrl });
    if (op.startsWith('workspace list')) return ok([{ id: 'w', name: '工作区' }]);
    if (op.startsWith('project list')) return ok([{ id: 'p', workspace_id: 'w', title: '项目' }]);
    if (op.startsWith('project resource list')) return ok([{ resource_type: 'local_directory', resource_ref: { daemon_id: options.otherMachine ? 'remote' : 'd', local_path: cwd } }]);
    if (op.startsWith('project get')) return ok({ id: 'p', workspace_id: options.wrongProject ? 'other' : 'w', title: '项目' });
    if (op.startsWith('issue list')) return ok({ issues: [issue], has_more: options.hasMore ?? false, total: options.hasMore ? 110 : 1 });
    if (op.startsWith('issue get')) return ok({ ...issue, project_id: options.wrongIssue ? 'other' : 'p' });
    if (op.startsWith('issue comment list')) return ok([]);
    if (op.startsWith('issue runs')) return ok([{ id: 'r', agent_id: 'a', status: 'running' }]);
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { execute, calls, options };
}
function harness(options = {}, initialState) {
  const f = fixture(options), events = new Map(), tools = new Map(), entries = [], notices = [], widgets = new Map(), statuses = new Map(), widgetRenders = [], execOptions = [];
  if (initialState) entries.push({ type: 'custom', customType: 'multica-mode', data: initialState });
  let command;
  const pi = {
    registerFlag() {}, getFlag(name) { return options.flags?.[name]; },
    registerCommand(name, value) { assert.equal(name, "pm"); command = value; },
    registerTool(value) { tools.set(value.name, value); },
    on(name, handler) { events.set(name, handler); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    exec: (command, args, options) => { execOptions.push({ command, ...options }); return f.execute(command, args); },
  };
  const ctx = { cwd, hasUI: options.hasUI ?? true, signal: undefined,
    waitForIdle: async () => {}, sessionManager: { getBranch: () => entries },
    ui: { setStatus(key, value) { statuses.set(key, value); }, setWidget(key, lines) { widgets.set(key, lines); if (lines !== undefined) widgetRenders.push(lines); }, notify(message, level) { notices.push({ message, level }); },
      select: async (_title, choices) => options.cancel ? undefined : choices[0], confirm: async () => !options.reject },
  };
  register(pi);
  return { ...f, events, tools, entries, notices, widgets, statuses, widgetRenders, ctx, execOptions,
    start: () => events.get('session_start')({}, ctx),
    command: args => command.handler(args, ctx),
    tool: (name, params) => tools.get(name).execute('call', params, undefined, undefined, ctx),
    before: async () => { const event = { systemPromptOptions: { sections: {} }, systemPrompt: 'base' }; await events.get('before_agent_start')(event, ctx); return event; },
  };
}

test('directory boundaries and SSH/HTTPS repository identity', () => {
  assert.equal(containsPath('/tmp/repo', '/tmp/repo/src'), true);
  assert.equal(containsPath('/tmp/repo', '/tmp/repository'), false);
  assert.equal(repoKey('git@github.com:org/repo.git'), repoKey('https://github.com/org/repo'));
  assert.equal(repoKey('file:///tmp/repo'), undefined);
  assert.equal(cleanText('\x1b[31mA\nB').includes('\x1b'), false);
});
test('unique strongest match wins; tied matches require a user decision', () => {
  assert.equal(uniqueMatch([{ score: 5 }, { score: 1 }]).score, 5);
  assert.equal(uniqueMatch([{ score: 5 }, { score: 5 }]), undefined);
  assert.equal(uniqueMatch([{ score: 0 }]), undefined);
});
test('restoration honors branch state and invalidates changed cwd/profile/service', () => {
  const state = { enabled: true, target, issue: 'i', waitingFor: '范围确认' };
  assert.deepEqual(restoreState(state, cwd, ''), state);
  assert.deepEqual(restoreState(state, '/some/other/path', ''), { enabled: true });
  assert.deepEqual(restoreState(state, cwd, 'other'), { enabled: true });
  assert.deepEqual(restoreState(state, cwd, '', 'https://other.example.com'), { enabled: true });
  assert.equal(restoreState({ enabled: true, target: { ...target, serverUrl: 'https://secret:token@example.com' } }, cwd, '').target, undefined);
});
test('discovery requires the local daemon for local-directory auto matching', async () => {
  const f = fixture();
  assert.ok(uniqueMatch(await new MulticaClient(f.execute).discover(cwd)));
  const remote = fixture({ otherMachine: true });
  assert.equal(uniqueMatch(await new MulticaClient(remote.execute).discover(cwd)), undefined);
  assert.ok(f.calls.every(([command, args]) => command === 'git' || !args.some(a => ['create', 'update', 'assign', 'rerun', 'start', 'delete'].includes(a))));
});
test('overview verifies ownership, preserves partial-list warning and pins service/workspace', async () => {
  const f = fixture({ hasMore: true });
  const snapshot = await new MulticaClient(f.execute, '', target.serverUrl).overview(target, 'i');
  assert.equal(snapshot.hasMore, true);
  assert.equal(snapshot.focus.runs[0].status, 'running');
  assert.ok(f.calls.every(([, args]) => args.includes('--server-url')));
  assert.ok(f.calls.every(([, args]) => args.includes('--workspace-id')));
  const wrong = fixture({ wrongIssue: true });
  await assert.rejects(new MulticaClient(wrong.execute, '', target.serverUrl).overview(target, 'i'), /不属于当前项目/);
});
test('rejects foreign project, malformed JSON, and ambiguous network results', async () => {
  const wrong = fixture({ wrongProject: true });
  await assert.rejects(new MulticaClient(wrong.execute, '', target.serverUrl).verify(target), /不匹配/);
  await assert.rejects(new MulticaClient(async () => ({ code: 0, killed: false, stdout: 'not json', stderr: '' })).read(['workspace', 'list']), /有效 JSON/);
  await assert.rejects(new MulticaClient(fixture({ fail: true }).execute).read(['workspace', 'list']), /network unavailable/);
});
test('disabled mode makes no network calls and does not change existing tools', async () => {
  const h = harness(); await h.start();
  assert.deepEqual((await h.before()).systemPromptOptions.sections, {});
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.tool('multica_overview', {}), /先启用/);
});
test('bare /pm enters and repeated entry stays enabled; off removes rules', async () => {
  const h = harness(); await h.start(); await h.command('on');
  assert.equal(h.entries.at(-1).data.target.id, 'p');
  await h.command('off');
  await h.command('');
  assert.equal(h.entries.at(-1).data.enabled, true);
  await h.command('');
  assert.equal(h.entries.at(-1).data.enabled, true);
  const first = (await h.before()).systemPromptOptions.sections.multica_mode;
  assert.match(first, /Discuss, review and plan/); assert.match(first, /issue-workflow/);
  assert.match(first, /"workspace_id":"w"/);
  assert.equal((await h.before()).systemPromptOptions.sections.multica_mode.includes('Runtime context'), true);
  await h.command('off');
  assert.deepEqual((await h.before()).systemPromptOptions.sections, {});
  assert.equal(h.widgets.get('multica-mode'), undefined);
});
test('project selection cancel/reject never binds; no-UI ambiguity never guesses', async () => {
  const cancel = harness({ otherMachine: true, cancel: true }); await cancel.start(); await cancel.command('on');
  assert.equal(cancel.entries.at(-1).data.target, undefined);
  const headless = harness({ otherMachine: true, hasUI: false }); await headless.start(); await headless.command('on');
  assert.equal(headless.entries.at(-1).data.target, undefined);
  assert.match(headless.notices.at(-1).message, /不能自动猜测/);
  const reject = harness({ reject: true }, { enabled: true }); await reject.start();
  assert.deepEqual((await reject.tool('multica_select_project', { workspaceId: 'w', projectId: 'p' })).details, { changed: false });
  assert.equal(reject.entries.at(-1).data.target, undefined);
});
test('explicit user project command binds verified IDs without remote writes', async () => {
  const h = harness(); await h.start(); await h.command('project w p');
  assert.equal(h.entries.at(-1).data.target.id, 'p');
  await h.command('project other p');
  assert.match(h.notices.at(-1).message, /未找到/);
  assert.equal(h.entries.at(-1).data.target.id, 'p');
});
test('waiting-only updates persist locally without CLI calls, including offline', async () => {
  for (const fail of [false, true]) {
    const h = harness({ fail }, { enabled: true, target, issue: 'i' });
    await h.start();
    for (const waitingFor of ['请确认范围', '']) {
      const response = await h.tool('multica_overview', { waitingFor });
      assert.deepEqual(response.details, { source: 'local', waitingFor: waitingFor || null });
      assert.equal(h.entries.at(-1).data.waitingFor, waitingFor || undefined);
      assert.equal(h.entries.at(-1).data.issue, 'i');
      assert.deepEqual(h.entries.at(-1).data.target, target);
      await h.events.get('session_tree')({}, h.ctx);
      const context = (await h.before()).systemPromptOptions.sections.multica_mode;
      assert.ok(context.includes(`"waitingFor":${JSON.stringify(waitingFor || null)}`));
      assert.equal(h.calls.length, 0);
    }
  }
});
test('waiting-only updates preserve historical snapshot; explicit queries still read', async () => {
  const h = harness({}, { enabled: true, target, issue: 'i' });
  await h.start();
  const overview = await h.tool('multica_overview', {});
  assert.equal(overview.details.focus.issue.id, 'i');
  assert.ok(h.calls.length > 0);
  const before = (await h.before()).systemPromptOptions.sections.multica_mode;
  const count = h.calls.length;
  await h.tool('multica_overview', { waitingFor: '请确认范围' });
  await h.tool('multica_overview', { waitingFor: '' });
  assert.equal(h.calls.length, count);
  assert.equal((await h.before()).systemPromptOptions.sections.multica_mode, before);
  for (const params of [{ issue: 'CERE-1', waitingFor: '确认' }, { issue: '', waitingFor: '' }, {}]) {
    const count = h.calls.length;
    await h.tool('multica_overview', params);
    assert.ok(h.calls.length > count);
  }
});
test('focus and waiting state can be set and cleared together', async () => {
  const h = harness(); await h.start(); await h.command('on');
  await h.tool('multica_overview', { issue: 'CERE-1', waitingFor: '验收标准' });
  assert.equal(h.entries.at(-1).data.issue, 'i');
  assert.equal(h.entries.at(-1).data.waitingFor, '验收标准');
  assert.equal(h.widgets.get('multica-mode'), undefined);
  await h.tool('multica_overview', { issue: '', waitingFor: '' });
  assert.equal(h.entries.at(-1).data.issue, undefined);
  assert.equal(h.entries.at(-1).data.waitingFor, undefined);
  await h.command('issue CERE-1'); await h.command('issue');
  assert.equal(h.entries.at(-1).data.issue, undefined);
});
test('failed refresh clears snapshot instead of presenting stale data as current', async () => {
  const options = {}; const h = harness(options); await h.start(); await h.command('on');
  options.fail = true;
  await h.command('status');
  const event = await h.before();
  assert.match(h.notices.at(-1).message, /network unavailable/);
  assert.doesNotMatch(event.systemPromptOptions.sections.multica_mode, /network unavailable|"snapshot"/);
  assert.equal(h.widgets.get('multica-mode'), undefined);
  assert.deepEqual(h.widgetRenders, []);
});
test('resume/fork restore only active branch; --pm does not override saved off state', async () => {
  const h = harness({ flags: { pm: true } }, { enabled: false, target }); await h.start();
  assert.deepEqual((await h.before()).systemPromptOptions.sections, {});
  h.entries.push({ type: 'custom', customType: 'multica-mode', data: { enabled: true, target, issue: 'i' } });
  await h.events.get('session_tree')({}, h.ctx);
  assert.match((await h.before()).systemPromptOptions.sections.multica_mode, /"issue":"i"/);
  h.entries.splice(0); await h.events.get('session_fork')({}, h.ctx);
  assert.match((await h.before()).systemPromptOptions.sections.multica_mode, /"target":null/);
});
test('human UI CLI reads avoid shared task markers; git stays in the project', async () => {
  const h = harness(); await h.start(); await h.command('on');
  assert.ok(h.execOptions.filter(o => o.command === 'multica').every(o => o.cwd === tmpdir()));
  assert.ok(h.execOptions.filter(o => o.command === 'git').every(o => o.cwd === cwd));
  const headless = harness({ hasUI: false }); await headless.start(); await headless.command('on');
  assert.ok(headless.execOptions.every(o => o.cwd === cwd));
});
test('structured rules also work alongside an earlier forced system prompt', async () => {
  const h = harness(); await h.start(); await h.command('on');
  const event = { systemPromptOptions: { sections: {}, forceSystemPrompt: 'other extension' }, systemPrompt: 'other extension' };
  const result = await h.events.get('before_agent_start')(event, h.ctx);
  assert.match(result.systemPrompt, /^other extension/);
  assert.match(result.systemPrompt, /PM mode/);
});
test('compact footer never renders issue widgets, but explicit status retains task details', async () => {
  const options = {}; const h = harness(options);
  await h.start(); await h.command('');
  assert.equal(h.statuses.get('multica-mode'), 'PM mode · 项目');
  await h.tool('multica_overview', { issue: 'CERE-1', waitingFor: '验收标准' });
  await h.command('status');
  assert.match(h.notices.at(-1).message, /CERE-1/);
  assert.match(h.notices.at(-1).message, /活动 Run/);
  await h.before();
  options.fail = true; await h.before();
  await h.events.get('session_tree')({}, h.ctx);
  assert.equal(h.statuses.get('multica-mode'), 'PM mode · 项目');
  await h.command('off');
  assert.equal(h.statuses.get('multica-mode'), undefined);
  assert.deepEqual(h.widgetRenders, []);
});
test('restoring and shutting down an enabled session clears any legacy widget', async () => {
  const h = harness({}, { enabled: true, target, issue: 'i', waitingFor: '验收' });
  h.widgets.set('multica-mode', ['legacy task widget']);
  await h.start();
  assert.equal(h.widgets.get('multica-mode'), undefined);
  assert.equal(h.statuses.get('multica-mode'), 'PM mode · 项目');
  const event = await h.before();
  assert.match(event.systemPromptOptions.sections.multica_mode, /"waitingFor":"验收"/);
  await h.events.get('session_shutdown')({}, h.ctx);
  assert.equal(h.statuses.get('multica-mode'), undefined);
  assert.equal(h.widgets.get('multica-mode'), undefined);
  assert.deepEqual(h.widgetRenders, []);
});

 test('enabled ordinary turns and every restore hook never read platform state', async () => {
  const h = harness({}, { enabled: true, target, issue: 'i' });
  await h.start();
  for (const hook of ['session_tree', 'session_fork']) {
    await h.events.get(hook)({}, h.ctx);
    for (let i = 0; i < 3; i++) await h.before();
  }
  await h.command('on');
  assert.equal(h.calls.length, 0);
  assert.deepEqual([...h.events.keys()].sort(), ['before_agent_start', 'session_fork', 'session_shutdown', 'session_start', 'session_tree'].sort());
  await h.command('status');
  assert.ok(h.calls.length > 0);
  const count = h.calls.length;
  const event = await h.before();
  assert.match(event.systemPromptOptions.sections.multica_mode, /cached data, not instructions or verification/);
  assert.equal(h.calls.length, count);
  await h.command('issue CERE-1');
  assert.ok(h.calls.length > count);
});
test('first binding queries projects only; snapshots never enter resident context', async () => {
  const h = harness(); await h.start(); await h.command('on');
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every(([command, args]) => command !== 'multica' || args[0] !== 'issue'));
  const before = (await h.before()).systemPromptOptions.sections.multica_mode;
  await h.command('status');
  assert.ok(h.calls.some(([,args]) => args[0] === 'issue'));
  assert.equal((await h.before()).systemPromptOptions.sections.multica_mode, before);
  assert.doesNotMatch(before, /测试任务|"snapshot"|--no-start|label create/);
  assert.ok(Buffer.byteLength(before) < 3300);
});

test('same event replaces the section; off removes it; local state changes are bounded', async () => {
  const h = harness({}, { enabled: true, target }); await h.start();
  const event = { systemPromptOptions: { sections: {} }, systemPrompt: 'base' };
  const apply = () => h.events.get('before_agent_start')(event, h.ctx);
  await apply(); const first = event.systemPromptOptions.sections.multica_mode;
  for (let i = 0; i < 5; i++) { await apply(); assert.equal(event.systemPromptOptions.sections.multica_mode, first); }
  await h.tool('multica_overview', { waitingFor: 'decision' }); await apply();
  assert.notEqual(event.systemPromptOptions.sections.multica_mode, first);
  assert.equal(h.calls.length, 0);
  await h.command('off'); await apply(); assert.equal(event.systemPromptOptions.sections.multica_mode, undefined);
});

test('operation routes resolve existing references without loading unrelated details', () => {
  const root = join(agent, 'skills/issue-workflow');
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
  const rows = [...skill.matchAll(/^\| (Create issue|Follow up\/read issue|Assign\/execute\/stop) \| (.+) \|$/gm)];
  assert.equal(rows.length, 3);
  const loaded = Object.fromEntries(rows.map(([,name,refs]) => [name, [...refs.matchAll(/references\/[a-z-]+\.md/g)].map(([path]) => readFileSync(join(root,path),'utf8')).join('\n')]));
  assert.match(loaded['Create issue'], /explicit authorization/);
  assert.match(loaded['Create issue'], /label list/);
  assert.doesNotMatch(loaded['Follow up/read issue'], /label create|issue assign <id>/);
  assert.match(loaded['Follow up/read issue'], /outside that transition, do not update, reassign, restart or monitor/);
  assert.match(loaded['Assign/execute/stop'], /--no-start/);
  assert.match(loaded['Assign/execute/stop'], /if unavailable, stop and ask/);
  assert.match(loaded['Assign/execute/stop'], /Verify ownership and actual Run state afterward/);
  for (const value of Object.values(loaded)) assert.match(value, /verify ownership/);
});

test('secondary references cannot bypass optional template and check routes', () => {
  const root = join(agent, 'skills/issue-workflow/references');
  const violations = (name, text) => text.split('\n').filter(line => {
    if (name === 'checks.md') return false; // Explicit workflow testing context.
    return (/templates\.md/.test(line) && !/only for a requested template\/handoff/.test(line)) ||
      (/checks\.md/.test(line) && !/only when testing the workflow/.test(line));
  });
  for (const name of readdirSync(root).filter(name => name.endsWith('.md') && !name.startsWith('validation-'))) {
    assert.deepEqual(violations(name, readFileSync(join(root, name), 'utf8')), [], name);
  }
  // Negative fixtures prove the original secondary-loading regression is caught.
  assert.equal(violations('authoring.md', 'Use `templates.md`, and validate with `checks.md`.').length, 1);
  assert.equal(violations('follow-up.md', 'Use references/templates.md for an optional example.').length, 1);
});

test('PM injects Git/PR collaboration boundaries without platform work or tool restrictions', async () => {
  const h = harness({}, { enabled: true, target }); await h.start();
  const section = (await h.before()).systemPromptOptions.sections.multica_mode;
  assert.match(section, /PR review and authorized Git commit, merge and push may run in this session without an Issue or Agent handoff/);
  assert.match(section, /Review grants no fix, merge or push permission/);
  assert.match(section, /merge grants no additional push beyond the request/);
  assert.match(section, /Verify repository, PR, branches and remote; preserve existing changes/);
  assert.match(section, /Execute clear authorization without asking again/);
  assert.match(section, /Force-push and destructive resets need corresponding authorization/);
  assert.match(section, /Report Git\/PR results in chat unless recording is separately required/);
  assert.match(section, /Code implementation goes to the issue owner/);
  assert.match(section, /do not authorize direct Run starts or duplicate triggers/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.events.has('tool_call'), false);
  const execution = readFileSync(join(agent, 'skills/issue-workflow/references/execution.md'), 'utf8');
  assert.match(execution, /do not require creating\/updating an Issue/);
  assert.match(execution, /Inspect staged\/unstaged changes and preserve unrelated work/);
  assert.match(execution, /Do not read Multica merely to perform Git\/PR collaboration/);
  assert.match(execution, /--no-start/);
});

test('installed host records only changed sections, including removal', async () => {
  const { diffSystemPromptSections } = await import(pathToFileURL(join(hostInstall, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js')).href);
  const h = harness({}, { enabled: true, target }); await h.start();
  const first = (await h.before()).systemPromptOptions.sections;
  assert.deepEqual(diffSystemPromptSections({}, first), first);
  assert.equal(diffSystemPromptSections(first, (await h.before()).systemPromptOptions.sections), undefined);
  await h.tool('multica_overview', { waitingFor: 'decision' });
  const next = (await h.before()).systemPromptOptions.sections;
  assert.deepEqual(diffSystemPromptSections(first, next), next);
  await h.command('off');
  assert.deepEqual(diffSystemPromptSections(next, (await h.before()).systemPromptOptions.sections), { multica_mode: null });
});

test('positive issue-body examples exclude execution switches but retain technical requirements', () => {
  const templates = readFileSync(join(agent, 'skills/issue-workflow/references/templates.md'), 'utf8');
  const bodyAfter = templates.split('Task description — after:')[1].split('Delivery — before:')[0];
  const arrangements = templates.split('## Creation arrangements')[1].split('## Related issue reference example')[0];
  const bodies = [bodyAfter, arrangements].map(section =>
    section.split('\n').filter(line => line.startsWith('> ')).map(line => line.slice(2)).join('\n'));
  const controls = /不启动执行|仅创建并分配任务|仅分配|(?:do not|don't) start|assignment.only|multica issue (?:assign|status|rerun)/i;
  for (const body of bodies) {
    assert.ok(body.length > 0);
    assert.match(body, /CSV/);
    assert.match(body, /保留旧文件/);
    assert.match(body, /验收.*Excel.*回归/);
    assert.doesNotMatch(body, controls);
  }
  for (const contamination of ['不启动执行', '范围：仅创建并分配任务', '验收：仅分配', 'multica issue status <id> backlog', 'Do not start']) {
    assert.match(bodies[0] + '\n' + contamination, controls);
  }
  assert.doesNotMatch(bodies[0] + '\n验证：pnpm test -- csv-export；实现 multica issue list 的过滤参数。', controls);
  assert.match(bodyAfter, /不提交或推送 Git/);
});

test('body separation reaches authoring, execution and resident PM guidance', async () => {
  const root = join(agent, 'skills/issue-workflow');
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
  const authoring = readFileSync(join(root, 'references/authoring.md'), 'utf8');
  const execution = readFileSync(join(root, 'references/execution.md'), 'utf8');
  assert.match(skill, /Keep execution control out of issue bodies/);
  assert.match(authoring, /ordinary creation, create-then-assign and tasks awaiting planning/);
  assert.match(authoring, /reproduction\/test command/);
  assert.match(execution, /configured statuses and startup semantics/);
  assert.match(execution, /--no-start suppresses a particular write's trigger/);
  assert.match(execution, /Verify stored status, assignment and actual Run state/);
  const h = harness({}, { enabled: true, target }); await h.start();
  assert.match((await h.before()).systemPromptOptions.sections.multica_mode, /manage planning\/readiness through verified platform status/);
  assert.equal(h.calls.length, 0);
});


test('PM routes explicit follow-up transitions while commands remain reads', async () => {
  const h = harness({}, { enabled: true, target }); await h.start();
  const section = (await h.before()).systemPromptOptions.sections.multica_mode;
  assert.match(section, /Completed explicit follow-up moves verified blocked or in_review targets to todo/);
  assert.match(section, /issue-workflow\/references\/follow-up.md/);
  assert.match(section, /incomplete\/failed follow-ups are unchanged/);
  assert.match(section, /\/pm status and \/pm issue remain reads/);
  assert.equal(h.calls.length, 0);
  await h.command('status');
  await h.command('issue');
  assert.ok(h.calls.every(call => !/issue (status|update|assign|rerun|wakeup|comment add)/.test(call.join(' '))));
});

// Static documentation contract only; this does not execute a migration or model.
function assertFollowUpContract(text) {
  const section = text.split('## Completed explicit follow-up → todo\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'completion transition section must exist');
  const step = number => {
    const value = section.split('\n').find(line => line.startsWith(`${number}. `));
    assert.ok(value, `completion step ${number} must exist`);
    return value;
  };
  assert.match(section, /Apply only to the target of the user's explicit follow-up request/);
  assert.match(section, /body and relevant comments were successfully read, required Run checks succeeded, and analysis and a factual summary with blockers\/next action are ready/);
  assert.match(section, /Failed reads, missing relevant context or unfinished analysis permit no transition/);
  assert.match(step(1), /use exact keys `blocked`, `in_review`, `todo`, not display-name guesses/);
  assert.match(step(1), /Other statuses, including `backlog`, `todo`, `in_progress`, `done`, `cancelled` and custom keys, remain unchanged/);
  // Scope checks to the preflight step: initial capture or CAS advice cannot satisfy it.
  assert.match(step(2), /After completing analysis and summary, freshly read the target and relevant active Runs immediately before writing/);
  assert.match(step(2), /Compare identity, workspace\/project, assignee, status and revision with the analyzed snapshot/, 'preflight must compare ownership, assignee, status and revision');
  assert.match(step(2), /A mismatch, changed revision \(including away-and-back status changes\), failed read or unclear ownership means skip the write/);
  assert.match(step(2), /do not overwrite it or automatically rebase\/retry/);
  assert.match(step(3), /For an unchanged eligible target, perform at most one/);
  const commands = [...section.matchAll(/`multica issue status <issue-id> ([^`]+)`/g)].map(match => match[1]);
  assert.deepEqual(commands, ['todo'], 'the single migration command must target todo');
  assert.match(step(5), /Read back issue identity\/ownership, stored status, assignment and actual Run state after the attempt, including errors\/timeouts/);
  assert.match(step(5), /A verified `todo` is success/);
  assert.match(step(5), /a different status or failed verification is reported as unconfirmed\/changed, never corrected by a second write/);
  assert.match(step(5), /Do not blindly retry, roll back, or add another trigger/);
}

const readFollowUpContract = () => readFileSync(join(agent, 'skills/issue-workflow/references/follow-up.md'), 'utf8');

test('follow-up document protects completion, eligibility, preflight and readback', () => {
  assertFollowUpContract(readFollowUpContract());
});

test('follow-up contract rejects a cancelled migration target', () => {
  const original = readFollowUpContract();
  const mutated = original.replace('`multica issue status <issue-id> todo`', '`multica issue status <issue-id> cancelled`');
  assert.notEqual(mutated, original, 'negative fixture must actually alter the command');
  assert.throws(() => assertFollowUpContract(mutated), { code: 'ERR_ASSERTION', message: /single migration command must target todo/ });
});

test('follow-up contract rejects removal of preflight status and revision checks', () => {
  const original = readFollowUpContract();
  const mutated = original.replace('Compare identity, workspace/project, assignee, status and revision with the analyzed snapshot.', 'Compare identity, workspace/project and assignee with the analyzed snapshot.');
  assert.notEqual(mutated, original, 'negative fixture must actually remove the preflight checks');
  assert.throws(() => assertFollowUpContract(mutated), { code: 'ERR_ASSERTION', message: /preflight must compare ownership, assignee, status and revision/ });
});

// Guidance contracts and real extension injection, not model decision tests.
function assertAppSessionContract(text) {
  for (const operation of ['App run/install', 'cause investigation', 'error analysis', 'reproduction', 'test requests']) {
    assert.ok(text.includes(operation), `missing operation: ${operation}`);
  }
  assert.match(text, /current-session tools|current PM session|current-session operations/);
  assert.match(text, /(?:reply with results|replying|unverified items) in chat/);
  assert.match(text, /(?:Tool use, multi-step analysis (?:or|and) repository inspection)(?: alone)? (?:do not require|do not authorize|does not require) Issue creation\/update, assignment or Agent startup/);
  assert.match(text, /Only explicit task recording or authorized code implementation enters/);
  assert.match(text, /Diagnosis\/tests\/install (?:grant no|do not authorize) source edits, fixes, commits, merges, pushes, deployment or (?:Issue )?closure/);
  assert.match(text, /Confirm payment, elevation, permission changes, sensitive-data actions and destructive operations/);
}

test('App operations contract reaches actual PM injection and both workflow layers', async () => {
  const h = harness({}, { enabled: true, target, issue: 'i' }); await h.start();
  const section = (await h.before()).systemPromptOptions.sections.multica_mode;
  assertAppSessionContract(section);
  const root = join(agent, 'skills/issue-workflow');
  for (const path of ['SKILL.md', 'references/execution.md']) {
    assertAppSessionContract(readFileSync(join(root, path), 'utf8'));
  }
  const execution = readFileSync(join(root, 'references/execution.md'), 'utf8');
  assert.match(execution, /“仅分析，不修改代码” remains diagnosis-only/);
  assert.match(execution, /issue identifier or PM issue focus does not itself request a task write or follow-up status transition/);
  assert.match(execution, /source rewrites, destructive fixtures or deployment hooks need their own authorization/);
  assert.match(section, /report source defects and wait for repair authorization/);
  assert.match(section, /clear ordinary authorization needs no repeat confirmation/);
  assert.match(section, /Clarify only material target\/platform\/environment ambiguity/);
  assert.match(section, /Code implementation goes to the issue owner/);
  assert.equal(h.calls.length, 0, 'injection with focused issue must not query or mutate platform');
  assert.equal(h.events.has('tool_call'), false, 'no blanket tool prohibition');
});

test('App contracts reject handoff, automatic repair and missing confirmation regressions', async () => {
  const h = harness({}, { enabled: true, target }); await h.start();
  const original = (await h.before()).systemPromptOptions.sections.multica_mode;
  for (const [before, after] of [
    ['do not require Issue creation/update, assignment or Agent startup', 'require Issue creation/update, assignment or Agent startup'],
    ['Only explicit task recording or authorized code implementation enters', 'Any operation needing tools enters'],
    ['Diagnosis/tests/install grant no source edits, fixes, commits, merges, pushes, deployment or closure', 'Failed tests authorize source edits and fixes'],
    ['Confirm payment, elevation, permission changes, sensitive-data actions and destructive operations', 'Installation authorizes all side effects'],
  ]) {
    const mutated = original.replace(before, after);
    assert.notEqual(mutated, original, `negative fixture must change: ${before}`);
    assert.throws(() => assertAppSessionContract(mutated), { code: 'ERR_ASSERTION' });
  }
});

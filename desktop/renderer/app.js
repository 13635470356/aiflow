/* aiflow 桌面版界面（Electron 和网页模式共用） */
'use strict';

// ───────── 传输层：Electron 用 preload 暴露的 window.aiflow；网页模式用 HTTP + SSE ─────────
const A = window.aiflow || (() => {
  const token = new URLSearchParams(location.search).get('t') || '';
  const subs = {};
  const es = new EventSource(`/events?t=${token}`);
  es.onmessage = (m) => { const { channel, payload } = JSON.parse(m.data); (subs[channel] || []).forEach((cb) => cb(payload)); };
  return {
    desktop: false,
    async call(channel, ...args) {
      const r = await fetch(`/api/${encodeURIComponent(channel)}`, { method: 'POST', headers: { 'x-aiflow-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      return j.result;
    },
    on(channel, cb) { (subs[channel] ||= []).push(cb); },
  };
})();
const call = async (ch, ...args) => {
  try { return await A.call(ch, ...args); } catch (e) { throw new Error(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
};

// ───────── 小工具 ─────────
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
// Markdown：AI 输出里的原始 HTML 一律转义，不执行
marked.use({ gfm: true, breaks: true, renderer: { html: (t) => esc(typeof t === 'string' ? t : t.text) } });
const md = (s) => h('div', { class: 'md', html: marked.parse(String(s || '')) });
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2600);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };
const fmtMs = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60000).toFixed(1)}m`);
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;

const S = { cwd: localStorage.getItem('aiflow.cwd') || '', tools: null, info: null, page: 'run' };

// ───────── 通用弹窗 ─────────
function openModal({ title, icon, wide, body, footer, closable = true, onClose }) {
  const root = $('#modal-root');
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-h' }, icon || null, h('h2', {}, title)),
    h('div', { class: 'modal-b' }, body),
    footer ? h('div', { class: 'modal-f' }, footer) : null);
  const bd = h('div', { class: 'backdrop' }, box);
  if (openModal.asRequest) bd.dataset.req = '1';
  const after = () => setTimeout(() => window.pumpRequests?.(), 30); // 你的弹窗关掉后，再弹出排队的拍板请求
  const close = () => { bd.remove(); after(); };                       // 按钮关闭：不触发 onClose
  const dismiss = () => { bd.remove(); onClose?.(); after(); };        // 点遮罩关闭：视为取消
  if (closable) bd.addEventListener('mousedown', (e) => { if (e.target === bd) dismiss(); });
  root.append(bd);
  setTimeout(() => box.querySelector('textarea, input, .btn.primary')?.focus(), 30);
  return { close, el: box };
}
function dialog({ title, text, input, value = '', buttons }) {
  return new Promise((resolve) => {
    const inp = input ? h('input', { type: 'text', value, placeholder: input }) : null;
    let m;
    const done = (v) => { m.close(); resolve(v); };
    const btns = buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), onclick: () => done(inp && b.value !== null ? { key: b.value, text: inp.value.trim() } : b.value) }, b.label));
    m = openModal({ title, body: [text ? h('p', { class: 'hint' }, text) : null, inp], footer: btns, onClose: () => resolve(null) });
    inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') btns.at(-1).click(); });
  });
}

// ───────── 导航与项目 ─────────
function go(page) {
  S.page = page;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => (p.hidden = p.id !== `page-${page}`));
  ({ run: loadRunForm, schedules: loadSchedules, history: loadHistory, workflows: loadWorkflows, tools: loadTools, stats: loadStats, settings: loadSettings })[page]?.();
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

function renderProject() {
  $('#project-name').textContent = S.cwd ? baseName(S.cwd) : '未选择（点击选择）';
  $('#project-path').textContent = S.cwd || '';
}
async function useProject(dir) {
  const r = await call('project:use', dir);
  S.cwd = r.cwd; localStorage.setItem('aiflow.cwd', S.cwd); renderProject();
  if (!r.isGit) toast('提示：这个文件夹不是 git 仓库，审核步骤依赖 git diff，也不方便回滚', true);
  go(S.page);
}
async function pickProjectDialog(current = S.cwd) {
  const info = await call('app:info');
  const recent = (info.recent || []).filter((p) => p !== current);
  return new Promise((resolve) => {
    const list = h('div', { class: 'steps' }, recent.map((p) => h('div', { class: 'stp', style: 'cursor:pointer', onclick: () => { m.close(); resolve(p); } }, h('div', { class: 'ti' }, baseName(p)), h('div', { class: 'path', style: 'font-size:12px;color:var(--text-3)' }, p))));
    const inp = h('input', { type: 'text', placeholder: '或粘贴文件夹路径，例如 D:\\code\\my-app', value: current || '' });
    const m = openModal({
      title: '选择项目文件夹',
      body: [recent.length ? h('div', { class: 'section-t' }, '最近使用') : null, recent.length ? list : null, inp],
      footer: [
        A.desktop ? h('button', { class: 'btn', onclick: async () => { const d = await call('os:pickFolder'); if (d) { m.close(); resolve(d); } } }, '浏览…') : null,
        h('button', { class: 'btn primary', onclick: () => { m.close(); resolve(inp.value.trim()); } }, '使用此路径'),
      ],
      onClose: () => resolve(null),
    });
  });
}
$('#project-box').addEventListener('click', guard(async () => {
  const pick = await pickProjectDialog();
  if (pick) { await useProject(pick); if (!formCwd()) { $('#run-cwd').value = pick; loadFormWorkflows(); } }
}));

// ───────── 工具页 ─────────
async function loadTools(data) {
  S.tools = data || (await call('tools:list'));
  const t = $('#tools-table');
  t.innerHTML = '';
  t.append(h('tr', {}, ['工具', '状态', '擅长 / 说明', ''].map((x) => h('th', {}, x))));
  for (const tool of S.tools.tools) {
    const det = tool.detected;
    const isMain = S.tools.main === tool.id;
    const row = h('tr', {},
      h('td', {}, h('div', { style: 'font-weight:600' }, tool.name, ' ', isMain ? h('span', { class: 'chip acc' }, '★ 主工具') : null),
        h('div', { class: 'path' }, tool.id, det ? ` · ${det.path}` : '')),
      h('td', {}, det ? h('span', { class: 'chip ok' }, '✔ ', det.version) : h('span', { class: 'chip' }, '未安装'),
        tool.unverified ? h('div', { style: 'font-size:11.5px;color:var(--text-3);margin-top:4px' }, '调用参数未验证') : null,
        tool.custom ? h('div', { style: 'font-size:11.5px;color:var(--text-3);margin-top:4px' }, '自定义') : null),
      h('td', { style: 'color:var(--text-2);font-size:13px' }, tool.strengths, tool.note ? h('div', { style: 'color:var(--warn);font-size:12px;margin-top:4px' }, tool.note) : null),
      h('td', { style: 'text-align:right;white-space:nowrap' },
        det && !isMain ? h('button', { class: 'btn small', onclick: guard(async () => { await loadTools(await call('tools:setMain', tool.id)); toast(`主工具已设为 ${tool.name}`); }) }, '设为主工具') : null, ' ',
        h('button', { class: 'btn small', onclick: guard(async () => toggleSkills(row, tool)) }, '查看能力')));
    t.append(row);
  }
}
async function toggleSkills(row, tool) {
  if (row.nextSibling?.classList?.contains('skills')) { row.nextSibling.remove(); return; }
  const info = await call('tools:skills', tool.id, S.cwd);
  const label = { skill: 'Skill', command: '斜杠命令', agent: '子代理', plugin: '插件', rules: '规则文件', mcp: 'MCP 配置' };
  const cell = h('td', { colspan: 4 });
  if (!Object.keys(info).length) cell.append(h('div', { style: 'color:var(--text-3)' }, '没有发现（或未配置 skillDirs）'));
  for (const [kind, list] of Object.entries(info)) {
    for (const { path, items } of list) {
      cell.append(h('h4', {}, label[kind] || kind), h('div', { class: 'path' }, path));
      if (items[0] !== '(存在)') cell.append(h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px' }, items.slice(0, 60).map((i) => h('span', { class: 'chip' }, i))));
    }
  }
  cell.append(h('div', { style: 'color:var(--text-3);font-size:12px;margin-top:6px' }, '这些能力由 CLI 自己加载。在工作流步骤里用 "use" 指定要优先使用的能力。'));
  row.after(h('tr', { class: 'skills' }, cell));
}
$('#tools-detect').addEventListener('click', guard(async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = '检测中…';
  try { await loadTools(await call('tools:detect')); toast('检测完成'); } finally { b.disabled = false; b.textContent = '重新检测'; }
}));

// ───────── 工作流页 ─────────
const WF = { list: [], cur: null, dirty: false };
const scopeLabel = { project: '项目', user: '用户', builtin: '内置' };
async function loadWorkflows(selectFile) {
  if (!S.tools) S.tools = await call('tools:list');
  WF.list = await call('wf:list', S.cwd);
  const box = $('#wf-list'); box.innerHTML = '';
  for (const w of WF.list) {
    box.append(h('div', { class: 'wf-item' + (WF.cur?.file === w.file ? ' active' : ''), onclick: () => openWorkflow(w) },
      h('div', { class: 'n' }, w.name, h('span', { class: `scope ${w.scope}` }, scopeLabel[w.scope])),
      h('div', { class: 'd' }, w.description)));
  }
  const target = WF.list.find((w) => w.file === selectFile) || (WF.cur && WF.list.find((w) => w.name === WF.cur.name));
  if (target) await openWorkflow(target);
}
const toolOptions = (sel, allowMain = true) => {
  const opts = [];
  if (allowMain) opts.push(h('option', { value: '@main', selected: sel === '@main' }, `@main（主工具：${S.tools.main || '未设置'}）`));
  for (const t of S.tools.tools) opts.push(h('option', { value: t.id, selected: sel === t.id }, `${t.id}${t.detected ? '' : '（未安装）'}`));
  if (sel && sel !== '@main' && !S.tools.tools.some((t) => t.id === sel)) opts.push(h('option', { value: sel, selected: true }, `${sel}（未知）`));
  return opts;
};
async function openWorkflow(w) {
  if (WF.dirty && WF.cur && WF.cur.file !== w.file) {
    const ok = await dialog({ title: '放弃未保存的修改？', text: `"${WF.cur.name}" 有修改还没保存。`, buttons: [{ label: '取消', value: false }, { label: '放弃修改', value: true, cls: 'primary' }] });
    if (!ok) return;
  }
  const r = await call('wf:load', S.cwd, w.file);
  WF.cur = { ...w, wf: r.wf, resolved: r.resolved, json: false };
  WF.dirty = false;
  document.querySelectorAll('.wf-item').forEach((el, i) => el.classList.toggle('active', WF.list[i]?.file === w.file));
  renderWorkflow();
}
function stepFlags(s, resolved) {
  const t = s.type || 'agent';
  const f = [];
  if (resolved[s.id]) f.push(h('span', { class: 'chip' }, h('b', {}, resolved[s.id])));
  if (s.role) f.push(h('span', { class: 'chip' }, '角色 ', s.role));
  if (t === 'interactive') f.push(h('span', { class: 'chip you' }, '你直接对话'));
  if (t === 'approve') f.push(h('span', { class: 'chip you' }, '你拍板'));
  if (s.mode === 'edit') f.push(h('span', { class: 'chip edit' }, '可改代码'));
  if (s.when) f.push(h('span', { class: 'chip' }, 'when: ', s.when));
  if (t === 'loop') f.push(h('span', { class: 'chip' }, `最多 ${s.max ?? 3} 轮 · until: ${s.until}`));
  if (s.isolation === 'worktree') f.push(h('span', { class: 'chip acc' }, '独立 worktree 并行'));
  if (s.artifact) f.push(h('span', { class: 'chip ok' }, '产出：', s.artifact));
  if (s.use?.length) f.push(h('span', { class: 'chip acc' }, 'use: ', s.use.join(', ')));
  if (s.ask === false) f.push(h('span', { class: 'chip' }, '不提问'));
  return f;
}
function renderSteps(steps, resolved) {
  return h('ul', { class: 'steps' }, (steps || []).map((s) => {
    const t = s.type || 'agent';
    const prompt = Array.isArray(s.prompt) ? s.prompt.join('\n') : s.prompt;
    const pre = prompt ? h('pre', { hidden: true }, prompt) : null;
    return h('li', { class: 'stp' },
      h('div', { class: 'stp-h', onclick: () => pre && (pre.hidden = !pre.hidden), title: prompt ? '点击查看提示词' : '' },
        h('span', { class: 'ty' }, t), h('span', { class: 'ti' }, s.title || s.id), ...stepFlags(s, resolved)),
      pre, s.steps ? renderSteps(s.steps, resolved) : null);
  }));
}
function renderWorkflow() {
  const c = WF.cur, box = $('#wf-detail');
  box.innerHTML = '';
  const markDirty = () => { WF.dirty = true; saveBtn.disabled = false; };
  const saveBtn = h('button', { class: 'btn primary', disabled: !WF.dirty, onclick: guard(() => saveWorkflowUi(false)) }, c.scope === 'builtin' ? '保存为副本' : '保存');
  box.append(
    h('div', { class: 'row between' },
      h('div', {}, h('h2', {}, c.name, h('span', { class: `scope ${c.scope}` }, scopeLabel[c.scope])), h('div', { class: 'sub' }, c.wf.description || ''), h('div', { class: 'path', style: 'font-size:11.5px;color:var(--text-3);margin-top:4px;font-family:var(--mono)' }, c.file)),
      h('div', { class: 'wf-actions' },
        h('button', { class: 'btn', onclick: () => { c.json = !c.json; renderWorkflow(); } }, c.json ? '可视化' : '编辑 JSON'),
        h('button', { class: 'btn', onclick: guard(() => saveWorkflowUi(true)) }, '另存为…'),
        c.scope !== 'builtin' ? h('button', { class: 'btn danger', onclick: guard(deleteWorkflowUi) }, '删除') : null,
        saveBtn)));
  if (c.json) {
    const ta = h('textarea', { class: 'mono editor', spellcheck: 'false', rows: 28 });
    ta.value = JSON.stringify(c.wf, null, 2);
    const err = h('div', { style: 'color:var(--err);font-size:12.5px;min-height:18px' });
    ta.addEventListener('input', () => { try { c.wf = JSON.parse(ta.value); err.textContent = ''; markDirty(); } catch (e) { err.textContent = 'JSON 格式错误：' + e.message; saveBtn.disabled = true; } });
    box.append(ta, err);
    return;
  }
  const roles = c.wf.roles || {};
  box.append(h('div', {}, h('div', { class: 'section-t' }, '角色分工（换工具只改这里）'),
    h('div', { class: 'roles' }, Object.entries(roles).map(([role, tool]) => {
      const sel = h('select', { onchange: (e) => { c.wf.roles[role] = e.target.value; markDirty(); } }, toolOptions(tool));
      return h('div', { class: 'role' }, h('label', {}, role), sel);
    }),
    h('div', { class: 'role', style: 'justify-content:center;border-style:dashed' }, h('button', { class: 'link', onclick: guard(async () => {
      const r = await dialog({ title: '新增角色', input: '角色名，例如 tester', buttons: [{ label: '取消', value: null }, { label: '添加', value: 'ok', cls: 'primary' }] });
      if (r?.text) { c.wf.roles = { ...(c.wf.roles || {}), [r.text]: '@main' }; WF.dirty = true; renderWorkflow(); }
    }) }, '+ 新增角色')))));
  box.append(h('div', {}, h('div', { class: 'section-t' }, '步骤（点击查看提示词；改步骤请用"编辑 JSON"）'), renderSteps(c.wf.steps, c.resolved)));
}
async function saveWorkflowUi(saveAs) {
  const c = WF.cur;
  let name = c.name, scope = c.scope;
  if (saveAs || scope === 'builtin') {
    const r = await dialog({ title: saveAs ? '另存为' : '保存内置工作流的副本', text: '保存到"项目"只对当前项目生效；保存到"用户"对所有项目生效。', input: '名称', value: saveAs ? `${c.name}-copy` : c.name,
      buttons: [{ label: '取消', value: null }, { label: '保存到用户', value: 'user' }, { label: '保存到项目', value: 'project', cls: 'primary' }] });
    if (!r?.key || !r.text) return;
    if (r.key === 'project' && !S.cwd) throw new Error('请先选择项目文件夹');
    name = r.text; scope = r.key;
  }
  const file = await call('wf:save', { cwd: S.cwd, scope, name, wf: c.wf });
  WF.dirty = false;
  toast(`已保存：${file}`);
  await loadWorkflows(file);
}
async function deleteWorkflowUi() {
  const ok = await dialog({ title: `删除工作流 ${WF.cur.name}？`, text: WF.cur.file, buttons: [{ label: '取消', value: false }, { label: '删除', value: true, cls: 'primary' }] });
  if (!ok) return;
  await call('wf:delete', WF.cur.file);
  WF.cur = null; WF.dirty = false;
  $('#wf-detail').innerHTML = '<div class="empty">已删除</div>';
  await loadWorkflows();
}
$('#wf-new').addEventListener('click', guard(async () => {
  const r = await dialog({ title: '新建工作流', text: '会以内置的 quick 工作流为模板。', input: '名称，例如 bugfix', buttons: [{ label: '取消', value: null }, { label: '保存到用户', value: 'user' }, { label: '保存到项目', value: 'project', cls: 'primary' }] });
  if (!r?.key || !r.text) return;
  const base = WF.list.find((w) => w.name === 'quick') || WF.list[0];
  const { wf } = await call('wf:load', S.cwd, base.file);
  wf.name = r.text; wf.description = '';
  const file = await call('wf:save', { cwd: S.cwd, scope: r.key, name: r.text, wf });
  await loadWorkflows(file);
}));

// ───────── 统计页 ─────────
async function loadStats() {
  const st = await call('stats:get', Number($('#stats-days').value));
  const box = $('#stats-body'); box.innerHTML = '';
  if (!st.total) { box.append(h('div', { class: 'card empty' }, '还没有统计数据，运行几次工作流后再来看。')); return; }
  const table = (title, rows) => h('div', { class: 'card stats-sec' },
    h('div', { class: 'card-h' }, title),
    h('table', { class: 'tbl' },
      h('tr', {}, ['名称', '次数', '成功率', '平均耗时', '超时', '追问', '费用 (USD)'].map((x, i) => h('th', { class: i ? 'num' : '' }, x))),
      rows.map((a) => h('tr', {}, h('td', {}, a.name), h('td', { class: 'num' }, a.n),
        h('td', { class: 'num' }, h('span', { class: 'bar' }, h('i', { style: `width:${(a.okRate * 100).toFixed(0)}%;${a.okRate < 0.8 ? 'background:var(--warn)' : ''}` })), `${(a.okRate * 100).toFixed(0)}%`),
        h('td', { class: 'num' }, fmtMs(a.avgMs)), h('td', { class: 'num' }, a.timeout), h('td', { class: 'num' }, a.asks), h('td', { class: 'num' }, a.cost ? a.cost.toFixed(3) : '-')))));
  box.append(h('p', { class: 'sub', style: 'margin:0 0 12px' }, `最近 ${st.days} 天共 ${st.total} 次调用。费用只有 Claude 会返回；订阅账号显示的是换算值。`),
    table('按工具', st.byTool), table('按角色 → 工具', st.byRole), table('按工作流步骤', st.byStep));
}
$('#stats-days').addEventListener('change', guard(loadStats));

// ───────── 设置页 ─────────
async function loadSettings() {
  const [cfg, info, app] = await Promise.all([call('config:get'), call('app:info'), call('app:settings')]);
  $('#set-max').value = app.maxConcurrent;
  $('#set-tray').checked = app.trayOnClose;
  $('#set-login').checked = app.openAtLogin;
  document.querySelectorAll('.desktop-only').forEach((el) => (el.hidden = !A.desktop));
  $('#settings-path').textContent = `配置目录：${info.home}`;
  $('#set-timeout').value = cfg.defaultTimeoutMin;
  $('#set-overrides').value = JSON.stringify(cfg.overrides || {}, null, 2);
  $('#set-custom').value = JSON.stringify(cfg.custom || {}, null, 2);
  const it = cfg.integrations || {};
  $('#set-conf-base').value = it.confluence?.baseUrl || '';
  $('#set-conf-email').value = it.confluence?.email || '';
  $('#set-conf-token').value = it.confluence?.token || '';
  $('#set-figma-token').value = it.figma?.token || '';
}
$('#settings-save').addEventListener('click', guard(async () => {
  let overrides, custom;
  try { overrides = JSON.parse($('#set-overrides').value || '{}'); } catch (e) { throw new Error('overrides 不是合法 JSON：' + e.message); }
  try { custom = JSON.parse($('#set-custom').value || '{}'); } catch (e) { throw new Error('custom 不是合法 JSON：' + e.message); }
  const v = (id) => $(id).value.trim();
  const integrations = {
    confluence: { baseUrl: v('#set-conf-base'), email: v('#set-conf-email'), token: v('#set-conf-token') },
    figma: { token: v('#set-figma-token') },
  };
  await call('config:save', { defaultTimeoutMin: Number($('#set-timeout').value) || 30, overrides, custom, integrations });
  await call('app:saveSettings', { maxConcurrent: Number($('#set-max').value) || 3, trayOnClose: $('#set-tray').checked, openAtLogin: $('#set-login').checked });
  toast('已保存。改了工具配置的话，到"工具"页重新检测。');
}));

// ───────── 需求素材 ─────────
const IN = { files: [], links: [] };
try { Object.assign(IN, JSON.parse(localStorage.getItem('aiflow.inputs') || '{}')); } catch { /* 忽略 */ }
const linkLabel = (u) => (/figma\.com/.test(u) ? 'Figma' : /atlassian\.net|\/wiki\/|viewpage\.action|\/display\//.test(u) ? 'Confluence' : '链接');
function renderInputs() {
  localStorage.setItem('aiflow.inputs', JSON.stringify(IN));
  const box = $('#inputs-list'); box.innerHTML = '';
  IN.files.forEach((f, i) => box.append(h('span', { class: 'in-chip', title: f.path }, h('span', { class: 'k' }, '文件'), h('span', { class: 'n' }, f.name),
    h('button', { title: '移除', onclick: () => { IN.files.splice(i, 1); renderInputs(); } }, '×'))));
  IN.links.forEach((u, i) => box.append(h('span', { class: 'in-chip', title: u }, h('span', { class: 'k' }, linkLabel(u)), h('span', { class: 'n' }, u),
    h('button', { title: '移除', onclick: () => { IN.links.splice(i, 1); renderInputs(); } }, '×'))));
}
async function addFileObjects(fileList) {
  for (const f of fileList) {
    if (f.size > 80 * 1024 * 1024) { toast(`${f.name} 超过 80MB`, true); continue; }
    const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
    const path = await call('inputs:upload', { name: f.name, base64 });
    IN.files.push({ name: f.name, path });
  }
  renderInputs();
}
$('#inputs-add-file').addEventListener('click', guard(async () => {
  if (A.desktop) {
    const paths = await call('os:pickFiles');
    if (Array.isArray(paths)) { paths.forEach((p) => IN.files.push({ name: baseName(p), path: p })); renderInputs(); return; }
  }
  $('#inputs-file').click();
}));
$('#inputs-file').addEventListener('change', guard(async (e) => { await addFileObjects([...e.target.files]); e.target.value = ''; }));
$('#inputs-add-link').addEventListener('click', guard(async () => {
  const r = await dialog({ title: '添加需求链接', text: 'Confluence 页面、Figma 设计稿（可带 node-id 指定画板）或任意网页。需要登录的页面请先在"设置 → 集成"里配置令牌；取不到时会交给子 agent 用它的 MCP 访问。', input: 'https://...', buttons: [{ label: '取消', value: null }, { label: '添加', value: 'ok', cls: 'primary' }] });
  if (!r?.text) return;
  for (const u of r.text.split(/\s+/).filter(Boolean)) {
    try { new URL(u); IN.links.push(u); } catch { toast(`不是有效的网址：${u}`, true); }
  }
  renderInputs();
}));
const zone = $('#inputs-zone');
['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
zone.addEventListener('drop', guard(async (e) => {
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (e.dataTransfer.files.length) await addFileObjects([...e.dataTransfer.files]);
  else if (/^https?:\/\//.test(text)) { IN.links.push(text.trim()); renderInputs(); }
}));
renderInputs();

// ───────── 任务页：可以同时运行多个任务 ─────────
const JOBS = new Map();   // jobId → 任务信息（来自 job:update）
const VIEWS = new Map();  // jobId → RunView
let SEL = null;           // 当前查看的任务
const statusText = { queued: '排队中', running: '运行中', waiting: '等你拍板', done: '完成', failed: '失败', stopped: '已停止' };

// 新建任务表单
function formCwd() { return $('#run-cwd').value.trim(); }
async function loadRunForm() {
  if (!$('#run-cwd').value && S.cwd) $('#run-cwd').value = S.cwd;
  await loadFormWorkflows();
}
async function loadFormWorkflows() {
  const sel = $('#run-wf');
  const prev = sel.value ? baseName(sel.value).replace(/\.json$/, '') : localStorage.getItem('aiflow.wfname') || 'default';
  const list = await call('wf:list', formCwd() || S.cwd);
  sel.innerHTML = '';
  for (const w of list) sel.append(h('option', { value: w.file, selected: w.name === prev }, `${w.name}（${scopeLabel[w.scope]}）— ${w.description}`));
  await showRoles();
}
async function showRoles() {
  const box = $('#run-wf-roles'); box.innerHTML = '';
  if (!$('#run-wf').value) return;
  const { wf } = await call('wf:load', formCwd() || S.cwd, $('#run-wf').value);
  const tools = S.tools || (S.tools = await call('tools:list'));
  for (const [role, tool] of Object.entries(wf.roles || {})) {
    const real = tool === '@main' ? tools.main : tool;
    const ok = tools.tools.find((t) => t.id === real)?.detected;
    box.append(h('span', { class: 'chip' + (ok ? '' : ' err'), title: ok ? '' : `${real} 未安装，会回退到主工具` }, role, ' → ', h('b', {}, real || '?')));
  }
  updateStartButton();
}
function updateStartButton() {
  const cwd = formCwd().toLowerCase().replace(/[\\/]+$/, '');
  const busy = [...JOBS.values()].some((j) => ['running', 'waiting', 'queued'].includes(j.status) && j.cwd.toLowerCase().replace(/[\\/]+$/, '') === cwd);
  $('#run-start').textContent = busy ? '加入队列' : '开始运行';
  $('#run-start').title = busy ? '这个项目已有任务，新任务会在它结束后自动开始' : '';
}
$('#run-wf').addEventListener('change', guard(async () => { localStorage.setItem('aiflow.wfname', baseName($('#run-wf').value).replace(/\.json$/, '')); await showRoles(); }));
$('#run-cwd').addEventListener('change', guard(loadFormWorkflows));
$('#run-cwd').addEventListener('input', updateStartButton);
$('#run-cwd-pick').addEventListener('click', guard(async () => {
  const d = await pickProjectDialog(formCwd());
  if (d) { $('#run-cwd').value = d; await call('project:use', d); await loadFormWorkflows(); }
}));
$('#run-task').value = localStorage.getItem('aiflow.task') || '';
$('#run-task').addEventListener('input', () => localStorage.setItem('aiflow.task', $('#run-task').value));
$('#form-toggle').addEventListener('click', () => { const c = $('#run-form').classList.toggle('collapsed'); $('#form-toggle').textContent = c ? '展开' : '收起'; });

$('#run-start').addEventListener('click', guard(async () => {
  const cwd = formCwd();
  if (!cwd) { $('#run-cwd-pick').click(); return; }
  await call('project:use', cwd);
  const job = await call('run:start', { cwd, file: $('#run-wf').value, task: $('#run-task').value, inputs: { files: IN.files.map((f) => f.path), links: IN.links }, dryRun: $('#run-dry').checked, autoApprove: $('#run-auto').checked });
  onJob(job);
  selectJob(job.id);
  toast(job.status === 'queued' ? `已加入队列：${job.queuedReason}` : '任务已开始');
}));
$('#run-schedule').addEventListener('click', guard(() => openScheduleEditor({
  cwd: formCwd(), workflow: $('#run-wf').value, task: $('#run-task').value,
  inputs: { files: IN.files.map((f) => f.path), links: [...IN.links] }, approval: $('#run-auto').checked ? 'auto' : 'wait',
})));

// 任务列表
function onJob(j) {
  const prev = JOBS.get(j.id);
  JOBS.set(j.id, j);
  if (!VIEWS.has(j.id)) VIEWS.set(j.id, new RunView(j));
  renderJobs();
  if (SEL === j.id) renderJobHead();
  if (!SEL) selectJob(j.id);
  if (prev && prev.status !== j.status && j.source === 'schedule' && j.status === 'running') toast(`定时任务"${j.scheduleName}"已开始（${j.project}）`);
  updateStartButton();
}
A.on('job:update', onJob);
function renderJobs() {
  const box = $('#job-list'); box.innerHTML = '';
  const list = [...JOBS.values()].reverse();
  if (!list.length) box.append(h('div', { class: 'empty', style: 'padding:16px' }, '还没有任务'));
  for (const j of list) {
    box.append(h('div', { class: 'job' + (SEL === j.id ? ' sel' : ''), onclick: () => selectJob(j.id) },
      h('div', { class: 'l1' }, h('span', { class: 'pj' }, j.project), j.source === 'schedule' ? h('span', { class: 'chip acc', title: j.scheduleName }, '⏰ 定时') : null, h('span', { class: `js ${j.status}` }, statusText[j.status] || j.status)),
      h('div', { class: 'tk', title: j.task }, j.task),
      h('div', { class: 'mt' }, h('span', {}, j.workflowName), j.autoApprove ? h('span', {}, '无人值守') : null, j.queuedReason && j.status === 'queued' ? h('span', {}, j.queuedReason) : null, j.error ? h('span', { style: 'color:var(--err)' }, j.error.slice(0, 60)) : null)));
  }
  const active = list.filter((j) => ['running', 'waiting'].includes(j.status)).length;
  const queued = list.filter((j) => j.status === 'queued').length;
  const waiting = list.filter((j) => j.status === 'waiting').length;
  const badge = $('#nav-running'); badge.hidden = !active && !queued; badge.textContent = active + queued;
  $('#run-status').innerHTML = '';
  if (active) $('#run-status').append(h('div', { class: 'spinner' }), h('span', { style: 'color:var(--text-2)' }, `${active} 个运行中${queued ? ` · ${queued} 个排队` : ''}${waiting ? ` · ${waiting} 个等你拍板` : ''}`));
  else if (queued) $('#run-status').append(h('span', { style: 'color:var(--text-2)' }, `${queued} 个排队`));
}
function renderJobHead() {
  const j = JOBS.get(SEL), box = $('#job-head'); box.innerHTML = '';
  if (!j) return;
  const live = ['running', 'waiting', 'queued'].includes(j.status);
  box.append(...[h('span', { class: `js ${j.status}`, style: 'margin:0' }, statusText[j.status]),
    h('div', { style: 'min-width:0;flex:1' }, h('div', { class: 't', title: j.task }, `${j.project} · ${j.task}`), h('div', { class: 'p' }, j.cwd)),
    j.runDir ? h('button', { class: 'btn small', onclick: () => call('os:openPath', j.runDir) }, '记录目录') : null,
    live ? h('button', { class: 'btn small danger', onclick: guard(async () => {
      const ok = await dialog({ title: `停止任务（${j.project}）？`, text: '会立即结束这个任务的所有子 agent。已经改动的代码不会回滚。', buttons: [{ label: '继续运行', value: false }, { label: '停止', value: true, cls: 'primary' }] });
      if (ok) await call('run:stop', j.id);
    }) }, j.status === 'queued' ? '取消排队' : '停止') : h('button', { class: 'btn small', onclick: guard(async () => { await call('jobs:remove', j.id); JOBS.delete(j.id); VIEWS.delete(j.id); SEL = null; renderJobs(); $('#job-head').innerHTML = ''; $('#timeline-host').innerHTML = ''; $('#console-host').innerHTML = '<div class="empty">选择左侧的任务查看进度</div>'; }) }, '从列表移除')].filter(Boolean));
}
function selectJob(id) {
  SEL = id;
  const v = VIEWS.get(id);
  $('#timeline-host').innerHTML = ''; $('#console-host').innerHTML = '';
  if (v) { $('#timeline-host').append(v.timelineEl, v.runDirEl); $('#console-host').append(v.root); }
  renderJobs(); renderJobHead();
}

// 每个任务一个视图：时间线 + 各子 agent 日志标签页 + 成果
class RunView {
  constructor(job) {
    this.jobId = job.id; this.cwd = job.cwd;
    this.steps = new Map(); this.order = []; this.curStep = new Map();
    this.panels = new Map(); this.blocks = new Map(); this.artifacts = [];
    this.active = null; this.pinnedAt = 0; this.runId = null;
    this.timelineEl = h('ol'); this.runDirEl = h('div', { class: 'run-dir' });
    this.tabs = h('div', { class: 'tabs' }); this.panelsEl = h('div', { class: 'panels' });
    this.root = h('div', { class: 'runview' }, this.tabs, this.panelsEl);
    this.panel('main', '主控');
    this.artsEl = h('div', { class: 'arts' });
    this.panel('artifacts', '📄 成果').el.append(this.artsEl);
    this.renderArtifacts();
    if (job.status !== 'queued' && job.startedAt && Date.now() - Date.parse(job.startedAt) > 3000) this.mainLog('warn', '界面打开前的日志不再显示，完整记录可在"记录"页查看。');
  }
  panel(id, label) {
    if (this.panels.has(id)) return this.panels.get(id);
    const dot = h('span', { class: 'dot' });
    const tab = h('button', { class: 'tab', onclick: () => { this.pinnedAt = Date.now(); this.activate(id); } }, dot, label);
    const el = h('div', { class: 'panel', hidden: true });
    this.tabs.append(tab); this.panelsEl.append(el);
    const p = { id, tab, dot, el };
    this.panels.set(id, p);
    if (!this.active) this.activate(id);
    return p;
  }
  activate(id) {
    this.active = id;
    for (const [k, p] of this.panels) { p.tab.classList.toggle('active', k === id); p.el.hidden = k !== id; if (k === id) p.dot.classList.remove('new'); }
  }
  autoFocus(id) { if (Date.now() - this.pinnedAt > 8000) this.activate(id); }
  appendTo(p, target, node) {
    const nearBottom = p.el.scrollHeight - p.el.scrollTop - p.el.clientHeight < 80;
    target.append(node);
    while (target.childElementCount > 4000) target.firstChild.remove();
    if (nearBottom) p.el.scrollTop = p.el.scrollHeight;
    if (this.active !== p.id && !p.dot.classList.contains('busy')) p.dot.classList.add('new');
  }
  mainLog(cls, text) { const p = this.panel('main', '主控'); this.appendTo(p, p.el, h('div', { class: 'ln ' + cls }, text)); }
  toolOut(d, node) { const p = this.panel(d.tool, d.tool); const blk = this.blocks.get(`${d.tool}|${d.stepId}`); this.appendTo(p, blk ? blk.querySelector('.blk-b') : p.el, node); }
  setStep(key, status, chip) {
    const s = this.steps.get(key); if (!s) return;
    s.el.className = status; s.status = status;
    s.el.querySelector('.st').textContent = { done: '✓', failed: '!', waiting: '?', skipped: '' }[status] || '';
    if (chip) s.sub.append(h('span', { class: 'chip' }, chip));
  }
  stepItem(d) {
    const key = d.iter ? `${d.stepId}#${d.iter}` : d.stepId;
    if (this.steps.has(key)) { this.setStep(key, 'running'); return key; }
    const sub = h('div', { class: 't-sub' }, d.lane ? h('span', { class: 'chip acc' }, 'worktree') : null);
    const el = h('li', { class: 'running', style: `margin-left:${d.depth * 14}px`, title: '点击查看这一步的输入和输出', onclick: () => openStepDetail(this, d.stepId, d.title) },
      h('span', { class: 'st' }), h('div', {}, h('div', { class: 't-title' }, d.title), sub));
    this.timelineEl.append(el);
    if (SEL === this.jobId) el.scrollIntoView({ block: 'nearest' });
    this.steps.set(key, { el, sub, depth: d.depth, status: 'running', tools: new Set(), title: d.title });
    this.order.push(key);
    return key;
  }
  allRunning(status) { for (const k of this.order) if (this.steps.get(k).status === 'running') this.setStep(k, status); }
  markWaiting(stepId, on) {
    const k = this.curStep.get(stepId); if (!k) return;
    const s = this.steps.get(k);
    if (on && s.status === 'running') this.setStep(k, 'waiting');
    if (!on && s.status === 'waiting') this.setStep(k, 'running');
  }
  renderArtifacts() {
    this.artsEl.innerHTML = '';
    if (!this.artifacts.length) { this.artsEl.append(h('div', { class: 'empty' }, '需求定稿、实施方案、代码检查报告、代码变更会出现在这里')); return; }
    for (const a of this.artifacts) this.artsEl.append(artifactCard(a));
  }
  handle(type, d) {
    switch (type) {
      case 'run-start':
        this.runId = d.runId; this.runDir = d.runDir;
        this.runDirEl.innerHTML = '';
        this.runDirEl.append('记录目录：', h('button', { class: 'link', onclick: () => call('os:openPath', d.runDir) }, d.runDir));
        this.mainLog('info', `▶ 工作流 ${d.workflow} · 主工具 ${d.main}`);
        break;
      case 'step': {
        const key = this.stepItem(d);
        this.curStep.set(d.stepId, key);
        this.mainLog('stephead', `${'  '.repeat(d.depth)}━━ ${d.title}  [${d.type}]${d.lane ? '  · worktree' : ''}`);
        break;
      }
      case 'step-done': this.setStep(this.curStep.get(d.stepId) || d.stepId, d.status === 'failed' ? 'failed' : 'done', d.status === 'redo' ? '已退回重做' : null); break;
      case 'skip': this.setStep(this.curStep.get(d.stepId), 'skipped', '已跳过'); this.mainLog('', `  ↷ 条件不满足，跳过（when: ${d.when}）`); break;
      case 'info': {
        this.mainLog({ ok: 'ok', warn: 'warn', err: 'bad', dim: 'err' }[d.level] || 'info', d.text);
        if (d.text.startsWith('↻')) this.timelineEl.append(h('li', { class: 'iter', style: `margin-left:${(d.depth + 1) * 14}px` }, d.text.replace(/^↻\s*/, '')));
        break;
      }
      case 'artifact': {
        const i = this.artifacts.findIndex((x) => x.title === d.title);
        if (i >= 0) this.artifacts[i] = d; else this.artifacts.push(d);
        this.renderArtifacts();
        this.mainLog('ok', `📄 产出物「${d.title}」已更新`);
        const p = this.panels.get('artifacts'); if (this.active !== 'artifacts') p.dot.classList.add('new');
        break;
      }
      case 'tool-start': {
        const p = this.panel(d.tool, d.tool);
        const st = this.steps.get(this.curStep.get(d.stepId));
        if (st && !st.tools.has(d.tool)) { st.tools.add(d.tool); st.sub.append(h('span', { class: 'chip' + (d.interactive ? ' you' : '') }, d.tool)); }
        const blk = h('div', { class: 'blk' },
          h('div', { class: 'blk-h' }, h('span', { class: 'step' }, st?.title || d.stepId), d.lane ? h('span', { class: 'chip acc' }, 'worktree') : null,
            d.round ? h('span', { class: 'chip you' }, `回答后第 ${d.round} 次`) : null, d.interactive ? h('span', { class: 'chip you' }, '前台') : null,
            h('span', { class: 'cmd', title: d.cmd }, d.cmd), d.promptFile ? h('button', { class: 'link', onclick: () => viewFile(d.promptFile, '输入（提示词）') }, '输入') : null),
          h('div', { class: 'blk-b' }));
        p.el.append(blk);
        this.blocks.set(`${d.tool}|${d.stepId}`, blk);
        p.dot.className = 'dot busy';
        this.autoFocus(d.tool);
        p.el.scrollTop = p.el.scrollHeight;
        break;
      }
      case 'tool-line': this.toolOut(d, h('div', { class: 'ln' + (d.stream === 'stderr' ? ' err' : '') }, d.text)); break;
      case 'tool-use': this.toolOut(d, h('div', { class: 'ln use' }, `🔧 ${d.name} `, h('span', { class: 'd' }, d.detail))); break;
      case 'tool-meta': this.toolOut(d, h('div', { class: 'ln meta' }, d.text)); break;
      case 'tool-done': {
        const p = this.panel(d.tool, d.tool);
        const blk = this.blocks.get(`${d.tool}|${d.stepId}`);
        const status = d.dryRun ? h('span', { class: 'chip' }, '预览') : d.timedOut ? h('span', { class: 'chip err' }, '超时终止') : d.ok ? h('span', { class: 'chip ok' }, '完成') : h('span', { class: 'chip err' }, '失败');
        blk?.append(h('div', { class: 'blk-f' }, status, h('span', {}, fmtMs(d.ms || 0)), d.cost ? h('span', {}, `$${d.cost.toFixed(4)}`) : null,
          d.outFile ? h('button', { class: 'link', onclick: () => viewFile(d.outFile, '输出') }, '输出') : null));
        p.dot.className = 'dot ' + (d.ok ? 'ok' : 'err');
        break;
      }
      case 'done': this.allRunning('done'); this.mainLog('ok', '✔ 工作流完成'); this.activate('artifacts'); this.endTabs(); break;
      case 'error': this.allRunning('failed'); this.mainLog('bad', `✘ ${d.message}`); this.endTabs(); break;
    }
  }
  endTabs() { for (const p of this.panels.values()) if (p.dot.classList.contains('busy')) p.dot.className = 'dot'; }
}
A.on('run:event', ({ jobId, type, data }) => {
  let v = VIEWS.get(jobId);
  if (!v) { v = new RunView({ id: jobId, cwd: '' }); VIEWS.set(jobId, v); }
  v.handle(type, data);
  if (type === 'done' && JOBS.get(jobId)) toast(`[${JOBS.get(jobId).project}] 任务完成，成果在"📄 成果"标签页`);
  if (type === 'error' && JOBS.get(jobId)) toast(`[${JOBS.get(jobId).project}] ${data.message}`, true);
});

// ───────── 定时任务页 ─────────
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const schedStatus = { done: '完成', failed: '失败', stopped: '已停止', missed: '错过' };
async function loadSchedules() {
  const [list, log] = await Promise.all([call('sched:list'), call('sched:log')]);
  const box = $('#sched-list'); box.innerHTML = '';
  if (!list.length) box.append(h('div', { class: 'card empty' }, '还没有定时任务。可以点右上角新建，或在"任务"页填好需求后点"设为定时任务…"'));
  for (const x of list) {
    const sw = h('button', { class: 'switch' + (x.enabled ? ' on' : ''), title: x.enabled ? '已启用' : '已停用', onclick: guard(async () => { await call('sched:enable', x.id, !x.enabled); loadSchedules(); }) });
    const hist = h('div', { hidden: true, style: 'grid-column:1/-1' }, h('table', { class: 'tbl' },
      h('tr', {}, ['时间', '结果', '说明', ''].map((t) => h('th', {}, t))),
      (x.history || []).map((r) => h('tr', {}, h('td', {}, fmtTime(r.at)), h('td', {}, h('span', { class: `st-badge ${r.status === 'missed' ? 'stopped' : r.status}` }, schedStatus[r.status] || r.status)),
        h('td', { style: 'color:var(--text-2);font-size:12.5px' }, r.error || ''), h('td', {}, r.runDir ? h('button', { class: 'link', onclick: () => call('os:openPath', r.runDir) }, '记录目录') : null)))));
    box.append(h('div', { class: 'card sc' + (x.enabled ? '' : ' off') }, sw,
      h('div', { style: 'min-width:0' },
        h('div', { class: 'nm' }, x.name, h('span', { class: 'chip acc' }, x.whenText), h('span', { class: 'chip' + (x.approval === 'wait' ? ' you' : '') }, x.approval === 'wait' ? '等我拍板' : '无人值守'),
          x.lastStatus ? h('span', { class: `st-badge ${x.lastStatus === 'missed' ? 'stopped' : x.lastStatus}` }, `上次：${schedStatus[x.lastStatus] || x.lastStatus}`) : null),
        h('div', { class: 'ds' }, h('span', {}, `📁 ${x.project}`), h('span', {}, `⇄ ${baseName(x.workflow).replace(/\.json$/, '')}`), h('span', {}, `下次：${x.enabled ? fmtTime(x.nextRun) : '已停用'}`)),
        h('div', { class: 'ds', title: x.task }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.task))),
      h('div', { class: 'wf-actions' },
        h('button', { class: 'btn small', onclick: guard(async () => { const j = await call('sched:runNow', x.id); onJob(j); go('run'); selectJob(j.id); }) }, '立即运行'),
        (x.history || []).length ? h('button', { class: 'btn small', onclick: () => (hist.hidden = !hist.hidden) }, '历史') : null,
        h('button', { class: 'btn small', onclick: () => openScheduleEditor(x) }, '编辑'),
        h('button', { class: 'btn small danger', onclick: guard(async () => {
          const ok = await dialog({ title: `删除定时任务"${x.name}"？`, buttons: [{ label: '取消', value: false }, { label: '删除', value: true, cls: 'primary' }] });
          if (ok) { await call('sched:delete', x.id); loadSchedules(); }
        }) }, '删除')),
      hist));
  }
  const lg = $('#sched-log'); lg.innerHTML = '';
  if (!log.length) lg.append(h('div', {}, '暂无'));
  for (const l of log.slice(0, 50)) lg.append(h('div', { style: l.level === 'warn' ? 'color:var(--warn)' : l.level === 'err' ? 'color:var(--err)' : '' }, `${new Date(l.at).toLocaleString()}  ${l.text}`));
}
A.on('sched:changed', () => { if (S.page === 'schedules') loadSchedules(); });
A.on('sched:log', () => { if (S.page === 'schedules') loadSchedules(); });
$('#sched-new').addEventListener('click', () => openScheduleEditor({ cwd: S.cwd }));

async function openScheduleEditor(x = {}) {
  const st = {
    id: x.id, name: x.name || '', cwd: x.cwd || S.cwd || '', workflow: x.workflow || '', task: x.task || '',
    inputs: { files: [...(x.inputs?.files || [])], links: [...(x.inputs?.links || [])] },
    when: x.when ? { ...x.when } : { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, approval: x.approval || 'auto',
  };
  const name = h('input', { type: 'text', value: st.name, placeholder: '例如：每天早上自动修复 lint 问题' });
  const cwd = h('input', { type: 'text', value: st.cwd, class: 'grow', placeholder: 'D:\\code\\my-app' });
  const wfSel = h('select', {});
  const task = h('textarea', { rows: 3, placeholder: '需求，写法和手动运行一样' }); task.value = st.task;
  const links = h('textarea', { rows: 2, placeholder: '需求链接，每行一个（可选）' }); links.value = st.inputs.links.join('\n');
  const filesBox = h('div', { class: 'inputs-list' });
  const renderFiles = () => { filesBox.innerHTML = ''; st.inputs.files.forEach((f, i) => filesBox.append(h('span', { class: 'in-chip', title: f }, h('span', { class: 'k' }, '文件'), h('span', { class: 'n' }, baseName(f)), h('button', { onclick: () => { st.inputs.files.splice(i, 1); renderFiles(); } }, '×')))); };
  renderFiles();
  const loadWfs = async () => {
    wfSel.innerHTML = '';
    try {
      const list = await call('wf:list', cwd.value.trim());
      const cur = st.workflow ? baseName(st.workflow).replace(/\.json$/, '') : 'quick';
      for (const w of list) wfSel.append(h('option', { value: w.file, selected: w.file === st.workflow || w.name === cur }, `${w.name}（${scopeLabel[w.scope]}）`));
    } catch (e) { toast(e.message, true); }
  };
  cwd.addEventListener('change', loadWfs);
  await loadWfs();

  // 时间规则
  const kinds = [['daily', '每天'], ['weekly', '每周'], ['interval', '每隔几小时'], ['once', '只执行一次'], ['cron', 'cron 表达式']];
  const kindSeg = h('div', { class: 'seg' });
  const whenBox = h('div', { class: 'row', style: 'align-items:center;flex-wrap:wrap' });
  const preview = h('div', { class: 'preview' });
  const refreshPreview = async () => {
    try { const ts = await call('sched:preview', st.when); preview.textContent = ts.length ? `接下来：${ts.map((t) => new Date(t).toLocaleString()).join('；')}` : '没有将来的执行时间'; preview.style.color = ''; }
    catch (e) { preview.textContent = e.message; preview.style.color = 'var(--err)'; }
  };
  const renderWhen = () => {
    kindSeg.innerHTML = '';
    for (const [k, l] of kinds) kindSeg.append(h('button', { class: st.when.kind === k ? 'on' : '', onclick: () => {
      const t = st.when.time || '09:00';
      st.when = { daily: { kind: 'daily', time: t }, weekly: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: t }, interval: { kind: 'interval', hours: 2 }, once: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString().slice(0, 16) }, cron: { kind: 'cron', expr: '0 9 * * 1-5' } }[k];
      renderWhen();
    } }, l));
    whenBox.innerHTML = '';
    const w = st.when;
    const timeInp = () => { const i = h('input', { type: 'time', value: w.time || '09:00' }); i.addEventListener('change', () => { w.time = i.value; refreshPreview(); }); return i; };
    if (w.kind === 'daily') whenBox.append('时间', timeInp());
    if (w.kind === 'weekly') {
      const wd = h('div', { class: 'wd' }, [1, 2, 3, 4, 5, 6, 7].map((d) => h('button', { class: w.days.includes(d) ? 'on' : '', onclick: (e) => {
        w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort(); e.target.classList.toggle('on'); refreshPreview();
      } }, '一二三四五六日'[d - 1])));
      whenBox.append(wd, '时间', timeInp());
    }
    if (w.kind === 'interval') { const i = h('input', { type: 'number', min: 1, max: 23, value: w.hours, style: 'width:80px' }); i.addEventListener('change', () => { w.hours = +i.value; refreshPreview(); }); whenBox.append('每', i, '小时（整点执行）'); }
    if (w.kind === 'once') { const i = h('input', { type: 'datetime-local', value: (w.at || '').slice(0, 16) }); i.addEventListener('change', () => { w.at = i.value; refreshPreview(); }); whenBox.append('执行时间', i); }
    if (w.kind === 'cron') { const i = h('input', { type: 'text', value: w.expr, class: 'mono', style: 'width:220px' }); i.addEventListener('change', () => { w.expr = i.value.trim(); refreshPreview(); }); whenBox.append(i, h('small', { style: 'color:var(--text-3)' }, '分 时 日 月 周，例如 */30 9-18 * * 1-5')); }
    refreshPreview();
  };
  renderWhen();

  const approval = h('div', { class: 'radio' });
  const renderApproval = () => {
    approval.innerHTML = '';
    for (const [k, t, d] of [['auto', '无人值守', '自动通过所有拍板，子 agent 的问题按它的推荐处理，需要你直接对话的步骤会跳过，合并冲突交给主工具。适合固定、明确的任务。'],
      ['wait', '等我拍板', '到点开始后，遇到拍板和提问会弹窗并发系统通知，等你处理。需要 aiflow 开着（托盘里也行）。']]) {
      approval.append(h('label', { class: st.approval === k ? 'on' : '', onclick: () => { st.approval = k; renderApproval(); } }, h('input', { type: 'radio', name: 'appr', checked: st.approval === k }), h('div', {}, h('b', {}, t), h('small', {}, d))));
    }
  };
  renderApproval();

  const m = openModal({
    title: st.id ? '编辑定时任务' : '新建定时任务', wide: true,
    body: [
      h('label', { class: 'field' }, h('span', {}, '名称'), name),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', {}, '项目文件夹'), h('div', { class: 'row', style: 'gap:6px' }, cwd, h('button', { class: 'btn', onclick: guard(async () => { const d = await pickProjectDialog(cwd.value); if (d) { cwd.value = d; loadWfs(); } }) }, '选择…'))),
        h('label', { class: 'field grow' }, h('span', {}, '工作流'), wfSel)),
      h('label', { class: 'field' }, h('span', {}, '需求'), task),
      h('div', { class: 'field' }, h('span', {}, '需求素材（可选）'), filesBox, h('div', { class: 'inputs-actions' }, A.desktop ? h('button', { class: 'btn small', onclick: guard(async () => { const ps = await call('os:pickFiles'); if (Array.isArray(ps)) { st.inputs.files.push(...ps); renderFiles(); } }) }, '＋ 添加文件') : h('small', { style: 'color:var(--text-3)' }, '网页模式请在"任务"页添加文件后点"设为定时任务…"')), links),
      h('div', { class: 'field' }, h('span', {}, '什么时候执行'), kindSeg, whenBox, preview),
      h('div', { class: 'field' }, h('span', {}, '拍板方式'), approval),
    ],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '取消'), h('button', { class: 'btn primary', onclick: guard(async () => {
      const saved = await call('sched:save', { id: st.id, name: name.value.trim(), cwd: cwd.value.trim(), workflow: wfSel.value, task: task.value.trim(),
        inputs: { files: st.inputs.files, links: links.value.split(/\s+/).filter(Boolean) }, when: st.when, approval: st.approval, enabled: x.enabled ?? true });
      m.close();
      toast(`已保存，下次执行：${fmtTime(saved.nextRun)}`);
      go('schedules');
    }) }, '保存')],
  });
}

function artifactCard(a) {
  const ic = { 需求素材: '素', 需求定稿: '需', 实施方案: '案', 代码检查报告: '审', 代码变更: '±' }[a.title] || '文';
  return h('div', { class: 'art' }, h('div', { class: 'ic' }, ic),
    h('div', { class: 'grow' }, h('div', { class: 't' }, a.title), h('div', { class: 'f' }, a.file)),
    h('button', { class: 'btn small', onclick: () => viewFile(a.file, a.title, a.kind) }, '查看'),
    h('button', { class: 'btn small', onclick: () => call('os:showItem', a.file) }, '打开位置'));
}

// ───────── 查看文件 / 步骤输入输出 / 运行记录 ─────────
function renderDiff(text) {
  const pre = h('pre', { class: 'diff' });
  for (const line of String(text).split('\n').slice(0, 20000)) {
    const cls = line.startsWith('diff --git') ? 'h' : line.startsWith('+') && !line.startsWith('+++') ? 'a' : line.startsWith('-') && !line.startsWith('---') ? 'd' : '';
    pre.append(cls ? h('span', { class: cls }, line) : document.createTextNode(line + '\n'));
  }
  return pre;
}
async function fileView(p, kind) {
  const text = await call('file:read', p);
  if (text == null) return h('div', { class: 'empty' }, '(文件不存在)');
  if (kind === 'diff' || /\.(diff|patch)$/.test(p)) return renderDiff(text);
  if (/\.(png|jpe?g|gif|webp|svg|pdf|docx|pptx|xlsx)$/i.test(p)) return h('div', { class: 'empty' }, '二进制文件，请点"打开位置"查看');
  return md(text);
}
async function viewFile(p, title, kind) {
  const body = h('div', { class: 'md-box' }, await fileView(p, kind));
  openModal({ title: `${title} · ${baseName(p)}`, wide: true, body: [h('div', { class: 'path', style: 'font-size:12px;color:var(--text-3);font-family:var(--mono);word-break:break-all' }, p), body],
    footer: [h('button', { class: 'btn', onclick: () => call('os:showItem', p) }, '打开位置')] });
}

/** 一步的全部调用：每次调用的输入 / 输出并排显示，加上这一步里你的回答和拍板 */
function callsView(run, stepIds) {
  const calls = run.calls.filter((c) => stepIds.includes(c.stepId));
  const logs = (run.log || []).filter((l) => stepIds.includes(l.step) && (l.asked || l.decision));
  const io = h('div', { class: 'io' });
  const show = async (c, row) => {
    list.querySelectorAll('.callrow').forEach((r) => r.classList.toggle('on', r === row));
    io.innerHTML = '';
    io.append(
      h('div', {}, h('div', { class: 'io-t' }, '输入（提示词）', c.promptFile ? h('button', { class: 'link', onclick: () => call('os:showItem', c.promptFile) }, '打开位置') : null), h('div', { class: 'md-box' }, c.promptFile ? await fileView(c.promptFile) : '—')),
      h('div', {}, h('div', { class: 'io-t' }, '输出', c.outFile ? h('button', { class: 'link', onclick: () => call('os:showItem', c.outFile) }, '打开位置') : null), h('div', { class: 'md-box' }, c.outFile ? await fileView(c.outFile) : h('div', { class: 'empty' }, c.ok === undefined ? '运行中…' : '没有输出'))));
  };
  const list = h('div', { class: 'calls' }, calls.map((c) => {
    const row = h('div', { class: 'callrow', onclick: () => show(c, row) },
      h('span', { class: 'tool' }, c.tool), h('span', { class: 'chip' }, c.title || c.stepId),
      c.round ? h('span', { class: 'chip you' }, `回答后第 ${c.round} 次`) : null, c.interactive ? h('span', { class: 'chip you' }, '前台') : null, c.lane ? h('span', { class: 'chip acc' }, 'worktree') : null,
      c.ok === undefined ? h('span', { class: 'chip acc' }, '运行中') : c.ok ? h('span', { class: 'chip ok' }, '完成') : h('span', { class: 'chip err' }, c.timedOut ? '超时' : '失败'),
      h('span', { class: 'meta' }, c.ms != null ? fmtMs(c.ms) : '', c.cost ? ` · $${c.cost.toFixed(4)}` : ''));
    return row;
  }));
  if (calls.length) setTimeout(() => list.firstChild?.click(), 0);
  const logBox = logs.length ? h('div', { class: 'calls' }, logs.map((l) => h('div', { class: 'logline' },
    l.asked ? [h('b', {}, `${l.tool} 问：`), h('div', { style: 'white-space:pre-wrap' }, l.asked), h('b', {}, '你答：'), ` ${l.answer}`]
      : [h('b', {}, '你的拍板：'), { approved: '通过', edited: '修改后通过', redo: '退回重做' }[l.decision] || l.decision, l.feedback ? `（意见：${l.feedback}）` : '']))) : null;
  return [calls.length ? list : h('div', { class: 'empty' }, '这一步没有调用 AI 工具'), logBox, calls.length ? io : null];
}
async function openStepDetail(view, stepId, title) {
  if (!view.runId) return;
  const run = await call('runs:get', view.cwd || JOBS.get(view.jobId)?.cwd, view.runId);
  const ids = [stepId, `${stepId}-merge`];
  openModal({ title: `步骤：${title}`, wide: true, body: callsView(run, ids) });
}

// 记录页
const HS = { list: [], cur: null };
const statusLabel = { done: '完成', failed: '失败', stopped: '已停止', running: '运行中' };
async function loadHistory() {
  const box = $('#history-list'); box.innerHTML = '';
  if (!S.cwd) { box.append(h('div', { class: 'empty' }, '先选择项目文件夹')); return; }
  HS.list = await call('runs:list', S.cwd);
  if (!HS.list.length) box.append(h('div', { class: 'empty' }, '还没有运行记录'));
  for (const r of HS.list) {
    box.append(h('div', { class: 'wf-item' + (HS.cur === r.id ? ' active' : ''), onclick: (e) => { box.querySelectorAll('.wf-item').forEach((x) => x.classList.remove('active')); e.currentTarget.classList.add('active'); openRun(r.id); } },
      h('div', { class: 'n' }, new Date(r.startedAt || r.id.replace(/T(\d+)-(\d+)-(\d+)/, 'T$1:$2:$3Z')).toLocaleString(), h('span', { class: `st-badge ${r.status}` }, statusLabel[r.status] || r.status)),
      h('div', { class: 'd' }, `${r.workflow || ''} · ${r.task}`)));
  }
}
async function openRun(id) {
  HS.cur = id;
  const run = await call('runs:get', S.cwd, id);
  const box = $('#history-detail'); box.innerHTML = '';
  const stepIds = [...new Set(run.calls.map((c) => c.stepId))];
  const titles = Object.fromEntries(run.calls.map((c) => [c.stepId, c.title || c.stepId]));
  const stepSel = h('select', {}, h('option', { value: '' }, '全部步骤'), stepIds.map((s) => h('option', { value: s }, titles[s])));
  const callsBox = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  const renderCalls = () => { callsBox.innerHTML = ''; callsBox.append(...callsView(run, stepSel.value ? [stepSel.value] : stepIds).filter(Boolean)); };
  stepSel.addEventListener('change', renderCalls);
  box.append(
    h('div', { class: 'row between' }, h('h2', {}, '运行详情', h('span', { class: `st-badge ${run.status}` }, statusLabel[run.status] || run.status)),
      h('div', { class: 'wf-actions' }, h('button', { class: 'btn', onclick: () => call('os:openPath', run.dir) }, '打开记录目录'),
        h('button', { class: 'btn', onclick: () => { $('#run-task').value = run.task; localStorage.setItem('aiflow.task', run.task); $('#run-cwd').value = S.cwd; go('run'); } }, '用这个需求再跑一次'))),
    h('div', { class: 'kv' }, h('div', {}, '工作流'), h('div', {}, run.workflow), h('div', {}, '开始'), h('div', {}, run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'),
      h('div', {}, '结束'), h('div', {}, run.endedAt ? new Date(run.endedAt).toLocaleString() : '-'), run.error ? h('div', {}, '错误') : null, run.error ? h('div', { style: 'color:var(--err)' }, run.error) : null),
    h('div', {}, h('div', { class: 'section-t' }, '需求'), h('div', { class: 'md-box', style: 'min-height:0;max-height:180px' }, md(run.task))),
    h('div', {}, h('div', { class: 'section-t' }, `成果（${run.artifacts.length}）`), h('div', { class: 'arts' }, run.artifacts.length ? run.artifacts.map(artifactCard) : h('div', { class: 'empty', style: 'padding:12px' }, '没有产出物'))),
    h('div', {}, h('div', { class: 'row between', style: 'margin-bottom:8px' }, h('div', { class: 'section-t', style: 'margin:0' }, `每一步的输入和输出（${run.calls.length} 次调用）`), stepSel), callsBox));
  renderCalls();
}
$('#history-refresh').addEventListener('click', guard(loadHistory));

// ───────── 引擎请求：拍板 / 回答 / 确认 / 选择 / 前台子 agent ─────────
const Q = { queue: [], cur: null };
A.on('ui:request', (req) => { Q.queue.push(req); pump(); });
A.on('ui:cancel', ({ id }) => {
  Q.queue = Q.queue.filter((r) => r.id !== id);
  if (Q.cur?.id === id) { Q.cur.modal.close(); Q.cur = null; pump(); }
});
function respond(id, value) {
  call('ui:respond', id, value).catch((e) => toast(e.message, true));
  if (Q.cur?.id === id) { VIEWS.get(Q.cur.jobId)?.markWaiting(Q.cur.stepId, false); Q.cur.modal.close(); Q.cur = null; }
  setTimeout(pump, 50);
}
// 你自己打开的弹窗（编辑器、查看文件等）开着时，不打断你：只显示提示条
const userModalOpen = () => !!document.querySelector('#modal-root .backdrop:not([data-req])');
function renderReqBanner() {
  let bar = $('#req-banner');
  const n = Q.queue.length + (Q.cur ? 1 : 0);
  if (!n || Q.cur) { bar?.remove(); return; }
  if (!bar) {
    bar = h('div', { id: 'req-banner', class: 'req-banner', onclick: () => { Q.force = true; pump(); } });
    document.body.append(bar);
  }
  bar.textContent = `✋ ${n} 个任务在等你拍板 · 点这里处理`;
}
window.pumpRequests = () => pump();
function pump() {
  renderReqBanner();
  if (Q.cur || !Q.queue.length) return;
  if (userModalOpen() && !Q.force) return;
  Q.force = false;
  const req = Q.queue.shift();
  const fn = { approve: showApprove, answer: showAnswer, confirm: showConfirm, choose: showChoose, pickFile: showPickFile, interactive: showInteractive }[req.kind];
  if (!fn) return respond(req.id, null);
  const { jobId, stepId, project, task } = req.payload;
  VIEWS.get(jobId)?.markWaiting(stepId, true);
  // 不强制跳转页面；在任务页时自动切到这个任务
  if (S.page === 'run' && jobId && SEL !== jobId && VIEWS.has(jobId)) selectJob(jobId);
  openModal.asRequest = true;
  let modal;
  try { modal = fn(req.id, req.payload); } finally { openModal.asRequest = false; }
  renderReqBanner();
  // 标明是哪个任务在问
  if (project) modal.el.querySelector('.modal-h').after(h('div', { class: 'req-ctx', style: 'padding:0 20px;display:flex;gap:10px' },
    h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, `任务：${project} · ${task || ''}`),
    S.page !== 'run' ? h('button', { class: 'link', onclick: () => { go('run'); if (VIEWS.has(jobId)) selectJob(jobId); } }, '查看这个任务') : null));
  Q.cur = { id: req.id, jobId, stepId, modal };
}
const youIcon = (t = '?') => h('span', { class: 'chip you', style: 'font-weight:700' }, t);

function showApprove(id, p) {
  let mode = 'view', edited = false;
  const viewBox = h('div', { class: 'md-box' }, md(p.content || '(无内容)'));
  const ta = h('textarea', { class: 'editor', hidden: true, spellcheck: 'false' });
  ta.value = p.content || '';
  ta.addEventListener('input', () => { edited = ta.value !== p.content; approveBtn.textContent = edited ? '保存修改并通过' : '通过'; });
  const seg = h('div', { class: 'seg' },
    h('button', { class: 'on', onclick: (e) => setMode('view', e) }, '预览'),
    h('button', { onclick: (e) => setMode('edit', e) }, '编辑'));
  function setMode(m, e) {
    mode = m; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
    if (m === 'view') { viewBox.innerHTML = ''; viewBox.append(md(ta.value)); }
    viewBox.hidden = m !== 'view'; ta.hidden = m !== 'edit';
  }
  const fb = h('textarea', { rows: 3, placeholder: '写下你的修改意见，AI 会带着意见重做上一步' });
  const fbBox = h('div', { class: 'field', hidden: true }, h('span', {}, '修改意见'), fb);
  const redoBtn = h('button', { class: 'btn', onclick: () => {
    if (fbBox.hidden) { fbBox.hidden = false; fb.focus(); redoBtn.textContent = '发送意见并重做'; return; }
    if (!fb.value.trim()) { fb.focus(); return; }
    respond(id, { decision: 'r', feedback: fb.value.trim() });
  } }, '提意见重做');
  const approveBtn = h('button', { class: 'btn you', onclick: () => respond(id, edited ? { decision: 'e', content: ta.value } : { decision: 'y' }) }, '通过');
  return openModal({
    title: `拍板：${p.title}`, icon: youIcon('✋'), wide: true, closable: false,
    body: [h('div', { class: 'row between' }, h('p', { class: 'hint' }, '可以直接通过、在"编辑"里改完再通过，或者提意见让 AI 重做。'), seg), viewBox, ta, fbBox],
    footer: [h('div', { class: 'left' }, h('button', { class: 'btn danger', onclick: async () => { const ok = await dialog({ title: '终止整个工作流？', buttons: [{ label: '取消', value: false }, { label: '终止', value: true, cls: 'primary' }] }); if (ok) respond(id, { decision: 'n' }); } }, '终止')), redoBtn, approveBtn],
  });
}
function showAnswer(id, p) {
  const ta = h('textarea', { rows: 4, placeholder: '直接写你的决定，可以一次回答多条，例如：1. 选 A  2. 不需要分页' });
  const send = () => { if (ta.value.trim()) respond(id, ta.value.trim()); else ta.focus(); };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
  return openModal({
    title: `${p.tool} 需要你拍板`, icon: youIcon('?'), closable: false,
    body: [h('p', { class: 'hint' }, `步骤：${p.stepId}。它拿不准下面的问题，你回答后它会带着答案继续。`), h('div', { class: 'questions' }, md(p.questions)), ta],
    footer: [h('button', { class: 'btn', onclick: () => respond(id, 'auto') }, '按它的推荐决定'), h('button', { class: 'btn you', onclick: send }, '回答（Ctrl+Enter）')],
  });
}
function showConfirm(id, p) {
  return openModal({ title: '需要你确认', icon: youIcon(), closable: false, body: h('p', { style: 'margin:0;font-size:15px' }, p.question),
    footer: [h('button', { class: 'btn', onclick: () => respond(id, false) }, '否'), h('button', { class: 'btn you', onclick: () => respond(id, true) }, '是')] });
}
function showChoose(id, p) {
  return openModal({ title: '需要你选择', icon: youIcon(), closable: false, body: h('p', { style: 'margin:0;font-size:15px;line-height:1.6;word-break:break-all' }, p.question),
    footer: [p.path ? h('div', { class: 'left' }, h('button', { class: 'btn', onclick: () => call('os:openPath', p.path) }, '打开文件夹')) : null,
      ...p.options.map((o, i) => h('button', { class: 'btn' + (i === 0 ? ' you' : ''), onclick: () => respond(id, o.key) }, o.label))] });
}
function showPickFile(id, p) {
  const inp = h('input', { type: 'text', placeholder: '文件路径（相对项目文件夹或绝对路径）' });
  return openModal({ title: p.title || '选择文件', closable: false, body: inp,
    footer: [h('button', { class: 'btn', onclick: () => respond(id, null) }, '取消'), h('button', { class: 'btn primary', onclick: () => respond(id, inp.value.trim()) }, '确定')] });
}
function showInteractive(id, p) {
  return openModal({
    title: `正在和 ${p.name} 对话`, icon: h('div', { class: 'spinner' }), closable: false,
    body: [
      h('p', { class: 'hint', style: 'font-size:14px;color:var(--text)' }, `已经在一个新的终端窗口里打开了 ${p.name}，和你平时直接使用完全一样：skill、斜杠命令、提问都可以用。`),
      h('ol', { style: 'margin:0;padding-left:20px;line-height:1.9;color:var(--text-2)' },
        h('li', {}, '切换到那个终端窗口，回答它的问题、做决定'),
        h('li', {}, '完成后让它把结果写入文件，然后输入 /exit 关闭窗口'),
        h('li', {}, '窗口关闭后 aiflow 会自动继续；如果窗口没有自动关闭，点下面的"我已完成"')),
    ],
    footer: [h('div', { class: 'left' }, p.promptFile ? h('button', { class: 'btn', onclick: () => viewFile(p.promptFile, '首条任务说明') }, '查看任务说明') : null),
      h('button', { class: 'btn you', onclick: () => respond(id, true) }, '我已完成，继续')],
  });
}

// ───────── 启动 ─────────
(async function init() {
  try {
    renderProject();
    S.info = await call('app:info');
    S.tools = await call('tools:list');
    if (!S.tools.tools.some((t) => t.detected)) {
      toast('第一次使用：正在检测本机的 AI 工具…');
      S.tools = await call('tools:detect');
    }
    if (S.cwd) { try { await call('project:use', S.cwd); } catch { S.cwd = ''; renderProject(); } }
    go('run');
    if (!S.cwd && !JOBS.size) setTimeout(() => $('#project-box').click(), 300);
    for (const j of await call('jobs:list')) onJob(j);
  } catch (e) { toast(e.message, true); }
})();

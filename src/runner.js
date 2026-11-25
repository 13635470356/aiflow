// 工作流引擎（主控 agent）——与界面无关，CLI 和桌面版共用。
// 所有显示与交互都通过 ui 适配器完成（见 ui-cli.js / desktop/ui-gui.js）：
//   显示：ui.event(type, data)   type: run-start | step | skip | info | tool-start | tool-line | tool-use | tool-meta | tool-done | done | error
//   交互（均为 async）：
//     ui.approve({stepId,title,content,file})       → {decision:'y'|'e'|'r'|'n', content?, feedback?}
//     ui.answer({tool,stepId,questions})            → 文本，'auto' 表示按它的推荐
//     ui.confirm({question})                        → boolean
//     ui.choose({question, options:[{key,label}]})  → key
//     ui.pickFile({title})                          → 路径或 null
//     ui.interactive({tool,name,exe,args,cwd,promptFile,signal}) → 退出码（前台子 agent）
//
// 步骤类型：agent | parallel | interactive | approve | write | loop
//   parallel 两种用法：
//     roles/tools + prompt           多个工具做同一件事（只读，交叉验证）
//     steps + isolation:"worktree"   多个不同的步骤同时做，各自在独立 git worktree 里改代码，完成后合并回工作区
// 通用字段：id, title, when, role|tool, prompt, mode(read|edit), timeoutMin, ask, maxAsks, use, args, artifact（产出物名称）
import fs from 'node:fs';
import path from 'node:path';
import { toolDef, HOME_DIR } from './config.js';
import { runStreaming, gitChanged } from './proc.js';
import * as G from './git.js';
import { prepareInputs } from './inputs.js';

// ───────── 模板与条件 ─────────
function render(tpl, ctx) {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}
const promptText = (p) => (Array.isArray(p) ? p.join('\n') : p || '');

/** 步骤提示词 = prompt + use 提示（让子 agent 主动使用它自己的 skill / 斜杠命令 / MCP） */
function stepPrompt(step, ctx) {
  let p = render(promptText(step.prompt), ctx);
  if (step.use?.length) p += `\n\n【本步骤请优先使用你已安装的以下能力（skill / 斜杠命令 / 子代理 / MCP 工具），没有则说明后用常规方式完成】\n- ${step.use.join('\n- ')}`;
  return p;
}

export function evalExpr(expr, ctx, cwd) {
  const helpers = {
    task: ctx.task,
    iter: ctx.iter,
    output: (id) => ctx.steps[id]?.output ?? '',
    has: (id, text) => (ctx.steps[id]?.output ?? '').includes(text),
    ran: (id) => id in ctx.steps,
    changed: (prefix = '') => gitChanged(cwd).some((f) => f.replaceAll('\\', '/').startsWith(prefix)),
  };
  // eslint-disable-next-line no-new-func
  return !!new Function('h', `with (h) { return (${expr}); }`)(helpers);
}

async function checkWhen(step, ctx, env) {
  if (!step.when) return true;
  let ok;
  // 无人值守（自动通过）时，需要你确认的可选步骤一律跳过
  if (step.when.startsWith('confirm:')) ok = env.autoApprove ? false : await env.ui.confirm({ question: step.when.slice(8), stepId: step.id });
  else ok = evalExpr(step.when, ctx, env.cwd);
  if (!ok) env.ui.event('skip', { stepId: step.id, when: step.when });
  return ok;
}

// ───────── 工具解析与命令构建 ─────────
export function resolveTool(ref, wf, cfg, warn) {
  let id = ref;
  if (!id || id === '@main') id = cfg.main;
  else if (wf.roles?.[id]) id = wf.roles[id] === '@main' ? cfg.main : wf.roles[id];
  if (!cfg.detected[id] && cfg.main && cfg.detected[cfg.main]) {
    warn?.(`工具 ${id} 未检测到，回退到主工具 ${cfg.main}`);
    id = cfg.main;
  }
  return id;
}

function fillArgs(template, def, mode, promptArg) {
  const args = [];
  for (const a of template) {
    if (a === '{{EDIT}}') { if (mode === 'edit') args.push(...(def.editArgs || [])); }
    else if (a === '{{PROMPT}}') args.push(promptArg);
    else args.push(a);
  }
  return args;
}

const relPath = (cwd, p) => path.relative(cwd, p).split(path.sep).join('/');
const fileInstruction = (rel) => `请读取文件 ${rel} 中的完整任务说明，并严格按其要求执行。`;
const short = (args) => args.map((a) => (a.length > 50 ? a.slice(0, 47) + '...' : a)).join(' ');

// ───────── 统计 ─────────
function recordStat(rec) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(path.join(HOME_DIR, 'stats.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* 统计失败不影响主流程 */ }
}

// ───────── 运行记录（run.json 边跑边写，桌面版"记录"页读取它） ─────────
function saveRun(env) {
  try {
    fs.writeFileSync(path.join(env.runDir, 'run.json'), JSON.stringify({
      id: path.basename(env.runDir), workflow: env.wfName, workflowFile: env.wf.__file, task: env.task, inputs: env.inputs,
      startedAt: env.startedAt, endedAt: env.endedAt, status: env.status, error: env.error,
      calls: env.calls, artifacts: env.artifacts, log: env.log,
    }, null, 2));
  } catch { /* 忽略 */ }
}
function addArtifact(env, { title, file, stepId, kind = 'md' }) {
  const i = env.artifacts.findIndex((a) => a.title === title);
  const a = { title, file, stepId, kind, at: new Date().toISOString() };
  if (i >= 0) env.artifacts[i] = a; else env.artifacts.push(a);
  env.ui.event('artifact', a);
  saveRun(env);
}
function artifactFromOutput(env, step, text) {
  if (!step.artifact) return;
  const file = path.join(env.runDir, 'artifacts', `${step.id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text ?? '');
  addArtifact(env, { title: step.artifact, file, stepId: step.id });
}

// ───────── Claude 事件流解析：让你看到子 agent 在做什么 ─────────
function summarizeInput(inp = {}) {
  const v = inp.file_path || inp.path || inp.command || inp.pattern || inp.url || inp.description || inp.skill || inp.prompt;
  const s = v ? String(v) : JSON.stringify(inp);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}
function claudeStreamHandler(ui, tool, stepId, state) {
  return (stream, line) => {
    if (stream === 'stderr') return ui.event('tool-line', { tool, stepId, stream, text: line });
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) ui.event('tool-line', { tool, stepId, stream, text: line }); return; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      const n = (x) => (Array.isArray(x) ? x.length : 0);
      ui.event('tool-meta', { tool, stepId, text: `模型 ${ev.model || '?'} · 工具 ${n(ev.tools)} · MCP ${n(ev.mcp_servers)} · 斜杠命令/skill ${n(ev.slash_commands) + n(ev.skills)} · 插件 ${n(ev.plugins)}` });
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) ui.event('tool-line', { tool, stepId, stream: 'stdout', text: b.text });
        if (b.type === 'tool_use') ui.event('tool-use', { tool, stepId, name: b.name, detail: summarizeInput(b.input) });
      }
    } else if (ev.type === 'result') {
      state.result = ev.result ?? '';
      state.cost = ev.total_cost_usd;
      state.isError = ev.is_error;
    }
  };
}

// ───────── 后台子 agent（含 ASK 升级协议） ─────────
const ASK_PROTOCOL = `

---
【拿不准时向需求方提问】如果存在你无法根据现有信息确定、且会明显影响结果的关键问题，不要猜测，立刻停止，只输出如下格式（可给选项和你的推荐）：
[[ASK]]
1. 问题……（A. … B. … 推荐：A，理由……）
[[/ASK]]
需求方回答后，你会收到附带回答的同一任务。没有必须确认的问题就直接完成任务，不要输出 [[ASK]]。`;

async function callOnce(toolId, prompt, env, info) {
  const { cfg, cwd, runDir, dryRun, ui } = env;
  const def = toolDef(cfg, toolId);
  const exe = cfg.detected[toolId]?.path;
  if (!def || !exe) throw new Error(`工具 ${toolId} 不可用，先检测工具`);
  const base = `${info.stepId}.${toolId}${info.round ? '.r' + info.round : ''}`;
  const promptFile = path.join(runDir, 'prompts', `${base}.md`);   // 记录用
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  // worktree 里的子 agent 只能看到自己的目录，提示词文件放一份到 worktree 里
  let readFile = promptFile;
  if (env.laneDir) {
    readFile = path.join(env.laneDir, '.aiflow', 'prompts', `${base}.md`);
    fs.mkdirSync(path.dirname(readFile), { recursive: true });
    fs.writeFileSync(readFile, prompt);
  }
  const instr = fileInstruction(relPath(cwd, readFile)) + '直接输出结果。';
  const args = [...fillArgs(def.args, def, info.mode, def.promptVia === 'arg' ? prompt : instr), ...(info.extraArgs || [])];
  const stdin = def.promptVia === 'stdin' ? prompt : null;

  const call = { stepId: info.stepId, title: info.title, tool: toolId, round: info.round || 0, promptFile, lane: env.laneDir ? relPath(env.rootCwd, env.laneDir) : null, startedAt: new Date().toISOString() };
  env.calls.push(call); saveRun(env);
  ui.event('tool-start', { tool: toolId, stepId: info.stepId, lane: call.lane, round: info.round, cmd: `${path.basename(exe)} ${short(args)}${stdin != null ? '  < 提示词(stdin)' : ''}`, promptFile });
  if (dryRun) {
    Object.assign(call, { ok: true, ms: 0, dryRun: true }); saveRun(env);
    ui.event('tool-done', { tool: toolId, stepId: info.stepId, ok: true, ms: 0, dryRun: true });
    return { out: `[dry-run] ${toolId} 输出占位`, ok: true };
  }

  const state = {};
  const onLine = def.stream === 'claude-json'
    ? claudeStreamHandler(ui, toolId, info.stepId, state)
    : (stream, text) => ui.event('tool-line', { tool: toolId, stepId: info.stepId, stream, text });
  const t0 = Date.now();
  const res = await runStreaming(exe, args, {
    stdin, cwd, onLine, signal: env.signal, cliSigint: env.cli,
    timeoutMs: (info.timeoutMin ?? cfg.defaultTimeoutMin) * 60000,
  });
  if (env.signal?.aborted) throw new Error('已停止');
  const ms = Date.now() - t0;
  const out = (def.stream === 'claude-json' && state.result != null ? state.result : res.stdout).trim();
  fs.mkdirSync(path.join(runDir, 'outputs'), { recursive: true });
  const outFile = path.join(runDir, 'outputs', `${base}.md`);
  fs.writeFileSync(outFile, out);
  const ok = !res.timedOut && res.code === 0 && !state.isError && !!out;
  Object.assign(call, { outFile, ok, ms, cost: state.cost ?? null, timedOut: res.timedOut }); saveRun(env);
  ui.event('tool-done', { tool: toolId, stepId: info.stepId, ok, ms, code: res.code, timedOut: res.timedOut, cost: state.cost, outFile });
  recordStat({ workflow: env.wfName, step: info.stepId, role: info.role, tool: toolId, kind: 'headless', mode: info.mode, round: info.round || 0, ms, ok, code: res.code, timedOut: res.timedOut, outChars: out.length, costUsd: state.cost ?? null });
  if (!out && !ok) throw new Error(`${toolId} 执行失败：${res.stderr.slice(-500)}`);
  return { out, ok };
}

// 并行子 agent 同时提问时，排队一个一个问你
function withLock(env, fn) { const r = env.askQ.p.then(fn); env.askQ.p = r.catch(() => {}); return r; }

async function callTool(toolId, basePrompt, env, info) {
  const useAsk = info.ask ?? env.wf.askUser ?? true;
  const prompt = basePrompt + (useAsk ? ASK_PROTOCOL : '');
  const qa = [];
  for (let round = 0; ; round++) {
    const { out } = await callOnce(toolId, prompt + (qa.length ? `\n\n【需求方已回答的问题】\n${qa.join('\n\n')}` : ''), env, { ...info, round });
    const m = useAsk && out.match(/\[\[ASK\]\]([\s\S]*?)(\[\[\/ASK\]\]|$)/);
    if (!m) return out;
    const questions = m[1].trim();
    if (env.autoApprove || round >= (info.maxAsks ?? 5)) {
      qa.push('需求方让你按自己的推荐方案决定，不要再提问。');
      env.ui.event('info', { level: 'dim', text: `[${toolId}] 有提问，按它的推荐继续` });
      continue;
    }
    const ans = (await withLock(env, () => env.ui.answer({ tool: toolId, stepId: info.stepId, questions }))).trim();
    qa.push(ans.toLowerCase() === 'auto'
      ? `问题：\n${questions}\n回答：需求方让你按你的推荐决定，不要再提问。`
      : `问题：\n${questions}\n回答：${ans}`);
    env.log.push({ step: info.stepId, tool: toolId, asked: questions, answer: ans, at: new Date().toISOString() });
    saveRun(env);
  }
}

// ───────── 前台子 agent（交互 TUI） ─────────
function newestMatch(cwd, pattern, sinceMs) {
  const abs = path.resolve(cwd, pattern);
  const dir = path.dirname(abs);
  const re = new RegExp('^' + path.basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).filter((x) => x.t >= sinceMs).sort((a, b) => b.t - a.t);
  return hits[0]?.f ?? null;
}

async function runInteractiveStep(step, ctx, env) {
  const { cfg, cwd, runDir, dryRun, wf, ui } = env;
  if (env.autoApprove && !dryRun) {
    ui.event('info', { level: 'warn', text: `无人值守模式：跳过需要你直接对话的步骤"${step.title || step.id}"，后续步骤以需求和素材为准` });
    return '';
  }
  const toolId = resolveTool(step.tool || step.role, wf, cfg, (t) => ui.event('info', { level: 'warn', text: t }));
  const def = toolDef(cfg, toolId);
  const exe = cfg.detected[toolId]?.path;
  if (!def?.interactiveArgs) throw new Error(`${toolId} 未配置 interactiveArgs`);
  const outFile = path.join(runDir, 'outputs', `${step.id}.${toolId}.md`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const outRel = relPath(cwd, outFile);
  const body = stepPrompt(step, { ...ctx, outFile: outRel });
  const tail = step.output ? '' : `\n\n【完成约定】当需求方确认没有问题后，把最终结果完整写入文件 ${outRel}，然后提醒需求方输入 /exit 退出，主控会继续后续流程。`;
  const promptFile = path.join(runDir, 'prompts', `${step.id}.${toolId}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, body + tail);
  // 以 / 开头（斜杠命令/skill，如 /deep-interview）必须直接作为首条消息；否则让它读提示词文件
  const direct = step.promptAs === 'direct' || body.trimStart().startsWith('/');
  const first = direct ? (body + tail).replace(/\s*\n\s*/g, ' ') : fileInstruction(relPath(cwd, promptFile));
  const args = [...fillArgs(def.interactiveArgs, def, step.mode || 'read', first), ...(step.args || [])];

  if (step.output == null && env.laneDir) throw new Error('worktree 并行组里不能放 interactive 步骤');
  if (dryRun) {
    ui.event('tool-start', { tool: toolId, stepId: step.id, interactive: true, cmd: `${path.basename(exe)} ${short(args)}` });
    ui.event('tool-done', { tool: toolId, stepId: step.id, ok: true, ms: 0, dryRun: true });
    return `[dry-run] ${toolId} 交互结果占位`;
  }
  for (;;) {
    const t0 = Date.now();
    ui.event('tool-start', { tool: toolId, stepId: step.id, interactive: true, cmd: `${path.basename(exe)} ${short(args)}`, promptFile });
    const code = await ui.interactive({ tool: toolId, name: def.name, exe, args, cwd, promptFile, signal: env.signal });
    if (env.signal?.aborted) throw new Error('已停止');
    const ms = Date.now() - t0;
    const found = step.output ? newestMatch(cwd, render(step.output, ctx), t0 - 1000) : fs.existsSync(outFile) ? outFile : null;
    env.calls.push({ stepId: step.id, title: step.title || step.id, tool: toolId, interactive: true, promptFile, outFile: found, ok: !!found, ms, startedAt: new Date(t0).toISOString() });
    saveRun(env);
    ui.event('tool-done', { tool: toolId, stepId: step.id, ok: !!found, ms, interactive: true, outFile: found });
    recordStat({ workflow: env.wfName, step: step.id, role: step.role, tool: toolId, kind: 'interactive', ms, ok: !!found, code });
    if (found) {
      ui.event('info', { level: 'ok', text: `收集到结果：${relPath(cwd, found)}` });
      const text = fs.readFileSync(found, 'utf8');
      if (found !== outFile) fs.writeFileSync(outFile, text);
      return text;
    }
    const a = await ui.choose({
      question: `没有找到 ${def.name} 的结果文件`,
      options: [{ key: 'r', label: '重新进入' }, { key: 'p', label: '手动指定文件' }, { key: 's', label: '跳过（结果为空）' }, { key: 'n', label: '终止' }],
    });
    if (a === 'n') throw new Error('已被你终止');
    if (a === 's') return '';
    if (a === 'p') {
      const f = await ui.pickFile({ title: '选择结果文件', cwd });
      if (f && fs.existsSync(path.resolve(cwd, f))) return fs.readFileSync(path.resolve(cwd, f), 'utf8');
      ui.event('info', { level: 'err', text: '文件不存在' });
    }
  }
}

// ───────── worktree 隔离并行组 ─────────
async function runIsolatedGroup(step, ctx, env, depth) {
  const { ui } = env;
  const warn = (t) => ui.event('info', { level: 'warn', text: t });
  // 先判断条件，跳过的分支不建 worktree
  const lanes = [];
  for (const sub of step.steps) {
    if ((sub.type || 'agent') !== 'agent') throw new Error(`worktree 并行组 ${step.id} 里只能放 agent 步骤（${sub.id} 是 ${sub.type}）`);
    ui.event('step', { stepId: sub.id, title: sub.title || sub.id, type: 'agent', depth: depth + 1, lane: true });
    if (await checkWhen(sub, ctx, env)) lanes.push({ step: sub });
    else env.log.push({ step: sub.id, skipped: true });
  }
  if (!lanes.length) return;
  if (env.dryRun || !G.isRepo(env.cwd)) {
    if (!env.dryRun) warn('当前项目不是 git 仓库，无法用 worktree 隔离，改为依次执行');
    for (const l of lanes) await runOne(l.step, ctx, env, depth + 1);
    return;
  }
  G.ensureExcluded(env.cwd);
  const base = G.snapshot(env.cwd, `aiflow: ${step.id} 的起点`);
  const runTag = path.basename(env.runDir);
  const wtRoot = path.join(env.cwd, '.aiflow', 'worktrees', runTag);
  const keep = [];
  try {
    for (const l of lanes) {
      l.branch = `aiflow/${runTag}/${l.step.id}`;
      l.dir = path.join(wtRoot, l.step.id);
      G.addWorktree(env.cwd, l.dir, l.branch, base);
      // 需求素材也带进 worktree（同样的相对路径）
      const inputsDir = path.join(env.runDir, 'inputs');
      if (fs.existsSync(inputsDir)) fs.cpSync(inputsDir, path.join(l.dir, relPath(env.cwd, inputsDir)), { recursive: true });
    }
    ui.event('info', { level: 'info', text: `已创建 ${lanes.length} 个独立 worktree，并行执行：${lanes.map((l) => l.step.title || l.step.id).join('、')}` });

    const results = await Promise.allSettled(lanes.map((l) =>
      runOne(l.step, ctx, { ...env, cwd: l.dir, laneDir: l.dir }, depth + 1, true)));
    if (env.signal?.aborted) throw new Error('已停止');
    const failed = lanes.filter((_, k) => results[k].status === 'rejected');
    for (const l of failed) {
      const msg = results[lanes.indexOf(l)].reason?.message;
      ui.event('step-done', { stepId: l.step.id, status: 'failed' });
      ui.event('info', { level: 'err', text: `${l.step.title || l.step.id} 失败：${msg}` });
    }
    if (failed.length) {
      const a = env.autoApprove ? 'c' : await ui.choose({ question: `${failed.length} 个并行步骤失败`, options: [{ key: 'c', label: '只合并成功的部分，继续' }, { key: 'n', label: '终止（保留 worktree 供检查）' }], stepId: step.id });
      if (a === 'n') { keep.push(...lanes); throw new Error('已被你终止'); }
    }
    const ok = lanes.filter((l) => !failed.includes(l));
    for (const l of ok) l.changed = G.commitAll(l.dir, `aiflow: ${l.step.title || l.step.id}`);
    const changed = ok.filter((l) => l.changed);
    if (!changed.length) { ui.event('info', { level: 'warn', text: '并行步骤没有产生任何代码改动' }); return; }

    // 在单独的集成 worktree 里依次合并，冲突在这里解决，不碰你的工作区
    const mergeDir = path.join(wtRoot, '_merge');
    const mergeBranch = `aiflow/${runTag}/merge`;
    G.addWorktree(env.cwd, mergeDir, mergeBranch, base);
    lanes.push({ dir: mergeDir, branch: mergeBranch, step: { id: '_merge' } });
    for (const l of changed) {
      const m = G.merge(mergeDir, l.branch, `aiflow: 合并 ${l.step.title || l.step.id}`);
      if (m.ok) { ui.event('info', { level: 'ok', text: `已合并 ${l.step.title || l.step.id}` }); continue; }
      await resolveConflicts(step, l, m.conflicts, mergeDir, ctx, env);
    }
    const patch = path.join(env.runDir, `${step.id}.patch`);
    fs.writeFileSync(patch, G.diff(env.cwd, base, G.head(mergeDir)));
    const stat = G.diffStat(env.cwd, base, G.head(mergeDir));
    const ap = G.applyPatch(env.cwd, patch);
    if (!ap.ok) {
      keep.push(...lanes);
      const a = env.autoApprove ? 'c' : await ui.choose({ question: `无法把合并结果应用到工作区（并行执行期间工作区可能被改过）：${ap.err.slice(0, 300)}。合并结果保留在分支 ${mergeBranch}，补丁在 ${relPath(env.cwd, patch)}`, options: [{ key: 'c', label: '我稍后手动处理，继续' }, { key: 'n', label: '终止' }], path: mergeDir, stepId: step.id });
      if (a === 'n') throw new Error('已被你终止');
      return;
    }
    ui.event('info', { level: 'ok', text: `并行结果已合并回工作区${ap.threeWay ? '（使用了三方合并）' : ''}：${stat.split('\n').pop()}` });
    ctx.steps[step.id] = { output: stat, outputs: Object.fromEntries(ok.map((l) => [l.step.id, ctx.steps[l.step.id]?.output ?? ''])) };
  } catch (e) {
    if (e.keepWorktrees) keep.push(...lanes);
    throw e;
  } finally {
    for (const l of lanes) if (!keep.includes(l) && l.dir) G.removeWorktree(env.cwd, l.dir, l.branch);
    if (!keep.length) {
      fs.rmSync(wtRoot, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(wtRoot)); } catch { /* 还有其他内容则保留 */ }
    }
    else ui.event('info', { level: 'warn', text: `已保留 worktree 供检查：${relPath(env.cwd, wtRoot)}` });
  }
}

async function resolveConflicts(step, lane, conflicts, mergeDir, ctx, env) {
  const { ui } = env;
  for (let attempt = 1; ; attempt++) {
    if (env.autoApprove && attempt > 2) throw Object.assign(new Error(`无人值守模式下两次都没能解决合并冲突，worktree 已保留：${mergeDir}`), { keepWorktrees: true });
    const a = env.autoApprove ? 'a' : await ui.choose({
      question: `合并"${lane.step.title || lane.step.id}"时有 ${conflicts.length} 个文件冲突：${conflicts.join('、')}`,
      options: [{ key: 'a', label: '让主工具解决冲突' }, { key: 'm', label: '我手动解决' }, { key: 'n', label: '终止' }],
      path: mergeDir, stepId: step.id,
    });
    if (a === 'n') throw new Error('已被你终止');
    if (a === 'a') {
      const prompt = `你在一个 git 仓库里，正在合并两位工程师并行开发的代码，出现了冲突。\n冲突文件：\n${conflicts.map((f) => `- ${f}`).join('\n')}\n\n请逐个打开这些文件，理解双方的意图，保留两边需要的功能，删除全部冲突标记（<<<<<<< ======= >>>>>>>）。实施方案见 docs/aiflow/PLAN.md（如有）。只解决冲突，不做其他改动。完成后列出每个文件的处理方式。`;
      await callTool(resolveTool('@main', env.wf, env.cfg), prompt, { ...env, cwd: mergeDir, laneDir: mergeDir }, { stepId: `${step.id}-merge`, title: '解决合并冲突', mode: 'edit', ask: false });
    } else {
      await ui.choose({ question: `请在这个文件夹里解决冲突（删除冲突标记）后点继续：${mergeDir}`, options: [{ key: 'c', label: '已解决，继续' }], path: mergeDir, stepId: step.id });
    }
    const left = G.filesWithMarkers(mergeDir);
    if (!left.length) { G.finishMerge(mergeDir); ui.event('info', { level: 'ok', text: `冲突已解决：${lane.step.title || lane.step.id}` }); return; }
    conflicts = left;
    ui.event('info', { level: 'warn', text: `还有文件包含冲突标记：${left.join('、')}` });
  }
}

// ───────── 步骤执行 ─────────
async function runSteps(steps, ctx, env, depth = 0) {
  for (let i = 0; i < steps.length; i++) {
    if (env.signal?.aborted) throw new Error('已停止');
    const r = await runOne(steps[i], ctx, env, depth, false, steps);
    if (r?.jump != null) i = r.jump - 1;
  }
}

/** 执行单个步骤。返回 { jump } 表示跳回到同层某一步（拍板时选择重做） */
async function runOne(step, ctx, env, depth, inLane = false, siblings = null) {
  const { ui } = env;
  const type = step.type || 'agent';
  const done = (status = 'done') => ui.event('step-done', { stepId: step.id, iter: ctx.iter, status });
  if (!inLane) {
    ui.event('step', { stepId: step.id, title: step.title || step.id, type, depth, iter: ctx.iter });
    if (!(await checkWhen(step, ctx, env))) { env.log.push({ step: step.id, skipped: true }); return; }
  }
  const warn = (t) => ui.event('info', { level: 'warn', text: t });
  const info = { stepId: step.id, title: step.title || step.id, role: step.role, mode: step.mode || 'read', timeoutMin: step.timeoutMin, ask: step.ask, maxAsks: step.maxAsks, extraArgs: step.args };

  if (type === 'agent') {
    const id = resolveTool(step.tool || step.role, env.wf, env.cfg, warn);
    const out = await callTool(id, stepPrompt(step, ctx), env, info);
    ctx.steps[step.id] = { output: out, outputs: { [id]: out } };
    artifactFromOutput(env, step, out);
  } else if (type === 'parallel' && step.steps) {
    await runIsolatedGroup(step, ctx, env, depth);
  } else if (type === 'parallel') {
    if (step.mode === 'edit') throw new Error(`并行步骤 ${step.id} 要改代码时，请改用 steps + isolation:"worktree" 写法`);
    const refs = step.roles || step.tools;
    const ids = [...new Set(refs.map((r) => resolveTool(r, env.wf, env.cfg, warn)))];
    const prompt = stepPrompt(step, ctx);
    const outs = await Promise.all(ids.map((id, k) => callTool(id, prompt, env, { ...info, role: refs[k] })));
    const outputs = Object.fromEntries(ids.map((id, k) => [id, outs[k]]));
    ctx.steps[step.id] = { outputs, output: ids.map((id) => `### 来自 ${id} 的结果\n\n${outputs[id]}`).join('\n\n---\n\n') };
    artifactFromOutput(env, step, ctx.steps[step.id].output);
  } else if (type === 'interactive') {
    const out = await runInteractiveStep(step, ctx, env);
    ctx.steps[step.id] = { output: out, outputs: { interactive: out } };
    artifactFromOutput(env, step, out);
  } else if (type === 'approve') {
    const file = path.join(env.runDir, `${step.review}.md`);
    const content = ctx.steps[step.review]?.output ?? '';
    fs.writeFileSync(file, content);
    const res = env.autoApprove ? { decision: 'y' } : await ui.approve({ stepId: step.id, title: step.title || step.id, review: step.review, content, file });
    if (res.decision === 'n') { done('failed'); throw new Error('已被你终止'); }
    if (res.decision === 'e') {
      const edited = res.content ?? fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, edited);
      ctx.steps[step.review].output = edited;
      const target = siblings?.find((s) => s.id === step.review);
      if (target) artifactFromOutput(env, target, edited);
      ui.event('info', { level: 'ok', text: '已采用你修改后的版本' });
    }
    if (res.decision === 'r') {
      const back = siblings ? siblings.findIndex((s) => s.id === step.review) : -1;
      if (back < 0) throw new Error(`approve 的 review 目标 ${step.review} 必须在同一层步骤里`);
      ctx.feedback = res.feedback || '';
      env.log.push({ step: step.id, decision: 'redo', feedback: ctx.feedback, at: new Date().toISOString() });
      saveRun(env);
      done('redo');
      return { jump: back };
    }
    ctx.feedback = '';
    env.log.push({ step: step.id, decision: res.decision === 'e' ? 'edited' : 'approved', at: new Date().toISOString() });
    saveRun(env);
  } else if (type === 'write') {
    const dest = path.resolve(env.cwd, render(step.to, ctx));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, ctx.steps[step.from]?.output ?? '');
    ui.event('info', { level: 'ok', text: `已写入 ${relPath(env.cwd, dest)}`, file: dest });
    if (step.artifact) addArtifact(env, { title: step.artifact, file: dest, stepId: step.id });
  } else if (type === 'loop') {
    const max = step.max ?? 3;
    for (let k = 1; ; k++) {
      ctx.iter = k;
      ui.event('info', { level: 'info', text: `↻ ${step.title || step.id}：第 ${k}/${max} 轮`, depth });
      await runSteps(step.steps, ctx, env, depth + 1);
      if (step.until && evalExpr(step.until, ctx, env.cwd)) { ui.event('info', { level: 'ok', text: `满足结束条件（${step.until}）` }); break; }
      if (k >= max) {
        const a = env.autoApprove ? 'a' : await ui.choose({
          question: `已到最大轮数 ${max}，仍未满足（${step.until}）`,
          options: [{ key: 'c', label: '再来一轮' }, { key: 'a', label: '接受现状继续' }, { key: 'n', label: '终止' }], stepId: step.id,
        });
        if (a === 'n') throw new Error('已被你终止');
        if (a === 'a') break;
      }
    }
    delete ctx.iter;
  } else throw new Error(`未知步骤类型 ${type}`);
  env.log.push({ step: step.id, at: new Date().toISOString() });
  done();
}

/**
 * 运行工作流。返回 { ok, runDir, error? }
 * inputs: { files: [路径], links: [网址] } 需求素材，会整理到 runDir/inputs 并附在需求后面
 */
export async function runWorkflow(wf, { task, inputs, cfg, cwd, ui, dryRun = false, autoApprove = false, signal, cli = false }) {
  if (!cfg.main) throw new Error('还没设置主工具');
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(cwd, '.aiflow', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const wfName = wf.name || path.basename(wf.__file || 'wf', '.json');
  const env = { wf, wfName, cfg, cwd, rootCwd: cwd, runDir, dryRun, autoApprove, signal, cli, ui, task, inputs: [], log: [], calls: [], artifacts: [], askQ: { p: Promise.resolve() }, startedAt: new Date().toISOString(), status: 'running' };
  const ctx = { task, feedback: '', runDir: relPath(cwd, runDir), steps: {} };
  ui.event('run-start', { workflow: wfName, main: cfg.main, runDir, task, runId });
  saveRun(env);
  let baseline = null;
  try {
    const isRepo = G.isRepo(cwd);
    if (isRepo) { G.ensureExcluded(cwd); baseline = G.snapshot(cwd, 'aiflow: 运行前'); }
    if (inputs && (inputs.files?.length || inputs.links?.length)) {
      const r = await prepareInputs({ runDir, cwd, files: inputs.files || [], links: inputs.links || [], cfg, ui });
      env.inputs = r.items;
      ctx.task = `${task}\n\n${r.section}`;
      addArtifact(env, { title: '需求素材', file: r.indexFile, stepId: '_inputs' });
    }
    await runSteps(wf.steps, ctx, env);
    env.status = 'done';
    ui.event('done', { runDir });
    return { ok: true, runDir };
  } catch (e) {
    env.status = env.signal?.aborted ? 'stopped' : 'failed';
    env.error = e.message;
    ui.event('error', { message: e.message, runDir });
    return { ok: false, runDir, error: e.message };
  } finally {
    // 本次运行带来的全部代码改动（与运行前的工作区快照对比，不含你运行前已有的改动）
    if (baseline && !dryRun) {
      try {
        const after = G.snapshot(cwd, 'aiflow: 运行后');
        const d = G.diff(cwd, baseline, after);
        if (d.trim()) {
          const file = path.join(runDir, 'changes.diff');
          fs.writeFileSync(file, d);
          fs.writeFileSync(path.join(runDir, 'changes.stat.txt'), G.diffStat(cwd, baseline, after));
          addArtifact(env, { title: '代码变更', file, stepId: '_changes', kind: 'diff' });
        }
      } catch (e) { ui.event('info', { level: 'warn', text: `生成代码变更记录失败：${e.message}` }); }
    }
    env.endedAt = new Date().toISOString();
    saveRun(env);
  }
}

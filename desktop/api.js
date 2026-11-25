// 桌面版/网页版共用的 API 层：与传输方式无关（Electron IPC 或本地 HTTP）。
// send(channel, payload) 推送给界面：run:event | run:end | ui:request | ui:cancel
// platform 提供原生能力：pickFolder / pickFile / attention / openPath / showItem（可缺省）
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig, saveConfig, toolDef, allToolIds, listWorkflowsDetailed, loadWorkflow,
  saveWorkflow, deleteWorkflow, HOME_DIR, BUILTIN_WF_DIR,
} from '../src/config.js';
import { detectAll } from '../src/detect.js';
import { resolveTool } from '../src/runner.js';
import { computeStats } from '../src/stats.js';
import { inspectSkills } from '../src/skills.js';
import { runInNewConsole } from '../src/proc.js';
import crypto from 'node:crypto';
import { JobManager } from '../src/jobs.js';
import * as S from '../src/schedule.js';

export function createApi({ send, platform = {}, scheduler = true, owner = 'desktop' }) {
  const pending = new Map(); // 请求 id → { resolve, reject, jobId }
  let seq = 0;

  const wait = (id, jobId) => new Promise((resolve, reject) => pending.set(id, { resolve, reject, jobId }));
  const jobTag = (job) => ({ jobId: job.id, project: path.basename(job.cwd), cwd: job.cwd, task: job.task.slice(0, 80) });

  // 每个任务一个界面适配器：事件和请求都带上 jobId，界面据此分到对应任务
  function makeUi(job) {
    const request = (kind, payload) => {
      const id = ++seq;
      send('ui:request', { id, kind, payload: { ...payload, ...jobTag(job) } });
      platform.attention?.(kind, { ...payload, project: path.basename(job.cwd) });
      jobs.setWaiting(job.id, true);
      return wait(id, job.id).finally(() => {
        if (![...pending.values()].some((p) => p.jobId === job.id)) jobs.setWaiting(job.id, false);
      });
    };
    const ui = {
      event: (type, data) => send('run:event', { jobId: job.id, type, data, at: Date.now() }),
      approve: (p) => request('approve', p),
      answer: (p) => request('answer', p),
      confirm: (p) => request('confirm', p),
      choose: (p) => request('choose', p),
      async pickFile(p) { return platform.pickFile ? platform.pickFile(p) : request('pickFile', p); },
      // 前台子 agent：在新控制台窗口里运行真实 CLI；窗口关闭或你点"我已完成"都会继续
      async interactive({ tool, name, exe, args, cwd, promptFile, signal }) {
        const id = ++seq;
        send('ui:request', { id, kind: 'interactive', payload: { tool, name, promptFile, ...jobTag(job) } });
        platform.attention?.('interactive', { name, project: path.basename(job.cwd) });
        jobs.setWaiting(job.id, true);
        const proc = runInNewConsole(exe, args, { cwd, title: `aiflow · ${path.basename(job.cwd)} · ${name}`, signal })
          .then((code) => ({ code }), (e) => ({ error: e.message }));
        const user = wait(id, job.id).then(() => ({ user: true }), () => ({ stopped: true }));
        const r = await Promise.race([proc, user]);
        jobs.setWaiting(job.id, false);
        if (!r.user) { pending.delete(id); send('ui:cancel', { id }); }
        if (r.error) ui.event('info', { level: 'err', text: `无法打开新窗口：${r.error}` });
        return r.code ?? 0;
      },
    };
    return ui;
  }

  const jobs = new JobManager({
    makeUi,
    onChange: (job) => {
      send('job:update', job);
      if (['done', 'failed'].includes(job.status)) platform.notifyDone?.(job);
    },
  });

  // 定时任务：到点后作为一个普通任务提交（同一项目在跑就排队）
  let sched = null;
  const schedLog = [];
  if (scheduler) {
    sched = S.startScheduler({
      owner,
      onLog: (level, text) => { schedLog.unshift({ at: new Date().toISOString(), level, text }); schedLog.length = Math.min(schedLog.length, 100); send('sched:log', { level, text }); },
      onDue: async (x) => {
        jobs.start({ cwd: x.cwd, workflow: x.workflow, task: x.task, inputs: x.inputs, autoApprove: x.approval !== 'wait', source: 'schedule', scheduleId: x.id, scheduleName: x.name });
        send('sched:changed', {});
      },
    });
  }

  const toolsView = (cfg) => ({
    main: cfg.main,
    tools: allToolIds(cfg).map((id) => {
      const d = toolDef(cfg, id);
      return { id, name: d.name, strengths: d.strengths || '', note: d.note || '', unverified: !!d.unverified, custom: !!cfg.custom[id], detected: cfg.detected[id] || null };
    }),
  });

  const handlers = {
    'app:info': () => ({ home: HOME_DIR, builtin: BUILTIN_WF_DIR, platform: process.platform, desktop: !!platform.desktop, recent: loadConfig().recentProjects || [] }),
    'app:settings': () => { const c = loadConfig(); return { maxConcurrent: c.maxConcurrent || 3, trayOnClose: c.trayOnClose !== false, openAtLogin: !!c.openAtLogin }; },
    'app:saveSettings': (p) => {
      const cfg = loadConfig();
      if (p.maxConcurrent != null) cfg.maxConcurrent = Math.max(1, Math.min(10, +p.maxConcurrent || 3));
      if (p.trayOnClose != null) cfg.trayOnClose = !!p.trayOnClose;
      if (p.openAtLogin != null) { cfg.openAtLogin = !!p.openAtLogin; platform.setOpenAtLogin?.(cfg.openAtLogin); }
      saveConfig(cfg);
      jobs.pump();
      return true;
    },

    'tools:list': () => toolsView(loadConfig()),
    'tools:detect': () => {
      const cfg = loadConfig();
      cfg.detected = Object.fromEntries(Object.entries(detectAll(cfg)).filter(([, v]) => v));
      if (!cfg.main || !cfg.detected[cfg.main]) {
        cfg.main = ['claude', 'codex', 'agy', 'gemini', 'opencode'].find((id) => cfg.detected[id]) || Object.keys(cfg.detected)[0] || null;
      }
      saveConfig(cfg);
      return toolsView(cfg);
    },
    'tools:setMain': (id) => {
      const cfg = loadConfig();
      if (!cfg.detected[id]) throw new Error(`${id} 未检测到`);
      cfg.main = id; saveConfig(cfg);
      return toolsView(cfg);
    },
    'tools:skills': (id, cwd) => inspectSkills(toolDef(loadConfig(), id), cwd || process.cwd()),

    'config:get': () => { const c = loadConfig(); return { defaultTimeoutMin: c.defaultTimeoutMin, overrides: c.overrides, custom: c.custom, integrations: c.integrations || {} }; },
    'config:save': (patch) => {
      const cfg = loadConfig();
      for (const k of ['defaultTimeoutMin', 'overrides', 'custom', 'integrations']) if (k in patch) cfg[k] = patch[k];
      saveConfig(cfg);
      return true;
    },

    'wf:list': (cwd) => listWorkflowsDetailed(cwd || process.cwd()),
    'wf:load': (cwd, file) => {
      const cfg = loadConfig();
      const wf = loadWorkflow(cwd || process.cwd(), file);
      const resolved = {};
      const walk = (steps) => steps.forEach((s) => {
        const t = s.type || 'agent';
        if (t === 'parallel' && s.steps) walk(s.steps);
        else if (t === 'parallel') resolved[s.id] = (s.roles || s.tools || []).map((r) => resolveTool(r, wf, cfg)).join(' + ');
        else if (t === 'agent' || t === 'interactive') resolved[s.id] = resolveTool(s.tool || s.role, wf, cfg);
        if (t === 'loop') walk(s.steps || []);
      });
      walk(wf.steps || []);
      const { __file, ...clean } = wf;
      return { wf: clean, file: __file, resolved };
    },
    'wf:save': ({ cwd, scope, name, wf }) => saveWorkflow(cwd || process.cwd(), scope, name, wf),
    'wf:delete': (file) => { deleteWorkflow(file); return true; },

    'stats:get': (days) => computeStats(days || 30),

    'file:read': (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
    'os:pickFiles': async () => (platform.pickFiles ? platform.pickFiles() : { unsupported: true }),
    // 拖进来的文件（或网页版上传的文件）先存到 ~/.aiflow/uploads，运行时再复制进本次记录
    'inputs:upload': ({ name, base64 }) => {
      const buf = Buffer.from(base64, 'base64');
      if (buf.length > 80 * 1024 * 1024) throw new Error('单个文件不能超过 80MB');
      const dir = path.join(HOME_DIR, 'uploads', crypto.randomBytes(6).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, path.basename(name).replace(/[\\/:*?"<>|]/g, '_'));
      fs.writeFileSync(file, buf);
      return file;
    },
    'runs:list': (cwd) => {
      const dir = path.join(cwd, '.aiflow', 'runs');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).sort().reverse().slice(0, 200).map((id) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, id, 'run.json'), 'utf8'));
          return { id, dir: path.join(dir, id), workflow: r.workflow, task: (r.task || '').slice(0, 200), status: r.status || (r.log ? 'done' : '?'), startedAt: r.startedAt, endedAt: r.endedAt, error: r.error, artifacts: (r.artifacts || []).length, calls: (r.calls || []).length, inputs: (r.inputs || []).length };
        } catch { return null; }
      }).filter(Boolean);
    },
    'runs:get': (cwd, id) => {
      const dir = path.join(cwd, '.aiflow', 'runs', path.basename(id));
      const r = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
      return { ...r, dir };
    },
    'os:pickFolder': async () => (platform.pickFolder ? platform.pickFolder() : { unsupported: true }),
    'os:openPath': async (p) => { await platform.openPath?.(p); return true; },
    'os:showItem': (p) => { platform.showItem?.(p); return true; },

    'project:use': (cwd) => {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('文件夹不存在');
      const cfg = loadConfig();
      cfg.recentProjects = [cwd, ...(cfg.recentProjects || []).filter((p) => p !== cwd)].slice(0, 8);
      saveConfig(cfg);
      return { cwd, isGit: fs.existsSync(path.join(cwd, '.git')), recent: cfg.recentProjects };
    },

    // ───── 任务（可同时运行多个，不同项目并行，同一项目排队） ─────
    'jobs:list': () => jobs.list(),
    'jobs:pending': () => [...pending.keys()],
    'run:start': ({ cwd, file, task, inputs, dryRun, autoApprove }) => jobs.start({ cwd, workflow: file, task, inputs, dryRun: !!dryRun, autoApprove: !!autoApprove }),
    'run:stop': (jobId) => {
      for (const [id, p] of pending) if (p.jobId === jobId) { pending.delete(id); p.reject(new Error('已停止')); send('ui:cancel', { id }); }
      return jobs.stop(jobId);
    },
    'jobs:remove': (jobId) => { jobs.remove(jobId); return true; },
    'ui:respond': (id, value) => {
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      p.resolve(value);
      return true;
    },

    // ───── 定时任务 ─────
    'sched:list': () => S.loadSchedules().map((x) => ({ ...x, whenText: S.describeWhen(x.when), project: path.basename(x.cwd) })),
    'sched:save': (x) => { const r = S.upsertSchedule(x); sched?.tick(); send('sched:changed', {}); return r; },
    'sched:delete': (id) => { S.deleteSchedule(id); send('sched:changed', {}); return true; },
    'sched:enable': (id, on) => { const r = S.setEnabled(id, on); send('sched:changed', {}); return r; },
    'sched:runNow': (id) => {
      const x = S.loadSchedules().find((y) => y.id === id);
      if (!x) throw new Error('计划不存在');
      return jobs.start({ cwd: x.cwd, workflow: x.workflow, task: x.task, inputs: x.inputs, autoApprove: x.approval !== 'wait', source: 'schedule', scheduleId: x.id, scheduleName: x.name });
    },
    'sched:preview': (when) => {
      S.validateWhen(when);
      const out = []; let t = new Date();
      for (let i = 0; i < 5; i++) { const n = S.nextRunOf(when, t); if (!n) break; out.push(n.toISOString()); if (when.kind === 'once') break; t = n; }
      return out;
    },
    'sched:log': () => schedLog,
  };

  return {
    async call(channel, ...args) {
      const h = handlers[channel];
      if (!h) throw new Error(`未知接口 ${channel}`);
      return h(...args);
    },
    isRunning: () => jobs.running().length > 0,
    runningCount: () => jobs.running().length,
    stop: () => { for (const [id, p] of pending) { pending.delete(id); p.reject(new Error('已停止')); } jobs.stopAll(); },
    hasSchedules: () => S.loadSchedules().some((x) => x.enabled),
    shutdown: () => sched?.stop(),
  };
}

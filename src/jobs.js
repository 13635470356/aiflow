// 任务管理：同时运行多个需求任务（不同项目并行），同一项目排队，限制总并发数
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, loadWorkflow } from './config.js';
import { runWorkflow } from './runner.js';
import { recordResult } from './schedule.js';

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

export class JobManager {
  /**
   * makeUi(job) → 该任务专用的 ui 适配器
   * onChange(job) → 任务状态变化（排队/运行/等你拍板/结束）时调用
   */
  constructor({ makeUi, onChange = () => {}, maxConcurrent }) {
    this.jobs = new Map();
    this.order = [];
    this.makeUi = makeUi;
    this.onChange = onChange;
    this.fixedMax = maxConcurrent;
  }
  get max() { return this.fixedMax || loadConfig().maxConcurrent || 3; }

  view(j) {
    const { controller, ui, ...rest } = j;
    return { ...rest, project: path.basename(j.cwd) };
  }
  list() { return this.order.map((id) => this.view(this.jobs.get(id))); }
  running() { return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'waiting'); }
  busyCwd(cwd) { return this.running().some((j) => norm(j.cwd) === norm(cwd)); }

  /** 新建任务：能跑就立即跑，否则排队 */
  start({ cwd, workflow, task, inputs, dryRun = false, autoApprove = false, source = 'manual', scheduleId = null, scheduleName = null }) {
    if (!task?.trim()) throw new Error('请填写需求');
    const cfg = loadConfig();
    if (!cfg.main) throw new Error('还没有主工具，请先检测工具并设置');
    const wf = loadWorkflow(cwd, workflow); // 先校验工作流存在
    const job = {
      id: crypto.randomBytes(4).toString('hex'), cwd, workflow: wf.__file, workflowName: wf.name || path.basename(wf.__file, '.json'),
      task, inputs, dryRun, autoApprove, source, scheduleId, scheduleName,
      status: 'queued', createdAt: new Date().toISOString(), queuedReason: '',
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    // 只保留最近 50 个已结束的任务
    const ended = this.order.filter((id) => ['done', 'failed', 'stopped'].includes(this.jobs.get(id).status));
    for (const id of ended.slice(0, Math.max(0, ended.length - 50))) { this.jobs.delete(id); this.order = this.order.filter((x) => x !== id); }
    this.pump();
    return this.view(job);
  }

  pump() {
    for (const id of this.order) {
      const j = this.jobs.get(id);
      if (j.status !== 'queued') continue;
      const reason = this.busyCwd(j.cwd) ? '同一项目已有任务在运行，等它结束' : this.running().length >= this.max ? `已达到同时运行上限（${this.max} 个）` : '';
      if (reason) { if (j.queuedReason !== reason) { j.queuedReason = reason; this.onChange(this.view(j)); } continue; }
      this.launch(j);
    }
  }

  launch(j) {
    j.status = 'running';
    j.queuedReason = '';
    j.startedAt = new Date().toISOString();
    j.controller = new AbortController();
    j.ui = this.makeUi(j);
    this.onChange(this.view(j));
    const cfg = loadConfig();
    let wf;
    try { wf = loadWorkflow(j.cwd, j.workflow); } catch (e) { return this.finish(j, { ok: false, error: e.message }); }
    const ui = { ...j.ui, event: (type, data) => { if (type === 'run-start') { j.runDir = data.runDir; this.onChange(this.view(j)); } j.ui.event(type, data); } };
    runWorkflow(wf, { task: j.task, inputs: j.inputs, cfg, cwd: j.cwd, ui, dryRun: j.dryRun, autoApprove: j.autoApprove, signal: j.controller.signal })
      .then((r) => this.finish(j, r), (e) => this.finish(j, { ok: false, error: e.message }));
  }

  finish(j, r) {
    j.status = r.ok ? 'done' : j.controller?.signal.aborted ? 'stopped' : 'failed';
    j.error = r.error || null;
    j.runDir = r.runDir || j.runDir;
    j.endedAt = new Date().toISOString();
    if (j.scheduleId) recordResult(j.scheduleId, { status: j.status, runDir: j.runDir, error: j.error, at: j.startedAt, jobId: j.id });
    this.onChange(this.view(j));
    this.pump();
  }

  /** 任务在等你拍板（界面用来显示"等你拍板"） */
  setWaiting(id, waiting) {
    const j = this.jobs.get(id);
    if (!j || !['running', 'waiting'].includes(j.status)) return;
    const s = waiting ? 'waiting' : 'running';
    if (j.status !== s) { j.status = s; this.onChange(this.view(j)); }
  }

  stop(id) {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.status === 'queued') { j.status = 'stopped'; j.endedAt = new Date().toISOString(); this.onChange(this.view(j)); this.pump(); return true; }
    if (['running', 'waiting'].includes(j.status)) { j.controller.abort(); return true; }
    return false;
  }
  stopAll() { for (const j of this.jobs.values()) this.stop(j.id); }
  remove(id) {
    const j = this.jobs.get(id);
    if (j && ['running', 'waiting', 'queued'].includes(j.status)) throw new Error('任务还没结束');
    this.jobs.delete(id); this.order = this.order.filter((x) => x !== id);
  }
}

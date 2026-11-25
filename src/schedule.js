// 定时任务：cron 解析、计划存储（~/.aiflow/schedules.json）、单实例锁、定时检查循环
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';

const FILE = () => path.join(HOME_DIR, 'schedules.json');
const LOCK = () => path.join(HOME_DIR, 'scheduler.lock');

// ───────── cron（5 段：分 时 日 月 周，本地时间） ─────────
function parseField(f, min, max) {
  const set = new Set();
  for (const part of f.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? +stepS : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number);
    else { lo = +range; hi = stepS ? max : lo; }
    if ([lo, hi, step].some((n) => !Number.isInteger(n)) || lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron 字段无效：${f}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}
export function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周，例如 "0 9 * * 1-5"');
  const dow = parseField(f[4].replace(/\b7\b/g, '0'), 0, 6);
  return { min: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), mon: parseField(f[3], 1, 12), dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}
/** 下一次触发时间（严格晚于 from） */
export function nextCron(expr, from = new Date()) {
  const c = parseCron(expr);
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 400 * 86400000;
  while (d.getTime() < limit) {
    if (!c.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

// ───────── 计划的时间规则 ─────────
// when: { kind:'daily', time:'09:00' } | { kind:'weekly', days:[1..7], time } | { kind:'interval', hours:N }
//     | { kind:'once', at:'2026-11-25T09:00' } | { kind:'cron', expr }
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function toCron(when) {
  const [h, m] = String(when.time || '09:00').split(':').map(Number);
  switch (when.kind) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekly': return `${m} ${h} * * ${(when.days || [1]).map((d) => d % 7).join(',')}`;
    case 'interval': return `0 */${Math.max(1, Math.min(23, +when.hours || 1))} * * *`;
    case 'cron': return when.expr;
    default: return null;
  }
}
export function describeWhen(when) {
  switch (when.kind) {
    case 'daily': return `每天 ${when.time}`;
    case 'weekly': {
      const ds = (when.days || []).map((d) => d % 7).sort((a, b) => (a || 7) - (b || 7));
      const label = ds.join(',') === '1,2,3,4,5' ? '工作日' : ds.join(',') === '0,6' || ds.join(',') === '6,0' ? '周末' : `每周${ds.map((d) => WEEK[d]).join('、')}`;
      return `${label} ${when.time}`;
    }
    case 'interval': return `每 ${when.hours} 小时（整点）`;
    case 'once': return `仅一次：${new Date(when.at).toLocaleString()}`;
    case 'cron': return `cron：${when.expr}`;
    default: return '?';
  }
}
export function nextRunOf(when, from = new Date()) {
  if (when.kind === 'once') { const t = new Date(when.at); return t > from ? t : null; }
  return nextCron(toCron(when), from);
}
export function validateWhen(when) {
  if (when.kind === 'once') { if (Number.isNaN(Date.parse(when.at))) throw new Error('请填写有效的执行时间'); return; }
  if (['daily', 'weekly'].includes(when.kind) && !/^\d{1,2}:\d{2}$/.test(when.time || '')) throw new Error('时间格式应为 HH:MM');
  if (when.kind === 'weekly' && !when.days?.length) throw new Error('至少选择一天');
  parseCron(toCron(when));
}

// ───────── 存储 ─────────
export function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return []; }
}
function saveSchedules(list) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE());
}
/**
 * 计划字段：id, name, enabled, cwd, workflow(文件路径或名称), task, inputs{files,links},
 *           when, approval('wait' 等我拍板 | 'auto' 无人值守), nextRun, lastRun, lastStatus, lastRunDir, history[]
 */
export function upsertSchedule(s) {
  if (!s.name?.trim()) throw new Error('请填写名称');
  if (!s.cwd || !fs.existsSync(s.cwd)) throw new Error('项目文件夹不存在');
  if (!s.workflow) throw new Error('请选择工作流');
  if (!s.task?.trim()) throw new Error('请填写需求');
  validateWhen(s.when);
  const list = loadSchedules();
  const i = list.findIndex((x) => x.id === s.id);
  const prev = i >= 0 ? list[i] : {};
  const next = nextRunOf(s.when);
  const item = {
    ...prev, ...s,
    id: s.id || crypto.randomBytes(5).toString('hex'),
    approval: s.approval === 'wait' ? 'wait' : 'auto',
    enabled: s.enabled !== false && !!next,
    nextRun: next ? next.toISOString() : null,
    history: prev.history || [],
    createdAt: prev.createdAt || new Date().toISOString(),
  };
  if (i >= 0) list[i] = item; else list.push(item);
  saveSchedules(list);
  return item;
}
export function deleteSchedule(id) { saveSchedules(loadSchedules().filter((s) => s.id !== id)); }
export function setEnabled(id, enabled) {
  const list = loadSchedules();
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error('计划不存在');
  s.enabled = !!enabled;
  if (enabled) { const n = nextRunOf(s.when); s.nextRun = n?.toISOString() ?? null; if (!n) s.enabled = false; }
  saveSchedules(list);
  return s;
}
export function recordResult(id, rec) {
  const list = loadSchedules();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, { lastStatus: rec.status, lastRunDir: rec.runDir || s.lastRunDir, lastError: rec.error || null });
  s.history = [{ at: rec.at || new Date().toISOString(), ...rec }, ...(s.history || [])].slice(0, 30);
  saveSchedules(list);
}

// ───────── 单实例锁：同一台电脑上只允许一个进程执行定时任务 ─────────
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function acquireLock(owner) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK(), 'utf8'));
    const fresh = Date.now() - cur.at < 120000;
    if (cur.pid !== process.pid && cur.host === os.hostname() && fresh && alive(cur.pid)) return { ok: false, holder: cur };
  } catch { /* 没有锁或锁已损坏 */ }
  fs.writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, host: os.hostname(), owner, at: Date.now() }));
  return { ok: true };
}
export function releaseLock() {
  try { const cur = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); if (cur.pid === process.pid) fs.rmSync(LOCK()); } catch { /* 忽略 */ }
}

/**
 * 启动定时检查。onDue(schedule) 负责真正执行（返回 Promise）。
 * 错过的计划（程序没开着）：落后不超过 graceMin 分钟就补跑，否则跳过并记录。
 */
export function startScheduler({ owner, onDue, onLog = () => {}, intervalMs = 20000, graceMin = 10 }) {
  let timer = null, holding = false;
  const tick = () => {
    const lock = acquireLock(owner);
    if (!lock.ok) {
      if (holding) onLog('warn', `定时任务改由其他 aiflow 进程执行（pid ${lock.holder.pid}）`);
      holding = false;
      return;
    }
    if (!holding) onLog('info', '定时任务调度已启动');
    holding = true;
    const now = new Date();
    const list = loadSchedules();
    let changed = false;
    for (const s of list) {
      if (!s.enabled || !s.nextRun) continue;
      const due = new Date(s.nextRun);
      if (due > now) continue;
      const late = (now - due) / 60000;
      const next = s.when.kind === 'once' ? null : nextRunOf(s.when, now);
      s.nextRun = next ? next.toISOString() : null;
      if (!next) s.enabled = false;
      changed = true;
      if (late > graceMin) {
        s.history = [{ at: now.toISOString(), status: 'missed', error: `错过了 ${due.toLocaleString()} 的执行（aiflow 当时没有运行）` }, ...(s.history || [])].slice(0, 30);
        s.lastStatus = 'missed';
        onLog('warn', `计划"${s.name}"错过了 ${due.toLocaleString()} 的执行，已跳过`);
        continue;
      }
      onLog('info', `计划"${s.name}"开始执行`);
      Promise.resolve().then(() => onDue({ ...s })).catch((e) => onLog('err', `计划"${s.name}"启动失败：${e.message}`));
    }
    if (changed) saveSchedules(list);
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const stop = () => { clearInterval(timer); releaseLock(); };
  process.once('exit', releaseLock);
  return { stop, tick };
}

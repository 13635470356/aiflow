// git 工具：快照、worktree、合并、补丁。全部不改动你当前分支和暂存区。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDENTITY = { GIT_AUTHOR_NAME: 'aiflow', GIT_AUTHOR_EMAIL: 'aiflow@localhost', GIT_COMMITTER_NAME: 'aiflow', GIT_COMMITTER_EMAIL: 'aiflow@localhost' };

export function git(cwd, args, { env, input } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', input, maxBuffer: 1 << 29, windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error) : '') };
}
function must(r, what) {
  if (r.code !== 0) throw new Error(`${what}失败：${(r.err || r.out).trim().slice(0, 600)}`);
  return r.out.trim();
}

export function isRepo(cwd) { return git(cwd, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true'; }

/** 把 .aiflow/ 加入本地忽略（.git/info/exclude，不会提交），避免运行记录出现在 git status 里 */
export function ensureExcluded(cwd) {
  const common = must(git(cwd, ['rev-parse', '--git-common-dir']), '读取 git 目录');
  const file = path.join(path.resolve(cwd, common), 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!/^\/?\.aiflow\/?$/m.test(cur)) fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}.aiflow/\n`);
}

/**
 * 给当前工作区（含未提交改动和未跟踪文件，不含被忽略的文件）拍一个快照提交。
 * 使用临时索引文件，不影响你的分支、暂存区和工作区。返回提交 id。
 */
export function snapshot(cwd, message = 'aiflow snapshot') {
  const tmpIndex = path.join(os.tmpdir(), `aiflow-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmpIndex, ...IDENTITY };
  try {
    const head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).out.trim();
    if (head) must(git(cwd, ['read-tree', head], { env }), '读取 HEAD');
    must(git(cwd, ['add', '-A'], { env }), '收集工作区文件');
    const tree = must(git(cwd, ['write-tree'], { env }), '生成快照');
    return must(git(cwd, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { env }), '提交快照');
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

export function addWorktree(cwd, dir, branch, base) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  must(git(cwd, ['worktree', 'add', '-q', '-b', branch, dir, base]), `创建 worktree ${path.basename(dir)} `);
}

export function removeWorktree(cwd, dir, branch) {
  git(cwd, ['worktree', 'remove', '--force', dir]);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git(cwd, ['worktree', 'prune']);
  if (branch) git(cwd, ['branch', '-D', branch]);
}

/** 提交 worktree 里的全部改动；没有改动返回 false */
export function commitAll(dir, message) {
  must(git(dir, ['add', '-A']), '暂存改动');
  if (git(dir, ['diff', '--cached', '--quiet']).code === 0) return false;
  must(git(dir, ['commit', '-q', '--no-verify', '-m', message], { env: IDENTITY }), '提交改动');
  return true;
}

export function conflictedFiles(dir) {
  return git(dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').map((s) => s.trim()).filter(Boolean);
}
export function filesWithMarkers(dir) {
  const r = git(dir, ['grep', '-l', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)']);
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 在 dir 里合并 branch。返回 { ok, conflicts } */
export function merge(dir, branch, message) {
  const r = git(dir, ['merge', '--no-ff', '--no-verify', '-m', message, branch], { env: IDENTITY });
  if (r.code === 0) return { ok: true, conflicts: [] };
  const conflicts = conflictedFiles(dir);
  if (!conflicts.length) throw new Error(`合并失败：${(r.err || r.out).trim().slice(0, 600)}`);
  return { ok: false, conflicts };
}

/** 解决冲突后完成合并提交 */
export function finishMerge(dir) {
  must(git(dir, ['add', '-A']), '暂存合并结果');
  must(git(dir, ['commit', '-q', '--no-verify', '--no-edit'], { env: IDENTITY }), '完成合并提交');
}

export function head(dir) { return must(git(dir, ['rev-parse', 'HEAD']), '读取 HEAD'); }
export function diff(cwd, a, b) { return must(git(cwd, ['diff', '--binary', a, b]), '生成差异') + '\n'; }
export function diffStat(cwd, a, b) { return git(cwd, ['diff', '--stat', a, b]).out.trim(); }

/** 把补丁应用到工作区（不动暂存区）。冲突时尝试三方合并。 */
export function applyPatch(cwd, patchFile) {
  if (!fs.readFileSync(patchFile, 'utf8').trim()) return { ok: true, empty: true };
  let r = git(cwd, ['apply', '--whitespace=nowarn', patchFile]);
  if (r.code === 0) return { ok: true };
  r = git(cwd, ['apply', '--3way', '--whitespace=nowarn', patchFile]);
  if (r.code === 0) return { ok: true, threeWay: true };
  return { ok: false, err: (r.err || r.out).trim() };
}

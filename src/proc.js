// 跨平台进程工具：查找可执行文件、安全启动（处理 Windows .cmd 垫片）、超时杀进程树
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const isWin = process.platform === 'win32';

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '');
}

/** 返回可执行文件的绝对路径，找不到返回 null */
export function which(bin, extraPaths = []) {
  const r = spawnSync(isWin ? 'where' : 'which', [bin], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!isWin) return lines[0];
    // npm 在 Windows 会同时生成无扩展名的 sh 脚本和 .cmd，前者不能直接运行
    return (
      lines.find((l) => /\.exe$/i.test(l)) ||
      lines.find((l) => /\.(cmd|bat)$/i.test(l)) ||
      null
    );
  }
  if (isWin) {
    for (const p of extraPaths.map(expandEnv)) if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const needsShell = (file) => isWin && /\.(cmd|bat)$/i.test(file);

// .cmd 必须经过 cmd.exe，需要手动给参数加引号
function quoteWin(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^%()]/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}

export function runSync(file, args, timeout = 10000) {
  const shell = needsShell(file);
  const r = spawnSync(shell ? `"${file}"` : file, shell ? args.map(quoteWin) : args, {
    encoding: 'utf8',
    shell,
    timeout,
    windowsHide: true,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function killTree(child) {
  if (!child.pid) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

/**
 * 启动子进程并实时输出。返回 { code, stdout, stderr, timedOut }
 * onLine(stream, line) 用于实时显示
 */
export function runStreaming(file, args, { stdin, cwd, timeoutMs, onLine, signal, cliSigint = false }) {
  return new Promise((resolve) => {
    const shell = needsShell(file);
    const child = spawn(shell ? `"${file}"` : file, shell ? args.map(quoteWin) : args, {
      cwd,
      shell,
      windowsHide: true,
      detached: !isWin, // Unix 下独立进程组，超时可整组杀掉
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let stdout = '', stderr = '', timedOut = false;
    const bufs = { stdout: '', stderr: '' };
    const feed = (name, chunk) => {
      const s = chunk.toString('utf8');
      if (name === 'stdout') stdout += s; else stderr += s;
      bufs[name] += s;
      const lines = bufs[name].split(/\r?\n/);
      bufs[name] = lines.pop();
      for (const l of lines) onLine?.(name, l);
    };
    child.stdout.on('data', (c) => feed('stdout', c));
    child.stderr.on('data', (c) => feed('stderr', c));
    child.on('error', (e) => { stderr += String(e); });
    // 无论是否通过 stdin 传提示词都要关闭 stdin，否则部分 CLI 会一直等待输入
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const onSigint = () => { killTree(child); process.exit(130); };
    if (cliSigint) process.once('SIGINT', onSigint);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('close', (code) => {
      process.removeListener('SIGINT', onSigint);
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      for (const n of ['stdout', 'stderr']) if (bufs[n]) onLine?.(n, bufs[n]);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 交互模式：把终端完全交给子工具（TUI），返回退出码 */
export function runInteractive(file, args, { cwd }) {
  return new Promise((resolve) => {
    const shell = needsShell(file);
    // cmd.exe 下参数不能含换行
    const a = shell ? args.map((x) => quoteWin(x.replace(/\r?\n/g, ' '))) : args;
    const child = spawn(shell ? `"${file}"` : file, a, { cwd, shell, stdio: 'inherit' });
    const ignore = () => {}; // Ctrl+C 交给子工具处理
    process.on('SIGINT', ignore);
    child.on('error', (e) => { console.error(String(e)); });
    child.on('close', (code) => { process.removeListener('SIGINT', ignore); resolve(code); });
  });
}

/**
 * 桌面版用：在一个新的控制台窗口里运行交互式 CLI（和直接在终端里用完全一样），窗口关闭后返回。
 * Windows：start /wait 打开新窗口；Linux：x-terminal-emulator。
 */
export function runInNewConsole(file, args, { cwd, title = 'aiflow', signal }) {
  return new Promise((resolve, reject) => {
    let child;
    if (isWin) {
      const q = (a) => '"' + String(a).replace(/\r?\n/g, ' ').replace(/"/g, '""') + '"';
      const inner = [file, ...args].map(q).join(' ');
      child = spawn('cmd.exe', ['/d', '/s', '/c', `start "${title.replace(/"/g, '')}" /wait cmd /d /c "${inner}"`], {
        cwd, windowsVerbatimArguments: true, windowsHide: true,
      });
    } else {
      const term = which('x-terminal-emulator') || which('gnome-terminal') || which('xterm');
      if (!term) return reject(new Error('没有找到可用的终端程序'));
      child = spawn(term, ['-e', file, ...args], { cwd, detached: true });
    }
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); resolve(code); });
  });
}

export function gitChanged(cwd) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
}

export function openInEditor(file) {
  const editor = process.env.EDITOR || (isWin ? 'notepad' : 'vi');
  spawnSync(editor, [file], { stdio: 'inherit', shell: isWin });
}

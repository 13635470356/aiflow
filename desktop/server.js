// 网页模式：aiflow ui —— 在本机起一个只监听 127.0.0.1 的服务，用浏览器打开同一套界面。
// 安全：每次启动生成随机 token，接口必须带 token，防止其他网页调用本机命令。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function openUrl(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* 忽略 */ }
}

export function startServer({ port = 7788, open = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const clients = new Set();
  const backlog = []; // 页面刷新后补发尚未处理的请求
  const send = (channel, payload) => {
    if (channel === 'ui:request') backlog.push(payload);
    if (channel === 'ui:cancel') { const i = backlog.findIndex((r) => r.id === payload.id); if (i >= 0) backlog.splice(i, 1); }
    const msg = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const res of clients) res.write(msg);
  };
  const opener = (p) => {
    const [cmd, args] = process.platform === 'win32' ? ['explorer', [p]] : ['xdg-open', [p]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  };
  const api = createApi({ send, owner: 'web', platform: { openPath: opener, showItem: (p) => opener(path.dirname(p)) } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authed = url.searchParams.get('t') === token || req.headers['x-aiflow-token'] === token;

    if (url.pathname === '/events') {
      if (!authed) { res.writeHead(403).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      for (const r of backlog) res.write(`data: ${JSON.stringify({ channel: 'ui:request', payload: r })}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      if (!authed) { res.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      const channel = decodeURIComponent(url.pathname.slice(5));
      if (channel === 'ui:respond') { const [id] = JSON.parse(body || '[]'); const i = backlog.findIndex((r) => r.id === id); if (i >= 0) backlog.splice(i, 1); }
      try {
        const result = await api.call(channel, ...JSON.parse(body || '[]'));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result: result ?? null }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    // 静态文件
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      if (open) openUrl(url);
      resolve({ url, server, api });
    });
  });
}

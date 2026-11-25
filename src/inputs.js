// 需求素材：上传的文件 + 链接（Confluence / Figma / 普通网页）
// 全部整理到 runDir/inputs/，生成 INDEX.md，并在需求后面附上一段说明，所有子 agent 都能看到。
// 取不到的内容不会让流程失败：会在说明里写明，请子 agent 用它自己的 MCP / 工具去访问。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const rel = (cwd, p) => path.relative(cwd, p).split(path.sep).join('/');
const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 80) || 'file';
function unique(dir, name) {
  let p = path.join(dir, name), i = 1;
  const { name: n, ext } = path.parse(name);
  while (fs.existsSync(p)) p = path.join(dir, `${n}-${i++}${ext}`);
  return p;
}

// ───────── 极简 zip 读取（docx / pptx / xlsx 都是 zip） ─────────
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    });
    p += 46 + nlen + elen + clen;
  }
  return files;
}
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const xmlText = (s) => decodeEntities(s.replace(/<[^>]+>/g, ''));

function docxToMd(buf) {
  const xml = readZip(buf).get('word/document.xml')?.().toString('utf8');
  if (!xml) throw new Error('找不到正文');
  const out = [];
  const para = (block) => {
    const text = (block.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(xmlText).join('');
    if (!text.trim()) return;
    const h = block.match(/<w:pStyle w:val="(?:Heading|heading|标题)\s?(\d)"/);
    out.push(h ? `${'#'.repeat(Math.min(6, +h[1]))} ${text}` : /<w:numPr>|<w:pStyle w:val="List/.test(block) ? `- ${text}` : text);
  };
  // 表格单独处理，其余按段落
  for (const part of xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/)) {
    if (part.startsWith('<w:tbl>')) {
      const rows = part.split('</w:tr>').filter((r) => r.includes('<w:tc'))
        .map((r) => r.split('</w:tc>').filter((c) => c.includes('<w:tc')).map((c) => (c.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(xmlText).join('').trim()));
      if (rows.length) out.push([`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => ' --- ').join('|')}|`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n'));
    } else part.split('</w:p>').forEach(para);
  }
  return out.join('\n\n');
}
function pptxToMd(buf) {
  const z = readZip(buf);
  const slides = [...z.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  return slides.map((n, i) => {
    const xml = z.get(n)().toString('utf8');
    const paras = xml.split('</a:p>').map((p) => (p.match(/<a:t>[^<]*<\/a:t>/g) || []).map(xmlText).join('')).filter((t) => t.trim());
    return `## 第 ${i + 1} 页\n\n${paras.join('\n')}`;
  }).join('\n\n');
}
function xlsxToMd(buf) {
  const z = readZip(buf);
  const shared = [];
  const ss = z.get('xl/sharedStrings.xml')?.().toString('utf8');
  if (ss) for (const si of ss.split('</si>')) if (si.includes('<si')) shared.push((si.match(/<t[^>]*>[^<]*<\/t>/g) || []).map(xmlText).join(''));
  const sheets = [...z.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  return sheets.slice(0, 10).map((n, i) => {
    const xml = z.get(n)().toString('utf8');
    const rows = [];
    for (const row of xml.split('</row>').slice(0, 500)) {
      const cells = [...row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, inner = '']) => {
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? (inner.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] || '');
        return /t="s"/.test(attrs) ? shared[+v] ?? '' : xmlText(v);
      });
      if (cells.some((c) => c !== '')) rows.push(`| ${cells.join(' | ')} |`);
    }
    return `## 工作表 ${i + 1}\n\n${rows.join('\n')}`;
  }).join('\n\n');
}

// ───────── HTML → Markdown（够用的简化版） ─────────
export function htmlToMd(html) {
  let s = String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<ri:attachment ri:filename="([^"]+)"[^>]*\/?>/gi, '[附件: $1]')
    .replace(/<ac:image[\s\S]*?ri:filename="([^"]+)"[\s\S]*?<\/ac:image>/gi, '[图片: $1]')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(+n)} ${t}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|table|blockquote|section|article)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '\n|').replace(/<\/t[dh]>/gi, ' |')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

// ───────── Confluence ─────────
async function fetchConfluence(url, conf, dir) {
  if (!conf?.token) throw new Error('未配置 Confluence 访问令牌（桌面版：设置 → 集成）');
  const u = new URL(url);
  const id = u.searchParams.get('pageId') || u.pathname.match(/\/pages\/(?:edit-v2\/)?(\d+)/)?.[1];
  if (!id) throw new Error('无法从链接识别页面 ID（短链接 /x/... 请打开后复制完整地址）');
  const base = (conf.baseUrl || `${u.origin}${u.pathname.startsWith('/wiki/') ? '/wiki' : ''}`).replace(/\/$/, '');
  const auth = conf.email ? `Basic ${Buffer.from(`${conf.email}:${conf.token}`).toString('base64')}` : `Bearer ${conf.token}`;
  const r = await fetchWithTimeout(`${base}/rest/api/content/${id}?expand=body.storage,version,space`, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Confluence 返回 HTTP ${r.status}${r.status === 401 || r.status === 403 ? '（令牌无效或没有权限）' : ''}`);
  const j = await r.json();
  const md = `# ${j.title}\n\n> 来源：${url}（版本 ${j.version?.number ?? '?'}）\n\n${htmlToMd(j.body?.storage?.value || '')}`;
  const file = unique(dir, `confluence-${safe(j.title)}.md`);
  fs.writeFileSync(file, md);
  return { title: j.title, files: [file], note: md.includes('[图片:') ? '页面内嵌图片未下载，如需请让子 agent 用 Confluence 工具查看' : '' };
}

// ───────── Figma ─────────
async function fetchFigma(url, conf, dir) {
  if (!conf?.token) throw new Error('未配置 Figma 个人访问令牌（桌面版：设置 → 集成）');
  const m = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('无法识别 Figma 文件');
  const key = m[1];
  const nodeParam = new URL(url).searchParams.get('node-id');
  const headers = { 'X-Figma-Token': conf.token };
  const api = async (p) => {
    const r = await fetchWithTimeout(`https://api.figma.com/v1${p}`, { headers }, 60000);
    if (!r.ok) throw new Error(`Figma 返回 HTTP ${r.status}${r.status === 403 ? '（令牌无效或无权访问此文件）' : ''}`);
    return r.json();
  };
  let fileName, frames;
  if (nodeParam) {
    const id = decodeURIComponent(nodeParam).replace('-', ':');
    const j = await api(`/files/${key}/nodes?ids=${encodeURIComponent(id)}`);
    fileName = j.name;
    const node = j.nodes?.[id]?.document;
    if (!node) throw new Error('找不到链接里的节点');
    frames = ['FRAME', 'COMPONENT', 'SECTION', 'INSTANCE'].includes(node.type) && !node.children?.some((c) => c.type === 'FRAME') ? [node] : (node.children || []).filter((c) => ['FRAME', 'COMPONENT', 'SECTION'].includes(c.type));
    if (!frames.length) frames = [node];
  } else {
    const j = await api(`/files/${key}?depth=2`);
    fileName = j.name;
    frames = (j.document?.children || []).flatMap((pg) => (pg.children || []).filter((c) => ['FRAME', 'COMPONENT', 'SECTION'].includes(c.type)).map((c) => ({ ...c, page: pg.name })));
  }
  const total = frames.length;
  frames = frames.slice(0, 12);
  // 结构说明：每个画板里的文字
  const texts = [];
  const walk = (n, acc) => { if (n.type === 'TEXT' && n.characters) acc.push(n.characters.trim()); (n.children || []).forEach((c) => walk(c, acc)); return acc; };
  let detail = {};
  try { detail = (await api(`/files/${key}/nodes?ids=${frames.map((f) => encodeURIComponent(f.id)).join(',')}`)).nodes || {}; } catch { /* 文字提取失败不影响图片 */ }
  // 导出 PNG
  const img = await api(`/images/${key}?ids=${frames.map((f) => encodeURIComponent(f.id)).join(',')}&format=png&scale=1`);
  const files = [];
  for (const f of frames) {
    const u = img.images?.[f.id];
    const words = detail[f.id]?.document ? walk(detail[f.id].document, []) : [];
    let pngRel = '';
    if (u) {
      const r = await fetchWithTimeout(u, {}, 60000);
      if (r.ok) {
        const png = unique(dir, `figma-${safe(f.name)}.png`);
        fs.writeFileSync(png, Buffer.from(await r.arrayBuffer()));
        files.push(png);
        pngRel = path.basename(png);
      }
    }
    const box = f.absoluteBoundingBox || detail[f.id]?.document?.absoluteBoundingBox;
    texts.push(`## ${f.page ? f.page + ' / ' : ''}${f.name}\n\n${pngRel ? `![${f.name}](${pngRel})\n\n` : ''}${box ? `尺寸：${Math.round(box.width)}×${Math.round(box.height)}\n\n` : ''}${words.length ? `界面文字：\n${words.slice(0, 80).map((w) => `- ${w.replace(/\n/g, ' ')}`).join('\n')}` : ''}`);
  }
  const md = `# Figma：${fileName}\n\n> 来源：${url}\n> 共 ${total} 个画板，导出了前 ${frames.length} 个为 PNG（可用 Read 工具直接查看图片）\n\n${texts.join('\n\n')}`;
  const mdFile = unique(dir, `figma-${safe(fileName)}.md`);
  fs.writeFileSync(mdFile, md);
  return { title: fileName, files: [mdFile, ...files], note: total > frames.length ? `只导出了前 ${frames.length} 个画板；需要更多请在链接里指定具体节点` : '' };
}

// ───────── 普通网页 ─────────
async function fetchGeneric(url, dir) {
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 aiflow' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (/text\/html/.test(type)) {
    const html = await r.text();
    if (/<input[^>]+type=["']?password/i.test(html) || /login|signin|sso/i.test(new URL(r.url || url).pathname)) throw new Error('页面需要登录');
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url).trim();
    const body = htmlToMd(html.match(/<body[\s\S]*<\/body>/i)?.[0] || html).slice(0, 120000);
    const file = unique(dir, `web-${safe(title)}.md`);
    fs.writeFileSync(file, `# ${title}\n\n> 来源：${url}\n\n${body}`);
    return { title, files: [file] };
  }
  const ext = /pdf/.test(type) ? '.pdf' : /png/.test(type) ? '.png' : /jpe?g/.test(type) ? '.jpg' : /markdown|text\/plain/.test(type) ? '.md' : '';
  if (!ext) throw new Error(`不支持的内容类型 ${type}`);
  const file = unique(dir, `web-${safe(path.basename(new URL(url).pathname) || 'file')}${path.extname(new URL(url).pathname) ? '' : ext}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return { title: path.basename(file), files: [file] };
}

export function linkKind(url, integrations = {}) {
  if (/figma\.com\//.test(url)) return 'figma';
  const cbase = integrations.confluence?.baseUrl;
  if (/atlassian\.net\/wiki|\/wiki\/spaces\/|\/pages\/viewpage\.action|\/display\//.test(url) || (cbase && url.startsWith(cbase.replace(/\/$/, '')))) return 'confluence';
  return 'web';
}
const KIND_LABEL = { figma: 'Figma 原型', confluence: 'Confluence 文档', web: '网页' };
const FILE_KIND = (ext) => ({ '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.gif': '图片', '.webp': '图片', '.svg': '图片', '.pdf': 'PDF', '.md': 'Markdown', '.txt': '文本', '.docx': 'Word', '.pptx': 'PPT', '.xlsx': 'Excel', '.csv': 'CSV', '.json': 'JSON', '.html': 'HTML' }[ext] || '文件');

/** 整理需求素材。返回 { items, section, indexFile } */
export async function prepareInputs({ runDir, cwd, files = [], links = [], cfg = {}, ui }) {
  const dir = path.join(runDir, 'inputs');
  fs.mkdirSync(dir, { recursive: true });
  const items = [];
  const say = (level, text) => ui?.event('info', { level, text });

  for (const src of files) {
    const name = path.basename(src);
    const item = { type: 'file', name, source: src, files: [] };
    try {
      const dest = unique(dir, safe(path.parse(name).name) + path.extname(name).toLowerCase());
      fs.copyFileSync(src, dest);
      item.files.push(dest);
      item.kind = FILE_KIND(path.extname(name).toLowerCase());
      const conv = { '.docx': docxToMd, '.pptx': pptxToMd, '.xlsx': xlsxToMd }[path.extname(name).toLowerCase()];
      if (conv) {
        try {
          const md = conv(fs.readFileSync(dest));
          const mdFile = `${dest}.md`;
          fs.writeFileSync(mdFile, `# ${name}\n\n${md}`);
          item.files.push(mdFile);
          item.note = '已转成 Markdown 文本，原文件里的图片未提取';
        } catch (e) { item.note = `转文字失败：${e.message}`; }
      }
      say('ok', `素材：${name}`);
    } catch (e) { item.error = e.message; say('err', `素材 ${name} 读取失败：${e.message}`); }
    items.push(item);
  }

  for (const url of links) {
    const kind = linkKind(url, cfg.integrations);
    const item = { type: 'link', url, kind: KIND_LABEL[kind], files: [] };
    try {
      say('info', `正在获取 ${KIND_LABEL[kind]}：${url}`);
      const r = kind === 'figma' ? await fetchFigma(url, cfg.integrations?.figma, dir)
        : kind === 'confluence' ? await fetchConfluence(url, cfg.integrations?.confluence, dir)
          : await fetchGeneric(url, dir);
      Object.assign(item, { name: r.title, files: r.files, note: r.note || '' });
      say('ok', `已获取 ${KIND_LABEL[kind]}：${r.title}（${r.files.length} 个文件）`);
    } catch (e) {
      item.error = e.message;
      say('warn', `未能自动获取 ${url}：${e.message}。会把链接交给子 agent，用它自己的工具（如 Figma / Atlassian MCP）访问`);
    }
    items.push(item);
  }

  const line = (it) => {
    const head = it.type === 'file' ? `- 【${it.kind || '文件'}】${it.name}` : `- 【${it.kind}】${it.name || it.url}${it.name ? `（${it.url}）` : ''}`;
    const lines = [head, ...it.files.map((f) => `  - ${rel(cwd, f)}`)];
    if (it.error) lines.push(`  - ⚠ 未能自动获取（${it.error}）：请用你自己的工具（MCP / 浏览）访问上面的链接；无法访问就在结果里说明`);
    if (it.note) lines.push(`  - 说明：${it.note}`);
    return lines.join('\n');
  };
  const list = items.map(line).join('\n');
  const indexFile = path.join(dir, 'INDEX.md');
  fs.writeFileSync(indexFile, `# 需求素材\n\n下面是需求方提供的全部素材。图片和 PDF 可以直接用 Read 工具查看；Word/PPT/Excel 已转成同名 .md 文本。\n\n${list}\n`);
  const section = `【需求素材】需求方提供了以下素材，请先阅读（清单见 ${rel(cwd, indexFile)}）。原型图、设计稿要仔细看，界面以设计稿为准：\n${list}`;
  return { items, section, indexFile };
}

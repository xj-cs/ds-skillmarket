/**
 * dsh-skill-market — node half.
 *
 * 职责：
 *  - 拉取 GitHub 上符合 DSH skills 规范（仓库内含 SKILL.md）的热门仓库，
 *    聚合 star 数（stargazers_count）与 Release 资产累计下载量（download_count）；
 *  - ETag 条件请求 + 磁盘缓存规避 GitHub API 限流（匿名 60 次/时，304 不计配额）；
 *  - 一键安装：下载仓库 tar.gz（codeload 直连，可选加速前缀回退，不翻墙），
 *    解析出技能目录，安装到 skills 主目录（~/.dsh/skills/<name>/SKILL.md）；
 *  - 卸载、已装清单扫描、目录（收藏夹）管理；
 *  - 通过宿主 webServer 服务注册同源 JSON API，供浏览器 half 调用。
 *
 * 零依赖：仅 Node 内置模块 + 全局 fetch（Node >= 18）。
 * 所有副作用（路由、临时目录、在途请求）都以 Cordis 标准方式可撤销：
 * apply() 内经 ctx.effect() 登记清理函数。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve as resolvePath, sep as pathSep } from 'node:path'
import { homedir } from 'node:os'
import dns from 'node:dns'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

/** 内置目录快照（随包分发，参考 dsh-market 的 registry-snapshot 模式）：
 *  打开集市即渲染全量卡片，零网络；星标/下载量等统计由 refresh 在后台更新。 */
const builtinCatalog = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../data/builtin-catalog.json', import.meta.url), 'utf8'))
  } catch {
    return { generatedAt: 0, repos: [] }
  }
})()

/** 自身版本（设置页展示；读失败退回 0.0.0）。 */
const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Cordis 插件名：与 cordis.patch.yml 里的 insert 条目 id 一致。 */
export const name = 'skill-market'

/* --------------------------------------------------------------------------
 * 常量与默认配置
 * ------------------------------------------------------------------------ */

/** 内置精选目录（均已在 GitHub 上验证含 skills 目录下的 SKILL.md）。
 *  2026-10-24 扩容：后 14 个来自 topic:claude-skills / topic:agent-skills 星标榜
 *  （tarball 实测含 SKILL.md；morluto/rea 等上榜但无 SKILL.md 目录者未收录）。 */
const SEED_REPOS = [
  { owner: 'anthropics', repo: 'skills', note: 'Anthropic 官方技能库', category: '官方' },
  { owner: 'obra', repo: 'superpowers', note: '智能体技能框架与软件开发方法论', category: '开发' },
  { owner: 'K-Dense-AI', repo: 'scientific-agent-skills', note: 'AI 科学家技能集', category: '科研' },
  { owner: 'coreyhaines31', repo: 'marketingskills', note: 'Claude Code 营销技能集', category: '营销' },
  { owner: 'wshobson', repo: 'agents', note: '多智能体插件市场（内含大量技能）', category: '开发' },
  { owner: 'thedotmack', repo: 'claude-mem', note: '跨会话持久上下文技能', category: '记忆' },
  { owner: 'Egonex-AI', repo: 'Understand-Anything', note: '把代码库变成可交互知识图', category: '可视化' },
  { owner: 'hugohe3', repo: 'ppt-master', note: 'AI 生成原生可编辑 PPT：模板填充/视觉重建/旁白动画', category: '可视化' },
  { owner: 'ayghri', repo: 'i-have-adhd', note: '阻止编码智能体把答案埋进长篇输出', category: '效率' },
  { owner: 'addyosmani', repo: 'agent-skills', note: 'Addy Osmani 出品：生产级软件工程技能', category: '开发' },
  { owner: 'tt-a1i', repo: 'archify', note: '把想法、计划或代码库变成可交互的架构页面', category: '可视化' },
  { owner: 'Leonxlnx', repo: 'taste-skill', note: '给编码智能体审美：前端艺术指导', category: '可视化' },
  { owner: 'cathrynlavery', repo: 'diagram-design', note: '编辑级品牌化图表设计', category: '可视化' },
  { owner: 'blader', repo: 'humanizer', note: '去除 AI 写作痕迹，读起来像本人', category: '效率' },
  { owner: 'alirezarezvani', repo: 'claude-skills', note: '380+ 全品类 Claude 技能合集', category: '开发' },
  { owner: 'phuryn', repo: 'pm-skills', note: '产品经理技能市场：100+ 技能', category: '效率' },
  { owner: 'OthmanAdi', repo: 'planning-with-files', note: '文件化持久规划（多语言，含中文版）', category: '开发' },
  { owner: 'JimLiu', repo: 'baoyu-skills', note: '宝玉技能：翻译、生图、排版、一键发布', category: '可视化' },
  { owner: 'alchaincyf', repo: 'huashu-design', note: '花叔设计：HTML 高保真原型与幻灯片', category: '可视化' },
  { owner: 'titanwings', repo: 'distilly', note: '把人物素材蒸馏成可复用画像技能', category: '效率' },
  { owner: 'zenstory-ai', repo: 'oh-story-claudecode', note: '中文网文创作工具箱：拆书、扫榜、写作、封面', category: '可视化' },
  { owner: 'Orchestra-Research', repo: 'AI-Research-SKILLs', note: '开源 AI 科研与工程技能库', category: '科研' },
  { owner: 'Jeffallan', repo: 'claude-skills', note: '67 个全栈开发专业技能', category: '开发' },
]

/** 分类集合（自选 = 用户自行添加的仓库默认分类）。 */
const CATEGORIES = ['官方', '开发', '科研', '营销', '记忆', '可视化', '效率', '自选']

const API_BASE = 'https://api.github.com'
const CODELOAD_BASE = 'https://codeload.github.com'
const USER_AGENT = 'dsh-skill-market/0.1.0 (+https://github.com/)'

/* --------------------------------------------------------------------------
 * GitHub 线路（对齐 dsh-market regions.ts 的多线路策略）：
 *  - 公共加速前缀按序回退，末尾永远保留直连兜底；自定义前缀（配置/环境变量）
 *    置顶而非替换——公共代理会死，链不能断；
 *  - 每类服务独立记忆最后成功线路（进程内 + cache.json 持久化）；
 *  - 校验失败的线路（代理错误页伪装 200 / HTML 响应）立即切换；
 *  - info/refs 走 git 智能协议端点：不占匿名 60 次/小时配额（dsh-market 实测结论）。
 * ------------------------------------------------------------------------ */

/** GitHub 公共加速前缀（按序回退；均可被 downloadProxy 配置顶替）。 */
const GITHUB_PROXIES = ['https://gh-proxy.com', 'https://ghfast.top']
/** API / refs 请求的单跳超时（毫秒）。 */
const HOP_TIMEOUT_MS = 8000
/** git 引用广播（info/refs）超时：慢线路不该拖住整轮刷新；大仓库的 refs 较大，放宽到 10s。 */
const REF_TIMEOUT_MS = 10_000
/** REST 星标复核失败后的冷却：线路挂掉期间不反复撞墙（仍做零配额的 git 广播）。 */
const META_RETRY_COOLDOWN_MS = 30 * 60 * 1000
/** HEAD 未变化的仓库，星标最多每 12 小时复核一次（期间 0 次 REST 调用）。 */
const STARS_REFRESH_MS = 12 * 60 * 60 * 1000

/** 归一化自定义加速前缀：仅 https、不带凭据/查询/锚点，去尾斜杠；非法返回 null。 */
function normalizeProxyPrefix(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.includes('\\')) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null
    if (u.search !== '' || u.hash !== '') return null
    const p = u.pathname.replace(/\/+$/, '')
    return `${u.origin}${p}`
  } catch {
    return null
  }
}

/** 缓存 TTL（分钟）与保护阈值。 */
const DEFAULT_TTL_MINUTES = 360
/** 剩余配额低于该值时本轮刷新提前收尾，返回部分数据。 */
const RATE_RESERVE = 8
/** 单仓库最多安装的技能数 / tar 解包安全上限。 */
const MAX_INSTALL_SKILLS = 300
const MAX_TAR_BYTES = 512 * 1024 * 1024
const MAX_TAR_ENTRIES = 50000
/** 整仓导入的 tarball 体积上限：技能仓库几乎都远小于此；
 *  超大仓库（带视频/大资产）应按 tree 深链目录或单文件 SKILL.md 导入。 */
const MAX_IMPORT_TARBALL_BYTES = 128 * 1024 * 1024
/** 请求体上限。 */
const MAX_BODY_BYTES = 1024 * 1024

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPO_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/* --------------------------------------------------------------------------
 * 路径安全：规范化 + 边界校验（所有拼接动态段的地方都走 safeJoin）
 * ------------------------------------------------------------------------ */

/** 父目录引用段检测（逐字符比较，先于任何拼接执行）。 */
function isParentRef(seg) {
  return typeof seg === 'string' && seg.length === 2 && seg[0] === '.' && seg[1] === '.'
}

/**
 * 连接 base 与相对段并做包含校验：
 * 结果规范化（resolve）后必须仍位于 base 目录内，否则抛错。
 */
function safeJoin(base, ...segments) {
  const target = resolvePath(join(base, ...segments))
  const root = resolvePath(base)
  if (target !== root && !target.startsWith(root + pathSep)) {
    throw new Error('path escapes allowed directory')
  }
  return target
}

/* --------------------------------------------------------------------------
 * URL 安全门：仅 http/https；解析并拒绝 localhost / 环回 / 私有 / 保留地址。
 * 所有对外请求（API、codeload、加速前缀）都必须经过这里。
 * ------------------------------------------------------------------------ */

const dnsCache = new Map() // host -> { ok, expires }

function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark
  if (a >= 224) return true // 组播/保留
  return false
}

function isForbiddenIp(ip) {
  if (ip.includes(':')) {
    const low = ip.toLowerCase()
    if (low === '::' || low === '::1') return true
    if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true // 链路本地 / ULA
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIPv4(mapped[1])
    return false
  }
  return isPrivateIPv4(ip)
}

function hostnameIsForbidden(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '0.0.0.0' || h === '::1') return true
  // IP 字面量直接判
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return isForbiddenIp(h)
  return false
}

/** GitHub 文本资源固定 host 白名单：这些 host 是写死常量（无 SSRF 面），
 *  但部分环境 DNS 无法解析（如大陆网络），DNS 复核只是可用性探测而非安全边界，
 *  故跳过——直连失败仍会由调用方落到加速线路。 */
const GITHUB_TEXT_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'])

async function assertSafeUrl(raw, { skipDns = false } = {}) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`invalid url: ${raw}`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`blocked protocol: ${u.protocol}`)
  if (hostnameIsForbidden(u.hostname)) throw new Error(`blocked host: ${u.hostname}`)
  if (skipDns && GITHUB_TEXT_HOSTS.has(u.hostname)) return u
  // 域名解析后仍要复核：防 DNS 命中内网地址。
  const host = u.hostname
  const now = Date.now()
  let verdict = dnsCache.get(host)
  if (!verdict || verdict.expires < now) {
    try {
      const results = await dns.promises.lookup(host, { all: true, verbatim: true })
      verdict = { ok: results.length > 0 && !results.some((r) => isForbiddenIp(r.address)), expires: now + 60_000 }
    } catch {
      verdict = { ok: false, expires: now + 10_000 }
    }
    dnsCache.set(host, verdict)
  }
  if (!verdict.ok) throw new Error(`blocked host (dns): ${host}`)
  return u
}

/** 手动跟随重定向的 fetch：每一跳都先过安全门。
 *  options.skipDnsVerify：目标 host 属固定 GitHub 白名单时跳过 DNS 复核（见 GITHUB_TEXT_HOSTS）。 */
async function safeFetch(rawUrl, options = {}, log = () => {}) {
  const { skipDnsVerify, ...fetchOpts } = options
  let url = await assertSafeUrl(rawUrl, { skipDns: skipDnsVerify === true })
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { ...fetchOpts, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      url = await assertSafeUrl(new URL(loc, url).href, { skipDns: skipDnsVerify === true })
      continue
    }
    return res
  }
  log(`too many redirects: ${rawUrl}`)
  throw new Error('too many redirects')
}

/** 流式读取响应体，累计超过 maxBytes 立即中止：
 *  codeload 不返回 Content-Length，超大仓库必须在传输途中掐断，
 *  而不是下完几百 MB 才报错。onProgress(bytesSoFar) 逐块回报用于进度条。 */
async function readBodyCapped(res, maxBytes, onProgress) {
  if (!res.body || typeof res.body.getReader !== 'function') return Buffer.from(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* 已断开 */ }
      throw new Error(`download exceeds ${Math.round(maxBytes / 1048576)} MB limit`)
    }
    chunks.push(Buffer.from(value))
    if (onProgress) { try { onProgress(total) } catch { /* 进度回报失败不影响下载 */ } }
  }
  return Buffer.concat(chunks)
}

/* --------------------------------------------------------------------------
 * GitHub API 客户端：ETag 条件请求 + 配额跟踪
 * ------------------------------------------------------------------------ */

function createGitHub({ token, routes, onRate }) {
  /** 有 token 只走直连：凭据绝不发给第三方代理。 */
  const apiRoutes = () => (token ? [null] : routes('api'))
  async function call(path, { etag } = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (etag) headers['if-none-match'] = etag
    let lastRateLimited = false
    for (const proxy of apiRoutes()) {
      let res
      try {
        res = await safeFetch(proxy === null ? `${API_BASE}${path}` : `${proxy}/${API_BASE}${path}`, {
          headers,
          signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        })
      } catch {
        continue // 传输失败：换下一条线路
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining'))
      const limit = Number(res.headers.get('x-ratelimit-limit'))
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      if (Number.isFinite(remaining)) onRate({ limit, remaining, reset })
      // 404 是仓库层面的事实，换线路不会改变，直接返回
      if (res.status === 404) return { status: 404, json: null, etag: undefined }
      // 代理错误页常以 200/HTML 伪装；非 JSON 一律视为线路失败
      if (String(res.headers.get('content-type') || '').includes('text/html')) continue
      if (res.status === 304) { routes.remember('api', proxy); return { status: 304, json: null, etag: etag || res.headers.get('etag') || undefined } }
      if (res.status === 403 || res.status === 429) { lastRateLimited = true; continue }
      if (!res.ok) continue
      try {
        const json = await res.json()
        routes.remember('api', proxy)
        return { status: 200, json, etag: res.headers.get('etag') || undefined }
      } catch {
        continue // 半截响应：换线路
      }
    }
    const err = new Error(lastRateLimited ? 'rate-limited' : `github unreachable on ${path}`)
    if (lastRateLimited) err.rateLimited = true
    throw err
  }
  return { call }
}

/* --------------------------------------------------------------------------
 * tar.gz 解包（最小 USTAR/GNU 实现，零依赖）
 * 返回 [{ path, data }]，path 为去掉仓库根目录前缀后的 POSIX 相对路径。
 * ------------------------------------------------------------------------ */

function parseOctal(buf, off, len) {
  const s = buf.toString('ascii', off, off + len).replace(/[\0 ]/g, '')
  if (!s) return 0
  // GNU base-256 扩展
  if (buf[off] & 0x80) {
    let v = buf[off] & 0x7f
    for (let i = off + 1; i < off + len; i++) v = v * 256 + buf[i]
    return v
  }
  return parseInt(s, 8) || 0
}

/** 规整归一化：拒绝绝对路径、盘符与父目录引用段，返回 POSIX 相对路径。 */
function normalizeEntryPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return null
  let s = p.replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  if (s.startsWith('/')) s = s.slice(1)
  if (/^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/').filter((seg) => seg !== '' && seg !== '.')
  if (parts.some((seg) => isParentRef(seg))) return null
  if (parts.length === 0) return null
  return parts.join('/')
}

function extractTarGz(gzBuffer) {
  let tar
  if (gzBuffer.length > 2 && gzBuffer[0] === 0x1f && gzBuffer[1] === 0x8b) {
    tar = zlib.gunzipSync(gzBuffer)
  } else {
    tar = gzBuffer // 容错：已是裸 tar
  }
  const files = []
  let off = 0
  let pendingLongName = null
  let pendingPaxPath = null
  let total = 0
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break // 结束块
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
    if (prefix) name = `${prefix}/${name}`
    const size = parseOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 0x30)
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (size < 0 || dataEnd > tar.length) throw new Error('corrupt tar entry')
    total += size
    if (total > MAX_TAR_BYTES) throw new Error('tarball too large')
    if (files.length > MAX_TAR_ENTRIES) throw new Error('too many tar entries')
    const data = tar.subarray(dataStart, dataEnd)
    off = dataStart + Math.ceil(size / 512) * 512
    if (type === 'L') { pendingLongName = data.toString('utf8').replace(/\0.*$/, ''); continue }
    if (type === 'x' || type === 'X') {
      // pax 头：仅取 path 覆盖记录
      const text = data.toString('utf8')
      const m = text.match(/(\d+) path=([^\n]*)\n/)
      if (m) pendingPaxPath = m[2]
      continue
    }
    if (type === 'g') continue // 全局 pax 头，忽略
    if (pendingLongName !== null) { name = pendingLongName; pendingLongName = null }
    if (pendingPaxPath !== null) { name = pendingPaxPath; pendingPaxPath = null }
    if (type !== '0' && type !== '\0' && type !== '7') continue // 目录/链接等跳过
    const norm = normalizeEntryPath(name)
    if (norm === null) continue
    files.push({ path: norm, data })
  }
  // 去掉仓库根前缀（<repo>-<ref>/
  const roots = new Set(files.map((f) => f.path.split('/')[0]))
  if (roots.size === 1 && files.some((f) => f.path.includes('/'))) {
    const root = [...roots][0]
    for (const f of files) f.path = f.path.slice(root.length + 1)
  }
  return files
}

/* --------------------------------------------------------------------------
 * SKILL.md 解析与技能发现
 * ------------------------------------------------------------------------ */

function stripQuotes(v) {
  return String(v || '').trim().replace(/^['"]|['"]$/g, '')
}

/** 在 frontmatter 文本（含 metadata 缩进块）里取一个键的值。 */
function fmKey(fm, key) {
  const top = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (top) return stripQuotes(top[1])
  const block = fm.match(new RegExp(`^metadata:\\s*\\n((?:[ \\t]+.+\\n?)+)`, 'm'))
  if (block) {
    const m = block[1].match(new RegExp(`^[ \\t]+${key}:\\s*(.+)$`, 'm'))
    if (m) return stripQuotes(m[1])
  }
  return ''
}

/** 从 SKILL.md 文本解析 frontmatter：name/description + metadata 版本信息。 */
function parseSkillMd(text) {
  const out = { name: '', description: '', version: '', license: '', author: '', homepage: '' }
  if (typeof text !== 'string') return out
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return out
  const fm = m[1]
  out.name = fmKey(fm, 'name')
  out.version = fmKey(fm, 'version').slice(0, 32)
  out.license = fmKey(fm, 'license').slice(0, 40)
  out.author = fmKey(fm, 'author').slice(0, 60)
  out.homepage = (fmKey(fm, 'official_repository') || fmKey(fm, 'homepage')).slice(0, 200)
  const descM = fm.match(/^description:\s*(.*)$/m)
  if (descM) {
    const inline = stripQuotes(descM[1])
    // YAML 块指示符（>、|、>-、|- 等）不是简介本身，需取后续缩进块
    if (inline && !/^[>|][+-]?$/.test(inline)) out.description = inline
  }
  if (!out.description) {
    // YAML 折叠块：取 description: > 之后的缩进行
    const blockM = fm.match(/^description:\s*[>|][^\n]*\n((?:[ \t]+[^\n]*\n?)+)/m)
    if (blockM) out.description = blockM[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 200)
  }
  out.description = out.description.slice(0, 200)
  return out
}

function hiddenSegment(path) {
  return path.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules')
}

/** 从 tar 条目里找技能：任意深度、路径上无隐藏段、以 SKILL.md 结尾。 */
function discoverSkillsFromTar(files, repoFallbackName) {
  const bySkill = new Map()
  for (const f of files) {
    if (!f.path.endsWith('SKILL.md')) continue
    if (hiddenSegment(f.path)) continue
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    const base = dir === '' ? repoFallbackName : dir.slice(dir.lastIndexOf('/') + 1)
    if (!bySkill.has(dir)) {
      bySkill.set(dir, { dir, base, files: [] })
    }
    bySkill.get(dir).files.push(f)
  }
  const skills = []
  for (const { dir, base, files } of bySkill.values()) {
    const skillMd = files.find((f) => f.path.endsWith('SKILL.md'))
    const meta = parseSkillMd(skillMd.data.toString('utf8'))
    const name0 = NAME_PATTERN.test(meta.name || '') ? meta.name : base
    if (!NAME_PATTERN.test(name0)) continue
    skills.push({
      name: name0,
      dirName: base,
      dir, // tar 内相对目录（'' = 仓库根）
      description: meta.description,
      version: meta.version,
      license: meta.license,
      author: meta.author,
      homepage: meta.homepage,
      fileCount: files.length,
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/** 从 git trees API 的扁平路径里预估技能清单（用于卡片展示，不用于安装）。 */
function discoverSkillsFromTreePaths(paths, repoFallbackName) {
  const dirs = new Set()
  for (const p of paths) {
    if (!p.endsWith('SKILL.md') || hiddenSegment(p)) continue
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    dirs.add(dir)
  }
  return [...dirs].map((dir) => {
    const base = dir === '' ? repoFallbackName : dir.slice(dir.lastIndexOf('/') + 1)
    return { name: NAME_PATTERN.test(base) ? base : '', dir, fileCount: 0, description: '' }
  }).filter((s) => s.name !== '')
}

/* --------------------------------------------------------------------------
 * 磁盘状态（缓存 / 目录 / 台账）
 * ------------------------------------------------------------------------ */

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/* --------------------------------------------------------------------------
 * 市场核心（createMarket）：纯参数注入，便于测试与宿主共用
 * ------------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.stateDir     状态目录（缓存/目录/台账）
 * @param {string} opts.skillsHome   技能主目录（默认 ~/.dsh/skills）
 * @param {string} [opts.token]      GitHub Personal Access Token（可选，仅提额）
 * @param {string} [opts.downloadProxy] 自定义 GitHub 加速前缀（https、无凭据）；
 *   置顶内建线路链而非替换，直连兜底永远保留（对齐 dsh-market 的 #850 教训）
 * @param {number} [opts.ttlMinutes] 缓存有效期
 * @param {object} [opts.log]
 */
export function createMarket(opts = {}) {
  const stateDir = opts.stateDir || join(homedir(), '.dsh', 'skill-market')
  const skillsHome = opts.skillsHome || join(homedir(), '.dsh', 'skills')
  const token = opts.token || ''
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) ? opts.ttlMinutes : DEFAULT_TTL_MINUTES
  const log = opts.log || (() => {})
  const fetchImpl = opts.fetchImpl || safeFetch

  const cacheFile = join(stateDir, 'cache.json')
  const catalogFile = join(stateDir, 'catalog.json')
  const ledgerFile = join(stateDir, 'installed.json')
  const prefsFile = join(stateDir, 'prefs.json')
  const metaDir = safeJoin(stateDir, 'skillmeta')
  const tarballDir = safeJoin(stateDir, 'tarballs')

  mkdirSync(stateDir, { recursive: true })
  mkdirSync(skillsHome, { recursive: true })
  mkdirSync(metaDir, { recursive: true })
  mkdirSync(tarballDir, { recursive: true })

  let cache = readJsonSafe(cacheFile, { fetchedAt: 0, etags: {}, items: {}, rate: null })
  let userRepos = readJsonSafe(catalogFile, [])
  let ledger = readJsonSafe(ledgerFile, {})
  let rate = cache.rate || null

  /* ----- 线路表（dsh-market regions.ts 模式）：自定义前缀置顶、直连兜底、按服务记忆 ----- */

  const routeMemory = {
    api: (cache.routeLabels && cache.routeLabels.api) || null,
    git: (cache.routeLabels && cache.routeLabels.git) || null,
    code: (cache.routeLabels && cache.routeLabels.code) || null,
  }
  const routeLabel = (p) => (p === null ? 'direct' : p)

  /** 某服务的候选线路。区域决定优先级（dsh-market 的「下载区域」设置）：
   *  china（默认）：API/下载代理优先（大陆直连不稳），git 广播直连优先（不占配额且常可直连）；
   *  global：全部直连优先。自定义前缀始终置顶，直连兜底永不丢。 */
  function routes(kind) {
    const custom = effectiveCustomProxy()
    const proxies = [custom, ...GITHUB_PROXIES].filter(Boolean).filter((p, i, a) => a.indexOf(p) === i)
    const region = getPrefs().region
    const chain = kind === 'git'
      ? (region === 'global' ? [custom, null, ...GITHUB_PROXIES] : [null, ...proxies])
      : (region === 'global' ? [custom, null, ...GITHUB_PROXIES] : [...proxies, null])
    const dedup = chain.filter((p, i, a) => p === null ? a.indexOf(null) === i : a.indexOf(p) === i)
    const winner = routeMemory[kind]
    if (!winner) return dedup
    const i = dedup.findIndex((p) => routeLabel(p) === winner)
    if (i <= 0) return dedup
    return [dedup[i], ...dedup.slice(0, i), ...dedup.slice(i + 1)]
  }
  routes.remember = (kind, proxy) => { routeMemory[kind] = routeLabel(proxy) }
  routes.label = (kind) => routeMemory[kind]

  /** git 引用广播：取仓库 HEAD sha。不占 API 配额；全部线路失败返回 null（刷新退回旧行为）。 */
  async function gitHeadSha(key) {
    const url = `https://github.com/${key}/info/refs?service=git-upload-pack`
    for (const proxy of routes('git')) {
      try {
        const res = await safeFetch(proxy === null ? url : `${proxy}/${url}`, {
          headers: { 'user-agent': 'git/2.40.0' },
          signal: AbortSignal.timeout(REF_TIMEOUT_MS),
        })
        if (!res.ok) continue
        const body = await res.text()
        // 必须是 git pkt-line 广播：代理 HTML 错误页伪装 200 在这里被拦下
        if (!body.includes('# service=git-upload-pack')) continue
        const m = /([0-9a-f]{40}) HEAD/.exec(body)
        if (!m) continue
        routes.remember('git', proxy)
        return m[1]
      } catch { /* 换下一条线路 */ }
    }
    return null
  }
  /** 在途安装（单仓库单飞）。 */
  const inflight = new Map()
  /** 在途技能详情拉取（单仓库单飞）。 */
  const inflightMeta = new Map()
  /** 本次会话创建的临时目录，dispose 时清理。 */
  const sessionTmpDirs = new Set()

  /* ----- 内置快照打底：缺的仓库补齐、已有仓库补技能详情（不写盘，统计待 refresh 更新）。
   * 旧结构的 skillDetails（0.4.2 之前，无 dirName/dir）也用新快照升级。 ----- */
  for (const r of builtinCatalog.repos || []) {
    const key = `${r.owner}/${r.repo}`
    if (cache.items[key]) {
      const stale = !Array.isArray(cache.items[key].skillDetails)
        || cache.items[key].skillDetails.length === 0
        || !cache.items[key].skillDetails.some((s) => s && s.dirName)
      if (stale) {
        cache.items[key].skillDetails = r.skills || []
        if (!cache.items[key].statsAt) cache.items[key].statsAt = builtinCatalog.generatedAt || 0
      }
      continue
    }
    cache.items[key] = {
      meta: {
        stars: r.stars ?? null,
        description: r.description || '',
        defaultBranch: r.defaultBranch || 'main',
        pushedAt: r.pushedAt || '',
        owner: r.owner,
        htmlUrl: `https://github.com/${key}`,
      },
      skills: (r.skills || []).map((s) => ({ name: s.name })),
      skillDetails: r.skills || [],
      downloads: r.downloads ?? null,
      note: r.note || '',
      category: r.category || '自选',
      statsAt: builtinCatalog.generatedAt || 0,
      fetchedAt: 0,
      bundled: true,
    }
  }

  /* ----- 偏好设置（侧边栏开关 / 下载区域 / 自定义加速前缀） ----- */

  function getPrefs() {
    const p = readJsonSafe(prefsFile, {})
    return {
      sidebar: p.sidebar === true,
      region: p.region === 'global' ? 'global' : 'china',
      apiProxy: typeof p.apiProxy === 'string' ? p.apiProxy : '',
    }
  }

  function setPrefs(patch) {
    const p = getPrefs()
    if (patch && typeof patch.sidebar === 'boolean') p.sidebar = patch.sidebar
    if (patch && (patch.region === 'global' || patch.region === 'china')) {
      if (p.region !== patch.region) {
        p.region = patch.region
        // 区域切换后线路记忆作废：直连/代理优先级变了，重新探测
        routeMemory.api = null
        routeMemory.git = null
        routeMemory.code = null
      }
    }
    if (patch && typeof patch.apiProxy === 'string') {
      // 空串 = 清除（回到自动线路链）；非空必须能通过归一化校验
      if (patch.apiProxy.trim() === '') p.apiProxy = ''
      else {
        const n = normalizeProxyPrefix(patch.apiProxy)
        if (n) p.apiProxy = n
      }
    }
    writeJsonAtomic(prefsFile, p)
    return p
  }

  /** 生效的自定义前缀：插件配置/环境变量（operator 级）优先并锁定，否则用界面偏好。 */
  const managedProxy = normalizeProxyPrefix(opts.downloadProxy || '')
  const effectiveCustomProxy = () => managedProxy || normalizeProxyPrefix(getPrefs().apiProxy || '')

  const github = createGitHub({
    token,
    routes,
    onRate: (r) => { rate = r },
  })

  function persistCache() {
    cache.fetchedAt = Date.now()
    cache.etags = cache.etags || {}
    cache.items = cache.items || {}
    cache.rate = rate
    cache.routeLabels = { api: routeMemory.api, git: routeMemory.git, code: routeMemory.code }
    writeJsonAtomic(cacheFile, cache)
  }

  function catalogList() {
    return [
      ...SEED_REPOS,
      ...userRepos.map((r) => ({ owner: r.owner, repo: r.repo, note: r.note || '', category: r.category || '自选', userAdded: true })),
    ]
  }

  /** 刷新（dsh-market 的配额观）：技能新鲜度只依赖零配额的 git 引用广播；
   *  REST（星标/树/下载量）是 best-effort——公共代理池随时可能 403（共享账号），
   *  失败保留旧数据、不中断整轮、HEAD 不记账以便下轮重试。 */
  async function refresh(force = false) {
    const ageMinutes = (Date.now() - (cache.fetchedAt || 0)) / 60_000
    if (!force && cache.fetchedAt && ageMinutes < ttlMinutes && Object.keys(cache.items || {}).length > 0) {
      return { refreshed: false, partial: false }
    }
    cache.etags = cache.etags || {}
    cache.items = cache.items || {}
    let partial = false
    let refreshedAny = false
    let degradedCount = 0
    for (const entry of catalogList()) {
      const key = `${entry.owner}/${entry.repo}`
      const prev = cache.items[key] || {}
      const stamp = () => {
        prev.note = entry.note || ''
        prev.category = entry.category || '自选'
        prev.userAdded = entry.userAdded === true
      }
      try {
        // 0) git 引用广播取 HEAD（不占匿名配额，也不占代理池的 API 配额）
        const head = await gitHeadSha(key)
        if (head === null) {
          stamp()
          prev.error = 'refs unreachable'
          prev.fetchedAt = prev.fetchedAt || Date.now()
          cache.items[key] = prev
          partial = true
          continue
        }
        // HEAD 未变且星标尚新 → 本轮 0 次 REST 调用
        if (prev.headSha === head && prev.meta?.stars != null
          && Number.isFinite(prev.statsAt) && Date.now() - prev.statsAt < STARS_REFRESH_MS) {
          stamp()
          prev.error = undefined
          prev.fetchedAt = Date.now()
          cache.items[key] = prev
          refreshedAny = true
          continue
        }
        const changed = !prev.headSha || prev.headSha !== head
        // 1) 星标复核（best-effort）：全部线路失败 → 保留旧值，HEAD 不记账，本轮降级标记；
        //    冷却期内不重试（避免线路故障时每轮刷新都把时间花在注定失败的请求上）
        const metaEtagKey = `${key}:meta`
        let metaOk = true
        if (Number.isFinite(prev.metaRetryAt) && Date.now() - prev.metaRetryAt < META_RETRY_COOLDOWN_MS) {
          metaOk = false
        } else {
          try {
            const meta = await github.call(`/repos/${key}`, { etag: cache.etags[metaEtagKey] })
            if (meta.status === 200) {
              cache.etags[metaEtagKey] = meta.etag
              prev.meta = {
                stars: meta.json.stargazers_count ?? 0,
                description: meta.json.description || '',
                defaultBranch: meta.json.default_branch || 'main',
                pushedAt: meta.json.pushed_at || '',
                owner: meta.json.owner?.login || entry.owner,
                htmlUrl: meta.json.html_url || `https://github.com/${key}`,
              }
            }
            prev.metaRetryAt = undefined
          } catch {
            metaOk = false
            prev.metaRetryAt = Date.now()
          }
        }
        if (!metaOk) {
          stamp()
          prev.error = undefined
          prev.fetchedAt = prev.fetchedAt || Date.now()
          cache.items[key] = prev
          degradedCount++
          continue
        }
        const branch = prev.meta?.defaultBranch || 'main'
        // 2) 文件树 + Release 下载量：仅当 HEAD 变化时重拉；失败同样不记账
        if (changed) {
          try {
            const treeEtagKey = `${key}:tree`
            const tree = await github.call(`/repos/${key}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { etag: cache.etags[treeEtagKey] })
            if (tree.status === 200) {
              cache.etags[treeEtagKey] = tree.etag
              const paths = (tree.json.tree || []).map((t) => t.path)
              prev.skills = discoverSkillsFromTreePaths(paths, entry.repo)
              prev.treeTruncated = tree.json.truncated === true
            }
            const relEtagKey = `${key}:rel`
            try {
              const rel = await github.call(`/repos/${key}/releases?per_page=100`, { etag: cache.etags[relEtagKey] })
              if (rel.status === 200) {
                cache.etags[relEtagKey] = rel.etag
                prev.downloads = Array.isArray(rel.json)
                  ? rel.json.reduce((sum, r) => sum + (r.assets || []).reduce((s, a) => s + (a.download_count || 0), 0), 0)
                  : 0
              }
            } catch { prev.downloads = prev.downloads ?? 0 }
          } catch {
            stamp()
            prev.error = undefined
            prev.fetchedAt = prev.fetchedAt || Date.now()
            cache.items[key] = prev
            degradedCount++
            continue
          }
        }
        prev.headSha = head
        cache.items[key] = prev
        refreshedAny = true
      } catch (e) {
        // 兜底：单仓库异常保留旧数据并标记
        prev.error = String(e.message || e)
        prev.fetchedAt = prev.fetchedAt || Date.now()
        prev.note = entry.note || ''
        prev.category = entry.category || '自选'
        prev.userAdded = entry.userAdded === true
        cache.items[key] = prev
      }
    }
    cache.statsDegraded = degradedCount > 0
    if (refreshedAny || force) persistCache()
    return { refreshed: refreshedAny, partial, degraded: degradedCount }
  }

  /** 已安装扫描：skillsHome 下含 SKILL.md 的目录。
   *  覆盖三类来源：集市安装（ledger 有 owner/repo）、本插件创建/导入（ledger 有 kind）、
   *  外部手动放入（无 ledger 记录）。 */
  function installedList() {
    const out = []
    let dirs = []
    try {
      dirs = readdirSync(skillsHome, { withFileTypes: true })
    } catch {
      return out
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      if (d.name.startsWith('.') || d.name.startsWith('_')) continue
      const dir = safeJoin(skillsHome, d.name)
      const skillMd = join(dir, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      const meta = parseSkillMd(readFileSync(skillMd, 'utf8'))
      const name = NAME_PATTERN.test(meta.name || '') ? meta.name : d.name
      const led = ledger[d.name] || ledger[name]
      const rec = {
        name,
        dirName: d.name,
        description: meta.description,
        version: meta.version,
        /** repo=集市仓库安装 / url=URL 导入 / created=本插件创建 / local=外部手动放入 */
        sourceKind: 'local',
        source: '',
        sourceUrl: '',
        installedAt: '',
      }
      if (led) {
        rec.installedAt = led.installedAt || ''
        if (led.owner && led.repo) {
          rec.sourceKind = 'repo'
          rec.source = `${led.owner}/${led.repo}`
          rec.sourceUrl = `https://github.com/${led.owner}/${led.repo}`
        } else if (led.kind === 'url' && led.url) {
          rec.sourceKind = 'url'
          rec.sourceUrl = led.url
        } else if (led.kind === 'local') {
          rec.sourceKind = 'created'
        }
      }
      out.push(rec)
    }
    return out
  }

  function statePayload() {
    const catByKey = new Map(catalogList().map((r) => [`${r.owner}/${r.repo}`, r.category || '自选']))
    // 已过期的配额快照不再下发（窗口重置后旧值只会误导展示与前端提示）
    const rateLive = rate && (!rate.reset || rate.reset * 1000 > Date.now()) ? rate : null
    const items = Object.entries(cache.items).map(([key, v]) => ({
      key,
      owner: key.split('/')[0],
      repo: key.split('/')[1],
      stars: v.meta?.stars ?? null,
      downloads: v.downloads ?? null,
      description: v.meta?.description || '',
      note: v.note || '',
      category: catByKey.get(key) || '自选',
      pushedAt: v.meta?.pushedAt || '',
      htmlUrl: v.meta?.htmlUrl || `https://github.com/${key}`,
      branch: v.meta?.defaultBranch || 'main',
      skills: (v.skills || []).map((s) => ({ name: s.name })),
      skillDetails: v.skillDetails || [],
      skillCount: (v.skills || []).length,
      treeTruncated: v.treeTruncated === true,
      statsAt: v.statsAt || 0,
      userAdded: v.userAdded === true,
      error: v.error || '',
    }))
    return {
      items,
      installed: installedList(),
      fetchedAt: cache.fetchedAt || 0,
      stale: Date.now() - (cache.fetchedAt || 0) > ttlMinutes * 60_000,
      partial: false,
      /** 上一轮星标/下载量复核是否因接口受限而降级（技能目录不受影响） */
      statsDegraded: cache.statsDegraded === true,
      cache: cacheStats(),
      rate: rateLive,
      catalog: catalogList().map((r) => ({ key: `${r.owner}/${r.repo}`, category: r.category || '自选', userAdded: r.userAdded === true })),
      categories: CATEGORIES,
      prefs: getPrefs(),
      config: {
        hasToken: Boolean(token),
        hasProxy: Boolean(managedProxy || effectiveCustomProxy()),
        /** 当前生效的自定义加速前缀（'' = 自动线路链）；operator 配置存在时界面输入被锁定 */
        apiProxy: effectiveCustomProxy(),
        apiProxyManaged: Boolean(managedProxy),
        region: getPrefs().region,
        version: pkgVersion,
        stateDir,
        /** 最后成功的数据线路（direct=直连；其余为加速前缀），供前端展示真实状态 */
        dataRoute: routeMemory.api,
        gitRoute: routeMemory.git,
        skillsHome,
        ttlMinutes,
      },
    }
  }

  /** 下载 tarball（ref 为 codeload tar.gz/ 后的部分，如 refs/heads/main、HEAD）：
   *  多线路按序回退（自定义前缀置顶、直连兜底），
   *  以 gzip 魔数校验拒绝代理错误页伪装的 200（dsh-market 的校验教训）；
   *  maxBytes 限流流式读取（不传则用 MAX_TAR_BYTES 兜底）；
   *  onProgress(bytes) 逐块回报下载字节（仅成功线路的读流会触发）。 */
  async function downloadTarballRef(owner, repo, ref, maxBytes, onProgress) {
    const direct = `${CODELOAD_BASE}/${owner}/${repo}/tar.gz/${ref.split('/').map(encodeURIComponent).join('/')}`
    let lastErr = null
    for (const proxy of routes('code')) {
      const url = proxy === null ? direct : `${proxy}/${direct}`
      try {
        // 总时长上限：防挂起；放宽到 10 分钟以容忍慢而持续有进展的下载
        const res = await fetchImpl(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' },
          signal: AbortSignal.timeout(600_000),
        })
        if (!res.ok) { lastErr = new Error(`download ${res.status} ${url}`); continue }
        const buf = await readBodyCapped(res, maxBytes || MAX_TAR_BYTES, onProgress)
        // 非 gzip 载荷 = 代理错误页/HTML 伪装，换下一条线路
        if (buf.length < 1024 || buf[0] !== 0x1f || buf[1] !== 0x8b) { lastErr = new Error(`invalid tarball payload from ${url}`); continue }
        routes.remember('code', proxy)
        return buf
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('download failed')
  }

  /** ref 未知（纯仓库链接导入，不知道默认分支名）时按候选序尝试：
   *  codeload 支持 HEAD 引用（实测 gh-proxy 可用），404/坏载荷自动换下一个。 */
  async function downloadTarballAnyRef(owner, repo, refs, maxBytes, onProgress) {
    let lastErr = null
    for (const ref of refs) {
      try { return await downloadTarballRef(owner, repo, ref, maxBytes, onProgress) } catch (e) { lastErr = e }
    }
    throw lastErr || new Error('download failed')
  }

  /**
   * tarball 落盘缓存（TTL 与技能详情一致）：详情解析与安装共用同一次下载，
   * 同仓库第二次安装为本地解包，秒级完成（dsh-market「预构建优先」的对应做法）。
   */
  /** tarball 落盘缓存（TTL 与技能详情一致）：ref 为完整引用路径（refs/heads/main、HEAD），
   *  缓存键不含 ref——目录安装（默认分支）与导入共用；详情解析与安装共用同一次下载，
   *  同仓库第二次安装为本地解包，秒级完成（dsh-market「预构建优先」的对应做法）。 */
  async function downloadTarballOnce(owner, repo, ref, maxBytes, onProgress) {
    const file = safeJoin(tarballDir, `${owner}__${repo}.tgz`)
    try {
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs < META_TTL_MS) {
        return readFileSync(file)
      }
    } catch { /* 缓存读失败则重新下载 */ }
    const buf = await downloadTarballRef(owner, repo, ref, maxBytes, onProgress)
    try { writeFileSync(file, buf) } catch { /* 磁盘写失败不影响本次返回 */ }
    return buf
  }

  /**
   * 技能详情：整仓 tarball 下载一次（codeload 直连，不占 GitHub API 配额），
   * 解析出每个技能的 name/简介/版本/许可证/作者/GitHub 目录，磁盘缓存 7 天。
   * @param {string} key 'owner/repo'，必须在目录内。
   */
  const META_TTL_MS = 7 * 24 * 60 * 60 * 1000
  /** 缓存结构版本：v2 起携带 dirName/dir（GitHub 目录名与仓库内路径）。 */
  const META_VERSION = 2
  async function skillMeta(key) {
    if (!REPO_REF_PATTERN.test(key || '')) throw new Error('bad repo ref')
    const inCatalog = catalogList().some((r) => `${r.owner}/${r.repo}` === key)
    if (!inCatalog) throw Object.assign(new Error('source not in catalog'), { status: 404 })
    if (inflightMeta.has(key)) return inflightMeta.get(key)
    const [owner, repo] = key.split('/')
    const file = safeJoin(metaDir, `${owner}__${repo}.json`)
    const p = (async () => {
      const cached = readJsonSafe(file, null)
      if (cached && cached.v === META_VERSION && Array.isArray(cached.skills) && Date.now() - (cached.fetchedAt || 0) < META_TTL_MS) {
        return cached.skills
      }
      const branch = cache.items[key]?.meta?.defaultBranch || 'main'
      const gz = await downloadTarballOnce(owner, repo, `refs/heads/${branch}`)
      const files = extractTarGz(gz)
      const skills = discoverSkillsFromTar(files, repo).map((s) => ({
        name: s.name,
        dirName: s.dirName,
        dir: s.dir,
        description: s.description,
        version: s.version,
        license: s.license,
        author: s.author,
        homepage: s.homepage,
        fileCount: s.fileCount,
      }))
      writeJsonAtomic(file, { v: META_VERSION, fetchedAt: Date.now(), skills })
      return skills
    })().finally(() => { inflightMeta.delete(key) })
    inflightMeta.set(key, p)
    return p
  }

  /** 把一个技能从 tar 文件表拷贝到临时 staging 目录（install 与整仓导入共用）；
   *  staging 无 SKILL.md 时返回 null。 */
  function stageSkillFiles(files, skill, tmpRoot) {
    const staging = safeJoin(tmpRoot, skill.name)
    mkdirSync(staging, { recursive: true })
    for (const f of files) {
      const rel = f.path === 'SKILL.md' && skill.dir === '' ? 'SKILL.md'
        : skill.dir === '' ? null
        : (f.path === skill.dir || f.path.startsWith(`${skill.dir}/`)) ? f.path.slice(skill.dir.length + 1) : null
      if (rel === null || rel === '') continue
      if (hiddenSegment(rel)) continue
      const target = safeJoin(staging, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.data)
    }
    return existsSync(join(staging, 'SKILL.md')) ? staging : null
  }

  /**
   * 集市安装执行器（0.10.0 任务化，后台运行）：与旧同步 install() 同一链路——
   * 下载整仓 tar.gz 一次（走 tarball 缓存，命中则秒级）、解出技能、逐个落盘 skillsHome——
   * 把阶段与进度写进任务（下载字节经 readBodyCapped 逐块回报，客户端轮询渲染）。
   * @param {object} job newImportJob(kind='install') 创建的任务；目标集从 job.wanted 实时读取
   *   （installStart 的并入合并发生在下载期间，执行到安装选择时才能看到最新集合）
   * @param {string} key 'owner/repo'，必须在目录内（确认来源）
   */
  async function runInstall(job, key) {
    const [owner, repo] = key.split('/')
    try {
      const prev = cache.items[key]
      const branch = prev?.meta?.defaultBranch || 'main'
      // 同仓库前一个安装任务还在收尾（解包/落盘）时等待：tarball 此时已进缓存，
      // 本任务稍候即秒级完成，避免 423 报错（附着/合并已在 installStart 里分流）
      const waitStart = Date.now()
      while (inflight.has(key) && Date.now() - waitStart < 120_000) {
        await new Promise((r) => setTimeout(r, 300))
      }
      if (inflight.has(key)) throw Object.assign(new Error('install already running'), { status: 423 })
      inflight.set(key, Date.now())
      const tmpRoot = safeJoin(stateDir, `tmp-install-${randomUUID().slice(0, 8)}`)
      sessionTmpDirs.add(tmpRoot)
      try {
        job.phase = 'downloading'
        const gz = await downloadTarballOnce(owner, repo, `refs/heads/${branch}`, null, (bytes) => { job.bytes = bytes })
        job.phase = 'extracting'
        const files = extractTarGz(gz)
        const skills = discoverSkillsFromTar(files, repo)
        if (skills.length === 0) throw Object.assign(new Error('no SKILL.md found in repository'), { status: 422 })
        const wanted = job.wanted
        const selected = wanted === null ? skills.slice(0, MAX_INSTALL_SKILLS) : skills.filter((s) => wanted.includes(s.name))
        if (selected.length === 0) throw Object.assign(new Error('no matching skill'), { status: 404 })
        job.phase = 'installing'
        job.skillTotal = selected.length
        const installed = []
        const skipped = []
        for (const skill of selected) {
          job.currentSkill = skill.name
          const staging = stageSkillFiles(files, skill, tmpRoot)
          if (!staging) { skipped.push(skill.name); job.skillDone++; continue }
          // 落盘：目录名 == frontmatter name（Harness 规范），safeJoin 做包含校验
          const dest = safeJoin(skillsHome, skill.name)
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
          renameSync(staging, dest)
          ledger[skill.name] = { owner, repo, installedAt: new Date().toISOString(), dirName: skill.name }
          installed.push(skill.name)
          job.skillDone++
        }
        writeJsonAtomic(ledgerFile, ledger)
        job.installed = installed
        job.skipped = skipped
        job.total = skills.length
        job.sourceUrl = `https://github.com/${key}`
        job.phase = 'done'
        job.finishedAt = Date.now()
      } finally {
        inflight.delete(key)
        try { if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
        sessionTmpDirs.delete(tmpRoot)
      }
    } catch (e) {
      jobFail(job, e)
    }
  }

  /** 发起集市安装（0.10.0）：立即返回 { jobId, alreadyRunning }，进度经 /import/status 轮询。
   *  同仓库安装任务仍在下载中提交 → 把新目标并入该任务（union）后附着同一 jobId，
   *  一次下载装齐两张卡片；已进入解包/安装阶段则另起新任务（tarball 已进缓存，等待后秒装）。 */
  function installStart(key, wanted = null) {
    if (!REPO_REF_PATTERN.test(key || '')) throw Object.assign(new Error('bad repo ref'), { status: 400 })
    const inCatalog = catalogList().some((r) => `${r.owner}/${r.repo}` === key)
    if (!inCatalog) throw Object.assign(new Error('source not in catalog'), { status: 404 })
    for (const j of importJobs.values()) {
      if (j.kind !== 'install' || j.key !== key || j.finishedAt) continue
      if ((j.phase === 'starting' || j.phase === 'downloading') && wanted && wanted.length > 0) {
        if (Array.isArray(j.wanted)) j.wanted = [...new Set([...j.wanted, ...wanted])]
        // j.wanted === null（装全部）已覆盖任意新目标，无需合并
      }
      return { jobId: j.id, alreadyRunning: true }
    }
    const job = newImportJob(key, '', 'install')
    job.wanted = Array.isArray(wanted) && wanted.length > 0 ? [...wanted] : null
    runInstall(job, key)
    return { jobId: job.id, alreadyRunning: false }
  }

  /** 卸载：按技能名定位目录（安装名通常 == 目录名；外部手动放入的可能不同，
   *  此时回退到已装清单按 name 匹配目录名）。仅允许删除 skillsHome 下、含 SKILL.md 的技能目录。 */
  function uninstall(name) {
    if (!NAME_PATTERN.test(name || '')) throw new Error('bad skill name')
    let dir = safeJoin(skillsHome, name)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      const hit = installedList().find((s) => s.name === name)
      if (hit) dir = safeJoin(skillsHome, hit.dirName)
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw Object.assign(new Error('skill not found'), { status: 404 })
    if (!existsSync(join(dir, 'SKILL.md'))) throw Object.assign(new Error('not a skill directory (no SKILL.md)'), { status: 422 })
    rmSync(dir, { recursive: true, force: true })
    const dirBase = basename(dir)
    if (ledger[name] || ledger[dirBase]) {
      delete ledger[name]
      delete ledger[dirBase]
      writeJsonAtomic(ledgerFile, ledger)
    }
    return { uninstalled: name }
  }

  /** 目录管理：新增 / 移除用户仓库（内置精选不可移除）。 */
  function addRepo(key, category) {
    if (!REPO_REF_PATTERN.test(key || '')) throw new Error('expected owner/repo')
    const cat = CATEGORIES.includes(category) ? category : '自选'
    const [owner, repo] = key.split('/')
    if (SEED_REPOS.some((r) => r.owner === owner && r.repo === repo)) throw Object.assign(new Error('already in built-in catalog'), { status: 409 })
    if (userRepos.some((r) => r.owner === owner && r.repo === repo)) throw Object.assign(new Error('already added'), { status: 409 })
    userRepos.push({ owner, repo, note: '', category: cat })
    writeJsonAtomic(catalogFile, userRepos)
    return catalogList().map((r) => ({ key: `${r.owner}/${r.repo}`, category: r.category || '自选', userAdded: r.userAdded === true }))
  }

  function removeRepo(key) {
    const [owner, repo] = String(key || '').split('/')
    const before = userRepos.length
    userRepos = userRepos.filter((r) => !(r.owner === owner && r.repo === repo))
    if (userRepos.length === before) throw Object.assign(new Error('not a user-added repo'), { status: 404 })
    writeJsonAtomic(catalogFile, userRepos)
    return catalogList().map((r) => ({ key: `${r.owner}/${r.repo}`, category: r.category || '自选', userAdded: r.userAdded === true }))
  }

  /* ----- 添加新技能（0.8.0）：本地创建与 URL 导入 ----- */

  /** 技能正文上限：SKILL.md 是纯文本指令文件，64KB 已远超常见规模。 */
  const MAX_SKILL_MD_BYTES = 64 * 1024
  /** URL 导入的内容上限（单文件 raw 文本）。 */
  const MAX_IMPORT_BYTES = 512 * 1024

  /** 本地创建：生成规范 SKILL.md（目录名 == frontmatter name）落盘到 skillsHome。 */
  function createSkill({ name, description, content }) {
    if (!NAME_PATTERN.test(name || '')) {
      throw Object.assign(new Error('bad skill name: start with a letter/digit, then only A-Za-z0-9._-, max 64'), { status: 400 })
    }
    const desc = String(description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
    if (!desc) throw Object.assign(new Error('description required (1-200 chars)'), { status: 400 })
    const text = String(content || '').slice(0, MAX_SKILL_MD_BYTES)
    const dest = safeJoin(skillsHome, name)
    if (existsSync(dest)) throw Object.assign(new Error(`skill already exists: ${name}`), { status: 409 })
    // 简介写进双引号 YAML 字符串：转义反斜杠与双引号，避免破坏 frontmatter
    const descYaml = desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'SKILL.md'), `---\nname: ${name}\ndescription: "${descYaml}"\n---\n\n${text}\n`, 'utf8')
    ledger[name] = { kind: 'local', installedAt: new Date().toISOString() }
    writeJsonAtomic(ledgerFile, ledger)
    return { created: name }
  }

  /* ----- 导入任务（0.9.0）：POST /import 立即返回 jobId，客户端轮询 /import/status。
   *  大仓库导入耗时以分钟计，同步响应既拿不到进度、超时还会误导用户重试
   *  （重试触发 inflight 423 "install already running"）。任务制下：
   *  同仓库任务进行中再次提交 = 直接附着返回同一 jobId（不重复下载、不报错）。 ----- */

  const importJobs = new Map()
  /** 阶段机：starting → downloading → extracting → installing → done | error
   *  kind：import=URL 导入（0.9.0）/ install=集市卡片安装（0.10.0），共用同一任务池与轮询端点。 */
  function newImportJob(key, url, kind = 'import') {
    const job = {
      id: randomUUID().slice(0, 8), key, url, kind, phase: 'starting',
      bytes: 0, skillDone: 0, skillTotal: 0, currentSkill: '',
      installed: [], skipped: [], total: 0, sourceUrl: '',
      error: '', startedAt: Date.now(), finishedAt: 0,
    }
    importJobs.set(job.id, job)
    // 只保留最近 30 个已完成任务（进行中不清理）
    const done = [...importJobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt)
    while (done.length > 30) importJobs.delete(done.shift().id)
    return job
  }
  const jobView = (j) => ({
    id: j.id, kind: j.kind, key: j.key, phase: j.phase, bytes: j.bytes,
    skillDone: j.skillDone, skillTotal: j.skillTotal, currentSkill: j.currentSkill,
    installed: j.installed, skipped: j.skipped, total: j.total, sourceUrl: j.sourceUrl,
    error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt,
  })
  const jobFail = (j, e) => {
    j.phase = 'error'
    j.error = String(e.message || e)
    j.finishedAt = Date.now()
  }

  const stripGitSuffix = (s) => String(s || '').replace(/\.git$/i, '')

  /** 解析导入 URL 形态：仓库链接（含 .git/尾斜杠）→ repo；tree 深链 → repo+分支+子目录；
   *  blob 页 SKILL.md 链接（自动转 raw，分支名单段乐观解析）与 raw/gist 直链 → file；
   *  其余 host 必须直指 SKILL.md。skipDns 只对 GITHUB_TEXT_HOSTS 白名单生效。 */
  async function parseImportTarget(rawUrl) {
    const u = await assertSafeUrl(String(rawUrl || ''), { skipDns: true })
    if (u.hostname === 'github.com') {
      const segs = u.pathname.split('/').filter(Boolean)
      if (segs.length === 2) return { kind: 'repo', owner: stripGitSuffix(segs[0]), repo: stripGitSuffix(segs[1]), branch: '', subdir: '' }
      if (segs.length >= 4 && segs[2] === 'tree') {
        return { kind: 'repo', owner: segs[0], repo: segs[1], branch: segs[3], subdir: segs.slice(4).join('/') }
      }
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
      if (!m || !m[4].endsWith('SKILL.md')) {
        throw Object.assign(new Error('unsupported github.com URL: use a repo link (github.com/owner/repo), a tree link, or a blob link to a SKILL.md file'), { status: 400 })
      }
      const raw = await assertSafeUrl(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`, { skipDns: true })
      return { kind: 'file', url: raw.href }
    }
    if (u.pathname !== '/SKILL.md' && !u.pathname.endsWith('/SKILL.md')) {
      throw Object.assign(new Error('URL must point at a SKILL.md file, or use a github.com repo link'), { status: 400 })
    }
    return { kind: 'file', url: u.href }
  }

  /** 整仓导入执行器（后台任务）：解析仓库 tarball，安装其中发现的全部技能。
   *  tree 深链只装该目录下的技能；ref 未知时按 HEAD → main → master 尝试
   *  （codeload 支持 HEAD 引用，实测 gh-proxy 可用，无需知道默认分支名）。
   *  同名技能冲突：同源（同一仓库）覆盖更新，异源/手动放入跳过不覆盖。
   *  纯仓库导入走 tarball 缓存（同仓库重复导入秒级）；tree 深链不写缓存
   *  （ref 可能非默认分支，缓存键不含 ref，宁可重下保正确）。 */
  async function runImportRepo(job, owner, repo, { branch = '', subdir = '' } = {}) {
    const key = `${owner}/${repo}`
    try {
      if (!REPO_REF_PATTERN.test(key)) throw Object.assign(new Error('bad repo ref'), { status: 400 })
      job.phase = 'downloading'
      const refs = branch ? [`refs/heads/${branch}`, 'HEAD'] : ['HEAD', 'refs/heads/main', 'refs/heads/master']
      const onBytes = (bytes) => { job.bytes = bytes }
      const gz = branch
        ? await downloadTarballAnyRef(owner, repo, refs, MAX_IMPORT_TARBALL_BYTES, onBytes)
        : await downloadTarballOnce(owner, repo, 'HEAD', MAX_IMPORT_TARBALL_BYTES, onBytes)
      job.phase = 'extracting'
      const files = extractTarGz(gz)
      const skills = discoverSkillsFromTar(files, repo)
      if (skills.length === 0) {
        // 区分「真没有」与「有但在隐藏目录被安全规则跳过」，让用户能自助判断
        const hiddenHits = files.filter((f) => /skill\.md$/i.test(f.path) && hiddenSegment(f.path)).length
        throw Object.assign(new Error(hiddenHits > 0
          ? `no installable SKILL.md: found ${hiddenHits} SKILL.md file(s) only inside hidden directories (e.g. .agents/skills/, .claude/skills/) — hidden paths are skipped by policy; this repo does not ship user-installable skills`
          : 'no SKILL.md found in repository'), { status: 422 })
      }
      let selected = skills
      if (subdir) {
        const norm = subdir.replace(/\/+$/, '')
        selected = skills.filter((s) => s.dir === norm || s.dir.startsWith(`${norm}/`))
        if (selected.length === 0) throw Object.assign(new Error(`no skills found under ${subdir}`), { status: 404 })
      }
      job.phase = 'installing'
      job.skillTotal = Math.min(selected.length, MAX_INSTALL_SKILLS)
      const installed = []
      const skipped = []
      const tmpRoot = safeJoin(stateDir, `tmp-import-${randomUUID().slice(0, 8)}`)
      sessionTmpDirs.add(tmpRoot)
      try {
        for (const skill of selected.slice(0, MAX_INSTALL_SKILLS)) {
          job.currentSkill = skill.name
          const dest = safeJoin(skillsHome, skill.name)
          if (existsSync(dest)) {
            const led = ledger[skill.name]
            if (!(led && led.owner === owner && led.repo === repo)) { skipped.push(skill.name); job.skillDone++; continue }
          }
          const staging = stageSkillFiles(files, skill, tmpRoot)
          if (!staging) { skipped.push(skill.name); job.skillDone++; continue }
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
          renameSync(staging, dest)
          ledger[skill.name] = { owner, repo, installedAt: new Date().toISOString(), dirName: skill.name }
          installed.push(skill.name)
          job.skillDone++
        }
      } finally {
        try { if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
        sessionTmpDirs.delete(tmpRoot)
      }
      if (installed.length > 0) writeJsonAtomic(ledgerFile, ledger)
      job.installed = installed
      job.skipped = skipped
      job.total = skills.length
      job.sourceUrl = `https://github.com/${key}`
      job.phase = 'done'
      job.finishedAt = Date.now()
    } catch (e) {
      jobFail(job, e)
    }
  }

  /** 单文件导入执行器（后台任务）：下载单个 SKILL.md 文本并安装。 */
  async function runImportFile(job, url) {
    try {
      job.phase = 'downloading'
      const u = new URL(url)
      const isGithubRaw = u.hostname === 'raw.githubusercontent.com' || u.hostname === 'gist.githubusercontent.com'
      const candidates = isGithubRaw ? routes('code') : [null]
      let lastErr = null
      let text = ''
      for (const proxy of candidates) {
        try {
          const res = await safeFetch(proxy === null ? u.href : `${proxy}/${u.href}`, {
            headers: { 'user-agent': USER_AGENT, accept: 'text/plain, text/markdown, q=0.9, */*; q=0.1' },
            signal: AbortSignal.timeout(20_000),
            skipDnsVerify: true,
          })
          if (!res.ok) { lastErr = new Error(`fetch ${res.status}`); continue }
          const buf = Buffer.from(await res.arrayBuffer())
          job.bytes = buf.length
          if (buf.length === 0 || buf.length > MAX_IMPORT_BYTES) {
            throw Object.assign(new Error(`content out of range (1B-${MAX_IMPORT_BYTES}B)`), { status: 413 })
          }
          const candidate = buf.toString('utf8')
          // 代理错误页常伪装 200：非 frontmatter 文本按线路失败换下一条
          if (!candidate.startsWith('---')) { lastErr = new Error('not a SKILL.md (missing YAML frontmatter)'); continue }
          text = candidate
          break
        } catch (e) {
          if (e.status) throw e
          lastErr = e
        }
      }
      if (!text) throw Object.assign(new Error(String(lastErr?.message || 'download failed')), { status: 502 })
      job.phase = 'installing'
      const meta = parseSkillMd(text)
      if (!NAME_PATTERN.test(meta.name || '')) {
        throw Object.assign(new Error('invalid SKILL.md: frontmatter name missing or invalid'), { status: 422 })
      }
      const dest = safeJoin(skillsHome, meta.name)
      if (existsSync(dest)) throw Object.assign(new Error(`skill already exists: ${meta.name}`), { status: 409 })
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), text, 'utf8')
      ledger[meta.name] = { kind: 'url', url: u.href, installedAt: new Date().toISOString() }
      writeJsonAtomic(ledgerFile, ledger)
      job.installed = [meta.name]
      job.total = 1
      job.sourceUrl = u.href
      job.phase = 'done'
      job.finishedAt = Date.now()
    } catch (e) {
      jobFail(job, e)
    }
  }

  /** 发起导入：立即返回 { jobId }；同仓库导入任务进行中 → 附着返回（alreadyRunning）。
   *  附着只认同类任务（kind=import），不与集市安装任务互附——两者的 wanted 目标集不同。 */
  async function importStart(rawUrl) {
    const target = await parseImportTarget(rawUrl)
    if (target.kind === 'repo') {
      const key = `${target.owner}/${target.repo}`
      for (const j of importJobs.values()) {
        if (j.kind === 'import' && j.key === key && !j.finishedAt) return { jobId: j.id, alreadyRunning: true }
      }
      const job = newImportJob(key, String(rawUrl || '').trim())
      runImportRepo(job, target.owner, target.repo, { branch: target.branch, subdir: target.subdir })
      return { jobId: job.id, alreadyRunning: false }
    }
    const job = newImportJob(target.url, target.url)
    runImportFile(job, target.url)
    return { jobId: job.id, alreadyRunning: false }
  }

  function importJobGet(id) {
    const j = importJobs.get(String(id || ''))
    return j ? jobView(j) : null
  }

  /** 宿主 dispose 时调用：清理本次会话遗留临时目录。 */
  function dispose() {
    for (const dir of sessionTmpDirs) {
      try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    sessionTmpDirs.clear()
  }

  /** 缓存体量（tarball / 技能元数据），供设置页展示。 */
  function cacheStats() {
    const out = { tarballCount: 0, tarballBytes: 0, metaCount: 0 }
    try {
      for (const f of readdirSync(tarballDir)) {
        try {
          const st = statSync(join(tarballDir, f))
          if (st.isFile()) { out.tarballCount++; out.tarballBytes += st.size }
        } catch {}
      }
    } catch {}
    try {
      for (const f of readdirSync(metaDir)) {
        try { if (statSync(join(metaDir, f)).isFile()) out.metaCount++ } catch {}
      }
    } catch {}
    return out
  }

  /** 清理缓存：删除 tarball 与技能元数据（保留安装台账/目录/偏好）。 */
  function clearCaches() {
    let removed = 0
    for (const dir of [tarballDir, metaDir]) {
      try {
        for (const f of readdirSync(dir)) {
          try { rmSync(join(dir, f), { recursive: true, force: true }); removed++ } catch {}
        }
      } catch {}
    }
    return { removed, ...cacheStats() }
  }

  return { refresh, statePayload, installStart, uninstall, addRepo, removeRepo, skillMeta, createSkill, importStart, importJobGet, getPrefs, setPrefs, cacheStats, clearCaches, dispose, log }
}

/* --------------------------------------------------------------------------
 * HTTP API（挂在宿主 webServer 上，同源 JSON）
 * ------------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid json body')) }
    })
    req.on('error', reject)
  })
}

/**
 * 轻量同源校验：浏览器同源 POST 的 Origin 与 Host 一致；
 * 原生协议（如 dsh-app://）与无 Origin 的调用放行，其余跨站拒绝。
 */
function sameOriginOk(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true // 宿主原生协议
    const host = req.headers.host
    return !host || u.host === host
  } catch {
    return true
  }
}

function registerRoutes(webServer, market, log) {
  const base = '/skill-market'
  const disposers = []
  // 注意：宿主 webServer 的路由只按 path 匹配（无方法维度），
  // 同一 path 的 GET/POST 必须合并为一条路由、在 handler 内分发。
  const route = (method, suffix, handler) => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${base}${suffix}`,
      handler: async (req, res) => {
        try {
          if (method !== 'ANY' && req.method !== method) { sendJson(res, 405, { error: 'method not allowed' }); return }
          if (req.method === 'POST' && !sameOriginOk(req)) { sendJson(res, 403, { error: 'cross-origin rejected' }); return }
          await handler(req, res)
        } catch (e) {
          const status = e.status || 500
          if (status >= 500) log(`error on ${suffix}: ${e.message}`)
          if (!res.headersSent) sendJson(res, status, { error: String(e.message || e) })
        }
      },
    }))
  }

  route('GET', '/api/v1/state', async (req, res) => {
    sendJson(res, 200, market.statePayload())
  })

  route('POST', '/api/v1/refresh', async (req, res) => {
    const r = await market.refresh(true)
    const payload = market.statePayload()
    payload.partial = r.partial === true
    payload.statsDegraded = r.degraded > 0
    sendJson(res, 200, payload)
  })

  route('POST', '/api/v1/install', async (req, res) => {
    const body = await readBody(req)
    const { owner, repo, skills } = body || {}
    if (typeof owner !== 'string' || typeof repo !== 'string') { sendJson(res, 400, { error: 'owner and repo required' }); return }
    const wanted = Array.isArray(skills) ? skills.filter((s) => typeof s === 'string' && NAME_PATTERN.test(s)) : null
    // 0.10.0 任务化：立即返回 { jobId, alreadyRunning }，进度经 /import/status 轮询
    // （与 URL 导入共用任务池；同仓库下载中提交会并入目标集附着同一任务）
    sendJson(res, 200, market.installStart(`${owner}/${repo}`, wanted))
  })

  route('POST', '/api/v1/uninstall', async (req, res) => {
    const body = await readBody(req)
    if (typeof body?.name !== 'string') { sendJson(res, 400, { error: 'name required' }); return }
    sendJson(res, 200, market.uninstall(body.name))
  })

  route('POST', '/api/v1/skills', async (req, res) => {
    const body = await readBody(req)
    if (typeof body?.key !== 'string') { sendJson(res, 400, { error: 'key required' }); return }
    const skills = await market.skillMeta(body.key.trim())
    sendJson(res, 200, { key: body.key.trim(), skills })
  })

  route('ANY', '/api/v1/prefs', async (req, res) => {
    if (req.method === 'GET') { sendJson(res, 200, market.getPrefs()); return }
    if (req.method === 'POST') { const body = await readBody(req); sendJson(res, 200, market.setPrefs(body || {})); return }
    sendJson(res, 405, { error: 'method not allowed' })
  })

  route('GET', '/api/v1/cache', async (req, res) => {
    sendJson(res, 200, market.cacheStats())
  })

  route('POST', '/api/v1/cache/clear', async (req, res) => {
    sendJson(res, 200, market.clearCaches())
  })

  route('POST', '/api/v1/catalog', async (req, res) => {
    const body = await readBody(req)
    if (typeof body?.add === 'string') { sendJson(res, 200, { catalog: market.addRepo(body.add.trim(), typeof body.category === 'string' ? body.category : '自选') }); return }
    if (typeof body?.remove === 'string') { sendJson(res, 200, { catalog: market.removeRepo(body.remove.trim()) }); return }
    sendJson(res, 400, { error: 'add or remove required' })
  })

  route('POST', '/api/v1/create', async (req, res) => {
    const body = await readBody(req)
    sendJson(res, 200, market.createSkill({
      name: typeof body?.name === 'string' ? body.name.trim() : '',
      description: typeof body?.description === 'string' ? body.description : '',
      content: typeof body?.content === 'string' ? body.content : '',
    }))
  })

  route('POST', '/api/v1/import', async (req, res) => {
    const body = await readBody(req)
    if (typeof body?.url !== 'string' || !body.url.trim()) { sendJson(res, 400, { error: 'url required' }); return }
    // 立即返回 jobId（同仓库任务进行中会附着返回 alreadyRunning），进度经 /import/status 轮询
    sendJson(res, 200, await market.importStart(body.url.trim()))
  })

  route('POST', '/api/v1/import/status', async (req, res) => {
    const body = await readBody(req)
    const job = market.importJobGet(body?.job)
    if (!job) { sendJson(res, 404, { error: 'job not found' }); return }
    sendJson(res, 200, job)
  })

  return () => disposers.forEach((d) => { try { d && d() } catch {} })
}

/* --------------------------------------------------------------------------
 * Cordis 入口
 * ------------------------------------------------------------------------ */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ token?: string, githubToken?: string, downloadProxy?: string, skillsHome?: string, ttlMinutes?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const log = (...args) => {
    if (ctx.logger?.warn) ctx.logger.warn('[skill-market]', ...args)
    else console.warn('[skill-market]', ...args)
  }
  const token = config.githubToken || config.token || process.env.DSH_SKILL_MARKET_TOKEN || process.env.GITHUB_TOKEN || ''
  const market = createMarket({
    stateDir: join(homedir(), '.dsh', 'skill-market'),
    skillsHome: config.skillsHome || join(homedir(), '.dsh', 'skills'),
    token,
    downloadProxy: config.downloadProxy || process.env.DSH_SKILL_MARKET_PROXY || '',
    ttlMinutes: config.ttlMinutes,
    log,
  })
  try {
    ctx.inject(['webServer'], (host) => {
      const webServer = host?.webServer || ctx.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        log('webServer service unavailable — skill-market disabled')
        return
      }
      host.effect(() => {
        const disposeRoutes = registerRoutes(webServer, market, log)
        return () => {
          disposeRoutes()
          market.dispose()
        }
      })
    })
  } catch (e) {
    log(`failed to mount: ${e.message}`)
  }
}

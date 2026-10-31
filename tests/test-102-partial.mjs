/**
 * 1.0.2 局部优化离线验证（不依赖网络、不触碰真实 ~/.dsh/skills）：
 *   A. 解压炸弹防护：600MB 全零 gzip（压缩后 <1MB）→ gunzip 限长拒收，
 *      任务落 error 且进程存活、不落盘（原实现 gunzipSync 无上限会试图分配全量）
 *   B. installStart 附着语义：仅下载前/下载中附着同一 jobId；任务结束后再装是新任务
 *   C. 识别事件持久化：首次启动 recognized=N 且 prefs 落盘 lastRecognized；
 *      第二次 createMarket（模拟宿主多次 apply）recognized=0 但 lastRecognized 仍可读
 *   D. skillsHome 的 "~" 展开：~/xxx 落到真实用户主目录（用完即清理）
 *   E. 私有 host 拦截回归：127.0.0.1 的 SKILL.md 直链仍被 SSRF 门拒收（skipDns 重构不破防）
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createMarket } from '../lib/index.js'

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`)
  if (!cond) failed++
}

const enc = new TextEncoder()
function slowEndlessStream() {
  let timer = null
  return new ReadableStream({
    start(c) { timer = setInterval(() => { try { c.enqueue(enc.encode('x'.repeat(1024))) } catch { /* 已关闭 */ } }, 50) },
    cancel() { if (timer) clearInterval(timer) },
  })
}

/* A. 解压炸弹防护 */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102-bomb-'))
  const market = createMarket({
    stateDir: join(root, 'state'), skillsHome: join(root, 'skills'), log: () => {},
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => gzipSync(Buffer.alloc(600 * 1024 * 1024)) }),
  })
  market.addRepo('zztest/bomb', '自选')
  const r = market.installStart('zztest/bomb', null)
  let j = market.importJobGet(r.jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 30000) {
    await new Promise((res) => setTimeout(res, 100))
    j = market.importJobGet(r.jobId)
  }
  check('A 任务快速落 error（≤30s，非 OOM 崩溃）', j.phase === 'error', JSON.stringify({ phase: j.phase, error: j.error }))
  check('A 错因为解压超限（maxOutputLength 生效）', /exceeds \d+ MB limit/.test(j.error || ''), j.error)
  check('A 未落盘任何技能', readdirSync(join(root, 'skills')).length === 0)
  market.dispose()
  rmSync(root, { recursive: true, force: true })
}

/* B. installStart 附着语义 */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102-attach-'))
  const market = createMarket({
    stateDir: join(root, 'state'), skillsHome: join(root, 'skills'), log: () => {},
    fetchImpl: async () => ({ ok: true, body: slowEndlessStream() }),
  })
  market.addRepo('zztest/slowrepo', '自选')
  const r1 = market.installStart('zztest/slowrepo', ['skill-a'])
  let j = market.importJobGet(r1.jobId)
  const t0 = Date.now()
  while (j.phase !== 'downloading' && Date.now() - t0 < 5000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r1.jobId)
  }
  check('B 首次安装进入下载中', j.phase === 'downloading')
  const r2 = market.installStart('zztest/slowrepo', ['skill-b'])
  check('B 下载中提交附着同一任务（alreadyRunning）', r2.alreadyRunning === true && r2.jobId === r1.jobId,
    JSON.stringify({ r1: r1.jobId, r2: r2.jobId, running: r2.alreadyRunning }))
  const r3 = market.installStart('zztest/slowrepo', null)
  check('B 装全部请求同样附着（不另起下载）', r3.alreadyRunning === true && r3.jobId === r1.jobId)
  market.importCancel(r1.jobId)
  const t1 = Date.now()
  while (!j.finishedAt && Date.now() - t1 < 3000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r1.jobId)
  }
  check('B 取消后任务落 error(cancelled)', j.phase === 'error' && j.reason === 'cancelled')
  const r4 = market.installStart('zztest/slowrepo', ['skill-c'])
  check('B 已结束任务不再附着，另起新任务', r4.alreadyRunning === false && r4.jobId !== r1.jobId)
  market.importCancel(r4.jobId)
  market.dispose()
  rmSync(root, { recursive: true, force: true })
}

/* C. 识别事件持久化 */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102-adopt-'))
  const stateDir = join(root, 'state')
  const skillsHome = join(root, 'skills')
  const SKILL = (n) => `---\nname: ${n}\ndescription: "adopt persistence test"\n---\n\n# ${n}\n`
  for (const n of ['adopt-one', 'adopt-two']) {
    mkdirSync(join(skillsHome, n), { recursive: true })
    writeFileSync(join(skillsHome, n, 'SKILL.md'), SKILL(n))
  }
  const m1 = createMarket({ stateDir, skillsHome, log: () => {} })
  const s1 = m1.statePayload()
  check('C 首次启动 recognized=2', s1.recognized === 2, String(s1.recognized))
  check('C /state 带出 lastRecognized(count=2)', s1.lastRecognized && s1.lastRecognized.count === 2, JSON.stringify(s1.lastRecognized))
  const onDisk = JSON.parse(readFileSync(join(stateDir, 'prefs.json'), 'utf8'))
  check('C prefs.json 已持久化识别事件', Number.isFinite(onDisk.lastRecognized?.at) && onDisk.lastRecognized.count === 2, JSON.stringify(onDisk))
  m1.dispose()
  const m2 = createMarket({ stateDir, skillsHome, log: () => {} })
  const s2 = m2.statePayload()
  check('C 第二次 apply recognized=0（幂等）', s2.recognized === 0)
  check('C 第二次 apply 仍可读 lastRecognized', s2.lastRecognized && s2.lastRecognized.count === 2)
  m2.dispose()
  rmSync(root, { recursive: true, force: true })
}

/* D. skillsHome 的 ~ 展开（用完即清理，不触碰真实技能目录） */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102-tilde-'))
  const marker = `skm102-tilde-${Date.now()}`
  const market = createMarket({ stateDir: join(root, 'state'), skillsHome: `~/${marker}`, log: () => {} })
  check('D "~/xxx" 展开到用户主目录', existsSync(join(homedir(), marker)))
  market.dispose()
  rmSync(join(homedir(), marker), { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

/* E. 私有 host 拦截回归（skipDns 重构不破防） */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102-ssrf-'))
  let fetched = false
  const market = createMarket({
    stateDir: join(root, 'state'), skillsHome: join(root, 'skills'), log: () => {},
    fetchImpl: async () => { fetched = true; return { ok: true, arrayBuffer: async () => Buffer.alloc(0) } },
  })
  const r = await market.importStart('http://127.0.0.1:9/SKILL.md')
  let j = market.importJobGet(r.jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 3000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r.jobId)
  }
  check('E 127.0.0.1 直链被拒（落 error 且未发起请求；reason 为空系既有行为，fetch 门在 parse 层抛普通 Error）',
    j.phase === 'error' && fetched === false && /blocked host/i.test(j.error || ''),
    JSON.stringify({ phase: j.phase, reason: j.reason, error: j.error, fetched }))
  market.dispose()
  rmSync(root, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

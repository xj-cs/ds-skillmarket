/**
 * 1.2.0 优化项离线端到端测试（不依赖网络、不触碰真实 ~/.dsh）：
 *   F. 坏缓存恢复：缓存位置的半截/垃圾文件 → 命中校验失败 → 删除重下 → 安装成功
 *   G. 集市安装异源保护：同名技能来自其他来源 → skipped；同源 → 覆盖更新
 *   H. pruneCaches：过期 tarball 与 tmp 残留在构造时被回收
 *   I. 取消语义：importCancel 对进行中任务生效、对已完成任务无效
 *
 * 注：原文件在 2026-10-25 20:28 目录清除事故中丢失，本版由留存会话内容重建
 *（断言与原版一致，fetchImpl 匹配写法归一化）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { createMarket } from '../lib/index.js'

function tarHeader(path, size) {
  const h = Buffer.alloc(512)
  h.write(path.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136)
  h.write('        ', 148)
  h.write('0', 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

function tarGz(entries) {
  const chunks = []
  for (const [path, content] of entries) {
    const data = Buffer.from(content, 'utf8')
    chunks.push(tarHeader(path, data.length), data)
    const pad = 512 - (data.length % 512)
    if (pad < 512) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

const SKILL = (name) => `---
name: ${name}
description: "1.2.0 offline test skill ${name}"
---

# ${name}
`

const root = mkdtempSync(join(tmpdir(), 'skm12x-'))
const stateDir = join(root, 'state')
const skillsHome = join(root, 'skills')

/** F/G 共用：按 owner/repo 伺服对应 tarball（体积过 1KB 反伪装门槛）。 */
const repos = {
  'zztest/corrupt': tarGz([['skills/good-one/SKILL.md', SKILL('good-one')], ['assets/pad.bin', randomBytes(6144).toString('base64')]]),
  'zztest/mktrepo': tarGz([['skills/mkt-skill/SKILL.md', SKILL('mkt-skill')], ['skills/mkt-skill2/SKILL.md', SKILL('mkt-skill2')], ['assets/pad.bin', randomBytes(6144).toString('base64')]]),
}
const serve = (url) => {
  const hit = Object.keys(repos).find((k) => String(url).includes(k))
  if (hit) return { ok: true, arrayBuffer: async () => repos[hit] }
  return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) }
}
const market = createMarket({ stateDir, skillsHome, log: () => {}, fetchImpl: serve })

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`)
  if (!cond) failed++
}
const runJob = async (url) => {
  const { jobId } = await market.importStart(url)
  let j = market.importJobGet(jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 50))
    j = market.importJobGet(jobId)
  }
  return j
}
const brief = (j) => JSON.stringify({ phase: j.phase, reason: j.reason, installed: j.installed, skipped: j.skipped, error: j.error })

/* F. 坏缓存恢复 */
{
  const dir = join(stateDir, 'tarballs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'zztest__corrupt.tgz'), Buffer.from('this is not a gzip payload at all, just garbage bytes to trip the magic check'))
  const j = await runJob('https://github.com/zztest/corrupt')
  check('F 坏缓存被删除并重新下载 → done', j.phase === 'done', brief(j))
  check('F 装上 good-one', JSON.stringify(j.installed) === JSON.stringify(['good-one']), brief(j))
  check('F 缓存已替换为有效 gzip', readFileSync(join(dir, 'zztest__corrupt.tgz'))[0] === 0x1f)
}

/* G. 集市安装异源保护（先放异源同名技能 + 台账，再走 installStart） */
{
  market.addRepo('zztest/mktrepo', '自选')
  // 异源预置：mkt-skill 来自 other/otherrepo；同源预置：mkt-skill2 已来自 zztest/mktrepo
  mkdirSync(join(skillsHome, 'mkt-skill'), { recursive: true })
  writeFileSync(join(skillsHome, 'mkt-skill', 'SKILL.md'), SKILL('mkt-skill'))
  mkdirSync(join(skillsHome, 'mkt-skill2'), { recursive: true })
  writeFileSync(join(skillsHome, 'mkt-skill2', 'SKILL.md'), SKILL('mkt-skill2'))
  writeFileSync(join(stateDir, 'installed.json'), JSON.stringify({
    'mkt-skill': { owner: 'other', repo: 'otherrepo', installedAt: '2026-10-25T00:00:00.000Z' },
    'mkt-skill2': { owner: 'zztest', repo: 'mktrepo', installedAt: '2026-10-25T00:00:00.000Z' },
  }))
  // addRepo 之后 createMarket 早已构造完，ledger 只在构造时读盘——这里直接重建一个市场实例读新台账
  market.dispose()
  const market2 = createMarket({ stateDir, skillsHome, log: () => {}, fetchImpl: serve })
  const r = market2.installStart('zztest/mktrepo', ['mkt-skill', 'mkt-skill2'])
  let j = market2.importJobGet(r.jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 10_000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market2.importJobGet(r.jobId)
  }
  check('G phase=done', j.phase === 'done', brief(j))
  check('G 异源 mkt-skill 被跳过', JSON.stringify(j.skipped) === JSON.stringify(['mkt-skill']), brief(j))
  check('G 同源 mkt-skill2 被覆盖安装', JSON.stringify(j.installed) === JSON.stringify(['mkt-skill2']), brief(j))
  check('G 异源技能内容未被改动', readFileSync(join(skillsHome, 'mkt-skill', 'SKILL.md'), 'utf8') === SKILL('mkt-skill'))

  /* H. pruneCaches：过期 tarball / tmp 残留在构造时回收 */
  const dir = join(stateDir, 'tarballs')
  const expired = join(dir, 'zztest__expired.tgz')
  writeFileSync(expired, Buffer.from('x'))
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(expired, old, old)
  writeFileSync(join(dir, 'zztest__fresh.tgz.tmp-123-456'), Buffer.from('partial'))
  market2.dispose()
  const market3 = createMarket({ stateDir, skillsHome, log: () => {}, fetchImpl: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }) })
  check('H 过期 tarball 被回收', !existsSync(expired))
  check('H tmp 残留被回收', !existsSync(join(dir, 'zztest__fresh.tgz.tmp-123-456')))
  check('H 新鲜缓存保留', existsSync(join(dir, 'zztest__corrupt.tgz')))

  /* I. 取消语义 */
  const hangMarket = createMarket({ stateDir: join(root, 'state2'), skillsHome: join(root, 'skills2'), log: () => {}, fetchImpl: () => new Promise(() => {}) })
  const { jobId } = await hangMarket.importStart('https://github.com/zztest/hangs')
  const c1 = hangMarket.importCancel(jobId)
  check('I 进行中任务可取消', c1.cancelled === true)
  const c2 = hangMarket.importCancel('nonexistent')
  check('I 不存在的任务返回 cancelled:false', c2.cancelled === false)
  hangMarket.dispose()
  market3.dispose()
}

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

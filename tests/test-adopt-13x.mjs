/**
 * 1.3.0 既有技能识别离线端到端测试（不依赖网络、不触碰真实 ~/.dsh）：
 *   A. 启动识别：插件安装前已在 skillsHome 的技能（无台账）→ adopt 回填台账，
 *      statePayload().recognized 计数正确；来源映射不串（url/created/adopted-local）
 *   B. 幂等：第二次启动不再识别（recognized=0）
 *   C. 运行期识别：新放入的技能在插件重启后被识别
 *   D. dirName 匹配数据：name≠目录名的技能两键都可达（客户端集合匹配的数据基础）
 *   E. 识别不破坏集市安装的异源跳过保护：adopt 记录无 owner/repo → 同名安装仍 skipped
 *   F. 卸载清理：adopted 技能卸载后目录与台账一并移除
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
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

const SKILL = (name, desc = '') => `---
name: ${name}
description: "${desc || `1.3.0 adopt test skill ${name}`}"
---

# ${name}
`

const root = mkdtempSync(join(tmpdir(), 'skm13x-'))
const stateDir = join(root, 'state')
const skillsHome = join(root, 'skills')
const put = (dir, text, mtime) => {
  mkdirSync(join(skillsHome, dir), { recursive: true })
  writeFileSync(join(skillsHome, dir, 'SKILL.md'), text, 'utf8')
  if (mtime) utimesSync(join(skillsHome, dir, 'SKILL.md'), mtime, mtime)
}

/* 预置用户既有现场：3 个无台账的既有技能 + 2 个有台账的（url 导入 / 本插件创建）+ 3 个应被忽略的目录 */
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
put('alpha', SKILL('alpha'), threeDaysAgo)                       // 正常既有技能，SKILL.md mtime 3 天前
put('beta-dir', SKILL('beta'))                                   // 目录名 ≠ frontmatter name
put('gamma', '# no frontmatter at all\n\njust markdown\n')       // 无 frontmatter → name 回退目录名
put('delta', SKILL('delta'))                                     // 有 url 台账 → 不 adopt
put('zeta', SKILL('zeta'))                                       // 有 created 台账 → 不 adopt
put('_under', SKILL('under'))                                    // _ 开头 → 扫描跳过
mkdirSync(join(skillsHome, '.hiddendir'), { recursive: true })
writeFileSync(join(skillsHome, '.hiddendir', 'SKILL.md'), SKILL('hidden'))
mkdirSync(join(skillsHome, 'empty-dir'), { recursive: true })    // 无 SKILL.md → 跳过

/* 预写台账（createMarket 构造时读盘） */
mkdirSync(stateDir, { recursive: true })
writeFileSync(join(stateDir, 'installed.json'), JSON.stringify({
  delta: { kind: 'url', url: 'https://example.com/delta/SKILL.md', installedAt: '2026-10-20T00:00:00.000Z' },
  zeta: { kind: 'local', installedAt: '2026-10-21T00:00:00.000Z' },
}, null, 2))

const noNet = () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`)
  if (!cond) failed++
}
const brief = (j) => JSON.stringify({ phase: j.phase, installed: j.installed, skipped: j.skipped, error: j.error })

/* A. 启动识别 */
const market1 = createMarket({ stateDir, skillsHome, log: () => {}, fetchImpl: noNet })
{
  const s = market1.statePayload()
  check('A recognized = 3（alpha/beta-dir/gamma）', s.recognized === 3, `got ${s.recognized}`)
  const byDir = new Map((s.installed || []).map((i) => [i.dirName, i]))
  check('A 已装清单共 5 条（忽略 _/. /无 SKILL.md）', (s.installed || []).length === 5, JSON.stringify([...byDir.keys()]))
  const alpha = byDir.get('alpha')
  check('A alpha: sourceKind=local（不是 created）', alpha && alpha.sourceKind === 'local', JSON.stringify(alpha))
  check('A alpha: installedAt 取 SKILL.md mtime（3 天前）', alpha && alpha.installedAt.startsWith(threeDaysAgo.toISOString().slice(0, 10)), alpha && alpha.installedAt)
  const beta = byDir.get('beta-dir')
  check('A beta: name=beta dirName=beta-dir', beta && beta.name === 'beta' && beta.dirName === 'beta-dir', JSON.stringify(beta))
  const gamma = byDir.get('gamma')
  check('A gamma: 无 frontmatter 回退目录名', gamma && gamma.name === 'gamma' && gamma.sourceKind === 'local', JSON.stringify(gamma))
  const delta = byDir.get('delta')
  check('A delta: url 台账不受影响', delta && delta.sourceKind === 'url' && delta.sourceUrl === 'https://example.com/delta/SKILL.md', JSON.stringify(delta))
  const zeta = byDir.get('zeta')
  check('A zeta: 旧 created 台账仍显示本插件创建', zeta && zeta.sourceKind === 'created', JSON.stringify(zeta))
  const led = JSON.parse(readFileSync(join(stateDir, 'installed.json'), 'utf8'))
  check('A alpha 台账已回填 adopted:true', led.alpha && led.alpha.adopted === true, JSON.stringify(led.alpha))
  check('A delta 台账未被改写', led.delta && led.delta.kind === 'url' && !led.delta.adopted, JSON.stringify(led.delta))
  check('A hidden/empty/下划线 不入清单', !byDir.has('empty-dir') && !byDir.has('_under') && !byDir.has('.hiddendir'))
}

/* B. 幂等 */
market1.dispose()
const market2 = createMarket({ stateDir, skillsHome, log: () => {}, fetchImpl: noNet })
check('B 二次启动 recognized = 0', market2.statePayload().recognized === 0, `got ${market2.statePayload().recognized}`)

/* C. 运行期识别（插件运行期间新放入 → 重启后识别） */
put('epsilon', SKILL('epsilon'))
market2.dispose()
const market3 = createMarket({ stateDir, skillsHome, log: () => {}, fetchImpl: noNet })
{
  const s = market3.statePayload()
  check('C 新放入的 epsilon 被识别', s.recognized === 1, `got ${s.recognized}`)
  check('C epsilon 出现在已装清单', (s.installed || []).some((i) => i.dirName === 'epsilon' && i.sourceKind === 'local'))
}

/* E. 识别不破坏异源跳过保护：与 adopted 同名的集市技能安装仍被跳过 */
{
  const dir = join(stateDir, 'tarballs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'zztest__adoptrepo.tgz'), tarGz([
    ['skills/alpha/SKILL.md', SKILL('alpha', 'market version that must NOT overwrite the adopted skill')],
    ['assets/pad.bin', 'x'.repeat(6144)],
  ]))
  market3.addRepo('zztest/adoptrepo', '自选')
  const r = market3.installStart('zztest/adoptrepo', ['alpha'])
  let j = market3.importJobGet(r.jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 10_000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market3.importJobGet(r.jobId)
  }
  check('E phase=done', j.phase === 'done', brief(j))
  check('E 同名 adopted 技能被跳过（不被集市覆盖）', JSON.stringify(j.skipped) === JSON.stringify(['alpha']) && j.installed.length === 0, brief(j))
  check('E alpha 内容未被改动', readFileSync(join(skillsHome, 'alpha', 'SKILL.md'), 'utf8') === SKILL('alpha'))
}

/* D. dirName 匹配数据基础：客户端集合 {name, dirName} 双键均可命中 */
{
  const s = market3.statePayload()
  const beta = (s.installed || []).find((i) => i.dirName === 'beta-dir')
  check('D beta 的 name 与 dirName 双键齐备（卡片按任一键判已装）', beta && beta.name === 'beta' && beta.dirName === 'beta-dir')
}

/* F. 卸载清理 */
{
  market3.uninstall('beta') // 按 name 定位 → 回退 installedList 找到 dirName=beta-dir
  check('F beta 目录已删除', !existsSync(join(skillsHome, 'beta-dir')))
  const led = JSON.parse(readFileSync(join(stateDir, 'installed.json'), 'utf8'))
  check('F beta 台账记录已移除', !led.beta && !led['beta-dir'], JSON.stringify(Object.keys(led)))
  const names = market3.statePayload().installed.map((i) => i.name)
  check('F 已装清单不再含 beta', !names.includes('beta'), JSON.stringify(names))
}

market3.dispose()
rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

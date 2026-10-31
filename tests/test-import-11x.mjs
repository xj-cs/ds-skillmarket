/**
 * 1.1.0 URL 导入链路离线端到端测试（不依赖网络、不触碰真实 ~/.dsh）：
 *   A. node_modules 仓库 → reason=no-skills-node-modules（detail=命中数），无落盘
 *   B. 隐藏目录整仓导入：.agents/skills 与 .claude/skills 中的技能都装上，
 *      技能目录内的隐藏附属文件完整安装（1.1.0 完整检索口径）
 *   C. 真无技能仓库 → reason=no-skills
 *   D. 坏链接（blob 指向 README）→ 立即返回 jobId，任务 reason=bad-url
 *   E. tree 深链子目录过滤：只装该目录下技能；子目录外的技能（含隐藏目录）不装
 *   F. 导入与既有技能（adopted，无 owner/repo）同名 → skipped 异源保护，内容不覆盖
 *   G. raw 单文件导入 → 安装成功，台账 kind=url
 *
 * 注：原文件在 2026-10-25 20:28 目录清除事故中丢失，本版按 HANDOFF 记载的
 * 断言行为重写（覆盖同一行为面）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
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

const SKILL = (name, desc = '') => `---
name: ${name}
description: "${desc || `1.1.0 offline import test skill ${name}`}"
---

# ${name}
`

const root = mkdtempSync(join(tmpdir(), 'skm11x-'))
const stateDir = join(root, 'state')
const skillsHome = join(root, 'skills')
mkdirSync(stateDir, { recursive: true })

/** F 预置：手动放入的 alpha（无台账 → createMarket 启动识别回填 adopted，无 owner/repo）。 */
mkdirSync(join(skillsHome, 'alpha'), { recursive: true })
writeFileSync(join(skillsHome, 'alpha', 'SKILL.md'), SKILL('alpha', 'manually placed, must not be overwritten by import'))

const repos = {
  // A: SKILL.md 只存在于 node_modules（第三方依赖自带，不算仓库发布的技能）
  'zznm/pkg': tarGz([
    ['node_modules/leftpad/SKILL.md', SKILL('leftpad')],
    ['assets/pad.bin', randomBytes(6144).toString('base64')],
  ]),
  // B: 技能只在隐藏约定位置 + 隐藏附属文件
  'zzhidden/hid': tarGz([
    ['.agents/skills/release/SKILL.md', SKILL('release', 'hidden convention location skill')],
    ['.agents/skills/release/.assets/note.txt', 'hidden auxiliary file must be installed too'],
    ['.claude/skills/toolkit/SKILL.md', SKILL('toolkit')],
    ['assets/pad.bin', randomBytes(6144).toString('base64')],
  ]),
  // C: 真无技能（只有 README 与资源）
  'zzempty/void': tarGz([
    ['README.md', '# no skills here\n'],
    ['assets/pad.bin', randomBytes(6144).toString('base64')],
  ]),
  // E: tree 深链子目录过滤（子目录外含普通与隐藏技能）
  'zzsub/deep': tarGz([
    ['other/gamma/SKILL.md', SKILL('gamma', 'inside the linked subdirectory')],
    ['top/alpha2/SKILL.md', SKILL('alpha2', 'outside the subdirectory')],
    ['.agents/skills/hideaway/SKILL.md', SKILL('hideaway', 'hidden convention location outside the subdirectory')],
    ['assets/pad.bin', randomBytes(6144).toString('base64')],
  ]),
  // F: 与手动放入的 alpha 同名（异源保护）
  'zzadopt/prot': tarGz([
    ['skills/alpha/SKILL.md', SKILL('alpha', 'market version that must NOT overwrite the adopted skill')],
    ['assets/pad.bin', randomBytes(6144).toString('base64')],
  ]),
}
const RAW_SKILL = SKILL('single-file', 'imported from a raw URL')
const serve = (url) => {
  const hit = Object.keys(repos).find((k) => String(url).includes(k))
  if (hit) return { ok: true, arrayBuffer: async () => repos[hit] }
  if (String(url).includes('zzraw/files')) return { ok: true, arrayBuffer: async () => Buffer.from(RAW_SKILL, 'utf8') }
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
const brief = (j) => JSON.stringify({ phase: j.phase, reason: j.reason, detail: j.detail, installed: j.installed, skipped: j.skipped, error: j.error })
const names = () => readdirSync(skillsHome)

/* A. node_modules 仓库 */
{
  const j = await runJob('https://github.com/zznm/pkg')
  check('A phase=error reason=no-skills-node-modules', j.phase === 'error' && j.reason === 'no-skills-node-modules', brief(j))
  check('A detail=1（命中 1 个 node_modules 内 SKILL.md）', j.detail === '1', brief(j))
  check('A 无技能落盘', !existsSync(join(skillsHome, 'leftpad')), JSON.stringify(names()))
}

/* B. 隐藏目录整仓导入（完整检索口径） */
{
  const j = await runJob('https://github.com/zzhidden/hid')
  check('B phase=done', j.phase === 'done', brief(j))
  check('B 隐藏目录技能都装上（release + toolkit）', JSON.stringify(j.installed) === JSON.stringify(['release', 'toolkit']), brief(j))
  check('B 隐藏附属文件完整安装', existsSync(join(skillsHome, 'release', '.assets', 'note.txt'))
    && readFileSync(join(skillsHome, 'release', '.assets', 'note.txt'), 'utf8').includes('hidden auxiliary'))
  check('B 落盘目录干净（alpha=F 用例预置夹具）', names().sort().join(',') === 'alpha,release,toolkit', JSON.stringify(names()))
}

/* C. 真无技能 */
{
  const j = await runJob('https://github.com/zzempty/void')
  check('C phase=error reason=no-skills', j.phase === 'error' && j.reason === 'no-skills', brief(j))
  check('C 错误文案提及全量检索', /every file was searched/i.test(j.error))
}

/* D. 坏链接：blob 指向 README（非 SKILL.md） */
{
  const r = await market.importStart('https://github.com/zznm/pkg/blob/main/README.md')
  check('D 立即返回 jobId（不再同步 400）', typeof r.jobId === 'string')
  let j = market.importJobGet(r.jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 5_000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r.jobId)
  }
  check('D 任务化失败 reason=bad-url', j.phase === 'error' && j.reason === 'bad-url', brief(j))
}

/* E. tree 深链子目录过滤 */
{
  const j = await runJob('https://github.com/zzsub/deep/tree/main/other')
  check('E phase=done 只装子目录内技能', j.phase === 'done' && JSON.stringify(j.installed) === JSON.stringify(['gamma']), brief(j))
  check('E 子目录外的普通/隐藏技能未装', !existsSync(join(skillsHome, 'alpha2')) && !existsSync(join(skillsHome, 'hideaway')), JSON.stringify(names()))
  check('E gamma 内容正确落盘', existsSync(join(skillsHome, 'gamma', 'SKILL.md')))
}

/* F. 导入与 adopted 既有技能同名 → 异源跳过保护 */
{
  const j = await runJob('https://github.com/zzadopt/prot')
  check('F phase=done 同名 adopted 技能被跳过', j.phase === 'done' && JSON.stringify(j.skipped) === JSON.stringify(['alpha']) && j.installed.length === 0, brief(j))
  check('F alpha 内容未被改动', readFileSync(join(skillsHome, 'alpha', 'SKILL.md'), 'utf8') === SKILL('alpha', 'manually placed, must not be overwritten by import'))
}

/* G. raw 单文件导入 */
{
  const j = await runJob('https://raw.githubusercontent.com/zzraw/files/main/SKILL.md')
  check('G phase=done 装上 single-file', j.phase === 'done' && JSON.stringify(j.installed) === JSON.stringify(['single-file']), brief(j))
  const s = market.statePayload().installed.find((i) => i.name === 'single-file')
  check('G 台账来源=URL 导入', s && s.sourceKind === 'url', JSON.stringify(s))
}

market.dispose()
rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

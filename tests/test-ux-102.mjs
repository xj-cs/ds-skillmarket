/**
 * 1.0.2 体验包离线测试（不依赖网络、不触碰真实 ~/.dsh）：
 *   A. jobView.wantedCount：集市安装任务的目标技能数随附着/并入/升级变化，
 *      取消合并任务时客户端据此提示涉及面
 *   B. skillFile：按 name 读 SKILL.md 正文；目录名≠name 的外部技能经已装清单回退可读；
 *      未知技能 404；超过 256K 字符截断（truncated 标记）
 *   C. uninstall 回归：skillDirOf 重构后卸载行为不变（目录与台账一并清理）
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/* A. jobView.wantedCount */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102b-wanted-'))
  const market = createMarket({
    stateDir: join(root, 'state'), skillsHome: join(root, 'skills'), log: () => {},
    fetchImpl: async () => ({ ok: true, body: slowEndlessStream() }),
  })
  market.addRepo('zztest/slowrepo', '自选')
  const r1 = market.installStart('zztest/slowrepo', ['skill-a'])
  let j = market.importJobGet(r1.jobId)
  check('A 单目标任务的 wantedCount=1', j.wantedCount === 1, JSON.stringify({ wantedCount: j.wantedCount }))
  market.installStart('zztest/slowrepo', ['skill-b'])
  j = market.importJobGet(r1.jobId)
  check('A 附着并入后 wantedCount=2', j.wantedCount === 2, JSON.stringify({ wantedCount: j.wantedCount }))
  market.installStart('zztest/slowrepo', null)
  j = market.importJobGet(r1.jobId)
  check('A 装全部请求升级后 wantedCount=null', j.wantedCount === null, JSON.stringify({ wantedCount: j.wantedCount }))
  market.importCancel(r1.jobId)
  const t0 = Date.now()
  while (!j.finishedAt && Date.now() - t0 < 3000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r1.jobId)
  }
  check('A 取消后视图仍带 wantedCount', j.phase === 'error' && j.reason === 'cancelled' && j.wantedCount === null)
  market.dispose()
  rmSync(root, { recursive: true, force: true })
}

/* B+C. skillFile 与卸载回归 */
{
  const root = mkdtempSync(join(tmpdir(), 'skm102b-file-'))
  const stateDir = join(root, 'state')
  const skillsHome = join(root, 'skills')
  mkdirSync(join(skillsHome, 'plain'), { recursive: true })
  writeFileSync(join(skillsHome, 'plain', 'SKILL.md'), '---\nname: plain\ndescription: "plain skill"\n---\n\n# plain\n')
  // 目录名 ≠ frontmatter name 的外部技能（卸载/查看都靠已装清单回退定位）
  mkdirSync(join(skillsHome, 'xdir'), { recursive: true })
  writeFileSync(join(skillsHome, 'xdir', 'SKILL.md'), '---\nname: x-name\ndescription: "dirName mismatch"\n---\n\n# x-name\n')
  // 超长文件（> 256K 字符）验证截断
  mkdirSync(join(skillsHome, 'bigskill'), { recursive: true })
  writeFileSync(join(skillsHome, 'bigskill', 'SKILL.md'), `---\nname: bigskill\ndescription: "big"\n---\n\n${'x'.repeat(300 * 1024)}`)

  const market = createMarket({ stateDir, skillsHome, log: () => {} })
  const f1 = market.skillFile('plain')
  check('B skillFile 返回正文与目录', f1.content.includes('# plain') && f1.dir.endsWith('plain') && f1.truncated === false, JSON.stringify(f1).slice(0, 120))
  const f2 = market.skillFile('x-name')
  check('B 目录名≠name 经已装清单回退可读', f2.content.includes('dirName mismatch') && f2.dir.endsWith('xdir'), JSON.stringify(f2).slice(0, 120))
  const f3 = market.skillFile('bigskill')
  check('B 超长正文截断（truncated=true，长度=上限）', f3.truncated === true && f3.content.length === 256 * 1024, `len=${f3.content.length} truncated=${f3.truncated}`)
  let threw404 = false
  try { market.skillFile('ghost-skill') } catch (e) { threw404 = e.status === 404 }
  check('B 未知技能抛 404', threw404)

  // C. 卸载回归（skillDirOf 重构后）
  market.uninstall('x-name')
  check('C 卸载 name≠目录名技能删除正确目录', !existsSync(join(skillsHome, 'xdir')) && existsSync(join(skillsHome, 'plain')))
  market.uninstall('plain')
  check('C 卸载普通技能目录移除', !existsSync(join(skillsHome, 'plain')))
  check('C 台账同步清理（已装清单不再含 plain）', !market.statePayload().installed.some((s) => s.name === 'plain'))
  market.dispose()
  rmSync(root, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

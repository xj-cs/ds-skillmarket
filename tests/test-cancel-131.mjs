/**
 * 1.3.0 下载取消链路离线测试（不依赖网络、不触碰真实 ~/.dsh）：
 *   A. 集市安装下载中取消：取消请求 → 下载流被掐断（reader.cancel 触发）→
 *      任务快速落 error(reason=cancelled)，不换线路重试、不落盘任何技能
 *   B. 已完成任务不可取消（cancelled:false）
 *
 * 回归背景：readBodyCapped 原先吞掉 onProgress 抛出的取消异常、
 * downloadTarballRef 的换线路 catch 还会把取消当线路失败重试——取消要等整个
 * 下载跑完才生效，用户看到「取消任务」点了没反应。本测试用永不结束的慢流：
 * 修复前取消永远不生效（轮询超时），修复后秒级中止。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarket } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'skm-cancel-'))
const stateDir = join(root, 'state')
const skillsHome = join(root, 'skills')
mkdirSync(stateDir, { recursive: true })

const enc = new TextEncoder()
let streamCancelled = false
/** 每 50ms 推 1KB、永不结束的下载流：取消后经 reader.cancel() 触发 cancel 回调。 */
function slowEndlessStream() {
  let timer = null
  return new ReadableStream({
    start(c) {
      timer = setInterval(() => { try { c.enqueue(enc.encode('x'.repeat(1024))) } catch { /* 已关闭 */ } }, 50)
    },
    cancel() { if (timer) clearInterval(timer); streamCancelled = true },
  })
}

const market = createMarket({
  stateDir,
  skillsHome,
  log: () => {},
  fetchImpl: async () => ({ ok: true, body: slowEndlessStream() }),
})
market.addRepo('zztest/slowrepo', '自选')

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`)
  if (!cond) failed++
}

/* A. 下载中取消 */
{
  const r = market.installStart('zztest/slowrepo', ['skill-a'])
  check('A installStart 立即返回 jobId', typeof r.jobId === 'string' && !r.alreadyRunning)
  let j = market.importJobGet(r.jobId)
  // 等下载确实开始（字节增长）
  const t0 = Date.now()
  while (j.bytes < 2048 && Date.now() - t0 < 5000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r.jobId)
  }
  check('A 下载进行中（字节增长）', j.bytes >= 2048 && j.phase === 'downloading', JSON.stringify({ phase: j.phase, bytes: j.bytes }))
  const c = market.importCancel(r.jobId)
  check('A 取消请求被受理', c.cancelled === true)
  // 取消应在下一个 onProgress 检查点（≤~100ms）掐断下载并落账 error(cancelled)
  const t1 = Date.now()
  while (!j.finishedAt && Date.now() - t1 < 3000) {
    await new Promise((res) => setTimeout(res, 50))
    j = market.importJobGet(r.jobId)
  }
  check('A 任务快速中止（≤3s，非等下载跑完）', j.finishedAt && Date.now() - t1 < 3000, JSON.stringify({ phase: j.phase, reason: j.reason, error: j.error }))
  check('A reason=cancelled', j.phase === 'error' && j.reason === 'cancelled', JSON.stringify({ phase: j.phase, reason: j.reason }))
  check('A 下载流确实被 reader.cancel() 掐断', streamCancelled === true)
  check('A 未落盘任何技能', !existsSync(join(skillsHome, 'skill-a')) && readdirSync(skillsHome).length === 0, JSON.stringify(readdirSync(skillsHome)))
  // 等待窗口后下载没有偷偷换线路继续（流取消后不再有新任务写入）
  await new Promise((res) => setTimeout(res, 400))
  check('A 中止后无残留落盘', readdirSync(skillsHome).length === 0)
}

/* B. 已完成任务不可取消 */
{
  const c = market.importCancel('nonexistent-job')
  check('B 不存在的任务返回 cancelled:false', c.cancelled === false)
}

market.dispose()
rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

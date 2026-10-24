/**
 * dsh-skill-market — browser half（web 平台客户端插件）。
 *
 * 信封与导出契约取自宿主运行时（与 dshmarket 的 client bundle 同构）：
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })
 *   factory 内通过 require('react') 取宿主提供的 React，
 *   返回 { name, inject, apply }；loader 以客户端 Cordis 上下文调用 apply。
 *
 * 主视图：扁平的技能方框网格（对标 dsh-market 的插件卡片）——
 * 每张卡片一个技能：名称 / 作者 / 版本号 / 许可 / DSH 兼容标识 /
 * 来源仓库星数与下载量 / 能力简介 / 安装与卸载。
 * 分类按技能的应用场景与能力自动归类（关键词规则 + 仓库先验）。
 * 技能详情由客户端按仓库渐进拉取（服务端整仓解析并缓存 7 天）。
 *
 * 挂载的界面入口（均为宿主真实插槽，先 slots.inject 再 slots.register）：
 *   - settings.section      设置侧边栏独立分区「Skill 集市」
 *   - settings.plugins.tab  设置 → 内置插件 里的页签
 *   - plugins.tab           新宿主插件页里的页签
 *   - main + sidebar.panellist  主界面侧边栏行（用户开关，默认关）
 *
 * 渲染：纯 React.createElement + 内联样式 + 内联 SVG，
 * 不引用任何外部库、CDN、字体、图片。数据经同源 /skill-market/api/v1/* 拉取。
 */

window.__ModuleLoader__.load({ id: 'dsh-skill-market', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports

  const react = require('react')
  const { createElement: h, useState, useEffect, useMemo, useCallback, useRef } = react

  /** 客户端 Cordis 插件名：与 cordis.patch.yml 的 insert id 一致。 */
  const name = 'skill-market'
  /** 依赖的客户端服务：插槽 / 多语言 / 主题。 */
  const inject = ['slots', 'locale', 'theme']

  const NS = 'skill-market'
  const PANEL_ID = 'skill-market'
  const API = '/skill-market/api/v1'

  /* ---------------- 多语言 ---------------- */

  const zh = {
    nav: 'Skill 集市',
    subtitle: '聚合 GitHub 热门 Agent Skills',
    refresh: '刷新',
    refreshing: '刷新中…',
    searchPlaceholder: '搜索技能、简介或仓库…',
    sortStars: '按星标排序',
    sortDownloads: '按下载量排序',
    sortUpdated: '按更新时间排序',
    sortName: '按名称排序',
    onlyNew: '只看未安装',
    stars: '星标',
    downloads: '下载量',
    noDownloads: '—',
    updated: '更新',
    install: '安装',
    installing: '安装中…',
    uninstall: '卸载',
    confirmUninstall: '确认卸载？',
    installRepoAll: '安装本仓库全部',
    author: '作者',
    version: '版本',
    license: '许可',
    dshCompat: 'DSH 兼容',
    dshCompatOk: '✓ 当前宿主',
    dshCompatTip: 'Skills 为 SKILL.md 目录规范，兼容支持技能目录（~/.dsh/skills）的 DSH 宿主；当前宿主已验证可用',
    repoLevel: '仓库',
    starsRepoTip: '星标数来自 GitHub API（stargazers_count）。GitHub 仅提供仓库级数据，同一仓库内的技能共享此数值；无目录级星标，故不伪造。',
    downloadsRepoTip: '下载量为 GitHub Release 资产累计 download_count（仓库级，来自 GitHub API 的真实数据）。',
    statsAt: '数据抓取于 {0}',
    source: '来源',
    staleTip: '当前为缓存数据（{0}），点击刷新获取最新。',
    partialTip: 'GitHub API 配额不足，本轮仅刷新了部分仓库，其余沿用缓存。',
    noTokenTip: 'GitHub 匿名直连限额 60 次/小时，本轮刷新可能不完整：可在插件配置填 githubToken，或设置 downloadProxy 加速前缀。',
    proxyRouteTip: '未配置 Token：GitHub 数据经加速线路（{0}）获取，不受匿名 60 次/小时限制。',
    statsStaleTip: '星标/下载量复核暂不可用（GitHub 接口受限），技能目录与安装不受影响，线路恢复后自动更新；配置 githubToken 可提升配额。',
    rateLeft: '剩余配额 {0}',
    addRepoPlaceholder: 'owner/repo 添加仓库…',
    add: '添加',
    remove: '移除',
    catAll: '全部',
    sidebarShow: '在主界面侧边栏显示',
    loadingSkills: '正在整理技能卡片（整仓下载解析，首次较慢，之后走缓存）…',
    skillsProgress: '技能详情 {0}/{1} 仓库 · 已收录 {2} 个技能',
    skillsFailedN: '{0} 个仓库拉取失败',
    retryFailed: '重试失败项',
    empty: '暂无数据，点击刷新从 GitHub 拉取。',
    emptyFiltered: '没有匹配的技能。',
    loading: '加载中…',
    loadError: '加载失败：{0}',
    retry: '重试',
    installedOk: '已安装：{0}',
    uninstalledOk: '已卸载：{0}',
    actionFailed: '操作失败：{0}',
    userAdded: '自选',
    noDesc: '（该技能未提供简介）',
    noVersion: '—',
    showMore: '显示更多（还有 {0} 个）',
    installedBadge: '已装 {0}/{1}',
    repoError: '该仓库拉取失败，显示缓存数据',
    dirNameTip: 'GitHub 目录名：{0}；安装后目录名（SKILL.md name）：{1}',
    repoPathTip: '该技能在仓库中的目录路径（与 GitHub 文件树一致）',
    /* --- 设置页（对齐 dsh-market 的设置卡片） --- */
    settingsSubtitle: '版本与网络设置。',
    openMarket: '打开集市',
    openMarketDesc: '在主界面侧边栏打开 Skill 集市面板（浏览、搜索、安装技能）。',
    sidebarEntry: '主界面侧边栏入口',
    sidebarEntryDesc: '在主界面侧边栏显示集市行；关闭后仍可从设置页一键打开。',
    region: '下载区域',
    regionDesc: '中国大陆：API 与下载优先走加速线路，git 引用广播直连优先；全球：全部直连优先，失败回退加速线路。切换后自动重新探测线路。',
    regionChina: '中国大陆',
    regionGlobal: '全球',
    githubAccel: 'GitHub 加速',
    githubAccelDesc: '自动选择可用线路（内置 gh-proxy.com / ghfast.top 回退，直连兜底，记住最后成功线路）；也可指定自定义前缀，置顶线路链。',
    currentRoutes: '当前线路 — API：{0} · Git：{1}',
    routeUnprobed: '未探测',
    proxyPlaceholder: '自定义加速前缀（https://…，留空 = 自动）',
    proxySave: '保存前缀',
    proxyClear: '清除',
    proxyManaged: '已由插件配置/环境变量锁定：{0}',
    proxySaved: '已保存自定义加速前缀：{0}',
    proxyCleared: '已恢复自动线路选择',
    tokenRow: 'GitHub Token',
    tokenDesc: '界面不保存凭据。可通过环境变量 DSH_SKILL_MARKET_TOKEN 或插件配置 githubToken 提供；配置后星标刷新走官方直连（5000 次/小时）。',
    tokenOn: '已配置',
    tokenOff: '未配置（可选；当前走多线路零配额刷新）',
    cacheRow: '本地缓存',
    cacheDesc: '仓库 tarball 与技能元数据；清理后首次安装/详情会重新下载，已安装技能不受影响。',
    cacheClear: '清理缓存',
    cacheClearConfirm: '确认清理？',
    cacheCleared: '已清理 {0} 项缓存',
    dirsRow: '数据目录',
    dirsDesc: '集市数据与技能安装位置。',
    /* --- 0.8.0 已安装视图与添加技能 --- */
    tabMarket: '集市',
    tabInstalled: '已安装',
    addSkill: '添加技能',
    addSkillDesc: '本地新建一个技能，或从 URL 导入 SKILL.md；创建/导入即刻落盘，宿主新会话后加载。',
    modeCreate: '新建',
    modeImport: 'URL 导入',
    skillName: '技能名（name）',
    skillNamePh: 'my-skill（字母/数字开头，可含 . _ -，≤64 字符）',
    skillNameDesc: '即安装目录名，需符合 DSH 技能命名规范（目录名 == frontmatter name）。',
    skillDesc: '一句话简介（必填）',
    skillDescPh: '这个技能做什么、什么时候触发（1-200 字）',
    skillBody: '正文（可选）',
    skillBodyPh: 'SKILL.md 正文（Markdown）：工作流程、注意事项、示例…',
    importUrl: 'GitHub 链接',
    importUrlPh: 'https://github.com/owner/repo（Clone 链接即可）、…/tree/分支/目录 或 SKILL.md 链接',
    importUrlDesc: '粘贴仓库地址即可导入：Clone 按钮的 HTTPS 链接（自动整仓下载并安装其中全部技能）、tree 深链（只装该目录下的技能）、blob 页 SKILL.md 链接（自动转 raw）或 raw 直链。GitHub 域自动走加速线路；整仓导入时同名技能若来自其他来源会被跳过，同源则覆盖更新。',
    createBtn: '创建技能',
    importBtn: '导入',
    cancel: '取消',
    createdOk: '已创建技能：{0}（宿主新会话后加载）',
    importedOk: '已导入：{0}（宿主新会话后加载）',
    importedSkip: '（跳过 {0} 个同名技能：来自其他来源，不覆盖）',
    /* --- 0.9.0 导入进度 --- */
    phaseDownload: '正在下载仓库…',
    dlInfo: '已下载 {0}',
    phaseExtract: '正在解析仓库内容…',
    phaseInstall: '正在安装技能 {0}/{1}',
    phaseInstallCurrent: '当前：{0}',
    progressCloseHint: '可关闭此对话框，导入会在后台继续；再次提交同一仓库会直接恢复进度显示，不会重复下载。',
    importErrorTitle: '导入失败',
    backToForm: '修改链接',
    retryImport: '重试导入',
    /* --- 0.10.0 卡片安装进度 --- */
    installFailed: '安装失败：{0}',
    cardDownloading: '下载中',
    cardExtracting: '解包中',
    cardInstalling: '安装中 {0}/{1}',
    installedTitle: '已安装技能',
    installedSub: '已安装技能扫描自宿主技能目录（集市安装 / 本插件创建与导入 / 手动放入均可识别），宿主新会话后加载：',
    installedEmpty: '还没有已安装的技能。去集市安装，或点「添加技能」新建/导入。',
    sourceKindRepo: '集市仓库',
    sourceKindUrl: 'URL 导入',
    sourceKindCreated: '本插件创建',
    sourceKindLocal: '手动放入',
    installedAtLabel: '安装于',
    searchInstalled: '搜索已安装技能…',
  }

  const en = {
    nav: 'Skill Market',
    subtitle: 'Aggregated hot agent skills from GitHub',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    searchPlaceholder: 'Search skills, descriptions or repos…',
    sortStars: 'Sort by stars',
    sortDownloads: 'Sort by downloads',
    sortUpdated: 'Sort by updated',
    sortName: 'Sort by name',
    onlyNew: 'Not installed only',
    stars: 'stars',
    downloads: 'downloads',
    noDownloads: '—',
    updated: 'updated',
    install: 'Install',
    installing: 'Installing…',
    uninstall: 'Uninstall',
    confirmUninstall: 'Confirm uninstall?',
    installRepoAll: 'Install all from repo',
    author: 'by',
    version: 'ver',
    license: 'license',
    dshCompat: 'DSH compat',
    dshCompatOk: '✓ current host',
    dshCompatTip: 'Skills follow the SKILL.md directory convention; compatible with DSH hosts that serve the skills directory (~/.dsh/skills). Verified on the current host.',
    repoLevel: 'repo',
    starsRepoTip: 'Stars come from the GitHub API (stargazers_count). GitHub only exposes repo-level counts, shared by every skill in the repo; no per-directory stars exist, so none are invented.',
    downloadsRepoTip: 'Downloads are cumulative GitHub Release asset download_count (repo-level, real data from the GitHub API).',
    statsAt: 'data fetched {0}',
    source: 'source',
    staleTip: 'Cached data ({0}). Click refresh for the latest.',
    partialTip: 'GitHub API quota low — only part of the catalog refreshed this round.',
    noTokenTip: 'Anonymous GitHub direct access is limited to 60 req/hour; this refresh may be partial. Set githubToken (or a downloadProxy prefix) in plugin config.',
    proxyRouteTip: 'No token configured: GitHub data flows through an accelerated route ({0}), unaffected by the 60 req/hour anonymous limit.',
    statsStaleTip: 'Star/download re-check is temporarily unavailable (GitHub API limited). The skill catalog and installs are unaffected; stats catch up once a route recovers. Configure githubToken for higher limits.',
    rateLeft: '{0} requests left',
    addRepoPlaceholder: 'owner/repo to add…',
    add: 'Add',
    remove: 'Remove',
    catAll: 'All',
    sidebarShow: 'Show in main sidebar',
    loadingSkills: 'Preparing skill cards (repo download & parse; slow the first time, cached afterwards)…',
    skillsProgress: 'skill details {0}/{1} repos · {2} skills indexed',
    skillsFailedN: '{0} repos failed',
    retryFailed: 'Retry failed',
    empty: 'No data yet — click refresh to fetch from GitHub.',
    emptyFiltered: 'No matching skills.',
    loading: 'Loading…',
    loadError: 'Failed to load: {0}',
    retry: 'Retry',
    installedOk: 'Installed: {0}',
    uninstalledOk: 'Uninstalled: {0}',
    actionFailed: 'Action failed: {0}',
    userAdded: 'picked',
    noDesc: '(no description provided)',
    noVersion: '—',
    showMore: 'Show more ({0} more)',
    installedBadge: '{0}/{1} installed',
    repoError: 'fetch failed for this repo, showing cache',
    dirNameTip: 'GitHub directory: {0}; installed as (SKILL.md name): {1}',
    repoPathTip: 'directory path of this skill inside the repo (same as the GitHub file tree)',
    /* --- Settings page (mirrors dsh-market's settings card) --- */
    settingsSubtitle: 'Version and network settings.',
    openMarket: 'Open market',
    openMarketDesc: 'Open the Skill Market panel in the main sidebar (browse, search, install).',
    sidebarEntry: 'Sidebar entry',
    sidebarEntryDesc: 'Show the market row in the main sidebar; when off, it can still be opened from here in one click.',
    region: 'Download region',
    regionDesc: 'China: API and downloads prefer accelerated routes, git refs go direct first. Global: direct first everywhere, falling back to accelerators. Switching re-probes routes.',
    regionChina: 'China',
    regionGlobal: 'Global',
    githubAccel: 'GitHub acceleration',
    githubAccelDesc: 'Routes are picked automatically (built-in gh-proxy.com / ghfast.top fallback, direct escape, last-good memory); a custom prefix heads the chain.',
    currentRoutes: 'Current routes — API: {0} · Git: {1}',
    routeUnprobed: 'not probed',
    proxyPlaceholder: 'Custom prefix (https://…, empty = automatic)',
    proxySave: 'Save prefix',
    proxyClear: 'Clear',
    proxyManaged: 'Locked by plugin config/environment: {0}',
    proxySaved: 'Custom prefix saved: {0}',
    proxyCleared: 'Back to automatic route selection',
    tokenRow: 'GitHub Token',
    tokenDesc: 'Credentials are never stored in this UI. Provide DSH_SKILL_MARKET_TOKEN (env) or githubToken (plugin config); with a token, star refresh goes direct (5000 req/hour).',
    tokenOn: 'Configured',
    tokenOff: 'Not configured (optional; multi-route quota-free refresh in effect)',
    cacheRow: 'Local cache',
    cacheDesc: 'Repo tarballs and skill metadata; cleared entries re-download on first use. Installed skills are unaffected.',
    cacheClear: 'Clear cache',
    cacheClearConfirm: 'Confirm clear?',
    cacheCleared: 'Cleared {0} cache entries',
    dirsRow: 'Data directories',
    dirsDesc: 'Market data and skill install locations.',
    /* --- 0.8.0 Installed view & add skill --- */
    tabMarket: 'Market',
    tabInstalled: 'Installed',
    addSkill: 'Add skill',
    addSkillDesc: 'Create a skill locally, or import a SKILL.md from a URL. Written to disk immediately; the host loads it in new sessions.',
    modeCreate: 'Create',
    modeImport: 'Import URL',
    skillName: 'Skill name (name)',
    skillNamePh: 'my-skill (letter/digit first, then . _ -, <=64 chars)',
    skillNameDesc: 'Also the install directory name; must follow the DSH naming rule (directory name == frontmatter name).',
    skillDesc: 'One-line description (required)',
    skillDescPh: 'What this skill does and when it should trigger (1-200 chars)',
    skillBody: 'Body (optional)',
    skillBodyPh: 'SKILL.md body (Markdown): workflow, notes, examples…',
    importUrl: 'GitHub URL',
    importUrlPh: 'https://github.com/owner/repo (Clone link), …/tree/branch/dir or a SKILL.md link',
    importUrlDesc: 'Paste a repo URL to import: the Clone button HTTPS link (the whole repo is downloaded and all its skills installed), a tree deep link (installs only skills under that directory), a blob-page SKILL.md link (auto-converted to raw) or a raw link. GitHub hosts go through accelerated routes; on whole-repo imports, same-name skills from other sources are skipped, same-source ones are updated in place.',
    createBtn: 'Create skill',
    importBtn: 'Import',
    cancel: 'Cancel',
    createdOk: 'Skill created: {0} (loaded in new host sessions)',
    importedOk: 'Imported: {0} (loaded in new host sessions)',
    importedSkip: ' ({0} same-name skills skipped: from other sources, not overwritten)',
    /* --- 0.9.0 import progress --- */
    phaseDownload: 'Downloading repository…',
    dlInfo: '{0} downloaded',
    phaseExtract: 'Parsing repository contents…',
    phaseInstall: 'Installing skill {0}/{1}',
    phaseInstallCurrent: 'current: {0}',
    progressCloseHint: 'You can close this dialog; the import continues in the background. Submitting the same repo again reattaches to the live progress without downloading twice.',
    importErrorTitle: 'Import failed',
    backToForm: 'Edit link',
    retryImport: 'Retry import',
    /* --- 0.10.0 card install progress --- */
    installFailed: 'Install failed: {0}',
    cardDownloading: 'Downloading',
    cardExtracting: 'Extracting',
    cardInstalling: 'Installing {0}/{1}',
    installedTitle: 'Installed skills',
    installedSub: 'Scanned from the host skills directory (market installs, creations, imports and manually placed skills all recognized; loaded in new sessions): ',
    installedEmpty: 'No installed skills yet. Install from the Market, or use "Add skill" to create/import one.',
    sourceKindRepo: 'market repo',
    sourceKindUrl: 'URL import',
    sourceKindCreated: 'created here',
    sourceKindLocal: 'manual',
    installedAtLabel: 'installed',
    searchInstalled: 'Search installed skills…',
  }

  /* ---------------- 场景分类（确定性关键词规则 + 仓库先验） ---------------- */

  const SKILL_CATEGORIES = ['编程开发', '科研分析', '设计创意', '文档写作', '营销增长', '效率协作', '其他']

  /** 关键词按类别分组（中英文，全部小写匹配 name+description）。 */
  const CATEGORY_KEYWORDS = [
    ['编程开发', ['code', 'coding', 'develop', 'debug', '重构', 'refactor', 'git', 'branch', 'merge', 'test', '测试', 'tdd', 'review', '编程', '程序', 'deploy', 'ci/cd', 'api', 'sdk', 'typescript', 'javascript', 'python', 'rust', '前端', '后端', 'agent', 'subagent', 'workflow', 'plan', 'planning', '架构', 'archit', 'terminal', 'shell', 'bash', 'sql', '数据库', 'compile', '构建']],
    ['科研分析', ['research', 'science', 'scientific', 'data', '分析', '统计', 'statis', 'literature', '文献', 'bio', 'chem', '医学', 'medicine', 'drug', 'genome', '基因', '蛋白', '实验', 'experiment', 'math', '数学', '物理', 'simulation', '仿真', 'flux', 'metabol', 'molecular', 'paper', '论文', 'citation', '引文']],
    ['设计创意', ['design', 'art', 'brand', '创意', 'creative', 'visual', '视觉', 'image', '图', 'ppt', 'slide', 'presentation', '演示', '海报', 'poster', 'video', '视频', '动画', 'anim', 'ui', 'ux', 'logo', '插画', 'draw', 'paint', '3d', 'cad', '建模', 'brand-guidelines', 'typography', '排版', '颜色', 'color']],
    ['文档写作', ['writ', '论文写', '文档', 'doc', 'polish', 'grammar', '语法', 'translat', '翻译', 'blog', 'essay', 'resume', '简历', 'email', '邮件', 'report', '报告', 'summar', '摘要', '总结', '写作', 'newsletter', 'copy for docs', 'response', '审稿', 'response letter']],
    ['营销增长', ['marketing', 'seo', 'copywrit', 'ads', '广告', 'growth', 'cro', '增长', '文案', 'social', '媒体', 'campaign', 'funnel', 'landing', 'conversion', '品牌', 'ecommerce', '电商']],
    ['效率协作', ['automat', '自动化', 'download', '下载', 'schedule', '定时', 'memory', '记忆', 'context', '上下文', 'search', '检索', 'manage', '管理', 'productivity', '效率', 'note', '笔记', 'todo', 'task', '任务', 'focus', '注意力', 'file', '文件', 'pdf', 'excel', 'sheet', '表格', 'ocr', 'clipboard', '会议', 'meeting', '日程']],
  ]

  /** 仓库分类 → 技能场景先验（技能自身关键词未命中时使用）。 */
  const REPO_PRIOR = { 开发: '编程开发', 科研: '科研分析', 营销: '营销增长', 记忆: '效率协作', 可视化: '设计创意', 效率: '效率协作' }

  function classifySkill(skillName, description, repoCategory) {
    const text = `${skillName} ${description || ''}`.toLowerCase()
    for (const [cat, words] of CATEGORY_KEYWORDS) {
      for (const w of words) {
        if (text.includes(w)) return cat
      }
    }
    return REPO_PRIOR[repoCategory] || '其他'
  }

  /** 同仓库卡片交错排列（轮转）：星标/作者是仓库级口径，同一仓库整块连排时
   *  连续多卡数据完全相同，首屏会被误读成“所有技能显示同一份信息”；
   *  轮转打散后每屏都能看到多个仓库，仓库先验顺序由传入的已排序序列决定。 */
  function interleaveByRepo(sorted) {
    const order = []
    const queues = new Map()
    for (const card of sorted) {
      if (!queues.has(card.repoKey)) { queues.set(card.repoKey, []); order.push(card.repoKey) }
      queues.get(card.repoKey).push(card)
    }
    const out = []
    while (out.length < sorted.length) {
      for (const k of order) {
        const q = queues.get(k)
        if (q.length) out.push(q.shift())
      }
    }
    return out
  }

  /* ---------------- 工具 ---------------- */

  function fill(text, ...args) {
    return String(text).replace(/\{(\d)\}/g, (m, i) => (args[Number(i)] ?? m))
  }

  function fmtNum(n) {
    if (n === null || n === undefined) return '—'
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
    return n.toLocaleString('en-US')
  }

  function fmtDate(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    return `${fmtDate(new Date(ms))} ${new Date(ms).toTimeString().slice(0, 5)}`
  }

  /** 字节数人性化（进度条用）。 */
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B'
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
    return `${n} B`
  }

  /** 速率人性化（下载进度用；≤0 返回空串，调用方决定是否展示）。 */
  function fmtSpeed(n) {
    if (!Number.isFinite(n) || n <= 0) return ''
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB/s` : `${Math.max(1, Math.round(n / 1024))} KB/s`
  }

  function palette(dark) {
    return dark ? {
      page: '#0d1117', card: '#161b22', border: '#30363d', text: '#e6edf3', sub: '#8b949e',
      accent: '#4493f8', accentText: '#ffffff', ok: '#3fb950', okBg: 'rgba(63,185,80,0.15)',
      warn: '#d29922', warnBg: 'rgba(210,153,34,0.12)', danger: '#f85149', dangerBg: 'rgba(248,81,73,0.12)',
      input: '#0d1117', chip: '#21262d', chipActive: '#1f6feb33',
    } : {
      page: '#f6f8fa', card: '#ffffff', border: '#d0d7de', text: '#1f2328', sub: '#57606a',
      accent: '#0969da', accentText: '#ffffff', ok: '#1a7f37', okBg: 'rgba(26,127,55,0.10)',
      warn: '#9a6700', warnBg: 'rgba(154,106,0,0.10)', danger: '#cf222e', dangerBg: 'rgba(207,34,46,0.08)',
      input: '#ffffff', chip: '#eaeef2', chipActive: '#0969da1a',
    }
  }

  /* ---------------- 内联 SVG 图标（无外部资源） ---------------- */

  function svg(props, d, fill_) {
    return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, ...props }, h('path', { fill: fill_, d }))
  }

  const iconStar = (c) => svg({ style: { verticalAlign: '-2px', marginRight: 3, flexShrink: 0 } },
    'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z', c.warn)
  const iconDownload = (c) => svg({ style: { verticalAlign: '-2px', marginRight: 3, flexShrink: 0 } },
    'M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z', c.sub)
  const iconExternal = (c) => svg({ width: 12, height: 12, style: { verticalAlign: '-1px', marginLeft: 4 } },
    'M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5A1.75 1.75 0 0 1 3.75 2Zm6.5-1h4a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0V3.56L8.53 8.28a.749.749 0 1 1-1.06-1.06l4.72-4.72h-1.69a.75.75 0 0 1 0-1.5Z', c.accent)
  const iconRefresh = (c, spin) => svg({ style: { verticalAlign: '-2px', animation: spin ? 'dsh-skm-spin 0.9s linear infinite' : undefined } },
    'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z', 'currentColor')
  const iconStore = (c, size) => svg({ width: size || 18, height: size || 18, style: { verticalAlign: '-4px' } },
    'M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H13.5v4.75a.75.75 0 0 1-1.5 0V4.5h-2.5v7.25a.75.75 0 0 1-1.5 0V4.5H5.5v4.75a.75.75 0 0 1-1.5 0V4.5H1.75A.75.75 0 0 1 1 3.75Zm.75 9.75A.75.75 0 0 0 1 13.25v.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75v-.5a.75.75 0 0 0-.75-.75Z', c.accent)

  /** 注入一次 keyframes（内联 style 标签，非外部资源）。 */
  let spinInjected = false
  function injectSpinStyle() {
    if (spinInjected || typeof document === 'undefined' || !document.head) return
    try {
      const style = document.createElement('style')
      style.textContent = '@keyframes dsh-skm-spin{to{transform:rotate(360deg)}}'
        + '@keyframes dsh-skm-indet{0%{transform:translateX(-110%)}100%{transform:translateX(370%)}}'
      document.head.appendChild(style)
      spinInjected = true
    } catch { /* 装饰性动画，失败可忽略 */ }
  }

  /* ---------------- 数据访问 ---------------- */

  async function apiGet(path) {
    const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  /* ---------------- 侧边栏开关（模块级控制器） ---------------- */

  const sidebarCtl = { set: () => {}, get: () => false }

  /* ---------------- 添加技能对话框（0.8.0）：本地新建 / URL 导入 ---------------- */

  function AddSkillDialog({ t, c, onClose, onDone }) {
    const [mode, setMode] = useState('create')
    const [name, setName] = useState('')
    const [desc, setDesc] = useState('')
    const [body, setBody] = useState('')
    const [url, setUrl] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    /** 导入任务（0.9.0）：jobId 非空 = 进度模式；job 为最近一次轮询的任务视图。 */
    const [jobId, setJobId] = useState(null)
    const [job, setJob] = useState(null)
    const [speed, setSpeed] = useState(0)
    const speedRef = useRef(0)

    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose() }
      try { window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) } catch { /* 无关紧要 */ }
    }, [onClose])

    /** 进度轮询：600ms 一次；下载中用指数滑动平均估算实时速率；done → onDone。 */
    useEffect(() => {
      if (!jobId) return
      let stopped = false
      let fails = 0
      let timer = null
      let prev = { bytes: 0, t: Date.now() }
      const tick = async () => {
        try {
          const j = await apiPost('/import/status', { job: jobId })
          if (stopped) return
          fails = 0
          setJob(j)
          if (j.phase === 'downloading') {
            const now = Date.now()
            const dt = (now - prev.t) / 1000
            if (dt >= 0.3) {
              const inst = Math.max(0, j.bytes - prev.bytes) / dt
              speedRef.current = speedRef.current > 0 ? speedRef.current * 0.6 + inst * 0.4 : inst
              prev = { bytes: j.bytes, t: now }
              setSpeed(speedRef.current)
            }
          }
          if (j.phase === 'done') { onDone({ imported: j.installed, skipped: j.skipped }); return }
          if (j.phase !== 'error') timer = setTimeout(tick, 600)
        } catch (e) {
          if (stopped) return
          fails += 1
          if (fails >= 6) { setError(fill(t('loadError'), String(e.message || e))); return }
          timer = setTimeout(tick, 1200)
        }
      }
      timer = setTimeout(tick, 250)
      return () => { stopped = true; if (timer) clearTimeout(timer) }
    }, [jobId, onDone, t])

    /** 回到表单（进度视图复位；后台任务不受影响，重提交可附着）。 */
    const backToForm = useCallback(() => {
      setJobId(null); setJob(null); setSpeed(0); speedRef.current = 0; setError('')
    }, [])
    const switchMode = useCallback((m) => { setMode(m); backToForm() }, [backToForm])

    const labelStyle = { fontSize: 12, fontWeight: 600, margin: '12px 0 3px' }
    const descStyle = { fontSize: 11.5, color: c.sub, margin: '0 0 5px', lineHeight: 1.5 }
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', borderRadius: 6, border: `1px solid ${c.border}`,
      background: c.input, color: c.text, fontSize: 12.5, padding: '6px 9px', outline: 'none',
    }
    const segBtn = (on_) => ({ border: 'none', cursor: 'pointer', fontSize: 12, padding: '5px 14px', background: on_ ? c.text : 'transparent', color: on_ ? c.page : c.sub })
    const btnCancel = { borderRadius: 6, border: `1px solid ${c.border}`, background: c.card, color: c.text, fontSize: 12, padding: '5px 12px', cursor: 'pointer' }
    const btnGo = { borderRadius: 6, border: `1px solid ${c.accent}`, background: c.accent, color: c.accentText, fontSize: 12, padding: '5px 14px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }

    const submit = useCallback(async () => {
      if (busy) return
      setBusy(true); setError('')
      try {
        if (mode === 'create') {
          const out = await apiPost('/create', { name, description: desc, content: body })
          onDone(out)
        } else {
          // 立即拿到 jobId 转进度模式；同仓库任务进行中服务端会附着返回
          const r = await apiPost('/import', { url })
          speedRef.current = 0; setSpeed(0)
          setJob(null)
          setJobId(r.jobId)
        }
      } catch (e) {
        setError(String(e.message || e))
      } finally {
        setBusy(false)
      }
    }, [busy, mode, name, desc, body, url, onDone])

    /* ----- 进度视图片段（0.9.0）：三阶段条 + 实时速率（fmtSpeed 已提升为模块级共享） ----- */
    const inProgress = mode === 'import' && jobId != null && (!job || (job.phase !== 'error' && job.phase !== 'done'))
    const pct = job && job.phase === 'installing' && job.skillTotal > 0 ? Math.round((job.skillDone / job.skillTotal) * 100) : null
    const phaseText = !job || job.phase === 'starting' || job.phase === 'downloading' ? t('phaseDownload')
      : job.phase === 'extracting' ? t('phaseExtract')
      : job.phase === 'installing' ? fill(t('phaseInstall'), job.skillDone, job.skillTotal)
      : job.phase === 'error' ? t('importErrorTitle') : t('phaseExtract')
    const barInner = pct !== null
      ? { height: '100%', width: `${Math.max(4, pct)}%`, borderRadius: 999, background: c.accent, transition: 'width .25s ease' }
      : { height: '100%', width: '38%', borderRadius: 999, background: `linear-gradient(90deg, transparent, ${c.accent}, transparent)`, animation: 'dsh-skm-indet 1.1s ease-in-out infinite' }
    const progressPanel = h('div', { style: { marginTop: 8 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' } },
        h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, phaseText),
        job && job.phase === 'downloading'
          ? h('span', { style: { fontSize: 11.5, color: c.sub, fontFamily: 'ui-monospace, Consolas, monospace' } },
            `${fill(t('dlInfo'), fmtBytes(job.bytes))}${speed > 0 ? ` · ${fmtSpeed(speed)}` : ''}`)
          : null,
      ),
      h('div', { style: { height: 6, borderRadius: 999, background: c.chip, overflow: 'hidden', marginTop: 8 } },
        h('div', { style: barInner })),
      job && job.phase === 'installing' && job.currentSkill
        ? h('div', { style: { fontSize: 11, color: c.sub, marginTop: 6, fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          fill(t('phaseInstallCurrent'), job.currentSkill))
        : null,
      inProgress ? h('div', { style: { fontSize: 11.5, color: c.sub, marginTop: 8, lineHeight: 1.5 } }, t('progressCloseHint')) : null,
    )

    return h('div', {
      style: { position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
    },
      h('div', { role: 'dialog', style: { background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, width: 580, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', padding: '16px 18px', color: c.text, boxShadow: '0 16px 48px rgba(0,0,0,0.3)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('addSkill')),
          h('button', { style: { border: 'none', background: 'transparent', color: c.sub, fontSize: 15, cursor: 'pointer', lineHeight: 1, padding: 2 }, title: t('cancel'), onClick: onClose }, '✕'),
        ),
        h('div', { style: { fontSize: 12, color: c.sub, margin: '4px 0 10px', lineHeight: 1.5 } }, t('addSkillDesc')),
        h('div', { style: { display: 'inline-flex', border: `1px solid ${c.border}`, borderRadius: 8, overflow: 'hidden' } },
          h('button', { style: segBtn(mode === 'create'), onClick: () => switchMode('create') }, t('modeCreate')),
          h('button', { style: segBtn(mode === 'import'), onClick: () => switchMode('import') }, t('modeImport')),
        ),
        mode === 'create' ? h('div', null,
          h('p', { style: labelStyle }, t('skillName')),
          h('p', { style: descStyle }, t('skillNameDesc')),
          h('input', { style: inputStyle, value: name, maxLength: 64, placeholder: t('skillNamePh'), autoFocus: true, onChange: (e) => setName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') submit() } }),
          h('p', { style: labelStyle }, t('skillDesc')),
          h('input', { style: inputStyle, value: desc, maxLength: 200, placeholder: t('skillDescPh'), onChange: (e) => setDesc(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') submit() } }),
          h('p', { style: labelStyle }, t('skillBody')),
          h('textarea', { style: { ...inputStyle, minHeight: 160, resize: 'vertical', lineHeight: 1.6, fontFamily: 'ui-monospace, Consolas, monospace' }, value: body, placeholder: t('skillBodyPh'), onChange: (e) => setBody(e.target.value) }),
        ) : jobId != null ? progressPanel : h('div', null,
          h('p', { style: labelStyle }, t('importUrl')),
          h('p', { style: descStyle }, t('importUrlDesc')),
          h('input', { style: inputStyle, value: url, placeholder: t('importUrlPh'), autoFocus: true, onChange: (e) => setUrl(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') submit() } }),
        ),
        job && job.phase === 'error' ? h('div', { style: { ...cardStyleOf(c), borderColor: c.danger, background: c.dangerBg, color: c.danger, fontSize: 12, marginTop: 12, wordBreak: 'break-all' } }, job.error) : null,
        !job && error ? h('div', { style: { ...cardStyleOf(c), borderColor: c.danger, background: c.dangerBg, color: c.danger, fontSize: 12, marginTop: 12 } }, error) : null,
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } },
          inProgress
            ? h('button', { style: btnCancel, onClick: onClose }, t('cancel'))
            : job && job.phase === 'error' ? h('button', { style: btnCancel, onClick: backToForm }, t('backToForm')) : h('button', { style: btnCancel, onClick: onClose, disabled: busy }, t('cancel')),
          inProgress
            ? null
            : job && job.phase === 'error'
              ? h('button', { style: btnGo, onClick: submit }, t('retryImport'))
              : h('button', { style: btnGo, disabled: busy, onClick: submit }, busy ? '…' : (mode === 'create' ? t('createBtn') : t('importBtn'))),
        ),
      ),
    )
  }

  /* ---------------- 已安装视图（0.8.0）：扫描 skillsHome 的全部技能 ---------------- */

  function InstalledView({ t, c, installed, skillsHome, busy, doUninstall, confirmName, setConfirmName }) {
    const [q, setQ] = useState('')
    const list = useMemo(() => {
      const query = q.trim().toLowerCase()
      const arr = installed.slice().sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')) || a.name.localeCompare(b.name))
      if (!query) return arr
      return arr.filter((s) => `${s.name} ${s.dirName} ${s.description} ${s.source} ${s.sourceUrl}`.toLowerCase().includes(query))
    }, [installed, q])

    const kindLabel = (s) => s.sourceKind === 'repo' ? t('sourceKindRepo')
      : s.sourceKind === 'url' ? t('sourceKindUrl')
        : s.sourceKind === 'created' ? t('sourceKindCreated')
          : t('sourceKindLocal')

    const rowBtn = { borderRadius: 6, border: `1px solid ${c.border}`, background: c.card, color: c.text, fontSize: 12, padding: '4px 10px', cursor: 'pointer', lineHeight: 1.6, whiteSpace: 'nowrap' }
    const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
    const chip = { background: c.chip, color: c.sub, borderRadius: 999, fontSize: 11, padding: '2px 8px', lineHeight: 1.5, whiteSpace: 'nowrap' }

    if (installed.length === 0) {
      return h('div', { style: { background: c.card, border: `1px solid ${c.border}`, borderRadius: 10, padding: '12px 15px', color: c.sub, fontSize: 13 } }, t('installedEmpty'))
    }
    return h('div', null,
      h('div', { style: { fontSize: 12, color: c.sub, margin: '0 0 8px', lineHeight: 1.5 } },
        t('installedSub'),
        h('code', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, color: c.text } }, skillsHome || '~/.dsh/skills')),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
        h('input', {
          style: { borderRadius: 6, border: `1px solid ${c.border}`, background: c.input, color: c.text, fontSize: 12, padding: '5px 8px', width: 260, outline: 'none' },
          placeholder: t('searchInstalled'), value: q, onChange: (e) => setQ(e.target.value),
        }),
        h('span', { style: { fontSize: 12, color: c.sub } }, `${list.length} / ${installed.length}`),
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10 } },
        list.map((s) => {
          const sBusy = busy === `un#${s.name}`
          const confirming = confirmName === s.name
          return h('div', { key: s.dirName, style: { background: c.card, border: `1px solid ${c.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
              h('span', {
                title: s.dirName !== s.name ? `目录：${s.dirName}；技能名：${s.name}` : s.name,
                style: { fontSize: 13.5, fontWeight: 600, fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, s.name),
              h('span', { style: chip }, s.version ? `v${s.version}` : t('noVersion')),
            ),
            h('div', { style: { fontSize: 11.5, color: c.sub, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h('span', { style: chip }, kindLabel(s)),
              s.sourceUrl
                ? h('a', { href: s.sourceUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: c.accent, textDecoration: 'none', wordBreak: 'break-all' } }, s.source || s.sourceUrl, iconExternal(c))
                : (s.source ? h('span', null, s.source) : null),
              s.installedAt ? h('span', null, `${t('installedAtLabel')} ${fmtDate(s.installedAt)}`) : null,
            ),
            h('div', { style: { ...clamp2, fontSize: 12.5, color: c.sub, lineHeight: 1.55 } }, s.description || t('noDesc')),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: 2 } },
              h('button', {
                style: { ...rowBtn, ...(sBusy ? { opacity: 0.55, cursor: 'default' } : {}), ...(confirming ? { background: c.dangerBg, color: c.danger, borderColor: c.danger } : {}) },
                disabled: sBusy,
                onClick: () => { if (confirming) doUninstall(s.name); else { setConfirmName(s.name); setTimeout(() => setConfirmName((x) => (x === s.name ? '' : x)), 4000) } },
              }, sBusy ? '…' : (confirming ? t('confirmUninstall') : t('uninstall'))),
            ),
          )
        }),
      ),
    )
  }

  /* ---------------- 主视图 ---------------- */

  function MarketApp({ ctx, t, ctl }) {
    const [state, setState] = useState(null)
    const [loading, setLoading] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [busy, setBusy] = useState('') // key#skill 或 un#name
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState('stars')
    const [onlyNew, setOnlyNew] = useState(false)
    const [cat, setCat] = useState('全部')
    const [confirmName, setConfirmName] = useState('')
    /** 主视图页签：market=集市网格 / installed=已安装列表（0.8.0）。 */
    const [view, setView] = useState('market')
    const [addOpen, setAddOpen] = useState(false)
    const [repoInput, setRepoInput] = useState('')
    const [repoCat, setRepoCat] = useState('自选')
    const [sidebarOn, setSidebarOn] = useState(false)
    /** 技能索引：repoKey -> skills[]（来自 /skills，服务端缓存 7 天）。 */
    const [skillIndex, setSkillIndex] = useState({})
    const [failedRepos, setFailedRepos] = useState([])
    const [detailLoading, setDetailLoading] = useState(false)
    const [showCount, setShowCount] = useState(120)
    const [, setTick] = useState(0)
    const detailsStarted = useRef(false)
    /** 卡片安装任务（0.10.0）：name → { jobId, job, speed }。放在主视图层保管，
     *  卡片重挂载/「显示更多」翻页/切视图都不丢进度；done/error 的条目留作卡片回退展示。 */
    const [installJobs, setInstallJobs] = useState({})
    const installJobsRef = useRef(installJobs)
    installJobsRef.current = installJobs
    /** 下载速率 EMA 累积器：jobId → { ema, prevBytes, prevT }（跨轮询保持）。 */
    const speedAccRef = useRef({})

    const rerender = useCallback(() => setTick((x) => x + 1), [])

    const load = useCallback(async () => {
      setLoading(true)
      setError('')
      try {
        const s = await apiGet('/state')
        setState(s)
        setSidebarOn(s.prefs?.sidebar === true)
        // 内置快照自带技能详情：首屏即刻渲染全部卡片（零额外网络）
        const seeded = {}
        for (const it of s.items || []) {
          if (it.skillDetails && it.skillDetails.length > 0) seeded[it.key] = it.skillDetails
        }
        if (Object.keys(seeded).length > 0) setSkillIndex(seeded)
      } catch (e) {
        setError(String(e.message || e))
      } finally {
        setLoading(false)
      }
    }, [])

    useEffect(() => {
      injectSpinStyle()
      load()
      let off = null
      try { off = ctx.on?.('theme/change', rerender) } catch { /* 可选 */ }
      return () => { if (typeof off === 'function') off() }
    }, [load, rerender, ctx])

    /** 渐进拉取缺少详情的仓库（自选仓库/快照未覆盖者）：3 路并发。 */
    const loadDetails = useCallback(async (items) => {
      const targets = (items || []).filter((it) => it.skillCount > 0 && !(it.skillDetails && it.skillDetails.length > 0)).sort((a, b) => (b.stars || 0) - (a.stars || 0))
      if (targets.length === 0) return
      setDetailLoading(true)
      const failed = []
      let cursor = 0
      const worker = async () => {
        while (cursor < targets.length) {
          const it = targets[cursor++]
          try {
            const out = await apiPost('/skills', { key: it.key })
            setSkillIndex((prev) => ({ ...prev, [it.key]: out.skills || [] }))
          } catch (e) {
            failed.push(it.key)
          }
        }
      }
      await Promise.all([worker(), worker(), worker()])
      setFailedRepos(failed)
      setDetailLoading(false)
    }, [])

    // state 就绪后自动开始拉取技能详情（仅一次）
    useEffect(() => {
      if (!state || detailsStarted.current) return
      detailsStarted.current = true
      loadDetails(state.items)
    }, [state, loadDetails])

    const doRefresh = useCallback(async () => {
      setRefreshing(true)
      setError('')
      try {
        setState(await apiPost('/refresh', {}))
      } catch (e) {
        setError(String(e.message || e))
      } finally {
        setRefreshing(false)
      }
    }, [])

    const findItem = useCallback((key) => (state?.items || []).find((i) => i.key === key) || null, [state])

    /** 卡片安装（0.10.0 任务化）：POST /install 立即返回 { jobId, alreadyRunning }，
     *  卡片进入进度模式；进度数据由下方轮询循环写入 installJobs。 */
    const doInstall = useCallback(async (key, skillName) => {
      const item = findItem(key)
      if (!item) return
      setNotice('')
      try {
        const r = await apiPost('/install', { owner: item.owner, repo: item.repo, skills: [skillName] })
        speedAccRef.current[r.jobId] = { ema: 0, prevBytes: 0, prevT: Date.now() }
        setInstallJobs((prev) => ({ ...prev, [skillName]: { jobId: r.jobId, job: null, speed: 0 } }))
      } catch (e) {
        setNotice(fill(t('actionFailed'), String(e.message || e)))
      }
    }, [findItem, t])

    /** 安装任务轮询：600ms 拉 /import/status（与 URL 导入共用任务池与端点）；
     *  下载中用指数滑动平均估算实时速率（0.6 旧 + 0.4 新）；done → 刷新状态 +
     *  成功提示；error → 失败提示（卡片退回安装按钮，title 带原因，点击即重试）。 */
    const hasActiveInstall = useMemo(
      () => Object.values(installJobs).some((e) => e && e.jobId && (!e.job || (e.job.phase !== 'done' && e.job.phase !== 'error'))),
      [installJobs],
    )
    /** 任务总数作为 effect 依赖：堵住「上一轮循环恰好收尾的同一瞬间提交新任务」时
     *  轮询循环不重启的竞态（hasActiveInstall 布尔值此时不变，数量变化会触发重挂）。 */
    const installJobCount = Object.keys(installJobs).length
    useEffect(() => {
      if (!hasActiveInstall) return
      let stopped = false
      let timer = null
      const tick = async () => {
        const ids = [...new Set(Object.values(installJobsRef.current)
          .filter((e) => e && e.jobId && (!e.job || (e.job.phase !== 'done' && e.job.phase !== 'error')))
          .map((e) => e.jobId))]
        let anyActive = false
        for (const id of ids) {
          try {
            const j = await apiPost('/import/status', { job: id })
            if (stopped) return
            if (j.phase === 'downloading') {
              const now = Date.now()
              const acc = speedAccRef.current[id] || (speedAccRef.current[id] = { ema: 0, prevBytes: 0, prevT: now })
              const dt = (now - acc.prevT) / 1000
              if (dt >= 0.3) {
                const inst = Math.max(0, (j.bytes || 0) - acc.prevBytes) / dt
                acc.ema = acc.ema > 0 ? acc.ema * 0.6 + inst * 0.4 : inst
                acc.prevBytes = j.bytes || 0
                acc.prevT = now
              }
            }
            setInstallJobs((prev) => {
              const next = { ...prev }
              const speed = j.phase === 'downloading' ? (speedAccRef.current[id]?.ema || 0) : 0
              for (const [nm, e] of Object.entries(prev)) {
                if (e.jobId === id) next[nm] = { ...e, job: j, speed }
              }
              return next
            })
            if (j.phase === 'done') {
              setNotice(fill(t('installedOk'), (j.installed || []).join(', ') || '—'))
              apiGet('/state').then((s) => { if (!stopped) setState(s) }).catch(() => { /* 下次加载纠正 */ })
            } else if (j.phase === 'error') {
              setNotice(fill(t('installFailed'), String(j.error || '')))
            } else {
              anyActive = true
            }
          } catch {
            if (!stopped) anyActive = true // 网络/宿主抖动，下一轮重试
          }
        }
        if (!stopped && anyActive) timer = setTimeout(tick, 600)
      }
      timer = setTimeout(tick, 250)
      return () => { stopped = true; if (timer) clearTimeout(timer) }
    }, [hasActiveInstall, installJobCount, t])

    const doUninstall = useCallback(async (skillName) => {
      setBusy(`un#${skillName}`)
      setNotice('')
      try {
        await apiPost('/uninstall', { name: skillName })
        setNotice(fill(t('uninstalledOk'), skillName))
        setState(await apiGet('/state'))
      } catch (e) {
        setNotice(fill(t('actionFailed'), String(e.message || e)))
      } finally {
        setBusy('')
        setConfirmName('')
      }
    }, [t])

    const doAddRepo = useCallback(async () => {
      const v = repoInput.trim()
      if (!v) return
      try {
        await apiPost('/catalog', { add: v, category: repoCat })
        setRepoInput('')
        setRefreshing(true)
        const s = await apiPost('/refresh', {})
        setState(s)
        loadDetails(s.items)
      } catch (e) {
        setNotice(fill(t('actionFailed'), String(e.message || e)))
      } finally {
        setRefreshing(false)
      }
    }, [repoInput, repoCat, loadDetails, t])

    const doRemoveRepo = useCallback(async (key) => {
      try {
        await apiPost('/catalog', { remove: key })
        setSkillIndex((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        setState(await apiGet('/state'))
      } catch (e) {
        setNotice(fill(t('actionFailed'), String(e.message || e)))
      }
    }, [t])

    /** 添加技能成功：关对话框、刷新状态并切到已安装视图展示结果。
     *  整仓导入返回 imported 为数组、可能带 skipped（异源同名跳过）。 */
    const onSkillAdded = useCallback(async (out) => {
      setAddOpen(false)
      let msg
      if (out?.created) {
        msg = fill(t('createdOk'), out.created)
      } else {
        const names = Array.isArray(out?.imported) ? out.imported.join(', ') : String(out?.imported || '')
        msg = fill(t('importedOk'), names || '—')
        if (Array.isArray(out?.skipped) && out.skipped.length > 0) msg += fill(t('importedSkip'), out.skipped.length)
      }
      setNotice(msg)
      try { setState(await apiGet('/state')) } catch { /* 下次加载纠正 */ }
      setView('installed')
    }, [t])

    const toggleSidebar = useCallback(async (v) => {
      setSidebarOn(v)
      try {
        const p = await apiPost('/prefs', { sidebar: v })
        setSidebarOn(p.sidebar === true)
        ctl.set(p.sidebar === true)
      } catch (e) {
        setNotice(fill(t('actionFailed'), String(e.message || e)))
      }
    }, [ctl, t])

    const dark = useMemo(() => {
      try {
        const snap = ctx.theme?.getTheme?.()
        const id = String((snap && (snap.id || snap.name)) || '')
        return /dark|night/i.test(id)
      } catch {
        return false
      }
    }, [ctx, state])

    const c = palette(dark)
    const installedSet = useMemo(() => new Set((state?.installed || []).map((s) => s.name)), [state])

    /** 扁平技能卡片数据：合并技能详情 + 仓库统计 + 场景分类。 */
    const cards = useMemo(() => {
      const out = []
      for (const item of state?.items || []) {
        const skills = skillIndex[item.key]
        if (!skills) continue
        for (const s of skills) {
          out.push({
            name: s.name,
            // GitHub 可见名 = 技能目录名（与仓库文件树一致）；无目录数据时回退 SKILL.md name
            dirName: s.dirName || s.name,
            dirPath: s.dir || '',
            branch: item.branch || 'main',
            description: s.description || '',
            descriptionZh: s.descriptionZh || '',
            version: s.version || '',
            license: s.license || '',
            author: s.author || item.owner,
            homepage: s.homepage || item.htmlUrl,
            fileCount: s.fileCount || 0,
            category: classifySkill(s.name, s.descriptionZh || s.description, item.category),
            repoKey: item.key,
            repoOwner: item.owner,
            repoUrl: item.htmlUrl,
            repoCategory: item.category || '自选',
            userAdded: item.userAdded === true,
            stars: item.stars,
            downloads: item.downloads,
            pushedAt: item.pushedAt,
            statsAt: item.statsAt || 0,
            installed: installedSet.has(s.name),
          })
        }
      }
      return out
    }, [state, skillIndex, installedSet])

    const categories = useMemo(() => {
      const counts = new Map()
      for (const card of cards) counts.set(card.category, (counts.get(card.category) || 0) + 1)
      return SKILL_CATEGORIES.filter((k) => counts.has(k)).map((k) => [k, counts.get(k)])
    }, [cards])

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase()
      const list = cards.filter((card) => {
        if (cat !== '全部' && card.category !== cat) return false
        if (q && !(`${card.name} ${card.dirName} ${card.dirPath} ${card.description} ${card.repoKey} ${card.author}`.toLowerCase().includes(q))) return false
        if (onlyNew && card.installed) return false
        return true
      })
      const byName = (a, b) => (a.dirName || a.name).localeCompare(b.dirName || b.name)
      const cmp = {
        stars: (a, b) => (b.stars || 0) - (a.stars || 0) || byName(a, b),
        downloads: (a, b) => (b.downloads || 0) - (a.downloads || 0) || byName(a, b),
        updated: (a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')) || byName(a, b),
        name: byName,
      }[sort] || (() => 0)
      return interleaveByRepo(list.sort(cmp))
    }, [cards, query, sort, onlyNew, cat])

    const totalSkills = cards.length
    const detailDone = Object.keys(skillIndex).length
    const detailTotal = (state?.items || []).filter((it) => it.skillCount > 0).length

    /* ---------- 样式片段 ---------- */

    // 宿主的 centerCol / 面板容器是 overflow:hidden 的定高盒，不会替插件滚动；
    // 根节点必须自己占满插槽并建立 flex 列，内容区（body）内部滚动
    //（结构对齐官方 dshmarket：root height:100% flex 列 + body flex:1 overflow-y:auto）。
    const pageStyle = {
      width: '100%', height: '100%', flex: '1 1 0%', minWidth: 0, minHeight: 0,
      boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
      fontFamily: 'inherit', color: c.text,
    }
    const headStyle = { padding: '16px 20px 0', flexShrink: 0 }
    const bodyStyle = { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '0 20px 32px' }
    const titleStyle = { fontSize: 18, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }
    const subStyle = { fontSize: 12, color: c.sub, margin: '4px 0 0' }
    const cardStyle = { background: c.card, border: `1px solid ${c.border}`, borderRadius: 10, padding: '13px 15px' }
    const btnBase = { borderRadius: 6, border: `1px solid ${c.border}`, background: c.card, color: c.text, fontSize: 12, padding: '4px 10px', cursor: 'pointer', lineHeight: 1.6, whiteSpace: 'nowrap' }
    const btnAccent = { ...btnBase, background: c.accent, color: c.accentText, borderColor: c.accent }
    const btnDanger = { ...btnBase, background: c.dangerBg, color: c.danger, borderColor: c.danger }
    const btnDisabled = { ...btnBase, opacity: 0.55, cursor: 'default' }
    const inputStyle = { borderRadius: 6, border: `1px solid ${c.border}`, background: c.input, color: c.text, fontSize: 12, padding: '4px 8px', outline: 'none' }
    const badge = (bg, fg) => ({ background: bg, color: fg, borderRadius: 999, fontSize: 11, padding: '2px 8px', lineHeight: 1.5, whiteSpace: 'nowrap' })
    const statStyle = { display: 'inline-flex', alignItems: 'center', fontSize: 12, color: c.sub }
    const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 10 }
    const clamp3 = { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
    /** 视图页签（集市/已安装）分段按钮。 */
    const segTab = (v) => ({ border: 'none', cursor: 'pointer', fontSize: 12, padding: '5px 14px', background: view === v ? c.text : c.card, color: view === v ? c.page : c.sub, fontWeight: view === v ? 600 : 400 })

    /* ---------- 技能卡片（对标插件市场：名称/作者/版本/星数/下载量/简介/兼容标识） ---------- */

    /** 技能目录在 GitHub 上的直达链接（与文件树路径一致）；仓库根技能回退仓库页。 */
    const skillTreeUrl = (card) => card.dirPath
      ? `${card.repoUrl}/tree/${encodeURIComponent(card.branch)}/${card.dirPath.split('/').map(encodeURIComponent).join('/')}`
      : card.repoUrl

    const SkillCard = (card) => {
      const uBusy = busy === `un#${card.name}`
      const confirming = confirmName === card.name
      /** 本卡的安装任务（0.10.0）：进行中 → 按钮原位渲染进度条；error → 退回按钮（title 带原因）。 */
      const ij = card.installed ? null : installJobs[card.name]
      const ijPhase = ij?.job?.phase || ''
      const ijActive = !!(ij && ij.jobId && ijPhase !== 'done' && ijPhase !== 'error')
      const nameTitle = card.dirName !== card.name
        ? fill(t('dirNameTip'), card.dirName, card.name)
        : card.dirName
      return h('div', { key: `${card.repoKey}#${card.name}`, style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 } },
        // 名称 + 分类（显示 GitHub 目录名，点击卡片链接可直达对应目录核对）
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
          h('span', { title: nameTitle, style: { fontSize: 13.5, fontWeight: 600, fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.dirName),
          h('span', { style: badge(c.chipActive, c.accent) }, card.category),
        ),
        // 作者 · 来源仓库 · 仓库内目录路径
        h('div', { style: { fontSize: 11.5, color: c.sub, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
          h('span', null, `${t('author')} `, h('b', { style: { color: c.text, fontWeight: 600 } }, card.author)),
          h('a', { href: skillTreeUrl(card), target: '_blank', rel: 'noopener noreferrer', style: { color: c.accent, textDecoration: 'none' } }, ` ${card.repoKey}`, iconExternal(c)),
          card.dirPath ? h('span', { title: t('repoPathTip'), style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 10.5 } }, ` ${card.dirPath}`) : null,
        ),
        // 版本 / 许可 / DSH 兼容 标识
        h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
          h('span', { style: badge(c.chip, c.sub) }, `${t('version')} ${card.version || t('noVersion')}`),
          card.license ? h('span', { style: badge(c.chip, c.sub) }, card.license.length > 18 ? `${card.license.slice(0, 18)}…` : card.license) : null,
          h('span', { style: badge(c.okBg, c.ok), title: t('dshCompatTip') }, `${t('dshCompat')} ${t('dshCompatOk')}`),
          card.installed ? h('span', { style: badge(c.okBg, c.ok) }, '✓') : null,
        ),
        // 能力简介（优先中文，快照内置翻译；无翻译回退英文原文）
        h('div', { style: { ...clamp3, fontSize: 12.5, color: c.sub, lineHeight: 1.55, minHeight: 58 } },
          card.descriptionZh || card.description || t('noDesc')),
        // 统计 + 操作（星标/下载量为来源仓库真实数据，GitHub 仅提供仓库级口径）
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 'auto', paddingTop: 2 } },
          h('span', { style: statStyle, title: `${t('starsRepoTip')}${card.statsAt ? ' · ' + fill(t('statsAt'), fmtDate(card.statsAt)) : ''}` },
            iconStar(c), h('b', { style: { color: c.text } }, fmtNum(card.stars)), h('span', { style: { fontSize: 10, marginLeft: 2 } }, t('repoLevel'))),
          h('span', { style: statStyle, title: t('downloadsRepoTip') },
            iconDownload(c), card.downloads ? fmtNum(card.downloads) : t('noDownloads'), card.downloads ? h('span', { style: { fontSize: 10, marginLeft: 2 } }, t('repoLevel')) : null),
          card.installed
            ? h('button', {
              style: { ...btnBase, ...(uBusy ? { opacity: 0.55, cursor: 'default' } : {}), ...(confirming ? { background: c.dangerBg, color: c.danger, borderColor: c.danger } : {}), marginLeft: 'auto' },
              disabled: uBusy,
              onClick: () => { if (confirming) doUninstall(card.name); else { setConfirmName(card.name); setTimeout(() => setConfirmName((x) => (x === card.name ? '' : x)), 4000) } },
            }, uBusy ? '…' : (confirming ? t('confirmUninstall') : t('uninstall')))
            : ijActive
              ? (() => {
                // 进度条芯片（0.10.0）：下载中 = 动画条 + 已下载字节 + 实时速率；
                // 解包中 = 动画条；安装中 = skillDone/skillTotal 确定条
                const chipPhase = !ij.job || ijPhase === 'starting' || ijPhase === 'downloading' ? t('cardDownloading')
                  : ijPhase === 'extracting' ? t('cardExtracting')
                  : ijPhase === 'installing' ? fill(t('cardInstalling'), ij.job.skillDone, ij.job.skillTotal)
                  : t('installing')
                const chipPct = ijPhase === 'installing' && ij.job.skillTotal > 0
                  ? Math.round((ij.job.skillDone / ij.job.skillTotal) * 100) : null
                const chipBar = chipPct !== null
                  ? { height: '100%', width: `${Math.max(4, chipPct)}%`, borderRadius: 999, background: c.accent, transition: 'width .25s ease' }
                  : { height: '100%', width: '38%', borderRadius: 999, background: `linear-gradient(90deg, transparent, ${c.accent}, transparent)`, animation: 'dsh-skm-indet 1.1s ease-in-out infinite' }
                return h('div', { style: { marginLeft: 'auto', width: 150, flexShrink: 0 } },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, fontSize: 10.5, color: c.sub, marginBottom: 3, lineHeight: 1.3 } },
                    h('span', { style: { whiteSpace: 'nowrap' } }, chipPhase),
                    ijPhase === 'downloading'
                      ? h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' } },
                        `${fmtBytes(ij.job?.bytes || 0)}${ij.speed > 0 ? ' · ' + fmtSpeed(ij.speed) : ''}`)
                      : null,
                  ),
                  h('div', { style: { height: 5, borderRadius: 999, background: c.chip, overflow: 'hidden' } },
                    h('div', { style: chipBar })),
                )
              })()
              : h('button', {
                style: { ...btnAccent, marginLeft: 'auto' },
                title: ijPhase === 'error' ? String(ij.job?.error || '') : undefined,
                onClick: () => doInstall(card.repoKey, card.name),
              }, t('install')),
        ),
      )
    }

    /* ---------- 渲染 ---------- */

    if (loading && !state) {
      return h('div', { style: { ...pageStyle, padding: '16px 20px 32px', display: 'block' } }, h('div', { style: { color: c.sub, fontSize: 13 } }, t('loading')))
    }

    return h('div', { style: pageStyle },
      h('div', { style: headStyle },
      // 头部
      h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 } },
        h('div', null,
          h('div', { style: titleStyle }, iconStore(c), t('nav')),
          h('div', { style: subStyle },
            `${t('subtitle')} · ${totalSkills} skills · ${state?.items?.length ?? '—'} repos`,
            state?.rate ? ` · ${fill(t('rateLeft'), fmtNum(state.rate.remaining))}` : '',
          ),
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', { style: { fontSize: 12, color: c.sub, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: sidebarOn, onChange: (e) => toggleSidebar(e.target.checked) }),
            t('sidebarShow')),
          view === 'market' ? h('input', {
            style: { ...inputStyle, width: 170 }, placeholder: t('addRepoPlaceholder'),
            value: repoInput, onChange: (e) => setRepoInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') doAddRepo() },
          }) : null,
          view === 'market' ? h('select', { style: inputStyle, value: repoCat, onChange: (e) => setRepoCat(e.target.value), title: t('userAdded') },
            (state?.categories || ['自选']).map((k) => h('option', { key: k, value: k }, k))) : null,
          view === 'market' ? h('button', { style: btnBase, onClick: doAddRepo }, t('add')) : null,
          h('button', { style: btnBase, disabled: refreshing, onClick: doRefresh },
            iconRefresh(c, refreshing), ' ', refreshing ? t('refreshing') : t('refresh')),
        ),
      ),
      // 视图切换：集市 / 已安装 + 添加技能入口（0.8.0）
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
        h('div', { style: { display: 'inline-flex', border: `1px solid ${c.border}`, borderRadius: 8, overflow: 'hidden' } },
          h('button', { style: segTab('market'), onClick: () => setView('market') }, `${t('tabMarket')} ${totalSkills}`),
          h('button', { style: segTab('installed'), onClick: () => setView('installed') }, `${t('tabInstalled')} ${(state?.installed || []).length}`),
        ),
        view === 'market' ? h('button', { style: { ...btnAccent, marginLeft: 'auto' }, onClick: () => setAddOpen(true) }, `＋ ${t('addSkill')}`) : null,
      ),
      // 提示条（集市数据状态仅在集市视图展示；error/notice 全局有效）
      view === 'market' && state?.stale ? h('div', { style: { ...cardStyle, borderColor: c.warn, background: c.warnBg, color: c.warn, fontSize: 12, marginBottom: 8 } }, fill(t('staleTip'), fmtTime(state.fetchedAt))) : null,
      view === 'market' && state?.partial ? h('div', { style: { ...cardStyle, borderColor: c.warn, background: c.warnBg, color: c.warn, fontSize: 12, marginBottom: 8 } }, t('partialTip')) : null,
      // 线路状态（对齐 dsh-market：健康时保持安静）：
      // 优先级：刷新不完整 → 警告；仅星标复核降级 → 中性说明；有加速线路 → 中性说明；健康 → 不提示。
      view === 'market' && state && !state.config?.hasToken
        ? state.partial
          ? h('div', { style: { ...cardStyle, borderColor: c.warn, background: c.warnBg, color: c.warn, fontSize: 12, marginBottom: 8 } }, t('noTokenTip'))
          : state.statsDegraded
            ? h('div', { style: { ...cardStyle, fontSize: 12, color: c.sub, marginBottom: 8 } }, t('statsStaleTip'))
            : state.config?.dataRoute && state.config.dataRoute !== 'direct'
              ? h('div', { style: { ...cardStyle, fontSize: 12, color: c.sub, marginBottom: 8 } }, fill(t('proxyRouteTip'), state.config.dataRoute))
              : null
        : null,
      error ? h('div', { style: { ...cardStyle, borderColor: c.danger, background: c.dangerBg, color: c.danger, fontSize: 12, marginBottom: 8 } },
        fill(t('loadError'), error), ' ',
        h('button', { style: { ...btnBase, marginLeft: 8 }, onClick: load }, t('retry'))) : null,
      notice ? h('div', { style: { ...cardStyle, fontSize: 12, color: c.ok, background: c.okBg, borderColor: c.ok, marginBottom: 8 } }, notice) : null,
      // 技能详情渐进加载进度（仅集市视图）
      view === 'market' && (detailLoading || (detailDone < detailTotal))
        ? h('div', { style: { ...cardStyle, fontSize: 12, color: c.sub, marginBottom: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          detailLoading ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, iconRefresh(c, true), t('loadingSkills')) : null,
          h('span', null, fill(t('skillsProgress'), detailDone, detailTotal, totalSkills)),
          failedRepos.length > 0 ? h('span', { style: { color: c.warn } },
            ` · ${fill(t('skillsFailedN'), failedRepos.length)}`,
            h('button', { style: { ...btnBase, marginLeft: 8 }, onClick: () => loadDetails((state?.items || []).filter((it) => failedRepos.includes(it.key))) }, t('retryFailed'))) : null,
        )
        : null,
      // 分类筛选条（技能场景分类，仅集市视图）
      view === 'market' && categories.length > 1 ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
        h('button', {
          style: { ...btnBase, background: cat === '全部' ? c.chipActive : c.card, borderColor: cat === '全部' ? c.accent : c.border, fontWeight: cat === '全部' ? 600 : 400 },
          onClick: () => setCat('全部'),
        }, `${t('catAll')} ${totalSkills}`),
        categories.map(([k, n]) => h('button', {
          key: k,
          style: { ...btnBase, background: cat === k ? c.chipActive : c.card, borderColor: cat === k ? c.accent : c.border, fontWeight: cat === k ? 600 : 400 },
          onClick: () => setCat(k),
        }, `${k} ${n}`)),
      ) : null,
      // 工具栏（搜索/排序/只看未安装，仅集市视图）
      view === 'market' ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 } },
        h('input', {
          style: { ...inputStyle, width: 250 }, placeholder: t('searchPlaceholder'),
          value: query, onChange: (e) => setQuery(e.target.value),
        }),
        h('select', { style: inputStyle, value: sort, onChange: (e) => setSort(e.target.value) },
          h('option', { value: 'stars' }, t('sortStars')),
          h('option', { value: 'downloads' }, t('sortDownloads')),
          h('option', { value: 'updated' }, t('sortUpdated')),
          h('option', { value: 'name' }, t('sortName')),
        ),
        h('label', { style: { fontSize: 12, color: c.sub, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: onlyNew, onChange: (e) => setOnlyNew(e.target.checked) }),
          t('onlyNew')),
      ) : null,
      ), // head 结束
      // 内容区（自滚动）：集市网格 或 已安装列表（0.8.0）
      h('div', { style: bodyStyle },
      view === 'installed'
        ? h(InstalledView, { t, c, installed: state?.installed || [], skillsHome: state?.config?.skillsHome || '', busy, doUninstall, confirmName, setConfirmName })
        : totalSkills === 0 && detailLoading
          ? h('div', { style: { ...cardStyle, color: c.sub, fontSize: 13 } }, t('loadingSkills'))
          : filtered.length === 0
            ? h('div', { style: { ...cardStyle, color: c.sub, fontSize: 13 } }, state ? t('emptyFiltered') : t('empty'))
            : h('div', null,
              h('div', { style: gridStyle }, filtered.slice(0, showCount).map((card) => SkillCard(card))),
              filtered.length > showCount
                ? h('button', { style: { ...btnBase, marginTop: 10 }, onClick: () => setShowCount((x) => x + 120) }, fill(t('showMore'), filtered.length - showCount))
                : null),
      ),
      // 添加技能对话框（新建 / URL 导入）
      addOpen ? h(AddSkillDialog, { t, c, onClose: () => setAddOpen(false), onDone: onSkillAdded }) : null,
    )
  }

  /* ---------------- 设置页（对齐 dsh-market 的设置卡片：折叠分区 + 行式设置） ---------------- */

  function MarketSettings({ ctx, t, ctl }) {
    const [state, setState] = useState(null)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [busy, setBusy] = useState('')
    const [proxyInput, setProxyInput] = useState('')
    const [confirmClear, setConfirmClear] = useState(false)
    const [open, setOpen] = useState(true)
    const [, setTick] = useState(0)
    const rerender = useCallback(() => setTick((x) => x + 1), [])

    const load = useCallback(async () => {
      try {
        const s = await apiGet('/state')
        setState(s)
        setProxyInput((prev) => (prev === '' ? (s.config?.apiProxy || '') : prev))
      } catch (e) {
        setError(String(e.message || e))
      }
    }, [])

    useEffect(() => {
      injectSpinStyle()
      load()
      let off = null
      try { off = ctx.on?.('theme/change', rerender) } catch { /* 可选 */ }
      return () => { if (typeof off === 'function') off() }
    }, [load, rerender, ctx])

    const dark = useMemo(() => {
      try {
        const snap = ctx.theme?.getTheme?.()
        const id = String((snap && (snap.id || snap.name)) || '')
        return /dark|night/i.test(id)
      } catch { return false }
    }, [ctx, state])
    const c = palette(dark)

    const post = useCallback(async (path, body) => {
      const out = await apiPost(path, body || {})
      await load()
      return out
    }, [load])

    const saveProxy = useCallback(async () => {
      setBusy('proxy'); setNotice(''); setError('')
      try {
        const v = proxyInput.trim()
        await post('/prefs', { apiProxy: v })
        const norm = v.replace(/\/+$/, '')
        setNotice(v ? fill(t('proxySaved'), norm) : t('proxyCleared'))
      } catch (e) { setError(fill(t('actionFailed'), String(e.message || e))) }
      finally { setBusy('') }
    }, [proxyInput, post, t])

    const clearProxy = useCallback(async () => {
      setProxyInput(''); setBusy('proxy-clear'); setNotice('')
      try { await post('/prefs', { apiProxy: '' }); setNotice(t('proxyCleared')) }
      catch (e) { setError(fill(t('actionFailed'), String(e.message || e))) }
      finally { setBusy('') }
    }, [post, t])

    const setRegion = useCallback(async (region) => {
      setBusy(`region:${region}`); setNotice(''); setError('')
      try { await post('/prefs', { region }) }
      catch (e) { setError(fill(t('actionFailed'), String(e.message || e))) }
      finally { setBusy('') }
    }, [post])

    const toggleSidebar = useCallback(async (v) => {
      setBusy('sidebar')
      try { const p = await post('/prefs', { sidebar: v }); ctl.set(p.sidebar === true) }
      catch (e) { setError(fill(t('actionFailed'), String(e.message || e))) }
      finally { setBusy('') }
    }, [post, ctl])

    const openMarket = useCallback(async () => {
      try { await ctl.open() } catch (e) { setError(fill(t('actionFailed'), String(e.message || e))) }
    }, [ctl])

    const doClearCache = useCallback(async () => {
      setBusy('cache'); setNotice(''); setError('')
      try {
        const out = await apiPost('/cache/clear', {})
        setNotice(fill(t('cacheCleared'), out.removed ?? 0))
        await load()
      } catch (e) { setError(fill(t('actionFailed'), String(e.message || e))) }
      finally { setBusy(''); setConfirmClear(false) }
    }, [load, t])

    /* ---------- 样式片段（dsh-market 行式设置：左名称+说明，右控件） ---------- */
    const rowStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '13px 0', borderTop: `1px solid ${c.border}` }
    const nameStyle = { fontSize: 13, fontWeight: 600, margin: 0 }
    const descStyle = { fontSize: 12, color: c.sub, margin: '3px 0 0', lineHeight: 1.6, maxWidth: 460 }
    const segStyle = { display: 'inline-flex', border: `1px solid ${c.border}`, borderRadius: 8, overflow: 'hidden' }
    const segBtn = (on_) => ({ border: 'none', cursor: 'pointer', fontSize: 12, padding: '5px 14px', background: on_ ? c.text : 'transparent', color: on_ ? c.page : c.sub })
    const btnBase = { borderRadius: 6, border: `1px solid ${c.border}`, background: c.card, color: c.text, fontSize: 12, padding: '5px 12px', cursor: 'pointer', lineHeight: 1.6, whiteSpace: 'nowrap' }
    const btnAccent = { ...btnBase, background: c.accent, color: c.accentText, borderColor: c.accent }
    const btnDanger = { ...btnBase, background: c.dangerBg, color: c.danger, borderColor: c.danger }
    const inputStyle = { borderRadius: 6, border: `1px solid ${c.border}`, background: c.input, color: c.text, fontSize: 12, padding: '5px 8px', outline: 'none', width: 260 }
    const codeStyle = { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, color: c.sub, wordBreak: 'break-all' }

    const row = (name, desc, control) => h('div', { style: rowStyle },
      h('div', { style: { minWidth: 0 } }, h('p', { style: nameStyle }, name), desc ? h('p', { style: descStyle }, desc) : null),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' } }, control),
    )

    const cfg = state?.config
    const cache = state?.cache

    return h('div', { style: { padding: '4px 2px', fontFamily: 'inherit', color: c.text, maxWidth: 760 } },
      // 折叠分区头（dsh-market 同款：名称 + 版本）
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 0', userSelect: 'none' },
        onClick: () => setOpen((x) => !x),
      },
        h('span', { style: { color: c.sub, fontSize: 11, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }, '▶'),
        h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, `${t('nav')} v${cfg?.version || '…'}`),
        h('span', { style: { fontSize: 12, color: c.sub, marginLeft: 4 } }, t('settingsSubtitle')),
      ),
      open ? h('div', null,
        error ? h('div', { style: { ...cardStyleOf(c), borderColor: c.danger, background: c.dangerBg, color: c.danger, fontSize: 12, marginBottom: 4 } }, error) : null,
        notice ? h('div', { style: { ...cardStyleOf(c), fontSize: 12, color: c.ok, background: c.okBg, borderColor: c.ok, marginBottom: 4 } }, notice) : null,

        row(t('openMarket'), t('openMarketDesc'),
          h('button', { style: btnAccent, onClick: openMarket }, t('openMarket'))),
        row(t('sidebarEntry'), t('sidebarEntryDesc'),
          h('input', { type: 'checkbox', checked: state?.prefs?.sidebar === true, disabled: busy === 'sidebar', onChange: (e) => toggleSidebar(e.target.checked) })),
        row(t('region'), t('regionDesc'),
          h('div', { style: segStyle },
            h('button', { style: segBtn(cfg?.region !== 'global'), onClick: () => setRegion('china'), disabled: busy === 'region:china' || cfg?.region === 'china' }, t('regionChina')),
            h('button', { style: segBtn(cfg?.region === 'global'), onClick: () => setRegion('global'), disabled: busy === 'region:global' || cfg?.region === 'global' }, t('regionGlobal')),
          )),
        row(t('githubAccel'),
          h('span', { style: { ...descStyle, display: 'block' } },
            t('githubAccelDesc'), ' ',
            h('span', { style: { color: c.text } }, fill(t('currentRoutes'), cfg?.dataRoute || t('routeUnprobed'), cfg?.gitRoute || t('routeUnprobed')))),
          cfg?.apiProxyManaged
            ? h('span', { style: { fontSize: 12, color: c.warn } }, fill(t('proxyManaged'), cfg.apiProxy))
            : h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              h('input', { style: inputStyle, placeholder: t('proxyPlaceholder'), value: proxyInput, onChange: (e) => setProxyInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') saveProxy() } }),
              h('button', { style: btnBase, disabled: busy === 'proxy', onClick: saveProxy }, busy === 'proxy' ? '…' : t('proxySave')),
              proxyInput ? h('button', { style: btnBase, disabled: busy === 'proxy-clear', onClick: clearProxy }, t('proxyClear')) : null,
            )),
        row(t('tokenRow'), t('tokenDesc'),
          h('span', { style: { fontSize: 12, color: cfg?.hasToken ? c.ok : c.sub } }, cfg?.hasToken ? `✓ ${t('tokenOn')}` : t('tokenOff'))),
        row(t('cacheRow'), t('cacheDesc') + (cache ? ` tarball × ${cache.tarballCount}（${fmtNum(Math.round((cache.tarballBytes || 0) / 1048576))} MB）· 元数据 × ${cache.metaCount}` : ''),
          h('button', {
            style: confirmClear ? btnDanger : btnBase, disabled: busy === 'cache',
            onClick: () => { if (confirmClear) doClearCache(); else { setConfirmClear(true); setTimeout(() => setConfirmClear((x) => (x ? false : x)), 4000) } },
          }, busy === 'cache' ? '…' : (confirmClear ? t('cacheClearConfirm') : t('cacheClear')))),
        row(t('dirsRow'), h('span', { style: { ...descStyle, display: 'block' } },
          h('div', { style: codeStyle }, `${t('source')}：${cfg?.stateDir || '—'}`),
          h('div', { style: codeStyle }, `skills：${cfg?.skillsHome || '—'}`)),
          null),
      ) : null,
    )
  }

  /** 设置页用的卡片底色片段。 */
  function cardStyleOf(c) {
    return { background: c.card, border: `1px solid ${c.border}`, borderRadius: 10, padding: '10px 14px' }
  }

  /* ---------------- 客户端插件挂载 ---------------- */

  function mount(ctx) {
    // 多语言字典：宿主 locale 服务优先，缺键回退内置。
    try {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-market: dictionaries')
    } catch { /* 极老宿主：直接用内置文案 */ }

    const t = (key) => {
      try {
        const bound = ctx.locale.bind(NS)
        const s = bound(key)
        return s || zh[key] || key
      } catch {
        return zh[key] || key
      }
    }

    /* --- 座位一：设置侧边栏独立分区「Skill 集市」——集市本体（搜索/分类/安装）。 --- */
    const registerSettingsSection = () => ctx.slots.register(
      { name: 'settings.section', id: name, order: 45, label: () => t('nav'), locale: NS, inject: () => ({ t }) },
      () => h(MarketApp, { ctx, t, ctl: sidebarCtl }),
    )

    /* --- 座位二：设置 → 内置插件 的页签——版本与网络设置卡片（dsh-market 同款分工）。 --- */
    const registerPluginsSettingsTab = () => ctx.slots.register(
      { name: 'settings.plugins.tab', id: name, order: 65, label: () => t('nav'), locale: NS, inject: () => ({ t }) },
      () => h(MarketSettings, { ctx, t, ctl: sidebarCtl }),
    )

    /* --- 座位三：新宿主插件页的页签——设置卡片（对齐 dsh-market：插件页管理自身）。 --- */
    const registerPluginsTab = () => ctx.slots.register(
      { name: 'plugins.tab', id: name, order: 2, label: () => t('nav'), locale: NS, inject: () => ({ t }) },
      () => h(MarketSettings, { ctx, t, ctl: sidebarCtl }),
    )

    /* --- 主界面侧边栏行（可选，默认关；开 = 注册 main 面板 + panellist 行） --- */
    let layout = null
    let sidebarDispose = null
    try { ctx.inject(['layout'], (scoped) => { layout = scoped?.layout || null }) } catch { /* 可选服务 */ }
    function applySidebar(on) {
      if (on && !sidebarDispose) {
        try {
          const offPanel = ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) },
            () => h('div', { style: { width: '100%', height: '100%', minHeight: 0 } }, h(MarketApp, { ctx, t, ctl: sidebarCtl })),
          )
          const offRow = ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: () => t('nav'), locale: NS },
            (owner) => iconStore(palette(false), owner?.size ?? 16),
          )
          sidebarDispose = () => {
            // 先离开该面板再注销：选中态悬空会把主栏留在空页上
            try {
              const snap = layout?.panelInfo?.getSnapshot?.()
              if (snap && snap.activePanelId === PANEL_ID && typeof layout.selectPanel === 'function') layout.selectPanel(null)
            } catch { /* 布局服务可选 */ }
            try { if (typeof offRow === 'function') offRow() } catch {}
            try { if (typeof offPanel === 'function') offPanel() } catch {}
          }
        } catch (e) {
          console.warn('[dsh-skill-market] sidebar registration failed:', e && e.message)
        }
      } else if (!on && sidebarDispose) {
        const d = sidebarDispose
        sidebarDispose = null
        try { d() } catch {}
      }
    }
    sidebarCtl.set = applySidebar
    sidebarCtl.get = () => sidebarDispose !== null
    /** 设置页「打开集市」：确保侧边栏行已注册，再激活集市面板。 */
    sidebarCtl.open = async () => {
      try {
        const p = await apiPost('/prefs', { sidebar: true })
        if (!p || p.sidebar !== true) return false
        if (sidebarDispose === null) applySidebar(true)
        // 注册是同步完成的，下一帧再激活面板
        setTimeout(() => { try { layout?.selectPanel?.(PANEL_ID) } catch { /* 布局服务可选 */ } }, 80)
        return true
      } catch { return false }
    }

    // 启动时按持久化偏好恢复侧边栏行
    fetch(`${API}/prefs`, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((p) => { if (p && p.sidebar === true) applySidebar(true) })
      .catch(() => {})

    /* --- 注册所有座位（slots.inject：插槽晚出现时宿主回调重注册） --- */
    const disposers = []
    for (const [slot, reg] of [
      ['settings.section', registerSettingsSection],
      ['settings.plugins.tab', registerPluginsSettingsTab],
      ['plugins.tab', registerPluginsTab],
    ]) {
      try {
        const off = ctx.slots.inject(slot, reg)
        if (typeof off === 'function') disposers.push(off)
      } catch (e) {
        console.warn(`[dsh-skill-market] slot ${slot} unavailable:`, e && e.message)
      }
    }
    try {
      ctx.effect(() => () => {
        disposers.forEach((d) => { try { d() } catch {} })
        applySidebar(false)
      }, 'skill-market: slots')
    } catch { /* dispose 缺失时由宿主上下文兜底 */ }
  }

  function apply(ctx) {
    // 任何挂载异常都必须被拦住：一个插件的失败不能掀翻宿主启动。
    try {
      mount(ctx)
    } catch (error) {
      console.error('[dsh-skill-market] mounting failed, the tab is missing for this session. Rest of the app is unaffected:', error)
    }
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  return module.exports
} })

const { app, shell, session, net, BrowserWindow, ipcMain, dialog } = require('electron')
const { join, basename } = require('path')
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const Database = require('better-sqlite3')

// ===== 从 B 站公开视频页面提取公开元信息 =====
// 合规说明：只请求公开页面、只提取 og: 元信息、单条触发

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i')
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1]) return decodeHtml(m[1])
  }
  return ''
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function extractBvid(url) {
  const m = url.match(/(BV[0-9A-Za-z]{10})/)
  return m ? m[1] : ''
}

// 从页面里提取 window.__INITIAL_STATE__ = {...} 的完整 JSON（括号配对扫描，稳妥处理嵌套）
function extractInitialState(html) {
  const idx = html.indexOf('__INITIAL_STATE__')
  if (idx < 0) return null
  const eq = html.indexOf('=', idx)
  if (eq < 0) return null
  const start = html.indexOf('{', eq)
  if (start < 0) return null

  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else {
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return html.slice(start, i + 1)
      }
    }
  }
  return null
}

// 兜底：从 <meta name="author"> 提取作者名
function extractAuthor(html) {
  const patterns = [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1]) return decodeHtml(m[1])
  }
  return ''
}

async function fetchVideoInfo(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('链接不能为空')
  }

  const bvid = extractBvid(url)
  if (!bvid) {
    throw new Error('没有识别到有效的 BV 号，请检查链接')
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    }
  })

  if (!res.ok) {
    throw new Error(`请求失败：HTTP ${res.status}`)
  }

  const html = await res.text()
  const title = extractMeta(html, 'og:title')
  const cover = extractMeta(html, 'og:image')
  const authorMeta = extractAuthor(html)

  // 从公开页面的 __INITIAL_STATE__ 里解析更完整的结构化数据（仍属公开内容，无需 cookie）
  let videoData = null
  let pageTags = []
  try {
    const json = extractInitialState(html)
    if (json) {
      const state = JSON.parse(json)
      videoData = state.videoData || null
      // 视频标签就在公开页里（videoData.tags），顺手白捡，不用再单独请求标签接口。
      // 注意：数组里常有一条 tag_id=0 的「发现《BGM 名》」音乐标签，要过滤掉。
      const rawTags = (videoData && videoData.tags) || state.tags || []
      if (Array.isArray(rawTags)) {
        pageTags = rawTags.filter((t) => t && Number(t.tag_id) > 0).map((t) => t.tag_name)
      }
    }
  } catch {
    videoData = null
  }

  // 再用 view/detail 补一次：拿权威的 tag_type 分类 + 平台分词 participle + 简介。
  // 单条手动添加多一个请求完全能接受；失败会静默退回上面白捡的标签，不影响添加流程。
  const detail = await fetchVideoDetail(bvid)

  const owner = (videoData && videoData.owner) || {}
  const stat = (videoData && videoData.stat) || detail.stat || {}

  // 标签 = 官方分类标签优先，没有才退回页面白捡的；再补上简介里的 #话题#
  const tagList = detail.tags.length ? [...detail.tags] : cleanTags(pageTags)
  const tagMeta = detail.tags.length ? { ...detail.tagMeta } : {}
  const desc = (videoData && videoData.desc) || detail.desc || ''
  for (const topic of topicsFromDesc(desc)) {
    if (!tagList.includes(topic)) tagList.push(topic)
    if (!tagMeta[topic]) tagMeta[topic] = 'desc'
  }

  return {
    bvid,
    url,
    title: title || (videoData && videoData.title) || '（未能获取标题）',
    cover: cover || (videoData && videoData.pic) || '',
    author: owner.name || authorMeta || '',
    authorFace: owner.face || '',
    duration: (videoData && videoData.duration) || 0,
    // cid 是播放地址接口的必需参数：公开页 __INITIAL_STATE__ 里就有（分P取首P）
    cid:
      (videoData &&
        (videoData.cid || (videoData.pages && videoData.pages[0] && videoData.pages[0].cid))) ||
      detail.cid ||
      0,
    desc,
    pubdate: (videoData && videoData.pubdate) || detail.pubdate || 0,
    tname: (videoData && videoData.tname) || detail.tname || '',
    // B 站原始标签（带来源分类：UP 主频道 / 活动话题）作为默认标签一起入库
    tags: cleanTags(tagList),
    tagMeta,
    // 平台算法算出的主题分词，入库后用于交叉验证标签可信度
    participle: detail.participle,
    stat: {
      view: stat.view || 0,
      danmaku: stat.danmaku || 0,
      like: stat.like || 0,
      coin: stat.coin || 0,
      favorite: stat.favorite || 0,
      share: stat.share || 0,
      reply: stat.reply || 0
    }
  }
}

// ===== 本地 SQLite 存储 =====
// 数据保存在 app.getPath('userData') 目录下，关掉重开不丢

let db = null

// 数据分区：收藏(videos) / 稍后再看(toview) / 别人分享导入(shared) / 全站搜索(search)
// 四张结构相同的表，互不干扰。用白名单把 source 映射到真实表名，避免拼接注入。
const SOURCE_TABLES = { fav: 'videos', toview: 'toview', shared: 'shared', search: 'search' }
function tableFor(source) {
  return SOURCE_TABLES[source] || 'videos'
}

// 生成建表 SQL（收藏 / 稍后再看共用同一套字段）
function createTableSql(name) {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid        TEXT NOT NULL UNIQUE,
      url         TEXT NOT NULL,
      title       TEXT NOT NULL,
      cover       TEXT DEFAULT '',
      author      TEXT DEFAULT '',
      author_face TEXT DEFAULT '',
      duration    INTEGER DEFAULT 0,
      cid         INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      pubdate     INTEGER DEFAULT 0,
      tname       TEXT DEFAULT '',
      stat        TEXT DEFAULT '{}',
      tags        TEXT DEFAULT '[]',
      tag_meta    TEXT DEFAULT '{}',
      participle  TEXT DEFAULT '[]',
      watched     INTEGER DEFAULT 0,
      fav_time    INTEGER DEFAULT 0,
      invalid     INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `
}

// 分享导入分区：字段与上面一致，另加 share_from(导出者昵称) / share_mid。
// 唯一约束改成 (bvid, share_from)——同一视频可被不同人分别分享进来，各自独立。
function createSharedTableSql() {
  return `
    CREATE TABLE IF NOT EXISTS shared (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid        TEXT NOT NULL,
      url         TEXT NOT NULL,
      title       TEXT NOT NULL,
      cover       TEXT DEFAULT '',
      author      TEXT DEFAULT '',
      author_face TEXT DEFAULT '',
      duration    INTEGER DEFAULT 0,
      cid         INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      pubdate     INTEGER DEFAULT 0,
      tname       TEXT DEFAULT '',
      stat        TEXT DEFAULT '{}',
      tags        TEXT DEFAULT '[]',
      tag_meta    TEXT DEFAULT '{}',
      participle  TEXT DEFAULT '[]',
      watched     INTEGER DEFAULT 0,
      fav_time    INTEGER DEFAULT 0,
      invalid     INTEGER DEFAULT 0,
      share_from  TEXT DEFAULT '',
      share_mid   INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(bvid, share_from)
    )
  `
}

function initDb() {
  if (db) return db

  const dbPath = join(app.getPath('userData'), 'bilibili-collector.db')
  db = new Database(dbPath)

  // WAL 模式：读写更稳定，适合频繁小事务
  db.pragma('journal_mode = WAL')

  db.exec(createTableSql('videos')) // 收藏
  db.exec(createTableSql('toview')) // 稍后再看
  db.exec(createSharedTableSql()) // 分享导入
  db.exec(createTableSql('search')) // 全站搜索

  // 旧库迁移：补齐新增列（PRAGMA table_info 检测，缺哪列补哪列）
  migrateDb()

  return db
}

// 给已存在的旧表补列（新装库的 CREATE TABLE 已含全部列，此步对旧库生效）
function migrateDb() {
  const addCols = [
    ['cover', "TEXT DEFAULT ''"],
    ['author', "TEXT DEFAULT ''"],
    ['author_face', "TEXT DEFAULT ''"],
    ['duration', 'INTEGER DEFAULT 0'],
    ['cid', 'INTEGER DEFAULT 0'],
    ['description', "TEXT DEFAULT ''"],
    ['pubdate', 'INTEGER DEFAULT 0'],
    ['tname', "TEXT DEFAULT ''"],
    ['stat', "TEXT DEFAULT '{}'"],
    ['tags', "TEXT DEFAULT '[]'"],
    // 标签来源：{ "阴阳师": "up"(UP主频道标签) | "topic"(活动/话题) | "desc"(简介#话题#) }
    ['tag_meta', "TEXT DEFAULT '{}'"],
    // B 站平台算法算出的主题分词：干净、可直接当分类种子，用来交叉验证 UP 主自填标签
    ['participle', "TEXT DEFAULT '[]'"],
    ['watched', 'INTEGER DEFAULT 0'],
    ['fav_time', 'INTEGER DEFAULT 0'],
    ['invalid', 'INTEGER DEFAULT 0']
  ]
  for (const table of ['videos', 'toview', 'shared', 'search']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    for (const [name, def] of addCols) {
      if (!cols.includes(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`)
      }
    }
  }
}

// 把数据库行转成前端友好的对象（tags/stat 反序列化）
function rowToVideo(row) {
  if (!row) return null
  return {
    id: row.id,
    bvid: row.bvid,
    url: row.url,
    title: row.title,
    cover: row.cover,
    author: row.author,
    authorFace: row.author_face || '',
    duration: row.duration || 0,
    cid: row.cid || 0,
    desc: row.description || '',
    pubdate: row.pubdate || 0,
    tname: row.tname || '',
    stat: safeParseStat(row.stat),
    tags: safeParseTags(row.tags),
    tagMeta: safeParseTagMeta(row.tag_meta),
    participle: safeParseTags(row.participle),
    watched: row.watched === 1,
    favTime: row.fav_time || 0,
    invalid: row.invalid === 1,
    shareFrom: row.share_from || '',
    createdAt: row.created_at
  }
}

function safeParseStat(stat) {
  try {
    const obj = JSON.parse(stat || '{}')
    return {
      view: obj.view || 0,
      danmaku: obj.danmaku || 0,
      like: obj.like || 0,
      coin: obj.coin || 0,
      favorite: obj.favorite || 0,
      share: obj.share || 0,
      reply: obj.reply || 0
    }
  } catch {
    return { view: 0, danmaku: 0, like: 0, coin: 0, favorite: 0, share: 0, reply: 0 }
  }
}

function safeParseTags(tags) {
  try {
    const arr = JSON.parse(tags || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    // 兼容旧数据：逗号分隔字符串
    return String(tags || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
}

// tag_meta 反序列化：{ 标签名: 来源 } 。任何异常都退化成空对象（等同于「来源未知」）
function safeParseTagMeta(meta) {
  try {
    const obj = JSON.parse(meta || '{}')
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

// ===== B 站原始标签（作为「默认标签」随视频一起入库）=====
// 单个视频最多收录 20 个标签（B 站自己的量级也差不多），空值 / 超长 / 重复的一律丢掉
const MAX_TAGS = 20
// 平台分词（participle）是「主题词」不是「标签」，可以多一点
const MAX_PARTICIPLE = 40

// 从简介里抽「#话题#」。B 站的活动话题就是这个格式（#阴阳师十周年#），
// 严格限定「1~30 个非空白字符 + 收尾 #」，所以不会把「#1」「####」这种误当成话题。
// 注意：不要拿简介去做全文相似度 —— 充电说明 / 粉丝群 / 套话会把结果带偏。
function topicsFromDesc(desc) {
  const s = String(desc || '')
  const out = []
  const seen = new Set()
  const re = /#([^#\s]{1,30})#/g
  let m
  while ((m = re.exec(s)) !== null) {
    const name = m[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function cleanTags(list, max = MAX_TAGS) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw == null ? '' : raw).trim()
    if (!name || name.length > 30) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

// ===== 标签归一化与相似整合 =====
// B 站标签是「用户各写各的」，同一个概念能变出十几种写法，抓完标签后主界面会被铺满。
// 这里只做两类保守判定，避免误合并：
//   ① 归一化后同键 —— 大小写 / 全角半角 / 空格 / 连接符 / emoji 差异（python、PYTHON、ｐｙｔｈｏｎ）
//   ② 前缀包含 —— 短的写法是长的写法的前缀（「机器学习」⊂「机器学习入门」）
// 通用词（教程 / 合集 / 官方 …）单独存在时不参与包含归并，免得把「教程」吸进「Python教程」。
const TAG_GENERIC = new Set([
  '教程', '教学', '视频', '合集', '系列', '入门', '基础', '进阶', '分享', '推荐', '搬运', '转载',
  '原创', '自制', '日常', '生活', '游戏', '音乐', '动画', '影视', '科技', '数码', '知识', '资讯',
  '搞笑', '综艺', '纪录片', '舞蹈', '鬼畜', '时尚', '美食', '动物', '体育', '汽车', '财经', '旅游',
  '学习', '经验', '中文', '字幕', '高清', '完整版', '更新', '记录', '实况', '解说', '干货', 'pv',
  'mad', 'amv', 'vlog', '合集向', '教程向', '歌曲', '演唱会', '直播', '游戏实况'
])
// 前缀包含时允许的最大长度差（差得太多说明不是同一个概念）
const TAG_PREFIX_MAX_DIFF = 6

// 代表写法的偏好顺序：混合大小写（Python）> 全小写（python）> 全大写（PYTHON）。
// 组内写法次数一样时按这个挑，免得「同一个标签」最后留下一个别扭的全大写写法。
// 纯中文标签三者同分，会继续用「更短优先」来裁决。
function tagDisplayRank(name) {
  const s = String(name || '')
  if (!/[A-Z]/.test(s)) return 1
  return s === s.toUpperCase() ? 2 : 0
}

// 归一化：全角转半角 → 小写 → 只留字母 / 数字 / 汉字（丢掉空格、标点、连接符、emoji）
function normalizeTagKey(name) {
  return String(name == null ? '' : name)
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

// 把 [{name, count}] 归并成若干「近似标签组」：
//   [{ name(代表写法), count(合计), variantCount, variants:[{name,count}] }]
// 代表写法 = 组内出现次数最多的那个（一样多时取更短的），保证主界面显示的是最高频写法。
// protectedNames：受保护的标签名，【不参与】前缀包含归并。用来保护活动 / 话题标签 ——
// 「阴阳师拾此一瞬」是某一期活动，不是「阴阳师」的同义写法，被吸进去就丢了活动信息。
function mergeSimilarTags(items, protectedNames) {
  const guards = protectedNames instanceof Set ? protectedNames : new Set()
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({
      name: String((it && it.name) || '').trim(),
      count: Number(it && it.count) || 0
    }))
    .filter((it) => it.name)
  if (list.length === 0) return []

  const keys = list.map((it) => normalizeTagKey(it.name))
  const parent = list.map((_, i) => i)

  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  // ① 同键合并
  const byKey = new Map()
  for (let i = 0; i < list.length; i++) {
    const anchor = byKey.get(keys[i])
    if (anchor === undefined) byKey.set(keys[i], i)
    else union(anchor, i)
  }

  // ② 前缀包含合并：按归一化长度降序处理，每个标签找「最长的、能当它前缀的其它标签」并到一起。
  //    用首字分桶 + 长度降序，避免两两全扫（标签上千个时这一步是性能关键）。
  const byFirstChar = new Map()
  for (let i = 0; i < list.length; i++) {
    const c = keys[i][0] || ''
    if (!byFirstChar.has(c)) byFirstChar.set(c, [])
    byFirstChar.get(c).push(i)
  }
  const order = list.map((_, i) => i).sort((a, b) => keys[b].length - keys[a].length)
  for (const i of order) {
    const key = keys[i]
    if (key.length < 3) continue // 太短的（含单字）不做包含归并，误伤风险高
    if (TAG_GENERIC.has(list[i].name.toLowerCase())) continue
    if (guards.has(list[i].name)) continue // 活动 / 话题标签：独立实体，不许被前缀吸走
    const bucket = byFirstChar.get(key[0] || '') || []
    let best = -1
    for (const j of bucket) {
      if (j === i) continue
      const k = keys[j]
      if (k.length >= key.length) continue
      if (key.length - k.length > TAG_PREFIX_MAX_DIFF) continue
      if (!key.startsWith(k)) continue
      if (TAG_GENERIC.has(list[j].name.toLowerCase())) continue
      if (best === -1 || keys[best].length < k.length) best = j
    }
    if (best !== -1) union(best, i)
  }

  // ③ 汇总成组（组内同名写法再兜底去重一次）
  const groupsMap = new Map()
  for (let i = 0; i < list.length; i++) {
    const root = find(i)
    if (!groupsMap.has(root)) groupsMap.set(root, [])
    groupsMap.get(root).push(list[i])
  }

  const groups = []
  for (const members of groupsMap.values()) {
    const byName = new Map()
    for (const m of members) byName.set(m.name, (byName.get(m.name) || 0) + m.count)
    const variants = [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          tagDisplayRank(a.name) - tagDisplayRank(b.name) ||
          a.name.length - b.name.length ||
          a.name.localeCompare(b.name, 'zh-Hans-CN')
      )
    groups.push({
      name: variants[0].name,
      count: variants.reduce((s, v) => s + v.count, 0),
      variantCount: variants.length,
      variants
    })
  }
  return groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

// ===== 共前缀族（只做分组展示，绝不落库改写）=====
// 解决的正是「同前缀 + 不同活动后缀」这一族：阴阳师拾此一瞬 / 阴阳师执火燎原 ——
// 互不为前缀，上方两条规则（归一化同键、前缀包含）都抓不到，但它们明显同族
// （同一个活动系列的不同期次）。而且注意：这一族还有个更好的来源 —— B 站 view/detail
// 里 tag_type='topic' 的标签本身就把活动标签挑出来了，共前缀族是它的补充（覆盖手动标签）。
//
// 算法（字典序相邻扫描，O(n log n)，几千个标签毫秒级）：
//   ① 把标签按归一化 key 排序 —— 排序后共享前缀的标签必然相邻，不用两两比较；
//   ② 扫相邻两项求最长公共前缀 LCP，够阈值就用并查集并成一族；
//   ③ 阈值：LCP 里含汉字要 ≥ 3 字（中文 2 字太容易误并，「原神」+「胡桃/钟离」只有 2 字，
//      于是不会被并 —— 这是刻意的保守取舍）；纯拉丁要 ≥ 5 字母（3 个字母太短）。
// ⚠️ 族 ≠ 同义词：族内是「同系列的兄弟」，不是同一个东西。所以【绝不能】像
//    mergeSimilarTagsInDb 那样把它们改写成同一个名字 —— 否则「阴阳师拾此一瞬」会被
//    写成「阴阳师执火燎原」，数据就毁了。这里只产出分组给界面用。
function longestCommonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

// 太「泛」的前缀：以它们开头的标签往往不是同一个系列（「如何学习 A」vs「如何学习 B」），
// 命中就放弃成族，免得把八竿子打不着的东西捆一起。
const TAG_PREFIX_STOP = new Set([
  '如何', '怎么', '怎样', '教你', '带你', '跟我', '一起', '我的', '我们', '这是', '这个',
  '什么', '那些', '这些', '一个', '关于', '如果', '不要', '别再', '千万', '一定', '真的'
])

function clusterByCommonPrefix(items, minCount = 2) {
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({ name: String((it && it.name) || '').trim(), count: Number(it && it.count) || 0 }))
    .filter((it) => it.name && normalizeTagKey(it.name).length >= 3)
  if (list.length < minCount) return []

  const entries = list.map((it) => ({ ...it, key: normalizeTagKey(it.name) }))
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const parent = entries.map((_, i) => i)
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  for (let i = 1; i < entries.length; i++) {
    const key = entries[i].key
    if (TAG_PREFIX_STOP.has(key.slice(0, 2))) continue
    const lcp = longestCommonPrefixLen(entries[i - 1].key, key)
    if (lcp < 3) continue
    const shared = key.slice(0, lcp)
    const isCJK = /[\u4e00-\u9fff]/.test(shared)
    if (!isCJK && lcp < 5) continue
    union(i - 1, i)
  }

  const groupsMap = new Map()
  for (let i = 0; i < entries.length; i++) {
    const root = find(i)
    if (!groupsMap.has(root)) groupsMap.set(root, [])
    groupsMap.get(root).push(entries[i])
  }

  const families = []
  for (const members of groupsMap.values()) {
    if (members.length < minCount) continue
    // 族名 = 全族的最长公共前缀（成员已按 key 排序，逐项收缩即可）
    let prefix = members[0].key
    for (const m of members) {
      prefix = prefix.slice(0, longestCommonPrefixLen(prefix, m.key))
      if (!prefix) break
    }
    const sorted = members
      .map((m) => ({ name: m.name, count: m.count }))
      .sort((a, b) => b.count - a.count || a.name.length - b.name.length || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const total = sorted.reduce((s, m) => s + m.count, 0)
    // 总出现次数太少的族（比如两个各出现 1 次的标签）没有展示价值
    if (total < 3) continue
    families.push({ name: prefix, count: total, size: sorted.length, members: sorted })
  }
  return families.sort((a, b) => b.count - a.count || b.size - a.size)
}

// 抓单个视频的标签 + 平台分词。走公开只读接口 /x/web-interface/view/detail（匿名可访问）。
// 为什么不用更轻的 /x/tag/archive/tags？—— 实测两者返回的标签集合【完全一致】，
// 但 view/detail 额外给了每个标签的 tag_type，等于白送一套分类：
//   old_channel → UP 主/平台频道标签（真正的「分类」标签，系统的常驻标签）
//   topic       → 活动 / 话题标签（「阴阳师拾此一瞬」「了不起的旅行家」这类期次族）
//   bgm         → 「发现《XX》」音乐标签（tag_id=0），丢掉
// 还有 data.participle —— 平台算法算好的主题分词，比 tag_type 更干净（自动滤掉英文人名等噪音），
// 拿来做交叉验证：同时出现在 participle 里的标签可信度高，只出现在 tag_type 里的标记为噪音候选。
// 顺带把 desc / cid / tname / pubdate / stat 一起带回来（反正这一趟已经发了，白捡）。
// 失败一律当作「没有标签」—— 标签只是附加信息，不能因为它失败就中断整批导入。
async function fetchVideoDetail(bvid) {
  const empty = { tags: [], tagMeta: {}, participle: [] }
  if (!bvid) return empty
  try {
    const res = await biliFetch(
      `https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`
    )
    if (!res.ok) return empty
    const data = await res.json()
    if (data.code !== 0) {
      // -412（IP 被拦）/ -352（风控）：标记 blocked，让上层立刻停止继续抓，别越陷越深
      const blocked = data.code === -412 || data.code === -352
      return { ...empty, blocked, code: data.code }
    }

    const d = data.data || {}
    const tagMeta = {}
    const names = []
    for (const t of Array.isArray(d.Tags) ? d.Tags : []) {
      const name = t && t.tag_name
      if (!name) continue
      // bgm 标签（发现《XX》）和 tag_id=0 的一律不要
      if (t.tag_type === 'bgm' || Number(t.tag_id) === 0) continue
      const src = t.tag_type === 'topic' ? 'topic' : 'up'
      // 同名标签以 topic 优先：活动标签的信息量比频道标签大
      if (!tagMeta[name] || src === 'topic') tagMeta[name] = src
      names.push(name)
    }

    const participle = cleanTags(
      (Array.isArray(d.participle) ? d.participle : []).map((x) => String(x == null ? '' : x).trim()),
      MAX_PARTICIPLE
    )

    const view = d.View || {}
    const stat = view.stat || {}
    return {
      tags: cleanTags(names),
      tagMeta,
      participle,
      desc: view.desc || '',
      cid: view.cid || 0,
      tname: view.tname || '',
      pubdate: view.pubdate || 0,
      stat: {
        view: stat.view || 0,
        danmaku: stat.danmaku || 0,
        like: stat.like || 0,
        coin: stat.coin || 0,
        favorite: stat.favorite || 0,
        share: stat.share || 0,
        reply: stat.reply || 0
      }
    }
  } catch {
    return empty
  }
}

// 批量抓标签：3 并发 + 每条 250ms 间隔。比原来（4 并发 / 180ms）保守一档 ——
// view/detail 的返回体比 /x/tag/archive/tags 大一个数量级（约 70KB vs 2KB），
// 放慢节奏能明显降低触发风控的概率。
// 返回 { byBvid: Map<bvid, {tags, tagMeta, participle, ...}>, fetched, blocked }；onProgress 形如 { done, total }
async function fetchTagsBatch(bvids, onProgress) {
  const list = Array.isArray(bvids) ? bvids : []
  const byBvid = new Map()
  if (list.length === 0) return { byBvid, fetched: 0, blocked: false }

  let cursor = 0
  let done = 0
  let blocked = false

  const worker = async () => {
    for (;;) {
      if (blocked) return
      const i = cursor++
      if (i >= list.length) return
      const r = await fetchVideoDetail(list[i])
      if (r.blocked) blocked = true
      if (r.tags.length || r.participle.length) byBvid.set(list[i], r)
      done++
      if (typeof onProgress === 'function') onProgress({ done, total: list.length })
      await new Promise((res) => setTimeout(res, 250))
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker))
  return { byBvid, fetched: byBvid.size, blocked }
}

// 抓取结果 → 入库字段（新记录直接展开用）
function tagFieldsOf(r) {
  return {
    tags: (r && r.tags) || [],
    tagMeta: (r && r.tagMeta) || {},
    participle: (r && r.participle) || []
  }
}

// 这条记录还缺「标签相关元数据」吗？缺就值得再抓一次。
// 老库（v1.4.x 存进去的）有 tags 但没有 tag_meta，靠这个判断能在重新导入时自动升级。
function needsTagFetch(exist) {
  if (!exist) return true
  if (!Array.isArray(exist.tags) || exist.tags.length === 0) return true
  if (!exist.tagMeta || Object.keys(exist.tagMeta).length === 0) return true
  return false
}

// 给「已存在」的旧记录补全标签字段：哪个空补哪个，绝不覆盖你手动改过的数据。
// 重新导入一次收藏夹即可把存量数据升级成「带来源分类 + 平台分词」的形态。
function backfillTagFields(table, id, got, current) {
  const sets = []
  const args = []
  if (got.tags.length && (!current.tags || current.tags.length === 0)) {
    sets.push('tags = ?')
    args.push(JSON.stringify(got.tags))
  }
  if (Object.keys(got.tagMeta || {}).length && Object.keys(current.tagMeta || {}).length === 0) {
    sets.push('tag_meta = ?')
    args.push(JSON.stringify(got.tagMeta))
  }
  if (got.participle.length && (!current.participle || current.participle.length === 0)) {
    sets.push('participle = ?')
    args.push(JSON.stringify(got.participle))
  }
  if (sets.length === 0) return false
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  return true
}

// 按 bvid 查询（判断是否已收录）
function getByBvid(bvid, source = 'fav') {
  const t = tableFor(source)
  const row = db.prepare(`SELECT * FROM ${t} WHERE bvid = ?`).get(bvid)
  return rowToVideo(row)
}

// 新增一条记录。bvid 已存在则返回 exists:true，不重复插入
function addVideo(video, source = 'fav') {
  const t = tableFor(source)
  const {
    bvid,
    url,
    title,
    cover = '',
    author = '',
    tags = [],
    tagMeta = {},
    participle = [],
    authorFace = '',
    duration = 0,
    cid = 0,
    desc = '',
    pubdate = 0,
    tname = '',
    stat = {},
    favTime
  } = video
  const existing = getByBvid(bvid, source)
  if (existing) {
    return { exists: true, video: existing }
  }

  // 收录时间：从收藏夹/稍后再看导入的用 B 站时间戳；手动添加的记为「现在」，
  // 这样刚加的会排在最前，整体按「最新 → 最久之前」倒序。
  const collectedAt = Number(favTime) > 0 ? Number(favTime) : Math.floor(Date.now() / 1000)

  const info = db
    .prepare(
      `INSERT INTO ${t}
        (bvid, url, title, cover, author, author_face, duration, cid, description, pubdate, tname, stat, tags, tag_meta, participle, fav_time)
       VALUES
        (@bvid, @url, @title, @cover, @author, @authorFace, @duration, @cid, @description, @pubdate, @tname, @stat, @tags, @tagMeta, @participle, @favTime)`
    )
    .run({
      bvid,
      url,
      title,
      cover,
      author,
      authorFace,
      duration,
      cid: Number(cid) || 0,
      description: desc,
      pubdate,
      tname,
      stat: JSON.stringify(stat),
      tags: JSON.stringify(tags),
      tagMeta: JSON.stringify(tagMeta || {}),
      participle: JSON.stringify(participle || []),
      favTime: collectedAt
    })

  return {
    exists: false,
    video: rowToVideo(db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(info.lastInsertRowid))
  }
}

// 列出某个分区的全部记录（按收录时间倒序：最新在前，最久之前在后）
function listVideos(source = 'fav') {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT * FROM ${t} ORDER BY fav_time DESC, id DESC`).all()
  return rows.map(rowToVideo)
}

// 关键词搜索：标题 / BV 号 / 链接 / 标签 模糊匹配
function searchVideos(keyword, source = 'fav') {
  const kw = String(keyword || '').trim()
  if (!kw) return listVideos(source)

  const t = tableFor(source)
  const like = `%${kw}%`
  const rows = db
    .prepare(
      `SELECT * FROM ${t}
       WHERE title LIKE @like OR bvid LIKE @like OR url LIKE @like OR tags LIKE @like
       ORDER BY fav_time DESC, id DESC`
    )
    .all({ like })
  return rows.map(rowToVideo)
}

// 更新一条记录（标签 / 追番标记 / 标题等）
function updateVideo(id, fields, source = 'fav') {
  const t = tableFor(source)
  const video = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id)
  if (!video) return { error: '该条记录不存在' }

  const tags = fields.tags !== undefined ? JSON.stringify(fields.tags) : video.tags
  const watched = fields.watched !== undefined ? (fields.watched ? 1 : 0) : video.watched
  const title = fields.title !== undefined ? fields.title : video.title

  db.prepare(`UPDATE ${t} SET tags = ?, watched = ?, title = ? WHERE id = ?`).run(
    tags,
    watched,
    title,
    id
  )

  return {
    video: rowToVideo(db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id))
  }
}

// 删除一条记录
function deleteVideo(id, source = 'fav') {
  const t = tableFor(source)
  const info = db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id)
  return { deleted: info.changes > 0 }
}

// 批量给多条记录追加标签（已存在的标签不重复添加）。
// 用事务保证批量更新的原子性，返回实际发生变动的条数。
function batchAddTags(ids, newTags, source = 'fav') {
  const t = tableFor(source)
  const idList = Array.isArray(ids) ? ids : []
  const tags = (Array.isArray(newTags) ? newTags : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
  if (idList.length === 0) return { error: '没有可操作的目标' }
  if (tags.length === 0) return { error: '请输入要添加的标签' }

  const selectStmt = db.prepare(`SELECT * FROM ${t} WHERE id = ?`)
  const updateStmt = db.prepare(`UPDATE ${t} SET tags = ? WHERE id = ?`)
  let updated = 0

  const run = db.transaction((list) => {
    for (const id of list) {
      const row = selectStmt.get(id)
      if (!row) continue
      const current = safeParseTags(row.tags)
      const merged = [...current]
      for (const tag of tags) {
        if (!merged.includes(tag)) merged.push(tag)
      }
      if (merged.length !== current.length) {
        updateStmt.run(JSON.stringify(merged), id)
        updated++
      }
    }
  })
  run(idList)

  return { ok: true, total: idList.length, updated }
}

// 批量删除多条记录（事务保证原子性，返回实际删除条数）
function batchDeleteVideos(ids, source = 'fav') {
  const t = tableFor(source)
  const idList = Array.isArray(ids) ? ids : []
  if (idList.length === 0) return { error: '没有可删除的目标' }

  const stmt = db.prepare(`DELETE FROM ${t} WHERE id = ?`)
  let deleted = 0
  const run = db.transaction((list) => {
    for (const id of list) {
      deleted += stmt.run(id).changes
    }
  })
  run(idList)

  return { ok: true, total: idList.length, deleted }
}

// 某个分区的记录总数
function countVideos(source = 'fav') {
  const t = tableFor(source)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()
  return row.n
}

// ===== 全站搜索（B 站 wbi 签名）=====
// B 站的搜索接口属于「需要 wbi 签名」的接口：请求要附带按当日密钥算出的 w_rid 与 wts。
// 密钥每天轮换，这里从 nav 接口取一次并缓存 4 小时。
// 合规说明：用登录态搜自己的关键词、单次只取第一页，不做批量翻页爬取。

// 官方前端逆向出的固定混淆表（64 位）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

// 64 位原始密钥按混淆表重排后取前 32 位，得到 mixin_key
function getMixinKey(raw) {
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32)
}

// nav 接口返回的 img_url / sub_url 是伪装成 PNG 的密钥，取文件名并去掉扩展名
function extractWbiKey(url) {
  const name = String(url || '').split('/').pop() || ''
  return name.split('.')[0]
}

let wbiCache = { mixinKey: '', at: 0 }
const WBI_TTL = 4 * 60 * 60 * 1000 // 4 小时（密钥每日轮换，4 小时刷新足够安全）

async function getWbiMixinKey() {
  if (wbiCache.mixinKey && Date.now() - wbiCache.at < WBI_TTL) return wbiCache.mixinKey
  const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav')
  const data = await res.json()
  const imgKey = extractWbiKey(data && data.data && data.data.wbi_img && data.data.wbi_img.img_url)
  const subKey = extractWbiKey(data && data.data && data.data.wbi_img && data.data.wbi_img.sub_url)
  if (!imgKey || !subKey) throw new Error('获取签名密钥失败，请重新登录后再试')
  const mixinKey = getMixinKey(imgKey + subKey)
  wbiCache = { mixinKey, at: Date.now() }
  return mixinKey
}

// 按 wbi 规则拼接查询串并计算 w_rid。
// 编码细节错一条签名就废：十六进制大写、空格用 %20、值里的 !'()* 四个字符要过滤掉。
function signWbi(params, mixinKey, wts) {
  const encode = (v) => encodeURIComponent(String(v).replace(/[!'()*]/g, ''))
  // wts 可显式传入（便于用官方测试向量做断言），不传则取当前时间戳
  const p = { ...params, wts: Number(wts) || Math.floor(Date.now() / 1000) }
  const base = Object.keys(p)
    .sort()
    .map((k) => `${encode(k)}=${encode(p[k])}`)
    .join('&')
  const wRid = crypto.createHash('md5').update(base + mixinKey).digest('hex')
  // 与官方前端实现一致：w_rid 追加在 query 末尾，不参与上面的字典序排序
  return `${base}&w_rid=${wRid}`
}

// 搜索结果里的标题带 <em class="keyword"> 高亮标签，需要清洗成纯文本
function stripHtml(str) {
  return decodeHtml(String(str || '').replace(/<[^>]*>/g, ''))
}

// 搜索接口返回的封面是协议相对地址（//i0.hdslb.com/...），补上协议头
function normalizePic(pic) {
  const s = String(pic || '')
  if (!s) return ''
  return s.startsWith('//') ? `https:${s}` : s
}

// 时长字符串 "12:34" / "1:02:03" → 秒数
function parseDurationText(text) {
  const parts = String(text || '')
    .split(':')
    .map((x) => parseInt(x, 10))
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

// 按关键词搜 B 站全站视频（只拉第一页 20 条，必须登录）
async function searchBili(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return { error: '请输入搜索关键词' }

  // 必须登录：带登录态的请求风控权重更低，也避免匿名流量被判为脚本
  try {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://bilibili.com' })
    if (!cookies.some((c) => c.name === 'SESSDATA')) {
      return { error: '请先登录 B 站后再搜索', needLogin: true }
    }
  } catch {
    return { error: '请先登录 B 站后再搜索', needLogin: true }
  }

  let mixinKey
  try {
    mixinKey = await getWbiMixinKey()
  } catch (err) {
    return { error: err.message || '签名准备失败' }
  }

  const query = signWbi({ search_type: 'video', keyword: kw, page: 1, page_size: 20 }, mixinKey)

  let data
  try {
    const res = await biliFetch(
      `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`
    )
    data = await res.json()
  } catch (err) {
    return { error: `网络请求失败：${err.message || '未知错误'}` }
  }

  if (data.code !== 0) {
    // 风控类错误给出明确指引，避免用户反复重试把 IP 拖进 -412（IP 级封锁更麻烦）
    const HINTS = {
      '-352': '触发了风控校验，请等几分钟再搜，不要连续快速搜索',
      '-412': '当前 IP 已被 B 站拦截，请等一段时间或换个网络再试',
      '-403': '签名校验失败，请退出后重新登录再试',
      '-101': '未登录，请先登录 B 站'
    }
    return {
      error: HINTS[String(data.code)] || data.message || '搜索失败',
      code: data.code
    }
  }

  const list = (data.data && data.data.result) || []
  const items = list
    .filter((it) => it && it.bvid)
    .map((it) => ({
      bvid: it.bvid,
      url: `https://www.bilibili.com/video/${it.bvid}`,
      title: stripHtml(it.title),
      cover: normalizePic(it.pic),
      author: String(it.author || ''),
      authorFace: '',
      duration: parseDurationText(it.duration),
      desc: stripHtml(it.description || ''),
      pubdate: Number(it.pubdate) || 0,
      tname: String(it.typename || ''),
      stat: {
        view: Number(it.play) || 0,
        danmaku: Number(it.video_review) || 0,
        like: Number(it.like) || 0,
        coin: 0,
        favorite: Number(it.favorites) || 0,
        share: 0,
        reply: Number(it.review) || 0
      },
      // 搜索结果自带 tag 字段（逗号分隔字符串，如「程序员,Python教程」），白捡，零额外请求
      tags: cleanTags(String(it.tag || '').split(','))
    }))

  return { ok: true, keyword: kw, items }
}

// 把勾选的搜索结果写入「搜索列表」分区（按 bvid 去重，已存在的跳过）
function importSearchItems(items) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { error: '没有选中任何视频' }

  let added = 0
  let skipped = 0
  for (const item of list) {
    if (!item || !item.bvid) continue
    const r = addVideo(item, 'search')
    if (r.exists) skipped++
    else added++
  }
  return { ok: true, total: list.length, added, skipped }
}

// ===== 检查更新 =====
// 比对 GitHub Release 的最新版本号与本地版本，有新版本则提示下载。
const REPO_SLUG = 'Chadaidai-offical/bilibili-collector'

// 语义化版本比较：a 比 b 新返回 1，相同返回 0，旧返回 -1
function compareVersion(a, b) {
  const pa = String(a || '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

const API_LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`
const RAW_PKG_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/package.json`
const JSDELIVR_TAGS_URL = `https://data.jsdelivr.com/v1/package/gh/${REPO_SLUG}`
const UA_HEADER = { 'User-Agent': 'bilibili-collector' }

// 检查更新缓存：GitHub 匿名接口限额「每出口 IP 60 次/小时」，
// 而共享代理 IP 很容易被别的用户提前用光（表现为 403 rate limit）。
// 所以：① 自动检查走 30 分钟缓存；② API 失败时自动降级到备用源。
const UPDATE_CACHE_TTL = 30 * 60 * 1000
const updateState = { at: 0, etag: '', apiInfo: null, lastResult: null }

function releaseUrl(version) {
  return version
    ? `https://github.com/${REPO_SLUG}/releases/tag/v${version}`
    : `https://github.com/${REPO_SLUG}/releases`
}

// 从一批版本号里挑出最高的（兼容 v1.2.0 / 1.2.0 两种写法）
function pickLatestVersion(list) {
  let best = ''
  for (const raw of list || []) {
    const v = String(raw || '').replace(/^v/i, '').trim()
    if (!v || !/^\d/.test(v)) continue
    if (!best || compareVersion(v, best) > 0) best = v
  }
  return best
}

// 通道一：GitHub 官方 API —— 信息最全（更新说明/发布时间），但受匿名配额限制
async function latestFromApi() {
  const headers = { ...UA_HEADER, Accept: 'application/vnd.github+json' }
  // 带上 ETag：命中 304 时 GitHub 不计入配额
  if (updateState.etag) headers['If-None-Match'] = updateState.etag
  const res = await net.fetch(API_LATEST_URL, { headers })

  if (res.status === 304 && updateState.apiInfo) return updateState.apiInfo
  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch (_) {
      /* 忽略读取失败 */
    }
    const err = new Error(`GitHub API HTTP ${res.status}`)
    err.status = res.status
    err.rateLimited = res.status === 403 && /rate limit/i.test(body)
    err.detail = body.slice(0, 200)
    throw err
  }
  if (res.headers.get('etag')) updateState.etag = res.headers.get('etag')

  const data = await res.json()
  const latest = String(data.tag_name || '').replace(/^v/i, '').trim()
  if (!latest) throw new Error('API 未返回版本号')
  const info = {
    latest,
    url: data.html_url || releaseUrl(latest),
    name: data.name || '',
    notes: String(data.body || '').slice(0, 1500),
    publishedAt: data.published_at || '',
    source: 'api'
  }
  updateState.apiInfo = info
  return info
}

// 通道二：raw 上的 package.json（约 2KB，随 main 分支即时反映版本号）
async function latestFromRaw() {
  const res = await net.fetch(RAW_PKG_URL, { headers: { ...UA_HEADER, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`raw HTTP ${res.status}`)
  const data = await res.json()
  const latest = String(data.version || '').trim()
  if (!latest) throw new Error('raw 未返回版本号')
  return { latest, url: releaseUrl(latest), source: 'raw' }
}

// 通道三：jsDelivr 数据接口（走 CDN，不受 GitHub 配额限制，但版本列表有缓存延迟）
async function latestFromJsdelivr() {
  const res = await net.fetch(JSDELIVR_TAGS_URL, {
    headers: { ...UA_HEADER, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`jsDelivr HTTP ${res.status}`)
  const data = await res.json()
  const latest = pickLatestVersion([
    ...Object.values(data.tags || {}),
    ...(Array.isArray(data.versions) ? data.versions : [])
  ])
  if (!latest) throw new Error('jsDelivr 未返回版本号')
  return { latest, url: releaseUrl(latest), source: 'jsdelivr' }
}

async function checkUpdate(manual = false) {
  const current = app.getVersion()
  const now = Date.now()

  // 自动检查（启动静默检查）走缓存，避免每次启动都消耗配额；手动检查立即发请求
  if (!manual && updateState.lastResult && now - updateState.at < UPDATE_CACHE_TTL) {
    return { ...updateState.lastResult, cached: true }
  }

  const channels = [
    ['api', latestFromApi],
    ['raw', latestFromRaw],
    ['jsdelivr', latestFromJsdelivr]
  ]
  const failures = []
  let info = null
  for (const [name, fn] of channels) {
    try {
      info = await fn()
      break
    } catch (err) {
      failures.push({ channel: name, message: err.message, rateLimited: !!err.rateLimited })
    }
  }

  // 全部通道都失败：不缓存失败结果（下次手动点可立即重试），并给出可操作的提示
  if (!info) {
    const rateLimited = failures.some((f) => f.rateLimited)
    return {
      ok: false,
      current,
      rateLimited,
      url: releaseUrl(),
      error: rateLimited
        ? 'GitHub 接口配额已用尽（匿名接口按出口 IP 限 60 次/小时，这个 IP 上的额度被别的用户用光了），备用源也没取到，请稍后再试'
        : `检查更新失败：${failures[0] ? failures[0].message : '网络异常'}`,
      detail: failures.map((f) => `${f.channel}: ${f.message}`).join(' | ')
    }
  }

  const result = {
    ok: true,
    current,
    latest: info.latest,
    hasUpdate: compareVersion(info.latest, current) > 0,
    url: info.url,
    name: info.name || '',
    notes: info.notes || '',
    publishedAt: info.publishedAt || '',
    source: info.source,
    // 主通道失败但备用源成功时，把情况记下来（前端可提示"已切换备用通道"）
    fellBack: failures.length > 0 ? failures.map((f) => f.channel).join(',') : ''
  }
  updateState.at = now
  updateState.lastResult = result
  return result
}

// ===== 标签管理 =====
// 聚合某分区的全部标签及使用次数（按次数倒序）。
// merge 默认开启：把相似写法合并成一组，避免主界面出现几百个近似标签。
// 每项形如 { name(代表写法), count(合计), variantCount, variants:[{name,count}] }。
// 传 merge=false 则退化成「一个写法一项」（variants 只有它自己），兼容老调用方。
// 收集「活动 / 话题」标签名（tag_meta 里标了 topic 的）。
// 这些是独立实体，不能被前缀包含规则吸进基础标签里。
function collectTopicNames(source = 'fav') {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT tag_meta FROM ${t}`).all()
  const names = new Set()
  for (const r of rows) {
    const meta = safeParseTagMeta(r.tag_meta)
    for (const [k, v] of Object.entries(meta)) {
      if (v === 'topic') names.add(k)
    }
  }
  return names
}

function listTagStats(source = 'fav', merge = true) {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT tags FROM ${t}`).all()
  const map = new Map()
  for (const r of rows) {
    for (const tag of safeParseTags(r.tags)) {
      map.set(tag, (map.get(tag) || 0) + 1)
    }
  }
  const flat = [...map.entries()].map(([name, count]) => ({ name, count }))
  if (merge === false) {
    return flat
      .map((it) => ({ ...it, variantCount: 1, variants: [it] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  return mergeSimilarTags(flat, collectTopicNames(source))
}

// 标签族：在「原始写法」上做共前缀聚类（合并后的代表写法会丢掉前缀信息）。
// 例：阴阳师拾此一瞬 / 阴阳师执火燎原 / 阴阳师十周年 → 一族「阴阳师」。
function listTagFamilies(source = 'fav', minCount = 2) {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT tags FROM ${t}`).all()
  const map = new Map()
  for (const r of rows) {
    for (const tag of safeParseTags(r.tags)) {
      map.set(tag, (map.get(tag) || 0) + 1)
    }
  }
  const flat = [...map.entries()].map(([name, count]) => ({ name, count }))
  return clusterByCommonPrefix(flat, minCount)
}

// 一键整合（落库）：把每个「近似标签组」里的次要写法统一改写成组内代表写法。
// 整合后主界面 / 标签管理看到的标签会明显变少，而且是真改数据、不是只改显示。
// 单事务一次扫描，返回影响面（组数 / 被改写的写法数 / 受影响记录数）。
function mergeSimilarTagsInDb(source = 'fav') {
  const t = tableFor(source)
  const groups = listTagStats(source, true).filter((g) => g.variantCount > 1)
  if (groups.length === 0) return { ok: true, groups: 0, tags: 0, updated: 0 }

  const remap = new Map()
  let tags = 0
  for (const g of groups) {
    for (const v of g.variants) {
      if (v.name === g.name) continue
      remap.set(v.name, g.name)
      tags++
    }
  }
  if (remap.size === 0) return { ok: true, groups: 0, tags: 0, updated: 0 }

  const rows = db.prepare(`SELECT id, tags, tag_meta FROM ${t}`).all()
  const updateStmt = db.prepare(`UPDATE ${t} SET tags = ?, tag_meta = ? WHERE id = ?`)
  let updated = 0
  const run = db.transaction(() => {
    for (const row of rows) {
      const current = safeParseTags(row.tags)
      const currentMeta = safeParseTagMeta(row.tag_meta)
      const next = []
      for (const tag of current) {
        const mapped = remap.get(tag) || tag
        if (!next.includes(mapped)) next.push(mapped)
      }
      const nextMeta = remapTagMeta(currentMeta, (k) => remap.get(k) || k)
      const same =
        next.length === current.length &&
        next.every((x, i) => x === current[i]) &&
        JSON.stringify(nextMeta) === JSON.stringify(currentMeta)
      if (!same) {
        updateStmt.run(JSON.stringify(next), JSON.stringify(nextMeta), row.id)
        updated++
      }
    }
  })
  run()
  return { ok: true, groups: groups.length, tags, updated }
}

// ===== 标签总览（标签管理弹窗专用：一次调用拿齐）=====
// 为什么要一次拿齐：弹窗打开后要同时展示「按来源分组」和「按族折叠」，
// 拆成三次调用界面会闪三下，一次给完最稳。

// 统计每个标签的来源（多数票），以及「出现在平台分词里」的认证集合。
// 平票优先级：活动话题 > UP 主频道 > 简介话题 > 未知（信息量大的优先）。
function computeTagMetaInfo(source = 'fav') {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT tags, tag_meta, participle FROM ${t}`).all()
  const srcCount = new Map()
  const verified = new Set()
  for (const r of rows) {
    const meta = safeParseTagMeta(r.tag_meta)
    const tags = safeParseTags(r.tags)
    for (const tag of tags) {
      let c = srcCount.get(tag)
      if (!c) {
        c = { up: 0, topic: 0, desc: 0, unknown: 0 }
        srcCount.set(tag, c)
      }
      c[meta[tag] || 'unknown'] += 1
    }
    // 平台分词里出现的标签 = B 站算法认可，标记为「可信标签」，用来交叉验证
    const part = new Set(safeParseTags(r.participle).map((x) => x.toLowerCase()))
    for (const tag of tags) {
      if (part.has(tag.toLowerCase())) verified.add(tag)
    }
  }
  const sources = {}
  for (const [tag, c] of srcCount) {
    let best = 'unknown'
    let bestN = -1
    for (const k of ['topic', 'up', 'desc', 'unknown']) {
      if (c[k] > bestN) {
        bestN = c[k]
        best = k
      }
    }
    sources[tag] = best
  }
  return { sources, verified }
}

// 弹窗一次最多回传多少个标签组（剩下的让界面自己分页/搜索，别把 IPC 撑爆）
const TAG_OVERVIEW_LIMIT = 400

function tagOverview(source = 'fav') {
  const { sources, verified } = computeTagMetaInfo(source)
  const groups = listTagStats(source, true)
  const families = listTagFamilies(source, 2)

  const counter = {
    total: groups.length,
    topic: 0,
    up: 0,
    desc: 0,
    unknown: 0,
    verified: 0,
    families: families.length
  }
  const items = groups.slice(0, TAG_OVERVIEW_LIMIT).map((g) => {
    const src = sources[g.name] || 'unknown'
    const isVerified = g.variants.some((v) => verified.has(v.name))
    if (counter[src] !== undefined) counter[src] += 1
    if (isVerified) counter.verified += 1
    return {
      name: g.name,
      count: g.count,
      variantCount: g.variantCount,
      variants: g.variants,
      source: src,
      verified: isVerified
    }
  })
  return { groups: items, families, counter }
}

// 标签改名 / 合并时，把 tag_meta 的键一起跟着挪，否则来源信息会对不上新名字。
// mapper 返回空串表示这个标签被删掉了，直接丢掉来源记录。
// 多个旧键并到同一个新键时，活动话题（topic）优先保留 —— 它的信息量最大。
function remapTagMeta(meta, mapper) {
  const out = {}
  for (const [k, v] of Object.entries(meta || {})) {
    const nk = mapper(k)
    if (!nk) continue
    if (!out[nk] || v === 'topic') out[nk] = v
  }
  return out
}

// 标签批量重命名 / 合并 / 删除（作用于整个分区）：
//   - toTag 非空：把 fromTags 全部替换成 toTag；目标标签原本已存在则自动合并去重
//   - toTag 为空：把 fromTags 从所有记录里移除（只删标签，不动视频本身）
// 全程走一个事务，返回实际被改动的记录条数。
function editTags(fromTags, toTag, source = 'fav') {
  const t = tableFor(source)
  const target = String(toTag == null ? '' : toTag).trim()
  const froms = (Array.isArray(fromTags) ? fromTags : [fromTags])
    .map((s) => String(s == null ? '' : s).trim())
    .filter(Boolean)
  if (froms.length === 0) return { error: '请先选择要处理的标签' }

  // 单标签重命名且名字没变：无需改动
  if (target && froms.length === 1 && froms[0] === target) {
    return { ok: true, updated: 0, mode: 'rename' }
  }

  const fromSet = new Set(froms)
  const rows = db.prepare(`SELECT id, tags, tag_meta FROM ${t}`).all()
  const updateStmt = db.prepare(`UPDATE ${t} SET tags = ?, tag_meta = ? WHERE id = ?`)
  let updated = 0

  const run = db.transaction(() => {
    for (const row of rows) {
      const current = safeParseTags(row.tags)
      const currentMeta = safeParseTagMeta(row.tag_meta)
      const next = []
      for (const tag of current) {
        if (fromSet.has(tag)) {
          // 合并进目标标签并去重；目标为空则相当于彻底删除该标签
          if (target && !next.includes(target)) next.push(target)
        } else if (!next.includes(tag)) {
          next.push(tag)
        }
      }
      const nextMeta = remapTagMeta(currentMeta, (k) => (fromSet.has(k) ? target : k))
      // 只有真的发生变化时才写回，避免把「本来就没变」的记录也算进改动数
      const same =
        next.length === current.length &&
        next.every((x, i) => x === current[i]) &&
        JSON.stringify(nextMeta) === JSON.stringify(currentMeta)
      if (!same) {
        updateStmt.run(JSON.stringify(next), JSON.stringify(nextMeta), row.id)
        updated++
      }
    }
  })
  run()

  return { ok: true, updated, mode: target ? 'rename' : 'delete' }
}

// ===== 统计面板 =====
// 分区整体统计：总数 / 总时长 / 已看未看 / 失效 / Top 标签 / Top UP主
function getStats(source = 'fav', topN = 12) {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT author, duration, watched, invalid, tags, tag_meta FROM ${t}`).all()

  let totalDuration = 0
  let watched = 0
  let invalid = 0
  const authorMap = new Map()
  const tagMap = new Map()
  const topicNames = new Set()

  for (const r of rows) {
    totalDuration += Number(r.duration) || 0
    if (r.watched === 1) watched++
    if (r.invalid === 1) invalid++
    const author = String(r.author || '').trim()
    if (author) authorMap.set(author, (authorMap.get(author) || 0) + 1)
    for (const tag of safeParseTags(r.tags)) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1)
    }
    for (const [k, v] of Object.entries(safeParseTagMeta(r.tag_meta))) {
      if (v === 'topic') topicNames.add(k)
    }
  }

  const topFrom = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, topN)

  // 标签先做相似整合再排行：否则「Python」「python」「Python教程」会各自占一行，Top 榜没参考价值
  const tagGroups = mergeSimilarTags(
    [...tagMap.entries()].map(([name, count]) => ({ name, count })),
    topicNames
  )

  return {
    total: rows.length,
    totalDuration,
    watched,
    unwatched: rows.length - watched,
    invalid,
    tagCount: tagGroups.length,
    authorCount: authorMap.size,
    topTags: tagGroups.slice(0, topN).map((g) => ({ name: g.name, count: g.count })),
    topAuthors: topFrom(authorMap)
  }
}

// ===== 他人分享：导出 / 导入 =====
// 导出用紧凑 JSON（不缩进）+ 简介截断，保证文件小而信息完整：
// 保留封面/作者/时长/分区/播放数据/标签/看没看/收录时间，导入后功能不打折。

const SHARE_TYPE = 'bili-fav-share'
const DESC_LIMIT = 200

function trimDesc(desc) {
  const s = String(desc || '')
  return s.length > DESC_LIMIT ? s.slice(0, DESC_LIMIT) : s
}

// 组装导出数据（不落盘，便于测试）
function buildExportPayload(source = 'fav', exporter = {}) {
  const list = listVideos(source)
  return {
    app: 'bilibili-collector',
    type: SHARE_TYPE,
    version: 1,
    exportedAt: Math.floor(Date.now() / 1000),
    fromSource: source === 'toview' ? '稍后再看' : source === 'shared' ? '分享导入' : '收藏',
    exporter: {
      uname: String(exporter.uname || '匿名用户'),
      mid: Number(exporter.mid) || 0
    },
    count: list.length,
    videos: list.map((v) => ({
      bvid: v.bvid,
      title: v.title,
      cover: v.cover,
      author: v.author,
      authorFace: v.authorFace,
      duration: v.duration,
      desc: trimDesc(v.desc),
      pubdate: v.pubdate,
      tname: v.tname,
      stat: v.stat,
      tags: v.tags,
      // v1.5.1 起随分享一起走：标签来源分类 + 平台分词（旧版本读到会忽略，不影响兼容）
      tagMeta: v.tagMeta || {},
      participle: Array.isArray(v.participle) ? v.participle : [],
      watched: v.watched,
      favTime: v.favTime
    }))
  }
}

// 导出当前分区：生成 JSON 并让用户选择保存位置
async function exportVideos(source = 'fav') {
  const login = await checkLogin()
  const payload = buildExportPayload(source, {
    uname: login.loggedIn ? login.uname : '匿名用户',
    mid: login.loggedIn ? login.mid : 0
  })
  if (payload.count === 0) return { error: '当前列表是空的，没有可导出的内容' }

  const stamp = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const dateStr = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
  const safeName = String(payload.exporter.uname || '匿名').replace(/[\\/:*?"<>|]/g, '_')
  const defaultName = `B站${payload.fromSource}-${safeName}-${dateStr}.json`

  const parent = BrowserWindow.getAllWindows()[0]
  const { canceled, filePath } = await dialog.showSaveDialog(parent || undefined, {
    title: '导出为分享文件',
    defaultPath: defaultName,
    filters: [{ name: 'B站收藏分享', extensions: ['json'] }]
  })
  if (canceled || !filePath) return { canceled: true }

  try {
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8')
  } catch (err) {
    return { error: err.message || '写入文件失败' }
  }
  return { ok: true, count: payload.count, filePath }
}

// 把他人分享的数据（已解析好的对象）导入到 shared 分区。
// 去重规则：同一 (bvid + 分享者) 只保留一条，重复导入不会膨胀。
function doImportShare(payload) {
  if (!payload || typeof payload !== 'object') {
    return { error: '文件内容不是有效的分享数据' }
  }
  const list = Array.isArray(payload.videos) ? payload.videos : null
  if (!list) return { error: '文件格式不正确：缺少 videos 列表' }
  if (list.length === 0) return { error: '这个分享文件里没有视频' }

  const exporter = payload.exporter || {}
  const fromName = String(exporter.uname || payload.exporterName || '未知分享者').slice(0, 60)
  const fromMid = Number(exporter.mid) || 0

  const findStmt = db.prepare('SELECT id FROM shared WHERE bvid = ? AND share_from = ?')
  const insertStmt = db.prepare(
    `INSERT INTO shared
      (bvid, url, title, cover, author, author_face, duration, description, pubdate, tname, stat, tags, tag_meta, participle, watched, fav_time, share_from, share_mid)
     VALUES
      (@bvid, @url, @title, @cover, @author, @authorFace, @duration, @description, @pubdate, @tname, @stat, @tags, @tagMeta, @participle, @watched, @favTime, @shareFrom, @shareMid)`
  )

  let added = 0
  let skipped = 0
  const run = db.transaction((items) => {
    for (const v of items) {
      if (!v || !v.bvid) continue
      if (findStmt.get(v.bvid, fromName)) {
        skipped++
        continue
      }
      insertStmt.run({
        bvid: v.bvid,
        url: v.url || `https://www.bilibili.com/video/${v.bvid}`,
        title: v.title || '（无标题）',
        cover: v.cover || '',
        author: v.author || '',
        authorFace: v.authorFace || '',
        duration: Number(v.duration) || 0,
        description: v.desc || '',
        pubdate: Number(v.pubdate) || 0,
        tname: v.tname || '',
        stat: JSON.stringify(v.stat || {}),
        tags: JSON.stringify(Array.isArray(v.tags) ? v.tags : []),
        tagMeta: JSON.stringify(v.tagMeta && typeof v.tagMeta === 'object' ? v.tagMeta : {}),
        participle: JSON.stringify(Array.isArray(v.participle) ? v.participle : []),
        watched: v.watched ? 1 : 0,
        favTime: Number(v.favTime) || 0,
        shareFrom: fromName,
        shareMid: fromMid
      })
      added++
    }
  })
  run(list)

  return { ok: true, added, skipped, total: list.length, from: fromName }
}

// 「打开文件」导入：弹系统文件对话框选 JSON，读取并入库
async function pickAndImportShare() {
  const parent = BrowserWindow.getAllWindows()[0]
  const { canceled, filePaths } = await dialog.showOpenDialog(parent || undefined, {
    title: '选择要导入的分享文件',
    filters: [{ name: 'B站收藏分享', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (canceled || !filePaths || filePaths.length === 0) return { canceled: true }

  let payload
  try {
    const text = fs.readFileSync(filePaths[0], 'utf8')
    payload = JSON.parse(text)
  } catch (err) {
    return { error: `读取失败：${err.message || '文件不是有效的 JSON'}` }
  }

  const r = doImportShare(payload)
  return { ...r, fileName: basename(filePaths[0]) }
}

// ===== 失效视频检测 =====
// 逐条请求 B 站 view 接口，判断稿件是否已失效（被删 / 不可见 / 仅 UP 主可见等）。
// 采集量大，用「小并发 + 每条间隔」控制频率，尽量别触发风控。
// 原则：只写入「明确失效」的标记；网络异常等无法确认的情况记为 unknown，
// 不改动原有标记——宁可不标，也不误伤正常收藏。

// 单条判定，返回 'normal' | 'invalid' | 'unknown'
async function probeBvidState(bvid) {
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
    const data = await res.json()
    if (data.code === 0) return 'normal'
    // -404 稿件不存在；62002 稿件不可见；62012 稿件仅 UP 主可见；-403 权限不足
    if ([-404, 62002, 62012, -403].includes(data.code)) return 'invalid'
    // 62004 稿件审核中等其它情况暂不判定，保持未知
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// 检测指定分区：返回 { ok, total, checked, invalid, unknown }
// onProgress 回调形如 { checked, total, invalid }，用于前端显示进度
async function checkInvalidVideos(source = 'fav', onProgress) {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT id, bvid FROM ${t}`).all()
  const total = rows.length
  if (total === 0) return { ok: true, total: 0, checked: 0, invalid: 0, unknown: 0 }

  const validIds = []
  const invalidIds = []
  let checked = 0
  let unknown = 0

  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= rows.length) return
      const state = await probeBvidState(rows[i].bvid)
      checked++
      if (state === 'invalid') invalidIds.push(rows[i].id)
      else if (state === 'normal') validIds.push(rows[i].id)
      else unknown++
      if (typeof onProgress === 'function') {
        onProgress({ checked, total, invalid: invalidIds.length })
      }
      // 控频：每条之间稍作停顿
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  const workers = Math.min(4, rows.length)
  await Promise.all(Array.from({ length: workers }, worker))

  // 一次性写回：先清掉本轮的旧标记，再标记确认失效的（事务保证原子性）
  const clearStmt = db.prepare(`UPDATE ${t} SET invalid = 0 WHERE id = ?`)
  const markStmt = db.prepare(`UPDATE ${t} SET invalid = 1 WHERE id = ?`)
  const writeBack = db.transaction(() => {
    for (const id of validIds) clearStmt.run(id)
    for (const id of invalidIds) markStmt.run(id)
  })
  writeBack()

  return { ok: true, total, checked, invalid: invalidIds.length, unknown }
}

// ===== 视频下载（DASH 音视频分流 + ffmpeg 合并）=====
// 合规说明：只下载用户本人有权观看的公开视频，仅限个人自用，不绕过任何付费/地区限制。
// 技术要点：B 站高清（1080P 起）走 DASH 格式，音视频是分离的两条 m4s 流，
// 下载后必须用 ffmpeg -c copy 无损合并；拉 CDN 流必须带 Referer，否则 403。

// DASH 清晰度档位表（接口未提供 accept_description 时的本地兜底文案）
const QUALITY_LABELS = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P60 高帧率',
  112: '1080P+ 高码率',
  80: '1080P 高清',
  74: '720P60 高帧率',
  64: '720P 高清',
  32: '480P 清晰',
  16: '360P 流畅',
  6: '240P 极速'
}
const DEFAULT_QN = 80 // 默认目标 1080P；账号拿不到时自动往下降档

// 播放地址接口的错误码文案（与搜索接口同一套风控错误码）
const PLAYURL_HINTS = {
  '-404': '视频不存在或已被删除',
  '-403': '没有权限访问该视频（可能是付费/充电专属，或需要登录）',
  '-10403': '该视频在当前地区不可观看',
  '-352': '触发了风控校验，请等几分钟再试，不要连续快速下载',
  '-412': '当前 IP 已被 B 站拦截，请等一段时间或换个网络再试',
  '-101': '未登录，请先登录 B 站'
}

// 定位 ffmpeg：优先用打包进 resources 的副本，其次退回系统 PATH
function resolveFfmpeg() {
  const candidates = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'))
  candidates.push(join(__dirname, '../../resources/ffmpeg/ffmpeg.exe')) // 开发态：项目 resources 目录
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* 忽略探测失败 */
    }
  }
  return 'ffmpeg' // 退回系统 PATH（开发机已安装时直接可用）
}

// 播放地址短时缓存：避免「取清晰度列表」与「开始下载」两次重复请求同一接口
const playUrlCache = new Map()
const PLAYURL_TTL = 2 * 60 * 1000

// 取 cid：优先用库里存的，没有再请求 view 接口（分P取首P），拿到后回填数据库
async function ensureCid(bvid, source = 'fav') {
  const t = tableFor(source)
  const row = db.prepare(`SELECT id, cid FROM ${t} WHERE bvid = ?`).get(bvid)
  if (row && row.cid) return row.cid

  let data
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
    data = await res.json()
  } catch (err) {
    throw new Error(`获取视频信息失败：${err.message || '网络错误'}`)
  }
  if (data.code !== 0) {
    throw new Error(PLAYURL_HINTS[String(data.code)] || data.message || '获取视频信息失败')
  }
  const d = data.data || {}
  const cid = Number(d.cid || (d.pages && d.pages[0] && d.pages[0].cid)) || 0
  if (!cid) throw new Error('未能取到视频 cid')
  if (row) db.prepare(`UPDATE ${t} SET cid = ? WHERE bvid = ?`).run(cid, bvid)
  return cid
}

// 请求播放地址（DASH）。qn=127 一次性拿回账号可用的全部清晰度档位，后续按用户所选往下筛。
async function fetchDash(bvid, source = 'fav') {
  const hit = playUrlCache.get(bvid)
  if (hit && Date.now() - hit.at < PLAYURL_TTL) return hit.payload

  const cid = await ensureCid(bvid, source)

  let mixinKey
  try {
    mixinKey = await getWbiMixinKey()
  } catch (err) {
    return { error: err.message || '签名准备失败' }
  }

  const query = signWbi({ bvid, cid, qn: 127, fnval: 4048, fnver: 0, fourk: 1 }, mixinKey)

  let data
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/player/wbi/playurl?${query}`)
    data = await res.json()
  } catch (err) {
    return { error: `请求播放地址失败：${err.message || '网络错误'}` }
  }

  if (data.code !== 0) {
    return {
      error: PLAYURL_HINTS[String(data.code)] || data.message || '获取播放地址失败',
      code: data.code
    }
  }

  const d = data.data || {}
  if (!d.dash) {
    return { error: '未取到 DASH 流。高清下载需要登录态，请先登录 B 站后重试' }
  }

  const payload = {
    ok: true,
    cid,
    duration: d.dash.duration || 0,
    accepts: (d.accept_quality || []).map((q, i) => ({
      qn: q,
      label: (d.accept_description && d.accept_description[i]) || QUALITY_LABELS[q] || `清晰度 ${q}`
    })),
    video: d.dash.video || [],
    audio: d.dash.audio || []
  }
  playUrlCache.set(bvid, { at: Date.now(), payload })
  return payload
}

// 从一组流里挑清晰度不超过 maxQn 的最高档（同档位取码率最高的那条）
function pickStream(list, maxQn) {
  const avail = (list || []).filter((s) => s && (s.baseUrl || s.base_url))
  if (avail.length === 0) return null
  let best = null
  for (const s of avail) {
    if (Number(s.id) > maxQn) continue
    const better =
      !best ||
      Number(s.id) > Number(best.id) ||
      (Number(s.id) === Number(best.id) && Number(s.bandwidth || 0) > Number(best.bandwidth || 0))
    if (better) best = s
  }
  // 兜底：若所有流都超过上限（理论上不会），退回最低档
  if (!best) best = avail.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b))
  return best
}

// 取一条流的候选地址（主地址 + 备用镜像），下载失败时依次重试
function streamUrls(stream) {
  const main = stream.baseUrl || stream.base_url || ''
  const backups = stream.backupUrl || stream.backup_url || []
  return [main, ...backups].filter(Boolean)
}

// 流式下载单个地址到本地文件，边写边回报进度。带 Referer 过防盗链。
async function downloadStream(urls, dest, onProgress, signal) {
  let lastErr = null
  for (const url of urls) {
    try {
      const res = await net.fetch(url, {
        headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' },
        signal
      })
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      const total = Number(res.headers.get('content-length')) || 0
      const out = fs.createWriteStream(dest)
      let received = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (!out.write(Buffer.from(value))) {
          await new Promise((resolve) => out.once('drain', resolve))
        }
        if (typeof onProgress === 'function') onProgress(received, total)
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      return { ok: true, bytes: received }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
      lastErr = err
    }
  }
  throw lastErr || new Error('下载失败')
}

// 用 ffmpeg 把分离的音视频流合并为 mp4。-c copy = 流拷贝，不重编码、无损、秒级完成。
function mergeWithFfmpeg(videoPath, audioPath, outPath) {
  const ffmpeg = resolveFfmpeg()
  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath
  ]
  const r = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8' })
  if (r.error) throw new Error(`未找到 ffmpeg，无法合并音视频：${r.error.message}`)
  if (r.status !== 0) {
    const tail = String(r.stderr || '')
      .trim()
      .split('\n')
      .slice(-2)
      .join(' ')
    throw new Error(`ffmpeg 合并失败：${tail || `退出码 ${r.status}`}`)
  }
  if (!fs.existsSync(outPath)) throw new Error('ffmpeg 未生成输出文件')
  return { ok: true }
}

// 文件名清洗：去掉 Windows 不允许的字符，保留 BV 号便于溯源
function safeFileName(title, bvid) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${cleaned || 'video'}-${bvid}.mp4`
}

// 读取某视频可用的清晰度列表（供前端渲染选择弹窗）
async function getVideoQualities(bvid, source = 'fav') {
  if (!bvid) return { error: '缺少 BV 号' }
  const dash = await fetchDash(bvid, source)
  if (dash.error) return dash
  const have = new Set((dash.video || []).map((s) => Number(s.id)))
  return {
    ok: true,
    cid: dash.cid,
    duration: dash.duration,
    defaultQn: DEFAULT_QN,
    qualities: dash.accepts.map((a) => ({
      qn: a.qn,
      label: a.label,
      available: have.has(Number(a.qn))
    }))
  }
}

// 下载单个视频：cid → playurl → 选流 → 下载两条 m4s → ffmpeg 合并 → 落盘
async function downloadVideo(bvid, opts = {}, onProgress, signal) {
  const { source = 'fav', qn = DEFAULT_QN, savePath } = opts
  if (!bvid) return { error: '缺少 BV 号' }
  if (!savePath) return { error: '未指定保存位置' }

  const dash = await fetchDash(bvid, source)
  if (dash.error) return dash

  const vStream = pickStream(dash.video, Number(qn) || DEFAULT_QN)
  const aStream = pickStream(dash.audio, 999999) // 音频一律取最高码率
  if (!vStream) return { error: '没有可用的视频流' }
  if (!aStream) return { error: '没有可用的音频流' }

  const tmpDir = fs.mkdtempSync(join(app.getPath('temp'), 'bili-dl-'))
  const vFile = join(tmpDir, 'video.m4s')
  const aFile = join(tmpDir, 'audio.m4s')
  const report = (stage, percent, extra) => {
    if (typeof onProgress === 'function') onProgress({ stage, percent, ...extra })
  }

  try {
    report('video', 0)
    await downloadStream(
      streamUrls(vStream),
      vFile,
      (received, total) => {
        report('video', total ? Math.min(99, Math.round((received / total) * 100)) : 0, {
          received,
          total
        })
      },
      signal
    )

    report('audio', 0)
    await downloadStream(
      streamUrls(aStream),
      aFile,
      (received, total) => {
        report('audio', total ? Math.min(99, Math.round((received / total) * 100)) : 0, {
          received,
          total
        })
      },
      signal
    )

    report('merging', 100)
    mergeWithFfmpeg(vFile, aFile, savePath)
    report('done', 100)

    return { ok: true, filePath: savePath, quality: Number(vStream.id) }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
  }
}

// 弹保存对话框返回目标路径（前端在下载前调用，用户取消则中止流程）
async function pickSavePath(defaultName) {
  const parent = BrowserWindow.getAllWindows()[0]
  const { canceled, filePath } = await dialog.showSaveDialog(parent || undefined, {
    title: '保存视频到',
    defaultPath: defaultName || 'video.mp4',
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
  })
  if (canceled || !filePath) return { canceled: true }
  return { ok: true, filePath }
}

// ===== 打开 B 站客户端 =====
// 客户端注册的自定义协议名为 `bilipc`，注册表命令形如 "D:\bilibili\哔哩哔哩.exe" "%1"。
// 这里直接读注册表拿到 exe 真实路径并启动它，绕开协议深链的不确定性。

// 打开 B 站网页版
function openWeb() {
  return shell
    .openExternal('https://www.bilibili.com')
    .then(() => ({ ok: true, mode: 'web' }))
    .catch(() => ({ error: '未能打开 B 站网页' }))
}

// 打开 B 站客户端；没装或启动失败就退回网页版。
// 注意：客户端安装路径含中文（如 "D:\bilibili\哔哩哔哩.exe"），reg query 输出是 GBK 编码，
// 用 Node 按 UTF-8 读会乱码。所以这里让 PowerShell 全程在内部用 Unicode 处理：
// 读注册表 -> 提取 exe 路径 -> 启动，只把 exit code 返回给 Node，中文路径不跨进程传输。
//   exit 0 = 成功启动客户端；exit 1 = 未安装（无协议键）；exit 2 = 路径存在但 exe 缺失
function openBilibiliApp() {
  if (process.platform !== 'win32') return openWeb()

  const script = `
$keys = @(
  'HKCU:\\Software\\Classes\\bilipc\\shell\\open\\command',
  'HKLM:\\SOFTWARE\\Classes\\bilipc\\shell\\open\\command'
)
$exe = $null
foreach ($k in $keys) {
  try {
    $key = Get-Item -Path $k -ErrorAction Stop
    $cmd = [string]$key.GetValue('')
    if ($cmd -match '"([^"]+\\.exe)"') { $exe = $Matches[1]; break }
  } catch {}
}
if (-not $exe) { exit 1 }
if (-not (Test-Path -LiteralPath $exe)) { exit 2 }
Start-Process -FilePath $exe
exit 0
`

  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })

  if (r.status === 0) return { ok: true, mode: 'client' }
  return openWeb()
}

// ===== 修复 B 站图床防盗链 =====
// B 站图片域名 *.hdslb.com 有防盗链（要求 Referer 为 bilibili 域名），
// Electron 里 <img> 加载时默认不带正确 Referer 会被 403 导致封面/头像裂图。
// 这里拦截渲染进程发往 hdslb.com 的请求，强制补上 Referer。
function setupImageReferer() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.hdslb.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://www.bilibili.com/'
      callback({ requestHeaders: details.requestHeaders })
    }
  )
}

// ===== B 站登录 + 收藏夹导入 =====
// 通过 Electron 的 Chromium 网络栈（net.fetch）发请求，自动携带 defaultSession 里的
// 登录 Cookie 与真实浏览器环境；只拉取用户自己的收藏夹数据。

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// 用 Chromium 网络栈发请求（自动带登录 Cookie，UA 手动伪装成浏览器）
function biliFetch(url) {
  return net.fetch(url, {
    headers: {
      'User-Agent': BILI_UA,
      Referer: 'https://www.bilibili.com/'
    }
  })
}

// 检查登录状态：先查 Cookie 判断是否登录，再用 nav 接口拿昵称/头像/mid
async function checkLogin() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://bilibili.com' })
    if (!cookies.some((c) => c.name === 'SESSDATA')) {
      return { loggedIn: false }
    }
  } catch {
    return { loggedIn: false }
  }

  try {
    const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav')
    const data = await res.json()
    if (data.code === 0 && data.data) {
      return {
        loggedIn: true,
        uname: data.data.uname || '',
        face: data.data.face || '',
        mid: data.data.mid || 0
      }
    }
  } catch {
    // nav 接口失败则走 Cookie 兜底
  }

  try {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://bilibili.com' })
    const dede = cookies.find((c) => c.name === 'DedeUserID')
    return { loggedIn: true, uname: '', face: '', mid: dede ? Number(dede.value) : 0 }
  } catch {
    return { loggedIn: true, uname: '', face: '', mid: 0 }
  }
}

let loginWindow = null

// 打开登录窗口，返回 Promise，登录成功（检测到 SESSDATA）后 resolve
function openLogin() {
  return new Promise((resolve) => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus()
      return
    }

    const parent = BrowserWindow.getAllWindows()[0]
    loginWindow = new BrowserWindow({
      width: 420,
      height: 640,
      title: '登录 B 站',
      autoHideMenuBar: true,
      parent: parent || undefined,
      webPreferences: { sandbox: false }
    })

    loginWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    loginWindow.loadURL('https://passport.bilibili.com/login')
    loginWindow.on('closed', () => {
      loginWindow = null
    })

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
      resolve(result)
    }

    // 轮询 Cookie，检测到 SESSDATA 即认为登录成功
    const timer = setInterval(async () => {
      try {
        const cookies = await session.defaultSession.cookies.get({ url: 'https://bilibili.com' })
        if (cookies.some((c) => c.name === 'SESSDATA')) {
          finish(await checkLogin())
        }
      } catch {
        // 忽略，继续轮询
      }
    }, 1500)

    setTimeout(() => finish({ error: '登录超时，请重试' }), 180000)
  })
}

// 退出登录：清除 defaultSession 的 Cookie
async function logout() {
  try {
    await session.defaultSession.clearStorageData({ storages: ['cookies'] })
  } catch {
    // 忽略清理失败
  }
  return { ok: true }
}

// 获取当前用户创建的所有收藏夹
async function listFavFolders() {
  const login = await checkLogin()
  if (!login.loggedIn) return { error: '未登录，请先登录 B 站' }

  try {
    const res = await biliFetch(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${login.mid}`
    )
    const data = await res.json()
    if (data.code !== 0) {
      return { error: data.message || `获取收藏夹失败（code ${data.code}）` }
    }
    const list = (data.data && data.data.list) || []
    return list.map((f) => ({
      id: f.id || f.fid,
      title: f.title || '（未命名收藏夹）',
      mediaCount: f.media_count || 0
    }))
  } catch (err) {
    return { error: err.message || '获取收藏夹失败' }
  }
}

// 分页拉取指定收藏夹的视频并入库（type=2 为视频，页间延时控频）
async function importFavorites(mediaId, onTagsProgress) {
  const login = await checkLogin()
  if (!login.loggedIn) return { error: '未登录，请先登录 B 站' }
  if (!mediaId) return { error: '缺少收藏夹 ID' }

  let pn = 1
  let added = 0
  let skipped = 0
  let total = 0
  let tagsFilled = 0
  let tagsBlocked = false

  for (;;) {
    let data
    try {
      const res = await biliFetch(
        `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${pn}&ps=20&platform=web`
      )
      data = await res.json()
    } catch (err) {
      return { error: err.message || '拉取收藏夹失败', added, skipped, total }
    }

    if (data.code !== 0) {
      return { error: data.message || `拉取收藏夹失败（code ${data.code}）`, added, skipped, total }
    }

    // 只导入视频（type 2 = 视频；12 = 音频等其它类型跳过）
    const medias = ((data.data && data.data.medias) || []).filter((m) => m && m.type === 2 && m.bvid)

    // 这一页里「标签信息不全」的视频：新条目，或已入库但缺标签 / 缺来源分类的旧记录。
    // 抓全了的直接跳过 —— 既不覆盖你的标签，也不浪费请求。
    const needTags = medias.filter((m) => needsTagFetch(getByBvid(m.bvid, 'fav'))).map((m) => m.bvid)

    const { byBvid, blocked } = needTags.length
      ? await fetchTagsBatch(needTags, onTagsProgress)
      : { byBvid: new Map() }
    if (blocked) tagsBlocked = true

    for (const m of medias) {
      const video = {
        bvid: m.bvid,
        url: `https://www.bilibili.com/video/${m.bvid}`,
        title: m.title || '（无标题）',
        cover: m.cover || '',
        author: (m.upper && m.upper.name) || '',
        authorFace: (m.upper && m.upper.face) || '',
        duration: m.duration || 0,
        cid: m.cid || 0,
        desc: m.intro || '',
        pubdate: m.pubtime || 0,
        tname: '',
        stat: {
          view: (m.cnt_info && m.cnt_info.play) || 0,
          danmaku: (m.cnt_info && m.cnt_info.danmaku) || 0,
          like: 0,
          coin: 0,
          favorite: (m.cnt_info && m.cnt_info.collect) || 0,
          share: 0,
          reply: 0
        },
        // B 站原始标签（带来源分类：UP 主频道 / 活动话题）作为默认标签；抓不到就是空数组
        ...tagFieldsOf(byBvid.get(m.bvid)),
        // B 站收藏时间（秒级时间戳），用于「最新收藏 → 最久之前」排序
        favTime: m.fav_time || 0
      }

      const r = addVideo(video, 'fav')
      if (r.exists) {
        skipped++
        // 已存在：刷新为 B 站真实收藏时间（旧数据 fav_time 为 0，重新导入一次即可修正排序）
        if (m.fav_time && r.video.favTime !== m.fav_time) {
          db.prepare('UPDATE videos SET fav_time = ? WHERE id = ?').run(m.fav_time, r.video.id)
        }
        // 旧数据没存 cid，重新导入时顺手补上（下载功能需要）
        if (m.cid && !r.video.cid) {
          db.prepare('UPDATE videos SET cid = ? WHERE id = ?').run(m.cid, r.video.id)
        }
        // 旧数据字段不全：把这次抓到的补上（重新导入一次即可给存量数据补标签与来源）
        const got = byBvid.get(m.bvid)
        if (got && backfillTagFields('videos', r.video.id, got, r.video)) tagsFilled++
      } else added++
      total++
    }

    if (!data.data || !data.data.has_more) break
    pn++
    // 控频：翻页之间留 1.5 秒，避免触发风控
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  return { ok: true, added, skipped, total, tagsFilled, tagsBlocked }
}

// 拉取「稍后再看」列表并入库到 toview 分区。
// 接口 /x/v2/history/toview 一次返回全部（上限 100 条），按添加时间排列。
async function importWatchLater(onTagsProgress) {
  const login = await checkLogin()
  if (!login.loggedIn) return { error: '未登录，请先登录 B 站' }

  let data
  try {
    const res = await biliFetch('https://api.bilibili.com/x/v2/history/toview')
    data = await res.json()
  } catch (err) {
    return { error: err.message || '拉取稍后再看失败' }
  }

  if (data.code !== 0) {
    return { error: data.message || `拉取稍后再看失败（code ${data.code}）` }
  }

  const list = ((data.data && data.data.list) || []).filter((m) => m && m.bvid)
  let added = 0
  let skipped = 0
  let total = 0
  let tagsFilled = 0
  let tagsBlocked = false

  // 只给「标签信息不全」的条目抓（新条目 + 缺标签 / 缺来源分类的旧记录），抓全了的跳过
  const needTags = list.filter((m) => needsTagFetch(getByBvid(m.bvid, 'toview'))).map((m) => m.bvid)

  const { byBvid, blocked } = needTags.length
    ? await fetchTagsBatch(needTags, onTagsProgress)
    : { byBvid: new Map() }
  if (blocked) tagsBlocked = true

  for (const m of list) {
    const stat = m.stat || {}
    const video = {
      bvid: m.bvid,
      url: `https://www.bilibili.com/video/${m.bvid}`,
      title: m.title || '（无标题）',
      cover: m.pic || '',
      author: (m.owner && m.owner.name) || '',
      authorFace: (m.owner && m.owner.face) || '',
      duration: m.duration || 0,
      cid: m.cid || 0,
      desc: m.desc || '',
      pubdate: m.pubdate || 0,
      tname: m.tname || '',
      stat: {
        view: stat.view || 0,
        danmaku: stat.danmaku || 0,
        like: stat.like || 0,
        coin: stat.coin || 0,
        favorite: stat.fav || 0,
        share: stat.share || 0,
        reply: stat.reply || 0
      },
      // B 站原始标签（带来源分类）作为默认标签；抓不到就是空数组
      ...tagFieldsOf(byBvid.get(m.bvid)),
      // 加入稍后再看的时间（add_at），用于「最新 → 最久之前」排序
      favTime: m.add_at || m.ctime || 0
    }

    const r = addVideo(video, 'toview')
    if (r.exists) {
      skipped++
      if (m.add_at && r.video.favTime !== m.add_at) {
        db.prepare('UPDATE toview SET fav_time = ? WHERE id = ?').run(m.add_at, r.video.id)
      }
      if (m.cid && !r.video.cid) {
        db.prepare('UPDATE toview SET cid = ? WHERE id = ?').run(m.cid, r.video.id)
      }
      // 旧数据字段不全：把这次抓到的补上
      const got = byBvid.get(m.bvid)
      if (got && backfillTagFields('toview', r.video.id, got, r.video)) tagsFilled++
    } else added++
    total++
  }

  return { ok: true, added, skipped, total, tagsFilled, tagsBlocked }
}

// ===== 创建窗口 =====
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'B站收藏管理',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ===== 处理抓取请求 =====
ipcMain.handle('fetch-video-info', async (_event, url) => {
  try {
    return await fetchVideoInfo(url)
  } catch (err) {
    return { error: err.message || '抓取失败' }
  }
})

// ===== 存储相关 IPC =====
// 统一的错误捕获包装，避免异常穿透到渲染进程
function safe(fn) {
  return (_event, ...args) => {
    try {
      return fn(...args)
    } catch (err) {
      return { error: err.message || '操作失败' }
    }
  }
}

ipcMain.handle('save-video', safe((video, source) => addVideo(video, source)))
ipcMain.handle('list-videos', safe((source) => listVideos(source)))
ipcMain.handle('search-videos', safe((keyword, source) => searchVideos(keyword, source)))
ipcMain.handle('update-video', safe((id, fields, source) => updateVideo(id, fields, source)))
ipcMain.handle('delete-video', safe((id, source) => deleteVideo(id, source)))
ipcMain.handle('batch-add-tags', safe((ids, tags, source) => batchAddTags(ids, tags, source)))
ipcMain.handle('batch-delete-videos', safe((ids, source) => batchDeleteVideos(ids, source)))

// 标签管理 + 统计面板
ipcMain.handle('list-tag-stats', safe((source, merge) => listTagStats(source, merge !== false)))
ipcMain.handle('merge-similar-tags', safe((source) => mergeSimilarTagsInDb(source)))
// 标签总览（来源分类 + 平台认证标记 + 共前缀族），标签管理弹窗一次拿齐
ipcMain.handle('tag-overview', safe((source) => tagOverview(source)))
ipcMain.handle('list-tag-families', safe((source) => listTagFamilies(source)))
ipcMain.handle('edit-tags', safe((fromTags, toTag, source) => editTags(fromTags, toTag, source)))
ipcMain.handle('get-stats', safe((source) => getStats(source)))

// 失效视频检测（耗时较长，检测过程中通过 'check-invalid-progress' 事件回报进度）
ipcMain.handle('check-invalid', async (event, source) => {
  try {
    return await checkInvalidVideos(source, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('check-invalid-progress', p)
    })
  } catch (err) {
    return { error: err.message || '检测失败' }
  }
})

// ===== 视频下载 IPC =====
// 每个下载任务配一个 AbortController，支持中途取消
const downloadJobs = new Map()

ipcMain.handle('get-video-qualities', async (_event, bvid, source) => {
  try {
    return await getVideoQualities(bvid, source)
  } catch (err) {
    return { error: err.message || '获取清晰度失败' }
  }
})

ipcMain.handle('pick-save-path', async (_event, defaultName) => {
  try {
    return await pickSavePath(defaultName)
  } catch (err) {
    return { error: err.message || '选择保存位置失败' }
  }
})

// 开始下载；过程中通过 'download-progress' 事件回报 { jobId, stage, percent, ... }
ipcMain.handle('download-video', async (event, payload) => {
  const { bvid, source, qn, savePath, jobId } = payload || {}
  const controller = new AbortController()
  if (jobId) downloadJobs.set(jobId, controller)
  try {
    return await downloadVideo(
      bvid,
      { source, qn, savePath },
      (p) => {
        if (jobId && !event.sender.isDestroyed()) {
          event.sender.send('download-progress', { jobId, ...p })
        }
      },
      controller.signal
    )
  } catch (err) {
    if (err && err.name === 'AbortError') return { canceled: true }
    return { error: err.message || '下载失败' }
  } finally {
    if (jobId) downloadJobs.delete(jobId)
  }
})

ipcMain.handle('cancel-download', (_event, jobId) => {
  const c = downloadJobs.get(jobId)
  if (c) {
    c.abort()
    return { ok: true }
  }
  return { ok: false }
})

// 打开 B 站客户端（没装则退回网页）
ipcMain.handle('open-bilibili', () => openBilibiliApp())

// 全站搜索（走 wbi 签名）+ 搜索结果入库到「搜索列表」分区
ipcMain.handle('search-bili', async (_event, keyword) => {
  try {
    return await searchBili(keyword)
  } catch (err) {
    return { error: err.message || '搜索失败' }
  }
})
ipcMain.handle('import-search-items', safe((items) => importSearchItems(items)))

// 检查更新 + 打开外部链接（下载页 / Release 页）
ipcMain.handle('check-update', async (_event, manual) => {
  try {
    return await checkUpdate(!!manual)
  } catch (err) {
    return { ok: false, url: `https://github.com/${REPO_SLUG}/releases`, error: err.message || '检查更新失败' }
  }
})
ipcMain.handle('open-external', (_event, url) => {
  const u = String(url || '')
  if (!/^https?:\/\//i.test(u)) return { error: '链接不合法' }
  shell.openExternal(u)
  return { ok: true }
})

// B 站登录 + 收藏夹/稍后再看导入
ipcMain.handle('check-login', () => checkLogin())
ipcMain.handle('open-login', () => openLogin())
ipcMain.handle('logout', () => logout())
ipcMain.handle('list-fav-folders', () => listFavFolders())
// 导入收藏夹 / 稍后再看：会把视频在 B 站的原始标签一并抓下来作为「默认标签」。
// 抓标签阶段通过 'import-tags-progress' 事件回报进度（{ done, total }）。
ipcMain.handle('import-favorites', async (event, mediaId) => {
  try {
    return await importFavorites(mediaId, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('import-tags-progress', p)
    })
  } catch (err) {
    return { error: err.message || '导入收藏夹失败' }
  }
})
ipcMain.handle('import-watch-later', async (event) => {
  try {
    return await importWatchLater((p) => {
      if (!event.sender.isDestroyed()) event.sender.send('import-tags-progress', p)
    })
  } catch (err) {
    return { error: err.message || '拉取稍后再看失败' }
  }
})

// 导出 / 导入他人分享
ipcMain.handle('export-videos', async (_event, source) => {
  try {
    return await exportVideos(source)
  } catch (err) {
    return { error: err.message || '导出失败' }
  }
})
ipcMain.handle('pick-share-file', async () => {
  try {
    return await pickAndImportShare()
  } catch (err) {
    return { error: err.message || '导入失败' }
  }
})
ipcMain.handle('import-share-data', (_event, payload) => {
  try {
    return doImportShare(payload)
  } catch (err) {
    return { error: err.message || '导入失败' }
  }
})

app.whenReady().then(() => {
  initDb()
  setupImageReferer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 导出内部纯函数，供端到端测试断言（不影响主进程运行）
module.exports = {
  getMixinKey,
  signWbi,
  stripHtml,
  normalizePic,
  parseDurationText,
  compareVersion,
  importSearchItems,
  extractWbiKey,
  pickStream,
  safeFileName,
  normalizeTagKey,
  mergeSimilarTags,
  listTagStats,
  mergeSimilarTagsInDb,
  // v1.5.1：来源分类 + 平台分词交叉验证 + 共前缀族
  topicsFromDesc,
  clusterByCommonPrefix,
  listTagFamilies,
  collectTopicNames,
  computeTagMetaInfo,
  tagOverview,
  tagFieldsOf,
  needsTagFetch
}

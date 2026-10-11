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
  try {
    const json = extractInitialState(html)
    if (json) {
      const state = JSON.parse(json)
      videoData = state.videoData || null
    }
  } catch {
    videoData = null
  }

  const owner = (videoData && videoData.owner) || {}
  const stat = (videoData && videoData.stat) || {}

  return {
    bvid,
    url,
    title: title || (videoData && videoData.title) || '（未能获取标题）',
    cover: cover || (videoData && videoData.pic) || '',
    author: owner.name || authorMeta || '',
    authorFace: owner.face || '',
    duration: (videoData && videoData.duration) || 0,
    desc: (videoData && videoData.desc) || '',
    pubdate: (videoData && videoData.pubdate) || 0,
    tname: (videoData && videoData.tname) || '',
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
      description TEXT DEFAULT '',
      pubdate     INTEGER DEFAULT 0,
      tname       TEXT DEFAULT '',
      stat        TEXT DEFAULT '{}',
      tags        TEXT DEFAULT '[]',
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
      description TEXT DEFAULT '',
      pubdate     INTEGER DEFAULT 0,
      tname       TEXT DEFAULT '',
      stat        TEXT DEFAULT '{}',
      tags        TEXT DEFAULT '[]',
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
    ['description', "TEXT DEFAULT ''"],
    ['pubdate', 'INTEGER DEFAULT 0'],
    ['tname', "TEXT DEFAULT ''"],
    ['stat', "TEXT DEFAULT '{}'"],
    ['tags', "TEXT DEFAULT '[]'"],
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
    desc: row.description || '',
    pubdate: row.pubdate || 0,
    tname: row.tname || '',
    stat: safeParseStat(row.stat),
    tags: safeParseTags(row.tags),
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
    authorFace = '',
    duration = 0,
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
        (bvid, url, title, cover, author, author_face, duration, description, pubdate, tname, stat, tags, fav_time)
       VALUES
        (@bvid, @url, @title, @cover, @author, @authorFace, @duration, @description, @pubdate, @tname, @stat, @tags, @favTime)`
    )
    .run({
      bvid,
      url,
      title,
      cover,
      author,
      authorFace,
      duration,
      description: desc,
      pubdate,
      tname,
      stat: JSON.stringify(stat),
      tags: JSON.stringify(tags),
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
      tags: []
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
// 聚合某分区的全部标签及使用次数（按次数倒序，同次数按名称排）
function listTagStats(source = 'fav') {
  const t = tableFor(source)
  const rows = db.prepare(`SELECT tags FROM ${t}`).all()
  const map = new Map()
  for (const r of rows) {
    for (const tag of safeParseTags(r.tags)) {
      map.set(tag, (map.get(tag) || 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
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
  const rows = db.prepare(`SELECT id, tags FROM ${t}`).all()
  const updateStmt = db.prepare(`UPDATE ${t} SET tags = ? WHERE id = ?`)
  let updated = 0

  const run = db.transaction(() => {
    for (const row of rows) {
      const current = safeParseTags(row.tags)
      const next = []
      for (const tag of current) {
        if (fromSet.has(tag)) {
          // 合并进目标标签并去重；目标为空则相当于彻底删除该标签
          if (target && !next.includes(target)) next.push(target)
        } else if (!next.includes(tag)) {
          next.push(tag)
        }
      }
      // 只有在标签真的发生变化时才写回，避免把「本来就没变」的记录也算进改动数
      const same = next.length === current.length && next.every((t, i) => t === current[i])
      if (!same) {
        updateStmt.run(JSON.stringify(next), row.id)
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
  const rows = db.prepare(`SELECT author, duration, watched, invalid, tags FROM ${t}`).all()

  let totalDuration = 0
  let watched = 0
  let invalid = 0
  const authorMap = new Map()
  const tagMap = new Map()

  for (const r of rows) {
    totalDuration += Number(r.duration) || 0
    if (r.watched === 1) watched++
    if (r.invalid === 1) invalid++
    const author = String(r.author || '').trim()
    if (author) authorMap.set(author, (authorMap.get(author) || 0) + 1)
    for (const tag of safeParseTags(r.tags)) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1)
    }
  }

  const topFrom = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, topN)

  return {
    total: rows.length,
    totalDuration,
    watched,
    unwatched: rows.length - watched,
    invalid,
    tagCount: tagMap.size,
    authorCount: authorMap.size,
    topTags: topFrom(tagMap),
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
      (bvid, url, title, cover, author, author_face, duration, description, pubdate, tname, stat, tags, watched, fav_time, share_from, share_mid)
     VALUES
      (@bvid, @url, @title, @cover, @author, @authorFace, @duration, @description, @pubdate, @tname, @stat, @tags, @watched, @favTime, @shareFrom, @shareMid)`
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
async function importFavorites(mediaId) {
  const login = await checkLogin()
  if (!login.loggedIn) return { error: '未登录，请先登录 B 站' }
  if (!mediaId) return { error: '缺少收藏夹 ID' }

  let pn = 1
  let added = 0
  let skipped = 0
  let total = 0

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

    const medias = (data.data && data.data.medias) || []
    for (const m of medias) {
      // 只导入视频（type 2 = 视频；12 = 音频等其它类型跳过）
      if (m.type !== 2) continue
      if (!m.bvid) continue

      const video = {
        bvid: m.bvid,
        url: `https://www.bilibili.com/video/${m.bvid}`,
        title: m.title || '（无标题）',
        cover: m.cover || '',
        author: (m.upper && m.upper.name) || '',
        authorFace: (m.upper && m.upper.face) || '',
        duration: m.duration || 0,
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
        tags: [],
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
      } else added++
      total++
    }

    if (!data.data || !data.data.has_more) break
    pn++
    // 控频：翻页之间留 1.5 秒，避免触发风控
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  return { ok: true, added, skipped, total }
}

// 拉取「稍后再看」列表并入库到 toview 分区。
// 接口 /x/v2/history/toview 一次返回全部（上限 100 条），按添加时间排列。
async function importWatchLater() {
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

  const list = (data.data && data.data.list) || []
  let added = 0
  let skipped = 0
  let total = 0

  for (const m of list) {
    if (!m.bvid) continue
    const stat = m.stat || {}
    const video = {
      bvid: m.bvid,
      url: `https://www.bilibili.com/video/${m.bvid}`,
      title: m.title || '（无标题）',
      cover: m.pic || '',
      author: (m.owner && m.owner.name) || '',
      authorFace: (m.owner && m.owner.face) || '',
      duration: m.duration || 0,
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
      tags: [],
      // 加入稍后再看的时间（add_at），用于「最新 → 最久之前」排序
      favTime: m.add_at || m.ctime || 0
    }

    const r = addVideo(video, 'toview')
    if (r.exists) {
      skipped++
      if (m.add_at && r.video.favTime !== m.add_at) {
        db.prepare('UPDATE toview SET fav_time = ? WHERE id = ?').run(m.add_at, r.video.id)
      }
    } else added++
    total++
  }

  return { ok: true, added, skipped, total }
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
ipcMain.handle('list-tag-stats', safe((source) => listTagStats(source)))
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
ipcMain.handle('import-favorites', (_event, mediaId) => importFavorites(mediaId))
ipcMain.handle('import-watch-later', () => importWatchLater())

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
  extractWbiKey
}

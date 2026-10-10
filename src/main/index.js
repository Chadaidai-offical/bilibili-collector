const { app, shell, session, net, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { spawnSync } = require('child_process')
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

function initDb() {
  if (db) return db

  const dbPath = join(app.getPath('userData'), 'bilibili-collector.db')
  db = new Database(dbPath)

  // WAL 模式：读写更稳定，适合频繁小事务
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
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
      created_at  TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  // 旧库迁移：补齐新增列（PRAGMA table_info 检测，缺哪列补哪列）
  migrateDb()

  return db
}

// 给已存在的旧表补列（新装库的 CREATE TABLE 已含全部列，此步对旧库生效）
function migrateDb() {
  const cols = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name)
  const addCols = [
    ['author_face', "TEXT DEFAULT ''"],
    ['duration', 'INTEGER DEFAULT 0'],
    ['description', "TEXT DEFAULT ''"],
    ['pubdate', 'INTEGER DEFAULT 0'],
    ['tname', "TEXT DEFAULT ''"],
    ['stat', "TEXT DEFAULT '{}'"]
  ]
  for (const [name, def] of addCols) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${def}`)
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

// 按 bvid 查询（判断是否已收藏）
function getByBvid(bvid) {
  const row = db.prepare('SELECT * FROM videos WHERE bvid = ?').get(bvid)
  return rowToVideo(row)
}

// 新增收藏。bvid 已存在则返回 exists:true，不重复插入
function addVideo(video) {
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
    stat = {}
  } = video
  const existing = getByBvid(bvid)
  if (existing) {
    return { exists: true, video: existing }
  }

  const info = db
    .prepare(
      `INSERT INTO videos
        (bvid, url, title, cover, author, author_face, duration, description, pubdate, tname, stat, tags)
       VALUES
        (@bvid, @url, @title, @cover, @author, @authorFace, @duration, @description, @pubdate, @tname, @stat, @tags)`
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
      tags: JSON.stringify(tags)
    })

  return {
    exists: false,
    video: rowToVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(info.lastInsertRowid))
  }
}

// 列出全部收藏（新的在前）
function listVideos() {
  const rows = db.prepare('SELECT * FROM videos ORDER BY id DESC').all()
  return rows.map(rowToVideo)
}

// 关键词搜索：标题 / BV 号 / 链接 / 标签 模糊匹配
function searchVideos(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return listVideos()

  const like = `%${kw}%`
  const rows = db
    .prepare(
      `SELECT * FROM videos
       WHERE title LIKE @like OR bvid LIKE @like OR url LIKE @like OR tags LIKE @like
       ORDER BY id DESC`
    )
    .all({ like })
  return rows.map(rowToVideo)
}

// 更新一条收藏（标签 / 追番标记 / 标题等）
function updateVideo(id, fields) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id)
  if (!video) return { error: '该条收藏不存在' }

  const tags = fields.tags !== undefined ? JSON.stringify(fields.tags) : video.tags
  const watched = fields.watched !== undefined ? (fields.watched ? 1 : 0) : video.watched
  const title = fields.title !== undefined ? fields.title : video.title

  db.prepare('UPDATE videos SET tags = ?, watched = ?, title = ? WHERE id = ?').run(
    tags,
    watched,
    title,
    id
  )

  return {
    video: rowToVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(id))
  }
}

// 删除一条收藏
function deleteVideo(id) {
  const info = db.prepare('DELETE FROM videos WHERE id = ?').run(id)
  return { deleted: info.changes > 0 }
}

// 收藏总数
function countVideos() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM videos').get()
  return row.n
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
        tags: []
      }

      const r = addVideo(video)
      if (r.exists) skipped++
      else added++
      total++
    }

    if (!data.data || !data.data.has_more) break
    pn++
    // 控频：翻页之间留 1.5 秒，避免触发风控
    await new Promise((resolve) => setTimeout(resolve, 1500))
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

ipcMain.handle('save-video', safe((video) => addVideo(video)))
ipcMain.handle('list-videos', safe(() => listVideos()))
ipcMain.handle('search-videos', safe((keyword) => searchVideos(keyword)))
ipcMain.handle('update-video', safe((id, fields) => updateVideo(id, fields)))
ipcMain.handle('delete-video', safe((id) => deleteVideo(id)))

// 打开 B 站客户端（没装则退回网页）
ipcMain.handle('open-bilibili', () => openBilibiliApp())

// B 站登录 + 收藏夹导入
ipcMain.handle('check-login', () => checkLogin())
ipcMain.handle('open-login', () => openLogin())
ipcMain.handle('logout', () => logout())
ipcMain.handle('list-fav-folders', () => listFavFolders())
ipcMain.handle('import-favorites', (_event, mediaId) => importFavorites(mediaId))

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

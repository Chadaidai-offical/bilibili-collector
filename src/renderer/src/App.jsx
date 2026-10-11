import { useEffect, useMemo, useState } from 'react'

// 秒数 → 「23:32」或「1:23:32」
function formatDuration(s) {
  if (!s) return ''
  const sec = Number(s)
  if (Number.isNaN(sec) || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = sec % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

// 数字 → 「560」/「1.2万」/「3.4亿」
function formatCount(n) {
  if (!n) return ''
  const num = Number(n)
  if (Number.isNaN(num) || num <= 0) return ''
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return String(num)
}

// 时间戳 → 「2023-10-26」
function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 秒（累计时长）→ 「123 小时 45 分」
function formatTotalDuration(s) {
  const sec = Number(s) || 0
  if (sec <= 0) return '0 分钟'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  return `${m} 分钟`
}

// 排序方式（纯前端排序，作用于「当前筛选结果」，不动数据库）
const SORT_OPTIONS = [
  { key: 'favTimeDesc', label: '收藏时间：新 → 旧' },
  { key: 'favTimeAsc', label: '收藏时间：旧 → 新' },
  { key: 'viewDesc', label: '播放量：高 → 低' },
  { key: 'durationDesc', label: '时长：长 → 短' },
  { key: 'pubdateDesc', label: '发布时间：新 → 旧' },
  { key: 'authorAsc', label: 'UP主：A → Z' }
]

const EMPTY_STATS = {
  total: 0,
  totalDuration: 0,
  watched: 0,
  unwatched: 0,
  invalid: 0,
  tagCount: 0,
  authorCount: 0,
  topTags: [],
  topAuthors: []
}

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetchResult, setFetchResult] = useState(null)
  const [error, setError] = useState('')

  const [videos, setVideos] = useState([])
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState('')

  // 数据分区：'fav' 收藏 / 'toview' 稍后再看
  const [source, setSource] = useState('fav')

  const [editingId, setEditingId] = useState(null)
  const [editTags, setEditTags] = useState('')

  // 筛选状态：当前选中的标签（单选，null 表示不筛）、追番状态
  const [activeTag, setActiveTag] = useState(null)
  const [watchFilter, setWatchFilter] = useState('all') // 'all' | 'watched' | 'unwatched'

  // 批量打标签
  const [showBatch, setShowBatch] = useState(false)
  const [batchTags, setBatchTags] = useState('')

  // 失效视频检测
  const [checking, setChecking] = useState(false)
  const [checkProgress, setCheckProgress] = useState(null)
  const [invalidOnly, setInvalidOnly] = useState(false)

  // 他人分享：按分享者筛选 + 全窗拖拽导入遮罩
  const [shareFrom, setShareFrom] = useState(null)
  const [dragging, setDragging] = useState(false)

  // 检查更新
  const [updateInfo, setUpdateInfo] = useState(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  // 检查失败时的提示条（例如 GitHub 匿名接口配额耗尽），仍给「前往下载页」兜底
  const [updateTip, setUpdateTip] = useState(null)

  // 全站搜索：结果先预览（不入库），勾选后再写入「搜索列表」分区
  const [searchKw, setSearchKw] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [picked, setPicked] = useState([])

  // 排序方式（前端排序，作用于当前筛选结果）
  const [sortBy, setSortBy] = useState('favTimeDesc')

  // 统计面板（分区整体统计）+ 标签管理
  const [stats, setStats] = useState(EMPTY_STATS)
  const [showStats, setShowStats] = useState(false)
  const [showTagManager, setShowTagManager] = useState(false)
  const [tagStats, setTagStats] = useState([])
  const [selectedTags, setSelectedTags] = useState([])
  const [renameTo, setRenameTo] = useState('')
  const [tagBusy, setTagBusy] = useState(false)

  // 登录状态 + 收藏夹导入
  const [loginInfo, setLoginInfo] = useState(null)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [favFolders, setFavFolders] = useState([])
  const [selectedFolder, setSelectedFolder] = useState('')
  const [importing, setImporting] = useState(false)

  // 刷新列表（带关键词搜索），按当前分区取数；顺带刷新该分区的整体统计
  async function refresh(key = keyword, src = source) {
    try {
      const listPromise = key.trim()
        ? window.api.searchVideos(key.trim(), src)
        : window.api.listVideos(src)
      const [res, st] = await Promise.all([listPromise, window.api.getStats(src)])
      if (Array.isArray(res)) setVideos(res)
      else if (res && res.error) setError(res.error)
      if (st && !st.error) setStats({ ...EMPTY_STATS, ...st })
    } catch (err) {
      setError(err.message || '读取失败')
    }
  }

  useEffect(() => {
    refresh('', 'fav')
    // 启动时检查登录状态
    window.api
      .checkLogin()
      .then((info) => setLoginInfo(info))
      .catch(() => setLoginInfo({ loggedIn: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关键词或分区变化时实时搜索
  useEffect(() => {
    const t = setTimeout(() => refresh(keyword, source), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, source])

  // 订阅失效检测的进度事件（主进程逐条检测时回报）
  useEffect(() => {
    const off = window.api.onCheckInvalidProgress((p) => setCheckProgress(p))
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])

  // 启动后延迟 3 秒静默检查更新（不阻塞启动；只有真有新版本才提示）
  useEffect(() => {
    const t = setTimeout(() => {
      window.api
        .checkUpdate()
        .then((info) => {
          if (info && info.ok && info.hasUpdate) setUpdateInfo(info)
        })
        .catch(() => {})
    }, 3000)
    return () => clearTimeout(t)
  }, [])

  // 整窗拖拽导入：把 .json 分享文件拖进来松手即导入到「分享导入」分区
  useEffect(() => {
    let depth = 0
    const hasFiles = (e) =>
      e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
    function onDragEnter(e) {
      e.preventDefault()
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    function onDragOver(e) {
      e.preventDefault()
    }
    function onDragLeave(e) {
      e.preventDefault()
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    function onDrop(e) {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      if (file) readAndImportFile(file)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换分区：清空搜索/筛选，回到该分区的默认视图
  function switchSource(next) {
    if (next === source) return
    setKeyword('')
    setActiveTag(null)
    setWatchFilter('all')
    setShowBatch(false)
    setBatchTags('')
    setInvalidOnly(false)
    setShareFrom(null)
    setSortBy('favTimeDesc')
    setShowTagManager(false)
    setSelectedTags([])
    setRenameTo('')
    setSearchResults([])
    setPicked([])
    setSearchKw('')
    setError('')
    setSource(next)
  }

  function flash(text) {
    setNotice(text)
    setTimeout(() => setNotice(''), 2500)
  }

  async function handleFetch() {
    if (!url.trim()) return
    setLoading(true)
    setError('')
    setFetchResult(null)
    try {
      const res = await window.api.fetchVideoInfo(url.trim())
      if (res.error) setError(res.error)
      else setFetchResult(res)
    } catch (err) {
      setError(err.message || '抓取失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    if (!fetchResult) return
    try {
      const res = await window.api.saveVideo(fetchResult, source)
      if (res.error) {
        setError(res.error)
        return
      }
      flash(
        res.exists
          ? '这条视频之前已经收录过啦～'
          : source === 'fav'
            ? '已保存到本地收藏 ✅'
            : '已保存到稍后再看 ✅'
      )
      setFetchResult(null)
      setUrl('')
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '保存失败')
    }
  }

  async function handleDelete(video) {
    if (!window.confirm(`确定要删除「${video.title}」吗？`)) return
    try {
      const res = await window.api.deleteVideo(video.id, source)
      if (res.error) setError(res.error)
      else refresh(keyword, source)
    } catch (err) {
      setError(err.message || '删除失败')
    }
  }

  async function handleToggleWatched(video) {
    try {
      const res = await window.api.updateVideo(video.id, { watched: !video.watched }, source)
      if (res.error) setError(res.error)
      else refresh(keyword, source)
    } catch (err) {
      setError(err.message || '更新失败')
    }
  }

  async function handleOpenBilibili() {
    try {
      const res = await window.api.openBilibiliApp()
      if (res && res.error) setError(res.error)
      else if (res && res.mode === 'client') flash('已打开 B 站客户端')
      else flash('未检测到客户端，已打开网页版')
    } catch (err) {
      setError(err.message || '打开失败')
    }
  }

  async function handleLogin() {
    try {
      const res = await window.api.openLogin()
      if (res && res.error) {
        setError(res.error)
        return
      }
      if (res && res.loggedIn) {
        setLoginInfo(res)
        flash('登录成功 🎉')
      }
    } catch (err) {
      setError(err.message || '登录失败')
    }
  }

  async function handleLogout() {
    try {
      await window.api.logout()
      setLoginInfo({ loggedIn: false })
      flash('已退出登录')
    } catch (err) {
      setError(err.message || '退出失败')
    }
  }

  // 手动检查更新
  async function handleCheckUpdate() {
    setCheckingUpdate(true)
    setError('')
    setUpdateTip(null)
    try {
      const info = await window.api.checkUpdate(true)
      if (!info || !info.ok) {
        // 失败不弹错误，改用提示条 + 「前往下载页」兜底，避免用户被卡住
        setUpdateTip({
          text:
            (info && info.error) ||
            `检查更新失败（当前版本 v${(info && info.current) || '—'}），可手动前往下载页查看`,
          url: (info && info.url) || 'https://github.com/Chadaidai-offical/bilibili-collector/releases'
        })
        return
      }
      if (info.hasUpdate) {
        setUpdateInfo(info)
      } else {
        setUpdateInfo(null)
        flash(
          info.fellBack
            ? `当前已是最新版本 v${info.current}（GitHub 接口繁忙，已走备用通道核对）`
            : `当前已是最新版本 v${info.current}`
        )
      }
    } catch (err) {
      setUpdateTip({
        text: err.message || '检查更新失败',
        url: 'https://github.com/Chadaidai-offical/bilibili-collector/releases'
      })
    } finally {
      setCheckingUpdate(false)
    }
  }

  // 搜索 B 站全站视频：只发一次请求（第一页 20 条），结果先预览、不入库
  async function handleSearchBili() {
    const kw = searchKw.trim()
    if (!kw) {
      setError('请输入要搜索的关键词')
      return
    }
    setSearching(true)
    setError('')
    try {
      const res = await window.api.searchBili(kw)
      if (!res || res.error) {
        setError((res && res.error) || '搜索失败')
        setSearchResults([])
        setPicked([])
        return
      }
      const items = Array.isArray(res.items) ? res.items : []
      setSearchResults(items)
      setPicked([])
      if (items.length === 0) flash('没有搜到相关视频，换个关键词试试')
    } catch (err) {
      setError(err.message || '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  function togglePick(bvid) {
    setPicked((prev) => (prev.includes(bvid) ? prev.filter((x) => x !== bvid) : [...prev, bvid]))
  }

  function togglePickAll() {
    setPicked((prev) =>
      prev.length === searchResults.length ? [] : searchResults.map((v) => v.bvid)
    )
  }

  // 把勾选的搜索结果写入「搜索列表」分区（按 bvid 去重）
  async function handleAddPicked() {
    if (picked.length === 0) return
    const items = searchResults.filter((v) => picked.includes(v.bvid))
    try {
      const res = await window.api.importSearchItems(items)
      if (res && res.error) {
        setError(res.error)
        return
      }
      flash(`已加入搜索列表：新增 ${res.added} 条，已存在跳过 ${res.skipped} 条`)
      setPicked([])
      if (source === 'search') refresh(keyword, 'search')
    } catch (err) {
      setError(err.message || '加入失败')
    }
  }

  async function handleOpenImport() {
    setShowFolderPicker(true)
    setFavFolders([])
    setSelectedFolder('')
    try {
      const res = await window.api.listFavFolders()
      if (res && res.error) {
        setError(res.error)
        setShowFolderPicker(false)
        return
      }
      const list = Array.isArray(res) ? res : []
      setFavFolders(list)
      if (list.length > 0) setSelectedFolder(String(list[0].id))
    } catch (err) {
      setError(err.message || '获取收藏夹失败')
      setShowFolderPicker(false)
    }
  }

  async function handleDoImport() {
    if (!selectedFolder) return
    setImporting(true)
    try {
      const res = await window.api.importFavorites(Number(selectedFolder))
      if (res && res.error) {
        setError(res.error)
      } else if (res && res.ok) {
        flash(`导入完成：新增 ${res.added} 条，已存在跳过 ${res.skipped} 条`)
      }
      setShowFolderPicker(false)
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  // 一键拉取「稍后再看」到 toview 分区
  async function handleImportWatchLater() {
    try {
      const res = await window.api.importWatchLater()
      if (res && res.error) {
        setError(res.error)
        return
      }
      if (res && res.ok) {
        flash(`稍后再看拉取完成：新增 ${res.added} 条，已存在跳过 ${res.skipped} 条`)
      }
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '拉取稍后再看失败')
    }
  }

  function startEditTags(video) {
    setEditingId(video.id)
    setEditTags(video.tags.join(', '))
  }

  async function commitTags() {
    if (editingId == null) return
    const tags = editTags
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const res = await window.api.updateVideo(editingId, { tags }, source)
      if (res.error) setError(res.error)
      else refresh(keyword, source)
    } catch (err) {
      setError(err.message || '保存标签失败')
    } finally {
      setEditingId(null)
    }
  }

  // 从当前列表聚合出所有不重复的标签（用于筛选栏）
  const allTags = useMemo(() => {
    const set = new Set()
    videos.forEach((v) => v.tags.forEach((t) => set.add(t)))
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [videos])

  // 当前列表里失效视频的数量（用于「只看失效」筛选角标）
  const invalidCount = useMemo(() => videos.filter((v) => v.invalid).length, [videos])

  // 分享分区：聚合出所有分享者（用于按来源筛选）
  const shareFromList = useMemo(() => {
    if (source !== 'shared') return []
    const set = new Set()
    videos.forEach((v) => v.shareFrom && set.add(v.shareFrom))
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [videos, source])

  // 在关键词结果之上，叠加标签筛选 + 追番状态筛选 + 失效筛选 + 分享者筛选，最后按所选方式排序
  const filteredVideos = useMemo(() => {
    let list = videos
    if (activeTag) {
      list = list.filter((v) => v.tags.includes(activeTag))
    }
    if (watchFilter === 'watched') {
      list = list.filter((v) => v.watched)
    } else if (watchFilter === 'unwatched') {
      list = list.filter((v) => !v.watched)
    }
    if (invalidOnly) {
      list = list.filter((v) => v.invalid)
    }
    if (source === 'shared' && shareFrom) {
      list = list.filter((v) => v.shareFrom === shareFrom)
    }

    const sorted = [...list]
    switch (sortBy) {
      case 'favTimeAsc':
        sorted.sort((a, b) => (a.favTime || 0) - (b.favTime || 0) || a.id - b.id)
        break
      case 'viewDesc':
        sorted.sort((a, b) => ((b.stat && b.stat.view) || 0) - ((a.stat && a.stat.view) || 0))
        break
      case 'durationDesc':
        sorted.sort((a, b) => (b.duration || 0) - (a.duration || 0))
        break
      case 'pubdateDesc':
        sorted.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0))
        break
      case 'authorAsc':
        sorted.sort(
          (a, b) =>
            String(a.author || '').localeCompare(String(b.author || ''), 'zh-Hans-CN') ||
            (b.favTime || 0) - (a.favTime || 0)
        )
        break
      default:
        sorted.sort((a, b) => (b.favTime || 0) - (a.favTime || 0) || b.id - a.id)
    }
    return sorted
  }, [videos, activeTag, watchFilter, invalidOnly, source, shareFrom, sortBy])

  // ===== 标签管理 =====
  // 打开标签管理：拉取该分区全部标签及使用次数
  async function openTagManager() {
    setShowTagManager(true)
    setSelectedTags([])
    setRenameTo('')
    try {
      const res = await window.api.listTagStats(source)
      setTagStats(Array.isArray(res) ? res : [])
    } catch (err) {
      setError(err.message || '读取标签失败')
    }
  }

  function toggleTagSelect(name) {
    setSelectedTags((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    )
  }

  // 重命名 / 合并选中标签
  async function handleRenameTags() {
    if (selectedTags.length === 0) return
    const target = renameTo.trim()
    if (!target) {
      setError('请先输入新的标签名（想删除标签请点右侧「删除选中标签」）')
      return
    }
    if (
      !window.confirm(
        `确定把选中的 ${selectedTags.length} 个标签统一改成「${target}」吗？\n（记录里原本就有的「${target}」会自动合并去重）`
      )
    ) {
      return
    }
    await runEditTags(selectedTags, target, `已把 ${selectedTags.length} 个标签合并为「${target}」`)
  }

  // 删除选中标签（从所有记录里移除，不会删视频）
  async function handleDeleteTags() {
    if (selectedTags.length === 0) return
    if (
      !window.confirm(
        `确定从当前分区的所有记录中删除这 ${selectedTags.length} 个标签吗？\n（只移除标签，视频本身不受影响）`
      )
    ) {
      return
    }
    await runEditTags(selectedTags, '', `已删除 ${selectedTags.length} 个标签`)
  }

  // 标签批量操作的公共收尾：刷新标签列表 + 列表 + 统计
  async function runEditTags(fromTags, toTag, okText) {
    setTagBusy(true)
    try {
      const res = await window.api.editTags(fromTags, toTag, source)
      if (res && res.error) {
        setError(res.error)
        return
      }
      if (res && res.ok) flash(`${okText}（影响 ${res.updated} 条记录）`)
      setSelectedTags([])
      setRenameTo('')
      const list = await window.api.listTagStats(source)
      setTagStats(Array.isArray(list) ? list : [])
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '标签操作失败')
    } finally {
      setTagBusy(false)
    }
  }

  // 把输入的标签一键追加到「当前列表」（搜索/筛选后的结果）的所有记录上
  async function handleBatchApply() {
    const tags = batchTags
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (tags.length === 0) {
      setError('请先输入要添加的标签')
      return
    }
    const ids = filteredVideos.map((v) => v.id)
    if (ids.length === 0) return
    if (
      !window.confirm(
        `确定给当前 ${ids.length} 条记录添加标签「${tags.join('、')}」吗？\n（已存在该标签的会自动跳过）`
      )
    ) {
      return
    }
    try {
      const res = await window.api.batchAddTags(ids, tags, source)
      if (res && res.error) {
        setError(res.error)
        return
      }
      if (res && res.ok) {
        flash(
          res.updated > 0
            ? `已为 ${res.updated} 条记录添加标签（共 ${res.total} 条）`
            : '这些记录都已经有这个标签啦～'
        )
      }
      setShowBatch(false)
      setBatchTags('')
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '批量添加标签失败')
    }
  }

  // 批量删除「当前列表」（搜索/筛选后的结果）的所有记录
  async function handleBatchDelete() {
    const ids = filteredVideos.map((v) => v.id)
    if (ids.length === 0) return
    if (
      !window.confirm(
        `确定要删除当前列表的 ${ids.length} 条记录吗？\n⚠️ 删除后无法恢复，请谨慎操作！`
      )
    ) {
      return
    }
    try {
      const res = await window.api.batchDeleteVideos(ids, source)
      if (res && res.error) {
        setError(res.error)
        return
      }
      if (res && res.ok) flash(`已删除 ${res.deleted} 条记录`)
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '批量删除失败')
    }
  }

  // 一键检测当前分区里的失效视频（逐条请求 B 站，耗时取决于条数）
  async function handleCheckInvalid() {
    if (checking) return
    setError('')
    setChecking(true)
    setCheckProgress({ checked: 0, total: videos.length, invalid: 0 })
    try {
      const res = await window.api.checkInvalidVideos(source)
      if (res && res.error) {
        setError(res.error)
      } else if (res && res.ok) {
        flash(
          res.invalid > 0
            ? `检测完成：发现 ${res.invalid} 条失效视频（共检测 ${res.checked} 条）`
            : `检测完成：没有发现失效视频（共检测 ${res.checked} 条）`
        )
        if (res.invalid > 0) setInvalidOnly(true)
      }
      refresh(keyword, source)
    } catch (err) {
      setError(err.message || '检测失败')
    } finally {
      setChecking(false)
      setCheckProgress(null)
    }
  }

  // ===== 导出 / 导入他人分享 =====
  // 导出当前分区为紧凑 JSON 分享文件
  async function handleExport() {
    if (videos.length === 0) {
      setError('当前列表是空的，没有可导出的内容')
      return
    }
    try {
      const res = await window.api.exportVideos(source)
      if (res && res.error) setError(res.error)
      else if (res && res.ok) flash(`已导出 ${res.count} 条到分享文件 ✅`)
    } catch (err) {
      setError(err.message || '导出失败')
    }
  }

  // 导入成功后统一收尾：提示 + 切到「分享导入」分区
  function afterImport(res) {
    flash(
      res.added > 0
        ? `已从「${res.from}」的分享导入 ${res.added} 条${
            res.skipped ? `（${res.skipped} 条已存在跳过）` : ''
          }`
        : `「${res.from}」的分享内容已全部存在，无需重复导入`
    )
    setKeyword('')
    setActiveTag(null)
    setWatchFilter('all')
    setInvalidOnly(false)
    setShareFrom(null)
    setSource('shared')
    refresh('', 'shared')
  }

  // 「打开文件」方式导入
  async function handlePickShareFile() {
    try {
      const res = await window.api.pickShareFile()
      if (!res || res.canceled) return
      if (res.error) {
        setError(res.error)
        return
      }
      afterImport(res)
    } catch (err) {
      setError(err.message || '导入失败')
    }
  }

  // 拖拽导入：读取本地 .json 文件内容后交给主进程入库
  async function readAndImportFile(file) {
    if (!file) return
    if (!/\.json$/i.test(file.name)) {
      setError('只支持导入 .json 分享文件')
      return
    }
    try {
      const text = await file.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        setError('文件不是有效的 JSON，导入失败')
        return
      }
      const res = await window.api.importShareData(payload)
      if (res && res.error) {
        setError(res.error)
        return
      }
      if (res && res.ok) afterImport(res)
    } catch (err) {
      setError(err.message || '读取文件失败')
    }
  }

  // 分区文案
  const sourceLabel =
    source === 'fav'
      ? '收藏'
      : source === 'toview'
        ? '稍后再看'
        : source === 'shared'
          ? '分享内容'
          : '搜索列表'

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>B站收藏管理</h1>
          <div className="header-actions">
            {loginInfo && loginInfo.loggedIn && (
              <>
                {loginInfo.face && (
                  <img src={loginInfo.face} alt={loginInfo.uname} className="login-face" />
                )}
                <span className="login-name">{loginInfo.uname || '已登录'}</span>
              </>
            )}
            {source === 'fav' &&
              (loginInfo && loginInfo.loggedIn ? (
                <button className="btn-open-client" onClick={handleOpenImport}>
                  导入收藏夹
                </button>
              ) : (
                <button className="btn-open-client" onClick={handleLogin}>
                  登录B站
                </button>
              ))}
            {source === 'toview' &&
              (loginInfo && loginInfo.loggedIn ? (
                <button className="btn-open-client" onClick={handleImportWatchLater}>
                  拉取稍后再看
                </button>
              ) : (
                <button className="btn-open-client" onClick={handleLogin}>
                  登录B站
                </button>
              ))}
            {source === 'shared' && (
              <button className="btn-open-client" onClick={handlePickShareFile}>
                导入分享文件
              </button>
            )}
            <button
              className="btn-open-client"
              onClick={handleExport}
              disabled={videos.length === 0}
              title="把当前列表导出为分享文件（.json），可发给别人导入"
            >
              导出列表
            </button>
            {loginInfo && loginInfo.loggedIn && (
              <button className="btn-open-client" onClick={handleLogout}>
                退出
              </button>
            )}
            <button
              className="btn-open-client"
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              title="检查是否有新版本"
            >
              {checkingUpdate ? '检查中…' : '检查更新'}
            </button>
            <button className="btn-open-client" onClick={handleOpenBilibili}>
              打开B站客户端
            </button>
          </div>
        </div>
        <p className="subtitle">粘贴 B 站视频链接，抓取公开信息并存入本地</p>
      </header>

      {/* 有新版本时在顶部提示，点一下就能去下载 */}
      {updateInfo && updateInfo.hasUpdate && (
        <div className="update-bar">
          <span className="update-text">
            发现新版本 <b>v{updateInfo.latest}</b>（当前 v{updateInfo.current}）
            {updateInfo.fellBack && <span className="update-sub"> · 备用通道</span>}
          </span>
          <button
            className="btn-primary update-btn"
            onClick={() => window.api.openExternal(updateInfo.url)}
          >
            前往下载
          </button>
          <button className="btn-ghost" onClick={() => setUpdateInfo(null)}>
            忽略
          </button>
        </div>
      )}

      {/* 检查更新失败（如 GitHub 针对匿名接口的 IP 配额耗尽）时的提示条 */}
      {updateTip && (
        <div className="update-bar update-bar-warn">
          <span className="update-text">{updateTip.text}</span>
          <button
            className="btn-ghost update-btn"
            onClick={() => window.api.openExternal(updateTip.url)}
          >
            前往下载页
          </button>
          <button className="btn-ghost" onClick={() => setUpdateTip(null)}>
            知道了
          </button>
        </div>
      )}

      {/* 分区切换：收藏 / 稍后再看 / 分享导入 / 搜索列表 */}
      <div className="source-tabs">
        {[
          { key: 'fav', label: '我的收藏' },
          { key: 'toview', label: '稍后再看' },
          { key: 'shared', label: '分享导入' },
          { key: 'search', label: '搜索列表' }
        ].map((tab) => (
          <button
            key={tab.key}
            className={`source-tab ${source === tab.key ? 'on' : ''}`}
            onClick={() => switchSource(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 顶部统计条：大字号显示收藏数 / 收藏总时长，可展开详细统计面板 */}
      <div className="stat-hero">
        <div className="stat-hero-item">
          <div className="stat-hero-num">{stats.total}</div>
          <div className="stat-hero-label">{sourceLabel}总数</div>
        </div>
        <div className="stat-hero-divider" />
        <div className="stat-hero-item">
          <div className="stat-hero-num">{formatTotalDuration(stats.totalDuration)}</div>
          <div className="stat-hero-label">{source === 'fav' ? '收藏总时长' : '总时长'}</div>
        </div>
        <div className="stat-hero-divider" />
        <div className="stat-hero-item">
          <div className="stat-hero-num">
            {stats.watched}
            <span className="stat-hero-sub">/ {stats.unwatched}</span>
          </div>
          <div className="stat-hero-label">已看 / 未看</div>
        </div>
        {stats.invalid > 0 && (
          <>
            <div className="stat-hero-divider" />
            <div className="stat-hero-item">
              <div className="stat-hero-num stat-hero-warn">{stats.invalid}</div>
              <div className="stat-hero-label">已失效</div>
            </div>
          </>
        )}
        <button className="btn-ghost stat-hero-toggle" onClick={() => setShowStats((v) => !v)}>
          {showStats ? '收起统计' : '📊 统计面板'}
        </button>
      </div>

      {showStats && (
        <div className="stat-panel">
          <div className="stat-block">
            <h4>
              🏷 最多的标签
              <span className="stat-sub">共 {stats.tagCount} 种</span>
            </h4>
            {stats.topTags.length === 0 ? (
              <div className="stat-empty">还没有打任何标签</div>
            ) : (
              <div className="stat-bars">
                {stats.topTags.map((t) => (
                  <div key={t.name} className="stat-bar-row">
                    <span className="stat-bar-name" title={t.name}>
                      {t.name}
                    </span>
                    <span className="stat-bar-track">
                      <span
                        className="stat-bar-fill"
                        style={{
                          width: `${Math.max(4, (t.count / stats.topTags[0].count) * 100)}%`
                        }}
                      />
                    </span>
                    <span className="stat-bar-val">{t.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="stat-block">
            <h4>
              👤 收藏最多的 UP 主
              <span className="stat-sub">共 {stats.authorCount} 位</span>
            </h4>
            {stats.topAuthors.length === 0 ? (
              <div className="stat-empty">还没有作者信息</div>
            ) : (
              <div className="stat-bars">
                {stats.topAuthors.map((a) => (
                  <div key={a.name} className="stat-bar-row">
                    <span className="stat-bar-name" title={a.name}>
                      {a.name}
                    </span>
                    <span className="stat-bar-track">
                      <span
                        className="stat-bar-fill stat-bar-fill-blue"
                        style={{
                          width: `${Math.max(4, (a.count / stats.topAuthors[0].count) * 100)}%`
                        }}
                      />
                    </span>
                    <span className="stat-bar-val">{a.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="input-row">
        <input
          type="text"
          placeholder="粘贴 B 站视频链接，例如 https://www.bilibili.com/video/BVxxxx"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleFetch()}
        />
        <button onClick={handleFetch} disabled={loading || !url.trim()}>
          {loading ? '抓取中…' : '抓取信息'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {fetchResult && (
        <div className="card">
          {fetchResult.cover && (
            <img src={fetchResult.cover} alt={fetchResult.title} className="cover" />
          )}
          <div className="info">
            <div className="title">{fetchResult.title}</div>

            {fetchResult.author && (
              <div className="author-line">
                {fetchResult.authorFace && (
                  <img
                    src={fetchResult.authorFace}
                    alt={fetchResult.author}
                    className="author-face"
                  />
                )}
                <span>{fetchResult.author}</span>
              </div>
            )}

            <div className="meta meta-row">
              <span className="bvid">{fetchResult.bvid}</span>
              {fetchResult.duration > 0 && <span>⏱ {formatDuration(fetchResult.duration)}</span>}
              {fetchResult.tname && <span>{fetchResult.tname}</span>}
              {fetchResult.stat && fetchResult.stat.view > 0 && (
                <span>▶ {formatCount(fetchResult.stat.view)}</span>
              )}
              {fetchResult.pubdate > 0 && <span>{formatDate(fetchResult.pubdate)}</span>}
            </div>

            {fetchResult.desc && <div className="desc">{fetchResult.desc}</div>}

            <div className="meta">链接：{fetchResult.url}</div>

            <div className="card-actions">
              <button className="btn-primary" onClick={handleSave}>
                保存到收藏
              </button>
              <button className="btn-ghost" onClick={() => setFetchResult(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全站搜索面板（仅「搜索列表」分区显示）：结果先预览，勾选后才入库 */}
      {source === 'search' && (
        <div className="bili-search">
          <div className="bili-search-head">
            <input
              type="text"
              className="bili-search-input"
              placeholder="搜索 B 站全站视频…"
              value={searchKw}
              onChange={(e) => setSearchKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearchBili()
              }}
            />
            <button
              className="btn-primary"
              onClick={handleSearchBili}
              disabled={searching || !(loginInfo && loginInfo.loggedIn)}
            >
              {searching ? '搜索中…' : '搜索'}
            </button>
            {searchResults.length > 0 && (
              <>
                <button className="btn-ghost" onClick={togglePickAll}>
                  {picked.length === searchResults.length ? '取消全选' : '全选'}
                </button>
                <button
                  className="btn-primary"
                  onClick={handleAddPicked}
                  disabled={picked.length === 0}
                >
                  加入搜索列表（{picked.length}）
                </button>
              </>
            )}
          </div>

          {!(loginInfo && loginInfo.loggedIn) ? (
            <p className="bili-search-tip warn">
              全站搜索需要登录 B 站（带登录态的请求风控权重更低，更不容易被拦）。
              <button className="link-btn" onClick={handleLogin}>
                点这里登录
              </button>
            </p>
          ) : (
            <p className="bili-search-tip">
              每次搜索只请求一次（第一页 20 条）。请勿连续快速搜索，以免触发 B 站风控。
            </p>
          )}

          {searchResults.length > 0 && (
            <ul className="bili-search-list">
              {searchResults.map((v) => {
                const on = picked.includes(v.bvid)
                return (
                  <li key={v.bvid} className={`bili-search-item ${on ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      className="pick-box"
                      checked={on}
                      onChange={() => togglePick(v.bvid)}
                    />
                    {v.cover && <img src={v.cover} alt="" className="bili-search-cover" />}
                    <div className="bili-search-meta">
                      <div className="bili-search-title">{v.title}</div>
                      <div className="bili-search-sub">
                        {v.author}
                        {v.duration ? ` · ${formatDuration(v.duration)}` : ''}
                        {v.stat && v.stat.view ? ` · ${formatCount(v.stat.view)} 播放` : ''}
                        {v.tname ? ` · ${v.tname}` : ''}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>
            {source === 'fav'
              ? '我的收藏'
              : source === 'toview'
                ? '稍后再看'
                : source === 'shared'
                  ? '分享导入'
                  : '搜索列表'}
            （{filteredVideos.length}）
          </h2>
          <div className="section-head-right">
            <select
              className="sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              title="排序方式（只影响显示顺序）"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="search-input"
              placeholder="搜索标题 / BV号 / 标签…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>

        {/* 筛选栏：追番状态 + 标签分类 */}
        <div className="filters">
          <div className="watch-tabs">
            {[
              { key: 'all', label: '全部' },
              { key: 'unwatched', label: '未看' },
              { key: 'watched', label: '已看' }
            ].map((tab) => (
              <button
                key={tab.key}
                className={`watch-tab ${watchFilter === tab.key ? 'on' : ''}`}
                onClick={() => setWatchFilter(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 失效检测：一键体检当前分区，逐条请求 B 站判断稿件是否失效 */}
          <div className="tool-row">
            <button
              className="btn-ghost"
              onClick={handleCheckInvalid}
              disabled={checking || videos.length === 0}
              title="逐条检查视频是否已失效（被删 / 不可见），耗时取决于条数"
            >
              {checking
                ? `检测中 ${checkProgress ? checkProgress.checked : 0}/${
                    checkProgress ? checkProgress.total : 0
                  }…`
                : '🩺 检测失效视频'}
            </button>
            <button
              className="btn-ghost"
              onClick={openTagManager}
              disabled={videos.length === 0}
              title="重命名 / 合并同义标签，或清理用不到的标签"
            >
              🏷 标签管理
            </button>
            {invalidCount > 0 && (
              <button
                className={`chip-invalid ${invalidOnly ? 'on' : ''}`}
                onClick={() => setInvalidOnly((v) => !v)}
              >
                ⚠ 只看失效（{invalidCount}）
              </button>
            )}
          </div>

          {/* 分享分区：按分享者筛选，一眼区分是谁分享的 */}
          {source === 'shared' && shareFromList.length > 0 && (
            <div className="tag-filters">
              {shareFromList.map((f) => (
                <button
                  key={f}
                  className={`tag-chip ${shareFrom === f ? 'on' : ''}`}
                  onClick={() => setShareFrom(shareFrom === f ? null : f)}
                >
                  👤 {f}
                </button>
              ))}
            </div>
          )}

          {allTags.length > 0 && (
            <div className="tag-filters">
              {allTags.map((t) => (
                <button
                  key={t}
                  className={`tag-chip ${activeTag === t ? 'on' : ''}`}
                  onClick={() => setActiveTag(activeTag === t ? null : t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* 批量管理：作用于「当前列表」（默认/搜索/标签筛选后的结果） */}
          {videos.length > 0 && (
            <div className="batch-row">
              <span className="batch-hint">批量管理当前 {filteredVideos.length} 条</span>
              {showBatch ? (
                <>
                  <input
                    className="batch-input"
                    placeholder="输入标签，多个用逗号分隔"
                    value={batchTags}
                    autoFocus
                    onChange={(e) => setBatchTags(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleBatchApply()
                      if (e.key === 'Escape') {
                        setShowBatch(false)
                        setBatchTags('')
                      }
                    }}
                  />
                  <button
                    className="btn-primary"
                    onClick={handleBatchApply}
                    disabled={filteredVideos.length === 0}
                  >
                    应用到当前 {filteredVideos.length} 条
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setShowBatch(false)
                      setBatchTags('')
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn-ghost batch-toggle"
                    onClick={() => setShowBatch(true)}
                    disabled={filteredVideos.length === 0}
                  >
                    🏷 批量打标签
                  </button>
                  <button
                    className="btn-danger batch-toggle"
                    onClick={handleBatchDelete}
                    disabled={filteredVideos.length === 0}
                  >
                    🗑 批量删除
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {videos.length === 0 ? (
          <div className="empty">
            {source === 'fav'
              ? '还没有收藏，先去上面抓一个，或点右上角「导入收藏夹」～'
              : source === 'toview'
                ? '稍后再看还是空的，点右上角「拉取稍后再看」试试～'
                : source === 'shared'
                  ? '还没有导入别人的分享——点右上角「导入分享文件」，或直接把 .json 文件拖进来～'
                  : '搜索列表还是空的——在上面搜关键词，勾选想要的视频后点「加入搜索列表」～'}
          </div>
        ) : filteredVideos.length === 0 ? (
          <div className="empty">
            没有符合当前筛选的{sourceLabel}，换个标签或状态试试
          </div>
        ) : (
          <ul className="list">
            {filteredVideos.map((v) => (
              <li
                key={v.id}
                className={`item ${v.watched ? 'watched' : ''} ${v.invalid ? 'invalid' : ''}`}
              >
                {v.cover && <img src={v.cover} alt={v.title} className="item-cover" />}
                <div className="item-body">
                  <div className="item-title">
                    <a
                      href={v.url}
                      onClick={(e) => {
                        e.preventDefault()
                        window.open(v.url, '_blank')
                      }}
                    >
                      {v.title}
                    </a>
                    {v.invalid && <span className="badge-invalid">已失效</span>}
                  </div>
                  <div className="item-meta">
                    {v.author && (
                      <span className="author">
                        {v.authorFace && (
                          <img src={v.authorFace} alt={v.author} className="author-face-sm" />
                        )}
                        {v.author}
                      </span>
                    )}
                    {v.duration > 0 && <span>⏱ {formatDuration(v.duration)}</span>}
                    {v.stat && v.stat.view > 0 && <span>▶ {formatCount(v.stat.view)}</span>}
                    <span className="bvid">{v.bvid}</span>
                    {source === 'shared' && v.shareFrom && (
                      <span className="share-from">来自 {v.shareFrom}</span>
                    )}
                    {(v.favTime > 0 || v.createdAt) && (
                      <span className="date">
                        {source === 'shared' ? '收录于' : '收藏于'}{' '}
                        {v.favTime > 0 ? formatDate(v.favTime) : v.createdAt}
                      </span>
                    )}
                  </div>

                  <div className="item-tags">
                    {editingId === v.id ? (
                      <input
                        className="tag-editor"
                        value={editTags}
                        autoFocus
                        onChange={(e) => setEditTags(e.target.value)}
                        onBlur={commitTags}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitTags()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        placeholder="输入标签，用逗号分隔"
                      />
                    ) : v.tags.length > 0 ? (
                      v.tags.map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="no-tag">暂无标签</span>
                    )}
                  </div>
                </div>

                <div className="item-actions">
                  <button
                    className={`btn-watched ${v.watched ? 'on' : ''}`}
                    title={v.watched ? '标记为没看' : '标记为看过'}
                    onClick={() => handleToggleWatched(v)}
                  >
                    {v.watched ? '已看' : '未看'}
                  </button>
                  <button className="btn-ghost" onClick={() => startEditTags(v)}>
                    标签
                  </button>
                  <button className="btn-danger" onClick={() => handleDelete(v)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showTagManager && (
        <div className="modal-overlay">
          <div className="modal tag-modal">
            <h3>标签管理 · {sourceLabel}</h3>

            {tagStats.length === 0 ? (
              <div className="empty">这个分区还没有任何标签～</div>
            ) : (
              <>
                <div className="tag-mgr-toolbar">
                  <span className="batch-hint">已选 {selectedTags.length} 个标签</span>
                  <button
                    className="btn-ghost"
                    onClick={() =>
                      setSelectedTags(
                        selectedTags.length === tagStats.length ? [] : tagStats.map((t) => t.name)
                      )
                    }
                  >
                    {selectedTags.length === tagStats.length ? '取消全选' : '全选'}
                  </button>
                </div>

                <div className="tag-mgr-list">
                  {tagStats.map((t) => (
                    <label
                      key={t.name}
                      className={`tag-mgr-item ${selectedTags.includes(t.name) ? 'on' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTags.includes(t.name)}
                        onChange={() => toggleTagSelect(t.name)}
                      />
                      <span className="tag-mgr-name" title={t.name}>
                        {t.name}
                      </span>
                      <span className="tag-mgr-count">{t.count}</span>
                    </label>
                  ))}
                </div>

                <div className="tag-mgr-rename">
                  <input
                    className="batch-input"
                    placeholder="新标签名（用于重命名 / 合并）"
                    value={renameTo}
                    onChange={(e) => setRenameTo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameTags()
                    }}
                  />
                  <button
                    className="btn-primary"
                    onClick={handleRenameTags}
                    disabled={tagBusy || selectedTags.length === 0 || !renameTo.trim()}
                  >
                    {selectedTags.length > 1 ? '合并为' : '重命名为'}这个
                  </button>
                </div>

                <div className="modal-actions">
                  <button
                    className="btn-danger"
                    onClick={handleDeleteTags}
                    disabled={tagBusy || selectedTags.length === 0}
                  >
                    🗑 删除选中标签
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setShowTagManager(false)
                      setSelectedTags([])
                      setRenameTo('')
                    }}
                  >
                    关闭
                  </button>
                </div>
                <p className="tag-mgr-tip">
                  重命名 / 合并只改标签名，不影响视频；若目标标签已存在会自动去重合并。
                </p>
              </>
            )}

            {tagStats.length === 0 && (
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowTagManager(false)}>
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showFolderPicker && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>选择要导入的收藏夹</h3>
            {favFolders.length === 0 ? (
              <div className="empty">加载收藏夹中…</div>
            ) : (
              <select
                className="folder-select"
                value={selectedFolder}
                onChange={(e) => setSelectedFolder(e.target.value)}
              >
                {favFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}（{f.mediaCount} 条）
                  </option>
                ))}
              </select>
            )}
            <div className="modal-actions">
              <button
                className="btn-primary"
                onClick={handleDoImport}
                disabled={importing || !selectedFolder}
              >
                {importing ? '导入中…' : '开始导入'}
              </button>
              <button className="btn-ghost" onClick={() => setShowFolderPicker(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        <p>数据保存在本地 SQLite，仅抓取公开元信息</p>
      </footer>

      {dragging && (
        <div className="drop-mask">
          <div className="drop-mask-inner">
            <div className="drop-icon">📥</div>
            <div>松手即可导入分享文件</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

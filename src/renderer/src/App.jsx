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

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetchResult, setFetchResult] = useState(null)
  const [error, setError] = useState('')

  const [videos, setVideos] = useState([])
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState('')

  const [editingId, setEditingId] = useState(null)
  const [editTags, setEditTags] = useState('')

  // 筛选状态：当前选中的标签（单选，null 表示不筛）、追番状态
  const [activeTag, setActiveTag] = useState(null)
  const [watchFilter, setWatchFilter] = useState('all') // 'all' | 'watched' | 'unwatched'

  // 登录状态 + 收藏夹导入
  const [loginInfo, setLoginInfo] = useState(null)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [favFolders, setFavFolders] = useState([])
  const [selectedFolder, setSelectedFolder] = useState('')
  const [importing, setImporting] = useState(false)

  // 刷新收藏列表（带关键词搜索）
  async function refresh(key = keyword) {
    try {
      const res = key.trim()
        ? await window.api.searchVideos(key.trim())
        : await window.api.listVideos()
      if (Array.isArray(res)) setVideos(res)
      else if (res && res.error) setError(res.error)
    } catch (err) {
      setError(err.message || '读取收藏失败')
    }
  }

  useEffect(() => {
    refresh('')
    // 启动时检查登录状态
    window.api
      .checkLogin()
      .then((info) => setLoginInfo(info))
      .catch(() => setLoginInfo({ loggedIn: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关键词变化时实时搜索
  useEffect(() => {
    const t = setTimeout(() => refresh(keyword), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword])

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
      const res = await window.api.saveVideo(fetchResult)
      if (res.error) {
        setError(res.error)
        return
      }
      flash(res.exists ? '这条视频之前已经收藏过啦～' : '已保存到本地收藏 ✅')
      setFetchResult(null)
      setUrl('')
      refresh(keyword)
    } catch (err) {
      setError(err.message || '保存失败')
    }
  }

  async function handleDelete(video) {
    if (!window.confirm(`确定要删除「${video.title}」吗？`)) return
    try {
      const res = await window.api.deleteVideo(video.id)
      if (res.error) setError(res.error)
      else refresh(keyword)
    } catch (err) {
      setError(err.message || '删除失败')
    }
  }

  async function handleToggleWatched(video) {
    try {
      const res = await window.api.updateVideo(video.id, { watched: !video.watched })
      if (res.error) setError(res.error)
      else refresh(keyword)
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
      refresh(keyword)
    } catch (err) {
      setError(err.message || '导入失败')
    } finally {
      setImporting(false)
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
      const res = await window.api.updateVideo(editingId, { tags })
      if (res.error) setError(res.error)
      else refresh(keyword)
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

  // 在关键词结果之上，再叠加标签筛选 + 追番状态筛选（纯前端过滤）
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
    return list
  }, [videos, activeTag, watchFilter])

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>B站收藏管理</h1>
          <div className="header-actions">
            {loginInfo && loginInfo.loggedIn ? (
              <>
                {loginInfo.face && (
                  <img src={loginInfo.face} alt={loginInfo.uname} className="login-face" />
                )}
                <span className="login-name">{loginInfo.uname || '已登录'}</span>
                <button className="btn-open-client" onClick={handleOpenImport}>
                  导入收藏夹
                </button>
                <button className="btn-open-client" onClick={handleLogout}>
                  退出
                </button>
              </>
            ) : (
              <button className="btn-open-client" onClick={handleLogin}>
                登录B站
              </button>
            )}
            <button className="btn-open-client" onClick={handleOpenBilibili}>
              打开B站客户端
            </button>
          </div>
        </div>
        <p className="subtitle">粘贴 B 站视频链接，抓取公开信息并存入本地</p>
      </header>

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

      <div className="section">
        <div className="section-head">
          <h2>我的收藏（{filteredVideos.length}）</h2>
          <input
            type="text"
            className="search-input"
            placeholder="搜索标题 / BV号 / 标签…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
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
        </div>

        {videos.length === 0 ? (
          <div className="empty">还没有收藏，先去上面抓一个吧～</div>
        ) : filteredVideos.length === 0 ? (
          <div className="empty">没有符合当前筛选的收藏，换个标签或状态试试</div>
        ) : (
          <ul className="list">
            {filteredVideos.map((v) => (
              <li key={v.id} className={`item ${v.watched ? 'watched' : ''}`}>
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
                    {v.createdAt && <span className="date">收藏于 {v.createdAt}</span>}
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
    </div>
  )
}

export default App

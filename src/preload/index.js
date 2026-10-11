const { contextBridge, ipcRenderer } = require('electron')

// 通过 contextBridge 把安全的方法暴露给渲染进程
contextBridge.exposeInMainWorld('api', {
  // 抓取 B 站视频公开元信息
  fetchVideoInfo: (url) => ipcRenderer.invoke('fetch-video-info', url),

  // 本地存储（source: 'fav' 收藏 / 'toview' 稍后再看）
  saveVideo: (video, source) => ipcRenderer.invoke('save-video', video, source),
  listVideos: (source) => ipcRenderer.invoke('list-videos', source),
  searchVideos: (keyword, source) => ipcRenderer.invoke('search-videos', keyword, source),
  updateVideo: (id, fields, source) => ipcRenderer.invoke('update-video', id, fields, source),
  deleteVideo: (id, source) => ipcRenderer.invoke('delete-video', id, source),
  batchAddTags: (ids, tags, source) => ipcRenderer.invoke('batch-add-tags', ids, tags, source),
  batchDeleteVideos: (ids, source) => ipcRenderer.invoke('batch-delete-videos', ids, source),

  // 标签管理（分区级重命名 / 合并 / 删除）与统计面板
  listTagStats: (source) => ipcRenderer.invoke('list-tag-stats', source),
  editTags: (fromTags, toTag, source) => ipcRenderer.invoke('edit-tags', fromTags, toTag, source),
  getStats: (source) => ipcRenderer.invoke('get-stats', source),
  checkInvalidVideos: (source) => ipcRenderer.invoke('check-invalid', source),
  // 订阅检测进度；返回取消订阅函数
  onCheckInvalidProgress: (cb) => {
    const listener = (_event, progress) => cb(progress)
    ipcRenderer.on('check-invalid-progress', listener)
    return () => ipcRenderer.removeListener('check-invalid-progress', listener)
  },

  // 全站搜索（B站 wbi 签名，需登录）+ 勾选结果入库
  searchBili: (keyword) => ipcRenderer.invoke('search-bili', keyword),
  importSearchItems: (items) => ipcRenderer.invoke('import-search-items', items),

  // 检查更新 + 打开外部链接（下载页）
  // manual=true 表示用户手动点击（跳过缓存立即检查）；不传则为启动静默检查（走缓存）
  checkUpdate: (manual) => ipcRenderer.invoke('check-update', manual),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 打开 B 站客户端（没装则退回网页）
  openBilibiliApp: () => ipcRenderer.invoke('open-bilibili'),

  // B 站登录 + 收藏夹 / 稍后再看导入
  checkLogin: () => ipcRenderer.invoke('check-login'),
  openLogin: () => ipcRenderer.invoke('open-login'),
  logout: () => ipcRenderer.invoke('logout'),
  listFavFolders: () => ipcRenderer.invoke('list-fav-folders'),
  importFavorites: (mediaId) => ipcRenderer.invoke('import-favorites', mediaId),
  importWatchLater: () => ipcRenderer.invoke('import-watch-later'),

  // 导出 / 导入他人分享
  exportVideos: (source) => ipcRenderer.invoke('export-videos', source),
  pickShareFile: () => ipcRenderer.invoke('pick-share-file'),
  importShareData: (payload) => ipcRenderer.invoke('import-share-data', payload)
})

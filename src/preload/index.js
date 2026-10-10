const { contextBridge, ipcRenderer } = require('electron')

// 通过 contextBridge 把安全的方法暴露给渲染进程
contextBridge.exposeInMainWorld('api', {
  // 抓取 B 站视频公开元信息
  fetchVideoInfo: (url) => ipcRenderer.invoke('fetch-video-info', url),

  // 本地收藏存储
  saveVideo: (video) => ipcRenderer.invoke('save-video', video),
  listVideos: () => ipcRenderer.invoke('list-videos'),
  searchVideos: (keyword) => ipcRenderer.invoke('search-videos', keyword),
  updateVideo: (id, fields) => ipcRenderer.invoke('update-video', id, fields),
  deleteVideo: (id) => ipcRenderer.invoke('delete-video', id),

  // 打开 B 站客户端（没装则退回网页）
  openBilibiliApp: () => ipcRenderer.invoke('open-bilibili'),

  // B 站登录 + 收藏夹导入
  checkLogin: () => ipcRenderer.invoke('check-login'),
  openLogin: () => ipcRenderer.invoke('open-login'),
  logout: () => ipcRenderer.invoke('logout'),
  listFavFolders: () => ipcRenderer.invoke('list-fav-folders'),
  importFavorites: (mediaId) => ipcRenderer.invoke('import-favorites', mediaId)
})

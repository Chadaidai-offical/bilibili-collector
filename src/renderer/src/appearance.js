// 外观设置落到 DOM 的入口。
// 这里刻意不用 React 渲染壁纸层：React 挂载是异步的，壁纸晚一帧出现就会闪一下白。
// 改成直接操作 DOM —— 页面加载时同步调用一次，之后设置面板改动时再调用。

const DEFAULTS = { cardOpacity: 0.72, wallpaperBlur: 0 }

export function applyAppearance(state) {
  if (!state) return
  const settings = state.settings || {}
  const root = document.documentElement

  const opacity =
    typeof settings.cardOpacity === 'number' ? settings.cardOpacity : DEFAULTS.cardOpacity
  const blur = typeof settings.wallpaperBlur === 'number' ? settings.wallpaperBlur : DEFAULTS.wallpaperBlur

  root.style.setProperty('--surface-a', String(opacity))
  // 弹窗要比卡片实：卡片可以很透，但弹窗里全是正文，透太多会被背后的列表文字干扰
  root.style.setProperty('--modal-a', String(Math.min(1, Math.max(0.9, opacity + 0.26))))
  root.style.setProperty('--wl-blur', `${blur}px`)

  const url = (state.resolved && state.resolved.url) || ''
  let layer = document.getElementById('wl-layer')

  if (url) {
    if (!layer) {
      layer = document.createElement('div')
      layer.id = 'wl-layer'
      document.body.insertBefore(layer, document.body.firstChild)
    }
    layer.style.backgroundImage = `url("${url}")`
    layer.style.filter = blur > 0 ? `blur(${blur}px)` : ''
    root.classList.add('has-wallpaper')
  } else {
    if (layer) layer.remove()
    root.classList.remove('has-wallpaper')
  }
}

// 首屏：同步取一次设置并立刻铺上（React 还没开始渲染）
export function applyAppearanceBoot() {
  try {
    const state = window.api && window.api.getAppearanceSync ? window.api.getAppearanceSync() : null
    if (state) applyAppearance(state)
    return state
  } catch {
    return null
  }
}

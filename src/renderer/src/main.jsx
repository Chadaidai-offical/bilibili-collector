import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { applyAppearanceBoot } from './appearance.js'
import './index.css'

// 先铺壁纸再渲染 React：设置是同步取的，所以首屏不会出现「先黑底再跳壁纸」
applyAppearanceBoot()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

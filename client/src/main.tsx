if (import.meta.env.DEV) {
  void import('react-grab')
  void import('react-scan')
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider, applyThemeToDom, readStoredTheme } from './theme/ThemeContext'
import './styles.css'

// 五主题：渲染前同步 data-theme（index.html 已有 early 脚本，这里兜底）
applyThemeToDom(readStoredTheme())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)

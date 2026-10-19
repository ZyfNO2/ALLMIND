import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './MemoryBookApp'
import './index.css'
import { managementSession } from './management-session'

// Refresh before mounting: a backend restart rotates the token, including in existing tabs.
void managementSession().catch(error => console.error('管理会话恢复失败', error.message)).finally(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
))

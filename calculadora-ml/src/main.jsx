import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './globals.css' // tokens primeiro — o styles.css consome daqui
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

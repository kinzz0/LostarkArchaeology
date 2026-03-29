import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// ONNX는 초기 번들·CSP 실패 시 앱 전체 흰 화면을 막기 위해 지연 로드
import('./detection/install-best-onnx-bridge.js')
  .then((m) => m.installBestOnnxDetectBridge())
  .catch(() => {})

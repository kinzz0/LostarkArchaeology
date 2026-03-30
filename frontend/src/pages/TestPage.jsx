import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { detectImage, warmupDetectModel } from '../services/api'

const DETECT_INTERVAL_MS = 600

export default function TestPage() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const [detections, setDetections] = useState([])
  const [status, setStatus] = useState('대기')
  const [running, setRunning] = useState(false)

  const stop = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setRunning(false)
    setStatus('중지됨')
  }, [])

  useEffect(() => () => stop(), [stop])

  const tickDetect = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video?.srcObject || video.readyState < 2) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, w, h)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return
    const file = new File([blob], 'frame.png', { type: 'image/png' })
    try {
      const res = await detectImage(file, { timeoutMs: 8000 })
      setDetections(Array.isArray(res?.detections) ? res.detections : [])
      setStatus(`탐지 ${res?.detections?.length ?? 0}개 (백엔드 YOLO CPU)`)
    } catch (e) {
      setStatus(e?.message || '탐지 실패')
    }
  }, [])

  const start = async () => {
    try {
      await warmupDetectModel()
    } catch {
      /* 워밍업 실패해도 계속 */
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play().catch(() => {})
    }
    setRunning(true)
    setStatus('탐지 중…')
    timerRef.current = window.setInterval(() => void tickDetect(), DETECT_INTERVAL_MS)
    void tickDetect()
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">탐지 테스트 (서버 YOLO CPU)</h1>
          <Link to="/" className="text-blue-400 hover:underline">
            홈
          </Link>
        </div>
        <p className="text-sm text-gray-400">{status}</p>
        <div className="flex gap-2">
          {!running ? (
            <button
              type="button"
              onClick={() => void start()}
              className="rounded bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500"
            >
              화면 공유 + 탐지 시작
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded bg-red-600 px-4 py-2 text-sm hover:bg-red-500"
            >
              중지
            </button>
          )}
        </div>
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />
        <div className="rounded border border-gray-700 bg-gray-950 p-4 font-mono text-sm">
          박스 수: {detections.length}
          <ul className="mt-2 max-h-48 overflow-auto text-xs text-gray-400">
            {detections.slice(0, 30).map((d, i) => (
              <li key={i}>
                {d.label} {d.confidence?.toFixed?.(3) ?? d.confidence}
              </li>
            ))}
            {detections.length > 30 ? <li>…</li> : null}
          </ul>
        </div>
      </div>
    </div>
  )
}

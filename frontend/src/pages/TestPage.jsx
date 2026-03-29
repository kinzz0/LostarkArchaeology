import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { detectImage, warmupDetectModel } from '../services/api'

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
const DETECT_DOWNSAMPLE_SCALE = 0.75
const LIVE_DETECT_MIN_INTERVAL_MS = 300

function TestPage() {
  const [status, setStatus] = useState('idle')
  const [detections, setDetections] = useState([])
  const [liveScan, setLiveScan] = useState({ result: null, confidence: null })
  const [modelReady, setModelReady] = useState(false)
  const [lastError, setLastError] = useState(null)
  const [lastLatencyMs, setLastLatencyMs] = useState(null)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const liveDetectIntervalRef = useRef(null)
  const detectingRef = useRef(false)
  const pendingDetectRef = useRef(false)
  const streamRef = useRef(null)
  const latestDetectionsRef = useRef([])

  const drawVideoWithDetections = useCallback((video, canvas, dets) => {
    if (!video || !canvas) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return

    const outCtx = canvas.getContext('2d')
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    outCtx.drawImage(video, 0, 0)
    outCtx.lineWidth = 3
    outCtx.font = '14px sans-serif'

    for (let i = 0; i < (dets || []).length; i++) {
      const d = dets[i]
      const cid = typeof d.class_id === 'number' ? d.class_id : i
      const color = COLORS[cid % COLORS.length] || '#22c55e'
      outCtx.strokeStyle = color
      outCtx.fillStyle = color

      if (d.obb && d.bbox && d.bbox.length === 8) {
        const [x1, y1, x2, y2, x3, y3, x4, y4] = d.bbox
        outCtx.beginPath()
        outCtx.moveTo(x1, y1)
        outCtx.lineTo(x2, y2)
        outCtx.lineTo(x3, y3)
        outCtx.lineTo(x4, y4)
        outCtx.closePath()
        outCtx.stroke()
        outCtx.fillText(
          `${d.label} ${((d.confidence ?? 0) * 100).toFixed(0)}%`,
          x1,
          Math.max(14, Math.min(y1, y4) - 4)
        )
      } else {
        const [x1, y1, x2, y2] = d.bbox || []
        if (x1 != null) {
          outCtx.strokeRect(x1, y1, x2 - x1, y2 - y1)
          outCtx.fillText(
            `${d.label} ${((d.confidence ?? 0) * 100).toFixed(0)}%`,
            x1,
            Math.max(14, y1 - 4)
          )
        }
      }
    }
  }, [])

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    if (liveDetectIntervalRef.current != null) {
      clearInterval(liveDetectIntervalRef.current)
      liveDetectIntervalRef.current = null
    }
    setDetections([])
    latestDetectionsRef.current = []
    setLiveScan({ result: null, confidence: null })
    pendingDetectRef.current = false
    setLastError(null)
    setLastLatencyMs(null)
    setStatus('idle')
  }, [])

  const captureAndDetect = useCallback(async () => {
    if (detectingRef.current) {
      pendingDetectRef.current = true
      return
    }

    const video = videoRef.current
    if (!video || !video.srcObject || video.readyState < 2) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) return

    const offscreen = document.createElement('canvas')
    const detectW = Math.max(1, Math.round(w * DETECT_DOWNSAMPLE_SCALE))
    const detectH = Math.max(1, Math.round(h * DETECT_DOWNSAMPLE_SCALE))
    offscreen.width = detectW
    offscreen.height = detectH
    const ctx = offscreen.getContext('2d')
    ctx.drawImage(video, 0, 0, detectW, detectH)

    const blob = await new Promise((resolve) => {
      offscreen.toBlob((b) => resolve(b), 'image/png')
    })
    if (!blob) return

    detectingRef.current = true
    const file = new File([blob], 'frame.png', { type: 'image/png' })

    try {
      const t0 = performance.now()
      const res = await detectImage(file, { timeoutMs: 4000 })
      setLastLatencyMs(Math.round(performance.now() - t0))
      setLastError(null)
      const dets = res.detections || []
      setDetections(dets)
      latestDetectionsRef.current = dets
      setLiveScan({
        result: res.scan_result ?? null,
        confidence: res.scan_confidence ?? null,
      })
    } catch (e) {
      setDetections([])
      latestDetectionsRef.current = []
      setLiveScan({ result: null, confidence: null })
      setLastError(e?.message || String(e))
    } finally {
      detectingRef.current = false
      if (pendingDetectRef.current) {
        pendingDetectRef.current = false
        queueMicrotask(() => captureAndDetect())
      }
    }
  }, [])

  const handleStartShare = async () => {
    setStatus('idle')
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      streamRef.current = s
      setStatus('sharing')
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        setStatus('idle')
      } else {
        setStatus('error')
      }
    }
  }

  useEffect(() => {
    if (status !== 'sharing' || !streamRef.current) return
    const video = videoRef.current
    if (!video) return

    let cancelled = false

    const clearDetectInterval = () => {
      if (liveDetectIntervalRef.current != null) {
        clearInterval(liveDetectIntervalRef.current)
        liveDetectIntervalRef.current = null
      }
    }

    video.srcObject = streamRef.current
    const p = video.play().then(async () => {
      if (cancelled) return
      try {
        await warmupDetectModel()
        if (!cancelled) setModelReady(true)
      } catch (e) {
        if (!cancelled) {
          setModelReady(false)
          setLastError(e?.message || String(e))
        }
      }

      const displayLoop = () => {
        if (cancelled) return
        drawVideoWithDetections(video, canvasRef.current, latestDetectionsRef.current)
        animationRef.current = requestAnimationFrame(displayLoop)
      }
      animationRef.current = requestAnimationFrame(displayLoop)

      liveDetectIntervalRef.current = window.setInterval(() => {
        captureAndDetect()
      }, LIVE_DETECT_MIN_INTERVAL_MS)
      queueMicrotask(() => {
        if (!cancelled) captureAndDetect()
      })
    })

    return () => {
      cancelled = true
      clearDetectInterval()
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      setModelReady(false)
      p.catch(() => {})
    }
  }, [status, captureAndDetect, drawVideoWithDetections])

  useEffect(() => {
    return () => stopStream()
  }, [stopStream])

  const labelSummary = detections.reduce((acc, d) => {
    const lab = d?.label || '(?)'
    acc[lab] = (acc[lab] || 0) + 1
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-6">
            <h1 className="text-2xl font-bold text-blue-400">박스 탐지 확인</h1>
            <nav className="flex gap-3 text-sm">
              <Link to="/test" className="text-blue-400 font-medium">테스트</Link>
              <Link to="/track-ocr-results" className="text-gray-400 hover:text-gray-200">종합 OCR 결과</Link>
              <Link to="/" className="text-gray-400 hover:text-gray-200">대시보드</Link>
              <Link to="/data-collect" className="text-gray-400 hover:text-gray-200">데이터 수집</Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            {status === 'sharing' && (
              <span className="text-sm text-green-400 flex items-center gap-2">
                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                공유 중
              </span>
            )}
            {status === 'sharing' ? (
              <button
                type="button"
                onClick={stopStream}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                공유 중지
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartShare}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                화면 공유 시작
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {status === 'error' && (
          <p className="text-sm text-red-400 mb-4">화면 공유를 시작하지 못했습니다. 다시 시도하세요.</p>
        )}
        <p className="text-sm text-gray-500 mb-4">
          브라우저 ONNX로만 탐지합니다. 오른쪽 캔버스에 라벨·박스가 맞게 그려지는지 확인하세요.
          {status === 'sharing' && (
            <span className="ml-2 text-gray-400">
              모델: {modelReady ? '준비됨' : '로딩…'} · 주기 {LIVE_DETECT_MIN_INTERVAL_MS}ms
            </span>
          )}
        </p>

        {status !== 'sharing' ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <div className="text-5xl mb-4">📦</div>
            <p className="text-lg mb-2">화면 공유를 시작하세요</p>
            <p className="text-sm text-center max-w-md">
              원본(왼쪽)과 탐지 오버레이(오른쪽)를 비교해 박스 위치·라벨이 기대와 일치하는지만 보면 됩니다.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-gray-400">원본</h2>
              <div className="rounded-lg overflow-hidden bg-black border border-gray-700">
                <video ref={videoRef} muted playsInline className="w-full h-auto" />
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-gray-400">탐지 오버레이 (best.onnx)</h2>
              <div className="rounded-lg overflow-hidden bg-black border border-gray-700">
                <canvas ref={canvasRef} className="w-full h-auto" />
              </div>
              <div className="text-xs text-gray-500 space-y-1">
                <p>
                  박스 수: <span className="text-gray-300 font-mono">{detections.length}</span>
                  {lastLatencyMs != null && (
                    <span className="ml-3">지연: <span className="text-gray-300 font-mono">{lastLatencyMs}ms</span></span>
                  )}
                </p>
                {liveScan.result && (
                  <p className="text-amber-400/90">
                    스캔 집계(common/uncommon):{' '}
                    <span className="text-gray-200 font-medium">{liveScan.result}</span>
                    {liveScan.confidence != null && (
                      <span className="text-gray-500 ml-1">({(liveScan.confidence * 100).toFixed(0)}%)</span>
                    )}
                  </p>
                )}
                {Object.keys(labelSummary).length > 0 && (
                  <p className="text-gray-400">
                    라벨별:{' '}
                    {Object.entries(labelSummary)
                      .map(([k, v]) => `${k}×${v}`)
                      .join(', ')}
                  </p>
                )}
                {lastError && <p className="text-red-400 break-all">{lastError}</p>}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default TestPage

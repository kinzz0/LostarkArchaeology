import { useState, useRef, useCallback } from 'react'
import { captureScreen, detectImage } from '../services/api'

const TRIGGER_LABELS = ['common', 'uncommon', 'chest']
const DETECT_CHECK_MS = 1500   // 1.5초마다 감지 체크
const BURST_INTERVAL_MS = 500 // 1초마다 캡처 
const BURST_COUNT = 10         // 10장    

export default function ScreenCapture({ onCapture, onStatusChange }) {
  const [isCapturing, setIsCapturing] = useState(false)
  const [captureMode, setCaptureMode] = useState(null)
  const [intervalId, setIntervalId] = useState(null)
  const [captureDelay, setCaptureDelay] = useState(5)
  const streamRef = useRef(null)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const isInBurstRef = useRef(false)
  const detectIntervalIdRef = useRef(null)



  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  /** 공유 중인 화면에서 한 프레임을 캡처해 File로 반환 */
  const captureFrame = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || !streamRef.current || video.readyState < 2) return null

    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) return null

    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)

    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(null)
            return
          }
          const file = new File([blob], `capture_${Date.now()}.png`, { type: 'image/png' })
          resolve(file)
        },
        'image/png',
        0.95
      )
    })
  }, [])

  const sendCapture = useCallback(
    async (file) => {
      if (!file) return
      const result = await captureScreen(file)
      onCapture({
        id: Date.now(),
        filename: result.filename,
        preview: result.image_url,
        timestamp: result.timestamp || new Date().toISOString(),
        detections: result.detections || [],
      })
      onStatusChange({ message: '캡처 완료!', type: 'success' })
    },
    [onCapture, onStatusChange]
  )


  /** common/uncommon/chest 감지 시 5초 동안 1초마다 캡처 */
  const runBurstCapture = useCallback(async () => {
    if (isInBurstRef.current) return
    isInBurstRef.current = true
    onStatusChange({ message: '객체 감지! 5초간 1초마다 캡처 중...', type: 'loading' })
    for (let i = 0; i < BURST_COUNT; i++) {
      if (!streamRef.current) break
      const file = await captureFrame()
      if (file) {
        try {
          await sendCapture(file)
        } catch (_) {}
      }
      if (i < BURST_COUNT - 1) await new Promise((r) => setTimeout(r, BURST_INTERVAL_MS))
    }
    isInBurstRef.current = false
  }, [sendCapture, onStatusChange])

  const handleDetectCapture = useCallback(async () => {
    if (captureMode === 'detect' && detectIntervalIdRef.current) {
      clearInterval(detectIntervalIdRef.current)
      detectIntervalIdRef.current = null
      setIsCapturing(false)
      setCaptureMode(null)
      stopStream()
      onStatusChange({ message: '감지 캡처 중지됨', type: 'idle' })
      return
    }

    onStatusChange({ message: '화면을 선택해 주세요...', type: 'loading' })
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => video.play().then(resolve).catch(reject)
      })

      setIsCapturing(true)
      setCaptureMode('detect')
      onStatusChange({ message: 'common/uncommon/chest 감지 대기 중...', type: 'loading' })
  
      const checkAndCapture = async () => {
        if (!streamRef.current || isInBurstRef.current) return
        const file = await captureFrame()
        if (!file) return
        try {
          const { detections = [] } = await detectImage(file)
          const hasTrigger = detections.some((d) => TRIGGER_LABELS.includes(d.label))
          if (hasTrigger) runBurstCapture()
        } catch (_) {}
      }
  
      await checkAndCapture()
      detectIntervalIdRef.current = setInterval(checkAndCapture, DETECT_CHECK_MS)
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        onStatusChange({ message: '화면 공유를 취소했습니다.', type: 'idle' })
      } else {
        onStatusChange({ message: `캡처 실패: ${error.message}`, type: 'error' })
      }
    }
  }, [captureMode, runBurstCapture, stopStream, onStatusChange])

  /** 화면 공유 시작 → 단일 캡처 1장 보내기 */
  const handleSingleCapture = async () => {
    onStatusChange({ message: '화면을 선택해 주세요...', type: 'loading' })
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      streamRef.current = stream

      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => video.play().then(resolve).catch(reject)
      })

      onStatusChange({ message: '캡처 중...', type: 'loading' })
      const file = await captureFrame()
      stopStream()
      if (file) {
        onStatusChange({ message: '서버로 전송 중...', type: 'loading' })
        await sendCapture(file)
      } else {
        onStatusChange({ message: '프레임 캡처에 실패했습니다.', type: 'error' })
      }
    } catch (error) {
      stopStream()
      if (error.name === 'NotAllowedError') {
        onStatusChange({ message: '화면 공유를 취소했습니다.', type: 'idle' })
      } else {
        onStatusChange({ message: `캡처 실패: ${error.message}`, type: 'error' })
      }
    }
  }

  /** 자동 캡처: 공유 시작 후 N초마다 캡처 전송 */
  const handleAutoCapture = async () => {
    if (captureMode === 'auto') {
      if (intervalId) clearInterval(intervalId)
      setIntervalId(null)
      setIsCapturing(false)
      setCaptureMode(null)
      stopStream()
      onStatusChange({ message: '자동 캡처 중지됨', type: 'idle' })
      return
    }

    onStatusChange({ message: '화면을 선택해 주세요...', type: 'loading' })
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      streamRef.current = stream

      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => video.play().then(resolve).catch(reject)
      })

      setIsCapturing(true)
      setCaptureMode('auto')
      onStatusChange({ message: `${captureDelay}초 간격으로 자동 캡처 중...`, type: 'loading' })

      const tick = async () => {
        const file = await captureFrame()
        if (file) {
          try {
            await sendCapture(file)
          } catch (_) {
            // 전송 실패 시 상태만 유지
          }
        }
      }

      await tick()
      const id = setInterval(tick, captureDelay * 1000)
      setIntervalId(id)
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        onStatusChange({ message: '화면 공유를 취소했습니다.', type: 'idle' })
      } else {
        onStatusChange({ message: `캡처 실패: ${error.message}`, type: 'error' })
      }
    }
  }

  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <h2 className="text-lg font-semibold mb-4 text-blue-300">화면 캡처 (화면 공유)</h2>

      {/* 숨김: 스트림 렌더링 및 캡처용 */}
      <video ref={videoRef} muted playsInline className="hidden" />
      <canvas ref={canvasRef} className="hidden" />

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-400">캡처 간격:</label>
          <input
            type="number"
            min="1"
            max="60"
            value={captureDelay}
            onChange={(e) => setCaptureDelay(Number(e.target.value))}
            className="w-20 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
          <span className="text-sm text-gray-400">초</span>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSingleCapture}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
          >
            단일 캡처
          </button>
          <button
            onClick={handleAutoCapture}
            className={`flex-1 font-medium py-2.5 px-4 rounded-lg transition-colors ${
              captureMode === 'auto' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {captureMode === 'auto' ? '자동 캡처 중지' : '자동 캡처 시작'}
          </button>
          <button
            onClick={handleDetectCapture}
            className={`flex-1 font-medium py-2.5 px-4 rounded-lg transition-colors ${
              captureMode === 'detect' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-amber-600 hover:bg-amber-700 text-white'
            }`}
          >
            {captureMode === 'detect' ? '감지 캡처 중지' : '감지 시 5초 캡처'}
          </button>
        </div>

        {captureMode === 'auto' && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <span className="inline-block w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            자동 캡처 진행 중... (공유 중인 화면이 캡처됩니다)
          </div>
        )}
        {captureMode === 'detect' && (
          <div className="flex items-center gap-2 text-sm text-amber-400">
            <span className="inline-block w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
            common/uncommon/chest 감지 대기 중... (감지 시 5초간 1초마다 캡처)
          </div>
        )}

        <p className="text-xs text-gray-500">
          단일/자동 캡처 시 브라우저에서 공유할 화면 또는 창을 선택하세요.
        </p>
      </div>
    </div>
  )
}

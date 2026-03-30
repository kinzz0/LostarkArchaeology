import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getTrackAndOcrJob, startTrackAndOcr, warmupDetectModel } from '../services/api'

function fileFromCanvas(canvas, name) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null)
          return
        }
        resolve(new File([blob], name, { type: 'image/png' }))
      },
      'image/png',
    )
  })
}

/** 정식 수집: 프레임만 업로드 → 백엔드 Ultralytics YOLO-OBB(CPU) + track-OCR */
export default function OfficialCollectPage() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const [status, setStatus] = useState('대기')
  const [busy, setBusy] = useState(false)

  const stopShare = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const startShare = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play().catch(() => {})
    }
    setStatus('화면 공유 중')
  }

  const collectAndQueue = async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video?.srcObject) {
      setStatus('먼저 화면 공유를 시작하세요.')
      return
    }
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) {
      setStatus('비디오 크기 없음')
      return
    }
    setBusy(true)
    try {
      await warmupDetectModel()
    } catch {
      /* optional */
    }
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    const files = []
    for (let i = 0; i < 12; i++) {
      ctx.drawImage(video, 0, 0, w, h)
      // eslint-disable-next-line no-await-in-loop
      const f = await fileFromCanvas(canvas, `collect_${i}.png`)
      if (f) files.push(f)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250))
    }
    if (files.length < 2) {
      setStatus('프레임이 부족합니다.')
      setBusy(false)
      return
    }
    setStatus('분석 큐 등록 중…')
    try {
      const q = await startTrackAndOcr(files, { yoloConfFallback: 0.5 })
      const jobId = q?.job_id
      if (!jobId) throw new Error('job_id 없음')
      setStatus(`등록됨: ${jobId}`)
      for (let t = 0; t < 120; t++) {
        // eslint-disable-next-line no-await-in-loop
        const st = await getTrackAndOcrJob(jobId)
        if (st.status === 'done') {
          setStatus(`완료 run_id=${st.result?.run_id ?? '—'}`)
          break
        }
        if (st.status === 'failed') {
          setStatus(st.error || '실패')
          break
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 800))
      }
    } catch (e) {
      setStatus(e?.message || '실패')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-lg font-semibold">정식 수집</h1>
          <Link to="/" className="text-blue-400 text-sm hover:underline">
            홈
          </Link>
        </div>
        <p className="text-sm text-gray-400">{status}</p>
        <p className="text-xs text-gray-500">
          프레임만 전송합니다. 탐지는 서버 Ultralytics YOLO-OBB CPU (`backend/models/best.pt` 등).
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void startShare()}
            className="rounded bg-emerald-700 px-3 py-2 text-sm disabled:opacity-50"
          >
            화면 공유
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void collectAndQueue()}
            className="rounded bg-amber-700 px-3 py-2 text-sm disabled:opacity-50"
          >
            12프레임 수집 후 분석
          </button>
          <button type="button" onClick={stopShare} className="rounded bg-gray-700 px-3 py-2 text-sm">
            공유 중지
          </button>
        </div>
        <video ref={videoRef} className="w-full rounded border border-gray-700" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  )
}

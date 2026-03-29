import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  detectImage,
  getAuthMe,
  getDbActionTypes,
  getDbScanResults,
  getTrackAndOcrJob,
  getMyToolSpecs,
  sendRunToDb,
  startTrackAndOcr,
} from '../services/api'

const ACTION_GAUGE_LABEL = 'action_gauge'
const MINI_LABEL = 'mini'
const DETECT_INTERVAL_MS = 500
/** action_gauge 트리거 후 수집 시간 */
const COLLECT_DURATION_ACTION_GAUGE_MS = 6000
/** mini 트리거 후 수집 시간 */
const COLLECT_DURATION_MINI_MS = 12000
const COLLECT_INTERVAL_MS = 250
const QUEUE_POLL_MS = 900
const NEXT_COLLECT_GAP_MS = 500
const TRIGGER_HOLD_MS = 1200
const DETECT_TIMEOUT_MS = 1500

function shortHexId(id, tail = 8) {
  if (!id || typeof id !== 'string') return '—'
  return id.length <= tail ? id : `…${id.slice(-tail)}`
}

function waitLabel(createdAt) {
  const s = Math.floor((Date.now() - createdAt) / 1000)
  if (s < 0) return '0초'
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  return `${m}분 ${s % 60}초`
}

function queueStatusLabel(status) {
  if (status === 'running') return '처리 중'
  if (status === 'queued') return '대기'
  return status || '대기'
}

function AnalysisQueuePanel({ jobs, collecting, sharing }) {
  const empty = !jobs.length
  return (
    <div className="rounded-lg border-2 border-amber-700/50 bg-gradient-to-b from-gray-900 to-gray-950 shadow-[inset_0_1px_0_rgba(251,191,36,0.08)] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-amber-950/40 border-b border-amber-800/40">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-500/15 border border-amber-500/35 text-amber-400">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 10h16M4 14h10M4 18h14"
              />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-amber-200 tracking-tight">분석 대기열</p>
            <p className="text-[10px] text-amber-500/80 uppercase tracking-wider">선입선출 · 백그라운드 OCR</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-gray-950 px-2.5 py-1 text-xs font-mono text-amber-100/90 border border-amber-900/50 tabular-nums">
            대기 <strong className="text-amber-300">{jobs.length}</strong>건
          </span>
        </div>
      </div>

      <div className="p-4">
        {empty ? (
          <div className="rounded-md border border-dashed border-gray-600 bg-gray-900/50 py-8 px-4 text-center">
            <p className="text-sm text-gray-500">대기 중인 분석 작업이 없습니다.</p>
            <p className="text-xs text-gray-600 mt-1">
              {sharing
                ? collecting
                  ? '프레임 수집이 끝나면 자동으로 번호가 발급됩니다.'
                  : '트리거가 감지되면 수집 후 이곳에 대기열이 표시됩니다.'
                : '화면공유를 시작하면 대기열이 활성화됩니다.'}
            </p>
          </div>
        ) : (
          <ol className="space-y-0 relative">
            {jobs.map((job, index) => {
              const isFirst = index === 0
              const isRunning = job.status === 'running'
              const isWaiting = job.status === 'queued' || (!isRunning && job.status !== 'failed')
              return (
                <li key={job.jobId} className="relative flex gap-0">
                  {index < jobs.length - 1 && (
                    <span
                      className="absolute left-[17px] top-9 bottom-0 w-0.5 bg-gradient-to-b from-amber-600/50 to-gray-700"
                      aria-hidden
                    />
                  )}
                  <div className="flex flex-col items-center pt-1 w-9 shrink-0 z-[1]">
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold tabular-nums border-2 ${
                        isFirst
                          ? isRunning
                            ? 'border-cyan-400 bg-cyan-950 text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.25)] animate-pulse'
                            : 'border-amber-400 bg-amber-950 text-amber-200'
                          : 'border-gray-600 bg-gray-800 text-gray-400'
                      }`}
                    >
                      {index + 1}
                    </span>
                  </div>
                  <div
                    className={`ml-3 mb-3 flex-1 min-w-0 rounded-lg border px-3 py-2.5 ${
                      isFirst
                        ? 'border-amber-600/60 bg-amber-950/20'
                        : 'border-gray-700 bg-gray-800/40'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            isFirst
                              ? isRunning
                                ? 'bg-cyan-500/20 text-cyan-300'
                                : 'bg-amber-500/20 text-amber-200'
                              : 'bg-gray-700 text-gray-400'
                          }`}
                        >
                          {isFirst ? (isRunning ? '창구 처리 중' : '다음 순번') : '대기'}
                        </span>
                        <span className="text-xs text-gray-500 truncate">
                          대기 {waitLabel(job.createdAt)} · run{' '}
                          <code className="text-gray-400">{shortHexId(job.runId)}</code>
                        </span>
                      </div>
                      <span
                        className={`text-xs font-semibold shrink-0 ${
                          isRunning ? 'text-cyan-300' : isWaiting ? 'text-gray-400' : 'text-gray-500'
                        }`}
                      >
                        {queueStatusLabel(job.status)}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-600 font-mono mt-1 truncate" title={job.jobId}>
                      job {shortHexId(job.jobId, 12)}
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

function OfficialCollectPage() {
  const [user, setUser] = useState(null)
  const [specs, setSpecs] = useState([])
  const [selectedSpecId, setSelectedSpecId] = useState('')
  const [status, setStatus] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [scanResults, setScanResults] = useState([])
  const [actionTypes, setActionTypes] = useState([])
  const [lastRunId, setLastRunId] = useState('')
  /** 분석 대기열 (FIFO). job 상태는 폴링으로 갱신 */
  const [queueJobs, setQueueJobs] = useState([])
  const videoRef = useRef(null)
  /** 수집 전용 — `collectAndSend`만 사용 (탐지와 캔버스 경쟁 방지) */
  const canvasRef = useRef(null)
  /** 탐지 전용 — `detectLoop`만 사용, 분석 큐 대기 중에도 트리거 갱신 가능 */
  const detectCanvasRef = useRef(null)
  const streamRef = useRef(null)
  const detectTimerRef = useRef(null)
  const queuePollTimerRef = useRef(null)
  const lastCollectStartedAtRef = useRef(0)
  const collectingRef = useRef(false)
  const detectingRef = useRef(false)
  const queuePollingRef = useRef(false)
  const pendingJobsRef = useRef([])
  const lastActionGaugeAtRef = useRef(0)
  const lastMiniAtRef = useRef(0)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const [me, mySpecs, scans, actions] = await Promise.all([
          getAuthMe(),
          getMyToolSpecs(),
          getDbScanResults(),
          getDbActionTypes(),
        ])
        if (!mounted) return
        setUser(me)
        const arr = Array.isArray(mySpecs?.tool_specs) ? mySpecs.tool_specs : []
        setSpecs(arr)
        if (arr[0]?.id) setSelectedSpecId(String(arr[0].id))
        setScanResults(scans?.scan_results || [])
        setActionTypes(actions?.action_types || [])
      } catch (e) {
        if (!mounted) return
        setStatus(e.message || '초기 로드 실패')
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  const selectedSpec = useMemo(
    () => specs.find((s) => String(s.id) === String(selectedSpecId)) || null,
    [selectedSpecId, specs]
  )

  const fileFromCanvas = useCallback(async (canvas, name) => {
    return new Promise((resolve) => {
      canvas.toBlob((b) => {
        if (!b) return resolve(null)
        resolve(new File([b], name, { type: 'image/png' }))
      }, 'image/png')
    })
  }, [])

  const stopSharing = useCallback(() => {
    if (detectTimerRef.current != null) {
      clearInterval(detectTimerRef.current)
      detectTimerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    if (queuePollTimerRef.current != null) {
      clearInterval(queuePollTimerRef.current)
      queuePollTimerRef.current = null
    }
    collectingRef.current = false
    queuePollingRef.current = false
    pendingJobsRef.current = []
    setQueueJobs([])
    setCollecting(false)
    setSharing(false)
  }, [])

  const enqueueAnalysisJob = useCallback(async (files) => {
    const queued = await startTrackAndOcr(files)
    const jobId = queued?.job_id
    if (!jobId) throw new Error('분석 작업 등록 실패: job_id 없음')
    const runId = queued?.run_id || ''
    const entry = { jobId, runId, createdAt: Date.now(), status: 'queued' }
    pendingJobsRef.current.push(entry)
    setQueueJobs((prev) => [...prev, { ...entry }])
    setStatus(`분석 큐 등록됨 (대기 ${pendingJobsRef.current.length}건)`)
  }, [])

  const pollQueueJobs = useCallback(async () => {
    if (queuePollingRef.current) return
    if (!pendingJobsRef.current.length) return
    queuePollingRef.current = true
    try {
      const remaining = []
      const displayRow = []
      for (const job of pendingJobsRef.current) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const st = await getTrackAndOcrJob(job.jobId)
          if (st?.status === 'done') {
            const result = st?.result
            const scan = scanResults.find((x) => x.label === result?.scan_result)
            const action = actionTypes.find((x) => x.label === result?.action_type)
            // eslint-disable-next-line no-await-in-loop
            await sendRunToDb(result.run_id, {
              user_id: user?.user_id,
              tool_spec_id: Number(selectedSpecId),
              scan_result_id: scan?.id ?? null,
              action_type_id: action?.id ?? 1,
              gauge: Number(result?.gauge_consumed ?? 0),
              auto_verify: true,
            })
            setLastRunId(result.run_id)
            setStatus('수집됨')
          } else if (st?.status === 'failed') {
            setStatus(st?.error || '분석 작업 실패')
          } else {
            const status = st?.status || 'queued'
            remaining.push({ ...job, runId: st?.run_id || job.runId, status })
            displayRow.push({
              jobId: job.jobId,
              runId: st?.run_id || job.runId,
              createdAt: job.createdAt,
              status,
            })
          }
        } catch {
          remaining.push(job)
          displayRow.push({
            jobId: job.jobId,
            runId: job.runId,
            createdAt: job.createdAt,
            status: job.status || 'queued',
          })
        }
      }
      pendingJobsRef.current = remaining
      setQueueJobs(displayRow)
    } finally {
      queuePollingRef.current = false
    }
  }, [actionTypes, scanResults, selectedSpecId, user?.user_id])

  const collectAndSend = useCallback(async (durationMs, statusLine) => {
    const ms = Number(durationMs) > 0 ? Number(durationMs) : COLLECT_DURATION_ACTION_GAUGE_MS
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return

    collectingRef.current = true
    lastCollectStartedAtRef.current = Date.now()
    setCollecting(true)
    setStatus(statusLine || '트리거 감지: 프레임 수집 중...')
    const ctx = canvas.getContext('2d')
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const files = []
    const started = Date.now()
    let idx = 0
    while (Date.now() - started < ms) {
      if (!videoRef.current?.srcObject) break
      ctx.drawImage(video, 0, 0, w, h)
      const f = await fileFromCanvas(canvas, `collect_${idx++}.png`)
      if (f) files.push(f)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, COLLECT_INTERVAL_MS))
    }
    if (files.length < 2) {
      setStatus('수집 프레임이 부족합니다. 다시 시도하세요.')
      setCollecting(false)
      collectingRef.current = false
      return
    }

    // 프레임 캡처 단계가 끝나는 즉시 다음 트리거 수집을 허용한다.
    // (큐 등록/분석 시작 요청이 느려도 탐지/수집 루프는 계속 진행)
    setCollecting(false)
    collectingRef.current = false
    setStatus('분석 큐 등록 중..')
    void enqueueAnalysisJob(files).catch((e) => {
      setStatus(e.message || '수집/저장 실패')
    })
  }, [enqueueAnalysisJob, fileFromCanvas])

  const detectLoop = useCallback(async () => {
    // 수집 중에도 탐지는 돌린다(같은 캔버스 쓰면 깨지므로 detectCanvasRef 분리).
    // 새 수집 시작은 `canStartNextCollect`의 !collectingRef로만 막는다.
    if (detectingRef.current) return
    if (!videoRef.current || !detectCanvasRef.current) return
    const video = videoRef.current
    const canvas = detectCanvasRef.current
    if (!video.srcObject || video.readyState < 2) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    detectingRef.current = true
    try {
      const ctx = canvas.getContext('2d')
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.drawImage(video, 0, 0, w, h)
      const frame = await fileFromCanvas(canvas, `detect_${Date.now()}.png`)
      if (!frame) return
      const res = await detectImage(frame, { timeoutMs: DETECT_TIMEOUT_MS })
      const dets = res?.detections || []
      const hasActionGauge = dets.some((d) => d.label === ACTION_GAUGE_LABEL)
      const hasMini = dets.some((d) => d.label === MINI_LABEL)
      const now = Date.now()
      // 실제 화면에서는 mini와 action_gauge가 동시에 나오는 경우는 거의 없음. 같은 프레임에 둘 다 있으면 mini만 반영.
      if (hasMini) {
        lastMiniAtRef.current = now
      } else if (hasActionGauge) {
        lastActionGaugeAtRef.current = now
      }
      const miniInWindow = now - lastMiniAtRef.current <= TRIGGER_HOLD_MS
      const gaugeInWindow = now - lastActionGaugeAtRef.current <= TRIGGER_HOLD_MS
      const canStartNextCollect =
        !collectingRef.current && now - lastCollectStartedAtRef.current >= NEXT_COLLECT_GAP_MS
      if (canStartNextCollect) {
        // mini 트리거면 12초, 그렇지 않고 action_gauge 트리거면 6초 (둘 중 하나만 쓰는 흐름)
        if (miniInWindow) {
          void collectAndSend(
            COLLECT_DURATION_MINI_MS,
            `mini 감지: ${COLLECT_DURATION_MINI_MS / 1000}초 프레임 수집 중…`
          )
        } else if (gaugeInWindow) {
          void collectAndSend(
            COLLECT_DURATION_ACTION_GAUGE_MS,
            `action_gauge 감지: ${COLLECT_DURATION_ACTION_GAUGE_MS / 1000}초 프레임 수집 중…`
          )
        }
      }
    } catch {
      // detect 실패는 루프 유지
    } finally {
      detectingRef.current = false
    }
  }, [collectAndSend, fileFromCanvas])

  const startSharing = async () => {
    if (!user?.user_id) {
      setStatus('로그인이 필요합니다.')
      return
    }
    if (!selectedSpecId) {
      setStatus('생활 스펙을 선택하세요.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setSharing(true)
      setStatus(
        '화면공유 시작됨. action_gauge(6초) 또는 mini(12초) 중 하나가 감지되면 자동 수집·분석합니다.'
      )
      detectTimerRef.current = window.setInterval(() => {
        detectLoop()
      }, DETECT_INTERVAL_MS)
      queuePollTimerRef.current = window.setInterval(() => {
        pollQueueJobs()
      }, QUEUE_POLL_MS)
      const [track] = stream.getVideoTracks()
      if (track) {
        track.onended = () => stopSharing()
      }
    } catch (e) {
      setStatus(e.message || '화면 공유 시작 실패')
    }
  }

  useEffect(() => {
    return () => stopSharing()
  }, [stopSharing])

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-emerald-400">정식 데이터 수집</h1>
          <Link to="/" className="text-sm text-gray-300 hover:text-white">대시보드</Link>
        </div>
      </header>
      <main className="max-w-5xl mx-auto p-6 space-y-4">
        <div className="rounded border border-gray-700 bg-gray-800 p-4 space-y-3">
          <p className="text-sm text-gray-300">
            화면공유 기반 수집. 둘 중 하나만 나오는 흐름으로, <span className="text-gray-400">action_gauge</span> 탐지 시
            6초, <span className="text-gray-400">mini</span> 탐지 시 12초 동안 프레임을 모은 뒤 분석·DB 저장합니다.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            <div>
              <label className="text-sm text-gray-400 block mb-1">내 생활 스펙</label>
              <select
                value={selectedSpecId}
                onChange={(e) => setSelectedSpecId(e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm"
              >
                <option value="">선택 안 함</option>
                {specs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {selectedSpec && <p className="text-xs text-gray-500 mt-1">선택: {selectedSpec.name}</p>}
            </div>
            <div>
              <label className="text-sm text-gray-400 block mb-1">화면공유 미리보기</label>
              <video ref={videoRef} muted playsInline className="w-full rounded border border-gray-700 bg-black/60 max-h-64 object-contain" />
              <canvas ref={canvasRef} className="hidden" aria-hidden />
              <canvas ref={detectCanvasRef} className="hidden" aria-hidden />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={startSharing}
              disabled={sharing}
              className="rounded bg-emerald-600 px-4 py-2 text-sm hover:bg-emerald-500 disabled:opacity-60"
            >
              {sharing ? '공유 중...' : '화면공유 시작'}
            </button>
            <button
              type="button"
              onClick={stopSharing}
              disabled={!sharing}
              className="rounded bg-gray-700 px-4 py-2 text-sm hover:bg-gray-600 disabled:opacity-60"
            >
              화면공유 중지
            </button>
          </div>
          {status && <p className="text-sm text-cyan-300">{status}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 border ${
                collecting
                  ? 'border-emerald-600/50 bg-emerald-950/40 text-emerald-300'
                  : sharing
                    ? 'border-cyan-700/50 bg-cyan-950/30 text-cyan-300'
                    : 'border-gray-600 bg-gray-800/80 text-gray-400'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  collecting ? 'bg-emerald-400 animate-pulse' : sharing ? 'bg-cyan-400' : 'bg-gray-500'
                }`}
              />
              {collecting ? '프레임 수집 중' : sharing ? '탐지 루프 동작 중' : '일시 정지'}
            </span>
            {lastRunId && (
              <span className="text-gray-500">
                최근 저장 run <code className="text-gray-400">{shortHexId(lastRunId, 10)}</code>
              </span>
            )}
          </div>
          <AnalysisQueuePanel jobs={queueJobs} collecting={collecting} sharing={sharing} />
        </div>
      </main>
    </div>
  )
}

export default OfficialCollectPage

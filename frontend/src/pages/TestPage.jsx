import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { detectImage, ocrGaugeImage, trackAndOcr, checkHealth, warmupDetectModel } from '../services/api'

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
/** 숫자·게이지 바 UI — 실시간 미리보기·게이지 OCR 크롭 대상 (data.yaml: gauge) */
const GAUGE_LABEL = 'gauge'
/** 행동 구간 트리거 UI — chest/normal 자동 파이프라인만 (data.yaml: action_gauge) */
const ACTION_GAUGE_LABEL = 'action_gauge'
/** 수동 버튼·폴백용: 기존 트리거 라벨 */
const TRIGGER_LABELS = ['normal', 'chest', 'mini']
const ITEM_LABELS = ['common_item', 'uncommon_item', 'rare_item']
const DOUBLE_POTION_LABEL = 'double_potion'
/**
 * action_gauge 탐지 직후 이 시간(ms) 동안만 프레임을 모아 track-and-OCR 전송.
 * 백엔드에서 스캔 종류·아이템·행동 타입·게이지 등을 프레임들로 종합 추론한다.
 */
const ACTION_GAUGE_COLLECT_MS = 6000
/** 자동 수집 시 프레임 간격 (ms). 탐지는 track 전송 시에만 ONNX로 수행 */
const AUTO_TRACK_OCR_FRAME_INTERVAL_MS = 100
/** 같은 세션에서 자동 파이프라인 재실행 최소 간격 (수집 길이보다 커야 함) */
const AUTO_TRACK_OCR_COOLDOWN_MS = 7000
const DETECT_DOWNSAMPLE_SCALE = 0.75
/**
 * 라이브 ONNX 탐지 호출 최소 간격 (requestAnimationFrame에서만 스케줄).
 * 너무 낮추면 WASM 부하 증가; 너무 높으면 박스·common/uncommon 표시가 늦게 느껴짐.
 */
const LIVE_DETECT_MIN_INTERVAL_MS = 300
/** 탐지 후 게이지 OCR 자동 갱신 최소 간격 (ms) — 아이템 프레임 있을 때만 */
const GAUGE_OCR_THROTTLE_MS = 250
/** 게이지 OCR 목표 신뢰도 */
const GAUGE_OCR_TARGET_CONFIDENCE = 0.8
/** 목표 신뢰도 미만일 때 재시도 간격 */
const GAUGE_OCR_RETRY_INTERVAL_MS = 120
/** 무한 재시도로 UI가 잠기지 않도록 안전 상한 */
const GAUGE_OCR_MAX_RETRIES = 20
/** 탐지 전 게이지 기준선: 연속 샘플 프레임 수 (ONNX 워밍업 후 1회 실행) */
const GAUGE_BEFORE_BASELINE_FRAME_COUNT = 3
/** 기준선 각 프레임 사이 간격 */
const GAUGE_BEFORE_BASELINE_INTER_FRAME_MS = 120
/** 3프레임 중 어디에도 gauge 라벨이 없을 때, 다음 배치까지 대기 */
const GAUGE_BEFORE_BASELINE_BATCH_RETRY_GAP_MS = 400
/** 배치 재시도 상한 (gauge 미검출 시) */
const GAUGE_BEFORE_BASELINE_MAX_BATCH_RETRIES = 20
const PERF_LOG_ENABLED = true

function emptyGaugeSnapshot() {
  return {
    remaining: null,
    total: null,
    value: null,
    rawText: null,
    confidence: null,
  }
}

/** /detect/gauge-ocr 응답 → 표시용 스냅샷 */
/** 여러 스냅샷 중 OCR 신뢰도 최대인 것 선택 */
function pickBestGaugeSnapshot(snaps) {
  if (!snaps || snaps.length === 0) return emptyGaugeSnapshot()
  return snaps.reduce((best, s) => {
    const bc = best?.confidence != null ? Number(best.confidence) : -1
    const sc = s?.confidence != null ? Number(s.confidence) : -1
    return sc > bc ? s : best
  })
}

function gaugeOcrToSnapshot(ocr) {
  if (!ocr) return emptyGaugeSnapshot()
  const rem = ocr.gauge_remaining != null ? String(ocr.gauge_remaining).trim() : null
  const tot = ocr.gauge_total != null ? String(ocr.gauge_total).trim() : null
  const num =
    ocr.ocr_number != null && String(ocr.ocr_number).trim() !== ''
      ? String(ocr.ocr_number).trim()
      : null
  const value =
    rem != null && tot != null
      ? `${rem} / ${tot}`
      : rem != null || tot != null
        ? [rem, tot].filter(Boolean).join(' / ')
        : num ?? (ocr.ocr_text && String(ocr.ocr_text).trim() ? String(ocr.ocr_text).trim() : null)
  return {
    remaining: rem || null,
    total: tot || null,
    value: value || null,
    rawText: ocr.ocr_text ?? null,
    confidence: ocr.ocr_confidence ?? null,
  }
}

/** 탐지 bbox → 축정렬 사각형 (크롭용) */
function rectFromDetectionBbox(d) {
  if (!d?.bbox) return null
  if (d.bbox.length === 8) {
    const xs = [d.bbox[0], d.bbox[2], d.bbox[4], d.bbox[6]]
    const ys = [d.bbox[1], d.bbox[3], d.bbox[5], d.bbox[7]]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }
  if (d.bbox.length >= 4) {
    const [x1, y1, x2, y2] = d.bbox
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
  return null
}

/** 다운샘플 탐지 캔버스에서 `gauge` 박스 영역만 잘라 PNG File */
async function fileFromGaugeCrop(detectCanvas, detection, pad = 4) {
  const rect = rectFromDetectionBbox(detection)
  if (!rect || rect.w < 2 || rect.h < 2) return null
  const x = Math.max(0, Math.floor(rect.x - pad))
  const y = Math.max(0, Math.floor(rect.y - pad))
  const cw = detectCanvas.width
  const ch = detectCanvas.height
  const w = Math.min(cw - x, Math.ceil(rect.w + 2 * pad))
  const h = Math.min(ch - y, Math.ceil(rect.h + 2 * pad))
  if (w < 4 || h < 4) return null
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d').drawImage(detectCanvas, x, y, w, h, 0, 0, w, h)
  const blob = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'))
  if (!blob) return null
  return new File([blob], 'gauge_crop.png', { type: 'image/png' })
}

async function inferDetectionsForFile(file) {
  const res = await detectImage(file)
  return Array.isArray(res?.detections) ? res.detections : []
}

function TestPage() {
  const [status, setStatus] = useState('idle') // idle | sharing | error
  const [detections, setDetections] = useState([])
  /** ONNX 탐지 집계: common | uncommon 스캔 종류 (실시간 프리뷰) */
  const [liveScan, setLiveScan] = useState({ result: null, confidence: null })
  const [trackOcrStatus, setTrackOcrStatus] = useState('idle') // idle | loading | done | error
  const [trackOcrResult, setTrackOcrResult] = useState(null)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  /** 라이브 ONNX 탐지 전용 interval — 표시 루프(rAF)와 분리 */
  const liveDetectIntervalRef = useRef(null)
  const detectingRef = useRef(false)
  /** 이전 탐지가 끝나기 전에 또 스케줄되면 true → 완료 후 최신 프레임으로 한 번 더 실행 */
  const pendingDetectRef = useRef(false)
  const streamRef = useRef(null)
  const trackOcrPhaseRef = useRef(false)
  const trackOcrLastRunRef = useRef(0)
  const latestDetectionsRef = useRef([])
  /** 마지막 탐지 기준 스캔 힌트 (common|uncommon) — track-and-ocr에 전달 */
  const liveScanResultRef = useRef(null)
  /** 아이템 없을 때 gauge OCR — 탐지 전 숫자 */
  const [gaugeBefore, setGaugeBefore] = useState(() => emptyGaugeSnapshot())
  /** common/uncommon/rare_item 탐지된 프레임에서 gauge OCR — 탐지 후 숫자 */
  const [gaugeAfter, setGaugeAfter] = useState(() => emptyGaugeSnapshot())
  const [gaugeOcrBusy, setGaugeOcrBusy] = useState(false)
  /** 탐지 전 기준선: 서버 확인 → 모델 워밍업 → 3프레임 샘플 */
  const [gaugeBeforeInitPhase, setGaugeBeforeInitPhase] = useState('idle')
  /** 탐지 후 크롭 미리보기 (blob URL) */
  const [gaugeCropPreviewUrl, setGaugeCropPreviewUrl] = useState(null)
  const gaugeOcrPendingRef = useRef(false)
  /** 탐지 전 3프레임 기준선 루틴 완료 여부 (공유 세션당 1회) */
  const gaugeBaselineInitCompletedRef = useRef(false)
  /** 기준선(서버·워밍업·3프레임) 끝난 뒤에만 라이브 루프의 탐지 후 gauge OCR 허용 */
  const gaugeBaselineAllowLiveGaugeAfterRef = useRef(false)
  const lastGaugeAfterAtRef = useRef(0)

  useEffect(() => {
    return () => {
      if (gaugeCropPreviewUrl) URL.revokeObjectURL(gaugeCropPreviewUrl)
    }
  }, [gaugeCropPreviewUrl])

  const pickTriggerAction = useCallback((dets) => {
    const triggerDets = (dets || []).filter((d) => TRIGGER_LABELS.includes(d.label))
    if (triggerDets.length === 0) return null
    triggerDets.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    return triggerDets[0].label
  }, [])

  const pickHasDoublePotion = useCallback((dets) => {
    return (dets || []).some((d) => d.label === DOUBLE_POTION_LABEL)
  }, [])

  const drawVideoWithDetections = useCallback((video, canvas, dets) => {
    if (!video || !canvas) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return

    const outCtx = canvas.getContext('2d')
    // 매 프레임 width/height를 건드리면 캔버스가 전부 클리어되어 깜빡임·비용 증가 → 해상도 바뀔 때만 조정
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
          `${d.label} ${(d.confidence * 100).toFixed(0)}%`,
          x1,
          Math.max(14, Math.min(y1, y4) - 4)
        )
      } else {
        const [x1, y1, x2, y2] = d.bbox || []
        if (x1 != null) {
          outCtx.strokeRect(x1, y1, x2 - x1, y2 - y1)
          outCtx.fillText(
            `${d.label} ${(d.confidence * 100).toFixed(0)}%`,
            x1,
            Math.max(14, y1 - 4)
          )
        }
      }
    }
  }, [])

  /**
   * action_gauge 트리거 후 ACTION_GAUGE_COLLECT_MS 동안 프레임만 연속 캡처 → track-and-ocr.
   * (라이브 탐지 프로브 없이 캡처만 — 스캔·아이템·행동 등은 track-and-ocr 백엔드가 프레임으로 추론)
   */
  const startAutoTrackOcrFor5Seconds = useCallback(async (actionHint = null, hasDoublePotionHint = null) => {
    const video = videoRef.current
    if (!video || !video.srcObject || video.readyState < 2) {
      trackOcrPhaseRef.current = false
      setTrackOcrStatus('idle')
      return
    }
    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) {
      trackOcrPhaseRef.current = false
      setTrackOcrStatus('idle')
      return
    }

    const offscreen = document.createElement('canvas')
    offscreen.width = w
    offscreen.height = h
    const ctx = offscreen.getContext('2d')
    const delay = (ms) => new Promise((r) => setTimeout(r, ms))

    setTrackOcrStatus('loading')
    setTrackOcrResult(null)

    const files = []
    const frontendDetections = []
    const start = Date.now()
    const durationMs = ACTION_GAUGE_COLLECT_MS

    while (true) {
      ctx.drawImage(video, 0, 0)
      const blob = await new Promise((resolve) => {
        offscreen.toBlob((b) => resolve(b), 'image/png')
      })
      if (blob) {
        const file = new File([blob], `auto_${files.length}.png`, { type: 'image/png' })
        files.push(file)
        try {
          // 프론트 모델 결과를 프레임별로 전달하면 백엔드는 재탐지 없이 계산 가능.
          // eslint-disable-next-line no-await-in-loop
          const dets = await inferDetectionsForFile(file)
          frontendDetections.push(Array.isArray(dets) ? dets : [])
        } catch {
          frontendDetections.push([])
        }
      }

      const elapsed = Date.now() - start
      if (elapsed >= durationMs) {
        break
      }
      await delay(AUTO_TRACK_OCR_FRAME_INTERVAL_MS)
    }

    if (PERF_LOG_ENABLED) {
      console.log('[PERF][auto-collect]', {
        actionHint,
        collect_ms: ACTION_GAUGE_COLLECT_MS,
        elapsed_ms: Date.now() - start,
        frames: files.length,
      })
    }

    trackOcrPhaseRef.current = false
    trackOcrLastRunRef.current = Date.now()

    if (files.length < 2) {
      setTrackOcrStatus('error')
      setTrackOcrResult({ error: '수집된 프레임이 2장 미만입니다.' })
      return
    }

    try {
      const tJobStart = performance.now()
      const data = await trackAndOcr(files, {
        actionHint,
        scanHint: liveScanResultRef.current,
        hasDoublePotionHint,
        frontendDetections,
      })
      if (PERF_LOG_ENABLED) {
        console.log('[PERF][trackAndOcr-wait]', {
          actionHint,
          scanHint: liveScanResultRef.current,
          wait_ms: Math.round(performance.now() - tJobStart),
          tracked_count: data?.tracked_count,
        })
      }
      setTrackOcrResult(data)
      setTrackOcrStatus('done')
    } catch (e) {
      setTrackOcrResult({ error: e.message })
      setTrackOcrStatus('error')
    }
  }, [])

  /**
   * action_gauge 탐지 직후 곧바로 ACTION_GAUGE_COLLECT_MS 동안 프레임 수집 → track-and-ocr.
   * 행동/스캔/더블포션 등은 백엔드가 프레임들로 추론 (힌트 null). 라이브 스캔 미리보기는 scanHint로만 보조.
   */
  const runGaugeTriggeredPipeline = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.srcObject || video.readyState < 2) {
      trackOcrPhaseRef.current = false
      setTrackOcrStatus('idle')
      return
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      trackOcrPhaseRef.current = false
      setTrackOcrStatus('idle')
      return
    }
    try {
      await startAutoTrackOcrFor5Seconds(null, null)
    } catch (e) {
      console.error(e)
      setTrackOcrResult({ error: e?.message || String(e) })
      setTrackOcrStatus('error')
      trackOcrPhaseRef.current = false
    }
  }, [startAutoTrackOcrFor5Seconds])

  /**
   * 화면 공유 직후(health + warmup 이후): 3프레임 연속 캡처 → gauge 있으면 크롭 OCR.
   * 3프레임 모두에서 gauge 미검출이면 배치를 재시도한다.
   */
  const runGaugeBaselineThreeFrames = useCallback(async () => {
    const video = videoRef.current
    if (!video?.srcObject || video.readyState < 2 || video.videoWidth === 0) return

    const delay = (ms) => new Promise((r) => setTimeout(r, ms))
    const w = video.videoWidth
    const h = video.videoHeight
    const detectW = Math.max(1, Math.round(w * DETECT_DOWNSAMPLE_SCALE))
    const detectH = Math.max(1, Math.round(h * DETECT_DOWNSAMPLE_SCALE))
    const offscreen = document.createElement('canvas')
    offscreen.width = detectW
    offscreen.height = detectH
    const ctx = offscreen.getContext('2d')

    for (let batch = 0; batch < GAUGE_BEFORE_BASELINE_MAX_BATCH_RETRIES; batch++) {
      let sawGaugeLabel = false
      const ocrSnapshots = []
      for (let i = 0; i < GAUGE_BEFORE_BASELINE_FRAME_COUNT; i++) {
        ctx.drawImage(video, 0, 0, detectW, detectH)
        const blob = await new Promise((resolve) => {
          offscreen.toBlob((b) => resolve(b), 'image/png')
        })
        if (!blob) {
          await delay(GAUGE_BEFORE_BASELINE_INTER_FRAME_MS)
          continue
        }
        const file = new File([blob], `gauge_baseline_${batch}_${i}.png`, { type: 'image/png' })
        const res = await detectImage(file)
        const dets = res?.detections || []
        const gaugeDets = dets.filter((d) => d.label === GAUGE_LABEL)
        gaugeDets.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        const bestGauge = gaugeDets[0]
        if (bestGauge) sawGaugeLabel = true
        if (bestGauge) {
          const cropFile = await fileFromGaugeCrop(offscreen, bestGauge)
          if (cropFile) {
            try {
              const ocr = await ocrGaugeImage(cropFile)
              ocrSnapshots.push(gaugeOcrToSnapshot(ocr))
            } catch {
              // ignore
            }
          }
        }
        await delay(GAUGE_BEFORE_BASELINE_INTER_FRAME_MS)
      }
      if (sawGaugeLabel && ocrSnapshots.length > 0) {
        setGaugeBefore(pickBestGaugeSnapshot(ocrSnapshots))
        return
      }
      await delay(GAUGE_BEFORE_BASELINE_BATCH_RETRY_GAP_MS)
    }
    setGaugeBefore(emptyGaugeSnapshot())
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
    liveScanResultRef.current = null
    setLiveScan({ result: null, confidence: null })
    setGaugeBefore(emptyGaugeSnapshot())
    setGaugeAfter(emptyGaugeSnapshot())
    gaugeBaselineInitCompletedRef.current = false
    gaugeBaselineAllowLiveGaugeAfterRef.current = false
    setGaugeBeforeInitPhase('idle')
    setGaugeOcrBusy(false)
    setGaugeCropPreviewUrl(null)
    trackOcrPhaseRef.current = false
    pendingDetectRef.current = false
    setTrackOcrStatus('idle')
    setTrackOcrResult(null)
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
      const tDetectStart = performance.now()
      const res = await detectImage(file)
      if (PERF_LOG_ENABLED) {
        console.log('[PERF][detectImage]', {
          latency_ms: Math.round(performance.now() - tDetectStart),
          detections: res?.detections?.length ?? 0,
        })
      }
      const dets = res.detections || []
      setDetections(dets)
      latestDetectionsRef.current = dets
      const sr = res.scan_result ?? null
      liveScanResultRef.current = sr
      setLiveScan({
        result: sr,
        confidence: res.scan_confidence ?? null,
      })

      // action_gauge 탐지 시: 곧바로 N초 프레임 수집 → track-and-OCR (쿨다운으로 중복 방지)
      const hasActionGauge = dets.some((d) => d.label === ACTION_GAUGE_LABEL)
      const now = Date.now()
      const cooldownPassed = now - trackOcrLastRunRef.current > AUTO_TRACK_OCR_COOLDOWN_MS

      if (hasActionGauge && !trackOcrPhaseRef.current && cooldownPassed) {
        trackOcrPhaseRef.current = true
        runGaugeTriggeredPipeline()
      }

      const hasItemFrame = dets.some((d) => ITEM_LABELS.includes(d.label))
      const gaugeDets = dets.filter((d) => d.label === GAUGE_LABEL)
      gaugeDets.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      const bestGauge = gaugeDets[0]
      const nowTick = Date.now()

      const scheduleGaugeOcrAfter = () => {
        if (!bestGauge || gaugeOcrPendingRef.current) return
        if (nowTick - lastGaugeAfterAtRef.current < GAUGE_OCR_THROTTLE_MS) return
        lastGaugeAfterAtRef.current = nowTick
        gaugeOcrPendingRef.current = true
        setGaugeOcrBusy(true)
        ;(async () => {
          try {
            const delay = (ms) => new Promise((r) => setTimeout(r, ms))
            let tries = 0
            let bestSnap = null
            while (tries < GAUGE_OCR_MAX_RETRIES) {
              tries += 1
              const cropFile = await fileFromGaugeCrop(offscreen, bestGauge)
              if (!cropFile) break
              setGaugeCropPreviewUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev)
                return URL.createObjectURL(cropFile)
              })
              const ocr = await ocrGaugeImage(cropFile)
              if (!ocr) break
              const snap = gaugeOcrToSnapshot(ocr)
              const currConf = Number(snap?.confidence ?? 0)
              const prevConf = Number(bestSnap?.confidence ?? -1)
              if (currConf > prevConf) bestSnap = snap
              if (currConf >= GAUGE_OCR_TARGET_CONFIDENCE) break
              await delay(GAUGE_OCR_RETRY_INTERVAL_MS)
            }
            if (bestSnap) setGaugeAfter(bestSnap)
          } catch {
            // ignore
          } finally {
            gaugeOcrPendingRef.current = false
            setGaugeOcrBusy(false)
          }
        })()
      }

      if (hasItemFrame && gaugeBaselineAllowLiveGaugeAfterRef.current) {
        scheduleGaugeOcrAfter()
      }

    } catch (_) {
      setDetections([])
      latestDetectionsRef.current = []
      liveScanResultRef.current = null
      setLiveScan({ result: null, confidence: null })
    } finally {
      detectingRef.current = false
      if (pendingDetectRef.current) {
        pendingDetectRef.current = false
        queueMicrotask(() => captureAndDetect())
      }
    }
  }, [runGaugeTriggeredPipeline])

  /** 트래킹+OCR: 현재 비디오에서 프레임 N장 캡처 후 track-and-ocr API 호출 */
  const runTrackAndOcr = useCallback(async (frameCount = 5) => {
    const video = videoRef.current
    if (!video || !video.srcObject || video.readyState < 2) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) return

    const offscreen = document.createElement('canvas')
    offscreen.width = w
    offscreen.height = h
    const ctx = offscreen.getContext('2d')

    const files = []
    const frontendDetections = []
    const delay = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < frameCount; i++) {
      ctx.drawImage(video, 0, 0)
      const blob = await new Promise((resolve) => {
        offscreen.toBlob((b) => resolve(b), 'image/png')
      })
      if (blob) {
        const file = new File([blob], `frame_${i}.png`, { type: 'image/png' })
        files.push(file)
        try {
          // eslint-disable-next-line no-await-in-loop
          const dets = await inferDetectionsForFile(file)
          frontendDetections.push(Array.isArray(dets) ? dets : [])
        } catch {
          frontendDetections.push([])
        }
      }
      if (i < frameCount - 1) await delay(300)
    }

    if (files.length < 2) {
      setTrackOcrStatus('error')
      setTrackOcrResult({ error: '프레임이 2장 이상 필요합니다.' })
      return
    }

    setTrackOcrStatus('loading')
    setTrackOcrResult(null)
    try {
      const actionHint = pickTriggerAction(latestDetectionsRef.current)
      const hasDoublePotionHint = actionHint === 'normal' ? pickHasDoublePotion(latestDetectionsRef.current) : null
      const data = await trackAndOcr(files, {
        actionHint,
        scanHint: liveScanResultRef.current,
        hasDoublePotionHint,
        frontendDetections,
      })
      setTrackOcrResult(data)
      setTrackOcrStatus('done')
    } catch (e) {
      setTrackOcrResult({ error: e.message })
      setTrackOcrStatus('error')
    }
  }, [pickTriggerAction, pickHasDoublePotion])

  const handleStartShare = async () => {
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

  /**
   * 화면 공유 시 두 경로를 분리:
   * - 표시: requestAnimationFrame — 비디오 + 마지막 탐지 박스만 그림(끊김 최소화)
   * - 분석: setInterval — ONNX 탐지만 호출해 latestDetectionsRef·스캔 UI 갱신(백그라운드에 가깝게)
   */
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
    const p = video.play().then(() => {
      if (cancelled) return

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
      p.catch(() => {})
    }
  }, [status, captureAndDetect, drawVideoWithDetections])

  /** 화면 공유 직후: 서버 health → 모델 워밍업 → 3프레임으로 탐지 전 게이지 기준값 (gauge 미검출 시 배치 재시도) */
  useEffect(() => {
    if (status !== 'sharing') return
    if (gaugeBaselineInitCompletedRef.current) return
    let cancelled = false
    const tid = window.setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2 || v.videoWidth === 0) return
      clearInterval(tid)
      if (cancelled || gaugeBaselineInitCompletedRef.current) return
      ;(async () => {
        try {
          setGaugeBeforeInitPhase('server')
          await checkHealth()
          if (cancelled) return
          setGaugeBeforeInitPhase('warming')
          await warmupDetectModel()
          if (cancelled) return
          setGaugeBeforeInitPhase('sampling')
          setGaugeOcrBusy(true)
          await runGaugeBaselineThreeFrames()
          if (!cancelled) setGaugeBeforeInitPhase('ready')
        } catch (e) {
          console.error(e)
          if (!cancelled) {
            setGaugeBeforeInitPhase('error')
            setGaugeBefore(emptyGaugeSnapshot())
          }
        } finally {
          setGaugeOcrBusy(false)
          if (!cancelled) {
            gaugeBaselineInitCompletedRef.current = true
            gaugeBaselineAllowLiveGaugeAfterRef.current = true
          }
        }
      })()
    }, 50)
    return () => {
      cancelled = true
      clearInterval(tid)
    }
  }, [status, runGaugeBaselineThreeFrames])

  useEffect(() => {
    return () => stopStream()
  }, [stopStream])

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-2xl font-bold text-blue-400">객체 탐지 테스트</h1>
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
                onClick={stopStream}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                공유 중지
              </button>
            ) : (
              <button
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
        {status !== 'sharing' ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <div className="text-5xl mb-4">🖥️</div>
            <p className="text-lg mb-2">화면 공유를 시작하면</p>
            <p className="text-sm">왼쪽에는 원본, 오른쪽에는 객체 탐지 박스가 표시됩니다.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-gray-400">원본</h2>
              <div className="rounded-lg overflow-hidden bg-black border border-gray-700">
                <video ref={videoRef} muted playsInline className="w-full h-auto" />
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-gray-400">객체 탐지 (YOLOv8)</h2>
              <div className="rounded-lg overflow-hidden bg-black border border-gray-700">
                <canvas ref={canvasRef} className="w-full h-auto" />
              </div>
              {(detections.length > 0 || liveScan.result) && (
                <div className="text-xs text-gray-500 space-y-0.5">
                  {detections.length > 0 && <p>{detections.length}개 객체 탐지됨</p>}
                  {liveScan.result && (
                    <p className="text-amber-400/90">
                      스캔 종류:{' '}
                      <span className="text-gray-200 font-medium">
                        {liveScan.result === 'common' ? '일반 스캔' : liveScan.result === 'uncommon' ? '고급 스캔' : liveScan.result}
                      </span>
                      {liveScan.confidence != null && (
                        <span className="text-gray-500 ml-1">({(liveScan.confidence * 100).toFixed(0)}%)</span>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {status === 'sharing' && (
          <div className="mt-4 px-1">
            <div className="rounded-lg border border-cyan-800/50 bg-gray-800/80 px-4 py-3 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-cyan-400/90">게이지 숫자 OCR</span>
                {(gaugeBeforeInitPhase === 'server' ||
                  gaugeBeforeInitPhase === 'warming' ||
                  gaugeBeforeInitPhase === 'sampling' ||
                  gaugeBeforeInitPhase === 'error' ||
                  (gaugeBeforeInitPhase === 'ready' && gaugeOcrBusy) ||
                  (gaugeBeforeInitPhase === 'idle' && gaugeOcrBusy)) && (
                  <span className="text-xs text-amber-400/90">
                    {gaugeBeforeInitPhase === 'server' && '서버 확인…'}
                    {gaugeBeforeInitPhase === 'warming' && '모델 로딩…'}
                    {gaugeBeforeInitPhase === 'sampling' && '탐지 전 3프레임 측정…'}
                    {gaugeBeforeInitPhase === 'error' && '기준선 실패'}
                    {gaugeBeforeInitPhase === 'ready' && gaugeOcrBusy && '탐지 후 갱신…'}
                    {gaugeBeforeInitPhase === 'idle' && gaugeOcrBusy && '갱신 중…'}
                  </span>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-6">
                <div className="space-y-2 min-w-0">
                  <p className="text-xs font-medium text-gray-400">탐지 전 숫자</p>
                  <p className="text-[11px] text-gray-600 leading-snug">
                    공유 직후 서버·모델 준비가 끝나면 <span className="text-gray-500">gauge</span>를{' '}
                    <span className="text-gray-400">{GAUGE_BEFORE_BASELINE_FRAME_COUNT}프레임</span> 연속 캡처해 기준값을 잡습니다.
                    3프레임 모두에서 gauge가 없으면 잠시 뒤 다시 시도합니다.
                  </p>
                  {gaugeBefore.remaining != null || gaugeBefore.total != null ? (
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-cyan-100">
                      <span className="text-xs text-gray-500">남은</span>
                      <span className="text-xl font-semibold tabular-nums">{gaugeBefore.remaining ?? '—'}</span>
                      <span className="text-gray-600">/</span>
                      <span className="text-xs text-gray-500">전체</span>
                      <span className="text-xl font-semibold tabular-nums text-cyan-200/90">{gaugeBefore.total ?? '—'}</span>
                    </div>
                  ) : (
                    <span className="text-xl font-semibold tabular-nums text-cyan-100">
                      {gaugeBefore.value != null && gaugeBefore.value !== '' ? gaugeBefore.value : '—'}
                    </span>
                  )}
                  {gaugeBefore.confidence != null &&
                    (gaugeBefore.remaining != null || gaugeBefore.total != null || gaugeBefore.value != null) && (
                      <span className="text-xs text-gray-600 block">
                        신뢰도 {(gaugeBefore.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  {gaugeBefore.rawText && String(gaugeBefore.rawText).trim() !== '' && (
                    <span className="text-xs text-gray-600 block truncate" title={gaugeBefore.rawText}>
                      OCR: {gaugeBefore.rawText}
                    </span>
                  )}
                </div>
                <div className="space-y-2 min-w-0">
                  <p className="text-xs font-medium text-gray-400">탐지 후 숫자</p>
                  <p className="text-[11px] text-gray-600 leading-snug">
                    아이템 프레임이 탐지되면 <span className="text-gray-500">gauge</span> 영역 OCR로 갱신
                  </p>
                  {gaugeAfter.remaining != null || gaugeAfter.total != null ? (
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-cyan-100">
                      <span className="text-xs text-gray-500">남은</span>
                      <span className="text-xl font-semibold tabular-nums">{gaugeAfter.remaining ?? '—'}</span>
                      <span className="text-gray-600">/</span>
                      <span className="text-xs text-gray-500">전체</span>
                      <span className="text-xl font-semibold tabular-nums text-cyan-200/90">{gaugeAfter.total ?? '—'}</span>
                    </div>
                  ) : (
                    <span className="text-xl font-semibold tabular-nums text-cyan-100">
                      {gaugeAfter.value != null && gaugeAfter.value !== '' ? gaugeAfter.value : '—'}
                    </span>
                  )}
                  {gaugeAfter.confidence != null &&
                    (gaugeAfter.remaining != null || gaugeAfter.total != null || gaugeAfter.value != null) && (
                      <span className="text-xs text-gray-600 block">
                        신뢰도 {(gaugeAfter.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  {gaugeAfter.rawText && String(gaugeAfter.rawText).trim() !== '' && (
                    <span className="text-xs text-gray-600 block truncate" title={gaugeAfter.rawText}>
                      OCR: {gaugeAfter.rawText}
                    </span>
                  )}
                </div>
              </div>
              {gaugeCropPreviewUrl && (
                <div className="flex flex-col gap-1 pt-2 border-t border-cyan-900/40">
                  <span className="text-xs text-gray-500">마지막 탐지 후 크롭 (gauge)</span>
                  <img
                    src={gaugeCropPreviewUrl}
                    alt="탐지 후 게이지 크롭"
                    className="max-h-40 max-w-[min(100%,280px)] rounded border border-cyan-700/50 bg-black/50 object-contain"
                  />
                </div>
              )}
            </div>
            <p className="text-xs text-gray-600 mt-1.5">
              탐지 전 숫자는 위 절차(3프레임)로만 설정합니다. 오른쪽 미리보기는 rAF로만 그려 끊김을 줄이고, ONNX 탐지는 별도 타이머(~{LIVE_DETECT_MIN_INTERVAL_MS}ms)로만 돌립니다. 탐지 후 숫자는 아이템이 잡힐 때{' '}
              <span className="text-gray-500">gauge</span> OCR({GAUGE_OCR_THROTTLE_MS}ms 스로틀).
            </p>
          </div>
        )}

        {/* 종합 OCR 테스트 (화면 공유 중일 때만) */}
        {status === 'sharing' && (
          <div className="mt-8 p-4 rounded-lg bg-gray-800 border border-gray-700">
            <h2 className="text-lg font-medium text-gray-200 mb-2">종합 OCR 테스트</h2>
            <p className="text-sm text-gray-500 mb-3">
              자동: <span className="text-gray-300">action_gauge</span>가 잡히면 바로{' '}
              <span className="text-gray-400">{ACTION_GAUGE_COLLECT_MS / 1000}초</span> 동안 프레임을 모아 종합 OCR합니다 (스캔 종류·아이템·행동·게이지 등은 서버가 프레임으로 추론).
              수동 버튼은 현재 화면 탐지 결과로 행동 힌트를 넘깁니다.
            </p>
            <button
              type="button"
              disabled={trackOcrStatus === 'loading'}
              onClick={() => runTrackAndOcr(5)}
              className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              {trackOcrStatus === 'loading' ? '프레임 수집·OCR…' : '종합 OCR 실행'}
            </button>

            {trackOcrStatus === 'done' && trackOcrResult?.items?.length > 0 && (
              <div className="mt-4">
                <p className="text-sm text-violet-300 mb-2">
                  스캔 OCR: {trackOcrResult.scan_result ?? '미추론'} / 행동 OCR: {trackOcrResult.action_type ?? '미추론'} / 게이지 OCR: {trackOcrResult.gauge_consumed != null ? trackOcrResult.gauge_consumed : '미추론'}
                </p>
                <p className="text-sm text-gray-400 mb-2">
                  개수 OCR: track {trackOcrResult.tracked_count}개
                </p>
                <ul className="space-y-2 max-h-64 overflow-y-auto">
                  {trackOcrResult.items.map((item, idx) => (
                    <li
                      key={item.track_id ?? idx}
                      className="p-3 rounded bg-gray-700/50 text-sm"
                    >
                      <span className="font-medium text-blue-300">#{item.track_id}</span>
                      {' '}
                      <span className="text-gray-500">({(item.confidence * 100).toFixed(0)}%)</span>
                      <div className="mt-1 text-green-400">
                        아이템 OCR: <span className="text-gray-200">{item.label === 'common_item' ? '일반' : item.label === 'uncommon_item' ? '고급' : item.label === 'rare_item' ? '희귀' : item.label}</span>
                      </div>
                      {item.ocr_text != null && item.ocr_text !== '' ? (
                        <div className="mt-0.5 text-green-400">
                          개수 OCR: <span className="text-gray-200">{item.ocr_text}</span>
                          {item.ocr_confidence != null && (
                            <span className="text-gray-500 ml-1">({(item.ocr_confidence * 100).toFixed(0)}%)</span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-gray-500">개수 OCR: -</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {trackOcrStatus === 'done' && trackOcrResult?.items?.length === 0 && (
              <div className="mt-4">
                <p className="text-sm text-violet-300 mb-2">
                  스캔 OCR: {trackOcrResult.scan_result ?? '미추론'} / 행동 OCR: {trackOcrResult.action_type ?? '미추론'} / 게이지 OCR: {trackOcrResult.gauge_consumed != null ? trackOcrResult.gauge_consumed : '미추론'}
                </p>
                <p className="text-sm text-gray-500">탐지된 객체가 없습니다.</p>
              </div>
            )}
            {trackOcrStatus === 'error' && trackOcrResult?.error && (
              <p className="mt-4 text-sm text-red-400">{trackOcrResult.error}</p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default TestPage

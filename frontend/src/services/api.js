import { detectWithBestOnnx } from '../detection/best-onnx-detect.js'
import { scanResultAndConfidenceFromDetections } from '../detection/scan-from-detections.js'
import { loadBestOnnxSession } from '../../onnx-loader.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

function withDetectTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs)
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(message || `탐지 타임아웃(${ms}ms)`)), ms)
    promise.then(
      (v) => {
        window.clearTimeout(t)
        resolve(v)
      },
      (e) => {
        window.clearTimeout(t)
        reject(e)
      }
    )
  })
}

/**
 * 이미지 파일을 서버에 업로드하고 OCR 분석 결과를 받아옴
 */
export async function uploadImage(file) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    throw new Error(`서버 오류: ${response.status}`)
  }

  return response.json()
}

/**
 * 화면 공유로 캡처한 이미지 파일을 서버로 보내고 OCR/탐지 결과를 받아옴
 * @param {File} file - getDisplayMedia 등으로 캡처한 이미지 파일
 */
export async function captureScreen(file) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_BASE}/capture`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    throw new Error(`캡처 실패: ${response.status}`)
  }

  return response.json()
}

/**
 * YOLO `gauge` 박스 크롭 PNG — 게이지 숫자 전용 전처리 후 OCR
 * @param {File} file
 * @returns {Promise<{ ocr_text: string, ocr_number: string|null, ocr_confidence: number, gauge_remaining: string|null, gauge_total: string|null }>}
 *   `남은량/전체` 형식: gauge_remaining=슬래시 앞, gauge_total=뒤
 */
export async function ocrGaugeImage(file) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_BASE}/detect/gauge-ocr`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || `게이지 OCR 실패: ${response.status}`)
  }

  return response.json()
}

/**
 * 수집된 데이터 목록 조회
 */
export async function getCollectedData(page = 1, limit = 20) {
  const response = await fetch(`${API_BASE}/data?page=${page}&limit=${limit}`)

  if (!response.ok) {
    throw new Error(`데이터 조회 실패: ${response.status}`)
  }

  return response.json()
}

/**
 * 브라우저 ONNX(best.onnx)로 객체 탐지 (저장 없음, 서버 /detect 미사용)
 * @param {File|Blob} file
 * @param {{ timeoutMs?: number, confFallback?: number }} [options]
 * @returns {Promise<{ detections: Array, scan_result: string|null, scan_confidence: number|null }>}
 */
export async function detectImage(file, options = {}) {
  const timeoutMs = Number(options?.timeoutMs ?? 2000)
  const confFallback = Number(options?.confFallback ?? 0.5)
  const detections = await withDetectTimeout(
    detectWithBestOnnx(file, { confFallback }),
    timeoutMs,
    `탐지 타임아웃(${timeoutMs}ms)`
  )
  const { scan_result, scan_confidence } = scanResultAndConfidenceFromDetections(detections)
  return {
    detections,
    scan_result,
    scan_confidence,
  }
}

/**
 * 숫자 OCR 테스트용 단일 이미지 업로드
 * @param {File} file
 */
export async function testNumberOcr(file) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_BASE}/detect/number-ocr`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || `숫자 OCR 테스트 실패: ${response.status}`)
  }

  return response.json()
}

/**
 * 여러 프레임을 보내 track-ocr 백그라운드 작업 등록
 * @param {File[]} files - 이미지 파일 배열 (최소 2개)
 * @param {{
 *   actionHint?: string,
 *   scanHint?: string|null,
 *   hasDoublePotionHint?: boolean|null,
 *   frontendOnnxOutputs?: Array<{ meta: object, pred_dims: number[], pred_data_b64: string }>,
 *   frontendDetections?: unknown[][],
 *   onnxConfFallback?: string|number,
 * }} options
 */
export async function startTrackAndOcr(files, options = {}) {
  const formData = new FormData()
  files.forEach((file) => formData.append('files', file))
  if (options.actionHint) {
    formData.append('action_hint', options.actionHint)
  }
  if (options.scanHint) {
    formData.append('scan_hint', options.scanHint)
  }
  if (typeof options.hasDoublePotionHint === 'boolean') {
    formData.append('has_double_potion_hint', options.hasDoublePotionHint ? '1' : '0')
  }
  if (Array.isArray(options.frontendOnnxOutputs)) {
    formData.append('frontend_onnx_outputs_json', JSON.stringify(options.frontendOnnxOutputs))
  }
  if (Array.isArray(options.frontendDetections)) {
    formData.append('frontend_detections_json', JSON.stringify(options.frontendDetections))
  }
  if (options.onnxConfFallback != null && options.onnxConfFallback !== '') {
    formData.append('onnx_conf_fallback', String(options.onnxConfFallback))
  }

  const response = await fetch(`${API_BASE}/capture/track-and-ocr`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || `트래킹+OCR 실패: ${response.status}`)
  }

  return response.json()
}

/** track-ocr 작업 상태 조회 */
export async function getTrackAndOcrJob(jobId) {
  const response = await fetch(`${API_BASE}/capture/track-and-ocr/jobs/${jobId}`)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || `작업 조회 실패: ${response.status}`)
  }
  return response.json()
}

/**
 * 트래킹+OCR 작업을 등록하고 완료될 때까지 폴링 대기
 * @param {File[]} files
 * @param {{ pollIntervalMs?: number, timeoutMs?: number }} options
 */
export async function trackAndOcr(files, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 700
  const timeoutMs = options.timeoutMs ?? 120000
  const actionHint = options.actionHint
  const scanHint = options.scanHint
  const hasDoublePotionHint = options.hasDoublePotionHint
  const frontendDetections = options.frontendDetections
  const frontendOnnxOutputs = options.frontendOnnxOutputs
  const onnxConfFallback = options.onnxConfFallback
  const startedAt = Date.now()

  const queued = await startTrackAndOcr(files, {
    actionHint,
    scanHint,
    hasDoublePotionHint,
    frontendDetections,
    frontendOnnxOutputs,
    onnxConfFallback,
  })
  const jobId = queued?.job_id
  if (!jobId) {
    throw new Error('작업 등록 실패: job_id가 없습니다.')
  }

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('트래킹+OCR 작업 타임아웃')
    }
    const job = await getTrackAndOcrJob(jobId)
    if (job.status === 'done') {
      return job.result
    }
    if (job.status === 'failed') {
      throw new Error(job.error || '트래킹+OCR 백그라운드 작업 실패')
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

/**
 * 저장된 종합 OCR 실행 목록
 */
export async function getTrackOcrRuns() {
  const response = await fetch(`${API_BASE}/track-ocr/runs`)
  if (!response.ok) throw new Error('종합 OCR 목록 조회 실패')
  return response.json()
}

/**
 * 종합 OCR 한 실행 상세 (items 포함)
 */
export async function getTrackOcrRun(runId) {
  const response = await fetch(`${API_BASE}/track-ocr/runs/${runId}`)
  if (!response.ok) throw new Error('종합 OCR 상세 조회 실패')
  return response.json()
}

/**
 * 해당 item을 완벽한 OCR으로 검증 처리
 */
export async function verifyTrackOcrItem(runId, itemIndex, verified = true) {
  const response = await fetch(
    `${API_BASE}/track-ocr/runs/${runId}/items/${itemIndex}?verified=${verified}`,
    { method: 'PATCH' }
  )
  if (!response.ok) throw new Error('검증 처리 실패')
  return response.json()
}

/** 해당 item 삭제 */
export async function deleteTrackOcrItem(runId, itemIndex) {
  const response = await fetch(
    `${API_BASE}/track-ocr/runs/${runId}/items/${itemIndex}`,
    { method: 'DELETE' }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '항목 삭제 실패')
  }
  return response.json()
}

/** 해당 item의 개수 OCR 텍스트 수동 수정 */
export async function updateTrackOcrItemOcrText(runId, itemIndex, ocrText) {
  const response = await fetch(
    `${API_BASE}/track-ocr/runs/${runId}/items/${itemIndex}/ocr-text`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ocr_text: ocrText }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || 'OCR 수정 실패')
  }
  return response.json()
}

/**
 * 서버 상태 확인 (health check)
 */
export async function checkHealth() {
  const response = await fetch(`${API_BASE}/health`)
  if (!response.ok) {
    throw new Error(`서버 오류: ${response.status}`)
  }
  return response.json()
}

/**
 * 브라우저 ONNX 세션 프리로드 (첫 탐지 전). 화면 공유 직후 게이지 기준선 등에서 호출.
 */
export async function warmupDetectModel() {
  await loadBestOnnxSession()
  return { ok: true, model_ready: true, frontend_model_mode: true }
}

/** 디스코드 OAuth 로그인 시작 URL */
export function getDiscordLoginUrl() {
  return `${API_BASE}/auth/discord/login`
}

/**
 * 로그인 사용자·선택 생활 스펙 프리셋(Run.tool_spec_id) 기준 대시보드 통계.
 * tool_spec_id 생략 시 설정의 기본 프리셋. 프리셋 미지정이면 빈 통계.
 * 응답: tool_spec_id, tool_spec_name, chest 단일 버킷,
 * common·uncommon은 각각 gauge_180 / gauge_360 (Run.gauge) 하위 버킷.
 * 비로그인 시 `null`.
 * @param {number | null | undefined} toolSpecId
 */
export async function getDashboardStats(toolSpecId) {
  const params = new URLSearchParams()
  if (toolSpecId != null && toolSpecId !== '') {
    params.set('tool_spec_id', String(toolSpecId))
  }
  const qs = params.toString()
  const url = `${API_BASE}/auth/dashboard-stats${qs ? `?${qs}` : ''}`
  const response = await fetch(url, {
    credentials: 'include',
  })
  if (response.status === 401) return null
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '대시보드 통계 조회 실패')
  }
  return response.json()
}

/** 현재 로그인 사용자 조회 */
export async function getAuthMe() {
  const response = await fetch(`${API_BASE}/auth/me`, {
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '로그인 정보 조회 실패')
  }
  return response.json()
}

/** 로그아웃 */
export async function logout() {
  const response = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '로그아웃 실패')
  }
  return response.json()
}

/** 내 설정 조회 (현재: tool_spec_id 중심) */
export async function getMySettings() {
  const response = await fetch(`${API_BASE}/auth/settings`, {
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '설정 조회 실패')
  }
  return response.json()
}

/** 내 설정 저장 (현재: tool_spec_id 중심) */
export async function updateMySettings(body) {
  const response = await fetch(`${API_BASE}/auth/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '설정 저장 실패')
  }
  return response.json()
}

/** DB 마스터: 도구 목록 */
export async function getDbTools() {
  const response = await fetch(`${API_BASE}/db/tools`)
  if (!response.ok) throw new Error('도구 목록 조회 실패')
  return response.json()
}

/** 내 생활 스펙 목록 */
export async function getMyToolSpecs() {
  const response = await fetch(`${API_BASE}/auth/my-tool-specs`, {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('내 생활 스펙 목록 조회 실패')
  return response.json()
}

/** 내 생활 스펙 생성 */
export async function createMyToolSpec(body) {
  const response = await fetch(`${API_BASE}/auth/my-tool-specs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '내 생활 스펙 생성 실패')
  }
  return response.json()
}

/** 내 생활 스펙 삭제 */
export async function deleteMyToolSpec(specId) {
  const response = await fetch(`${API_BASE}/auth/my-tool-specs/${specId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '내 생활 스펙 삭제 실패')
  }
  return response.json()
}

/** 관리자 본인 권한 확인 */
export async function getAdminMe() {
  const response = await fetch(`${API_BASE}/admin/me`, {
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '관리자 권한 확인 실패')
  }
  return response.json()
}

/** 관리자 개요 데이터 (카운트만) */
export async function getAdminOverview() {
  const response = await fetch(`${API_BASE}/admin/overview`, {
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '관리자 데이터 조회 실패')
  }
  return response.json()
}

/** 관리자 최근 run 목록 (요약 행, 페이지네이션) */
export async function getAdminRecentRuns(page = 1, limit = 10) {
  const response = await fetch(`${API_BASE}/admin/recent-runs?page=${page}&limit=${limit}`, {
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '최근 run 조회 실패')
  }
  return response.json()
}

/**
 * 관리자 run_items 검증 목록 (run 단위 페이지네이션)
 * @param {number} page
 * @param {number} limit
 * @param {{ action?: string, scan?: string, gauge?: number }} [filters] 행동/스캔/게이지 필터
 */
export async function getAdminRunItems(page = 1, limit = 10, filters = {}) {
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('limit', String(limit))
  if (filters.action) params.set('action', String(filters.action))
  if (filters.scan) params.set('scan', String(filters.scan))
  if (filters.gauge != null && filters.gauge !== '') {
    params.set('gauge', String(filters.gauge))
  }
  const qs = params.toString()
  const response = await fetch(`${API_BASE}/admin/run-items?${qs}`, {
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '관리자 run_items 조회 실패')
  }
  return response.json()
}

/** 관리자 run_item 수정 (ocr_text만) */
export async function patchAdminRunItem(runItemId, body) {
  const response = await fetch(`${API_BASE}/admin/run-items/${runItemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || 'run_item 수정 실패')
  }
  return response.json()
}

/** 관리자 run_item 삭제 */
export async function deleteAdminRunItem(runItemId) {
  const response = await fetch(`${API_BASE}/admin/run-items/${runItemId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '관리자 run_item 삭제 실패')
  }
  return response.json()
}

/** 관리자 run 삭제(하위 item 포함) */
export async function deleteAdminRun(runId) {
  const response = await fetch(`${API_BASE}/admin/runs/${runId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '관리자 run 삭제 실패')
  }
  return response.json()
}

/** 특정 도구의 생활 스펙 프리셋 목록 */
export async function getToolSpecs(toolId) {
  const response = await fetch(`${API_BASE}/db/tools/${toolId}/specs`)
  if (!response.ok) throw new Error('도구 스펙 목록 조회 실패')
  return response.json()
}

/** 특정 도구에 생활 스펙 프리셋 생성 */
export async function createToolSpec(toolId, body) {
  const response = await fetch(`${API_BASE}/db/tools/${toolId}/specs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '도구 스펙 생성 실패')
  }
  return response.json()
}

/** 생활 스펙 프리셋 삭제 */
export async function deleteToolSpec(specId) {
  const response = await fetch(`${API_BASE}/db/tool-specs/${specId}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || '도구 스펙 삭제 실패')
  }
  return response.json()
}

/** DB 마스터: 스캔 결과 목록 */
export async function getDbScanResults() {
  const response = await fetch(`${API_BASE}/db/scan-results`)
  if (!response.ok) throw new Error('스캔 결과 목록 조회 실패')
  return response.json()
}

/** DB 마스터: 행동 타입 목록 */
export async function getDbActionTypes() {
  const response = await fetch(`${API_BASE}/db/action-types`)
  if (!response.ok) throw new Error('행동 타입 목록 조회 실패')
  return response.json()
}

/**
 * 통과(verified)된 항목만 DB에 저장
 * @param {string} runId
 * @param {{ user_id?: number|null, tool_spec_id: number, scan_result_id?: number|null, action_type_id: number, gauge: number, auto_verify?: boolean }} body
 */
export async function sendRunToDb(runId, body) {
  const response = await fetch(`${API_BASE}/track-ocr/runs/${runId}/send-to-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.detail || `DB 저장 실패: ${response.status}`)
  }
  return response.json()
}

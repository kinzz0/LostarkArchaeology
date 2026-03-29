/** 백엔드 run_inference.scan_result_and_confidence_from_detections 와 동일 규칙 */

const SCAN_LABELS = new Set(['common', 'uncommon'])

/**
 * @param {Array<{ label?: string, confidence?: number }>} detections
 * @returns {{ scan_result: string|null, scan_confidence: number|null }}
 */
export function scanResultAndConfidenceFromDetections(detections) {
  if (!Array.isArray(detections) || detections.length === 0) {
    return { scan_result: null, scan_confidence: null }
  }
  const counts = new Map()
  for (const d of detections) {
    const label = String(d?.label || '').trim()
    if (SCAN_LABELS.has(label)) {
      counts.set(label, (counts.get(label) || 0) + 1)
    }
  }
  if (counts.size === 0) {
    return { scan_result: null, scan_confidence: null }
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
  const scanResult = entries[0][0]
  const confs = []
  for (const d of detections) {
    if (String(d?.label || '').trim() !== scanResult) continue
    const c = Number(d?.confidence)
    if (!Number.isNaN(c)) confs.push(c)
  }
  const scan_confidence = confs.length ? Math.round(Math.max(...confs) * 10000) / 10000 : null
  return { scan_result: scanResult, scan_confidence }
}

/**
 * Ultralytics YOLOv8 / OBB ONNX (BCN: [1, 4+nc+ne, N]) 후처리에 맞춘 브라우저 탐지.
 * ne===1 이면 각 앵커 마지막 채널을 각도(로짓→sigmoid→(x-0.25)*π)로 해석한다.
 */
import * as ort from "onnxruntime-web"
import { loadBestOnnxSession } from "../../onnx-loader.js"
import {
  labelForClassId,
  minConfidenceForLabel,
  DETECTION_CLASS_NAMES,
} from "./detection-classes.js"

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x)
    return 1 / (1 + z)
  }
  const z = Math.exp(x)
  return z / (1 + z)
}

function xywh2xyxy(cx, cy, w, h) {
  const hw = w / 2
  const hh = h / 2
  return [cx - hw, cy - hh, cx + hw, cy + hh]
}

/** ultralytics.utils.ops.xywhr2xyxyxyxy — 평탄화 [x1,y1, ... y4] */
function xywhrToFlatCorners(cx, cy, w, h, angleRad) {
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const w2 = w / 2
  const h2 = h / 2
  const v1x = w2 * cos
  const v1y = w2 * sin
  const v2x = -h2 * sin
  const v2y = h2 * cos
  const p1x = cx + v1x + v2x
  const p1y = cy + v1y + v2y
  const p2x = cx + v1x - v2x
  const p2y = cy + v1y - v2y
  const p3x = cx - v1x - v2x
  const p3y = cy - v1y - v2y
  const p4x = cx - v1x + v2x
  const p4y = cy - v1y + v2y
  return [p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y]
}

function decodeObbAngle(rawLogit) {
  return (sigmoid(rawLogit) - 0.25) * Math.PI
}

function iouAabb(a, b) {
  const xx1 = Math.max(a[0], b[0])
  const yy1 = Math.max(a[1], b[1])
  const xx2 = Math.min(a[2], b[2])
  const yy2 = Math.min(a[3], b[3])
  const iw = Math.max(0, xx2 - xx1)
  const ih = Math.max(0, yy2 - yy1)
  const inter = iw * ih
  const a1 = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
  const a2 = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const union = a1 + a2 - inter
  return union > 0 ? inter / union : 0
}

function nmsAabbClassAware(boxes, scores, classIds, iouThresh, maxDet, maxWh = 7680) {
  const n = boxes.length
  const order = scores.map((s, i) => i).sort((i, j) => scores[j] - scores[i])
  const picked = []
  const suppressed = new Array(n).fill(false)
  for (const idx of order) {
    if (suppressed[idx]) continue
    picked.push(idx)
    if (picked.length >= maxDet) break
    const bi = boxes[idx]
    const ci = classIds[idx] * maxWh
    for (let j = 0; j < n; j++) {
      if (j === idx || suppressed[j]) continue
      if (classIds[j] !== classIds[idx]) continue
      const bj = [
        boxes[j][0] + classIds[j] * maxWh,
        boxes[j][1] + classIds[j] * maxWh,
        boxes[j][2] + classIds[j] * maxWh,
        boxes[j][3] + classIds[j] * maxWh,
      ]
      const biOff = [bi[0] + ci, bi[1] + ci, bi[2] + ci, bi[3] + ci]
      if (iouAabb(biOff, bj) > iouThresh) suppressed[j] = true
    }
  }
  return picked
}

function aabbFromCorners8(c) {
  const xs = [c[0], c[2], c[4], c[6]]
  const ys = [c[1], c[3], c[5], c[7]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function letterboxToTensor(bitmap, targetW, targetH) {
  const iw = bitmap.width
  const ih = bitmap.height
  const r = Math.min(targetW / iw, targetH / ih)
  const nw = Math.round(iw * r)
  const nh = Math.round(ih * r)
  const dw = (targetW - nw) / 2
  const dh = (targetH - nh) / 2

  const canvas = document.createElement("canvas")
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.fillStyle = "rgb(114, 114, 114)"
  ctx.fillRect(0, 0, targetW, targetH)
  ctx.drawImage(bitmap, 0, 0, iw, ih, dw, dh, nw, nh)

  const { data } = ctx.getImageData(0, 0, targetW, targetH)
  const plane = targetW * targetH
  const buf = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    const j = p * 4
    buf[p] = data[j] / 255
    buf[plane + p] = data[j + 1] / 255
    buf[2 * plane + p] = data[j + 2] / 255
  }
  return {
    tensor: new ort.Tensor("float32", buf, [1, 3, targetH, targetW]),
    meta: { r, dw, dh, origW: iw, origH: ih, inW: targetW, inH: targetH },
  }
}

function unletterboxCorners(flat8, meta) {
  const { r, dw, dh, origW, origH } = meta
  const out = []
  for (let k = 0; k < 8; k += 2) {
    const x = (flat8[k] - dw) / r
    const y = (flat8[k + 1] - dh) / r
    out.push(
      Math.max(0, Math.min(origW, x)),
      Math.max(0, Math.min(origH, y)),
    )
  }
  return out.map((v) => Math.round(v))
}

function tensorGetFloat32(t) {
  const d = t.data
  if (d instanceof Float32Array) return d
  return Float32Array.from(d)
}

function resolveInputSize(session) {
  let h = 640
  let w = 640
  const inputName = session.inputNames[0]
  try {
    const meta = session.inputMetadata?.[inputName]
    const dims = meta?.dimensions
    if (Array.isArray(dims) && dims.length >= 4) {
      const dh = dims[2]
      const dw = dims[3]
      if (typeof dh === "number" && dh > 0) h = dh
      if (typeof dw === "number" && dw > 0) w = dw
    }
  } catch (_) {
    /* ignore */
  }
  return { inputName, h, w }
}

function pickMainOutput(session, outputs) {
  const names = session.outputNames
  let best = null
  let bestScore = -1
  for (const name of names) {
    const t = outputs[name]
    if (!t?.dims || t.dims.length !== 3) continue
    const b = t.dims[0]
    const d1 = t.dims[1]
    const d2 = t.dims[2]
    if (b !== 1) continue
    const c = Math.min(d1, d2)
    const n = Math.max(d1, d2)
    if (c >= 4 && c <= 256 && n >= 64) {
      const score = n * c
      if (score > bestScore) {
        bestScore = score
        best = t
      }
    }
  }
  return best || outputs[names[0]]
}

/**
 * [1, N, 6] end-to-end (xyxy + conf + cls), 좌표는 입력 해상도 기준 픽셀 또는 0~1
 */
function parseEndToEndBCN(tensor, meta, confFallback) {
  const dims = tensor.dims
  const data = tensorGetFloat32(tensor)
  if (dims.length !== 3 || dims[0] !== 1) return []
  let num = 0
  let fields = 0
  /** true: 메모리 순서 [1, N, F] → 오프셋 i*F+f, false: [1, F, N] → f*N+i */
  let rowMajorNFirst = true
  if (dims[2] <= 16 && dims[1] > dims[2]) {
    num = dims[1]
    fields = dims[2]
    rowMajorNFirst = true
  } else if (dims[1] <= 16 && dims[2] > dims[1]) {
    num = dims[2]
    fields = dims[1]
    rowMajorNFirst = false
  } else {
    return []
  }
  if (fields < 6) return []

  const ox = (i, f) => (rowMajorNFirst ? i * fields + f : f * num + i)
  const maybeNorm = (() => {
    let maxV = 0
    for (let i = 0; i < Math.min(num, 50); i++) {
      for (let f = 0; f < Math.min(4, fields); f++) maxV = Math.max(maxV, Math.abs(data[ox(i, f)]))
    }
    return maxV <= 1.5
  })()

  const { inW, inH, origW, origH, r, dw, dh } = meta
  const raw = []
  for (let i = 0; i < num; i++) {
    let x1 = data[ox(i, 0)]
    let y1 = data[ox(i, 1)]
    let x2 = data[ox(i, 2)]
    let y2 = data[ox(i, 3)]
    const conf = data[ox(i, 4)]
    const cls = data[ox(i, 5)]
    if (!(conf > 0)) continue
    if (maybeNorm) {
      x1 *= inW
      y1 *= inH
      x2 *= inW
      y2 *= inH
    }
    const flatLb = [
      x1,
      y1,
      x2,
      y1,
      x2,
      y2,
      x1,
      y2,
    ]
    const bbox = unletterboxCorners(flatLb, { r, dw, dh, origW, origH, inW, inH })
    const classId = Math.round(cls)
    const label = labelForClassId(classId)
    const th = minConfidenceForLabel(label, confFallback)
    if (conf < th) continue
    raw.push({
      label,
      confidence: Math.round(conf * 10000) / 10000,
      bbox,
      class_id: classId,
      obb: true,
    })
  }
  return raw
}

/**
 * Ultralytics BCN raw: [1, C, N], C = 4 + nc + ne
 */
function parseYoloBcnRaw(tensor, meta, confFallback, fixedNc) {
  const dims = tensor.dims
  if (dims.length !== 3 || dims[0] !== 1) return []
  const d1 = dims[1]
  const d2 = dims[2]
  const channelMajor = d1 <= d2
  const C = channelMajor ? d1 : d2
  const N = channelMajor ? d2 : d1
  const at = (ch, i) => (channelMajor ? ch * N + i : i * C + ch)

  const nc = fixedNc ?? DETECTION_CLASS_NAMES.length
  let extra = C - 4 - nc
  if (extra < 0) {
    const altNc = C - 4
    if (altNc < 1) return []
    return parseYoloBcnRaw(tensor, meta, confFallback, altNc)
  }

  const data = tensorGetFloat32(tensor)
  const candidates = []
  for (let i = 0; i < N; i++) {
    let bestScore = 0
    let bestCls = 0
    for (let c = 0; c < nc; c++) {
      const v = sigmoid(data[at(4 + c, i)])
      if (v > bestScore) {
        bestScore = v
        bestCls = c
      }
    }
    const label = labelForClassId(bestCls)
    const th = minConfidenceForLabel(label, confFallback)
    if (bestScore < th) continue

    const cx = data[at(0, i)]
    const cy = data[at(1, i)]
    const bw = data[at(2, i)]
    const bh = data[at(3, i)]

    let flat8
    if (extra >= 1) {
      const angleRaw = data[at(4 + nc, i)]
      const angle = decodeObbAngle(angleRaw)
      flat8 = xywhrToFlatCorners(cx, cy, bw, bh, angle)
    } else {
      const [x1, y1, x2, y2] = xywh2xyxy(cx, cy, bw, bh)
      flat8 = [x1, y1, x2, y1, x2, y2, x1, y2]
    }
    const bbox = unletterboxCorners(flat8, meta)
    const aabbNet = aabbFromCorners8(flat8)

    candidates.push({
      label,
      confidence: Math.round(bestScore * 10000) / 10000,
      bbox,
      class_id: bestCls,
      obb: true,
      _aabb: aabbNet,
      _cls: bestCls,
    })
  }

  const boxes = candidates.map((c) => c._aabb)
  const scores = candidates.map((c) => c.confidence)
  const classIds = candidates.map((c) => c._cls)
  const keep = nmsAabbClassAware(boxes, scores, classIds, 0.45, 300)
  return keep.map((k) => {
    const { _aabb, _cls, ...rest } = candidates[k]
    return rest
  })
}

/**
 * @param {File|Blob} file
 * @param {{ confFallback?: number }} [opts]
 * @returns {Promise<Array<{ label: string, confidence: number, bbox: number[], class_id: number, obb: boolean }>>}
 */
export async function detectWithBestOnnx(file, opts = {}) {
  const confFallback = Number(opts.confFallback ?? 0.5)
  const session = await loadBestOnnxSession()
  const { inputName, h: inH, w: inW } = resolveInputSize(session)

  const bitmap = await createImageBitmap(file)
  const { tensor, meta } = letterboxToTensor(bitmap, inW, inH)
  bitmap.close?.()

  const feeds = { [inputName]: tensor }
  const outputs = await session.run(feeds)
  const pred = pickMainOutput(session, outputs)
  if (!pred?.dims) return []

  const d = pred.dims
  if (d.length === 3 && d[0] === 1) {
    const a = d[1]
    const b = d[2]
    const fields = Math.min(a, b)
    const num = Math.max(a, b)
    if (fields >= 6 && fields <= 12 && num <= 500) {
      const e2e = parseEndToEndBCN(pred, meta, confFallback)
      if (e2e.length) return e2e
    }
  }

  return parseYoloBcnRaw(pred, meta, confFallback, undefined)
}

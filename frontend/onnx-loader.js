import * as ort from "onnxruntime-web"
import { runtimeConfig } from "./runtime-config.js"

/**
 * WASM은 Vite 플러그인(copy-ort-wasm-to-public)이 node_modules/onnxruntime-web/dist 에서
 * public/ort-wasm/ 로 복사 — 번들된 ort JS와 항상 같은 패키지 버전.
 */
if (typeof window !== "undefined") {
  const base = import.meta.env.BASE_URL ?? "/"
  const prefix = base.endsWith("/") ? base : `${base}/`
  ort.env.wasm.wasmPaths = `${window.location.origin}${prefix}ort-wasm/`
}

let cachedSession = null
let preloadInjected = false

function absoluteOnnxModelHref() {
  const path = runtimeConfig.onnxBestUrl
  if (/^https?:\/\//i.test(path)) return path
  const base = import.meta.env.BASE_URL ?? "/"
  const root = typeof window !== "undefined" ? window.location.origin : ""
  const b = base.endsWith("/") ? base : `${base}/`
  const p = path.startsWith("/") ? path.slice(1) : path
  return `${root}${b}${p}`
}

/** 네트워크에서 .onnx 다운로드를 세션 생성보다 앞당김 */
function injectOnnxPreload() {
  if (typeof document === "undefined" || preloadInjected) return
  preloadInjected = true
  const href = absoluteOnnxModelHref()
  const id = "preload-onnx-best"
  if (document.getElementById(id)) return
  const link = document.createElement("link")
  link.id = id
  link.rel = "preload"
  link.as = "fetch"
  link.href = href
  link.crossOrigin = "anonymous"
  document.head.appendChild(link)
}

if (typeof window !== "undefined") {
  queueMicrotask(() => {
    try {
      injectOnnxPreload()
    } catch {
      /* ignore */
    }
  })
}

function graphOptimizationLevel() {
  const v = (import.meta.env.VITE_ONNX_GRAPH_OPT || "extended").toLowerCase()
  const allowed = new Set(["disabled", "basic", "extended", "layout", "all"])
  return allowed.has(v) ? v : "extended"
}

async function createSession(modelUrl, executionProviders) {
  const opt = graphOptimizationLevel()
  return ort.InferenceSession.create(modelUrl, {
    executionProviders,
    graphOptimizationLevel: opt,
  })
}

export async function loadBestOnnxSession() {
  if (cachedSession) return cachedSession
  injectOnnxPreload()
  const modelUrl = runtimeConfig.onnxBestUrl
  const wantWebGpu =
    typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined"
  try {
    if (wantWebGpu) {
      try {
        cachedSession = await createSession(modelUrl, ["webgpu", "wasm"])
      } catch (e) {
        console.warn("[onnx] WebGPU 세션 실패, WASM만 재시도:", e)
        cachedSession = await createSession(modelUrl, ["wasm"])
      }
    } else {
      cachedSession = await createSession(modelUrl, ["wasm"])
    }
    return cachedSession
  } catch (err) {
    throw new Error(`best.onnx 로드 실패: ${String(err)}`)
  }
}


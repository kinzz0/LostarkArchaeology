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

export async function loadBestOnnxSession() {
  if (cachedSession) return cachedSession
  try {
    cachedSession = await ort.InferenceSession.create(runtimeConfig.onnxBestUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    })
    return cachedSession
  } catch (err) {
    throw new Error(`best.onnx 로드 실패: ${String(err)}`)
  }
}


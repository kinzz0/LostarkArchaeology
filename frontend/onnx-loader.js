import * as ort from "onnxruntime-web"
import { runtimeConfig } from "./runtime-config.js"

/** Vite dev에서 로컬 node_modules WASM 해석이 어긋날 때 CDN으로 폴백 */
const ORT_WASM_VER = "1.20.1"
if (typeof window !== "undefined") {
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WASM_VER}/dist/`
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


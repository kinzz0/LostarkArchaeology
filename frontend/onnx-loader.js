import * as ort from "onnxruntime-web"
import { runtimeConfig } from "./runtime-config.js"

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


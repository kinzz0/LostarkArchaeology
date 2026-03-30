import { detectWithBestOnnx } from "./best-onnx-detect.js"

/** 앱 로드 시 한 번 호출 → `TestPage` 등 `window.__bestOnnxDetect`(전체 탐지)용 */
export function installBestOnnxDetectBridge() {
  if (typeof window === "undefined") return
  window.__bestOnnxDetect = (file) => detectWithBestOnnx(file)
}

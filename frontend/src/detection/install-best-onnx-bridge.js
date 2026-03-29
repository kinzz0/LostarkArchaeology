import { detectWithBestOnnx } from "./best-onnx-detect.js"

/** 앱 로드 시 한 번 호출 → `OfficialCollectPage` / `TestPage`의 `inferDetectionsForFile`가 사용 */
export function installBestOnnxDetectBridge() {
  if (typeof window === "undefined") return
  window.__bestOnnxDetect = (file) => detectWithBestOnnx(file)
}

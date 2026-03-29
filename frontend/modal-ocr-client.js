import { runtimeConfig } from "./runtime-config.js"

export async function callModalEasyOcrFromBrowser(file) {
  if (!runtimeConfig.modalEasyocrUrl) {
    throw new Error("VITE_MODAL_EASYOCR_URL이 비어 있습니다.")
  }

  const buf = await file.arrayBuffer()
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))

  const res = await fetch(runtimeConfig.modalEasyocrUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: b64 }),
  })

  if (!res.ok) {
    const msg = await res.text()
    throw new Error(`Modal OCR 실패(${res.status}): ${msg}`)
  }
  return res.json()
}


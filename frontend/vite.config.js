import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * onnxruntime-web JS 번들과 동일 패키지의 WASM을 public/ort-wasm 에 복사.
 * CDN WASM과 버전이 어긋나 TypeError: t.getValue is not a function 나는 것을 막음.
 */
function copyOrtWasmToPublic() {
  return {
    name: 'copy-ort-wasm-to-public',
    buildStart() {
      const srcDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist')
      const destDir = path.resolve(__dirname, 'public/ort-wasm')
      if (!fs.existsSync(srcDir)) {
        console.warn('[copy-ort-wasm] node_modules/onnxruntime-web/dist 없음 — npm install 후 다시 시도')
        return
      }
      fs.mkdirSync(destDir, { recursive: true })
      const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.wasm'))
      for (const f of files) {
        fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f))
      }
      if (files.length) {
        console.log(`[copy-ort-wasm] ${files.length}개 wasm → public/ort-wasm/`)
      } else {
        console.warn('[copy-ort-wasm] dist 안에 .wasm 이 없습니다. onnxruntime-web 버전을 확인하세요.')
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), copyOrtWasmToPublic()],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'], // 확장자 자동 인식 설정,
  },
  server: {
      host: '0.0.0.0',      // Cloudtype 외부 접속 허용을 위해 필수
      port: 8000,           // Cloudtype 설정의 '포트' 번호와 일치시켜야 함
      strictPort: true      // 포트가 다르면 에러를 내서 혼선을 방지
  },
})

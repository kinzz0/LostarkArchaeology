import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'], // 확장자 자동 인식 설정,
  },
  server: {
      host: '0.0.0.0',      // Cloudtype 외부 접속 허용을 위해 필수
      port: 8000,           // Cloudtype 설정의 '포트' 번호와 일치시켜야 함
      strictPort: true      // 포트가 다르면 에러를 내서 혼선을 방지
  },
})

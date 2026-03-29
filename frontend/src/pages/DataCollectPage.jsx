import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ImageUploader from '../components/ImageUploader'
import DataViewer from '../components/DataViewer'
import StatusBar from '../components/StatusBar'
import ScreenCapture from '../components/ScreenCapture'
import { getAuthMe, getDiscordLoginUrl, logout } from '../services/api'

/** 기존 홈: 화면 캡처·업로더·데이터 뷰어 (경로 `/data-collect`) */
function DataCollectPage() {
  const [capturedImages, setCapturedImages] = useState([])
  const [ocrResults, setOcrResults] = useState([])
  const [status, setStatus] = useState({ message: '대기 중', type: 'idle' })
  const [authUser, setAuthUser] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  const handleImageCaptured = (imageData) => {
    setCapturedImages((prev) => [imageData, ...prev])
    setStatus({ message: '이미지 캡처 완료', type: 'success' })
  }

  const handleOcrResult = (result) => {
    setOcrResults((prev) => [result, ...prev])
    setStatus({ message: 'OCR 분석 완료', type: 'success' })
  }

  const handleStatusChange = (newStatus) => {
    setStatus(newStatus)
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const me = await getAuthMe()
        if (mounted) setAuthUser(me)
      } catch {
        if (mounted) setAuthUser(null)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const handleLogout = async () => {
    try {
      await logout()
      setAuthUser(null)
      setMenuOpen(false)
    } catch (e) {
      setStatus({ message: e.message || '로그아웃 실패', type: 'error' })
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-2xl font-bold text-blue-400 hover:text-blue-300">
              AI 데이터 수집기
            </Link>
            <nav className="flex gap-3 text-sm">
              <Link to="/" className="text-gray-400 hover:text-gray-200">대시보드</Link>
              <Link to="/data-collect" className="text-blue-400 font-medium">데이터 수집</Link>
              <Link to="/collect" className="text-emerald-400 hover:text-emerald-300">정식 수집</Link>
              <Link to="/test" className="text-gray-400 hover:text-gray-200">테스트</Link>
              <Link to="/number-ocr-test" className="text-gray-400 hover:text-gray-200">숫자 OCR 테스트</Link>
            </nav>
          </div>
          {!authUser ? (
            <a
              href={getDiscordLoginUrl()}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 hover:bg-indigo-500 transition"
              aria-label="디스코드 로그인"
              title="디스코드 로그인"
            >
              <img
                src="https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/discord.svg"
                alt="Discord"
                className="h-5 w-5 invert"
              />
            </a>
          ) : (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 hover:bg-indigo-500 transition overflow-hidden"
                aria-label="계정 메뉴"
                title={authUser.global_name || authUser.username || '계정'}
              >
                {authUser.avatar_url ? (
                  <img src={authUser.avatar_url} alt="avatar" className="h-10 w-10 object-cover" />
                ) : (
                  <img
                    src="https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/discord.svg"
                    alt="Discord"
                    className="h-5 w-5 invert"
                  />
                )}
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-36 rounded-md border border-gray-700 bg-gray-800 shadow-lg z-50">
                  <Link
                    to="/admin"
                    className="block px-3 py-2 text-sm text-amber-300 hover:bg-gray-700"
                    onClick={() => setMenuOpen(false)}
                  >
                    관리자
                  </Link>
                  <Link
                    to="/settings"
                    className="block px-3 py-2 text-sm text-gray-200 hover:bg-gray-700"
                    onClick={() => setMenuOpen(false)}
                  >
                    설정
                  </Link>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-gray-700"
                  >
                    로그아웃
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <StatusBar status={status} />

      <main className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-6">
            <ScreenCapture
              onCapture={handleImageCaptured}
              onStatusChange={handleStatusChange}
            />
            <ImageUploader
              onUpload={handleImageCaptured}
              onOcrResult={handleOcrResult}
              onStatusChange={handleStatusChange}
            />
          </div>
          <div>
            <DataViewer
              images={capturedImages}
              ocrResults={ocrResults}
            />
          </div>
        </div>
      </main>
    </div>
  )
}

export default DataCollectPage

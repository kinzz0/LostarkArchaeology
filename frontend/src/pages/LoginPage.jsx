import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getAuthMe, getDiscordLoginUrl, logout } from '../services/api'

const DISCORD_LOGO_URL =
  'https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/discord.svg'

function LoginPage() {
  const [searchParams] = useSearchParams()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const status = searchParams.get('status')
  const reason = searchParams.get('reason')

  const statusText = useMemo(() => {
    if (status === 'success') return '디스코드 로그인 성공'
    if (status === 'error') return `로그인 실패: ${reason || 'unknown'}`
    return ''
  }, [reason, status])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const me = await getAuthMe()
        if (mounted) {
          setUser(me)
          setError('')
        }
      } catch {
        if (mounted) setUser(null)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  const handleLogin = () => {
    window.location.href = getDiscordLoginUrl()
  }

  const handleLogout = async () => {
    try {
      await logout()
      setUser(null)
      setError('')
    } catch (e) {
      setError(e.message || '로그아웃 실패')
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-indigo-400">디스코드 로그인</h1>
          <Link to="/" className="text-sm text-gray-300 hover:text-white">
            대시보드
          </Link>
        </div>
      </header>
      <main className="max-w-3xl mx-auto p-6">
        <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
          <p className="text-sm text-gray-400 mb-4">Discord OAuth로 로그인합니다.</p>
          {statusText && <p className="text-sm mb-4 text-cyan-300">{statusText}</p>}
          {error && <p className="text-sm mb-4 text-red-400">{error}</p>}
          {loading ? (
            <p className="text-sm text-gray-400">로그인 상태 확인 중...</p>
          ) : user ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {user.avatar_url ? (
                  <img src={user.avatar_url} alt="avatar" className="w-12 h-12 rounded-full border border-gray-600" />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-gray-700" />
                )}
                <div>
                  <p className="font-semibold">{user.global_name || user.username}</p>
                  <p className="text-sm text-gray-400">@{user.username}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-sm"
              >
                로그아웃
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleLogin}
              className="inline-flex items-center gap-3 px-4 py-3 rounded-md bg-indigo-600 hover:bg-indigo-500 transition text-white"
            >
              <img src={DISCORD_LOGO_URL} alt="discord logo" className="w-5 h-5 invert" />
              <span className="font-medium">Discord로 로그인</span>
            </button>
          )}
        </div>
      </main>
    </div>
  )
}

export default LoginPage

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createMyToolSpec,
  deleteMyToolSpec,
  getAuthMe,
  getMySettings,
  getMyToolSpecs,
  updateMySettings,
} from '../services/api'

function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [user, setUser] = useState(null)
  const [specs, setSpecs] = useState([])
  const [selectedSpecId, setSelectedSpecId] = useState('')
  const [newSpecName, setNewSpecName] = useState('')
  const [newSpecValues, setNewSpecValues] = useState({
    common_reward_bonus: '',
    uncommon_reward_bonus: '',
    rare_reward_bonus: '',
    minigame_reward_bonus: '',
    minigame_chance_bonus: '',
    chest_spawn_bonus: '',
  })

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        setLoading(true)
        setError('')
        const [me, mySpecs, settings] = await Promise.all([getAuthMe(), getMyToolSpecs(), getMySettings()])
        if (!mounted) return
        setUser(me)
        setSpecs(Array.isArray(mySpecs?.tool_specs) ? mySpecs.tool_specs : [])
        if (settings?.tool_spec_id != null) {
          setSelectedSpecId(String(settings.tool_spec_id))
        } else {
          setSelectedSpecId('')
        }
      } catch (e) {
        if (!mounted) return
        setError(e.message || '설정 로드 실패')
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  const selectedSpecName = useMemo(() => {
    const id = Number(selectedSpecId)
    if (!id) return '미선택'
    const s = specs.find((x) => Number(x.id) === id)
    if (!s) return `ID ${id}`
    return s.name
  }, [selectedSpecId, specs])

  const reloadMySpecs = async () => {
    const mySpecs = await getMyToolSpecs()
    setSpecs(Array.isArray(mySpecs?.tool_specs) ? mySpecs.tool_specs : [])
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      setError('')
      setNotice('')
      await updateMySettings({
        tool_spec_id: selectedSpecId ? Number(selectedSpecId) : null,
      })
      setNotice('저장되었습니다.')
    } catch (e) {
      setError(e.message || '설정 저장 실패')
    } finally {
      setSaving(false)
    }
  }

  const handleCreateSpec = async () => {
    const name = (newSpecName || '').trim()
    if (!name) {
      setError('생활 스펙 이름을 입력하세요.')
      return
    }
    try {
      setError('')
      setNotice('')
      const toNumOrNull = (v) => {
        const s = String(v ?? '').trim()
        if (!s) return null
        const n = Number(s)
        return Number.isFinite(n) ? n : null
      }
      await createMyToolSpec({
        name,
        common_reward_bonus: toNumOrNull(newSpecValues.common_reward_bonus),
        uncommon_reward_bonus: toNumOrNull(newSpecValues.uncommon_reward_bonus),
        rare_reward_bonus: toNumOrNull(newSpecValues.rare_reward_bonus),
        minigame_reward_bonus: toNumOrNull(newSpecValues.minigame_reward_bonus),
        minigame_chance_bonus: toNumOrNull(newSpecValues.minigame_chance_bonus),
        chest_spawn_bonus: toNumOrNull(newSpecValues.chest_spawn_bonus),
      })
      setNewSpecName('')
      setNewSpecValues({
        common_reward_bonus: '',
        uncommon_reward_bonus: '',
        rare_reward_bonus: '',
        minigame_reward_bonus: '',
        minigame_chance_bonus: '',
        chest_spawn_bonus: '',
      })
      await reloadMySpecs()
      setNotice('내 생활 스펙이 추가되었습니다.')
    } catch (e) {
      setError(e.message || '생활 스펙 생성 실패')
    }
  }

  const handleDeleteSelected = async () => {
    if (!selectedSpecId) return
    try {
      setError('')
      setNotice('')
      await deleteMyToolSpec(Number(selectedSpecId))
      setSelectedSpecId('')
      await updateMySettings({ tool_spec_id: null })
      await reloadMySpecs()
      setNotice('선택한 생활 스펙을 삭제했습니다.')
    } catch (e) {
      setError(e.message || '생활 스펙 삭제 실패')
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-indigo-400">설정</h1>
          <Link to="/" className="text-sm text-gray-300 hover:text-white">
            대시보드
          </Link>
        </div>
      </header>
      <main className="max-w-4xl mx-auto p-6">
        {loading ? (
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-5 text-sm text-gray-300">설정 불러오는 중...</div>
        ) : (
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-5 space-y-4">
            {error && <p className="text-sm text-red-400">{error}</p>}
            {notice && <p className="text-sm text-emerald-400">{notice}</p>}

            {!user ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-300">로그인이 필요합니다.</p>
                <a
                  href="/api/auth/discord/login"
                  className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm hover:bg-indigo-500"
                >
                  Discord로 로그인
                </a>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-sm text-gray-400">로그인 계정</p>
                  <p className="text-sm font-medium text-gray-100">
                    {user.global_name || user.username} <span className="text-gray-500">@{user.username}</span>
                  </p>
                </div>

                <div className="space-y-2">
                  <label htmlFor="spec-select" className="block text-sm text-gray-300">
                    내 생활 스펙 선택
                  </label>
                  <select
                    id="spec-select"
                    value={selectedSpecId}
                    onChange={(e) => setSelectedSpecId(e.target.value)}
                    className="w-full max-w-md rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                  >
                    <option value="">선택 안 함</option>
                    {specs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500">현재 선택: {selectedSpecName}</p>
                </div>

                <div className="space-y-2 pt-2 border-t border-gray-700">
                  <label htmlFor="new-spec-name" className="block text-sm text-gray-300">
                    내 생활 스펙 추가
                  </label>
                  <div className="flex gap-2 max-w-md">
                    <input
                      id="new-spec-name"
                      type="text"
                      value={newSpecName}
                      onChange={(e) => setNewSpecName(e.target.value)}
                      placeholder="예: 본캐 전설 삽"
                      className="flex-1 rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                    <button
                      type="button"
                      onClick={handleCreateSpec}
                      className="rounded-md bg-gray-700 px-3 py-2 text-sm hover:bg-gray-600"
                    >
                      추가
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-2xl">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="일반 보상 증가 (%)"
                      value={newSpecValues.common_reward_bonus}
                      onChange={(e) =>
                        setNewSpecValues((prev) => ({ ...prev, common_reward_bonus: e.target.value }))
                      }
                      className="rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="고급 보상 증가 (%)"
                      value={newSpecValues.uncommon_reward_bonus}
                      onChange={(e) =>
                        setNewSpecValues((prev) => ({ ...prev, uncommon_reward_bonus: e.target.value }))
                      }
                      className="rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="희귀 보상 증가 (%)"
                      value={newSpecValues.rare_reward_bonus}
                      onChange={(e) =>
                        setNewSpecValues((prev) => ({ ...prev, rare_reward_bonus: e.target.value }))
                      }
                      className="rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="미니게임 보상 증가 (%)"
                      value={newSpecValues.minigame_reward_bonus}
                      onChange={(e) =>
                        setNewSpecValues((prev) => ({ ...prev, minigame_reward_bonus: e.target.value }))
                      }
                      className="rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="미니게임 기회 증가 (%)"
                      value={newSpecValues.minigame_chance_bonus}
                      onChange={(e) =>
                        setNewSpecValues((prev) => ({ ...prev, minigame_chance_bonus: e.target.value }))
                      }
                      className="rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="보물상자 등장 증가 (%)"
                      value={newSpecValues.chest_spawn_bonus}
                      onChange={(e) =>
                        setNewSpecValues((prev) => ({ ...prev, chest_spawn_bonus: e.target.value }))
                      }
                      className="rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                    />
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="rounded-md bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500 disabled:opacity-60"
                  >
                    {saving ? '저장 중...' : '저장'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteSelected}
                    disabled={!selectedSpecId}
                    className="rounded-md bg-red-700 px-4 py-2 text-sm hover:bg-red-600 disabled:opacity-60"
                  >
                    선택 스펙 삭제
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default SettingsPage

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  getAuthMe,
  getDashboardStats,
  getDiscordLoginUrl,
  getMyToolSpecs,
  logout,
} from '../services/api'

const ITEM_KEYS = ['common_item', 'uncommon_item', 'rare_item']
const ITEM_LABEL_KO = {
  common_item: '일반 아이템',
  uncommon_item: '고급 아이템',
  rare_item: '희귀 아이템',
}
const ITEM_COLORS = {
  common_item: '#22c55e',
  uncommon_item: '#3b82f6',
  rare_item: '#a855f7',
}

/** 상위: 고고학 / 보물상자 / 미니게임 — 일반·미니게임에서 스캔 종류 선택, 도약 구간은 일반 탭만 */
const CATEGORY_TABS = [
  {
    id: 'normal',
    title: '일반',
    desc: '고고학(normal) run만 — 아래에서 일반·고급 스캔과 도약 X/O(게이지 180/360)를 고릅니다.',
  },
  {
    id: 'chest',
    title: '보물상자',
    desc: '행동이 보물상자(chest)인 run — 라벨별 수집 1회(run)당 평균 획득 개수',
  },
  {
    id: 'mini',
    title: '미니게임',
    desc: '미니게임(mini) run만 — 도약 구분 없이 집계. 스캔이 DB에 없으면 일반 스캔 쪽에 포함됩니다.',
  },
]

const SCAN_SUB_TABS = [
  { id: 'common', label: '일반 스캔' },
  { id: 'uncommon', label: '고급 스캔' },
]

function bucketToBarData(bucket) {
  const avg = bucket?.item_label_avg_qty
  const cnt = bucket?.item_label_counts
  const valid = bucket?.item_label_valid_qty_count
  const runCount = Number(bucket?.run_count ?? 0)
  if (!avg || typeof avg !== 'object') return []
  return ITEM_KEYS.map((key) => ({
    key,
    name: ITEM_LABEL_KO[key],
    avgQty: Number(avg[key] ?? 0),
    rowCount: Number(cnt?.[key] ?? 0),
    validQtyRows: Number(valid?.[key] ?? 0),
    runCount,
  }))
}

function DashboardBucketSection({ heading, sub, bucket }) {
  const barData = useMemo(() => bucketToBarData(bucket), [bucket])
  const safe = bucket || {}

  return (
    <div className="space-y-4">
      {(heading || sub) && (
        <div className="border-b border-gray-700 pb-2">
          {heading && <h3 className="text-sm font-semibold text-cyan-200/90">{heading}</h3>}
          {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">해당 조건 run 수</p>
          <p className="text-2xl font-bold text-emerald-400 tabular-nums">{safe.run_count ?? 0}</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">아이템 행 합계</p>
          <p className="text-2xl font-bold text-cyan-400 tabular-nums">{safe.total_item_rows ?? 0}</p>
        </div>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-800 p-4 h-96">
        {(safe.run_count ?? 0) === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500 text-sm">
            이 구간에 해당하는 저장 기록이 없습니다.
          </div>
        ) : barData.every((d) => d.rowCount === 0) ? (
          <div className="flex h-full items-center justify-center text-gray-500 text-sm">
            아이템(common / uncommon / rare) 저장 행이 없습니다.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} margin={{ top: 28, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} />
              <YAxis
                tick={{ fill: '#9ca3af', fontSize: 11 }}
                allowDecimals
                label={{
                  value: 'run당 평균(개)',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#6b7280',
                  fontSize: 11,
                }}
              />
              <Tooltip
                cursor={{ fill: 'rgba(55, 65, 81, 0.35)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const p = payload[0].payload
                  return (
                    <div className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm shadow-lg">
                      <div className="font-medium text-gray-100">{p.name}</div>
                      <div className="text-cyan-300 mt-1">
                        수집 1회당 평균 <strong>{p.avgQty}</strong>개
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        집계 run {p.runCount ?? 0}회 기준 · 숫자 합산 크롭 {p.validQtyRows}건 / 해당 라벨 크롭{' '}
                        {p.rowCount}건
                      </div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="avgQty" name="run당 평균" radius={[6, 6, 0, 0]} maxBarSize={72}>
                {barData.map((entry) => (
                  <Cell key={entry.key} fill={ITEM_COLORS[entry.key] || '#6b7280'} />
                ))}
                <LabelList
                  dataKey="avgQty"
                  position="top"
                  fill="#e5e7eb"
                  fontSize={11}
                  formatter={(v) => {
                    const n = Number(v)
                    if (Number.isNaN(n) || n <= 0) return ''
                    return `run당 ${n}개`
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {(safe.run_count ?? 0) > 0 && barData.some((d) => d.rowCount > 0) && (
        <ul className="text-sm text-gray-400 space-y-1 border-t border-gray-700 pt-4">
          {barData
            .filter((d) => d.rowCount > 0)
            .map((d) => (
              <li key={d.key}>
                <span className="text-gray-200">{d.name}</span>: 수집 1회당 평균{' '}
                <strong className="text-cyan-300 tabular-nums">{d.avgQty}</strong>개
                <span className="text-gray-500">
                  {' '}
                  (숫자 합산 {d.validQtyRows}건 / 라벨 크롭 {d.rowCount}건)
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

function HomePage() {
  const [authUser, setAuthUser] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const [categoryTab, setCategoryTab] = useState('normal')
  /** 일반·미니게임 탭에서만 사용: common = 일반 스캔, uncommon = 고급 스캔 */
  const [scanKind, setScanKind] = useState('common')
  const [stats, setStats] = useState(null)
  const [statsError, setStatsError] = useState('')
  const [loadingStats, setLoadingStats] = useState(false)
  const [toolSpecs, setToolSpecs] = useState([])
  const [selectedToolSpecId, setSelectedToolSpecId] = useState(null)
  /** false = 도약 X (gauge 180), true = 도약 O (gauge 360) */
  const [doublePotionOn, setDoublePotionOn] = useState(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const me = await getAuthMe()
        if (!mounted) return
        setAuthUser(me)
      } catch {
        if (!mounted) return
        setAuthUser(null)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!authUser?.user_id) {
      setToolSpecs([])
      setSelectedToolSpecId(null)
      return
    }
    let mounted = true
    ;(async () => {
      try {
        const res = await getMyToolSpecs()
        if (!mounted) return
        const list = Array.isArray(res?.tool_specs) ? res.tool_specs : []
        setToolSpecs(list)
      } catch {
        if (!mounted) return
        setToolSpecs([])
      }
    })()
    return () => {
      mounted = false
    }
  }, [authUser?.user_id])

  useEffect(() => {
    if (!toolSpecs.length) {
      setSelectedToolSpecId(null)
      return
    }
    setSelectedToolSpecId((prev) => {
      if (prev != null && toolSpecs.some((s) => s.id === prev)) return prev
      const fromSettings = authUser?.tool_spec_id
      if (fromSettings != null && toolSpecs.some((s) => s.id === fromSettings)) return fromSettings
      return toolSpecs[0].id
    })
  }, [toolSpecs, authUser?.tool_spec_id])

  useEffect(() => {
    if (!authUser?.user_id) {
      setStats(null)
      return
    }
    let mounted = true
    setLoadingStats(true)
    setStatsError('')
    ;(async () => {
      try {
        const data = await getDashboardStats(selectedToolSpecId)
        if (!mounted) return
        setStats(data)
      } catch (e) {
        if (!mounted) return
        setStatsError(e.message || '통계를 불러오지 못했습니다.')
        setStats(null)
      } finally {
        if (mounted) setLoadingStats(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [authUser?.user_id, selectedToolSpecId])

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
      setStats(null)
      setMenuOpen(false)
    } catch {
      /* ignore */
    }
  }

  const categoryMeta = CATEGORY_TABS.find((t) => t.id === categoryTab) || CATEGORY_TABS[0]

  const scanBucketForDisplay = useMemo(() => {
    if (!stats || categoryTab === 'chest') return null
    if (categoryTab === 'mini') {
      return scanKind === 'common' ? stats.mini_common ?? null : stats.mini_uncommon ?? null
    }
    const split = scanKind === 'common' ? stats.common : stats.uncommon
    if (!split) return null
    return doublePotionOn ? split.gauge_360 : split.gauge_180
  }, [stats, categoryTab, scanKind, doublePotionOn])

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-2xl font-bold text-cyan-400">
              대시보드
            </Link>
            <nav className="flex flex-wrap gap-3 text-sm">
              <Link to="/data-collect" className="text-gray-400 hover:text-gray-200">
                데이터 수집
              </Link>
              <Link to="/collect" className="text-emerald-400 hover:text-emerald-300">
                정식 수집
              </Link>
              <Link to="/test" className="text-gray-400 hover:text-gray-200">
                테스트
              </Link>
              <Link to="/number-ocr-test" className="text-gray-400 hover:text-gray-200">
                숫자 OCR 테스트
              </Link>
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

      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">수집 요약</h1>
          <p className="text-sm text-gray-400 mt-1">
            <strong className="text-gray-300">생활 스펙 프리셋</strong>에 연결된 run만 집계합니다. 막대는 라벨별{' '}
            <strong className="text-gray-300">수집 1회(run)당 평균 획득 개수</strong>입니다. 개수 합산은 OCR이 순수 숫자로
            읽힌 크롭만 더하고, 분모는 해당 조건의 <strong className="text-gray-300">전체 run 수</strong>입니다. 숫자로
            읽히지 않은 크롭은 합에 포함되지 않습니다. <strong className="text-gray-300">일반</strong> 탭에서만{' '}
            <strong className="text-gray-300">도약 X / 도약 O</strong>(게이지 180·360)로 나눕니다.{' '}
            <strong className="text-gray-300">미니게임</strong>은 도약 효과가 없어 스캔 종류만 구분합니다.
          </p>
          {authUser && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label htmlFor="dash-tool-spec" className="text-xs text-gray-500">
                프리셋
              </label>
              <select
                id="dash-tool-spec"
                value={selectedToolSpecId == null ? '' : String(selectedToolSpecId)}
                onChange={(e) => {
                  const v = e.target.value
                  setSelectedToolSpecId(v === '' ? null : Number(v))
                }}
                disabled={!toolSpecs.length}
                className="rounded-md border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
              >
                {!toolSpecs.length && <option value="">프리셋 없음</option>}
                {toolSpecs.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name || `프리셋 #${s.id}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-b border-gray-700 pb-2">
          {CATEGORY_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setCategoryTab(t.id)}
              className={`rounded-t px-4 py-2 text-sm font-medium transition ${
                categoryTab === t.id
                  ? 'bg-gray-800 text-cyan-300 border border-b-0 border-gray-700'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t.title}
            </button>
          ))}
        </div>

        <p className="text-xs text-gray-500">{categoryMeta.desc}</p>

        {!authUser && (
          <div className="rounded-lg border border-dashed border-gray-600 bg-gray-800/50 p-12 text-center text-gray-500">
            로그인하면 생활 스펙 프리셋별 수집 1회당 평균 획득이 표시됩니다.
          </div>
        )}

        {authUser && !toolSpecs.length && !loadingStats && (
          <p className="text-sm text-amber-400/90">
            등록된 생활 스펙 프리셋이 없습니다. 설정에서 프리셋을 만든 뒤 수집 시 해당 프리셋을 선택해 주세요.
          </p>
        )}

        {authUser && loadingStats && (
          <p className="text-sm text-gray-400">통계 불러오는 중…</p>
        )}

        {authUser && statsError && (
          <p className="text-sm text-red-400">{statsError}</p>
        )}

        {authUser && !loadingStats && !statsError && stats && (
          <div className="space-y-4">
            {categoryTab === 'chest' ? (
              <DashboardBucketSection bucket={stats.chest} />
            ) : (
              <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-gray-500">스캔 종류</span>
                  <div className="inline-flex rounded-lg border border-gray-600 bg-gray-900/80 p-0.5">
                    {SCAN_SUB_TABS.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setScanKind(s.id)}
                        className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                          scanKind === s.id
                            ? 'bg-cyan-700/80 text-white shadow'
                            : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                {categoryTab === 'normal' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-gray-500">도약 구간</span>
                    <div className="inline-flex rounded-lg border border-gray-600 bg-gray-900/80 p-0.5">
                      <button
                        type="button"
                        onClick={() => setDoublePotionOn(false)}
                        className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                          !doublePotionOn
                            ? 'bg-cyan-700/80 text-white shadow'
                            : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        도약 X
                      </button>
                      <button
                        type="button"
                        onClick={() => setDoublePotionOn(true)}
                        className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                          doublePotionOn
                            ? 'bg-cyan-700/80 text-white shadow'
                            : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        도약 O
                      </button>
                    </div>
                    <span className="text-xs text-gray-500">
                      {doublePotionOn ? '게이지 360 · 더블 물약' : '게이지 180 · 단일'}
                    </span>
                  </div>
                )}
                <DashboardBucketSection bucket={scanBucketForDisplay} />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default HomePage

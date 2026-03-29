import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deleteAdminRun,
  getAdminMe,
  getAdminOverview,
  getAdminRecentRuns,
  getAdminRunItems,
  patchAdminRunItem,
} from '../services/api'

function buildVerifyQueryOpts(f) {
  const o = {}
  if (f.action) o.action = f.action
  if (f.scan) o.scan = f.scan
  if (f.gauge !== '' && f.gauge != null) {
    const n = parseInt(String(f.gauge), 10)
    if (Number.isFinite(n)) o.gauge = n
  }
  return o
}

/** @param {number} current 1-based */
/** @param {number} total */
/** @returns {(number | 'ellipsis')[]} */
function buildVerifyPageList(current, total) {
  if (total <= 0) return []
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const pages = new Set([1, total])
  for (let i = Math.max(1, current - 2); i <= Math.min(total, current + 2); i += 1) {
    pages.add(i)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const out = []
  let prev = 0
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('ellipsis')
    out.push(p)
    prev = p
  }
  return out
}

function formatRunDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' })
  } catch {
    return String(iso)
  }
}

function DbVerifyPaginationBar({ page, pagination, setPage }) {
  const total = pagination.total ?? 0
  const tpRaw = Math.max(0, Number(pagination.total_pages) || 0)
  const maxPage = Math.max(1, tpRaw || 1)
  const listLen = tpRaw > 0 ? tpRaw : 1
  const nums = buildVerifyPageList(Math.min(page, maxPage), listLen)
  const btnBase =
    'rounded min-w-[1.75rem] px-1.5 py-1 text-gray-200 disabled:opacity-40 disabled:pointer-events-none'
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
      <span>
        페이지 {page} / {maxPage} (총 {total} runs)
      </span>
      <div className="flex flex-wrap items-center gap-0.5">
        <button
          type="button"
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className={`${btnBase} bg-gray-700 hover:bg-gray-600`}
          aria-label="이전 페이지"
        >
          &lt;
        </button>
        {nums.map((n, idx) =>
          n === 'ellipsis' ? (
            <span key={`e-${idx}`} className="px-1 text-gray-500 select-none">
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              onClick={() => setPage(n)}
              className={
                n === page
                  ? `${btnBase} bg-amber-700 text-white hover:bg-amber-600`
                  : `${btnBase} bg-gray-700 hover:bg-gray-600`
              }
            >
              {n}
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => setPage(Math.min(maxPage, page + 1))}
          disabled={page >= maxPage}
          className={`${btnBase} bg-gray-700 hover:bg-gray-600`}
          aria-label="다음 페이지"
        >
          &gt;
        </button>
      </div>
    </div>
  )
}

function VerifyRunItemCard({ item, saving, onSave }) {
  const [ocrText, setOcrText] = useState(() => String(item.ocr_text ?? ''))

  useEffect(() => {
    setOcrText(String(item.ocr_text ?? ''))
  }, [item.id, item.ocr_text])

  const dirty = ocrText !== String(item.ocr_text ?? '')

  return (
    <div className="rounded border border-gray-700 p-2 bg-gray-900/40 w-[min(100%,260px)]">
      {item.image_url ? (
        <img
          src={item.image_url}
          alt="crop"
          className="h-16 w-16 rounded object-contain bg-black/40 border border-gray-700 mx-auto block"
        />
      ) : (
        <div className="h-16 w-16 rounded bg-gray-700 mx-auto" />
      )}
      <p className="text-[11px] text-gray-400 mt-1 truncate" title={item.label}>
        {item.label}
      </p>
      <label className="block text-[11px] text-gray-500 mt-1">OCR 텍스트</label>
      <input
        type="text"
        value={ocrText}
        onChange={(e) => setOcrText(e.target.value)}
        className="mt-0.5 w-full rounded border border-gray-600 bg-gray-950 px-2 py-1 text-xs text-gray-100"
        disabled={saving}
      />
      {item.ocr_confidence != null && (
        <p className="text-[10px] text-gray-600 mt-0.5">신뢰도 {(item.ocr_confidence * 100).toFixed(0)}%</p>
      )}
      <div className="flex justify-end mt-2">
        <button
          type="button"
          onClick={() => onSave({ ocr_text: ocrText })}
          disabled={saving || !dirty}
          className="rounded bg-amber-700/90 px-2 py-1 text-[11px] hover:bg-amber-600 disabled:opacity-40"
        >
          {saving ? '저장…' : '저장'}
        </button>
      </div>
    </div>
  )
}

function AdminPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [admin, setAdmin] = useState(null)
  const [overview, setOverview] = useState(null)
  const [runsForVerify, setRunsForVerify] = useState([])
  const [recentRuns, setRecentRuns] = useState([])
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, total_pages: 0 })
  const [recentPage, setRecentPage] = useState(1)
  const [recentPagination, setRecentPagination] = useState({ page: 1, limit: 10, total: 0, total_pages: 0 })
  const [recentJumpPage, setRecentJumpPage] = useState('')
  const [savingItemId, setSavingItemId] = useState(null)
  const [verifyFilters, setVerifyFilters] = useState({
    action: '',
    scan: '',
    gauge: '',
  })

  const loadVerifyRuns = useCallback(
    async (p = 1) => {
      const opts = buildVerifyQueryOpts(verifyFilters)
      const ri = await getAdminRunItems(p, 10, opts)
      const pag = ri?.pagination || {}
      const tp = Math.max(0, Number(pag.total_pages) || 0)
      if (tp > 0 && p > tp) {
        const ri2 = await getAdminRunItems(tp, 10, opts)
        setRunsForVerify(Array.isArray(ri2?.runs) ? ri2.runs : [])
        setPagination(ri2?.pagination || {})
        setPage(tp)
        return
      }
      setRunsForVerify(Array.isArray(ri?.runs) ? ri.runs : [])
      setPagination(pag.page != null ? pag : { page: p, limit: 10, total: 0, total_pages: 0 })
      setPage(pag.page ?? p)
    },
    [verifyFilters]
  )

  const updateVerifyFilter = (key, value) => {
    setVerifyFilters((prev) => ({ ...prev, [key]: value }))
    setPage(1)
  }

  const loadRecentRuns = async (p = 1) => {
    const data = await getAdminRecentRuns(p, 10)
    const pag = data?.pagination || {}
    const tp = Math.max(0, Number(pag.total_pages) || 0)
    if (tp > 0 && p > tp) {
      const data2 = await getAdminRecentRuns(tp, 10)
      setRecentRuns(Array.isArray(data2?.runs) ? data2.runs : [])
      setRecentPagination(data2?.pagination || {})
      setRecentPage(tp)
      return
    }
    setRecentRuns(Array.isArray(data?.runs) ? data.runs : [])
    setRecentPagination(pag.page != null ? pag : { page: p, limit: 10, total: 0, total_pages: 0 })
    setRecentPage(pag.page ?? p)
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        setLoading(true)
        setError('')
        const [me, ov] = await Promise.all([getAdminMe(), getAdminOverview()])
        if (!mounted) return
        setAdmin(me?.admin || null)
        setOverview(ov || null)
        await loadRecentRuns(1)
      } catch (e) {
        if (!mounted) return
        setError(e.message || '관리자 페이지 로드 실패')
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (loading) return
    let cancelled = false
    ;(async () => {
      try {
        await loadVerifyRuns(page)
      } catch (e) {
        if (!cancelled) setError(e.message || 'DB 검증 목록 로드 실패')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loading, page, loadVerifyRuns])

  const handleDeleteRun = async (runId) => {
    try {
      await deleteAdminRun(runId)
      const ov = await getAdminOverview()
      setOverview(ov || null)
      await loadRecentRuns(recentPage)
      await loadVerifyRuns(page)
    } catch (e) {
      setError(e.message || '삭제 실패')
    }
  }

  const handleRecentJumpToPage = async (raw) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    const maxPage = Math.max(1, recentPagination.total_pages || 1)
    const next = Math.min(maxPage, Math.max(1, n))
    setRecentPage(next)
    setRecentJumpPage('')
    await loadRecentRuns(next)
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-amber-400">관리자 페이지</h1>
          <Link to="/" className="text-sm text-gray-300 hover:text-white">
            대시보드
          </Link>
        </div>
      </header>
      <main className="max-w-6xl mx-auto p-6 space-y-4">
        {loading && <div className="rounded border border-gray-700 bg-gray-800 p-4 text-sm text-gray-300">불러오는 중...</div>}
        {!loading && error && <div className="rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">{error}</div>}
        {!loading && !error && (
          <>
            <div className="rounded border border-gray-700 bg-gray-800 p-4">
              <p className="text-sm text-gray-400">관리자</p>
              <p className="text-sm text-gray-100">
                {(admin?.global_name || admin?.username || '-') + ' '}
                <span className="text-gray-500">({admin?.discord_id || '-'})</span>
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded border border-gray-700 bg-gray-800 p-4">
                <p className="text-xs text-gray-400">사용자 수</p>
                <p className="text-2xl font-semibold">{overview?.counts?.users ?? 0}</p>
              </div>
              <div className="rounded border border-gray-700 bg-gray-800 p-4">
                <p className="text-xs text-gray-400">Run 수</p>
                <p className="text-2xl font-semibold">{overview?.counts?.runs ?? 0}</p>
              </div>
              <div className="rounded border border-gray-700 bg-gray-800 p-4">
                <p className="text-xs text-gray-400">Run Item 수</p>
                <p className="text-2xl font-semibold">{overview?.counts?.run_items ?? 0}</p>
              </div>
            </div>
            <div className="rounded border border-gray-700 bg-gray-800 p-4">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <p className="text-sm text-gray-300">최근 Run</p>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span>
                    페이지 {recentPagination.page} / {Math.max(1, recentPagination.total_pages || 1)} (총{' '}
                    {recentPagination.total ?? 0} runs)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.max(1, recentPage - 1)
                      setRecentPage(next)
                      loadRecentRuns(next)
                    }}
                    disabled={recentPage <= 1}
                    className="rounded bg-gray-700 px-2 py-1 disabled:opacity-50"
                  >
                    이전
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const maxPage = Math.max(1, recentPagination.total_pages || 1)
                      const next = Math.min(maxPage, recentPage + 1)
                      setRecentPage(next)
                      loadRecentRuns(next)
                    }}
                    disabled={recentPage >= Math.max(1, recentPagination.total_pages || 1)}
                    className="rounded bg-gray-700 px-2 py-1 disabled:opacity-50"
                  >
                    다음
                  </button>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      value={recentJumpPage}
                      onChange={(e) => setRecentJumpPage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRecentJumpToPage(recentJumpPage)
                      }}
                      className="w-20 rounded-md border border-gray-600 bg-gray-900 px-2 py-1 text-sm text-gray-100"
                      placeholder="페이지"
                    />
                    <button
                      type="button"
                      onClick={() => handleRecentJumpToPage(recentJumpPage)}
                      disabled={!recentJumpPage}
                      className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600 disabled:opacity-50"
                    >
                      이동
                    </button>
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="py-2 pr-4">시간</th>
                      <th className="py-2 pr-4">Run ID</th>
                      <th className="py-2 pr-4">유저</th>
                      <th className="py-2 pr-4">items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((r) => (
                      <tr key={r.run_id} className="border-b border-gray-800">
                        <td className="py-2 pr-4 text-gray-300">{r.created_at || '-'}</td>
                        <td className="py-2 pr-4 text-gray-100">{r.run_id}</td>
                        <td className="py-2 pr-4 text-gray-300">
                          {r.global_name || r.username || '-'} {r.user_id ? `(#${r.user_id})` : ''}
                        </td>
                        <td className="py-2 pr-4 text-gray-100">{r.tracked_count ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {recentPagination.total === 0 && (
                <p className="text-xs text-gray-500 mt-2">저장된 run이 없습니다.</p>
              )}
            </div>
            <div className="rounded border border-gray-700 bg-gray-800 p-4">
              <p className="text-sm text-gray-300 mb-2">DB 검증 (이미지 vs OCR 숫자)</p>
              <div className="flex flex-wrap items-end gap-3 mb-3 pb-3 border-b border-gray-700 text-xs">
                <div>
                  <label className="block text-gray-500 mb-1">행동</label>
                  <select
                    value={verifyFilters.action}
                    onChange={(e) => updateVerifyFilter('action', e.target.value)}
                    className="rounded-md border border-gray-600 bg-gray-900 px-2 py-1.5 text-gray-100 min-w-[7rem]"
                  >
                    <option value="">전체</option>
                    <option value="normal">normal</option>
                    <option value="chest">chest</option>
                    <option value="mini">mini</option>
                  </select>
                </div>
                <div>
                  <label className="block text-gray-500 mb-1">스캔</label>
                  <select
                    value={verifyFilters.scan}
                    onChange={(e) => updateVerifyFilter('scan', e.target.value)}
                    className="rounded-md border border-gray-600 bg-gray-900 px-2 py-1.5 text-gray-100 min-w-[7rem]"
                  >
                    <option value="">전체</option>
                    <option value="common">common</option>
                    <option value="uncommon">uncommon</option>
                    <option value="none">없음 (null)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-gray-500 mb-1">게이지 소모량</label>
                  <div className="flex flex-wrap gap-1 items-center mt-1">
                    <input
                      type="number"
                      min="0"
                      placeholder="값 입력 후 Enter"
                      value={verifyFilters.gauge}
                      onChange={(e) => setVerifyFilters((prev) => ({ ...prev, gauge: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          updateVerifyFilter('gauge', e.currentTarget.value.trim())
                        }
                      }}
                      className="w-28 rounded-md border border-gray-600 bg-gray-900 px-2 py-1.5 text-gray-100"
                    />
                    {['180', '360', '0'].map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => updateVerifyFilter('gauge', g)}
                        className="rounded border border-gray-600 bg-gray-800 px-2 py-1 text-gray-200 hover:bg-gray-700"
                      >
                        {g}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => updateVerifyFilter('gauge', '')}
                      className="rounded border border-gray-600 bg-gray-800 px-2 py-1 text-gray-400 hover:bg-gray-700"
                    >
                      전체
                    </button>
                  </div>
                </div>
              </div>
              <div className="mb-2">
                <DbVerifyPaginationBar page={page} pagination={pagination} setPage={setPage} />
              </div>
              <div className="space-y-2">
                {runsForVerify.map((run) => (
                  <div key={run.run_id} className="rounded border border-gray-700 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1 text-sm space-y-0.5">
                        <p className="text-gray-100 truncate">run={run.run_id}</p>
                        <p className="text-gray-400 truncate">
                          user_id={run.user_id || '-'} ({run.global_name || run.username || '-'}) / 개수={run.item_count ?? 0}
                        </p>
                        <p className="text-xs text-gray-400">
                          <span className="text-gray-500">저장 시각:</span>{' '}
                          <span className="text-gray-200">{formatRunDateTime(run.run_created_at)}</span>
                          {' · '}
                          <span className="text-gray-500">프리셋:</span>{' '}
                          <span className="text-gray-200">
                            {run.tool_spec_name || '—'}
                            {run.tool_spec_id != null ? ` (#${run.tool_spec_id})` : ''}
                          </span>
                        </p>
                        <p className="text-xs text-gray-300">
                          <span className="text-gray-500">행동:</span>{' '}
                          <span className="text-gray-100 font-medium">{run.action_type || '—'}</span>
                          {' · '}
                          <span className="text-gray-500">게이지:</span>{' '}
                          <span className="text-gray-100">{run.gauge != null ? run.gauge : '—'}</span>
                          {(run.action_type === 'normal' || run.action_type === 'mini') && (
                            <>
                              {' '}
                              <span className="text-gray-500">· 스캔:</span>{' '}
                              <span className="text-gray-100">{run.scan_result || '—'}</span>
                            </>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteRun(run.run_id)}
                        className="rounded bg-red-700 px-3 py-1.5 text-xs hover:bg-red-600"
                      >
                        run 삭제
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(run.items || []).map((it) => (
                        <VerifyRunItemCard
                          key={it.id}
                          item={it}
                          saving={savingItemId === it.id}
                          onSave={async (payload) => {
                            setSavingItemId(it.id)
                            setError('')
                            try {
                              await patchAdminRunItem(it.id, payload)
                              await loadVerifyRuns(page)
                            } catch (e) {
                              setError(e.message || '저장 실패')
                            } finally {
                              setSavingItemId(null)
                            }
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-gray-700">
                <DbVerifyPaginationBar page={page} pagination={pagination} setPage={setPage} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

export default AdminPage

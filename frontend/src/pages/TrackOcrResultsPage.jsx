import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  getTrackOcrRuns,
  getTrackOcrRun,
  verifyTrackOcrItem,
  deleteTrackOcrItem,
  updateTrackOcrItemOcrText,
  getDbTools,
  getToolSpecs,
  createToolSpec,
  deleteToolSpec,
  getDbScanResults,
  getDbActionTypes,
  sendRunToDb,
} from '../services/api'

function TrackOcrResultsPage() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [runDetail, setRunDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [verifyingIndex, setVerifyingIndex] = useState(null)
  const [deletingIndex, setDeletingIndex] = useState(null)
  const [editingItemIndex, setEditingItemIndex] = useState(null)
  const [editOcrText, setEditOcrText] = useState('')
  const [savingEditIndex, setSavingEditIndex] = useState(null)
  const [tools, setTools] = useState([])
  const [scanResults, setScanResults] = useState([])
  const [actionTypes, setActionTypes] = useState([])
  const [sendForm, setSendForm] = useState({ tool_id: 1, scan_result_id: '', action_type_id: 1, gauge: 180 })
  const [sending, setSending] = useState(false)
  const [sendMessage, setSendMessage] = useState(null)
  const [toolSpecs, setToolSpecs] = useState([])
  const [selectedToolSpecId, setSelectedToolSpecId] = useState('')
  const [isSpecModalOpen, setIsSpecModalOpen] = useState(false)
  const [specForm, setSpecForm] = useState({
    name: '',
    common_reward_bonus: '',
    uncommon_reward_bonus: '',
    rare_reward_bonus: '',
    minigame_reward_bonus: '',
    minigame_chance_bonus: '',
    chest_spawn_bonus: '',
  })
  const [specError, setSpecError] = useState(null)
  const runListScrollbarStyle = {
    scrollbarWidth: 'thin',
    scrollbarColor: '#8b5cf6 #1f2937',
  }

  const loadRuns = useCallback(async (options = {}) => {
    const silent = options.silent === true
    if (!silent) setLoading(true)
    setError(null)
    try {
      const data = await getTrackOcrRuns()
      setRuns(data.runs || [])
    } catch (e) {
      setError(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  useEffect(() => {
    getDbTools().then((d) => setTools(d.tools || [])).catch(() => setTools([]))
    getDbScanResults().then((d) => setScanResults(d.scan_results || [])).catch(() => setScanResults([]))
    getDbActionTypes().then((d) => setActionTypes(d.action_types || [])).catch(() => setActionTypes([]))
  }, [])

  useEffect(() => {
    if (!tools.length) return
    const exists = tools.some((t) => String(t.id) === String(sendForm.tool_id))
    if (!exists && tools[0]?.id != null) {
      setSendForm((f) => ({ ...f, tool_id: tools[0].id }))
    }
  }, [tools, sendForm.tool_id])

  const presetsForCurrentTool = toolSpecs
  const selectedToolSpec = presetsForCurrentTool.find((s) => String(s.id) === String(selectedToolSpecId)) || null

  const loadToolSpecs = useCallback(async (toolId) => {
    if (!toolId) {
      setToolSpecs([])
      return
    }
    try {
      const data = await getToolSpecs(Number(toolId))
      setToolSpecs(data.specs || [])
    } catch {
      setToolSpecs([])
    }
  }, [])

  useEffect(() => {
    if (!sendForm.tool_id) return
    loadToolSpecs(sendForm.tool_id)
  }, [sendForm.tool_id, loadToolSpecs])

  useEffect(() => {
    const forTool = toolSpecs.filter(
      (s) => s.tool_id != null && String(s.tool_id) === String(sendForm.tool_id)
    )
    const isInList = forTool.some((s) => String(s.id) === String(selectedToolSpecId))
    if (selectedToolSpecId && !isInList) {
      setSelectedToolSpecId(forTool[0] ? String(forTool[0].id) : '')
    }
  }, [sendForm.tool_id, toolSpecs, selectedToolSpecId])

  const handleChangeTool = (value) => {
    setSendForm((f) => ({ ...f, tool_id: value }))
    setSelectedToolSpecId('')
  }

  const openSpecModal = () => {
    setSpecError(null)
    setSpecForm({
      name: '',
      common_reward_bonus: '',
      uncommon_reward_bonus: '',
      rare_reward_bonus: '',
      minigame_reward_bonus: '',
      minigame_chance_bonus: '',
      chest_spawn_bonus: '',
    })
    setIsSpecModalOpen(true)
  }

  const closeSpecModal = () => {
    setIsSpecModalOpen(false)
  }

  const handleSaveToolSpec = async () => {
    if (!specForm.name.trim()) {
      setSpecError('프리셋 이름을 입력하세요.')
      return
    }
    setSpecError(null)
    const toNum = (v) => (v === '' || v == null ? null : Number(v))
    const body = {
      name: specForm.name.trim(),
      common_reward_bonus: toNum(specForm.common_reward_bonus),
      uncommon_reward_bonus: toNum(specForm.uncommon_reward_bonus),
      rare_reward_bonus: toNum(specForm.rare_reward_bonus),
      minigame_reward_bonus: toNum(specForm.minigame_reward_bonus),
      minigame_chance_bonus: toNum(specForm.minigame_chance_bonus),
      chest_spawn_bonus: toNum(specForm.chest_spawn_bonus),
    }
    try {
      const created = await createToolSpec(Number(sendForm.tool_id), body)
      await loadToolSpecs(sendForm.tool_id)
      setSelectedToolSpecId(String(created.id))
      setIsSpecModalOpen(false)
    } catch (e) {
      setSpecError(e.message || '프리셋 저장 실패')
    }
  }

  const handleDeleteToolSpec = async () => {
    if (!selectedToolSpecId) return
    try {
      await deleteToolSpec(Number(selectedToolSpecId))
      await loadToolSpecs(sendForm.tool_id)
      setSelectedToolSpecId('')
    } catch (e) {
      setSpecError(e.message || '프리셋 삭제 실패')
    }
  }

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null)
      setSendMessage(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setSendMessage(null)
    getTrackOcrRun(selectedRunId)
      .then((data) => {
        if (!cancelled) setRunDetail(data)
      })
      .catch(() => {
        if (!cancelled) setRunDetail(null)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => { cancelled = true }
  }, [selectedRunId])

  useEffect(() => {
    if (!runDetail?.id || !scanResults.length || !actionTypes.length) return
    const sr = runDetail.scan_result != null ? scanResults.find((s) => s.label === runDetail.scan_result) : null
    const at = runDetail.action_type != null ? actionTypes.find((a) => a.label === runDetail.action_type) : null
    setSendForm((f) => ({
      ...f,
      ...(sr && { scan_result_id: sr.id }),
      ...(at && { action_type_id: at.id }),
      ...(runDetail.gauge_consumed != null && runDetail.gauge_consumed !== '' && { gauge: Number(runDetail.gauge_consumed) }),
    }))
  }, [runDetail?.id, runDetail?.scan_result, runDetail?.action_type, runDetail?.gauge_consumed, scanResults, actionTypes])

  const handleVerify = async (runId, itemIndex, pass) => {
    setVerifyingIndex(itemIndex)
    try {
      await verifyTrackOcrItem(runId, itemIndex, pass)
      const data = await getTrackOcrRun(runId)
      setRunDetail(data)
      await loadRuns({ silent: true })
    } catch (_) {}
    setVerifyingIndex(null)
  }

  const handleDeleteItem = async (runId, itemIndex) => {
    setDeletingIndex(itemIndex)
    try {
      await deleteTrackOcrItem(runId, itemIndex)
      const data = await getTrackOcrRun(runId)
      setRunDetail(data)
      await loadRuns({ silent: true })
    } catch (_) {}
    setDeletingIndex(null)
  }

  const startEditOcr = (item) => {
    setEditingItemIndex(item.item_index)
    setEditOcrText(String(item.ocr_text || ''))
  }

  const cancelEditOcr = () => {
    setEditingItemIndex(null)
    setEditOcrText('')
  }

  const saveEditOcr = async (runId, itemIndex) => {
    setSavingEditIndex(itemIndex)
    try {
      await updateTrackOcrItemOcrText(runId, itemIndex, editOcrText)
      const data = await getTrackOcrRun(runId)
      setRunDetail(data)
      await loadRuns({ silent: true })
      cancelEditOcr()
    } catch (_) {
      // no-op
    }
    setSavingEditIndex(null)
  }

  const handleSendToDb = async () => {
    if (!runDetail?.id) return
    const verifiedCount = (runDetail.items || []).filter((it) => it.verified).length
    if (verifiedCount === 0) {
      setSendMessage({ type: 'error', text: '통과된 항목이 없습니다. 항목에 "통과"를 눌러주세요.' })
      return
    }
    setSending(true)
    setSendMessage(null)
    try {
      const body = {
        tool_id: Number(sendForm.tool_id),
        action_type_id: Number(sendForm.action_type_id),
        gauge: Number(sendForm.gauge),
      }
      if (sendForm.scan_result_id !== '' && sendForm.scan_result_id != null) {
        body.scan_result_id = Number(sendForm.scan_result_id)
      }
      if (selectedToolSpecId) {
        body.tool_spec_id = Number(selectedToolSpecId)
      }
      const res = await sendRunToDb(runDetail.id, body)
      setSendMessage({ type: 'success', text: res.message || `DB에 ${res.saved_items}건 저장되었습니다.` })
    } catch (e) {
      setSendMessage({ type: 'error', text: e.message })
    }
    setSending(false)
  }

  const formatDate = (iso) => {
    if (!iso) return '-'
    try {
      const d = new Date(iso)
      return d.toLocaleString('ko-KR')
    } catch {
      return iso
    }
  }

  const itemCounts = runDetail?.items
    ? runDetail.items.reduce(
        (acc, it) => {
          const label = it.label || ''
          if (label === 'common_item') acc.common_item += 1
          else if (label === 'uncommon_item') acc.uncommon_item += 1
          else if (label === 'rare_item') acc.rare_item += 1
          return acc
        },
        { common_item: 0, uncommon_item: 0, rare_item: 0 }
      )
    : { common_item: 0, uncommon_item: 0, rare_item: 0 }

  const selectedScan = scanResults.find((s) => String(s.id) === String(sendForm.scan_result_id))
  const selectedAction = actionTypes.find((a) => String(a.id) === String(sendForm.action_type_id))
  const isDbSent = Boolean(runDetail?.db_sent)

  const renderRunsAndDetail = () => {
    if (loading) {
      return <p className="text-gray-500">목록 불러오는 중…</p>
    }
    if (runs.length === 0) {
      return <p className="text-gray-500">저장된 종합 OCR 실행이 없습니다. 테스트 페이지에서 종합 OCR을 실행하면 여기에 쌓입니다.</p>
    }
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <h2 className="text-lg font-medium text-gray-200 mb-2">실행 목록</h2>
          <ul
            className="space-y-2 max-h-[calc(100vh-8rem)] overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-800/80 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-violet-500/70 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-violet-400/80"
            style={runListScrollbarStyle}
          >
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedRunId(r.id)}
                  className={`w-full text-left p-4 rounded-lg border transition ${
                    selectedRunId === r.id
                      ? 'border-violet-500 bg-violet-900/20'
                      : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                  }`}
                >
                  <span className="text-gray-400 text-xs font-mono">{r.id.slice(0, 8)}…</span>
                  <span className="block text-sm text-gray-300 mt-1">{formatDate(r.created_at)}</span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    track {r.tracked_count}개 · 검증 {r.verified_count}개
                  </span>
                  {r.db_sent && (
                    <span className="inline-flex mt-1 items-center rounded-full border border-emerald-500/40 bg-emerald-900/30 px-2 py-0.5 text-[11px] text-emerald-300">
                      DB 전송 완료
                    </span>
                  )}
                  {(r.scan_result != null || r.action_type != null || r.gauge_consumed != null) && (
                    <span className="block text-xs text-violet-400/90 mt-1">
                      스캔 OCR {r.scan_result ?? '-'} / 행동 OCR {r.action_type ?? '-'} / 게이지 OCR {r.gauge_consumed != null ? r.gauge_consumed : '-'}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-medium text-gray-200 mb-2">상세 (종합 OCR)</h2>
          {!selectedRunId ? (
            <p className="text-gray-500 text-sm">왼쪽에서 실행을 선택하세요.</p>
          ) : detailLoading ? (
            <p className="text-gray-500">상세 불러오는 중…</p>
          ) : !runDetail ? (
            <p className="text-gray-500">상세를 불러올 수 없습니다.</p>
          ) : (
            <>
              <div className="mb-4 p-4 rounded-lg border border-violet-700/50 bg-violet-900/10 space-y-2">
                <h3 className="text-sm font-medium text-violet-300">종합 요약</h3>
                {(runDetail.scan_result != null || runDetail.action_type != null || runDetail.gauge_consumed != null) && (
                  <p className="text-xs text-violet-400/80">
                    스캔 OCR: 화면에서 <span className="text-violet-200/90">common / uncommon</span> 박스로 스캔 종류 판정 · 행동 OCR: normal/chest/mini 등 · 게이지 OCR: 전·후 차이
                  </p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="text-gray-500">
                    스캔 OCR <span className="text-gray-600 font-normal">(일반·고급 / common·uncommon)</span>
                    <span className="block text-gray-200">{selectedScan ? (selectedScan.display_name || selectedScan.label) : (runDetail.scan_result || '미선택')}</span>
                  </div>
                  <div className="text-gray-500">
                    행동 OCR
                    <span className="block text-gray-200">{selectedAction ? (selectedAction.display_name || selectedAction.label) : (runDetail.action_type || '-')}</span>
                  </div>
                  <div className="text-gray-500">
                    게이지 OCR
                    <span className="block text-gray-200">{runDetail.gauge_consumed != null ? runDetail.gauge_consumed : sendForm.gauge}</span>
                  </div>
                  <div className="text-gray-500">
                    개수 OCR
                    <span className="block text-gray-200">
                      common_item {itemCounts.common_item} / uncommon_item {itemCounts.uncommon_item} / rare_item {itemCounts.rare_item}
                    </span>
                  </div>
                </div>
                {(runDetail.scan_frame_image_url || runDetail.scan_ocr_processed_image_url) && (
                  <div className="flex flex-wrap gap-4 pt-2 border-t border-violet-800/30 mt-2">
                    {runDetail.scan_frame_image_url && (
                      <div className="space-y-1">
                        <span className="text-[10px] text-gray-500 block leading-tight">
                          스캔 OCR 참고 프레임 (원본)
                        </span>
                        <span className="text-[9px] text-gray-600 block -mt-0.5 mb-0.5">
                          판정된 쪽(common 또는 uncommon) YOLO 박스만 잘라 저장한 이미지
                        </span>
                        <div className="w-44 h-28 rounded border border-gray-700 bg-gray-900/60 flex items-center justify-center overflow-hidden">
                          <img
                            src={runDetail.scan_frame_image_url}
                            alt="scan-frame"
                            className="max-w-full max-h-full object-contain"
                            loading="lazy"
                          />
                        </div>
                      </div>
                    )}
                    {runDetail.scan_ocr_processed_image_url && (
                      <div className="space-y-1">
                        <span className="text-[10px] text-gray-500 block leading-tight">
                          스캔 OCR 전처리 (Paddle) — 위 프레임과 동일 출처
                        </span>
                        <div className="w-44 h-28 rounded border border-gray-700 bg-gray-900/60 flex items-center justify-center overflow-hidden">
                          <img
                            src={runDetail.scan_ocr_processed_image_url}
                            alt="scan-ocr-processed"
                            className="max-w-full max-h-full object-contain"
                            loading="lazy"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="mb-4 p-4 rounded-lg border border-gray-700 bg-gray-800/50 space-y-3">
                <h3 className="text-sm font-medium text-gray-300">DB에 보내기</h3>
                <p className="text-gray-500 text-xs">
                  통과된 항목만 DB에 저장됩니다. 도구·스캔·행동·게이지를 선택한 뒤 버튼을 누르세요.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                  <label className="text-xs text-gray-500">
                    도구
                    <select
                      value={sendForm.tool_id}
                      onChange={(e) => handleChangeTool(e.target.value)}
                      className="mt-1 w-full rounded bg-gray-700 border border-gray-600 text-gray-200 px-2 py-1.5 text-sm"
                    >
                      {tools.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mb-3 p-3 rounded-md border border-gray-700 bg-gray-900/40 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-300">이 도구의 생활 스펙 프리셋</span>
                      <select
                        value={selectedToolSpecId}
                        onChange={(e) => setSelectedToolSpecId(e.target.value)}
                        className="rounded bg-gray-800 border border-gray-600 text-gray-200 px-2 py-1 text-xs"
                      >
                        <option value="">프리셋 선택 안 함</option>
                        {presetsForCurrentTool.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedToolSpecId && (
                        <button
                          type="button"
                          onClick={handleDeleteToolSpec}
                          className="text-[11px] px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white"
                        >
                          프리셋 삭제
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={openSpecModal}
                        className="text-[11px] px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-100"
                      >
                        이 도구 스펙 프리셋 만들기
                      </button>
                    </div>
                  </div>
                  {selectedToolSpec && (
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-400">
                      <div>
                        <span className="block text-gray-500">일반 보상 획득률</span>
                        <span className="block text-gray-200">
                          {selectedToolSpec.common_reward_bonus != null ? `${selectedToolSpec.common_reward_bonus}%` : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-gray-500">고급 보상 획득률</span>
                        <span className="block text-gray-200">
                          {selectedToolSpec.uncommon_reward_bonus != null ? `${selectedToolSpec.uncommon_reward_bonus}%` : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-gray-500">희귀 보상 획득률</span>
                        <span className="block text-gray-200">
                          {selectedToolSpec.rare_reward_bonus != null ? `${selectedToolSpec.rare_reward_bonus}%` : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-gray-500">미니게임 보상 획득률</span>
                        <span className="block text-gray-200">
                          {selectedToolSpec.minigame_reward_bonus != null ? `${selectedToolSpec.minigame_reward_bonus}%` : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-gray-500">미니게임 기회 획득 확률</span>
                        <span className="block text-gray-200">
                          {selectedToolSpec.minigame_chance_bonus != null ? `${selectedToolSpec.minigame_chance_bonus}%` : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-gray-500">보물상자 등장 확률</span>
                        <span className="block text-gray-200">
                          {selectedToolSpec.chest_spawn_bonus != null ? `${selectedToolSpec.chest_spawn_bonus}%` : '-'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                  <label className="text-xs text-gray-500">
                    스캔 결과 (선택)
                    <select
                      value={sendForm.scan_result_id}
                      onChange={(e) => setSendForm((f) => ({ ...f, scan_result_id: e.target.value }))}
                      className="mt-1 w-full rounded bg-gray-700 border border-gray-600 text-gray-200 px-2 py-1.5 text-sm"
                    >
                      <option value="">선택 안 함</option>
                      {scanResults.map((s) => (
                        <option key={s.id} value={s.id}>{s.display_name || s.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-gray-500">
                    행동 타입
                    <select
                      value={sendForm.action_type_id}
                      onChange={(e) => setSendForm((f) => ({ ...f, action_type_id: e.target.value }))}
                      className="mt-1 w-full rounded bg-gray-700 border border-gray-600 text-gray-200 px-2 py-1.5 text-sm"
                    >
                      {actionTypes.map((a) => (
                        <option key={a.id} value={a.id}>{a.display_name || a.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-gray-500">
                    게이지 (0 / 180 / 360)
                    <input
                      type="number"
                      min={0}
                      max={360}
                      value={sendForm.gauge}
                      onChange={(e) => setSendForm((f) => ({ ...f, gauge: e.target.value }))}
                      className="mt-1 w-full rounded bg-gray-700 border border-gray-600 text-gray-200 px-2 py-1.5 text-sm"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={sending || isDbSent}
                    onClick={handleSendToDb}
                    className={`text-white px-4 py-2 rounded text-sm disabled:opacity-50 ${
                      isDbSent ? 'bg-emerald-700 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'
                    }`}
                  >
                    {isDbSent ? '전송 완료됨' : (sending ? '저장 중…' : 'DB에 보내기')}
                  </button>
                  {sendMessage && (
                    <span className={sendMessage.type === 'success' ? 'text-green-400 text-sm' : 'text-red-400 text-sm'}>
                      {sendMessage.text}
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-3 max-h-[70vh] overflow-y-auto">
                {runDetail.items.map((item, idx) => (
                  <div
                    key={item.track_id ?? idx}
                    className={`p-4 rounded-lg border ${
                      item.verified ? 'border-green-700/50 bg-green-900/10' : 'border-gray-700 bg-gray-800/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-blue-300">#{item.track_id}</span>
                        {' '}
                        <span className="text-gray-500 text-sm">({(item.confidence * 100).toFixed(0)}%)</span>
                        <div className="mt-2 space-y-0.5 text-sm">
                          <div className="text-green-400">
                            아이템 OCR: <span className="text-gray-200">{item.label === 'common_item' ? '고대 유물' : item.label === 'uncommon_item' ? '희귀한 유물' : item.label === 'rare_item' ? '아비도스 유물' : item.label}</span>
                          </div>
                          {item.ocr_text != null && item.ocr_text !== '' && (
                            <div className="text-green-400">
                              개수 OCR: <span className="text-gray-200">{item.ocr_text}</span>
                              {item.ocr_confidence != null && (
                                <span className="text-gray-500 ml-1">({(item.ocr_confidence * 100).toFixed(0)}%)</span>
                              )}
                              {item.ocr_manual_edited && (
                                <span className="text-amber-300 ml-1">(수동수정)</span>
                              )}
                            </div>
                          )}
                          {(!item.ocr_text || item.ocr_text === '') && (
                            <div className="text-gray-500 text-sm">개수 OCR: -</div>
                          )}
                          {editingItemIndex === item.item_index ? (
                            <div className="mt-1 flex items-center gap-2">
                              <input
                                type="text"
                                value={editOcrText}
                                onChange={(e) => setEditOcrText(e.target.value)}
                                placeholder="개수 직접 입력"
                                className="w-28 rounded bg-gray-900 border border-gray-600 text-gray-100 px-2 py-1 text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => saveEditOcr(runDetail.id, item.item_index)}
                                disabled={savingEditIndex === item.item_index}
                                className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-2 py-1 rounded text-xs"
                              >
                                {savingEditIndex === item.item_index ? '저장 중…' : '저장'}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditOcr}
                                disabled={savingEditIndex === item.item_index}
                                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-2 py-1 rounded text-xs"
                              >
                                취소
                              </button>
                            </div>
                          ) : (
                            <div className="mt-1">
                              <button
                                type="button"
                                onClick={() => startEditOcr(item)}
                                className="bg-amber-700 hover:bg-amber-600 text-white px-2 py-1 rounded text-xs"
                              >
                                개수 수정
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex-shrink-0 flex items-center gap-2">
                        {item.verified ? (
                          <span className="text-green-400 text-sm">✓ 통과됨</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={deletingIndex === item.item_index}
                              onClick={() => handleDeleteItem(runDetail.id, item.item_index)}
                              className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-2 py-1.5 rounded text-xs border border-red-500"
                              title="항목 삭제"
                            >
                              {deletingIndex === item.item_index ? '삭제 중…' : 'X'}
                            </button>
                            <button
                              type="button"
                              disabled={verifyingIndex === item.item_index}
                              onClick={() => handleVerify(runDetail.id, item.item_index, true)}
                              className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm"
                            >
                              {verifyingIndex === item.item_index ? '처리 중…' : '통과 (DB 전송)'}
                            </button>
                            <button
                              type="button"
                              disabled={verifyingIndex === item.item_index}
                              onClick={() => handleVerify(runDetail.id, item.item_index, false)}
                              className="bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm border border-gray-500"
                            >
                              거부
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {item.image_url && (
                      <div className="mt-2 w-full max-w-xs h-28 rounded border border-gray-700 bg-gray-900/60 flex items-center justify-center overflow-hidden">
                        <img
                          src={item.image_url}
                          alt={`track-${item.track_id ?? idx}`}
                          className="max-w-full max-h-full object-contain"
                          loading="lazy"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderToolSpecModal = () => {
    if (!isSpecModalOpen) return null
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-lg bg-gray-900 border border-gray-700 p-4">
          <h2 className="text-sm font-medium text-gray-100 mb-3">이 도구의 생활 스펙 프리셋 만들기</h2>
          <p className="text-xs text-gray-500 mb-3">
            선택한 도구에 연결해 로컬에 저장됩니다. DB 전송용 참고 프리셋으로만 사용됩니다.
          </p>
          {specError && (
            <div className="mb-2 rounded bg-red-900/40 text-red-300 text-xs px-2 py-1">
              {specError}
            </div>
          )}
          <div className="space-y-2 text-xs">
            <label className="block text-gray-400">
              프리셋 이름
              <input
                type="text"
                value={specForm.name}
                onChange={(e) => setSpecForm((f) => ({ ...f, name: e.target.value }))}
                className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                placeholder="예: 메인 고고학 세팅"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-gray-400">
                일반 보상 획득률 (%)
                <input
                  type="number"
                  value={specForm.common_reward_bonus}
                  onChange={(e) => setSpecForm((f) => ({ ...f, common_reward_bonus: e.target.value }))}
                  className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                />
              </label>
              <label className="block text-gray-400">
                고급 보상 획득률 (%)
                <input
                  type="number"
                  value={specForm.uncommon_reward_bonus}
                  onChange={(e) => setSpecForm((f) => ({ ...f, uncommon_reward_bonus: e.target.value }))}
                  className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                />
              </label>
              <label className="block text-gray-400">
                희귀 보상 획득률 (%)
                <input
                  type="number"
                  value={specForm.rare_reward_bonus}
                  onChange={(e) => setSpecForm((f) => ({ ...f, rare_reward_bonus: e.target.value }))}
                  className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                />
              </label>
              <label className="block text-gray-400">
                미니게임 보상 획득률 (%)
                <input
                  type="number"
                  value={specForm.minigame_reward_bonus}
                  onChange={(e) => setSpecForm((f) => ({ ...f, minigame_reward_bonus: e.target.value }))}
                  className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                />
              </label>
              <label className="block text-gray-400">
                미니게임 기회 획득 확률 (%)
                <input
                  type="number"
                  value={specForm.minigame_chance_bonus}
                  onChange={(e) => setSpecForm((f) => ({ ...f, minigame_chance_bonus: e.target.value }))}
                  className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                />
              </label>
              <label className="block text-gray-400">
                보물상자 등장 확률 (%)
                <input
                  type="number"
                  value={specForm.chest_spawn_bonus}
                  onChange={(e) => setSpecForm((f) => ({ ...f, chest_spawn_bonus: e.target.value }))}
                  className="mt-1 w-full rounded bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1"
                />
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeSpecModal}
              disabled={false}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-100 text-xs disabled:opacity-60"
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleSaveToolSpec}
              disabled={false}
              className="px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white text-xs disabled:opacity-60"
            >
              프리셋 저장
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold text-violet-400">종합 OCR 결과</h1>
          <nav className="flex gap-3 text-sm">
            <Link to="/track-ocr-results" className="text-violet-400 font-medium">종합 OCR 결과</Link>
            <Link to="/number-ocr-test" className="text-gray-400 hover:text-gray-200">숫자 OCR 테스트</Link>
            <Link to="/test" className="text-gray-400 hover:text-gray-200">테스트</Link>
            <Link to="/" className="text-gray-400 hover:text-gray-200">대시보드</Link>
            <Link to="/data-collect" className="text-gray-400 hover:text-gray-200">데이터 수집</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        <p className="text-gray-500 text-sm mb-4">
          저장된 종합 OCR 실행 목록입니다. 실행을 클릭해 상세(스캔·행동·게이지·아이템 개수)를 보고, DB에 넣을 항목은 &quot;통과&quot;, 제외할 항목은 &quot;거부&quot;를 눌러주세요.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-900/30 text-red-300 text-sm">
            {error}
          </div>
        )}

        {renderRunsAndDetail()}
      </main>
      {renderToolSpecModal()}
    </div>
  )
}

export default TrackOcrResultsPage

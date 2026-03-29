import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { testNumberOcr } from '../services/api'

function NumberOcrTestPage() {
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const previewUrl = useMemo(() => {
    if (!file) return ''
    return URL.createObjectURL(file)
  }, [file])

  const detailNumbers = useMemo(() => {
    const details = Array.isArray(result?.ocr_details) ? result.ocr_details : []
    return details
      .map((d, idx) => {
        const text = String(d?.text ?? '')
        const m = text.match(/\d+/g)
        const number = m && m.length > 0 ? m[m.length - 1] : null
        const confidence = typeof d?.confidence === 'number' ? d.confidence : null
        return { idx, text, number, confidence }
      })
      .filter((x) => x.number !== null)
  }, [result])

  const handleSelectFile = (e) => {
    const f = e.target.files?.[0]
    setError('')
    setResult(null)
    setFile(f || null)
  }

  const handleTest = async () => {
    if (!file) {
      setError('이미지를 먼저 선택해주세요.')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const data = await testNumberOcr(file)
      setResult(data)
    } catch (err) {
      setError(err.message || '숫자 OCR 테스트 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold text-emerald-400">숫자 OCR 테스트</h1>
          <nav className="flex gap-3 text-sm">
            <Link to="/number-ocr-test" className="text-emerald-400 font-medium">숫자 OCR 테스트</Link>
            <Link to="/track-ocr-results" className="text-gray-400 hover:text-gray-200">종합 OCR 결과</Link>
            <Link to="/test" className="text-gray-400 hover:text-gray-200">테스트</Link>
            <Link to="/" className="text-gray-400 hover:text-gray-200">대시보드</Link>
            <Link to="/data-collect" className="text-gray-400 hover:text-gray-200">데이터 수집</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-4">
          <p className="text-sm text-gray-300">
            숫자 부분이 잘린 이미지(crop)를 올리면 EasyOCR 결과를 바로 확인할 수 있습니다.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="image/*"
              onChange={handleSelectFile}
              className="text-sm text-gray-200 file:mr-3 file:rounded file:border-0 file:bg-gray-700 file:px-3 file:py-2 file:text-gray-100 hover:file:bg-gray-600"
            />
            <button
              type="button"
              onClick={handleTest}
              disabled={loading || !file}
              className="rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-4 py-2 text-sm font-medium"
            >
              {loading ? '테스트 중...' : '숫자 OCR 테스트'}
            </button>
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="rounded-xl border border-gray-700 bg-gray-800/60 p-4">
            <h2 className="text-sm font-semibold text-gray-200 mb-3">업로드 이미지</h2>
            <div className="w-full h-80 rounded border border-gray-700 bg-gray-900/60 flex items-center justify-center overflow-hidden">
              {previewUrl ? (
                <img src={previewUrl} alt="ocr-preview" className="max-w-full max-h-full object-contain" />
              ) : (
                <span className="text-sm text-gray-500">이미지를 선택해주세요.</span>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-200">OCR 결과</h2>
            <div className="text-sm text-gray-300 space-y-1">
              <p><span className="text-gray-400">ocr_text:</span> {result?.ocr_text ?? '-'}</p>
              <p><span className="text-gray-400">ocr_number:</span> {result?.ocr_number ?? '-'}</p>
              <p>
                <span className="text-gray-400">ocr_confidence:</span>{' '}
                {typeof result?.ocr_confidence === 'number'
                  ? result.ocr_confidence.toFixed(6)
                  : '-'}
              </p>
              <div className="pt-1">
                <p className="text-gray-400">detail ocr_number:</p>
                {detailNumbers.length > 0 ? (
                  <ul className="mt-1 space-y-1 text-xs text-emerald-300">
                    {detailNumbers.map((item) => (
                      <li key={`${item.idx}-${item.number}`}>
                        #{item.idx} {item.number}
                        {typeof item.confidence === 'number' ? ` (conf: ${item.confidence.toFixed(4)})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">-</p>
                )}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-2">raw details</p>
              <pre className="text-xs bg-gray-900/70 border border-gray-700 rounded p-3 overflow-auto max-h-64 text-gray-200">
                {result ? JSON.stringify(result.ocr_details, null, 2) : '[]'}
              </pre>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

export default NumberOcrTestPage

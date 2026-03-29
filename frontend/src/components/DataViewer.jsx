import { useState } from 'react'

export default function DataViewer({ images, ocrResults }) {
  const [activeTab, setActiveTab] = useState('images')

  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      {/* 탭 네비게이션 */}
      <div className="flex gap-1 mb-4 bg-gray-900 rounded-lg p-1">
        <button
          onClick={() => setActiveTab('images')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'images'
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          캡처 이미지 ({images.length})
        </button>
        <button
          onClick={() => setActiveTab('ocr')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'ocr'
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          OCR 결과 ({ocrResults.length})
        </button>
      </div>

      {/* 이미지 탭 */}
      {activeTab === 'images' && (
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {images.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <div className="text-4xl mb-2">📷</div>
              <p>캡처된 이미지가 없습니다.</p>
              <p className="text-sm mt-1">화면을 캡처하거나 이미지를 업로드하세요.</p>
            </div>
          ) : (
            images.map((img) => (
              <div key={img.id} className="bg-gray-900 rounded-lg p-3 border border-gray-700">
                <div className="flex items-start gap-3">
                  {img.preview && (
                    <img
                      src={img.preview}
                      alt={img.filename}
                      className="w-24 h-24 object-cover rounded-md"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200 truncate">
                      {img.filename}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(img.timestamp).toLocaleString('ko-KR')}
                    </p>
                    {img.detections && img.detections.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {img.detections.map((det, i) => (
                          <span
                            key={i}
                            className="inline-block bg-blue-900/50 text-blue-300 text-xs px-2 py-0.5 rounded-full"
                          >
                            {det.label} ({(det.confidence * 100).toFixed(1)}%)
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* OCR 결과 탭 */}
      {activeTab === 'ocr' && (
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {ocrResults.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <div className="text-4xl mb-2">🔍</div>
              <p>OCR 결과가 없습니다.</p>
              <p className="text-sm mt-1">이미지를 분석하면 결과가 표시됩니다.</p>
            </div>
          ) : (
            ocrResults.map((result, index) => (
              <div key={index} className="bg-gray-900 rounded-lg p-3 border border-gray-700">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-xs text-gray-500">#{ocrResults.length - index}</span>
                  <span className="text-xs text-gray-500">
                    신뢰도: {(result.confidence * 100).toFixed(1)}%
                  </span>
                </div>
                <p className="text-sm text-gray-200">{result.text}</p>
                {result.bbox && (
                  <p className="text-xs text-gray-600 mt-1">
                    영역: [{result.bbox.join(', ')}]
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

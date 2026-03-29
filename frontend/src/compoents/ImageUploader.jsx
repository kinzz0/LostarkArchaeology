import { useState, useRef } from 'react'
import { uploadImage } from '../services/api'

export default function ImageUploader({ onUpload, onOcrResult, onStatusChange }) {
  const [isDragging, setIsDragging] = useState(false)
  const [preview, setPreview] = useState(null)
  const fileInputRef = useRef(null)

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      onStatusChange({ message: '이미지 파일만 업로드 가능합니다.', type: 'error' })
      return
    }

    // 미리보기 생성
    const reader = new FileReader()
    reader.onload = (e) => setPreview(e.target.result)
    reader.readAsDataURL(file)

    onStatusChange({ message: '이미지 업로드 중...', type: 'loading' })

    try {
      const result = await uploadImage(file)
      onUpload({
        id: Date.now(),
        filename: file.name,
        preview: URL.createObjectURL(file),
        timestamp: new Date().toISOString(),
      })
      if (result.ocr_data) {
        onOcrResult(result.ocr_data)
      }
      onStatusChange({ message: '업로드 및 분석 완료!', type: 'success' })
    } catch (error) {
      onStatusChange({ message: `업로드 실패: ${error.message}`, type: 'error' })
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => setIsDragging(false)

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    handleFile(file)
  }

  const handleClick = () => fileInputRef.current?.click()

  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (file) handleFile(file)
  }

  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <h2 className="text-lg font-semibold mb-4 text-blue-300">이미지 업로드</h2>

      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all
          ${isDragging
            ? 'border-blue-400 bg-blue-900/20'
            : 'border-gray-600 hover:border-gray-500 hover:bg-gray-700/50'
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        {preview ? (
          <img src={preview} alt="미리보기" className="max-h-48 mx-auto rounded-lg" />
        ) : (
          <div className="space-y-2">
            <div className="text-4xl">📁</div>
            <p className="text-gray-400">
              클릭하거나 이미지를 드래그하여 업로드
            </p>
            <p className="text-xs text-gray-500">
              PNG, JPG, BMP 지원
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

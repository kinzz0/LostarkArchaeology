import React, { useRef, useEffect, useState } from 'react';
import Tesseract from 'tesseract.js';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL; 

function App() {
  const videoRef = useRef(null);
  const chatCanvasRef = useRef(null);
  const playerCanvasRef = useRef(null);
  const [status, setStatus] = useState("대기 중");
  const [logs, setLogs] = useState([]);

  const startCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      videoRef.current.srcObject = stream;
      setStatus("분석 중...");
      
      // 1.5초마다 분석 루프 실행
      setInterval(analyzeFrames, 1500);
    } catch (err) {
      console.error("화면 공유 실패:", err);
    }
  };

  const analyzeFrames = async () => {
    const video = videoRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

    // --- 영역별 캡처 ---
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // 1. 캐릭터 주변 (중앙)
    const ctxP = playerCanvasRef.current.getContext('2d');
    ctxP.drawImage(video, vw/2 - 150, vh/2 - 100, 300, 200, 0, 0, 300, 200);

    // 2. 채팅창 (좌측 하단) - 로아 기본 위치 기준
    const ctxC = chatCanvasRef.current.getContext('2d');
    ctxC.filter = 'contrast(150%) grayscale(100%)'; // 인식률 향상 전처리
    ctxC.drawImage(video, vw * 0.02, vh * 0.7, 400, 200, 0, 0, 400, 200);

    // --- OCR 실행 (채팅창 문구 추출) ---
    const imageData = chatCanvasRef.current.toDataURL('image/png');
    const { data: { text } } = await Tesseract.recognize(imageData, 'kor+eng');

    // 획득 패턴 필터링 (예: "유물", "나무", "x" 포함 시)
    if (text.includes('x') || text.includes('획득')) {
      const cleanedText = text.replace(/\n/g, " ");
      sendToServer(cleanedText);
    }
  };

  const sendToServer = async (text) => {
    try {
      const response = await axios.post(`${API_URL}/api/collect`, {
        raw_text: text,
        timestamp: new Date().toISOString()
      });
      setLogs(prev => [response.data.received, ...prev].slice(0, 10));
    } catch (err) {
      console.error("서버 전송 실패:", err);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>LoA Life Analytics</h1>
      <button onClick={startCapture} style={{ padding: '10px 20px', fontSize: '16px' }}>화면 공유 시작</button>
      <p>상태: {status}</p>

      <div style={{ display: 'flex', gap: '10px' }}>
        <video ref={videoRef} autoPlay style={{ width: '300px', border: '1px solid #ccc' }} />
        <canvas ref={playerCanvasRef} width="300" height="200" style={{ border: '2px solid green' }} />
        <canvas ref={chatCanvasRef} width="400" height="200" style={{ border: '2px solid blue' }} />
      </div>

      <h3>최근 획득 로그 (서버 전송 결과)</h3>
      <ul>{logs.map((log, i) => <li key={i}>{log}</li>)}</ul>
    </div>
  );
}

export default App;
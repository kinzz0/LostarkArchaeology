from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import re
import os

origins = os.getenv("CORS_ORIGINS")

app = FastAPI()

# 1. CORS 설정 
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. 데이터 모델 정의
class LifeLog(BaseModel):
    raw_text: str
    timestamp: str

# 3. 중복 방지를 위한 최근 임시 저장소 (메모리)
last_captured = {
    "text": "",
    "time": datetime.min
}

@app.post("/api/collect")
async def collect_data(log: LifeLog):
    global last_captured
    
    # [데이터 정제] OCR 텍스트에서 아이템명과 개수만 추출 시도 (예: "오래된 유물 x15")
    # 정규표현식을 사용해 '아이템명'과 'x숫자'를 찾습니다.
    match = re.search(r"([가-힣\s]+)\s?x\s?(\d+)", log.raw_text)
    
    if not match:
        return {"status": "ignored", "reason": "No pattern matched"}

    item_name = match.group(1).strip()
    amount = int(match.group(2))
    current_time = datetime.now()

    # [중복 제거 로직] 2초 이내에 동일한 아이템과 개수가 들어오면 무시
    time_diff = (current_time - last_captured["time"]).total_seconds()
    if item_name == last_captured["text"] and time_diff < 2.0:
        return {"status": "duplicate", "message": "Prevented double count"}

    # 상태 업데이트
    last_captured = {"text": item_name, "time": current_time}

    # [결과 출력] 여기에 나중에 DB 저장 코드를 넣으면 됩니다.
    print(f"[{current_time.strftime('%H:%M:%S')}] 획득: {item_name} ({amount}개)")
    
    return {
        "status": "success",
        "received": f"{item_name} x{amount}",
        "time": current_time.isoformat()
    }

@app.get("/")
def health_check():
    return {"status": "ok", "message": "LoA Backend is running"}
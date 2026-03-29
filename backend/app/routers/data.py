from fastapi import APIRouter, Query
from pathlib import Path
from datetime import datetime

from app.config import RAW_IMAGE_DIR, LABEL_DIR

router = APIRouter()


@router.get("/data")
async def get_collected_data(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
):
    """수집된 데이터 목록을 반환합니다."""

    # 이미지 파일 목록 가져오기
    image_files = sorted(
        RAW_IMAGE_DIR.glob("*"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )

    total = len(image_files)
    start = (page - 1) * limit
    end = start + limit
    page_files = image_files[start:end]

    items = []
    for img_path in page_files:
        label_path = LABEL_DIR / f"{img_path.stem}.txt"
        items.append({
            "filename": img_path.name,
            "image_url": f"/static/images/raw/{img_path.name}",
            "has_label": label_path.exists(),
            "size_bytes": img_path.stat().st_size,
            "created_at": datetime.fromtimestamp(img_path.stat().st_ctime).isoformat(),
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit if total > 0 else 0,
    }


@router.get("/data/stats")
async def get_data_stats():
    """수집 데이터 통계를 반환합니다."""

    image_count = len(list(RAW_IMAGE_DIR.glob("*")))
    label_count = len(list(LABEL_DIR.glob("*.txt")))

    total_size = sum(f.stat().st_size for f in RAW_IMAGE_DIR.glob("*"))

    return {
        "total_images": image_count,
        "labeled_images": label_count,
        "unlabeled_images": image_count - label_count,
        "total_size_mb": round(total_size / (1024 * 1024), 2),
    }

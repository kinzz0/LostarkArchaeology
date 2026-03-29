"""
OpenCV 기반 이미지 전처리 모듈
게임 화면의 텍스트 인식률을 높이기 위한 전처리 파이프라인
"""
import cv2
import numpy as np
from pathlib import Path


def preprocess_for_ocr(image_path: str) -> np.ndarray:
    """OCR 인식률 향상을 위한 이미지 전처리 파이프라인"""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"이미지를 읽을 수 없습니다: {image_path}")

    # 1. 그레이스케일 변환
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 2. 노이즈 제거 (가우시안 블러)
    denoised = cv2.GaussianBlur(gray, (3, 3), 0)

    # 3. 대비 향상 (CLAHE)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)

    # 4. 이진화 (Otsu's method)
    _, binary = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    return binary

def preprocess_gauge_crop(crop_bgr: np.ndarray) -> np.ndarray:
    """
    게이지 숫자 OCR 인식률을 위한 전처리.
    - 초록 계열(UI 요소)을 검은색으로 눌러 숫자 대비를 높임
    - 그레이스케일 → CLAHE 대비 → 3채널 복원
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return crop_bgr

    # 1) 초록 계열을 마스킹해 검은색으로 치환
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    # 사용자 제공 샘플 RGB(61,136,78) ~ (66,154,87) 기준으로 좁힌 녹색 범위
    # OpenCV HSV(RGB->HSV) 대략 [67, 141, 136] ~ [67, 146, 154]
    lower_green = np.array([61, 110, 110], dtype=np.uint8)
    upper_green = np.array([73, 185, 190], dtype=np.uint8)
    green_mask = cv2.inRange(hsv, lower_green, upper_green)
    bgr_no_green = crop_bgr.copy()
    bgr_no_green[green_mask > 0] = (0, 0, 0)

    # 2) 숫자 대비 강화
    gray = cv2.cvtColor(bgr_no_green, cv2.COLOR_BGR2GRAY)
    denoised = cv2.GaussianBlur(gray, (3, 3), 0)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


def crop_obb_region(image_path: str, bbox_obb: list) -> np.ndarray:
    """OBB 4꼭짓점 [x1,y1,x2,y2,x3,y3,x4,y4]를 TL,TR,BR,BL 순으로 재정렬 후 직사각형으로 crop."""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"이미지를 읽을 수 없습니다: {image_path}")
    pts = np.array(bbox_obb, dtype=np.float32).reshape(4, 2)

    # 4점을 y 정렬 후 위쪽 2개 중 왼/오, 아래쪽 2개 중 왼/오 → TL, TR, BR, BL 순서로 고정
    by_y = pts[np.argsort(pts[:, 1])]
    top_two = by_y[:2][np.argsort(by_y[:2, 0])]
    bottom_two = by_y[2:][np.argsort(by_y[2:, 0])]
    top_left = top_two[0]
    top_right = top_two[1]
    bottom_left = bottom_two[0]
    bottom_right = bottom_two[1]
    pts_ordered = np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)

    out_w = int(max(
        np.linalg.norm(pts_ordered[1] - pts_ordered[0]),
        np.linalg.norm(pts_ordered[2] - pts_ordered[3]),
    ))
    out_h = int(max(
        np.linalg.norm(pts_ordered[3] - pts_ordered[0]),
        np.linalg.norm(pts_ordered[2] - pts_ordered[1]),
    ))
    out_w, out_h = max(1, out_w), max(1, out_h)
    dst = np.array(
        [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
        dtype=np.float32,
    )
    M = cv2.getPerspectiveTransform(pts_ordered, dst)
    cropped = cv2.warpPerspective(img, M, (out_w, out_h))
    return cropped
    
def preprocess_for_detection(image_path: str) -> np.ndarray:
    """객체 탐지를 위한 이미지 전처리"""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"이미지를 읽을 수 없습니다: {image_path}")

    # 리사이즈 (YOLO 입력 크기)
    resized = cv2.resize(img, (640, 640))

    return resized


def crop_region(image_path: str, bbox: list) -> np.ndarray:
    """이미지에서 특정 영역을 잘라냄"""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"이미지를 읽을 수 없습니다: {image_path}")

    x1, y1, x2, y2 = bbox
    cropped = img[y1:y2, x1:x2]
    return cropped



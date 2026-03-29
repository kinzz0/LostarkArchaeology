/** 백엔드 `app.config.DETECTION_CLASSES` / `CONFIDENCE_THRESHOLDS` 와 동일 */

export const DETECTION_CLASS_NAMES = [
  "common",
  "uncommon",
  "normal",
  "chest",
  "mini",
  "gauge",
  "chat",
  "skill_on",
  "skill_off",
  "skill_popup",
  "common_item",
  "uncommon_item",
  "rare_item",
  "double_potion",
  "action_gauge",
]

export const CONFIDENCE_THRESHOLDS = {
  common: 0.7,
  uncommon: 0.7,
  normal: 0.6,
  chest: 0.5,
  mini: 0.8,
  gauge: 0.8,
  chat: 0.9,
  skill_on: 0.9,
  skill_off: 0.9,
  skill_popup: 0.9,
  common_item: 0.75,
  uncommon_item: 0.75,
  rare_item: 0.75,
  double_potion: 0.8,
  action_gauge: 0.8,
}

export function labelForClassId(classId) {
  const id = Math.floor(Number(classId))
  if (id >= 0 && id < DETECTION_CLASS_NAMES.length) return DETECTION_CLASS_NAMES[id]
  return `class_${id}`
}

export function minConfidenceForLabel(label, fallback = 0.5) {
  const v = CONFIDENCE_THRESHOLDS[label]
  return typeof v === "number" ? v : fallback
}

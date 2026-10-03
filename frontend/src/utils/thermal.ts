/**
 * 热工计算工具
 * - 退火曲线段时长换算（升温 / 保温 / 缓冷）
 * - 炉次组炉：曲线匹配 / 时间对齐 / 装载容量封顶 / 窑位组分配与冲突判重
 * - 温度单位换算（℃ ↔ ℉）
 * - 工艺温度区间与设计尺寸校验
 */
import type { Anneal, CurveSeg } from '../types/anneal'
import type { Craft } from '../types/piece'

/** 保留 1 位小数 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 保留 2 位小数 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 摄氏度 → 华氏度 */
export function cToF(c: number): number {
  return round1((c * 9) / 5 + 32)
}

/** 华氏度 → 摄氏度 */
export function fToC(f: number): number {
  return round1(((f - 32) * 5) / 9)
}

/** 退火曲线段参数：起止温度与速率 */
export interface CurveSegment {
  seg: CurveSeg
  startC: number
  endC: number
  /** 升降温速率（℃/小时）；保温段为 0 */
  rateCPerHour: number
  /** 保温段的基准保温时长（小时，按 5mm 壁厚计） */
  holdHoursPer5mm: number
  hint: string
}

/** 退火曲线定义（钠钙玻璃常规退火区间） */
export const ANNEAL_CURVE: Record<CurveSeg, CurveSegment> = {
  升温: {
    seg: '升温',
    startC: 20,
    endC: 560,
    rateCPerHour: 120,
    holdHoursPer5mm: 0,
    hint: '从室温以 120 ℃/h 缓慢升温至 560 ℃ 退火点，避免热冲击。',
  },
  保温: {
    seg: '保温',
    startC: 560,
    endC: 560,
    rateCPerHour: 0,
    holdHoursPer5mm: 1.2,
    hint: '在 560 ℃ 退火点保温，每 5 mm 壁厚保温 1.2 小时以消除内应力。',
  },
  缓冷: {
    seg: '缓冷',
    startC: 560,
    endC: 60,
    rateCPerHour: 40,
    holdHoursPer5mm: 0,
    hint: '以 40 ℃/h 缓慢降温至 60 ℃ 以下再出窑，快速降温会造成裂纹。',
  },
}

/**
 * 曲线段时长换算（小时）
 * 升温 / 缓冷按温差与速率换算；保温按壁厚换算（每 5 mm 保温 1.2 小时）。
 */
export function segmentHours(seg: CurveSeg, wallThicknessMm: number): number {
  const curve = ANNEAL_CURVE[seg]
  if (seg === '保温') {
    const thickness = Math.max(1, wallThicknessMm)
    return round1((thickness / 5) * curve.holdHoursPer5mm)
  }
  const delta = Math.abs(curve.endC - curve.startC)
  if (curve.rateCPerHour <= 0) return 0
  return round1(delta / curve.rateCPerHour)
}

/** 一件作品的完整退火时长（三段合计，小时） */
export function totalAnnealHours(wallThicknessMm: number): number {
  return round1(
    segmentHours('升温', wallThicknessMm) + segmentHours('保温', wallThicknessMm) + segmentHours('缓冷', wallThicknessMm),
  )
}

/** 把小时数格式化为「x 小时 y 分钟」 */
export function formatHours(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} 分钟`
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

/** 解析 ISO / datetime-local 字符串为时间戳；非法返回 NaN */
export function parseAt(value: string): number {
  if (value === '') return Number.NaN
  const stamp = new Date(value).getTime()
  return Number.isNaN(stamp) ? Number.NaN : stamp
}

/** 时间戳转 datetime-local 字符串（YYYY-MM-DDTHH:mm），秒 / 毫秒向下取整到分钟 */
export function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

/** 两个时间窗是否重叠（端点相接不算重叠：前一炉出炉即可装入下一炉） */
export function windowsOverlap(a: [number, number], b: [number, number]): boolean {
  if (Number.isNaN(a[0]) || Number.isNaN(b[0])) return false
  return a[0] < b[1] && b[0] < a[1]
}

/* ============================ 炉次组炉排产 ============================ */

/** 组炉判定需要的最小退火记录字段 */
export type ScheduleAnneal = Pick<Anneal, 'pieceId' | 'state' | 'curveSeg' | 'inAt'>

/** 已建炉次排产所需字段（用于窑位 / 时间窗判重；已出炉炉次已释放窑位，不参与判重） */
export interface CommittedBatch {
  id: string
  kilnCode: string
  state: Anneal['state']
  inAt: string
  outAt: string
  curveSeg: CurveSeg
  slots: string[]
  /** 炉内最厚件壁厚（mm），用于估算未出炉炉次的预计出炉时间；缺省按 4 mm */
  maxWallMm?: number
}

export interface BatchPlanResult {
  /** 是否排得下：存在候选且容量不超限、窑位也够（无作品被退回下一炉） */
  ok: boolean
  /** 候选作品 pieceId 列表（曲线相同且时间能对上） */
  candidateIds: string[]
  /** 实际装入本炉的 pieceId 列表（受容量 / 窑位限制截断后） */
  loadedIds: string[]
  /** 排不下、退回队列等下一炉的 pieceId 列表 */
  queuedIds: string[]
  /** 建议分配的窑位组（与 loadedIds 一一对应） */
  slots: string[]
  message: string
}

/** 一炉的退火时长：同炉作品壁厚可能不同，整炉按炉内最厚件的完整退火时长烧 */
export function batchHours(wallThicknessList: number[]): number {
  const maxThickness = wallThicknessList.length > 0 ? Math.max(...wallThicknessList) : 4
  return totalAnnealHours(maxThickness)
}

/** 已建炉次的时间窗：[入窑, 出炉]；未出炉按入窑 + 炉内最厚件理论时长估算 */
export function committedWindowOf(batch: CommittedBatch): [number, number] {
  const start = parseAt(batch.inAt)
  if (Number.isNaN(start)) return [Number.NaN, Number.NaN]
  const end = parseAt(batch.outAt)
  if (!Number.isNaN(end) && end > start) return [start, end]
  return [start, start + batchHours([batch.maxWallMm ?? 4]) * 3600 * 1000]
}

/**
 * 判断某件待入窑作品能否并入指定炉次：
 * 曲线必须相同，且其期望（最早可）入窑时间不晚于炉次计划入窑时间（时间能对上）。
 */
export function canJoinBatch(
  waiting: ScheduleAnneal,
  plan: { curveSeg: CurveSeg; inAt: string },
): boolean {
  if (waiting.state !== '待入窑' || waiting.curveSeg !== plan.curveSeg) return false
  const readyAt = parseAt(waiting.inAt)
  const startAt = parseAt(plan.inAt)
  if (Number.isNaN(readyAt) || Number.isNaN(startAt)) return false
  return readyAt <= startAt
}

/** 从待入窑队列里挑出能并入指定炉次的作品（保持入队顺序） */
export function selectBatchCandidates(waiting: ScheduleAnneal[], plan: { curveSeg: CurveSeg; inAt: string }): ScheduleAnneal[] {
  return waiting.filter((row) => canJoinBatch(row, plan))
}

/** 下一炉最早可开炉时间：所有冲突在烧炉次预计出炉时间的最大值（端点相接即可开炉） */
export function suggestNextBatchStart(blocking: CommittedBatch[]): string | null {
  const ends = blocking.map((row) => committedWindowOf(row)[1]).filter((value) => !Number.isNaN(value))
  if (ends.length === 0) return null
  return toLocalInput(new Date(Math.max(...ends)))
}

/**
 * 为新一炉做组炉排产：
 * - 装载容量按件数封顶，超出容量的候选退回队列等下一炉；
 * - 窑位不得与同窑、尚未出炉且时间窗重叠的炉次冲突，绝不挤占在烧炉次；
 * - 窑位不够时只装分得下的部分，其余排队，并提示下一炉可开炉时间。
 */
export function planBatch(
  kilnCode: string,
  capacity: number,
  curveSeg: CurveSeg,
  inAt: string,
  waiting: ScheduleAnneal[],
  committed: CommittedBatch[],
  wallThicknessOf: (pieceId: string) => number,
  excludeBatchId = '',
): BatchPlanResult {
  const candidates = selectBatchCandidates(waiting, { curveSeg, inAt })
  const candidateIds = candidates.map((row) => row.pieceId)
  const capacityLimit = Math.max(1, Math.floor(capacity))
  const capped = candidates.slice(0, capacityLimit)
  const cappedIds = capped.map((row) => row.pieceId)

  const startMs = parseAt(inAt)
  const hours = batchHours(capped.map((row) => wallThicknessOf(row.pieceId)))
  const window: [number, number] = [startMs, Number.isNaN(startMs) ? Number.NaN : startMs + hours * 3600 * 1000]

  // 同窑、尚未出炉、时间窗重叠的炉次占用的窑位一律不可用（不挤掉已经入窑的那炉）
  const blocking = committed.filter(
    (row) =>
      row.id !== excludeBatchId &&
      row.kilnCode === kilnCode &&
      row.state !== '已出炉' &&
      windowsOverlap(window, committedWindowOf(row)),
  )
  const blockedSlots = new Set<string>()
  blocking.forEach((row) => row.slots.forEach((slot) => blockedSlots.add(slot)))

  const freeSlots = kilnSlots(kilnCode).filter((slot) => !blockedSlots.has(slot))
  const loaded = capped.filter((_, index) => index < freeSlots.length)
  const loadedIds = loaded.map((row) => row.pieceId)
  const slots = loadedIds.map((_, index) => freeSlots[index])

  const overflowByCapacity = candidateIds.length > capacityLimit
  const shortBySlots = cappedIds.length > loadedIds.length
  const ok = candidateIds.length > 0 && !overflowByCapacity && !shortBySlots

  let message: string
  if (candidateIds.length === 0) {
    message = `该时段没有曲线为「${curveSeg}」且时间能对上的待入窑作品，空窑不必照烧。`
  } else if (overflowByCapacity) {
    message = `本炉容量 ${capacityLimit} 件封顶，候选 ${candidateIds.length} 件；先装 ${loadedIds.length} 件，其余 ${
      candidateIds.length - loadedIds.length
    } 件排队等下一炉。`
  } else if (shortBySlots) {
    message = `窑位被在烧炉次占用，本炉只能装 ${loadedIds.length}/${cappedIds.length} 件；建议下一炉 ${
      suggestNextBatchStart(blocking) ?? '稍后'
    } 开炉，剩余作品先排队，不挤占已入窑炉次。`
  } else {
    message = `可并炉 ${loadedIds.length} 件，共用窑位 ${slots.join('、')}。`
  }

  return {
    ok,
    candidateIds,
    loadedIds,
    queuedIds: candidateIds.filter((id) => !loadedIds.includes(id)),
    slots,
    message,
  }
}

/** 生成某台退火窑的窑位列表（3×3 共 9 格） */
export function kilnSlots(kilnCode: string): string[] {
  const rows = ['A', 'B', 'C']
  const cols = [1, 2, 3]
  const list: string[] = []
  rows.forEach((row) => {
    cols.forEach((col) => {
      list.push(`${kilnCode}-${row}${col}`)
    })
  })
  return list
}

/** 工艺对应的适宜成型温度区间（℃） */
export const CRAFT_TEMP_RANGE: Record<Craft, { min: number; max: number; hint: string }> = {
  吹制: { min: 900, max: 1200, hint: '吹制需在 900–1200 ℃ 的高温区间快速完成，温度过低玻璃会硬化。' },
  铸造: { min: 800, max: 1150, hint: '铸造（窑铸）在 800–1150 ℃ 区间浇注，随后随窑缓冷。' },
  热塑: { min: 700, max: 1000, hint: '热塑（灯工）在 700–1000 ℃ 区间塑形，注意反复回火避免炸裂。' },
}

export interface TempCheck {
  ok: boolean
  message: string
}

/** 工序温度合理性校验：不得超窑炉上限，且应落在工艺区间附近 */
export function checkStepTemp(tempC: number, maxTempC: number, craft: Craft): TempCheck {
  const range = CRAFT_TEMP_RANGE[craft]
  if (tempC > maxTempC) {
    return { ok: false, message: `工序温度 ${tempC} ℃ 超过所选窑炉上限 ${maxTempC} ℃，无法执行。` }
  }
  if (tempC < range.min - 120 || tempC > range.max + 120) {
    return {
      ok: false,
      message: `工序温度 ${tempC} ℃ 明显偏离「${craft}」的适宜区间 ${range.min}–${range.max} ℃。${range.hint}`,
    }
  }
  return { ok: true, message: `工序温度 ${tempC} ℃ 落在「${craft}」的合理区间内。` }
}

/** 设计尺寸比例校验：壁厚与高度需匹配 */
export function checkDesign(heightMm: number, wallThicknessMm: number): TempCheck {
  if (heightMm <= 0) return { ok: false, message: '设计高度必须大于 0。' }
  if (wallThicknessMm <= 0) return { ok: false, message: '壁厚必须大于 0。' }
  if (wallThicknessMm >= heightMm / 8) {
    return { ok: false, message: `壁厚 ${wallThicknessMm} mm 相对设计高度 ${heightMm} mm 偏厚，成型与退火难度都会显著上升。` }
  }
  if (wallThicknessMm < 1.5) {
    return { ok: false, message: `壁厚 ${wallThicknessMm} mm 过薄（建议 ≥ 1.5 mm），退火时极易变形。` }
  }
  return { ok: true, message: `设计尺寸比例合理：高 ${heightMm} mm / 壁厚 ${wallThicknessMm} mm。` }
}

/** 料液剩余量阈值（kg），低于该值提示补料 */
export const LOW_REMAIN_KG = 60

/** 是否低于补料阈值 */
export function isLowRemain(remainKg: number): boolean {
  return remainKg < LOW_REMAIN_KG
}

/**
 * 炉次排产算法（纯函数，便于测试与复用）
 * 规则：
 * - 只处理「待入窑且未挂炉次」的退火排队记录；
 * - 同一台退火窑、曲线指纹相同（壁厚相同）的作品才允许并炉；
 * - 期望入窑时间对得上（差值不超过 ALIGN_TOLERANCE_MS）才凑成一炉；
 * - 每炉按退火窑装载容量（件数）封顶，排不下的切到下一炉；
 * - 新炉时间窗与该窑已编排 / 在烧炉次重叠时，本次先不排（留队列等下一炉），
 *   绝不能挤掉已经入窑的那炉。
 */
import type { Anneal } from '../types/anneal'
import type { Furnace } from '../types/furnace'
import type { Piece } from '../types/piece'
import type { KilnRun } from '../types/run'
import {
  DEFAULT_KILN_CAPACITY,
  curveKeyOf,
  plannedOutAt,
  runWindow,
  timesAlign,
  windowsOverlap,
} from './thermal'

/** 一个待落库的排产炉次（分组结果） */
export interface PlannedRunGroup {
  furnaceId: string
  kilnCode: string
  curveKey: string
  wallThicknessMm: number
  /** 本组排队记录（按期望入窑时间升序） */
  anneals: Anneal[]
  /** 本组计划入窑时间（取最早的期望入窑时间） */
  plannedInAt: string
  plannedOutAt: string
  capacity: number
}

export interface PlanResult {
  groups: PlannedRunGroup[]
  /** 本次排不进、继续留在队列里的退火记录 id（撞炉或退火窑缺失） */
  blockedAnnealIds: string[]
}

function capacityOf(furnace: Furnace | undefined): number {
  if (!furnace || !Number.isFinite(furnace.capacity) || furnace.capacity <= 0) return DEFAULT_KILN_CAPACITY
  return Math.floor(furnace.capacity)
}

/**
 * 把待入窑队列编排成炉次分组。
 * @param queued 待入窑且未挂炉次的退火记录
 * @param furnaces 全部窑炉（取退火窑容量）
 * @param pieces 作品（取壁厚算曲线指纹）
 * @param existingRuns 已存在的炉次（避免时间窗撞炉）
 */
export function planRunGroups(
  queued: Anneal[],
  furnaces: Furnace[],
  pieces: Piece[],
  existingRuns: KilnRun[],
): PlanResult {
  const thicknessOf = (pieceId: string): number =>
    pieces.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4
  const furnaceOfCode = (code: string): Furnace | undefined =>
    furnaces.find((row) => row.type === '退火窑' && row.code === code)

  // 已编排 / 在烧的炉次仍占着窑；已出炉的历史炉不再挡后续排产
  const blocking = existingRuns.filter((run) => run.state !== '已出炉')

  const groups: PlannedRunGroup[] = []
  const blockedAnnealIds: string[] = []

  const sorted = [...queued].sort((a, b) => a.expectedInAt.localeCompare(b.expectedInAt))

  for (const anneal of sorted) {
    const furnace = furnaceOfCode(anneal.kilnCode)
    if (furnace === undefined) {
      blockedAnnealIds.push(anneal.id)
      continue
    }
    const thickness = thicknessOf(anneal.pieceId)
    const key = curveKeyOf(thickness)
    const capacity = capacityOf(furnace)

    const fit = groups.find(
      (group) =>
        group.furnaceId === furnace.id &&
        group.curveKey === key &&
        group.anneals.length < capacity &&
        timesAlign(group.plannedInAt, anneal.expectedInAt),
    )

    // 能并入已建炉组：炉组窗口在建组时已校验过撞炉，直接加件（按入窑时间升序，锚点不会前移）
    if (fit !== undefined) {
      fit.anneals.push(anneal)
      continue
    }

    // 并入不了：尝试开新炉。同一台窑同一时间只能烧一条曲线，
    // 新炉窗口与该窑在烧 / 已编排炉窗重叠时本次不排，留队列等下一炉（不挤已入窑的炉）。
    const inAt = anneal.expectedInAt
    const outAt = plannedOutAt(inAt, thickness)
    const window: [number, number] = [
      Number.isNaN(Date.parse(inAt)) ? Number.NaN : Date.parse(inAt),
      Number.isNaN(Date.parse(outAt)) ? Number.NaN : Date.parse(outAt),
    ]

    const collides =
      blocking.some((run) => run.furnaceId === furnace.id && windowsOverlap(runWindow(run), window)) ||
      groups.some(
        (group) =>
          group.furnaceId === furnace.id &&
          windowsOverlap([Date.parse(group.plannedInAt), Date.parse(group.plannedOutAt)], window),
      )

    if (collides) {
      blockedAnnealIds.push(anneal.id)
      continue
    }

    groups.push({
      furnaceId: furnace.id,
      kilnCode: furnace.code,
      curveKey: key,
      wallThicknessMm: thickness,
      anneals: [anneal],
      plannedInAt: inAt,
      plannedOutAt: outAt,
      capacity,
    })
  }

  groups.sort((a, b) => a.plannedInAt.localeCompare(b.plannedInAt) || a.kilnCode.localeCompare(b.kilnCode))
  return { groups, blockedAnnealIds }
}

/** 在时间窗重叠的炉次里找出已被占用的窑位 */
export function usedSlotsInWindow(runs: KilnRun[], window: [number, number]): Set<string> {
  const used = new Set<string>()
  runs.forEach((run) => {
    if (run.state === '已出炉') return
    if (windowsOverlap(runWindow(run), window)) {
      run.slots.forEach((slot) => used.add(slot))
    }
  })
  return used
}

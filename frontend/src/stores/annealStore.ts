/**
 * 退火炉次与排队状态管理（Pinia）
 * - 待入窑作品先进队列（只定目标退火窑与期望入窑时间）；
 * - 窑务排产员按炉次编排：曲线相同（壁厚相同）、时间对得上的并成一炉，共用一组窑位，
 *   装载容量按件数封顶，排不下 / 撞炉窗口的先排队等下一炉，不挤已入窑的炉；
 * - 退火值守按炉次记实际入窑与出炉，计划与实际件数对不上时在炉次 dutyNote 上说清，两边各留一份。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState } from '../types/anneal'
import type { KilnRun, RunState } from '../types/run'
import type { Furnace } from '../types/furnace'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  checkinRun,
  closeRun,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
  scheduleRunQueue,
} from '../utils/db'
import {
  DEFAULT_KILN_CAPACITY,
  curveKeyOf,
  formatHours,
  kilnSlots,
  plannedOutAt,
  timesAlign,
  totalAnnealHours,
} from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 退火页筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  kilnCode: string | 'all'
}

/** 炉次展示行：炉次 + 当前挂在炉上的退火记录 + 容量 */
export interface RunRow {
  run: KilnRun
  members: Anneal[]
  capacity: number
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const runs = ref<KilnRun[]>([])
  const pieces = ref<Piece[]>([])
  const furnaces = ref<Furnace[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const annealingFurnaces = computed<Furnace[]>(() =>
    furnaces.value
      .filter((row) => row.type === '退火窑')
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
  )

  const kilnCodes = computed<string[]>(() => annealingFurnaces.value.map((row) => row.code))

  const pieceById = computed<Record<string, Piece>>(() =>
    Object.fromEntries(pieces.value.map((row) => [row.id, row])),
  )

  function pieceName(pieceId: string): string {
    const piece = pieceById.value[pieceId]
    return piece === undefined ? '（作品已删除）' : piece.name
  }

  const wallThicknessOf = (pieceId: string): number => pieceById.value[pieceId]?.wallThicknessMm ?? 4

  function capacityOfCode(kilnCode: string): number {
    const furnace = annealingFurnaces.value.find((row) => row.code === kilnCode)
    if (!furnace || !Number.isFinite(furnace.capacity) || furnace.capacity <= 0) return DEFAULT_KILN_CAPACITY
    return furnace.capacity
  }

  /** 全部物理窑位（按退火窑容量截断） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code).slice(0, capacityOfCode(code)))
  })

  /** 待入窑队列：状态待入窑且尚未挂到炉次 */
  const queuedAnneals = computed<Anneal[]>(() =>
    anneals.value
      .filter((row) => row.state === '待入窑' && row.runId === '')
      .sort((a, b) => a.expectedInAt.localeCompare(b.expectedInAt)),
  )

  /** 按入窑时间升序的炉次（历史 + 在烧 + 待入窑） */
  const sortedRuns = computed<KilnRun[]>(() =>
    [...runs.value].sort(
      (a, b) => a.plannedInAt.localeCompare(b.plannedInAt) || a.kilnCode.localeCompare(b.kilnCode) || a.seq - b.seq,
    ),
  )

  function membersOf(run: KilnRun): Anneal[] {
    return anneals.value
      .filter((row) => row.runId === run.id)
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot))
  }

  const runRows = computed<RunRow[]>(() =>
    sortedRuns.value.map((run) => ({ run, members: membersOf(run), capacity: capacityOfCode(run.kilnCode) })),
  )

  /** 炉次占用的窑位（未出炉的炉次视为占用） */
  const occupiedSlots = computed<Set<string>>(() => {
    const set = new Set<string>()
    runs.value.forEach((run) => {
      if (run.state !== '已出炉') run.slots.forEach((slot) => set.add(slot))
    })
    return set
  })

  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlots.value.size / total) * 1000) / 10
  })

  /** 队列里的作品是否已经有一条未完成的退火（一件同时只能排一条队） */
  function activeAnnealOfPiece(pieceId: string, excludeId = ''): Anneal | undefined {
    return anneals.value.find((row) => row.pieceId === pieceId && row.id !== excludeId && row.state !== '已出炉')
  }

  /** 排队预检：同窑是否已有曲线相同、时间对得上且还装得下的待入窑炉 */
  interface QueuePreview {
    curveKey: string
    plannedOutAt: string
    matchRuns: KilnRun[]
    overCapacity: KilnRun[]
  }

  function previewQueue(pieceId: string, kilnCode: string, expectedInAt: string): QueuePreview {
    const thickness = wallThicknessOf(pieceId)
    const key = curveKeyOf(thickness)
    const capacity = capacityOfCode(kilnCode)
    const matchRuns = runs.value.filter(
      (run) =>
        run.kilnCode === kilnCode &&
        run.state === '待入窑' &&
        run.curveKey === key &&
        timesAlign(run.plannedInAt, expectedInAt),
    )
    return {
      curveKey: key,
      plannedOutAt: plannedOutAt(expectedInAt, thickness),
      matchRuns,
      overCapacity: matchRuns.filter((run) => run.planPieceIds.length >= capacity),
    }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, runRows, pieceRows, furnaceRows] = await Promise.all([
            db.anneals.toArray(),
            db.kilnruns.toArray(),
            db.pieces.toArray(),
            db.furnaces.toArray(),
          ])
          return { annealRows, runRows, pieceRows, furnaceRows }
        }).subscribe({
          next: ({ annealRows, runRows, pieceRows, furnaceRows }) => {
            anneals.value = [...annealRows].sort((a, b) =>
              a.expectedInAt.localeCompare(b.expectedInAt),
            )
            runs.value = runRows
            pieces.value = pieceRows
            furnaces.value = furnaceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /** 作品进入退火排队（只定目标退火窑与期望入窑时间，窑位由排产分配） */
  async function enqueue(draft: AnnealDraft): Promise<Anneal | null> {
    const duplicate = activeAnnealOfPiece(draft.pieceId)
    if (duplicate !== undefined) {
      lastMessage.value = '该作品已有一条未完成的退火记录，不能重复入队；请先处理原记录。'
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnCode: draft.kilnCode,
      expectedInAt: draft.expectedInAt,
      runId: '',
      kilnSlot: '',
      curveSeg: draft.curveSeg,
      inAt: '',
      outAt: '',
      state: '待入窑',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    const preview = previewQueue(draft.pieceId, draft.kilnCode, draft.expectedInAt)
    lastMessage.value =
      preview.matchRuns.length > 0
        ? '已加入待入窑队列，与同曲线待入窑炉时间对得上，排产时可并炉'
        : '已加入待入窑队列，等待窑务排产员按炉次编排'
    return row
  }

  /** 编辑排队意向（仅未排产的待入窑记录可改） */
  async function updateQueue(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    if (existing.runId !== '' || existing.state !== '待入窑') {
      lastMessage.value = '该记录已编排入炉，不能直接修改；请在炉次上操作或退回重排。'
      return false
    }
    const duplicate = activeAnnealOfPiece(draft.pieceId, annealId)
    if (duplicate !== undefined) {
      lastMessage.value = '该作品已有一条未完成的退火记录，不能重复入队。'
      return false
    }
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnCode: draft.kilnCode,
      expectedInAt: draft.expectedInAt,
      curveSeg: draft.curveSeg,
    })
    revision.value += 1
    lastMessage.value = '排队意向已更新，等待重新排产'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 窑务排产：按炉次自动并炉，容量封顶，排不下的留队列等下一炉 */
  async function schedule(): Promise<{ created: number; blocked: number }> {
    const outcome = await scheduleRunQueue()
    revision.value += 1
    if (outcome.created.length === 0 && outcome.blocked.length === 0) {
      lastMessage.value = '待入窑队列为空，暂无需排产'
    } else {
      const pieceText = outcome.created
        .map((run) => `第 ${run.seq} 炉 ${run.planPieceIds.length} 件`)
        .join('；')
      lastMessage.value =
        `已编排 ${outcome.created.length} 炉（${pieceText}）` +
        (outcome.blocked.length > 0 ? `；另有 ${outcome.blocked.length} 件排不下，已留在队列等下一炉` : '')
    }
    return { created: outcome.created.length, blocked: outcome.blocked.length }
  }

  /** 退火值守：登记整炉实际入窑 */
  async function checkin(
    runId: string,
    actualInAt: string,
    actualPieceIds: string[],
    dutyNote: string,
  ): Promise<{ run: KilnRun; missing: number } | null> {
    const result = await checkinRun(runId, actualInAt, actualPieceIds, dutyNote)
    if (result === null) {
      lastMessage.value = '只有「待入窑」炉次可以登记入窑。'
      return null
    }
    revision.value += 1
    lastMessage.value =
      result.missingPieceIds.length > 0
        ? `已登记入窑：计划件 ${result.run.planPieceIds.length} 件，实际 ${result.run.actualPieceIds.length} 件，差异已在炉次说明，未到件退回重排`
        : `已登记整炉入窑（${result.run.actualPieceIds.length} 件）`
    return { run: result.run, missing: result.missingPieceIds.length }
  }

  /** 退火值守：登记整炉出炉 */
  async function close(
    runId: string,
    actualOutAt: string,
    actualPieceIds: string[],
    dutyNote: string,
  ): Promise<KilnRun | null> {
    const run = await closeRun(runId, actualOutAt, actualPieceIds, dutyNote)
    if (run === null) {
      lastMessage.value = '只有「退火中」炉次可以登记出炉。'
      return null
    }
    revision.value += 1
    const mismatch = run.actualPieceIds.length !== run.planPieceIds.length
    lastMessage.value = mismatch
      ? `已登记出炉：实际 ${run.actualPieceIds.length} 件，与计划 ${run.planPieceIds.length} 件不符，已在炉次说明上写清`
      : `已登记整炉出炉（${run.actualPieceIds.length} 件），作品状态已回写为「已退火」`
    return run
  }

  function durationOf(pieceId: string): { hours: number; text: string } {
    const hours = totalAnnealHours(wallThicknessOf(pieceId))
    return { hours, text: formatHours(hours) }
  }

  /** 现在是否落在炉次时间窗内（占用表高亮用） */
  function runIsActive(run: KilnRun): boolean {
    if (run.state === '已出炉') return false
    const now = Date.now()
    const start = Date.parse(run.actualInAt !== '' ? run.actualInAt : run.plannedInAt)
    const end = Date.parse(run.actualOutAt !== '' ? run.actualOutAt : run.plannedOutAt)
    return !Number.isNaN(start) && !Number.isNaN(end) && start <= now && now <= end
  }

  const runStateCounts = computed<Record<RunState, number>>(() => {
    const counts: Record<RunState, number> = { 待入窑: 0, 退火中: 0, 已出炉: 0 }
    runs.value.forEach((run) => {
      counts[run.state] += 1
    })
    return counts
  })

  return {
    anneals,
    runs,
    pieces,
    furnaces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    annealingFurnaces,
    kilnCodes,
    allSlots,
    occupancyRate,
    occupiedSlots,
    queuedAnneals,
    sortedRuns,
    runRows,
    runStateCounts,
    pieceById,
    pieceName,
    wallThicknessOf,
    capacityOfCode,
    membersOf,
    activeAnnealOfPiece,
    previewQueue,
    loadAll,
    setFilters,
    resetFilters,
    enqueue,
    updateQueue,
    deleteAnneal,
    schedule,
    checkin,
    close,
    durationOf,
    runIsActive,
  }
})

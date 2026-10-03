/**
 * 退火炉次与排队状态管理（Pinia）
 * 待入窑作品先排队；曲线相同、时间能对上的并成一炉，共用一组窑位；
 * 退火窑容量按件数封顶，排不下的先排队等下一炉，不挤占已入窑炉次；
 * 退火值守按炉次登记实际入窑 / 出炉，出炉件数对不上须在炉次上写明。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { KilnBatch, KilnBatchState } from '../types/kilnBatch'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  createKilnBatch,
  db,
  initDatabase,
  listKilnBatches,
  markBatchLoaded,
  markBatchOut,
  putAnneal,
  removeAnneal,
  removeKilnBatch,
  updateKilnBatchKeeper,
} from '../utils/db'
import {
  batchHours,
  committedWindowOf,
  formatHours,
  kilnSlots,
  planBatch,
  toLocalInput,
  totalAnnealHours,
  type BatchPlanResult,
  type CommittedBatch,
} from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行（按炉次 → 窑位展开，一格可显示占用它的炉次） */
export interface SlotOccupancy {
  kilnCode: string
  kilnSlot: string
  batchId: string
  batchSeq: number
  pieceIds: string[]
  pieceNames: string[]
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: KilnBatchState
  /** 该窑位当前是否被未出炉炉次占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const batches = ref<KilnBatch[]>([])
  const pieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const pieceById = computed<Record<string, Piece>>(() =>
    Object.fromEntries(pieces.value.map((row) => [row.id, row])),
  )

  function pieceNameOf(pieceId: string): string {
    return pieceById.value[pieceId]?.name ?? '（作品已删除）'
  }

  const wallThicknessOf = (pieceId: string): number => pieceById.value[pieceId]?.wallThicknessMm ?? 4

  /** 出现过的退火窑号（含炉次表），兜底 AN-01 */
  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    batches.value.forEach((row) => {
      if (row.kilnCode !== '') set.add(row.kilnCode)
    })
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  /** 全部窑位（按出现过的退火窑号展开，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  const batchById = computed<Record<string, KilnBatch>>(() =>
    Object.fromEntries(batches.value.map((row) => [row.id, row])),
  )

  /** 待入窑排队（尚未排进任何炉次），按登记先后 */
  const waitingQueue = computed<Anneal[]>(() =>
    anneals.value
      .filter((row) => row.state === '待入窑' && row.batchId === '')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  )

  function annealsOfBatch(batchId: string): Anneal[] {
    return anneals.value
      .filter((row) => row.batchId === batchId)
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot))
  }

  /** 炉内最厚件壁厚（用于估算未出炉炉次的预计出炉时间） */
  function maxWallOfBatch(batchId: string): number {
    const list = annealsOfBatch(batchId).map((row) => wallThicknessOf(row.pieceId))
    return list.length > 0 ? Math.max(...list) : 4
  }

  /** 供排产算法使用的已建炉次（带炉内最厚件壁厚） */
  const committedBatches = computed<CommittedBatch[]>(() =>
    batches.value.map((row) => ({
      id: row.id,
      kilnCode: row.kilnCode,
      state: row.state,
      inAt: row.inAt,
      outAt: row.outAt,
      curveSeg: row.curveSeg,
      slots: row.slots,
      maxWallMm: maxWallOfBatch(row.id),
    })),
  )

  /** 窑位占用表：按未出炉炉次把窑位展开为占用行（已出炉炉次视为释放） */
  const occupancy = computed<SlotOccupancy[]>(() => {
    const rows: SlotOccupancy[] = []
    batches.value
      .slice()
      .sort((a, b) => a.inAt.localeCompare(b.inAt) || a.seq - b.seq)
      .forEach((batch) => {
        if (batch.state === '已出炉') return
        const members = annealsOfBatch(batch.id)
        batch.slots.forEach((slot, index) => {
          const member = members[index] ?? members.find((item) => item.kilnSlot === slot)
          rows.push({
            kilnCode: batch.kilnCode,
            kilnSlot: slot,
            batchId: batch.id,
            batchSeq: batch.seq,
            pieceIds: member ? [member.pieceId] : [],
            pieceNames: member ? [pieceNameOf(member.pieceId)] : [],
            curveSeg: batch.curveSeg,
            inAt: batch.inAt,
            outAt: batch.outAt,
            state: batch.state,
            occupied: true,
          })
        })
      })
    return rows.sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  })

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  /** 退火记录列表（排队在前，其后按炉次 / 时间），供筛选表格使用 */
  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    const sorted = anneals.value
      .slice()
      .sort((a, b) => {
        const rank = (row: Anneal): number => (row.state === '待入窑' && row.batchId === '' ? 0 : 1)
        if (rank(a) !== rank(b)) return rank(a) - rank(b)
        return a.inAt.localeCompare(b.inAt) || a.createdAt.localeCompare(b.createdAt)
      })
    return sorted.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all') {
        const batch = row.batchId === '' ? undefined : batchById.value[row.batchId]
        const code = batch?.kilnCode ?? row.kilnSlot.split('-').slice(0, -1).join('-')
        if (code !== filters.kilnCode) return false
      }
      if (keyword === '') return true
      const name = pieceNameOf(row.pieceId).toLowerCase()
      const batchSeq = row.batchId === '' ? '' : `第${batchById.value[row.batchId]?.seq ?? ''}炉`
      return (
        name.includes(keyword) ||
        row.kilnSlot.toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword) ||
        batchSeq.includes(keyword)
      )
    })
  })

  /** 炉次列表（含炉内作品与占用窑位），供炉次卡片使用 */
  const batchCards = computed(() =>
    batches.value
      .slice()
      .sort((a, b) => b.inAt.localeCompare(a.inAt) || b.seq - a.seq)
      .map((batch) => {
        const members = annealsOfBatch(batch.id)
        const maxWall = members.length > 0 ? Math.max(...members.map((row) => wallThicknessOf(row.pieceId))) : 4
        const [, endEstimate] = committedWindowOf({
          id: batch.id,
          kilnCode: batch.kilnCode,
          state: batch.state,
          inAt: batch.inAt,
          outAt: batch.outAt,
          curveSeg: batch.curveSeg,
          slots: batch.slots,
          maxWallMm: maxWall,
        })
        return {
          batch,
          members,
          loadedCount: members.length,
          maxWallMm: maxWall,
          estimatedHours: batchHours([maxWall]),
          estimatedEndAt: Number.isNaN(endEstimate) ? '' : toLocalInput(new Date(endEstimate)),
        }
      }),
  )

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  /**
   * 组炉预排：给定退火窑 / 曲线 / 计划入窑时间，算出可并炉作品、容量截断与窑位组。
   * 排产页建炉弹窗据此实时提示「能装几件 / 谁要排队 / 窑位是否冲突」。
   */
  function previewPlan(kilnCode: string, capacity: number, curveSeg: CurveSeg, inAt: string): BatchPlanResult {
    return planBatch(
      kilnCode,
      capacity,
      curveSeg,
      inAt,
      waitingQueue.value,
      committedBatches.value,
      wallThicknessOf,
    )
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, batchRows, pieceRows] = await Promise.all([
            db.anneals.toArray(),
            listKilnBatches(),
            db.pieces.toArray(),
          ])
          return { annealRows, batchRows, pieceRows }
        }).subscribe({
          next: ({ annealRows, batchRows, pieceRows }) => {
            anneals.value = annealRows
            batches.value = batchRows
            pieces.value = pieceRows
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

  /* ------------------------------ 排队登记 ------------------------------ */

  /** 一件作品是否已有未出炉的退火安排（排队 / 排炉 / 退火中），避免重复排队 */
  function hasOpenAnneal(pieceId: string): boolean {
    return anneals.value.some((row) => row.pieceId === pieceId && row.state !== '已出炉')
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    if (draft.pieceId === '') {
      lastMessage.value = '请选择要排队的作品'
      return null
    }
    if (hasOpenAnneal(draft.pieceId)) {
      lastMessage.value = `「${pieceNameOf(draft.pieceId)}」已有未出炉的退火安排，无需重复排队`
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      batchId: '',
      kilnSlot: '',
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: '',
      state: '待入窑',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `「${pieceNameOf(row.pieceId)}」已进入待入窑排队（曲线「${row.curveSeg}」，期望 ${row.inAt.replace(
      'T',
      ' ',
    )} 起），等待组炉。`
    return row
  }

  /** 仅允许修改仍在排队（未排炉）记录的曲线与期望入窑时间 */
  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    if (existing.batchId !== '' || existing.state !== '待入窑') {
      lastMessage.value = '该作品已排入炉次，请通过整炉调整，不能单独改曲线 / 时间。'
      return false
    }
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      kilnSlot: '',
      outAt: '',
      state: '待入窑',
    })
    revision.value += 1
    lastMessage.value = '待入窑排队信息已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<boolean> {
    const ok = await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = ok ? '退火记录已删除' : '已入炉记录需随整炉值守处理，不能单独删除'
    return ok
  }

  /* -------------------------------- 组炉 -------------------------------- */

  interface CreateBatchPayload {
    kilnCode: string
    capacity: number
    curveSeg: CurveSeg
    inAt: string
    keeper: string
    /** 预排结果（loadedIds + slots），由 previewPlan 给出，store 内再复核一次 */
    plan: BatchPlanResult
  }

  /** 按预排结果正式开炉；返回新炉次，取消 / 排不下返回 null */
  async function createBatch(payload: CreateBatchPayload): Promise<KilnBatch | null> {
    const plan = previewPlan(payload.kilnCode, payload.capacity, payload.curveSeg, payload.inAt)
    if (plan.loadedIds.length === 0) {
      lastMessage.value = plan.message
      return null
    }
    const annealIds = plan.loadedIds
      .map((pieceId) => waitingQueue.value.find((row) => row.pieceId === pieceId))
      .filter((row): row is Anneal => row !== undefined)
      .map((row) => row.id)
    if (annealIds.length !== plan.loadedIds.length) {
      lastMessage.value = '排队队列已变化，请重新预排后再开炉'
      return null
    }
    const batch = await createKilnBatch({
      kilnCode: payload.kilnCode,
      capacity: payload.capacity,
      curveSeg: payload.curveSeg,
      inAt: payload.inAt,
      keeper: payload.keeper,
      annealIds,
      slots: plan.slots,
    })
    revision.value += 1
    lastMessage.value =
      plan.queuedIds.length > 0
        ? `已开第 ${batch.seq} 炉，装入 ${plan.loadedIds.length} 件；${plan.queuedIds.length} 件容量 / 窑位不足，排队等下一炉。`
        : `已开第 ${batch.seq} 炉，并炉 ${plan.loadedIds.length} 件，共用窑位 ${plan.slots.join('、')}。`
    return batch
  }

  /* ------------------------------ 炉次值守 ------------------------------ */

  /** 登记实际入窑：整炉待入窑 → 退火中 */
  async function loadBatch(batchId: string, inAt: string, keeper: string): Promise<boolean> {
    const ok = await markBatchLoaded(batchId, inAt, keeper)
    revision.value += 1
    if (ok) lastMessage.value = `第 ${batchById.value[batchId]?.seq ?? ''} 炉已登记实际入窑（${inAt.replace('T', ' ')}），整炉进入退火中。`
    else lastMessage.value = '只有待入窑炉次才能登记实际入窑'
    return ok
  }

  /** 登记实际出炉：整炉退火中 → 已出炉；件数对不上须写明 */
  async function outBatch(
    batchId: string,
    outAt: string,
    outCount: number,
    mismatchNote: string,
  ): Promise<{ ok: boolean; message: string }> {
    const result = await markBatchOut(batchId, { outAt, outCount, mismatchNote })
    revision.value += 1
    lastMessage.value = result.message
    return result
  }

  async function setBatchKeeper(batchId: string, keeper: string): Promise<void> {
    await updateKilnBatchKeeper(batchId, keeper)
    revision.value += 1
  }

  /** 删除待入窑炉次（作品退回排队）；已入窑炉次禁止删除 */
  async function deleteBatch(batchId: string): Promise<boolean> {
    const ok = await removeKilnBatch(batchId)
    revision.value += 1
    lastMessage.value = ok ? '炉次已撤销，作品退回待入窑排队、窑位已释放' : '已入窑炉次不能撤销，需按炉次值守出炉'
    return ok
  }

  /** 炉次状态的下一阶段（用于按钮文案 / 可用性） */
  function nextStateOf(state: KilnBatchState): KilnBatchState | null {
    const index = ANNEAL_STATE_FLOW.indexOf(state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    return ANNEAL_STATE_FLOW[index + 1]
  }

  return {
    anneals,
    batches,
    pieces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    waitingQueue,
    committedBatches,
    batchCards,
    visibleAnneals,
    batchById,
    wallThicknessOf,
    pieceNameOf,
    annealsOfBatch,
    maxWallOfBatch,
    durationOf,
    previewPlan,
    loadAll,
    setFilters,
    resetFilters,
    hasOpenAnneal,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    createBatch,
    loadBatch,
    outBatch,
    setBatchKeeper,
    deleteBatch,
    nextStateOf,
  }
})

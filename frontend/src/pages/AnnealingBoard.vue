<script setup lang="ts">
/**
 * /annealing 退火炉次编排与值守
 * 待入窑作品先排队；曲线相同、时间能对上的并成一炉，共用一组窑位；
 * 退火窑容量按件数封顶，排不下的排队等下一炉，不挤占已入窑炉次；
 * 值守按炉次登记实际入窑 / 出炉，出炉件数对不上须在炉次上写明。
 * 消费模型：KilnBatch、Anneal、Piece、Furnace；复用：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import {
  ANNEAL_STATE_OPTIONS,
  CURVE_SEG_OPTIONS,
  type Anneal,
  type AnnealDraft,
  type AnnealState,
  type CurveSeg,
} from '@/types/anneal'
import { ANNEAL_CURVE, formatHours, totalAnnealHours } from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'
import type { KilnBatch } from '@/types/kilnBatch'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

/* ------------------------------- 排队弹窗 ------------------------------- */
const queueDialogVisible = ref(false)
const queueSubmitting = ref(false)
const queueEditingId = ref<string | null>(null)
const queueFormRef = ref<FormInstance>()

const queueForm = reactive<AnnealDraft>({
  pieceId: '',
  curveSeg: '缓冷',
  inAt: nowLocalInput(),
})

const queueRules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择期望入窑时间', trigger: 'change' }],
}

/** 可排队作品：不存在未出炉退火安排的作品 */
const queueablePieces = computed(() =>
  pieceStore.pieces.filter((piece) => !annealStore.hasOpenAnneal(piece.id)),
)

const queueDuration = computed(() => {
  const piece = pieceStore.pieces.find((row) => row.id === queueForm.pieceId)
  const thickness = piece?.wallThicknessMm ?? 4
  return formatHours(totalAnnealHours(thickness))
})

/* ------------------------------- 开炉弹窗 ------------------------------- */
const batchDialogVisible = ref(false)
const batchSubmitting = ref(false)
const batchFormRef = ref<FormInstance>()

const batchForm = reactive({
  kilnCode: '',
  capacity: 6,
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  keeper: '',
})

const batchRules: FormRules<typeof batchForm> = {
  kilnCode: [{ required: true, message: '请选择退火窑', trigger: 'change' }],
  capacity: [{ required: true, message: '装载容量取自退火窑', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择本炉曲线', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择计划入窑时间', trigger: 'change' }],
}

/** 组炉预排结果（实时） */
const plan = computed(() =>
  batchForm.kilnCode === ''
    ? null
    : annealStore.previewPlan(batchForm.kilnCode, batchForm.capacity, batchForm.curveSeg, batchForm.inAt),
)

/** 选窑后带出该退火窑的装载容量 */
function syncCapacityFromKiln(): void {
  const furnace = furnaceStore.annealingFurnaces.find((row) => row.code === batchForm.kilnCode)
  if (furnace !== undefined) batchForm.capacity = furnace.loadCapacity
}

/* ------------------------------- 值守弹窗 ------------------------------- */
const dutyDialogVisible = ref(false)
const dutySubmitting = ref(false)
const dutyMode = ref<'load' | 'out'>('load')
const dutyBatch = ref<KilnBatch | null>(null)
const dutyFormRef = ref<FormInstance>()

const dutyForm = reactive({
  at: nowLocalInput(),
  keeper: '',
  outCount: 0,
  mismatchNote: '',
})

const dutyRules = computed<FormRules>(() => ({
  at: [{ required: true, message: '请选择时间', trigger: 'change' }],
  keeper: [{ required: true, message: '请登记值守人', trigger: 'blur' }],
  outCount: [{ required: true, message: '请清点实际出炉件数', trigger: 'blur' }],
  mismatchNote:
    dutyBatch.value !== null && dutyForm.outCount !== dutyBatchMembers.value.length
      ? [{ required: true, message: '件数对不上时必须写明情况', trigger: 'blur' }]
      : [],
}))

const dutyBatchMembers = computed<Anneal[]>(() =>
  dutyBatch.value === null ? [] : annealStore.annealsOfBatch(dutyBatch.value.id),
)

/* -------------------------------- 统计 -------------------------------- */
const stats = computed(() => ({
  waiting: annealStore.waitingQueue.length,
  batches: annealStore.batches.length,
  firing: annealStore.batches.filter((row) => row.state === '退火中').length,
  scheduled: annealStore.batches.filter((row) => row.state === '待入窑').length,
  done: annealStore.batches.filter((row) => row.state === '已出炉').length,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

/* ------------------------------ 排队操作 ------------------------------ */
function openEnqueue(): void {
  queueEditingId.value = null
  Object.assign(queueForm, {
    pieceId: queueablePieces.value[0]?.id ?? '',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
  })
  queueDialogVisible.value = true
}

function openEditQueue(row: Anneal): void {
  queueEditingId.value = row.id
  Object.assign(queueForm, { pieceId: row.pieceId, curveSeg: row.curveSeg, inAt: row.inAt })
  queueDialogVisible.value = true
}

async function handleQueueSubmit(): Promise<void> {
  if (queueFormRef.value === undefined) return
  const valid = await queueFormRef.value.validate().catch(() => false)
  if (!valid) return
  queueSubmitting.value = true
  try {
    if (queueEditingId.value === null) {
      const row = await annealStore.createAnneal({ ...queueForm })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(annealStore.lastMessage)
    } else {
      const ok = await annealStore.updateAnneal(queueEditingId.value, { ...queueForm })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success('排队信息已更新')
    }
    queueDialogVisible.value = false
  } finally {
    queueSubmitting.value = false
  }
}

async function handleDeleteQueue(row: Anneal): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认把「${annealStore.pieceNameOf(row.pieceId)}」从待入窑队列移除？`, '移除确认', {
        type: 'warning',
        confirmButtonText: '移除',
        cancelButtonText: '取消',
      })
  } catch {
    return
  }
  const ok = await annealStore.deleteAnneal(row.id)
  ElMessage[ok ? 'success' : 'warning'](annealStore.lastMessage)
}

/* ------------------------------ 开炉操作 ------------------------------ */
function openCreateBatch(): void {
  const code = furnaceStore.annealingFurnaces[0]?.code ?? annealStore.kilnCodes[0] ?? 'AN-01'
  Object.assign(batchForm, {
    kilnCode: code,
    capacity: furnaceStore.annealingFurnaces.find((row) => row.code === code)?.loadCapacity ?? 6,
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    keeper: '',
  })
  batchDialogVisible.value = true
}

async function handleCreateBatch(): Promise<void> {
  if (batchFormRef.value === undefined) return
  const valid = await batchFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (plan.value === null || plan.value.loadedIds.length === 0) {
    ElMessage.warning(plan.value?.message ?? '当前没有可并炉的作品')
    return
  }
  batchSubmitting.value = true
  try {
    const batch = await annealStore.createBatch({
      kilnCode: batchForm.kilnCode,
      capacity: batchForm.capacity,
      curveSeg: batchForm.curveSeg,
      inAt: batchForm.inAt,
      keeper: batchForm.keeper,
      plan: plan.value,
    })
    if (batch === null) {
      ElMessage.error(annealStore.lastMessage)
      return
    }
    ElMessage.success(annealStore.lastMessage)
    batchDialogVisible.value = false
  } finally {
    batchSubmitting.value = false
  }
}

/* ------------------------------ 炉次操作 ------------------------------ */
function openLoadDuty(card: { batch: KilnBatch }): void {
  dutyMode.value = 'load'
  dutyBatch.value = card.batch
  Object.assign(dutyForm, { at: card.batch.inAt || nowLocalInput(), keeper: card.batch.keeper, outCount: 0, mismatchNote: '' })
  dutyDialogVisible.value = true
}

function openOutDuty(card: { batch: KilnBatch }): void {
  dutyMode.value = 'out'
  dutyBatch.value = card.batch
  const memberCount = annealStore.annealsOfBatch(card.batch.id).length
  Object.assign(dutyForm, {
    at: nowLocalInput(),
    keeper: card.batch.keeper,
    outCount: card.batch.outCount ?? memberCount,
    mismatchNote: card.batch.mismatchNote,
  })
  dutyDialogVisible.value = true
}

async function handleDutySubmit(): Promise<void> {
  if (dutyFormRef.value === undefined || dutyBatch.value === null) return
  const valid = await dutyFormRef.value.validate().catch(() => false)
  if (!valid) return
  dutySubmitting.value = true
  try {
    if (dutyMode.value === 'load') {
      const ok = await annealStore.loadBatch(dutyBatch.value.id, dutyForm.at, dutyForm.keeper)
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(annealStore.lastMessage)
    } else {
      const result = await annealStore.outBatch(
        dutyBatch.value.id,
        dutyForm.at,
        dutyForm.outCount,
        dutyForm.mismatchNote,
      )
      if (!result.ok) {
        ElMessage.error(result.message)
        return
      }
      ElMessage.success(result.message)
    }
    dutyDialogVisible.value = false
  } finally {
    dutySubmitting.value = false
  }
}

async function handleDeleteBatch(card: { batch: KilnBatch }): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤销第 ${card.batch.seq} 炉？炉内 ${card.batch.slots.length} 件作品会退回待入窑排队并释放窑位。已入窑炉次不能撤销。`,
      '撤销炉次确认',
      { type: 'warning', confirmButtonText: '撤销炉次', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const ok = await annealStore.deleteBatch(card.batch.id)
  ElMessage[ok ? 'success' : 'warning'](annealStore.lastMessage)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}

const dutyTitle = computed(() => (dutyMode.value === 'load' ? '退火值守 · 登记实际入窑' : '退火值守 · 登记实际出炉'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待入窑排队" :value="stats.waiting" suffix="件" tone="info" icon="DataLine" />
      <StatBadge label="已排炉待入" :value="stats.scheduled" suffix="炉" tone="primary" icon="Histogram" />
      <StatBadge label="退火中" :value="stats.firing" suffix="炉" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="炉" tone="success" icon="PieChart" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`未出炉炉次占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位`"
      />
    </div>

    <el-alert
      v-if="annealStore.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="annealStore.lastMessage"
    />

    <!-- 待入窑排队 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">待入窑排队（曲线相同、时间能对上的将并成一炉）</span>
          <el-button type="primary" @click="openEnqueue" :disabled="queueablePieces.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记排队</span>
          </el-button>
        </div>
      </template>

      <EmptyPanel
        v-if="annealStore.ready && annealStore.waitingQueue.length === 0"
        title="队列里没有待入窑作品"
        description="把已完成全部工序的作品登记排队，注明退火曲线与最早可入窑时间；开炉时系统按曲线与时间自动组炉。"
        action-text="登记第一件排队"
        @action="openEnqueue"
      />

      <el-table v-else :data="annealStore.waitingQueue" row-key="id" stripe>
        <el-table-column label="作品" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ annealStore.pieceNameOf(row.pieceId) }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程
                {{ annealStore.durationOf(row.pieceId).text }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="150">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="曲线" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'">
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="期望入窑" width="160">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default>
            <el-tag size="small" type="info" effect="dark">排队中</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEditQueue(row)">改曲线/时间</el-button>
            <el-button link type="danger" size="small" @click="handleDeleteQueue(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 炉次 -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火炉次（每炉共用一组窑位，容量按件数封顶）</span>
          <el-button
            type="primary"
            @click="openCreateBatch"
            :disabled="annealStore.waitingQueue.length === 0 || furnaceStore.annealingFurnaces.length === 0"
          >
            <el-icon><Odometer /></el-icon>
            <span>按炉开炉</span>
          </el-button>
        </div>
      </template>

      <el-alert
        v-if="furnaceStore.annealingFurnaces.length === 0"
        type="warning"
        show-icon
        :closable="false"
        class="mb-14"
        title="还没有退火窑"
        description="请先到窑炉台账新建一台退火窑并设置每炉装载容量。"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.batchCards.length === 0"
        title="还没有退火炉次"
        description="队列里有作品时点「按炉开炉」：曲线相同、时间能对上的作品并成一炉，容量封顶、窑位冲突时多余作品自动排队等下一炉。"
        action-text="开第一炉"
        @action="openCreateBatch"
      />

      <div v-else class="batch-grid">
        <div v-for="card in annealStore.batchCards" :key="card.batch.id" class="batch-card">
          <div class="batch-head">
            <div class="batch-title">
              {{ card.batch.kilnCode }} · 第 {{ card.batch.seq }} 炉
              <el-tag
                size="small"
                effect="dark"
                :type="card.batch.state === '已出炉' ? 'success' : card.batch.state === '退火中' ? 'warning' : 'info'"
              >
                {{ card.batch.state }}
              </el-tag>
            </div>
            <div class="cell-sub">
              {{ card.batch.curveSeg }} · {{ card.loadedCount }}/{{ card.batch.capacity }} 件 · 值守
              {{ card.batch.keeper || '未登记' }}
            </div>
          </div>

          <div class="batch-times">
            <span>入窑 {{ card.batch.inAt.replace('T', ' ') }}</span>
            <span v-if="card.batch.outAt !== ''">出炉 {{ card.batch.outAt.replace('T', ' ') }}</span>
            <span v-else class="cell-sub">预计 {{ card.estimatedEndAt.replace('T', ' ') }}（按炉内最厚 {{ card.maxWallMm }} mm 估）</span>
          </div>

          <div class="batch-members">
            <div v-for="member in card.members" :key="member.id" class="member-row">
              <el-tag size="small" type="info">{{ member.kilnSlot }}</el-tag>
              <el-link type="primary" @click="$router.push(`/pieces/${member.pieceId}/steps`)">
                {{ annealStore.pieceNameOf(member.pieceId) }}
              </el-link>
              <span class="cell-sub">壁厚 {{ annealStore.wallThicknessOf(member.pieceId) }} mm</span>
            </div>
          </div>

          <el-alert
            v-if="card.batch.state === '已出炉' && card.batch.outCount !== card.loadedCount"
            type="error"
            show-icon
            :closable="false"
            class="batch-note"
            :title="`出炉件数对不上：登记 ${card.batch.outCount} 件 / 炉内 ${card.loadedCount} 件`"
            :description="card.batch.mismatchNote"
          />
          <el-alert
            v-else-if="card.batch.state === '已出炉'"
            type="success"
            show-icon
            :closable="false"
            class="batch-note"
            :title="`出炉 ${card.batch.outCount} 件，与炉内一致`"
          />

          <div class="batch-actions">
            <el-button
              v-if="card.batch.state === '待入窑'"
              size="small"
              type="warning"
              @click="openLoadDuty(card)"
            >
              登记实际入窑
            </el-button>
            <el-button v-if="card.batch.state === '退火中'" size="small" type="success" @click="openOutDuty(card)">
              登记实际出炉
            </el-button>
            <el-button v-if="card.batch.state === '待入窑'" size="small" type="danger" plain @click="handleDeleteBatch(card)">
              撤销炉次
            </el-button>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 退火记录（按炉次/排队筛选） -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">退火记录</span>
      </template>
      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: ANNEAL_STATE_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          curveSeg: annealStore.filters.curveSeg,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <el-table v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
              {{ annealStore.pieceNameOf(row.pieceId) }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="所属炉次" width="150">
          <template #default="{ row }">
            <span v-if="row.batchId === ''" class="cell-sub">排队中</span>
            <span v-else>
              {{ annealStore.batchById[row.batchId]?.kilnCode }} · 第 {{ annealStore.batchById[row.batchId]?.seq }} 炉
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="120">
          <template #default="{ row }">{{ row.kilnSlot || '—' }}</template>
        </el-table-column>
        <el-table-column label="曲线" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'">
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入窑 / 出炉" min-width="280">
          <template #default="{ row }">
            <span>{{ (row.inAt || '待排').replace('T', ' ') }}</span>
            <span class="cell-sub"> → {{ row.outAt === '' ? '未出炉' : row.outAt.replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.state === '已出炉' ? 'success' : row.state === '退火中' ? 'warning' : 'info'" effect="dark">
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 窑位占用表 -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表（仅未出炉炉次占格）</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{ 'is-occupied': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.occupied) }"
        >
          <div class="slot-name">{{ slot }}</div>
          <template v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot)" :key="row.batchId">
            <div class="slot-detail">
              第 {{ row.batchSeq }} 炉 · {{ row.pieceNames.join('、') || '在烧' }} · {{ row.state }}
            </div>
          </template>
          <div v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <!-- 排队弹窗 -->
    <el-dialog v-model="queueDialogVisible" :title="queueEditingId === null ? '登记待入窑排队' : '修改排队信息'" width="600px">
      <el-form ref="queueFormRef" :model="queueForm" :rules="queueRules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select v-model="queueForm.pieceId" filterable style="width: 100%" :disabled="queueEditingId !== null">
            <el-option
              v-for="item in queueablePieces"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="退火曲线" prop="curveSeg">
              <el-select v-model="queueForm.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="期望入窑时间" prop="inAt">
              <el-date-picker
                v-model="queueForm.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          type="success"
          show-icon
          :closable="false"
          :title="`该作品全流程退火约 ${queueDuration}`"
          :description="`只有曲线同为「${queueForm.curveSeg}」且不晚于炉次计划入窑时间的作品才会被并到同一炉；窑位由开炉时统一分配。${ANNEAL_CURVE[queueForm.curveSeg].hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="queueDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="queueSubmitting" @click="handleQueueSubmit">入队</el-button>
      </template>
    </el-dialog>

    <!-- 开炉弹窗 -->
    <el-dialog v-model="batchDialogVisible" title="按炉开炉 · 组炉预排" width="720px">
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="退火窑" prop="kilnCode">
              <el-select v-model="batchForm.kilnCode" style="width: 100%" @change="syncCapacityFromKiln">
                <el-option
                  v-for="item in furnaceStore.annealingFurnaces"
                  :key="item.id"
                  :value="item.code"
                  :label="`${item.code} · ${item.loadCapacity} 件/炉`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="本炉曲线" prop="curveSeg">
              <el-select v-model="batchForm.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="计划入窑时间" prop="inAt">
              <el-date-picker
                v-model="batchForm.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="容量上限" prop="capacity">
              <el-input-number v-model="batchForm.capacity" :min="1" :max="60" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="16">
            <el-form-item label="值守人">
              <el-input v-model="batchForm.keeper" placeholder="如：郑野（可入炉时再补登记）" />
            </el-form-item>
          </el-col>
        </el-row>

        <div class="plan-box">
          <template v-if="plan !== null">
            <div class="plan-line">
              <b>候选 {{ plan.candidateIds.length }} 件</b>
              <span class="cell-sub">曲线相同且期望入窑不晚于计划时间</span>
            </div>
            <div class="plan-line">
              <el-tag type="success">本炉装 {{ plan.loadedIds.length }} 件</el-tag>
              <el-tag :type="plan.queuedIds.length > 0 ? 'warning' : 'info'">
                排队等下一炉 {{ plan.queuedIds.length }} 件
              </el-tag>
            </div>
            <div class="plan-line cell-sub">{{ plan.message }}</div>
            <div v-if="plan.slots.length > 0" class="plan-line">
              <el-tag v-for="slot in plan.slots" :key="slot" size="small" class="slot-tag">{{ slot }}</el-tag>
            </div>
          </template>
          <el-alert v-else type="info" show-icon :closable="false" title="请先选择退火窑" />
        </div>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="batchSubmitting"
          :disabled="plan === null || plan.loadedIds.length === 0"
          @click="handleCreateBatch"
        >
          确认开炉（{{ plan?.loadedIds.length ?? 0 }} 件）
        </el-button>
      </template>
    </el-dialog>

    <!-- 值守弹窗 -->
    <el-dialog v-model="dutyDialogVisible" :title="dutyTitle" width="600px">
      <el-form ref="dutyFormRef" :model="dutyForm" :rules="dutyRules" label-width="120px">
        <el-form-item :label="dutyMode === 'load' ? '实际入窑时间' : '实际出炉时间'" prop="at">
          <el-date-picker
            v-model="dutyForm.at"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="值守人" prop="keeper">
          <el-input v-model="dutyForm.keeper" placeholder="如：郑野" />
        </el-form-item>
        <template v-if="dutyMode === 'out'">
          <el-form-item label="实际出炉件数" prop="outCount">
            <el-input-number v-model="dutyForm.outCount" :min="0" :max="99" :step="1" style="width: 200px" />
            <span class="cell-sub" style="margin-left: 10px">炉内 {{ dutyBatchMembers.length }} 件</span>
          </el-form-item>
          <el-form-item label="情况说明" prop="mismatchNote">
            <el-input
              v-model="dutyForm.mismatchNote"
              type="textarea"
              :rows="3"
              :placeholder="
                dutyForm.outCount === dutyBatchMembers.length
                  ? '件数一致，可留空'
                  : '必填：说明实际出炉件数与炉内不一致的原因（如破损 / 滞留 / 漏装）'
              "
            />
          </el-form-item>
          <el-alert
            v-if="dutyForm.outCount !== dutyBatchMembers.length"
            type="error"
            show-icon
            :closable="false"
            title="出炉件数与炉内对不上，必须在炉次上写明情况，记录会随炉次长期保留。"
          />
        </template>
        <el-alert
          v-else
          type="warning"
          show-icon
          :closable="false"
          title="整炉一起确认入窑：炉内各件状态统一推进为「退火中」，入炉后本炉曲线 / 窑位 / 时间锁定。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dutyDialogVisible = false">取消</el-button>
        <el-button :type="dutyMode === 'out' ? 'success' : 'warning'" :loading="dutySubmitting" @click="handleDutySubmit">
          {{ dutyMode === 'out' ? '确认出炉' : '确认入窑' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.batch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 12px;
}

.batch-card {
  border: 1px solid #e4e7ed;
  border-radius: 12px;
  padding: 12px 14px;
  background: #fafcff;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.batch-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d2b3a;
  display: flex;
  align-items: center;
  gap: 8px;
}

.batch-times {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: #5b6b7a;
}

.batch-members {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.batch-note {
  margin-top: 2px;
}

.batch-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: auto;
}

.plan-box {
  margin-top: 6px;
  border: 1px dashed #c7d0da;
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #fcfdff;
}

.plan-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.slot-tag {
  margin-right: 4px;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}

.slot-cell {
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafcff;
}

.slot-cell.is-occupied {
  border-color: #f0b27a;
  background: #fff8f1;
}

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail.is-free {
  color: #a8b0b8;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>

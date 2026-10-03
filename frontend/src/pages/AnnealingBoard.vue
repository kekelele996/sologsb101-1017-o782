<script setup lang="ts">
/**
 * /annealing 退火窑炉次编排
 * 窑务排产员按炉次编排：曲线相同、入窑时间对得上的待入窑作品并成一炉、共用一组窑位，
 * 装载容量按件数封顶，排不下 / 撞炉窗口的留在队列等下一炉，不挤已入窑的炉。
 * 退火值守按炉次记实际入窑与出炉；烧完件数对不上时在炉次上写清，计划 / 实际两边各留一份。
 * 消费模型：Anneal、KilnRun、Piece、Furnace；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
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
  CURVE_SEG_OPTIONS,
  type Anneal,
  type AnnealDraft,
  type AnnealState,
  type CurveSeg,
} from '@/types/anneal'
import type { KilnRun } from '@/types/run'
import { ANNEAL_CURVE, formatHours, plannedOutAt, segmentHours, totalAnnealHours } from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

/* ------------------------------ 排队 / 编辑弹窗 ------------------------------ */

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnCode: '',
  expectedInAt: nowLocalInput(),
  curveSeg: '保温' as CurveSeg,
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnCode: [{ required: true, message: '请选择目标退火窑', trigger: 'change' }],
  expectedInAt: [{ required: true, message: '请选择期望入窑时间', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
}

/** 还能排队的作品：没有未完成退火记录 */
const queueablePieces = computed(() =>
  pieceStore.pieces.filter((piece) => annealStore.activeAnnealOfPiece(piece.id, editingId.value ?? '') === undefined),
)

const selectedPiece = computed(() => pieceStore.pieces.find((row) => row.id === form.pieceId) ?? null)

const formDuration = computed(() => {
  const thickness = selectedPiece.value?.wallThicknessMm ?? 4
  return {
    segment: formatHours(segmentHours(form.curveSeg, thickness)),
    total: formatHours(totalAnnealHours(thickness)),
    hint: ANNEAL_CURVE[form.curveSeg].hint,
  }
})

/** 排队后能不能并炉的预判（仅提示，不改变提交） */
const mergePreview = computed(() => {
  if (form.pieceId === '' || form.kilnCode === '' || form.expectedInAt === '') return null
  return annealStore.previewQueue(form.pieceId, form.kilnCode, form.expectedInAt)
})

/* ------------------------------ 值守（入炉 / 出炉）弹窗 ------------------------------ */

const dutyDialogVisible = ref(false)
const dutyMode = ref<'checkin' | 'close'>('checkin')
const dutyRun = ref<KilnRun | null>(null)
const dutyAt = ref(nowLocalInput())
const dutyPieceIds = ref<string[]>([])
const dutyNote = ref('')

/* ------------------------------ 统计与筛选 ------------------------------ */

const stats = computed(() => ({
  queue: annealStore.queuedAnneals.length,
  waitingRun: annealStore.runStateCounts['待入窑'],
  firing: annealStore.runStateCounts['退火中'],
  done: annealStore.runStateCounts['已出炉'],
  plannedPieces: annealStore.runs
    .filter((run) => run.state === '待入窑')
    .reduce((acc, run) => acc + run.planPieceIds.length, 0),
}))

const stateFilter = ref<AnnealState | 'all'>('all')
const kilnFilter = ref<string>('all')
const keyword = ref('')

const visibleRunRows = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return annealStore.runRows.filter(({ run, members }) => {
    if (stateFilter.value !== 'all' && run.state !== stateFilter.value) return false
    if (kilnFilter.value !== 'all' && run.kilnCode !== kilnFilter.value) return false
    if (key === '') return true
    const names = run.planPieceIds.map((id) => annealStore.pieceName(id)).join(' ').toLowerCase()
    return (
      run.kilnCode.toLowerCase().includes(key) ||
      names.includes(key) ||
      members.some((row) => row.kilnSlot.toLowerCase().includes(key))
    )
  })
})

const visibleQueue = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return annealStore.queuedAnneals.filter((row) => {
    if (kilnFilter.value !== 'all' && row.kilnCode !== kilnFilter.value) return false
    if (key === '') return true
    return (
      annealStore.pieceName(row.pieceId).toLowerCase().includes(key) ||
      row.kilnCode.toLowerCase().includes(key)
    )
  })
})

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

/* ------------------------------ 排队动作 ------------------------------ */

function openCreate(): void {
  editingId.value = null
  const firstPiece = queueablePieces.value[0]
  Object.assign(form, {
    pieceId: firstPiece?.id ?? pieceStore.currentPieceId ?? '',
    kilnCode: annealStore.kilnCodes[0] ?? 'AN-01',
    expectedInAt: nowLocalInput(),
    curveSeg: '保温' as CurveSeg,
  })
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnCode: row.kilnCode,
    expectedInAt: row.expectedInAt,
    curveSeg: row.curveSeg,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.enqueue({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(annealStore.lastMessage)
    } else {
      const ok = await annealStore.updateQueue(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(annealStore.lastMessage)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除「${annealStore.pieceName(row.pieceId)}」的退火排队记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await annealStore.deleteAnneal(row.id)
  ElMessage.success('退火记录已删除')
}

async function handleSchedule(): Promise<void> {
  if (annealStore.queuedAnneals.length === 0) {
    ElMessage.info('待入窑队列为空')
    return
  }
  try {
    await ElMessageBox.confirm(
      '将把曲线相同（壁厚一致）、入窑时间对得上的待入窑作品并成一炉，共用一组窑位；超过退火窑容量或撞上在烧炉窗口的件会留在队列等下一炉。',
      '按炉次自动排产',
      { type: 'info', confirmButtonText: '开始排产', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const result = await annealStore.schedule()
  ElMessage.success(`已编排 ${result.created} 炉${result.blocked > 0 ? `，${result.blocked} 件留队列等下一炉` : ''}`)
}

/* ------------------------------ 炉次值守 ------------------------------ */

function openCheckin(run: KilnRun): void {
  dutyMode.value = 'checkin'
  dutyRun.value = run
  dutyAt.value = run.plannedInAt || nowLocalInput()
  dutyPieceIds.value = [...run.planPieceIds]
  dutyNote.value = run.dutyNote
  dutyDialogVisible.value = true
}

function openClose(run: KilnRun): void {
  dutyMode.value = 'close'
  dutyRun.value = run
  dutyAt.value = run.plannedOutAt || nowLocalInput()
  dutyPieceIds.value = [...run.actualPieceIds]
  dutyNote.value = run.dutyNote
  dutyDialogVisible.value = true
}

async function handleDutySubmit(): Promise<void> {
  const run = dutyRun.value
  if (run === null) return
  if (dutyPieceIds.value.length === 0) {
    ElMessage.warning('实际件数不能为 0 件；如整炉未烧，请先在炉次说明里注明并退回队列。')
    return
  }
  if (dutyMode.value === 'checkin') {
    const result = await annealStore.checkin(run.id, dutyAt.value, dutyPieceIds.value, dutyNote.value)
    if (result === null) {
      ElMessage.error(annealStore.lastMessage)
      return
    }
  } else {
    if (dutyPieceIds.value.length !== run.actualPieceIds.length && dutyNote.value.trim() === '') {
      ElMessage.warning('出炉件数与入炉件数对不上，请在炉次说明里写清原因后再提交。')
      return
    }
    const result = await annealStore.close(run.id, dutyAt.value, dutyPieceIds.value, dutyNote.value)
    if (result === null) {
      ElMessage.error(annealStore.lastMessage)
      return
    }
  }
  ElMessage.success(annealStore.lastMessage)
  dutyDialogVisible.value = false
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') stateFilter.value = value as AnnealState | 'all'
  if (key === 'kilnCode') kilnFilter.value = value
}

function dutyPieceOptions(run: KilnRun): string[] {
  return dutyMode.value === 'checkin' ? run.planPieceIds : run.actualPieceIds
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待入窑队列" :value="stats.queue" suffix="件" tone="info" icon="DataLine" />
      <StatBadge label="待开炉" :value="stats.waitingRun" suffix="炉" tone="primary" icon="Histogram" />
      <StatBadge label="退火中" :value="stats.firing" suffix="炉" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="炉" tone="success" icon="PieChart" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`未出炉炉次占用 ${annealStore.occupiedSlots.size} / ${annealStore.allSlots.length} 个窑位`"
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

    <!-- ============================ 待入窑队列 ============================ -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">待入窑队列（每件先进队，等排产并炉）</span>
          <el-space wrap>
            <el-button type="primary" plain @click="handleSchedule" :disabled="annealStore.queuedAnneals.length === 0">
              <el-icon><Operation /></el-icon>
              <span>按炉次排产</span>
            </el-button>
            <el-button type="primary" @click="openCreate" :disabled="annealStore.kilnCodes.length === 0">
              <el-icon><Plus /></el-icon>
              <span>作品入队</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <EmptyPanel
        v-if="annealStore.ready && annealStore.queuedAnneals.length === 0"
        title="待入窑队列已空"
        description="完成全部吹制工序的作品先在此排队（只选目标退火窑与期望入窑时间）；排产时曲线相同、时间对得上的会并成一炉，共用一组窑位。"
        action-text="把作品加入队列"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="visibleQueue" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ annealStore.pieceName(row.pieceId) }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程
                {{ annealStore.durationOf(row.pieceId).text }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="140">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="kilnCode" label="目标退火窑" width="120" />
        <el-table-column label="曲线段" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'">
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="期望入窑 / 预计出炉" min-width="280">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.expectedInAt.replace('T', ' ') }}</span>
              <span class="cell-sub">预计 {{ plannedOutAt(row.expectedInAt, annealStore.wallThicknessOf(row.pieceId)).replace('T', ' ') }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ============================ 炉次 ============================ -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火炉次（一炉多件并烧，共用一组窑位）</span>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          { key: 'state', label: '炉次状态', options: ['待入窑', '退火中', '已出炉'] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{ state: stateFilter, kilnCode: kilnFilter }"
        :result-text="`命中 ${visibleRunRows.length} / ${annealStore.runs.length} 炉；队列 ${visibleQueue.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            stateFilter = 'all'
            kilnFilter = 'all'
            keyword = ''
          }
        "
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.runs.length === 0"
        title="还没有炉次"
        description="把待入窑作品排产后会在此生成炉次卡片；同一炉的作品曲线相同、共用窑位，退火值守按炉次记实际入出炉。"
        :action-text="annealStore.queuedAnneals.length > 0 ? '立即按炉次排产' : ''"
        @action="handleSchedule"
      />

      <div v-else class="run-grid">
        <div v-for="{ run, members, capacity } in visibleRunRows" :key="run.id" class="run-card" :class="`is-${run.state}`">
          <div class="run-card__head">
            <div class="cell-stack">
              <b>{{ run.kilnCode }} · 第 {{ run.seq }} 炉</b>
              <span class="cell-sub">壁厚 {{ run.wallThicknessMm }} mm · 曲线 {{ run.curveKey }}</span>
            </div>
            <el-tag size="small" :type="run.state === '已出炉' ? 'success' : run.state === '退火中' ? 'warning' : 'info'" effect="dark">
              {{ run.state }}
            </el-tag>
          </div>

          <div class="run-meta">
            <span>装载 {{ run.planPieceIds.length }} / {{ capacity }} 件</span>
            <span>窑位 {{ run.slots.length > 0 ? run.slots.join('、') : '待分配' }}</span>
          </div>
          <div class="run-meta">
            <span>计划 {{ run.plannedInAt.replace('T', ' ') }} → {{ run.plannedOutAt.replace('T', ' ') }}</span>
          </div>
          <div class="run-meta" v-if="run.actualInAt !== '' || run.actualOutAt !== ''">
            <span class="actual">
              实际 {{ (run.actualInAt || '—').replace('T', ' ') }} → {{ run.actualOutAt === '' ? '在烧' : run.actualOutAt.replace('T', ' ') }}
              （{{ run.actualPieceIds.length }} 件）
            </span>
          </div>

          <ul class="run-pieces">
            <li v-for="anneal in members" :key="anneal.id">
              <el-link type="primary" @click="$router.push(`/pieces/${anneal.pieceId}/steps`)">
                {{ annealStore.pieceName(anneal.pieceId) }}
              </el-link>
              <span class="cell-sub">{{ anneal.kilnSlot || '窑位待分配' }} · {{ anneal.curveSeg }}</span>
            </li>
            <li v-if="members.length === 0" class="cell-sub">（该炉下已无退火记录，可能已被删除）</li>
          </ul>

          <el-alert
            v-if="run.dutyNote !== ''"
            type="warning"
            :closable="false"
            class="run-note"
            title="值守说明"
            :description="run.dutyNote"
          />
          <el-alert
            v-else-if="run.state === '已出炉' && run.actualPieceIds.length !== run.planPieceIds.length"
            type="error"
            :closable="false"
            class="run-note"
            :title="`件数不符：计划 ${run.planPieceIds.length} 件，实际出炉 ${run.actualPieceIds.length} 件，需在炉次上补说明`"
          />

          <div class="run-actions">
            <el-button v-if="run.state === '待入窑'" size="small" type="primary" @click="openCheckin(run)">
              登记实际入窑
            </el-button>
            <el-button v-if="run.state === '退火中'" size="small" type="primary" @click="openClose(run)">
              登记出炉
            </el-button>
            <span v-if="run.state === '已出炉'" class="cell-sub">已完成归档</span>
          </div>
        </div>
      </div>
    </el-card>

    <!-- ============================ 窑位占用表 ============================ -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表（未出炉炉次占格）</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{ 'is-occupied': annealStore.occupiedSlots.has(slot) }"
        >
          <div class="slot-name">{{ slot }}</div>
          <template v-for="row in annealStore.runRows.filter((item) => item.run.slots.includes(slot) && item.run.state !== '已出炉')" :key="row.run.id">
            <div class="slot-detail">
              {{ row.run.kilnCode }} 第{{ row.run.seq }}炉 · {{ row.run.state }} · {{ row.run.planPieceIds.length }}件
            </div>
          </template>
          <div v-if="!annealStore.occupiedSlots.has(slot)" class="slot-detail is-free">空闲</div>
        </div>
      </div>
    </el-card>

    <!-- ============================ 入队 / 编辑弹窗 ============================ -->
    <el-dialog v-model="dialogVisible" :title="editingId === null ? '作品加入待入窑队列' : '编辑排队意向'" width="660px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select v-model="form.pieceId" filterable style="width: 100%" :disabled="editingId !== null">
                <el-option
                  v-for="item in queueablePieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="目标退火窑" prop="kilnCode">
              <el-select v-model="form.kilnCode" filterable style="width: 100%">
                <el-option
                  v-for="item in annealStore.annealingFurnaces"
                  :key="item.id"
                  :value="item.code"
                  :label="`${item.code} · 容量 ${item.capacity || 9} 件/炉`"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="16">
            <el-form-item label="期望入窑时间" prop="expectedInAt">
              <el-date-picker
                v-model="form.expectedInAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-alert
          v-if="mergePreview !== null && mergePreview.matchRuns.some((run) => run.planPieceIds.length < annealStore.capacityOfCode(run.kilnCode))"
          type="success"
          show-icon
          :closable="false"
          title="时间与曲线对得上：排产时可并入同曲线待开炉，共用一组窑位"
          :description="`全流程退火 ${formDuration.total}，预计 ${mergePreview?.plannedOutAt.replace('T', ' ')} 出炉。`"
        />
        <el-alert
          v-else
          type="info"
          show-icon
          :closable="false"
          title="排队后由排产员按炉次编排"
          :description="`当前曲线段「${form.curveSeg}」该段时长 ${formDuration.segment}，作品全流程 ${formDuration.total}；同壁厚且入窑时间相差不超过 1 小时的作品才会并炉。${formDuration.hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">入队</el-button>
      </template>
    </el-dialog>

    <!-- ============================ 值守弹窗 ============================ -->
    <el-dialog
      v-model="dutyDialogVisible"
      :title="dutyRun === null ? '' : `${dutyRun.kilnCode} 第 ${dutyRun.seq} 炉 · ${dutyMode === 'checkin' ? '登记实际入窑' : '登记出炉'}`"
      width="620px"
    >
      <div v-if="dutyRun !== null" class="duty-body">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="计划（排产员留存）">
            {{ dutyRun.plannedInAt.replace('T', ' ') }} → {{ dutyRun.plannedOutAt.replace('T', ' ') }}
            ，共 {{ dutyRun.planPieceIds.length }} 件：
            {{ dutyRun.planPieceIds.map((id) => annealStore.pieceName(id)).join('、') }}
          </el-descriptions-item>
        </el-descriptions>

        <el-form label-width="110px" class="mt-14">
          <el-form-item :label="dutyMode === 'checkin' ? '实际入窑时间' : '实际出炉时间'">
            <el-date-picker
              v-model="dutyAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm"
              format="YYYY-MM-DD HH:mm"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item :label="dutyMode === 'checkin' ? '实际随炉件' : '实际出炉件'">
            <el-select v-model="dutyPieceIds" multiple filterable style="width: 100%" placeholder="勾选实际随炉 / 出炉的件">
              <el-option
                v-for="pieceId in dutyPieceOptions(dutyRun)"
                :key="pieceId"
                :value="pieceId"
                :label="annealStore.pieceName(pieceId)"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="值守说明">
            <el-input
              v-model="dutyNote"
              type="textarea"
              :rows="3"
              :placeholder="
                dutyMode === 'checkin'
                  ? '计划件没到场时，未勾选的件会自动退回待入窑重排；件数对不上请在此写清原因。'
                  : '出炉件数与入炉件数对不上时必须写清原因，计划 / 实际两边各留一份。'
              "
            />
          </el-form-item>
        </el-form>

        <el-alert
          v-if="dutyPieceIds.length !== dutyPieceOptions(dutyRun).length"
          type="warning"
          show-icon
          :closable="false"
          :title="
            dutyMode === 'checkin'
              ? `计划 ${dutyPieceOptions(dutyRun).length} 件，实际勾选 ${dutyPieceIds.length} 件；未勾选件将退回队列重排`
              : `入炉 ${dutyPieceOptions(dutyRun).length} 件，实际出炉勾选 ${dutyPieceIds.length} 件，请在说明里写清`
          "
        />
      </div>
      <template #footer>
        <el-button @click="dutyDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleDutySubmit">{{ dutyMode === 'checkin' ? '确认入窑' : '确认出炉' }}</el-button>
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

.run-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.run-card {
  border: 1px solid #e4e7ed;
  border-radius: 12px;
  padding: 12px 14px;
  background: #fafcff;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.run-card.is-退火中 {
  border-color: #f0b27a;
  background: #fff8f1;
}

.run-card.is-已出炉 {
  border-color: #b7e4c7;
  background: #f4fcf6;
}

.run-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.run-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: #5b6b7a;
}

.run-meta .actual {
  color: #b25b00;
}

.run-pieces {
  list-style: none;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #ffffff;
  border: 1px dashed #dfe5ec;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.run-note {
  margin: 0;
}

.run-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
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

.duty-body {
  display: flex;
  flex-direction: column;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>

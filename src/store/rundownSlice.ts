import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  BreakingChange,
  DenialEntry,
  HistoryEntry,
  MakeupItem,
  PendingChange,
  Role,
  RundownItem,
  Snapshot
} from "../types";
import {
  AD_DURATION,
  AD_ID,
  MIN_ITEM_DURATION,
  PRE_AD_TARGET,
  isAd,
  isAired,
  isSkipped,
  planBreaking,
  segmentById,
  segmentEffectiveMinutes
} from "./domain";

/** 08:00–08:30 固定 30 分钟，08:30 广告 3 分钟，广告后固定 27 分钟（至 09:00） */
const POST_AD_TARGET = 60 - PRE_AD_TARGET - AD_DURATION;

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "口播", duration: 3, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 7, status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 8, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "国际要闻速览", type: "新闻片", duration: 6, status: "待播", presenter: "陈默", source: "国际部" },
  { id: "r5", title: "民生服务提示", type: "口播", duration: 6, status: "待播", presenter: "林晓", source: "编辑稿" },
  { id: AD_ID, title: "整点广告（08:30 固定）", type: "广告", duration: AD_DURATION, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" },
  { id: "post-1", title: "财经数据快报", type: "新闻片", duration: 7, status: "待播", presenter: "林晓", source: "财经组" },
  { id: "post-2", title: "体育战报", type: "新闻片", duration: 5, status: "待播", presenter: "陈默", source: "体育组" },
  { id: "post-3", title: "文化周末看点", type: "嘉宾", duration: 8, status: "待播", presenter: "林晓", source: "演播室B" },
  { id: "post-4", title: "天气预报与收播", type: "口播", duration: 7, status: "待播", presenter: "陈默", source: "气象中心" }
];

interface BreakingInput {
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
}

export type EditorDraft = Pick<RundownItem, "title" | "duration" | "presenter" | "source">;

interface State {
  initialized: boolean;
  items: RundownItem[];
  makeup: MakeupItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  denials: DenialEntry[];
  role: Role;
  online: boolean;
}

const initialState: State = {
  initialized: false,
  items: seed,
  makeup: [],
  history: [],
  queue: [],
  changes: [],
  denials: [],
  role: "导播",
  online: true
};

const CAPACITY: Record<string, Partial<Record<Role, boolean>>> = {
  insertBreaking: { 导播: true },
  markAired: { 导播: true },
  skipItem: { 导播: true },
  reorder: { 导播: true },
  addItem: { 主编: true },
  editItem: { 主编: true }
};

function takeSnapshot(items: RundownItem[], makeup: MakeupItem[], label: string, detail: string): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    label,
    detail,
    time: new Date().toISOString(),
    // items/makeup 在 reducer 内是 Immer draft（Proxy），structuredClone 无法直接克隆，先 JSON 落纯对象
    snapshot: { items: structuredClone(toPlain(items)), makeup: structuredClone(toPlain(makeup)) }
  };
}

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 越权操作统一拒绝并留痕，UI 层同时拦截 */
function deny(state: State, action: string, detail: string) {
  state.denials.unshift({ id: crypto.randomUUID(), action, detail, at: new Date().toISOString() });
}

function guard(state: State, action: keyof typeof CAPACITY, label: string): boolean {
  if (CAPACITY[action][state.role]) return true;
  deny(state, label, `岗位「${state.role}」无权执行，已拒绝`);
  return false;
}

function enqueueWhenOffline(state: State, action: string, detail: string) {
  if (!state.online) {
    state.queue.unshift({ id: crypto.randomUUID(), action, detail, queuedAt: new Date().toISOString() });
  }
}

/** 该段当前还能再容纳几分钟（只看非跳过条目；总窗口固定，广告固定） */
function slack(items: RundownItem[], segment: "广告前" | "广告后"): number {
  const target = segment === "广告前" ? PRE_AD_TARGET : POST_AD_TARGET;
  return target - segmentEffectiveMinutes(items, segment);
}

/** 新增条目追加到广告后尾部：广告后剩余容量不够则拒绝 */
function addItemReducer(state: State, draft: Omit<RundownItem, "id" | "status">) {
  if (draft.type === "广告") {
    deny(state, "新增条目", "08:30 广告已固定，不允许再新增广告");
    return { ok: false as const, message: "08:30 广告已固定，不允许再新增广告" };
  }
  const free = slack(state.items, "广告后");
  if (draft.duration > free) {
    const message = free > 0
      ? `广告后只剩 ${free} 分钟，缺 ${draft.duration - free} 分钟，无法加入（08:00–09:00 窗口固定）`
      : `广告后已排满 09:00，缺 ${draft.duration} 分钟，无法加入`;
    deny(state, "新增条目", message);
    return { ok: false as const, message };
  }
  state.history.unshift(takeSnapshot(state.items, state.makeup, "新增条目", draft.title));
  state.items.push({ ...draft, id: `post-${crypto.randomUUID()}`, status: "待播" });
  enqueueWhenOffline(state, "新增条目", draft.title);
  return { ok: true as const };
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        state.items = action.payload.length ? action.payload : seed;
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    clearDenials(state) {
      state.denials = [];
    },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      if (!guard(state, "addItem", "新增条目")) return;
      addItemReducer(state, action.payload);
    },
    editItem(state, action: PayloadAction<{ id: string; draft: EditorDraft }>) {
      if (!guard(state, "editItem", "修改未播条目")) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (isAd(item)) {
        deny(state, "修改条目", "08:30 广告保持原位，禁止修改");
        return;
      }
      if (isAired(item)) {
        deny(state, "修改条目", `「${item.title}」已播出，已播出内容保持原位，禁止修改`);
        return;
      }
      if (isSkipped(item)) {
        deny(state, "修改条目", `「${item.title}」已跳过，不能修改`);
        return;
      }
      if (action.payload.draft.duration < MIN_ITEM_DURATION) {
        deny(state, "修改条目", `普通条目时长不能低于 ${MIN_ITEM_DURATION} 分钟`);
        return;
      }
      const segment = segmentById(item.id);
      const delta = action.payload.draft.duration - item.duration;
      const free = slack(state.items, segment);
      if (delta > free) {
        const message = segment === "广告前"
          ? `该段只有 ${free} 分钟空档，时长增加会顶到 08:30 广告，缺 ${delta - free} 分钟`
          : `该段只有 ${free} 分钟空档，时长增加会越过 09:00，缺 ${delta - free} 分钟`;
        deny(state, "修改条目", message);
        return;
      }
      state.history.unshift(
        takeSnapshot(state.items, state.makeup, "修改未播条目", `${item.title} → ${action.payload.draft.title}`)
      );
      Object.assign(item, action.payload.draft);
    },
    markAired(state, action: PayloadAction<string>) {
      if (!guard(state, "markAired", "标记已播出")) return;
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item || isAired(item)) return;
      if (isAd(item)) {
        deny(state, "标记已播出", "08:30 广告由播控系统自动执行，保持固定位置");
        return;
      }
      state.history.unshift(takeSnapshot(state.items, state.makeup, "播出状态", `${item.title} → 已播出`));
      item.status = "已播出";
    },
    skipItem(state, action: PayloadAction<string>) {
      if (!guard(state, "skipItem", "移走/跳过条目")) return;
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      if (isAd(item)) {
        deny(state, "移走条目", "08:30 广告不能挪，已拒绝");
        return;
      }
      if (isAired(item)) {
        deny(state, "移走条目", `「${item.title}」已播出，保持原位，已拒绝`);
        return;
      }
      state.history.unshift(takeSnapshot(state.items, state.makeup, "跳过条目", item.title));
      item.status = "已跳过";
      enqueueWhenOffline(state, "跳过条目", item.title);
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (!guard(state, "reorder", "调整顺序")) return;
      const next = action.payload;
      // 广告索引固定、不能跨段拖动、已播出条目必须留在原位
      const sameAdPlace = next.findIndex(isAd) === state.items.findIndex(isAd);
      const sameSegmentSets =
        state.items.filter((item) => segmentById(item.id) === "广告前").map((item) => item.id).sort().join() ===
        next.filter((item) => segmentById(item.id) === "广告前").map((item) => item.id).sort().join();
      const airedLocked = state.items.every((item, index) => !isAired(item) || next[index]?.id === item.id);
      if (!sameAdPlace || !sameSegmentSets || !airedLocked) {
        deny(state, "调整顺序", "广告位置固定、已播出内容保持原位、不能跨过广告拖动，已拒绝");
        return;
      }
      state.history.unshift(takeSnapshot(state.items, state.makeup, "调整顺序", "直播串联单顺序变化"));
      state.items = next;
    },
    /**
     * 突发插播：先出预案。
     * 容量不够直接拒绝（refusal 里列出缺几分钟），state 不变；
     * 接受后只压缩/移走后面的未播普通条目，插入突发条目，时间全部重算。
     */
    insertBreaking(state, action: PayloadAction<BreakingInput>) {
      if (!guard(state, "insertBreaking", "突发插播")) return;
      const plan = planBreaking(state.items, action.payload.insertAfter, action.payload.duration);
      if (!plan.feasible) {
        deny(state, "突发插播", plan.refusal ?? "剩余容量不足");
        return;
      }

      state.history.unshift(takeSnapshot(state.items, state.makeup, "突发插播", action.payload.headline));

      for (const change of plan.compressions) {
        const target = state.items.find((entry) => entry.id === change.item.id);
        if (target) target.duration = change.to;
      }
      const removedIds = new Set(plan.removals.map((item) => item.id));
      for (const item of plan.removals) {
        state.makeup.unshift({
          ...toPlain(item),
          status: "待补播",
          removedAt: new Date().toISOString(),
          removedFor: action.payload.headline
        });
      }

      const prefix = plan.segment === "广告前" ? "brk-pre-" : "brk-post-";
      const breakingItem: RundownItem = {
        id: `${prefix}${crypto.randomUUID()}`,
        title: `【突发】${action.payload.headline}`,
        type: "突发",
        duration: action.payload.duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${action.payload.reason}`
      };
      state.items = state.items.filter((item) => !removedIds.has(item.id));
      const insertAt = state.items.findIndex((item) => item.id === action.payload.insertAfter) + 1;
      state.items.splice(insertAt, 0, breakingItem);

      const record: BreakingChange = {
        id: crypto.randomUUID(),
        headline: action.payload.headline,
        duration: action.payload.duration,
        insertAfter: action.payload.insertAfter,
        anchorTitle: state.items[insertAt - 1]?.title ?? "",
        segment: plan.segment,
        reason: action.payload.reason,
        createdAt: new Date().toISOString(),
        compressed: plan.compressions.map((entry) => ({ id: entry.item.id, title: entry.item.title, from: entry.from, to: entry.to })),
        removed: plan.removals.map((item) => item.title)
      };
      state.changes.unshift(record);
      enqueueWhenOffline(state, "突发插播", action.payload.headline);
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      const snapshot: Snapshot = toPlain(last.snapshot);
      state.items = snapshot.items;
      state.makeup = snapshot.makeup;
    },
    queueChange(state, action: PayloadAction<{ action: string; detail: string }>) {
      state.queue.unshift({ ...action.payload, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
    },
    syncQueue(state) {
      state.queue = [];
    }
  }
});

export const {
  initialize,
  setRole,
  setOnline,
  addItem,
  editItem,
  markAired,
  reorder,
  insertBreaking,
  skipItem,
  undo,
  queueChange,
  syncQueue,
  clearDenials
} = slice.actions;
export { seed, POST_AD_TARGET };
export default slice.reducer;

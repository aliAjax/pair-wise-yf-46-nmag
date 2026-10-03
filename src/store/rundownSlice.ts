import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingChange, HistoryEntry, PendingChange, Role, RundownItem } from "../types";

// 直播窗口固定 08:00-09:00，共 60 分钟；08:30 广告为硬时间节点
const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 6, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 10, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 14, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" },
  { id: "r5", title: "国际新闻速览", type: "新闻片", duration: 12, status: "待播", presenter: "陈默", source: "国际部" },
  { id: "r6", title: "体育新闻", type: "新闻片", duration: 9, status: "待播", presenter: "陈默", source: "体育部" },
  { id: "r7", title: "天气预报", type: "口播", duration: 6, status: "待播", presenter: "陈默", source: "气象台" }
];

interface State {
  initialized: boolean;
  items: RundownItem[];
  makeup: RundownItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  role: Role;
  online: boolean;
  lastError: string | null;
}

const initialState: State = { initialized: false, items: seed, makeup: [], history: [], queue: [], changes: [], role: "导播", online: true, lastError: null };

function snapshot(items: RundownItem[], makeup: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: { items: structuredClone(items), makeup: structuredClone(makeup) } };
}

// 导播：全部权限；主编：可改未播内容；字幕/演播室：只读
function canEdit(role: Role): boolean {
  return role === "导播" || role === "主编";
}

function isAd(item: RundownItem): boolean {
  return item.type === "广告";
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
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    clearError(state) { state.lastError = null; },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      if (!canEdit(state.role)) { state.lastError = "当前岗位无新增条目权限"; return; }
      state.history.unshift(snapshot(state.items, state.makeup, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿" });
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      if (!canEdit(state.role)) { state.lastError = "当前岗位无播出操作权限"; return; }
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (item.status === "已播出") { state.lastError = "已播出内容不能重复操作"; return; }
      state.history.unshift(snapshot(state.items, state.makeup, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (state.role !== "导播") { state.lastError = "仅导播可调整串联单顺序"; return; }
      const oldAds = state.items.filter((i) => i.type === "广告").map((i) => i.id);
      const newAds = action.payload.filter((i) => i.type === "广告").map((i) => i.id);
      if (JSON.stringify(oldAds) !== JSON.stringify(newAds)) { state.lastError = "广告时段不能挪动"; return; }
      state.history.unshift(snapshot(state.items, state.makeup, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      if (!canEdit(state.role)) { state.lastError = "当前岗位无调整时长权限"; return; }
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (item.status === "已播出") { state.lastError = "已播出内容时长不能修改"; return; }
      if (isAd(item)) { state.lastError = "广告时长不能修改"; return; }
      state.history.unshift(snapshot(state.items, state.makeup, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      if (state.role !== "导播") { state.lastError = "仅导播可插播突发新闻"; return; }
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const index = state.items.findIndex((item) => item.id === change.insertAfter);
      if (index === -1) return;

      // 候选：插入点之后、未播出、非广告的普通条目（已播出内容和广告保持原位）
      // 从前往后腾时间：先压缩离插入点最近的条目（广告之前的条目压缩后广告仍在 08:30），
      // 压缩到 1 分钟仍不够再移走，确保广告时段不挪位
      const candidates = state.items.slice(index + 1).filter((item) =>
        (item.status === "待播" || item.status === "草稿") && !isAd(item)
      );

      let needToFree = change.duration;
      const movedIds: string[] = [];

      for (let i = 0; i < candidates.length && needToFree > 0; i++) {
        const candidate = candidates[i];
        const compressible = candidate.duration - 1;
        if (compressible >= needToFree) {
          candidate.duration -= needToFree;
          needToFree = 0;
        } else {
          needToFree -= candidate.duration;
          movedIds.push(candidate.id);
        }
      }

      // 剩余容量不够，直接拒绝并列出缺几分钟
      if (needToFree > 0) {
        state.lastError = `后续条目容量不足，还差 ${needToFree} 分钟`;
        return;
      }

      // 被移走的进入待补播清单
      if (movedIds.length) {
        const movedItems = state.items.filter((item) => movedIds.includes(item.id));
        state.makeup.unshift(...movedItems);
        state.items = state.items.filter((item) => !movedIds.includes(item.id));
      }

      // 插入突发新闻，时长改动后时间由 useTimeline 全部重算
      const insertIndex = state.items.findIndex((item) => item.id === change.insertAfter);
      state.items.splice(insertIndex + 1, 0, {
        id: crypto.randomUUID(),
        title: change.headline,
        type: "新闻片",
        duration: change.duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${change.reason}`
      });

      state.changes.unshift(change);
      state.history.unshift(snapshot(state.items, state.makeup, "突发插播", change.headline));

      if (!state.online) {
        state.queue.unshift({ id: crypto.randomUUID(), action: "突发插播", detail: change.headline, queuedAt: change.createdAt });
      }
    },
    skipItem(state, action: PayloadAction<string>) {
      if (!canEdit(state.role)) { state.lastError = "当前岗位无取消条目权限"; return; }
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      if (item.status === "已播出") { state.lastError = "已播出内容不能取消"; return; }
      if (isAd(item)) { state.lastError = "广告不能取消"; return; }
      state.history.unshift(snapshot(state.items, state.makeup, "取消条目", item.title));
      item.status = "已跳过";
      if (!state.online) state.queue.unshift({ id: crypto.randomUUID(), action: "取消条目", detail: item.title, queuedAt: new Date().toISOString() });
    },
    restoreMakeup(state, action: PayloadAction<string>) {
      if (!canEdit(state.role)) { state.lastError = "当前岗位无补播权限"; return; }
      const item = state.makeup.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, state.makeup, "恢复补播", item.title));
      state.makeup = state.makeup.filter((entry) => entry.id !== action.payload);
      state.items.push(item);
    },
    undo(state) {
      if (!canEdit(state.role)) { state.lastError = "当前岗位无撤回权限"; return; }
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(last.snapshot.items);
      state.makeup = structuredClone(last.snapshot.makeup);
    },
    queueChange(state, action: PayloadAction<{ action: string; detail: string }>) {
      state.queue.unshift({ ...action.payload, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
    },
    syncQueue(state) { state.queue = []; }
  }
});

export const { initialize, setRole, setOnline, clearError, addItem, updateStatus, reorder, adjustDuration, insertBreaking, skipItem, restoreMakeup, undo, queueChange, syncQueue } = slice.actions;
export default slice.reducer;

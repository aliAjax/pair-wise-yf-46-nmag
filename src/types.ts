export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告" | "突发";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿" | "待补播";
export type Segment = "广告前" | "广告后";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  /** 时长（分钟，整数） */
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
}

export interface Compression {
  id: string;
  title: string;
  from: number;
  to: number;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  anchorTitle: string;
  segment: Segment;
  reason: string;
  createdAt: string;
  /** 被压缩的普通条目 */
  compressed: Compression[];
  /** 被移走、进入待补播清单的条目标题 */
  removed: string[];
}

export interface MakeupItem extends RundownItem {
  removedAt: string;
  removedFor: string;
}

export interface PendingChange {
  id: string;
  action: string;
  detail: string;
  queuedAt: string;
}

export interface Snapshot {
  items: RundownItem[];
  makeup: MakeupItem[];
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: Snapshot;
}

export interface DenialEntry {
  id: string;
  action: string;
  detail: string;
  at: string;
}

/** 突发插播的腾挪预案：只允许压缩/移走插播点之后的未播普通条目 */
export interface BreakPlan {
  segment: Segment;
  anchorIndex: number;
  /** 后面未播普通条目可腾出的总分钟数（全部移走时） */
  freeable: number;
  /** 仅靠压缩（下限 1 分钟）能腾出的分钟数 */
  compressible: number;
  feasible: boolean;
  /** 不可行时还差几分钟 */
  shortage: number;
  refusal?: string;
  compressions: { item: RundownItem; from: number; to: number }[];
  removals: RundownItem[];
}

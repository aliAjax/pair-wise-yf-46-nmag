import type { BreakPlan, RundownItem, Segment } from "../types";

/** 开播 08:00、收播 09:00，窗口固定 60 分钟 */
export const ON_AIR_START_MINUTES = 8 * 60;
export const ON_AIR_END_MINUTES = 9 * 60;
export const AD_START_MINUTES = 8 * 60 + 30;
export const PRE_AD_TARGET = AD_START_MINUTES - ON_AIR_START_MINUTES; // 08:00–08:30 共 30 分钟
export const AD_DURATION = 3;
/** 08:30 广告不能挪，其余普通条目压缩下限为 1 分钟 */
export const MIN_ITEM_DURATION = 1;
export const AD_ID = "ad-0830";

export function isAd(item: RundownItem): boolean {
  return item.type === "广告" || item.id === AD_ID;
}

export function isAired(item: RundownItem): boolean {
  return item.status === "已播出";
}

export function isSkipped(item: RundownItem): boolean {
  return item.status === "已跳过";
}

/** 参与计时的条目：未播/已播出的非跳过条目；广告同样占时长且固定 */
export function isTimed(item: RundownItem): boolean {
  return !isSkipped(item) && item.status !== "待补播";
}

/** 可被突发插播压缩或移走：插播点之后的未播普通条目（非广告、非已播） */
export function isMovable(item: RundownItem): boolean {
  return !isAd(item) && item.status === "待播";
}

/** 通过 id 前缀判定片段，避免依赖运行时位置 */
export function segmentById(id: string): Segment {
  return id.startsWith("post-") || id.startsWith("brk-post-") ? "广告后" : "广告前";
}
/** 该段在串联单中的有效内容分钟数（跳过的条目计 0；广告单独计时，不计入任何一段） */
export function segmentEffectiveMinutes(items: RundownItem[], segment: Segment): number {
  return items
    .filter((item) => !isAd(item) && segmentById(item.id) === segment && isTimed(item))
    .reduce((sum, item) => sum + item.duration, 0);
}

export function adEffectiveMinutes(items: RundownItem[]): number {
  return items.find(isAd)?.duration ?? 0;
}

export interface TimelineRow {
  item: RundownItem;
  start: number;
  end: number;
  at: string;
}

export interface TimelineGap {
  start: number;
  end: number;
  minutes: number;
  segment: Segment;
}

export interface TimelineResult {
  rows: TimelineRow[];
  gaps: TimelineGap[];
  end: number;
  /** 预计收播晚于 09:00 的分钟数 */
  overrun: number;
  /** 08:30 广告被顶开的分钟数（必须始终为 0） */
  adDrift: number;
}

function fmt(start: number, end: number) {
  return {
    at: toClock(start),
    start,
    end
  };
}

export function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 接受插播/改动后，时间全部重算：
 * 08:00 顺序排到广告，广告必须在 08:30，广告后再排到 09:00。
 * 跳过的条目不占时长，形成可见空档。
 */
export function buildTimeline(items: RundownItem[]): TimelineResult {
  const rows: TimelineRow[] = [];
  const gaps: TimelineGap[] = [];
  const ad = items.find(isAd);
  let cursor = ON_AIR_START_MINUTES;

  const walk = (segment: Segment, boundary: number) => {
    for (const item of items.filter((entry) => !isAd(entry) && segmentById(entry.id) === segment)) {
      if (!isTimed(item)) {
        rows.push({ item, start: cursor, end: cursor, at: toClock(cursor) });
        continue;
      }
      rows.push({ item, ...fmt(cursor, cursor + item.duration) });
      cursor += item.duration;
    }
    if (cursor < boundary) {
      gaps.push({ start: cursor, end: boundary, minutes: boundary - cursor, segment });
      cursor = boundary;
    }
  };

  walk("广告前", AD_START_MINUTES);

  if (ad && isTimed(ad)) {
    rows.push({ item: ad, ...fmt(cursor, cursor + ad.duration) });
    cursor += ad.duration;
  } else if (ad) {
    rows.push({ item: ad, start: cursor, end: cursor, at: toClock(cursor) });
  }

  walk("广告后", ON_AIR_END_MINUTES);

  const adRow = ad ? rows.find((row) => row.item.id === ad.id) : undefined;
  const adDrift = adRow ? Math.max(0, adRow.start - AD_START_MINUTES) : 0;
  return { rows, gaps, end: cursor, overrun: Math.max(0, cursor - ON_AIR_END_MINUTES), adDrift };
}

/**
 * 突发插播预案：
 * - 只看插播点之后、同一段内还没播的普通条目；
 * - 已播出内容与广告保持原位；
 * - 先压缩（每条下限 1 分钟），再从后往前移走；
 * - 剩余容量不够则不可行，shortage 为所缺分钟数。
 */
export function planBreaking(items: RundownItem[], insertAfterId: string, duration: number): BreakPlan {
  const anchorIndex = items.findIndex((item) => item.id === insertAfterId);
  const anchor = items[anchorIndex];
  const fail = (refusal: string): BreakPlan => ({
    segment: anchor ? segmentById(anchor.id) : "广告前",
    anchorIndex,
    freeable: 0,
    compressible: 0,
    feasible: false,
    shortage: duration,
    refusal,
    compressions: [],
    removals: []
  });

  if (anchorIndex < 0) return fail("请选择有效的插播位置");
  if (duration <= 0) return fail("插播时长必须大于 0 分钟");

  const segment: Segment = isAd(anchor) ? "广告后" : segmentById(anchor.id);
  const later = items.filter(
    (item) => !isAd(item) && segmentById(item.id) === segment && items.indexOf(item) > anchorIndex && isMovable(item)
  );

  const freeable = later.reduce((sum, item) => sum + item.duration, 0);
  const compressible = later.reduce((sum, item) => sum + Math.max(0, item.duration - MIN_ITEM_DURATION), 0);

  if (freeable < duration) {
    return {
      segment,
      anchorIndex,
      freeable,
      compressible,
      feasible: false,
      shortage: duration - freeable,
      refusal: `后面的未播普通条目只能腾出 ${freeable} 分钟，还差 ${duration - freeable} 分钟。已播出内容和 08:30 广告不能挪。`,
      compressions: [],
      removals: []
    };
  }

  // 先压缩：从前往后，每条压到下限，直到凑够
  let need = duration;
  const compressions: BreakPlan["compressions"] = [];
  for (const item of later) {
    if (need <= 0) break;
    const give = Math.min(need, item.duration - MIN_ITEM_DURATION);
    if (give > 0) {
      compressions.push({ item, from: item.duration, to: item.duration - give });
      need -= give;
    }
  }

  // 压缩到极限仍不够，再从后面的条目尾部整条移走。
  // 已被压缩的条目被移走时，还能再释放它保留的下限时长（通常为 1 分钟）。
  const removals: RundownItem[] = [];
  for (let i = later.length - 1; i >= 0 && need > 0; i--) {
    const item = later[i];
    const index = compressions.findIndex((entry) => entry.item.id === item.id);
    const stillKept = index >= 0 ? compressions[index].to : item.duration;
    removals.unshift(item);
    if (index >= 0) compressions.splice(index, 1);
    need -= stillKept;
  }

  return {
    segment,
    anchorIndex,
    freeable,
    compressible,
    feasible: true,
    shortage: 0,
    compressions,
    removals
  };
}

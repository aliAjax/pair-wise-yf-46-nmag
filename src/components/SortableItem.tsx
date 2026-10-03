import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag } from "antd";
import type { Role, RundownItem } from "../types";

interface Props {
  item: RundownItem;
  cumulative: string;
  role: Role;
  onStatus: () => void;
  onSkip: () => void;
  onDuration: (delta: number) => void;
}

export function SortableItem({ item, cumulative, role, onStatus, onSkip, onDuration }: Props) {
  const isAd = item.type === "广告";
  const isBroadcast = item.status === "已播出";
  const canEdit = role === "导播" || role === "主编";
  // 仅导播可拖拽排序；广告和已播出内容不可挪动
  const canDrag = role === "导播" && !isAd && !isBroadcast;

  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: item.id,
    disabled: !canDrag
  });

  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button
        className="drag-handle"
        {...attributes}
        {...listeners}
        style={{ cursor: canDrag ? "grab" : "not-allowed", opacity: canDrag ? 1 : 0.35 }}
        title={isAd ? "广告时段不可挪动" : isBroadcast ? "已播出内容不可挪动" : "拖拽调整顺序"}
      >
        {isAd ? "🔒" : "⠿"}
      </button>
      <time>{cumulative}</time>
      <div className="row-main"><b>{item.title}</b><small>{item.source} · {item.presenter}</small></div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        <Button size="small" onClick={() => onDuration(-1)} disabled={!canEdit || isAd || isBroadcast}>-1</Button>
        <Button size="small" onClick={() => onDuration(1)} disabled={!canEdit || isAd || isBroadcast}>+1</Button>
        <Button size="small" type="primary" disabled={!canEdit || isBroadcast} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={!canEdit || isAd || isBroadcast} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}

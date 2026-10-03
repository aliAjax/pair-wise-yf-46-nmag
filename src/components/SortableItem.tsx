import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import { isAd, isSkipped } from "../store/domain";
import type { Role, RundownItem } from "../types";

const TYPE_COLOR: Record<RundownItem["type"], string> = {
  新闻片: "geekblue",
  连线: "blue",
  嘉宾: "cyan",
  口播: "default",
  广告: "gold",
  突发: "volcano"
};

interface Props {
  item: RundownItem;
  cumulative: string;
  role: Role;
  onStatus: () => void;
  onSkip: () => void;
  onEdit: () => void;
}

export function SortableItem({ item, cumulative, role, onStatus, onSkip, onEdit }: Props) {
  const aired = item.status === "已播出";
  const ad = isAd(item);
  const canDrag = role === "导播" && !aired;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: !canDrag });

  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status}${ad ? " is-ad" : ""}${item.type === "突发" ? " is-breaking" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button
        className="drag-handle"
        {...(canDrag ? { ...attributes, ...listeners } : {})}
        disabled={!canDrag}
        title={canDrag ? "拖动调整（不能跨过广告）" : role === "导播" ? "已播出内容保持原位" : "仅导播可调整顺序"}
      >
        ⠿
      </button>
      <time>{isSkipped(item) ? "—" : cumulative}</time>
      <div className="row-main">
        <b>{item.title}</b>
        <small>{item.source} · {item.presenter}</small>
      </div>
      <Tag color={TYPE_COLOR[item.type]}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={aired ? "green" : item.status === "已跳过" ? "red" : item.status === "待补播" ? "orange" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        {ad ? (
          <Tooltip title="08:30 广告不能挪、不能改"><Tag color="gold" className="locked-tag">🔒 固定</Tag></Tooltip>
        ) : aired ? (
          <Tag color="green" className="locked-tag">已锁定</Tag>
        ) : (
          <>
            <Button size="small" onClick={onEdit}>编辑</Button>
            {role === "导播" && <Button size="small" type="primary" onClick={onStatus}>播出</Button>}
            {role === "导播" && <Button size="small" danger onClick={onSkip}>移走</Button>}
          </>
        )}
      </div>
    </article>
  );
}

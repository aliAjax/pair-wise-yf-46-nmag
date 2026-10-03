import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Tag,
  Timeline,
  message
} from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addItem,
  clearDenials,
  editItem,
  initialize,
  insertBreaking,
  markAired,
  reorder,
  setOnline,
  setRole,
  skipItem,
  syncQueue,
  undo
} from "./store/rundownSlice";
import {
  AD_START_MINUTES,
  ON_AIR_END_MINUTES,
  buildTimeline,
  isAd,
  isTimed,
  planBreaking,
  segmentById,
  toClock
} from "./store/domain";
import type { ItemType, Role, RundownItem } from "./types";
import type { EditorDraft } from "./store/rundownSlice";

const TYPES: ItemType[] = ["新闻片", "连线", "嘉宾", "口播"];

const schema = z.object({
  title: z.string().min(2, "标题至少 2 个字"),
  type: z.enum(["新闻片", "连线", "嘉宾", "口播"]),
  duration: z.number().min(1, "至少 1 分钟").max(30, "单条不超过 30 分钟"),
  presenter: z.string().min(1, "填写主播"),
  source: z.string().min(1, "填写来源")
});
type FormValues = z.infer<typeof schema>;

/** 所有越权拒绝集中弹窗提示，切片中同时留痕 */
function useDenialToaster() {
  const dispatch = useAppDispatch();
  const denials = useAppSelector((state) => state.rundown.denials);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (denials.length > seen) {
      denials.slice(0, denials.length - seen).reverse().forEach((entry) => {
        message.error({ content: `已拒绝 · ${entry.action}：${entry.detail}`, duration: 4 });
      });
    }
    setSeen(denials.length);
  }, [denials, seen]);
  return () => dispatch(clearDenials());
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online } = useAppSelector((state) => state.rundown);
  const [saveMutation] = useSaveRundownMutation();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = useMemo(() => buildTimeline(items), [items]);
  const timedTotal = items.filter(isTimed).reduce((sum, item) => sum + item.duration, 0);
  const adRow = timeline.rows.find((row) => isAd(row.item));
  const adDrift = adRow ? Math.max(0, adRow.start - AD_START_MINUTES) : 0;
  const [editing, setEditing] = useState<RundownItem | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { void saveMutation(items); }, 250);
    return () => clearTimeout(timer);
  }, [items, saveMutation]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const startAt = useMemo(() => {
    const map = new Map(timeline.rows.map((row) => [row.item.id, row.at]));
    return (id: string) => map.get(id) ?? "--:--";
  }, [timeline.rows]);

  return (
    <div className="page-grid">
      <Card className="main-card">
        <div className="card-heading">
          <div>
            <small>2026-10-08 · 08:00–09:00 固定窗口 · 广告 08:30 不可挪动</small>
            <h2>直播串联单</h2>
          </div>
          <div className="head-actions">
            <Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag>
            <Button onClick={() => dispatch(undo())} disabled={role === "字幕" || role === "演播室"}>一键撤回上一步</Button>
          </div>
        </div>

        <div className="summary">
          <span><b>{items.length}</b> 条内容</span>
          <span><b>{timedTotal}</b> 分钟（窗口 60）</span>
          <span className={adDrift ? "danger-text" : ""}><b>{toClock(adRow?.start ?? AD_START_MINUTES)}</b> 广告实际起点{adDrift ? `（漂移 ${adDrift} 分钟）` : " · 锁定 08:30"}</span>
          <span className={timeline.overrun ? "danger-text" : ""}><b>{toClock(Math.max(timeline.end, ON_AIR_END_MINUTES))}</b> {timeline.overrun ? `超时 ${timeline.overrun} 分钟` : "预计收播"}</span>
        </div>

        {timeline.gaps.length > 0 && (
          <Alert
            className="gap-alert"
            type="warning"
            showIcon
            message={`存在 ${timeline.gaps.reduce((s, g) => s + g.minutes, 0)} 分钟空档（条目被移走/跳过后的位置，等待补播）`}
          />
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            <div className="rundown-list">
              {timeline.rows.map(({ item }) => (
                <SortableItem
                  key={item.id}
                  item={item}
                  cumulative={startAt(item.id)}
                  role={role}
                  onStatus={() => dispatch(markAired(item.id))}
                  onSkip={() => dispatch(skipItem(item.id))}
                  onEdit={() => setEditing(item)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </Card>

      <aside className="side-stack">
        <AddItemCard />
        <BreakingForm />
      </aside>

      {editing && <EditItemModal item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AddItemCard() {
  const dispatch = useAppDispatch();
  const role = useAppSelector((state) => state.rundown.role);
  const items = useAppSelector((state) => state.rundown.items);
  const postFree = useMemo(
    () => 60 - (AD_START_MINUTES - 8 * 60) - 3 - items.filter((i) => !isAd(i) && segmentById(i.id) === "广告后" && isTimed(i)).reduce((s, i) => s + i.duration, 0),
    [items]
  );
  const { control, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", type: "新闻片", duration: 3, presenter: "陈默", source: "主控" }
  });

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    reset();
  };

  return (
    <Card title="新增播出条目（主编）">
      <p className="hint">新条目追加到广告后尾部；窗口固定，广告后当前剩余 <b>{postFree}</b> 分钟，放不下会拒绝并提示缺口。</p>
      <Form layout="vertical" onFinish={handleSubmit(submit)}>
        <Form.Item label="标题">
          <Controller name="title" control={control} render={({ field, fieldState }) => (
            <>
              <Input {...field} status={fieldState.error ? "error" : ""} placeholder="至少 2 个字" />
              <small className="error">{fieldState.error?.message}</small>
            </>
          )} />
        </Form.Item>
        <div className="two-cols">
          <Form.Item label="类型">
            <Controller name="type" control={control} render={({ field }) => (
              <Select {...field} options={TYPES.map((v) => ({ value: v, label: v }))} />
            )} />
          </Form.Item>
          <Form.Item label="时长">
            <Controller name="duration" control={control} render={({ field, fieldState }) => (
              <>
                <InputNumber {...field} min={1} max={30} addonAfter="分钟" status={fieldState.error ? "error" : ""} />
                <small className="error">{fieldState.error?.message}</small>
              </>
            )} />
          </Form.Item>
        </div>
        <Form.Item label="主播">
          <Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} />
        </Form.Item>
        <Form.Item label="来源">
          <Controller name="source" control={control} render={({ field }) => <Input {...field} />} />
        </Form.Item>
        <Button htmlType="submit" type="primary" block disabled={role !== "主编"}>
          {role === "主编" ? "加入广告后尾部" : `当前岗位「${role}」无权新增`}
        </Button>
      </Form>
    </Card>
  );
}

function EditItemModal({ item, onClose }: { item: RundownItem; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const role = useAppSelector((state) => state.rundown.role);
  const [form] = Form.useForm<EditorDraft>();
  const readOnly = role !== "主编";

  const submit = () => {
    form.validateFields().then((draft) => {
      dispatch(editItem({ id: item.id, draft }));
      onClose();
    }).catch(() => undefined);
  };

  return (
    <Modal
      open
      title={`编辑未播条目${readOnly ? "（只读）" : ""}`}
      onCancel={onClose}
      onOk={submit}
      okText="保存修改"
      cancelText="关闭"
      okButtonProps={{ disabled: readOnly }}
    >
      {readOnly && <Alert type="error" showIcon message={`岗位「${role}」无权修改编排内容，任何保存都会被拒绝并留痕。`} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" disabled={readOnly} initialValues={{
        title: item.title,
        duration: item.duration,
        presenter: item.presenter,
        source: item.source
      }}>
        <Form.Item name="title" label="标题" rules={[{ required: true, min: 2, message: "标题至少 2 个字" }]}><Input /></Form.Item>
        <Form.Item name="duration" label="时长（分钟，下限 1；不得顶到广告/收播）" rules={[{ required: true }]}>
          <InputNumber min={1} max={60} addonAfter="分钟" />
        </Form.Item>
        <Form.Item name="presenter" label="主播" rules={[{ required: true, message: "填写主播" }]}><Input /></Form.Item>
        <Form.Item name="source" label="来源" rules={[{ required: true, message: "填写来源" }]}><Input /></Form.Item>
      </Form>
    </Modal>
  );
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, role, online } = useAppSelector((state) => state.rundown);
  const [headline, setHeadline] = useState("");
  const [duration, setDuration] = useState(5);
  const [reason, setReason] = useState("突发新闻");
  const [insertAfter, setInsertAfter] = useState<string>("");

  useEffect(() => {
    if (!insertAfter) {
      const lastAired = [...items].reverse().find((item) => item.status === "已播出");
      setInsertAfter(lastAired?.id ?? items[0]?.id ?? "");
    }
  }, [items, insertAfter]);

  const plan = useMemo(
    () => (insertAfter ? planBreaking(items, insertAfter, Math.max(1, duration || 0)) : null),
    [items, insertAfter, duration]
  );

  const anchorOptions = items.map((item) => ({
    value: item.id,
    label: `${isAd(item) ? "🔒" : ""}插在「${item.title}」后（${segmentById(item.id) === "广告前" || isAd(item) ? "广告前段" : "广告后段"}）`
  }));

  const submit = () => {
    dispatch(insertBreaking({ headline, duration, insertAfter, reason }));
    setHeadline("");
  };

  return (
    <Card title="突发插播（导播）" className="breaking-card">
      <p className="hint">规则：只压缩/移走插播点之后未播的普通条目（下限 1 分钟）；已播出内容和 08:30 广告保持原位；容量不够直接拒绝。接受后时间全部重算，被移走条目进入待补播清单。</p>
      <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="突发标题" />
      <div className="two-cols">
        <InputNumber value={duration} onChange={(v) => setDuration(Number(v ?? 1))} min={1} max={60} addonAfter="分钟" />
        <Select value={insertAfter} onChange={setInsertAfter} options={anchorOptions} showSearch optionFilterProp="label" />
      </div>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="插播原因" />

      {plan && !plan.feasible && (
        <Alert type="error" showIcon message={`容量不足：后面未播普通条目最多腾出 ${plan.freeable} 分钟，插播需要 ${duration} 分钟，缺 ${plan.shortage} 分钟。不能动已播内容和广告。`} />
      )}
      {plan && plan.feasible && (
        <Alert
          type="success"
          showIcon
          message={`可插播：将压缩 ${plan.compressions.length} 条（${plan.compressions.map((c) => `${c.item.title} ${c.from}→${c.to}`).join("；") || "无"}）${plan.removals.length ? `，移走 ${plan.removals.length} 条（${plan.removals.map((i) => i.title).join("、")}，进入待补播）` : ""}`}
        />
      )}

      <Button
        type="primary"
        danger
        block
        disabled={headline.trim().length < 2 || !plan?.feasible || role !== "导播"}
        onClick={submit}
      >
        {role !== "导播" ? `岗位「${role}」无权插播` : plan && !plan.feasible ? `容量不足，缺 ${plan.shortage} 分钟，无法插播` : "接受预案并重算时间"}
      </Button>
      {!online && <small className="offline-note">离线：操作进入本地应急队列，主链路恢复后统一提交。</small>}
    </Card>
  );
}

function ChangesPage() {
  const changes = useAppSelector((state) => state.rundown.changes);
  return (
    <Card title="突发变更记录">
      {changes.length === 0 ? <Empty description="还没有突发插播" /> : (
        <Timeline items={changes.map((item) => ({
          color: "red",
          children: (
            <div>
              <b>【突发】{item.headline}</b>
              <p>{item.reason} · 插播 {item.duration} 分钟 · 位于{item.segment}（锚点：{item.anchorTitle}）· {format(new Date(item.createdAt), "MM-dd HH:mm:ss")}</p>
              <div className="plan-tags">
                {item.compressed.map((c) => <Tag key={c.id} color="orange">压缩 {c.title} {c.from}→{c.to} 分钟</Tag>)}
                {item.removed.map((title) => <Tag key={title} color="red">移走 {title} → 待补播</Tag>)}
              </div>
            </div>
          )
        }))} />
      )}
    </Card>
  );
}

function MakeupPage() {
  const makeup = useAppSelector((state) => state.rundown.makeup);
  return (
    <Card title="待补播清单">
      <p className="hint">突发插播时被整条移走的普通条目进入此清单；已播出内容和广告永远不会出现在这里。</p>
      {makeup.length === 0 ? <Empty description="暂无待补播条目" /> : (
        <div className="makeup-list">
          {makeup.map((item) => (
            <article key={`${item.id}-${item.removedAt}`}>
              <div>
                <b>{item.title}</b>
                <small>{item.type} · {item.duration} 分钟 · {item.source} · {item.presenter}</small>
              </div>
              <div className="makeup-meta">
                <Tag color="orange">待补播</Tag>
                <small>因「{item.removedFor}」移走 · {format(new Date(item.removedAt), "HH:mm:ss")}</small>
              </div>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}

function QueuePage() {
  const state = useAppSelector((root) => root.rundown);
  const dispatch = useAppDispatch();
  return (
    <Card title="本地应急队列">
      <div className="queue-list">
        {state.queue.length ? state.queue.map((item) => (
          <article key={item.id}>
            <Tag color="red">{item.action}</Tag>
            <b>{item.detail}</b>
            <small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small>
          </article>
        )) : <p>当前没有待同步操作。</p>}
      </div>
      <Button type="primary" disabled={state.online} onClick={() => { dispatch(syncQueue()); message.success("应急队列已同步"); }}>主链路恢复后提交</Button>
    </Card>
  );
}

function HistoryPage() {
  const history = useAppSelector((state) => state.rundown.history);
  const dispatch = useAppDispatch();
  return (
    <Card
      title="操作历史（可一键撤回，恢复被移走条目）"
      extra={<Button onClick={() => dispatch(undo())} disabled={!history.length}>撤回上一步</Button>}
    >
      <Timeline items={history.map((entry) => ({
        color: "blue",
        children: (
          <div>
            <b>{entry.label}</b>
            <p>{entry.detail}</p>
            <small>{format(new Date(entry.time), "MM-dd HH:mm:ss")}</small>
          </div>
        )
      }))} />
    </Card>
  );
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  const clearDenialToasts = useDenialToaster();

  useEffect(() => {
    if (data.length) dispatch(initialize(data));
  }, [data, dispatch]);

  const navItems = [
    { to: "/", key: "rundown", label: t("rundown"), badge: 0 },
    { to: "/changes", key: "changes", label: t("changes"), badge: state.changes.length },
    { to: "/makeup", key: "makeup", label: t("makeup"), badge: state.makeup.length },
    { to: "/queue", key: "queue", label: t("queue"), badge: state.queue.length },
    { to: "/history", key: "history", label: t("history"), badge: 0 }
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>LIVE</span>
          <div><b>{t("title")}</b><small>Control room</small></div>
        </div>
        <nav>
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}>
              {item.label} {item.badge ? <em>{item.badge}</em> : null}
            </NavLink>
          ))}
        </nav>
        <Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>
          {i18n.language === "zh" ? "EN" : "中文"}
        </Button>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <small>直播运行中 · 08:00–09:00 固定窗口 · 紧急操作均保留审计记录</small>
            <h1>{t("title")}</h1>
          </div>
          <div className="top-actions">
            <label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label>
            <label>
              当前岗位
              <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} style={{ width: 100 }}
                options={[{ value: "导播" }, { value: "主编" }, { value: "字幕" }, { value: "演播室" }]} />
            </label>
            <Button size="small" onClick={clearDenialToasts}>清除拒绝提示</Button>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<RundownPage />} />
          <Route path="/changes" element={<ChangesPage />} />
          <Route path="/makeup" element={<MakeupPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/history" element={<HistoryPage />} />
        </Routes>
      </main>
    </div>
  );
}

import { CSSProperties, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { COMMITTEE_ROLES, User, downloadAttachment, request, uploadAttachment } from "../api";
import { button, card, colors, input, tabButton } from "../styles";

const MAX_FILE = 20 * 1024 * 1024;

export interface Task {
  id: number;
  title: string;
  description: string;
  due_date: string | null;
  importance: number;
  creator_id: number;
  creator_name: string;
  assignee_id: number;
  assignee_name: string;
  assigned_by_committee: number;
  attachment_id: string | null;
  attachment_name: string | null;
  status: string;
  done_at: string | null;
  created_at: string;
  edited_at: string | null;
  comments_count: number;
  for_all: number;
  done_count: number;
  members_total: number;
  viewers: { user_id: number; can_edit: number; is_executor: number; name: string }[];
  needs_confirm: number;
  assigned_by_admin: number;
  color: string | null;
  card_color?: string | null;
  confirm_condition: string | null;
  reminders: string[];
  subtasks: { id: number; title: string; done: number; importance: number; assignee_id: number | null; assignee_name: string | null }[];
}

interface Member {
  id: number;
  full_name: string;
  role: string;
}

interface HistoryChange {
  f: string;
  from: string | null;
  to: string | null;
}

interface HistoryEntry {
  id: number;
  created_at: string;
  user_name: string;
  changes: HistoryChange[];
}

// Что было и что стало для одного изменения в истории
function changeView(c: HistoryChange): { label: string; before: string; after: string } {
  const dash = "—";
  switch (c.f) {
    case "title":
      return { label: "Название", before: c.from ?? dash, after: c.to ?? dash };
    case "description":
      return {
        label: "Описание",
        before: c.from === null ? "не сохранялось" : c.from === "" ? "пусто" : c.from,
        after: c.to === "" ? "пусто" : c.to ?? dash,
      };
    case "due_date":
      return { label: "Срок", before: c.from ? formatDate(c.from) : "без срока", after: c.to ? formatDate(c.to) : "без срока" };
    case "importance":
      return { label: "Важность", before: `${c.from} из 5`, after: `${c.to} из 5` };
    case "assignee":
      return { label: "Исполнитель", before: c.from ?? dash, after: c.to ?? dash };
    case "viewers":
      return { label: "Видят", before: c.from ?? "никто", after: c.to ?? "никто" };
    case "attachment":
      return { label: "Файл", before: c.from ?? "нет", after: c.to ?? "нет" };
    case "reminder_add":
      return { label: "Напоминание", before: dash, after: formatWhen(c.to ?? "") };
    case "reminder_remove":
      return { label: "Напоминание", before: formatWhen(c.from ?? ""), after: dash };
    case "subtask_add":
      return { label: "Подпункт", before: dash, after: c.to ?? dash };
    case "subtask_rename":
      return { label: "Подпункт", before: c.from ?? dash, after: c.to ?? dash };
    case "subtask_remove":
      return { label: "Подпункт", before: c.from ?? dash, after: dash };
    default:
      return { label: "Изменено", before: dash, after: dash };
  }
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  author_id: number;
  author_name: string;
}

type Scope = "mine" | "assigned" | "available" | "all";
type View = "list" | "board" | "calendar";

const SCOPES: [Scope, string][] = [
  ["mine", "Мне"],
  ["assigned", "Я назначил"],
  ["available", "Доступные мне"],
  ["all", "Все"],
];
const VIEWS: [View, string][] = [
  ["list", "Список"],
  ["board", "Доска"],
  ["calendar", "Календарь"],
];

const linkButton: CSSProperties = { background: "none", border: "none", color: colors.blue, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 14 };

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Для поля «дата и время»: ISO из базы -> локальное время браузера, и обратно
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function isOverdue(t: Task): boolean {
  return t.status === "open" && !!t.due_date && t.due_date < todayIso();
}

function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 2, flexShrink: 0 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(n);
          }}
          aria-label={`Важность ${n}`}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            fontSize: 18,
            lineHeight: 1,
            color: n <= value ? colors.yellow : "rgba(255,255,255,0.25)",
            cursor: onChange ? "pointer" : "default",
          }}
        >
          ★
        </button>
      ))}
    </span>
  );
}

function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", marginBottom: 0, padding: 20, boxSizing: "border-box" }}
      >
        {children}
      </div>
    </div>
  );
}

type SortField = "due" | "importance" | "title" | "created";
interface SortLevel {
  field: SortField;
  dir: "asc" | "desc";
}
const SORT_LABELS: Record<SortField, string> = { due: "Срок", importance: "Важность", title: "Название", created: "Дата создания" };

// Сравнение по нескольким уровням сразу: сначала первый, при равенстве — следующий. Пустые значения всегда внизу
function compareBy<T>(levels: SortLevel[], get: (item: T, field: SortField) => string | number | null): (a: T, b: T) => number {
  return (a, b) => {
    for (const lv of levels) {
      const va = get(a, lv.field);
      const vb = get(b, lv.field);
      if (va === vb) continue;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "ru");
      if (r !== 0) return lv.dir === "asc" ? r : -r;
    }
    return 0;
  };
}

const taskSortValue = (t: Task, f: SortField): string | number | null =>
  f === "due" ? t.due_date : f === "importance" ? t.importance : f === "title" ? t.title : t.created_at;

// У подпункта нет срока; дата создания — порядок добавления (id растёт)
const subSortValue = (s: { id: number; title: string; importance: number }, f: SortField): string | number | null =>
  f === "importance" ? s.importance : f === "title" ? s.title : f === "created" ? s.id : null;

function SortBar({ levels, onChange }: { levels: SortLevel[]; onChange: (l: SortLevel[]) => void }) {
  function update(i: number, patch: Partial<SortLevel>) {
    onChange(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  if (levels.length === 0) {
    return (
      <div style={{ marginBottom: 10 }}>
        <button type="button" onClick={() => onChange([{ field: "due", dir: "asc" }])} style={{ ...tabButton(false), padding: "6px 12px" }}>
          Сортировка
        </button>
      </div>
    );
  }
  return (
    <div style={{ ...card, padding: 10, marginBottom: 12 }}>
      {levels.map((lv, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: colors.gray, minWidth: 56 }}>Сортировка</span>
          <select style={{ ...input, width: "auto", margin: 0 }} value={lv.field} onChange={(e) => update(i, { field: e.target.value as SortField })}>
            {(Object.keys(SORT_LABELS) as SortField[])
              .filter((f) => f === lv.field || !levels.some((l) => l.field === f))
              .map((f) => (
                <option key={f} value={f}>
                  {SORT_LABELS[f]}
                </option>
              ))}
          </select>
          <button type="button" onClick={() => update(i, { dir: lv.dir === "asc" ? "desc" : "asc" })} style={{ ...tabButton(false), padding: "6px 12px" }}>
            {lv.dir === "asc" ? "↑ по возрастанию" : "↓ по убыванию"}
          </button>
          <button type="button" onClick={() => onChange(levels.filter((_, j) => j !== i))} style={linkButton}>
            убрать
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([])} style={linkButton}>
        Сбросить сортировку
      </button>
    </div>
  );
}

function TaskCard({
  task,
  onOpen,
  onEdit,
  onChanged,
  sortLevels = [],
}: {
  task: Task;
  onOpen: (id: number) => void;
  onEdit: (task: Task) => void;
  onChanged: () => void;
  sortLevels?: SortLevel[];
}) {
  const done = task.status === "done";
  const overdue = isOverdue(task);
  const [showAllSubs, setShowAllSubs] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  async function saveColor(color: string | null) {
    setColorOpen(false);
    const { status } = await request(`/api/tasks/${task.id}/color`, "PUT", { color });
    if (status === 200) onChanged();
  }
  // Отметка выполнения прямо из списка; нет прав — сервер ответит ошибкой, и ничего не меняется
  async function toggleDone(v: boolean) {
    const { status } = await request(`/api/tasks/${task.id}/status`, "PUT", { done: v });
    if (status === 200) onChanged();
  }
  async function toggleSub(id: number, v: boolean) {
    const { status } = await request(`/api/subtasks/${id}`, "PUT", { done: v });
    if (status === 200) onChanged();
  }
  // Пункты списком под задачей: важные выше, больше пяти — свёрнуты
  // Без сортировки списка — пункты по важности, как раньше
  const subs = [...task.subtasks].sort(
    compareBy(sortLevels.length ? sortLevels : [{ field: "importance", dir: "desc" }], subSortValue),
  );
  const shownSubs = showAllSubs || subs.length <= 5 ? subs : subs.slice(0, 5);
  return (
    <div
      onClick={() => onOpen(task.id)}
      style={{
        ...card,
        padding: 14,
        marginBottom: 8,
        cursor: "pointer",
        opacity: done ? 0.6 : 1,
        boxSizing: "border-box",
        borderLeft: task.color ? `6px solid ${task.color}` : card.borderLeft,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
          <SquareCheck checked={done} title="Выполнено" onToggle={(v) => void toggleDone(v)} />
          <b style={{ overflowWrap: "anywhere", textDecoration: done ? "line-through" : "none" }}>{task.title}</b>
        </div>
        {/* Клики по меню не должны открывать задачу */}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <Stars value={task.importance} />
          <MoreMenu
            items={[
              { label: "Открыть", onClick: () => onOpen(task.id) },
              { label: "Редактировать", onClick: () => onEdit(task) },
              { label: "Цвет задачи", onClick: () => setColorOpen((v) => !v) },
              ...(task.color ? [{ label: "Вернуть без цвета", onClick: () => void saveColor(null) }] : []),
              { label: "Удалить задачу", onClick: () => void removeTask(task.id, onChanged), danger: true },
            ]}
          />
        </div>
      </div>
      {colorOpen && (
        <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <ColorPicker value={task.color} onChange={(c) => void saveColor(c)} onReset={() => void saveColor(null)} />
        </div>
      )}
      <div style={{ fontSize: 13, color: colors.blue, marginTop: 4 }}>
        Исполнитель: {task.for_all === 1 ? "Весь отряд" : task.assignee_name} · Автор: {task.creator_name}
        {task.for_all === 1 ? ` · выполнили ${task.done_count} из ${task.members_total}` : ""}
      </div>
      <div style={{ fontSize: 13, marginTop: 4, color: overdue ? "#ff8a8a" : colors.blue }}>
        {task.due_date ? `Срок: ${formatDate(task.due_date)}${overdue ? " · просрочено" : ""}` : "Без срока"}
        {task.reminders.length ? ` · напоминаний: ${task.reminders.length}` : ""}
        {task.subtasks.length ? ` · подпункты ${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}` : ""}
        {task.comments_count ? ` · комментариев: ${task.comments_count}` : ""}
        {task.edited_at ? " · редактировано" : ""}
      </div>
      {subs.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${colors.gray}` }}>
          {shownSubs.map((sub) => (
            <div key={sub.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 3 }}>
              <SquareCheck checked={!!sub.done} title="Выполнено" onToggle={(v) => void toggleSub(sub.id, v)} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflowWrap: "anywhere",
                  color: sub.done ? colors.gray : colors.white,
                  textDecoration: sub.done ? "line-through" : "none",
                }}
              >
                {sub.title}
                {sub.assignee_name && <span style={{ fontSize: 12, color: colors.gray }}> · {sub.assignee_name}</span>}
              </span>
              <Stars value={sub.importance} />
            </div>
          ))}
          {subs.length > 5 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowAllSubs((v) => !v);
              }}
              style={{ ...linkButton, fontSize: 13 }}
            >
              {showAllSubs ? "Свернуть" : `Развернуть все (${subs.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryModal({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    request(`/api/tasks/${taskId}/history`)
      .then(({ status, data }) => {
        if (status === 200) setEntries(data.history ?? []);
        else setErr(data.error ?? "Не удалось загрузить историю");
      })
      .catch(() => setErr("Нет связи с сервером"));
  }, [taskId]);
  return (
    <Overlay onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0 }}>История изменений</h3>
        <button type="button" onClick={onClose} aria-label="Закрыть" style={linkButton}>
          ✕
        </button>
      </div>
      {err && <p style={{ color: "#ff8a8a" }}>{err}</p>}
      {!entries && !err && <p style={{ color: colors.gray }}>Загрузка…</p>}
      {entries && entries.length === 0 && <p style={{ color: colors.gray }}>Изменений пока нет.</p>}
      {entries?.map((e) => (
        <div key={e.id} style={{ borderLeft: `3px solid ${colors.blue}`, paddingLeft: 10, marginTop: 12 }}>
          <div style={{ fontSize: 13, color: colors.blue }}>
            {formatWhen(e.created_at)} · <b>{e.user_name}</b>
          </div>
          {e.changes.map((c, i) => {
            const v = changeView(c);
            return (
              <div key={i} style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, color: colors.blue }}>{v.label}</div>
                <div style={{ fontSize: 14, color: colors.gray }}>
                  было:{" "}
                  <span style={{ color: colors.white, textDecoration: "line-through", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v.before}</span>
                </div>
                <div style={{ fontSize: 14, color: colors.gray }}>
                  стало:{" "}
                  <span style={{ color: colors.yellow, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v.after}</span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </Overlay>
  );
}

function TaskDetail({
  task,
  viewer,
  onChanged,
  onEdit,
  onDeleted,
  onClose,
}: {
  task: Task;
  viewer: User;
  onChanged: () => void;
  onEdit: () => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [reminders, setReminders] = useState<string[]>(task.reminders.map((r) => toLocalInput(r)));
  const [newSub, setNewSub] = useState("");
  const [newSubImp, setNewSubImp] = useState(3);
  const [newSubAssignee, setNewSubAssignee] = useState("");
  const [subsLocal, setSubsLocal] = useState(task.subtasks);
  const [showAllSubs, setShowAllSubs] = useState(false);
  useEffect(() => setSubsLocal(task.subtasks), [task]);
  const [showHistory, setShowHistory] = useState(false);
  const [err, setErr] = useState("");
  const isCreator = task.creator_id === viewer.id;
  // Исполнители — видящие, отмеченные как исполнитель
  const executors = task.viewers.filter((v) => v.is_executor === 1);
  const isAssignee = task.assignee_id === viewer.id || executors.some((v) => v.user_id === viewer.id);
  const committeeViewer = COMMITTEE_ROLES.includes(viewer.role);
  const needsCheck = task.for_all !== 1 && (task.needs_confirm === 1 || task.assigned_by_committee === 1 || task.assigned_by_admin === 1 || executors.length > 1);
  // Подтверждает: при нескольких исполнителях — создатель, иначе — комсостав (для задач комсостава и с галочкой)
  const confirmer =
    executors.length > 1 || task.assigned_by_admin === 1
      ? isCreator
      : (task.assigned_by_committee === 1 || task.needs_confirm === 1) && committeeViewer;
  const markDone = task.status === "open" || (task.status === "waiting" && confirmer);
  // Кого можно назначить на пункт: только те, кто добавлен в задачу (и создатель)
  const assignable = [
    { id: task.creator_id, name: task.creator_name },
    ...task.viewers.filter((v) => v.user_id !== task.creator_id).map((v) => ({ id: v.user_id, name: v.name })),
  ];
  // Пункты: сначала важные; больше пяти — свёрнуты
  const sortedSubs = [...subsLocal].sort((x, y) => y.importance - x.importance);
  const shownSubs = showAllSubs || sortedSubs.length <= 5 ? sortedSubs : sortedSubs.slice(0, 5);
  // Выполненную задачу нельзя редактировать (у «Весь отряд» — когда выполнили все)
  const locked = task.for_all === 1 ? task.members_total > 0 && task.done_count >= task.members_total : task.status === "done";
  // Видящий с правом редактирования работает с задачей наравне с создателем
  const editor = task.viewers.some((v) => v.user_id === viewer.id && v.can_edit === 1);
  const canEditSub = (isCreator || isAssignee || editor) && !locked;

  async function loadComments() {
    const { status, data } = await request(`/api/tasks/${task.id}/comments`);
    if (status === 200) setComments(data.comments ?? []);
  }

  useEffect(() => {
    loadComments();
    // Открыли другую задачу — обновляем поле напоминания
    setReminders(task.reminders.map((r) => toLocalInput(r)));
  }, [task.id]);

  async function setDone(done: boolean) {
    setErr("");
    const { status, data } = await request(`/api/tasks/${task.id}/status`, "PUT", { done });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось изменить статус");
  }

  async function saveReminders() {
    setErr("");
    const list = reminders.filter((v) => v).map((v) => fromLocalInput(v)).filter((v): v is string => !!v);
    const { status, data } = await request(`/api/tasks/${task.id}`, "PUT", { reminders: list });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось сохранить напоминания");
  }

  async function addSub(e: FormEvent) {
    e.preventDefault();
    const text = newSub.trim();
    if (!text) return;
    const { status, data } = await request(`/api/tasks/${task.id}/subtasks`, "POST", {
      title: text,
      importance: newSubImp,
      assignee_id: newSubAssignee ? Number(newSubAssignee) : null,
    });
    if (status === 201) {
      setSubsLocal(data.task.subtasks);
      setNewSub("");
      setNewSubImp(3);
      setNewSubAssignee("");
      onChanged();
    } else setErr(data.error ?? "Не удалось добавить пункт");
  }

  async function setSubField(id: number, patch: { done?: boolean; importance?: number; assignee_id?: number | null }) {
    const { status, data } = await request(`/api/subtasks/${id}`, "PUT", patch);
    if (status === 200) {
      setSubsLocal(data.task.subtasks);
      onChanged();
    } else setErr(data.error ?? "Не удалось изменить пункт");
  }

  async function removeSub(id: number) {
    const { status, data } = await request(`/api/subtasks/${id}`, "DELETE");
    if (status === 200) {
      setSubsLocal(data.task.subtasks);
      onChanged();
    } else setErr(data.error ?? "Не удалось удалить пункт");
  }

  async function sendComment(e: FormEvent) {
    e.preventDefault();
    const text = commentText.trim();
    if (!text) return;
    const { status, data } = await request(`/api/tasks/${task.id}/comments`, "POST", { body: text });
    if (status === 201) {
      setCommentText("");
      await loadComments();
      onChanged();
    } else setErr(data.error ?? "Не удалось отправить комментарий");
  }

  async function remove() {
    if (!window.confirm("Удалить задачу? Комментарии и файл тоже удалятся.")) return;
    const { status, data } = await request(`/api/tasks/${task.id}`, "DELETE");
    if (status === 200) onDeleted();
    else setErr(data.error ?? "Не удалось удалить");
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <h3 style={{ margin: 0, overflowWrap: "anywhere", textDecoration: task.status === "done" ? "line-through" : "none" }}>{task.title}</h3>
        <button type="button" onClick={onClose} aria-label="Закрыть" style={linkButton}>✕</button>
      </div>
      {locked && <div style={{ marginTop: 6, fontSize: 13, color: colors.yellow }}>Задача выполнена, редактирование закрыто.</div>}
      {task.edited_at && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
          <span style={{ background: colors.yellow, color: colors.navy, borderRadius: 999, padding: "1px 8px", fontWeight: "bold" }}>Редактировано</span>
          <button type="button" onClick={() => setShowHistory(true)} style={linkButton}>
            История изменений
          </button>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 14, color: colors.blue }}>
        <Stars value={task.importance} />
        <div style={{ marginTop: 6 }}>
          Исполнители: {task.for_all === 1 ? "Весь отряд" : executors.length ? executors.map((v) => v.name).join(", ") : task.assignee_name}
        </div>
        {task.needs_confirm === 1 && (
          <div style={{ marginTop: 4, fontSize: 14 }}>
            Подтверждение выполнения{task.confirm_condition ? `: ${task.confirm_condition}` : ""}
          </div>
        )}
        {task.viewers.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 14 }}>
            Видят: {task.viewers.map((v) => `${v.name}${v.is_executor ? " (исп.)" : ""}${v.can_edit ? " (редактирует)" : ""}`).join(", ")}
          </div>
        )}
        {task.for_all === 1 && isCreator && (
          <div>
            Выполнили: {task.done_count} из {task.members_total}
          </div>
        )}
        <div>Автор: {task.creator_name}</div>
        <div style={{ color: isOverdue(task) ? "#ff8a8a" : colors.blue }}>
          Срок: {task.due_date ? formatDate(task.due_date) : "не задан"}
          {isOverdue(task) ? " · просрочено" : ""}
        </div>
        <div>Статус: {task.status === "done" ? `выполнено${task.done_at ? ` ${formatWhen(task.done_at)}` : ""}` : "в работе"}</div>
      </div>

      {task.description && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "12px 0" }}>{task.description}</p>}

      {task.attachment_id && (
        <button
          type="button"
          onClick={() => downloadAttachment(task.attachment_id!, task.attachment_name ?? "file").then((e) => e && setErr(e))}
          style={{ ...linkButton, display: "block", margin: "8px 0" }}
        >
          📎 {task.attachment_name ?? "Файл"}
        </button>
      )}

      {(isAssignee || isCreator || editor) && !locked && (
        <div style={{ marginTop: 12 }}>
          <RemindersEditor values={reminders} onChange={setReminders} />
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px", fontSize: 14 }} onClick={saveReminders}>
            Сохранить напоминания
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        {(isAssignee || isCreator || editor || confirmer || task.for_all === 1) && (
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px", fontSize: 14 }} onClick={() => setDone(markDone)}>
            {markDone
              ? task.status === "waiting"
                ? "Подтвердить выполнение"
                : needsCheck
                  ? "Отправить на подтверждение"
                  : "Отметить выполненной"
              : "Вернуть в работу"}
          </button>
        )}
        {(isCreator || editor) && (
          <>
            {!locked && (
              <button type="button" style={{ ...tabButton(false), padding: "8px 14px" }} onClick={onEdit}>
                Редактировать
              </button>
            )}
          </>
        )}
        {isCreator && (
          <>
            <button type="button" style={{ ...tabButton(false), padding: "8px 14px", color: "#b00020" }} onClick={remove}>
              Удалить
            </button>
          </>
        )}
      </div>

      {showHistory && <HistoryModal taskId={task.id} onClose={() => setShowHistory(false)} />}

      <h4 style={{ margin: "18px 0 8px" }}>Подпункты</h4>
      {subsLocal.length === 0 && <p style={{ color: colors.gray, fontSize: 14, margin: "0 0 6px" }}>Пунктов нет.</p>}
      {shownSubs.map((sub) => (
        <div key={sub.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <input
            type="checkbox"
            checked={!!sub.done}
            disabled={locked || !(canEditSub || sub.assignee_id === viewer.id)}
            onChange={(e) => setSubField(sub.id, { done: e.target.checked })}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflowWrap: "anywhere",
              textDecoration: sub.done ? "line-through" : "none",
              color: sub.done ? colors.gray : colors.white,
            }}
          >
            {sub.title}
            {sub.assignee_name && <span style={{ fontSize: 12, color: colors.gray }}> · {sub.assignee_name}</span>}
          </span>
          <Stars value={sub.importance} onChange={canEditSub ? (n) => setSubField(sub.id, { importance: n }) : undefined} />
          {canEditSub && (
            <select
              style={{ ...input, width: "auto", margin: 0, padding: "2px 4px", fontSize: 13 }}
              value={sub.assignee_id ?? ""}
              onChange={(e) => setSubField(sub.id, { assignee_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">без исполнителя</option>
              {assignable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {canEditSub && (
            <button type="button" onClick={() => removeSub(sub.id)} aria-label="Удалить пункт" style={linkButton}>
              ✕
            </button>
          )}
        </div>
      ))}
      {sortedSubs.length > 5 && (
        <button type="button" onClick={() => setShowAllSubs((v) => !v)} style={{ ...linkButton, marginBottom: 6 }}>
          {showAllSubs ? "Свернуть" : `Развернуть все (${sortedSubs.length})`}
        </button>
      )}
      {canEditSub && (
        <form onSubmit={addSub} style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, margin: 0, flex: 1, minWidth: 160 }} value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder="Новый пункт..." maxLength={200} />
          <Stars value={newSubImp} onChange={setNewSubImp} />
          <select style={{ ...input, width: "auto", margin: 0 }} value={newSubAssignee} onChange={(e) => setNewSubAssignee(e.target.value)}>
            <option value="">без исполнителя</option>
            {assignable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="submit" style={{ ...button, width: "auto", padding: "8px 14px" }}>
            Добавить
          </button>
        </form>
      )}

      <h4 style={{ margin: "18px 0 8px" }}>Комментарии</h4>
      {comments.length === 0 && <p style={{ color: colors.gray, fontSize: 14, margin: 0 }}>Пока нет комментариев.</p>}
      {comments.map((c) => (
        <div key={c.id} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: colors.blue }}>
            <b>{c.author_name}</b> · {formatWhen(c.created_at)}
          </div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.body}</div>
        </div>
      ))}
      <form onSubmit={sendComment} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input style={{ ...input, margin: 0 }} value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Комментарий..." maxLength={1000} />
        <button type="submit" style={{ ...button, width: "auto", padding: "8px 14px" }}>
          Отправить
        </button>
      </form>
      {err && <p style={{ color: "#ff8a8a", marginBottom: 0 }}>{err}</p>}
    </Overlay>
  );
}

type ViewerDraft = { level: "view" | "edit"; exec: boolean };

function TaskForm({
  viewer,
  people,
  committee,
  boards,
  adminChats,
  defaultDue,
  initial,
  onSaved,
  onCancel,
}: {
  viewer: User;
  people: Member[];
  committee: boolean;
  boards: BoardSummary[];
  adminChats: AdminChat[];
  defaultDue?: string;
  initial: Task | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [dueDate, setDueDate] = useState(initial?.due_date ?? defaultDue ?? "");
  const [importance, setImportance] = useState(initial?.importance ?? 3);
  const [assignee, setAssignee] = useState<string>(
    initial ? (initial.for_all === 1 ? "all" : String(initial.assignee_id)) : String(viewer.id),
  );
  const [needsConfirm, setNeedsConfirm] = useState(initial?.needs_confirm === 1);
  // Подпункты при создании; у уже созданной задачи подпункты правятся в карточке
  const [subs, setSubs] = useState<string[]>([]);
  const [confirmCondition, setConfirmCondition] = useState(initial?.confirm_condition ?? "");
  const [reminders, setReminders] = useState<string[]>(initial ? initial.reminders.map((r) => toLocalInput(r)) : []);
  // undefined — файл не трогали; null — файл убрали; строка — новый файл
  const [attachmentId, setAttachmentId] = useState<string | null | undefined>(undefined);
  const [attachmentLabel, setAttachmentLabel] = useState<string | null>(initial?.attachment_name ?? null);
  // Кому видна задача: level — только видит или может редактировать; exec — исполнитель (только из видящих)
  const [viewers, setViewers] = useState<Record<number, ViewerDraft>>(() =>
    Object.fromEntries(
      (initial?.viewers ?? []).map((v) => [v.user_id, { level: v.can_edit ? "edit" : "view", exec: v.is_executor === 1 }]),
    ),
  );
  const [busy, setBusy] = useState(false);
  // Доска и колонка, куда сразу положить новую задачу (только доски, где можно редактировать)
  const writableBoards = boards.filter((b) => b.can_edit === 1);
  const [boardId, setBoardId] = useState("");
  const [columnId, setColumnId] = useState("");
  const pickedBoard = writableBoards.find((b) => String(b.id) === boardId);
  // Чат, где пользователь админ, и участник чата, которому ставится задача
  const [chatPick, setChatPick] = useState("");
  const [chatAssignee, setChatAssignee] = useState("");
  const pickedAdminChat = adminChats.find((c) => String(c.id) === chatPick);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const canSetViewers = !initial || initial.creator_id === viewer.id;
  const viewerChoices = people.filter((p) => p.id !== viewer.id);

  async function pickFile(file: File) {
    if (file.size > MAX_FILE) {
      setErr("Файл больше 20 МБ");
      return;
    }
    setBusy(true);
    setErr("");
    const up = await uploadAttachment(file);
    setBusy(false);
    if (!up.ok || !up.id) {
      setErr(up.error ?? "Не удалось загрузить файл");
      return;
    }
    setAttachmentId(up.id);
    setAttachmentLabel(file.name);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setErr("Укажите название задачи");
      return;
    }
    if (dueDate && dueDate < todayIso() && dueDate !== initial?.due_date) {
      setErr("Срок не может быть в прошлом");
      return;
    }
    const newReminders = reminders.filter((v) => v).map((v) => fromLocalInput(v)).filter((v): v is string => !!v);
    if (newReminders.some((iso) => iso <= new Date().toISOString() && !initial?.reminders.includes(iso))) {
      setErr("Напоминание не может быть в прошлом");
      return;
    }
    if (!initial && !committee && pickedAdminChat && !chatAssignee) {
      setErr("Выберите участника чата");
      return;
    }
    if (!initial && boardId && !columnId) {
      setErr("Выберите колонку на доске");
      return;
    }
    const payload: Record<string, unknown> = {
      title: title.trim(),
      description,
      due_date: dueDate || null,
      importance,
      reminders: newReminders,
    };
    if (!initial) payload.subtasks = subs.map((x) => x.trim()).filter((x) => x);
    if (!initial && !committee && pickedAdminChat) {
      payload.assignee_id = Number(chatAssignee);
      payload.chat_id = pickedAdminChat.id;
    }
    if (committee) {
      // Исполнителя меняют галочки «Исполняет»; при правке оставляем текущего, чтобы не сбросить его на себя
      payload.assignee_id = assignee === "all" ? "all" : initial ? String(initial.assignee_id) : viewer.id;
      payload.needs_confirm = needsConfirm;
      payload.confirm_condition = needsConfirm ? confirmCondition.trim() : "";
    }
    if (canSetViewers)
      payload.viewers = Object.entries(viewers).map(([id, d]) => ({
        user_id: Number(id),
        can_edit: d.level === "edit",
        is_executor: committee && assignee !== "all" && d.exec,
      }));
    if (attachmentId !== undefined) payload.attachment_id = attachmentId ?? "";
    setBusy(true);
    setErr("");
    try {
      const { status, data } = initial
        ? await request(`/api/tasks/${initial.id}`, "PUT", payload)
        : await request("/api/tasks", "POST", payload);
      if (status === 200 || status === 201) {
        if (!initial && boardId && columnId && data.task?.id)
          await request(`/api/boards/${boardId}/cards`, "POST", { task_id: data.task.id, column_id: Number(columnId) });
        onSaved();
      }
      else setErr(data.error ?? "Не удалось сохранить");
    } catch {
      setErr("Нет связи с сервером");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onCancel}>
      <form onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>{initial ? "Редактировать задачу" : "Новая задача"}</h3>
        <label style={{ display: "block" }}>
          Название
          <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
        </label>
        <label style={{ display: "block" }}>
          Описание
          <textarea
            style={{ ...input, minHeight: 90, resize: "vertical", fontFamily: "inherit" }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
          />
        </label>
        <label style={{ display: "block" }}>
          Срок
          <input style={input} type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          Важность <Stars value={importance} onChange={setImportance} />
        </div>
        {(committee || !pickedAdminChat) && (
          <label style={{ display: "block" }}>
            Исполнитель
            <select
              style={input}
              value={committee ? assignee : String(viewer.id)}
              onChange={(e) => setAssignee(e.target.value)}
              disabled={!committee}
            >
              <option value={String(viewer.id)}>Я</option>
              {committee && <option value="all">Весь отряд</option>}
            </select>
          </label>
        )}
        {committee && assignee !== "all" && (
          <div style={{ marginBottom: 12, fontSize: 14, color: "#5F7385" }}>
            Исполнители — отметьте людей ниже (только из тех, кто видит задачу). Если никого не отметить, исполнитель — вы.
          </div>
        )}
        {committee && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={needsConfirm} onChange={(e) => setNeedsConfirm(e.target.checked)} />
              Подтверждать выполнение
            </label>
            {needsConfirm && (
              <input
                style={input}
                placeholder="Условие подтверждения, например: фото отчёта в чате"
                value={confirmCondition}
                onChange={(e) => setConfirmCondition(e.target.value)}
                maxLength={500}
              />
            )}
          </div>
        )}
        {canSetViewers && (
          <fieldset style={{ border: "none", padding: 0, margin: "0 0 12px" }}>
            <legend style={{ padding: 0 }}>Кто ещё видит задачу</legend>
            {viewerChoices.length === 0 && <div style={{ fontSize: 14, color: "#5F7385" }}>Нет других участников.</div>}
            {viewerChoices.map((p) => {
              const level = viewers[p.id];
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                    <input
                      type="checkbox"
                      checked={level !== undefined}
                      onChange={(e) =>
                        setViewers((cur) => {
                          const next = { ...cur };
                          if (e.target.checked) next[p.id] = { level: "view", exec: false };
                          else delete next[p.id];
                          return next;
                        })
                      }
                    />
                    {p.full_name}
                  </label>
                  {level !== undefined && (
                    <select
                      style={{ ...input, width: "auto", marginBottom: 0 }}
                      value={level.level}
                      onChange={(e) =>
                        setViewers((cur) => ({ ...cur, [p.id]: { ...level, level: e.target.value as "view" | "edit" } }))
                      }
                    >
                      <option value="view">Только видит</option>
                      <option value="edit">Может редактировать</option>
                    </select>
                  )}
                  {level !== undefined && committee && assignee !== "all" && (
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={level.exec}
                        onChange={(e) => setViewers((cur) => ({ ...cur, [p.id]: { ...level, exec: e.target.checked } }))}
                      />
                      Исполняет
                    </label>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
        {!initial && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 14, marginBottom: 4 }}>Подпункты</div>
            {subs.map((text, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input
                  style={{ ...input, marginBottom: 0 }}
                  value={text}
                  maxLength={200}
                  onChange={(e) => setSubs((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button type="button" onClick={() => setSubs((cur) => cur.filter((_, j) => j !== i))} style={linkButton}>
                  убрать
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setSubs((cur) => [...cur, ""])} style={{ ...tabButton(false), padding: "6px 12px" }}>
              + Подпункт
            </button>
          </div>
        )}
        <RemindersEditor values={reminders} onChange={setReminders} />
        <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFile(f);
              e.target.value = "";
            }}
          />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...tabButton(false), padding: "8px 14px" }}>
            📎 Прикрепить файл
          </button>
          {attachmentLabel && (
            <span style={{ fontSize: 14 }}>
              {attachmentLabel}{" "}
              <button
                type="button"
                onClick={() => {
                  setAttachmentId(null);
                  setAttachmentLabel(null);
                }}
                style={linkButton}
              >
                убрать
              </button>
            </span>
          )}
        </div>
        {err && <p style={{ color: "#ff8a8a" }}>{err}</p>}
        {!initial && !committee && adminChats.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <label style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
              Чат, где вы админ
              <select
                style={input}
                value={chatPick}
                onChange={(e) => {
                  setChatPick(e.target.value);
                  setChatAssignee("");
                }}
              >
                <option value="">Не из чата</option>
                {adminChats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            {pickedAdminChat && (
              <label style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
                Кому поставить
                <select style={input} value={chatAssignee} onChange={(e) => setChatAssignee(e.target.value)}>
                  <option value="">Выберите участника</option>
                  {pickedAdminChat.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {!initial && writableBoards.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <label style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
              Доска
              <select
                style={input}
                value={boardId}
                onChange={(e) => {
                  setBoardId(e.target.value);
                  setColumnId("");
                }}
              >
                <option value="">Без доски</option>
                {writableBoards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </label>
            {pickedBoard && (
              <label style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
                Колонка
                <select style={input} value={columnId} onChange={(e) => setColumnId(e.target.value)}>
                  <option value="">Выберите колонку</option>
                  {pickedBoard.columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <button style={button} type="submit" disabled={busy}>
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
        <button type="button" onClick={onCancel} style={{ ...tabButton(false), width: "100%", marginTop: 8 }}>
          Отмена
        </button>
      </form>
    </Overlay>
  );
}

function RemindersEditor({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const minLocal = toLocalInput(new Date().toISOString());
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 14, marginBottom: 4 }}>Напоминания</div>
      {values.map((v, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <input
            style={{ ...input, margin: 0 }}
            type="datetime-local"
            min={minLocal}
            value={v}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} style={linkButton}>
            убрать
          </button>
        </div>
      ))}
      {values.length < 10 && (
        <button type="button" onClick={() => onChange([...values, ""])} style={{ ...tabButton(false), padding: "6px 12px" }}>
          + Добавить напоминание
        </button>
      )}
    </div>
  );
}

// Цвет текста на плашке: светлый на тёмном цвете и наоборот
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? colors.navy : "#ffffff";
}

function Calendar({
  tasks,
  onOpen,
  onChanged,
  onCreate,
  colorOf,
}: {
  tasks: Task[];
  onOpen: (id: number) => void;
  onChanged: () => void;
  onCreate: (day: string) => void;
  colorOf: (t: Task) => string;
}) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // День с задачами, которые не поместились в клетку: все задачи дня — в окне
  const [dayPopup, setDayPopup] = useState<string | null>(null);
  const [dragTask, setDragTask] = useState<Task | null>(null);
  // Фильтры календаря: важность, статус и исполнитель
  const [minImportance, setMinImportance] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "done">("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const assignees = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of tasks) m.set(t.assignee_id, t.assignee_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [tasks]);
  const filtered = tasks.filter(
    (t) =>
      t.importance >= minImportance &&
      (statusFilter === "all" || (statusFilter === "done" ? t.status === "done" : t.status !== "done")) &&
      (assigneeFilter === "all" || String(t.assignee_id) === assigneeFilter),
  );
  const filtersActive = minImportance > 0 || statusFilter !== "all" || assigneeFilter !== "all";
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDay = (month.getDay() + 6) % 7; // неделя с понедельника
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const byDay = new Map<string, Task[]>();
  for (const t of filtered) {
    if (!t.due_date) continue;
    byDay.set(t.due_date, [...(byDay.get(t.due_date) ?? []), t]);
  }
  // В клетке и в окне задачи идут по важности: самые важные — первыми
  const byImportance = (a: Task, b: Task) => b.importance - a.importance;
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  // Перенос задачи на другой день: срок меняется у всех, кто видит задачу
  async function moveTo(t: Task, day: string) {
    if (t.due_date === day) return;
    const { status, data } = await request(`/api/tasks/${t.id}/due`, "PUT", { due_date: day });
    if (status === 200) onChanged();
    else window.alert(data.error ?? "Не удалось перенести задачу");
  }

  function chipStyle(t: Task): CSSProperties {
    // Цвет задачи один везде: свой, а без него — цвет доски
    const bg = colorOf(t);
    return {
      fontSize: 11,
      color: textOn(bg),
      background: bg,
      border: isOverdue(t) ? "2px solid #c0392b" : "2px solid transparent",
      boxSizing: "border-box",
      borderRadius: 4,
      padding: "2px 4px",
      marginTop: 2,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      cursor: "grab",
      textDecoration: t.status === "done" ? "line-through" : "none",
    };
  }

  const popupTasks = dayPopup ? [...(byDay.get(dayPopup) ?? [])].sort(byImportance) : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button type="button" style={tabButton(false)} onClick={() => setMonth(new Date(year, mon - 1, 1))}>‹</button>
        <b style={{ textTransform: "capitalize" }}>{month.toLocaleString("ru-RU", { month: "long", year: "numeric" })}</b>
        <button type="button" style={tabButton(false)} onClick={() => setMonth(new Date(year, mon + 1, 1))}>›</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <select value={minImportance} onChange={(e) => setMinImportance(Number(e.target.value))} style={{ ...input, width: "auto", padding: "4px 6px" }} aria-label="Важность от">
          <option value={0}>Любая важность</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              от {"★".repeat(n)}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "open" | "done")} style={{ ...input, width: "auto", padding: "4px 6px" }} aria-label="Статус">
          <option value="all">Все статусы</option>
          <option value="open">Не выполнено</option>
          <option value="done">Выполнено</option>
        </select>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} style={{ ...input, width: "auto", padding: "4px 6px" }} aria-label="Исполнитель">
          <option value="all">Все исполнители</option>
          {assignees.map(([id, name]) => (
            <option key={id} value={String(id)}>
              {name}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setMinImportance(0);
              setStatusFilter("all");
              setAssigneeFilter("all");
            }}
            style={{ ...linkButton, fontSize: 13, color: colors.navy, textDecoration: "underline" }}
          >
            Сбросить фильтры
          </button>
        )}
      </div>
      {filtersActive && filtered.length === 0 && <p style={{ color: colors.gray, fontSize: 13, margin: "0 0 8px" }}>Нет задач по выбранным фильтрам.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
          <div key={d} style={{ fontSize: 12, color: colors.blue, textAlign: "center" }}>
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const key = `${year}-${pad(mon + 1)}-${pad(day)}`;
          const dayTasks = [...(byDay.get(key) ?? [])].sort(byImportance);
          const isToday = key === todayIso();
          const canCreate = key >= todayIso();
          return (
            <div
              key={i}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragTask) void moveTo(dragTask, key);
                setDragTask(null);
              }}
              style={{ background: colors.field, borderRadius: 6, minHeight: 64, padding: 3, boxSizing: "border-box", border: isToday ? `2px solid ${colors.yellow}` : "2px solid transparent", overflow: "hidden" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: colors.navy, fontWeight: isToday ? 700 : 400 }}>{day}</span>
                {canCreate && (
                  <button
                    type="button"
                    title="Создать задачу на этот день"
                    onClick={() => onCreate(key)}
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: colors.navy, fontSize: 14, lineHeight: 1, padding: "0 2px", fontWeight: 700 }}
                  >
                    +
                  </button>
                )}
              </div>
              {/* Больше трёх задач — две самые важные и кнопка «посмотреть остальные» */}
              {(dayTasks.length > 3 ? dayTasks.slice(0, 2) : dayTasks).map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={() => setDragTask(t)}
                  onDragEnd={() => setDragTask(null)}
                  onClick={() => onOpen(t.id)}
                  title={t.title}
                  style={chipStyle(t)}
                >
                  {t.title}
                </div>
              ))}
              {dayTasks.length > 3 && (
                <button type="button" onClick={() => setDayPopup(key)} style={{ ...linkButton, fontSize: 11, marginTop: 2, color: colors.navy, textDecoration: "underline" }}>
                  посмотреть остальные
                </button>
              )}
            </div>
          );
        })}
      </div>

      {dayPopup && (
        <div
          onClick={() => setDayPopup(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "min(480px, 100%)", boxSizing: "border-box", maxHeight: "80vh", overflowY: "auto" }}>
            <b>Задачи на {formatDate(dayPopup)}</b>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {popupTasks.map((t) => (
                <div
                  key={t.id}
                  onClick={() => {
                    setDayPopup(null);
                    onOpen(t.id);
                  }}
                  style={{ ...chipStyle(t), fontSize: 14, padding: "8px 10px", cursor: "pointer", whiteSpace: "normal", overflowWrap: "anywhere" }}
                >
                  {t.title}
                  <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>{"★".repeat(t.importance)}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setDayPopup(null)} style={{ ...tabButton(false), width: "100%", marginTop: 12 }}>
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Доски в стиле Trello: список досок и сама доска с колонками и перетаскиванием карточек
interface BoardSummary {
  id: number;
  title: string;
  color: string;
  creator_id: number;
  creator_name: string;
  cards_count: number;
  can_edit: number;
  columns: { id: number; title: string; color: string | null; cards: { task_id: number; color: string | null }[] }[];
}

// Группы, где пользователь админ: для постановки задач участникам чата
interface AdminChat {
  id: number;
  title: string;
  members: { id: number; full_name: string }[];
}

// Карточка на доске: задача и её цвет на этой доске (null — цвет доски)
type BoardCard = Task;

interface BoardData {
  board: { id: number; title: string; color: string; creator_id: number; is_creator: boolean; can_edit: boolean };
  columns: { id: number; title: string; color: string | null; cards: BoardCard[] }[];
  members: { user_id: number; full_name: string; can_edit: number }[];
}

// Цвета, которыми красятся доски
const BOARD_PALETTE = [
  "#b07a63", "#d4766a", "#f5301e", "#f9583b", "#ff7b3d", "#ffb14a", "#f9d56b", "#fbe98e",
  "#b8e07a", "#7fd24a", "#14a065", "#41d692", "#93e8c7", "#a2e3ea", "#9bc8e6", "#4a8ef0",
  "#9c9cf6", "#b99cf6", "#a77ee8", "#c77ce8", "#f58fb4", "#c9a4a8", "#c6baba", "#c4c9c9",
];
const DEFAULT_BOARD_COLOR = "#4a8ef0";

// Кнопка «...» с выпадающим меню
function MoreMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", flexShrink: 0 }} onMouseLeave={() => setOpen(false)}>
      <button type="button" title="Меню" onClick={() => setOpen((v) => !v)} style={{ ...tabButton(false), padding: "2px 10px", fontWeight: 700 }}>
        ...
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            zIndex: 20,
            minWidth: 190,
            background: colors.navy,
            border: `1px solid ${colors.blue}`,
            borderRadius: 10,
            padding: 4,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              style={{ background: "transparent", border: "none", textAlign: "left", padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 14, color: it.danger ? "#ff8a8a" : colors.white }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Квадратик отметки: по нажатию появляется галочка
function SquareCheck({ checked, disabled, title, onToggle }: { checked: boolean; disabled?: boolean; title?: string; onToggle: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(!checked);
      }}
      style={{
        width: 20,
        height: 20,
        flexShrink: 0,
        boxSizing: "border-box",
        borderRadius: 4,
        border: `2px solid ${colors.blue}`,
        background: checked ? colors.yellow : "transparent",
        color: colors.navy,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: disabled ? "default" : "pointer",
        fontWeight: 900,
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      {checked ? "✓" : ""}
    </button>
  );
}

function ColorPicker({ value, onChange, onReset }: { value: string | null; onChange: (c: string) => void; onReset?: () => void }) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 26px)", gap: 6 }}>
        {BOARD_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onChange(c)}
            style={{
              width: 26,
              height: 26,
              boxSizing: "border-box",
              borderRadius: "50%",
              background: c,
              border: c === value ? `3px solid ${colors.white}` : "2px solid transparent",
              cursor: "pointer",
              padding: 0,
              color: colors.navy,
              fontWeight: 900,
              fontSize: 12,
            }}
          >
            {c === value ? "✓" : ""}
          </button>
        ))}
      </div>
      {onReset && (
        <button type="button" onClick={onReset} style={{ ...linkButton, fontSize: 13, marginTop: 6 }}>
          Вернуть цвет доски
        </button>
      )}
    </div>
  );
}

// Срок, подтверждение выполнения и статус карточки
function CardMeta({ task: t, light }: { task: Task; light?: boolean }) {
  const overdue = isOverdue(t);
  const tone = overdue ? (light ? "#b00020" : "#ff8a8a") : colors.gray;
  return (
    <div style={{ fontSize: 12, color: tone, marginTop: 4, overflowWrap: "anywhere" }}>
      {t.due_date ? `срок ${formatDate(t.due_date)}${overdue ? " · просрочено" : ""}` : "без срока"}
      {t.needs_confirm === 1 ? ` · подтверждение${t.confirm_condition ? `: ${t.confirm_condition}` : ""}` : ""}
      {t.status === "waiting" ? " · ждёт подтверждения" : ""}
      {t.importance ? ` · ${"★".repeat(t.importance)}` : ""}
    </div>
  );
}

// Удаление задачи целиком (из списка, доски или календаря)
async function removeTask(id: number, onDone: () => void) {
  if (!window.confirm("Удалить задачу? Комментарии и файл тоже удалятся.")) return;
  const { status, data } = await request(`/api/tasks/${id}`, "DELETE");
  if (status === 200) onDone();
  else window.alert(data.error ?? "Не удалось удалить задачу");
}

// Пункты меню «...» карточки на доске
function cardMenu(o: {
  canEdit: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onCardColor?: () => void;
  onTaskColor?: () => void;
  onRemove: () => void;
  onDelete: () => void;
}) {
  return [
    { label: "Открыть", onClick: o.onOpen },
    { label: "Редактировать", onClick: o.onEdit },
    ...(o.canEdit
      ? [
          ...(o.onCardColor ? [{ label: "Цвет карточки", onClick: o.onCardColor }] : []),
          ...(o.onTaskColor ? [{ label: "Цвет задачи", onClick: o.onTaskColor }] : []),
          { label: "Убрать с доски", onClick: o.onRemove, danger: true },
        ]
      : []),
    { label: "Удалить задачу", onClick: o.onDelete, danger: true },
  ];
}

// Создание доски: название и цвет, открывается кнопкой «+ Доска» во вкладке «Доска»
function BoardForm({ onCreated, onCancel }: { onCreated: (id: number) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [color, setColor] = useState(DEFAULT_BOARD_COLOR);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) {
      setErr("Укажите название доски");
      return;
    }
    setBusy(true);
    setErr("");
    const { status, data } = await request("/api/boards", "POST", { title: t, color });
    setBusy(false);
    if (status === 201) onCreated(data.board.id);
    else setErr(data.error ?? "Не удалось создать доску");
  }

  return (
    <Overlay onClose={onCancel}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0 }}>Новая доска</h3>
        <input autoFocus style={input} placeholder="Название доски" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div>
          <div style={{ color: colors.gray, fontSize: 13, marginBottom: 6 }}>Цвет доски</div>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        {err && <p style={{ color: "#ff8a8a", margin: 0 }}>{err}</p>}
        <button style={button} type="submit" disabled={busy}>
          {busy ? "Создаю…" : "Создать доску"}
        </button>
        <button type="button" onClick={onCancel} style={{ ...tabButton(false), width: "100%" }}>
          Отмена
        </button>
      </form>
    </Overlay>
  );
}

// Список досок: карточки с цветом, автором и числом карточек; нажатие открывает доску
function BoardsView({
  people,
  openId,
  setOpenId,
  onOpenTask,
  onEditTask,
  onChanged,
}: {
  people: Member[];
  openId: number | null;
  setOpenId: (id: number | null) => void;
  onOpenTask: (id: number) => void;
  onEditTask: (id: number) => void;
  onChanged: () => void;
}) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [msg, setMsg] = useState("");

  async function loadBoards() {
    try {
      const { status, data } = await request("/api/boards");
      if (status === 200) {
        setBoards(data.boards ?? []);
        setMsg("");
      } else setMsg(data.error ?? "Не удалось загрузить доски");
    } catch {
      setMsg("Нет связи с сервером");
    }
  }

  useEffect(() => {
    loadBoards();
  }, []);

  if (openId !== null) {
    return (
      <BoardView
        boardId={openId}
        people={people}
        onOpenTask={onOpenTask}
        onEditTask={onEditTask}
        onBack={() => setOpenId(null)}
        onChanged={async () => {
          await loadBoards();
          onChanged();
        }}
      />
    );
  }

  return (
    <div>
      {msg && <p style={{ color: "#ff8a8a" }}>{msg}</p>}
      {boards.length === 0 && <p style={{ color: colors.gray }}>Досок пока нет. Нажмите «+ Доска», чтобы создать первую.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
        {boards.map((b) => (
          <div
            key={b.id}
            onClick={() => setOpenId(b.id)}
            style={{
              ...card,
              marginBottom: 0,
              padding: 14,
              borderTop: `8px solid ${b.color}`,
              cursor: "pointer",
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{b.title}</div>
            <div style={{ fontSize: 13, color: colors.gray, marginTop: 6 }}>
              {b.creator_name} · карточек: {b.cards_count}
            </div>
            <div style={{ fontSize: 13, marginTop: 6, color: b.can_edit === 1 ? colors.yellow : colors.gray }}>
              {b.can_edit === 1 ? "Можно редактировать" : "Только просмотр"}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13, color: colors.blue }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: b.color, flexShrink: 0 }} />
              списков: {b.columns.length}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Одна доска: списки-колонки и карточки-задачи, перетаскивание, цвета, участники
function BoardView({
  boardId,
  people,
  onBack,
  onOpenTask,
  onEditTask,
  onChanged,
}: {
  boardId: number;
  people: Member[];
  onBack: () => void;
  onOpenTask: (id: number) => void;
  onEditTask: (id: number) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<BoardData | null>(null);
  const [msg, setMsg] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<"board" | number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [showColors, setShowColors] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [draft, setDraft] = useState<Record<number, { on: boolean; edit: boolean }>>({});
  const [cardColorFor, setCardColorFor] = useState<number | null>(null);
  const [taskColorFor, setTaskColorFor] = useState<number | null>(null);
  const [columnColorFor, setColumnColorFor] = useState<number | null>(null);
  const [addingIn, setAddingIn] = useState<number | null>(null);
  const [cardTitle, setCardTitle] = useState("");
  const [newColumn, setNewColumn] = useState("");

  async function load() {
    try {
      const { status, data: d } = await request(`/api/boards/${boardId}`);
      if (status === 200) {
        setData(d);
        setMsg("");
      } else setMsg(d.error ?? "Не удалось открыть доску");
    } catch {
      setMsg("Нет связи с сервером");
    }
  }

  useEffect(() => {
    load();
  }, [boardId]);

  // Любое изменение доски: запрос, перечитываем доску и список задач в разделе
  async function act(path: string, method: string, body?: unknown): Promise<boolean> {
    const { status, data: d } = await request(path, method, body);
    if (status >= 300) {
      setMsg(d.error ?? "Не удалось выполнить действие");
      await load();
      return false;
    }
    setMsg("");
    await load();
    onChanged();
    return true;
  }

  async function setDone(taskId: number, done: boolean) {
    const { status, data: d } = await request(`/api/tasks/${taskId}/status`, "PUT", { done });
    if (status === 200) {
      await load();
      onChanged();
    } else setMsg(d.error ?? "Не удалось отметить задачу");
  }

  // Перетаскивание карточки: ставим в колонку toColumn перед карточкой beforeTask (или в конец)
  function moveCard(toColumn: number, beforeTask: number | null) {
    if (dragId === null || !data || !data.board.can_edit || dragId === beforeTask) return;
    const lists = data.columns.map((c) => ({
      column_id: c.id,
      task_ids: c.cards.map((t) => t.id).filter((id) => id !== dragId),
    }));
    const target = lists.find((l) => l.column_id === toColumn);
    if (!target) return;
    const at = beforeTask === null ? -1 : target.task_ids.indexOf(beforeTask);
    if (at < 0) target.task_ids.push(dragId);
    else target.task_ids.splice(at, 0, dragId);
    setDragId(null);
    void act(`/api/boards/${boardId}/order`, "PUT", { columns: lists });
  }

  async function deleteBoard() {
    if (!window.confirm("Удалить доску? Сами задачи останутся.")) return;
    const { status, data: d } = await request(`/api/boards/${boardId}`, "DELETE");
    if (status === 200) {
      onChanged();
      onBack();
    } else setMsg(d.error ?? "Не удалось удалить доску");
  }

  function openMembers() {
    if (!data) return;
    const d: Record<number, { on: boolean; edit: boolean }> = {};
    for (const m of data.members) d[m.user_id] = { on: true, edit: m.can_edit === 1 };
    setDraft(d);
    setShowMembers(true);
  }

  async function saveMembers() {
    const list = Object.entries(draft)
      .filter(([, v]) => v.on)
      .map(([id, v]) => ({ user_id: Number(id), can_edit: v.edit }));
    if (await act(`/api/boards/${boardId}`, "PUT", { members: list })) setShowMembers(false);
  }

  function startRename(kind: "board" | number, current: string) {
    setRenaming(kind);
    setRenameText(current);
  }

  // Сохранение нового названия доски или списка (Enter или уход из поля)
  async function finishRename() {
    const kind = renaming;
    const v = renameText.trim();
    setRenaming(null);
    if (kind === null || !data || !v) return;
    if (kind === "board") {
      if (v !== data.board.title) await act(`/api/boards/${boardId}`, "PUT", { title: v });
    } else {
      const col = data.columns.find((c) => c.id === kind);
      if (col && v !== col.title) await act(`/api/boards/${boardId}/columns/${kind}`, "PUT", { title: v });
    }
  }

  async function addCard(columnId: number) {
    const t = cardTitle.trim();
    if (!t) return;
    const created = await request("/api/tasks", "POST", { title: t });
    if (created.status !== 201 || !created.data.task?.id) {
      setMsg(created.data.error ?? "Не удалось создать задачу");
      return;
    }
    setCardTitle("");
    setAddingIn(null);
    await act(`/api/boards/${boardId}/cards`, "POST", { task_id: created.data.task.id, column_id: columnId });
  }

  if (!data) {
    return (
      <div>
        <button type="button" style={tabButton(false)} onClick={onBack}>
          ← Все доски
        </button>
        {msg && <p style={{ color: "#ff8a8a" }}>{msg}</p>}
      </div>
    );
  }

  const canEdit = data.board.can_edit;
  const color = data.board.color;
  const renameField = (
    <input
      autoFocus
      value={renameText}
      onChange={(e) => setRenameText(e.target.value)}
      onBlur={() => void finishRename()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      style={{ ...input, width: 260, fontWeight: 700 }}
    />
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <button type="button" style={tabButton(false)} onClick={onBack}>
          ← Все доски
        </button>
        <span style={{ width: 16, height: 16, borderRadius: 4, background: color, flexShrink: 0 }} />
        {renaming === "board" ? renameField : <b style={{ fontSize: 18, overflowWrap: "anywhere" }}>{data.board.title}</b>}
        {canEdit && (
          <MoreMenu
            items={[
              { label: "Переименовать доску", onClick: () => startRename("board", data.board.title) },
              { label: "Цвет доски", onClick: () => setShowColors((v) => !v) },
              ...(data.board.is_creator
                ? [
                    { label: "Участники", onClick: openMembers },
                    { label: "Удалить доску", onClick: () => void deleteBoard(), danger: true },
                  ]
                : []),
            ]}
          />
        )}
      </div>

      {showColors && canEdit && (
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: colors.gray, marginBottom: 6 }}>Цвет доски</div>
          <ColorPicker value={color} onChange={(c) => void act(`/api/boards/${boardId}`, "PUT", { color: c })} />
        </div>
      )}

      {msg && <p style={{ color: "#ff8a8a" }}>{msg}</p>}

      {showMembers && (
        <div style={{ ...card, marginBottom: 12 }}>
          <b>Кто видит доску</b>
          <div style={{ color: colors.gray, fontSize: 13, margin: "4px 0 8px" }}>
            Отметьте участников и право «может редактировать».
          </div>
          {people
            .filter((p) => p.id !== data.board.creator_id)
            .map((p) => (
              <div key={p.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "3px 0" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 260 }}>
                  <input
                    type="checkbox"
                    checked={draft[p.id]?.on ?? false}
                    onChange={(e) =>
                      setDraft((cur) => ({ ...cur, [p.id]: { on: e.target.checked, edit: cur[p.id]?.edit ?? false } }))
                    }
                  />
                  {p.full_name}
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={draft[p.id]?.edit ?? false}
                    disabled={!(draft[p.id]?.on ?? false)}
                    onChange={(e) =>
                      setDraft((cur) => ({ ...cur, [p.id]: { on: cur[p.id]?.on ?? false, edit: e.target.checked } }))
                    }
                  />
                  может редактировать
                </label>
              </div>
            ))}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" style={{ ...button, width: "auto", padding: "6px 12px" }} onClick={() => void saveMembers()}>
              Сохранить
            </button>
            <button type="button" style={tabButton(false)} onClick={() => setShowMembers(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, overflowX: "auto", alignItems: "flex-start", paddingBottom: 8 }}>
        {data.columns.map((col) => (
          <div
            key={col.id}
            onDragOver={(e) => {
              if (canEdit) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              moveCard(col.id, null);
            }}
            style={{
              flex: "0 0 280px",
              background: "rgba(255,255,255,0.06)",
              borderRadius: 12,
              borderTop: `6px solid ${col.color ?? color}`,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {renaming === col.id ? (
                renameField
              ) : (
                <b style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: colors.white }}>{col.title}</b>
              )}
              {canEdit && (
                <MoreMenu
                  items={[
                    { label: "Переименовать список", onClick: () => startRename(col.id, col.title) },
                    { label: "Цвет списка", onClick: () => setColumnColorFor((v) => (v === col.id ? null : col.id)) },
                    {
                      label: "Удалить список",
                      danger: true,
                      onClick: () => {
                        if (
                          window.confirm(
                            `Удалить список «${col.title}» вместе с карточками на доске? Сами задачи останутся.`,
                          )
                        )
                          void act(`/api/boards/${boardId}/columns/${col.id}`, "DELETE");
                      },
                    },
                  ]}
                />
              )}
            </div>

            {columnColorFor === col.id && (
              <ColorPicker
                value={col.color}
                onChange={(c) => {
                  setColumnColorFor(null);
                  void act(`/api/boards/${boardId}/columns/${col.id}`, "PUT", { color: c });
                }}
                onReset={() => {
                  setColumnColorFor(null);
                  void act(`/api/boards/${boardId}/columns/${col.id}`, "PUT", { color: null });
                }}
              />
            )}

            {col.cards.map((t) => {
              const cardColor = t.card_color ?? t.color ?? col.color ?? color;
              return (
                <div
                  key={t.id}
                  draggable={canEdit}
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    if (canEdit) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    moveCard(col.id, t.id);
                  }}
                  style={{
                    background: colors.field,
                    color: colors.navy,
                    borderRadius: 8,
                    padding: 8,
                    borderLeft: `6px solid ${cardColor}`,
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    cursor: canEdit ? "grab" : "default",
                    opacity: dragId === t.id ? 0.5 : 1,
                  }}
                >
                  <SquareCheck
                    checked={t.status === "done"}
                    disabled={!canEdit}
                    title="Выполнено"
                    onToggle={(v) => void setDone(t.id, v)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      onClick={() => onOpenTask(t.id)}
                      style={{
                        fontWeight: 600,
                        cursor: "pointer",
                        overflowWrap: "anywhere",
                        textDecoration: t.status === "done" ? "line-through" : "none",
                      }}
                    >
                      {t.title}
                    </div>
                    <CardMeta task={t} light />
                    {t.assignee_name && <div style={{ fontSize: 12, color: colors.gray }}>{t.assignee_name}</div>}
                    {cardColorFor === t.id && (
                      <div style={{ marginTop: 6 }}>
                        <ColorPicker
                          value={t.card_color ?? null}
                          onChange={(c) => {
                            setCardColorFor(null);
                            void act(`/api/boards/${boardId}/cards/${t.id}`, "PUT", { color: c });
                          }}
                          onReset={() => {
                            setCardColorFor(null);
                            void act(`/api/boards/${boardId}/cards/${t.id}`, "PUT", { color: null });
                          }}
                        />
                      </div>
                    )}
                    {taskColorFor === t.id && (
                      <div style={{ marginTop: 6 }}>
                        <ColorPicker
                          value={t.color}
                          onChange={(c) => {
                            setTaskColorFor(null);
                            void act(`/api/tasks/${t.id}/color`, "PUT", { color: c });
                          }}
                          onReset={() => {
                            setTaskColorFor(null);
                            void act(`/api/tasks/${t.id}/color`, "PUT", { color: null });
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <MoreMenu
                    items={cardMenu({
                      canEdit,
                      onOpen: () => onOpenTask(t.id),
                      onEdit: () => onEditTask(t.id),
                      onCardColor: () => setCardColorFor(t.id),
                      onTaskColor: () => setTaskColorFor(t.id),
                      onRemove: () => void act(`/api/boards/${boardId}/cards/${t.id}`, "DELETE"),
                      onDelete: () =>
                        void removeTask(t.id, () => {
                          void load();
                          onChanged();
                        }),
                    })}
                  />
                </div>
              );
            })}

            {canEdit &&
              (addingIn === col.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addCard(col.id);
                  }}
                  style={{ display: "flex", flexDirection: "column", gap: 6 }}
                >
                  <input
                    autoFocus
                    style={input}
                    placeholder="Название карточки"
                    value={cardTitle}
                    onChange={(e) => setCardTitle(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="submit" style={{ ...button, width: "auto", padding: "6px 12px" }}>
                      Добавить
                    </button>
                    <button type="button" style={tabButton(false)} onClick={() => setAddingIn(null)}>
                      Отмена
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setAddingIn(col.id);
                    setCardTitle("");
                  }}
                  style={{ ...tabButton(false), textAlign: "left" }}
                >
                  + Карточка
                </button>
              ))}
          </div>
        ))}

        {canEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = newColumn.trim();
              if (!t) return;
              void act(`/api/boards/${boardId}/columns`, "POST", { title: t }).then((ok) => {
                if (ok) setNewColumn("");
              });
            }}
            style={{ flex: "0 0 240px", display: "flex", flexDirection: "column", gap: 6 }}
          >
            <input style={input} placeholder="Название списка" value={newColumn} onChange={(e) => setNewColumn(e.target.value)} />
            <button type="submit" style={{ ...tabButton(false), textAlign: "left" }}>
              + Список
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Колонка доски в списке задач: строка как задача, карточки внутри как подпункты
function BoardGroupRow({
  board,
  column,
  cards,
  done,
  onOpenTask,
  onEditTask,
  onOpenBoard,
  onChanged,
}: {
  board: BoardSummary;
  column: BoardSummary["columns"][number];
  cards: BoardCard[];
  done: boolean;
  onOpenTask: (id: number) => void;
  onEditTask: (id: number) => void;
  onOpenBoard: (id: number) => void;
  onChanged: () => void;
}) {
  const mine = cards.filter((t) => (t.status === "done") === done);
  const canEdit = board.can_edit === 1;
  const [colorFor, setColorFor] = useState<number | null>(null);
  const [colorListOpen, setColorListOpen] = useState(false);

  async function setDoneTask(id: number, v: boolean) {
    const { status, data } = await request(`/api/tasks/${id}/status`, "PUT", { done: v });
    if (status === 200) onChanged();
    else window.alert(data.error ?? "Не удалось отметить задачу");
  }

  async function setListColor(color: string | null) {
    setColorListOpen(false);
    const { status, data } = await request(`/api/boards/${board.id}/columns/${column.id}`, "PUT", { color });
    if (status === 200) onChanged();
    else window.alert(data.error ?? "Не удалось сменить цвет");
  }

  async function setCardColor(id: number, color: string | null) {
    const { status, data } = await request(`/api/tasks/${id}/color`, "PUT", { color });
    setColorFor(null);
    if (status === 200) onChanged();
    else window.alert(data.error ?? "Не удалось сменить цвет");
  }

  async function removeCard(id: number) {
    if (!window.confirm("Убрать задачу с доски? Сама задача останется.")) return;
    const { status, data } = await request(`/api/boards/${board.id}/cards/${id}`, "DELETE");
    if (status === 200) onChanged();
    else window.alert(data.error ?? "Не удалось убрать задачу");
  }

  async function rename() {
    const v = window.prompt("Новое название списка", column.title)?.trim();
    if (!v || v === column.title) return;
    const { status, data } = await request(`/api/boards/${board.id}/columns/${column.id}`, "PUT", { title: v });
    if (status === 200) onChanged();
    else window.alert(data.error ?? "Не удалось переименовать");
  }

  const show = done ? mine.length > 0 : mine.length > 0 || cards.length === 0;
  if (!show) return null;

  return (
    <div style={{ ...card, padding: 14, marginBottom: 8, borderLeft: `8px solid ${column.color ?? board.color}`, boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <b style={{ overflowWrap: "anywhere" }}>{column.title}</b>
          <div style={{ fontSize: 13, color: board.color, marginTop: 2 }}>
            Доска: {board.title} · карточек: {cards.length}, выполнено: {cards.filter((t) => t.status === "done").length}
          </div>
        </div>
        <MoreMenu
          items={[
            { label: "Открыть доску", onClick: () => onOpenBoard(board.id) },
            ...(canEdit
              ? [
                  { label: "Переименовать список", onClick: () => void rename() },
                  { label: "Цвет списка", onClick: () => setColorListOpen((v) => !v) },
                ]
              : []),
          ]}
        />
      </div>
      {colorListOpen && (
        <div style={{ marginTop: 8 }}>
          <ColorPicker value={column.color} onChange={(c) => void setListColor(c)} onReset={() => void setListColor(null)} />
        </div>
      )}
      {mine.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${colors.gray}` }}>
          {mine.map((t) => (
            <div key={t.id} style={{ marginBottom: 6, paddingLeft: 8, borderLeft: `5px solid ${t.color ?? column.color ?? board.color}` }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14 }}>
                <SquareCheck checked={t.status === "done"} title="Выполнено" onToggle={(v) => void setDoneTask(t.id, v)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span
                    onClick={() => onOpenTask(t.id)}
                    style={{
                      cursor: "pointer",
                      overflowWrap: "anywhere",
                      color: t.status === "done" ? colors.gray : colors.white,
                      textDecoration: t.status === "done" ? "line-through" : "none",
                    }}
                  >
                    {t.title}
                    {t.assignee_name && <span style={{ fontSize: 12, color: colors.gray }}> · {t.assignee_name}</span>}
                  </span>
                  <CardMeta task={t} />
                  {colorFor === t.id && (
                    <div style={{ marginTop: 6 }}>
                      <ColorPicker value={t.color} onChange={(c) => void setCardColor(t.id, c)} onReset={() => void setCardColor(t.id, null)} />
                    </div>
                  )}
                </div>
                <MoreMenu
                  items={cardMenu({
                    canEdit,
                    onOpen: () => onOpenTask(t.id),
                    onEdit: () => onEditTask(t.id),
                    onTaskColor: () => setColorFor(t.id),
                    onRemove: () => void removeCard(t.id),
                    onDelete: () => void removeTask(t.id, onChanged),
                  })}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksPage({ viewer, onChanged }: { viewer: User; onChanged: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [adminChats, setAdminChats] = useState<AdminChat[]>([]);
  const [people, setPeople] = useState<Member[]>([]);
  const [scope, setScope] = useState<Scope>("mine");
  const [view, setView] = useState<View>("list");
  const [listTab, setListTab] = useState<"open" | "done">("open");
  const [sortLevels, setSortLevels] = useState<SortLevel[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [boardOpenId, setBoardOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDue, setNewDue] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [message, setMessage] = useState("");
  const committee = COMMITTEE_ROLES.includes(viewer.role);

  async function loadBoards() {
    try {
      const { status, data } = await request("/api/boards");
      if (status === 200) setBoards(data.boards ?? []);
    } catch {
      // Доски — дополнение к списку; без них список задач всё равно работает
    }
  }

  async function load() {
    try {
      const { status, data } = await request("/api/tasks");
      if (status === 200) setTasks(data.tasks ?? []);
      else setMessage(data.error ?? "Не удалось загрузить задачи");
    } catch {
      setMessage("Нет связи с сервером");
    }
    await loadBoards();
  }

  useEffect(() => {
    load();
    request("/api/profiles")
      .then(({ status, data }) => {
        if (status === 200) setPeople(data.users ?? []);
      })
      .catch(() => undefined);
    request("/api/chat-admin-targets")
      .then(({ status, data }) => {
        if (status === 200) setAdminChats(data.chats ?? []);
      })
      .catch(() => undefined);
  }, []);

  // Любое изменение: перечитываем список и обновляем значок в меню
  async function changed() {
    await load();
    onChanged();
  }

  const shown = useMemo(() => {
    if (scope === "mine")
      return tasks.filter(
        (t) => t.assignee_id === viewer.id || t.for_all === 1 || t.viewers.some((v) => v.user_id === viewer.id && v.is_executor === 1),
      );
    if (scope === "available") return tasks.filter((t) => t.viewers.some((v) => v.user_id === viewer.id));
    if (scope === "assigned") return tasks.filter((t) => t.creator_id === viewer.id);
    return tasks;
  }, [tasks, scope, viewer.id]);

  // Карточки досок в списке не дублируются отдельными задачами: они показаны внутри колонок
  const boardTaskIds = useMemo(() => new Set(boards.flatMap((b) => b.columns.flatMap((c) => c.cards.map((k) => k.task_id)))), [boards]);

  // Цвет списка, в котором лежит задача, а если у списка нет цвета — цвет доски (первая доска по порядку)
  const boardColorByTask = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of boards)
      for (const c of b.columns)
        for (const k of c.cards) if (!m.has(k.task_id)) m.set(k.task_id, c.color ?? b.color);
    return m;
  }, [boards]);
  const colorOf = (t: Task): string => t.color ?? boardColorByTask.get(t.id) ?? colors.yellow;

  const groups = useMemo(() => {
    const shownIds = new Set(shown.map((t) => t.id));
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return boards.flatMap((b) =>
      b.columns.map((col) => ({
        board: b,
        column: col,
        cards: col.cards
          .map((k) => {
            const t = byId.get(k.task_id);
            return t && shownIds.has(t.id) ? t : null;
          })
          .filter((t): t is BoardCard => t !== null),
      })),
    );
  }, [boards, tasks, shown]);

  const current = openId !== null ? tasks.find((t) => t.id === openId) ?? null : null;
  const open = shown.filter((t) => t.status !== "done" && !boardTaskIds.has(t.id));
  const done = shown.filter((t) => t.status === "done" && !boardTaskIds.has(t.id));
  const sortedOpen = useMemo(() => [...open].sort(compareBy(sortLevels, taskSortValue)), [open, sortLevels]);
  const sortedDone = useMemo(() => [...done].sort(compareBy(sortLevels, taskSortValue)), [done, sortLevels]);
  const groupsShown = groups.filter((g) =>
    listTab === "done" ? g.cards.some((t) => t.status === "done") : g.cards.some((t) => t.status !== "done") || g.cards.length === 0,
  );
  const listRows = listTab === "open" ? sortedOpen : sortedDone;

  // Редактирование задачи из доски или списка — той же формой, что и в списке задач
  function editTask(id: number) {
    const t = tasks.find((x) => x.id === id);
    if (t) setEditing(t);
  }

  function openBoard(id: number) {
    setBoardOpenId(id);
    setView("board");
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Задачи</h2>
        {view === "board" && boardOpenId === null ? (
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px" }} onClick={() => setCreatingBoard(true)}>
            + Доска
          </button>
        ) : (
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px" }} onClick={() => {
            setNewDue("");
            setCreating(true);
          }}>
            + Новая задача
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {SCOPES.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setScope(key)} style={tabButton(scope === key)}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setView(key)} style={{ ...tabButton(view === key), background: view === key ? colors.yellow : "transparent", color: view === key ? colors.navy : colors.blue, border: `1px solid ${colors.blue}` }}>
            {label}
          </button>
        ))}
      </div>

      {message && <p style={{ color: "#ff8a8a" }}>{message}</p>}

      {view === "list" && (
        <>
          <SortBar levels={sortLevels} onChange={setSortLevels} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {(
              [
                [
                  "open",
                  `Не выполнено (${open.length + groupsShown.reduce((n, g) => n + g.cards.filter((t) => t.status !== "done").length, 0)})`,
                ],
                [
                  "done",
                  `Выполнено (${done.length + groupsShown.reduce((n, g) => n + g.cards.filter((t) => t.status === "done").length, 0)})`,
                ],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setListTab(key)}
                style={{ ...tabButton(listTab === key), background: listTab === key ? colors.yellow : "transparent", color: listTab === key ? colors.navy : colors.blue, border: `1px solid ${colors.blue}` }}
              >
                {label}
              </button>
            ))}
          </div>
          {groupsShown.map((g) => (
            <BoardGroupRow
              key={g.column.id}
              board={g.board}
              column={g.column}
              cards={g.cards}
              done={listTab === "done"}
              onOpenTask={setOpenId}
              onEditTask={editTask}
              onOpenBoard={openBoard}
              onChanged={changed}
            />
          ))}
          {listRows.length === 0 && groupsShown.length === 0 && (
            <p style={{ color: colors.gray }}>{listTab === "open" ? "Невыполненных задач нет." : "Выполненных задач пока нет."}</p>
          )}
          {listRows.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={setOpenId} onEdit={setEditing} onChanged={changed} sortLevels={sortLevels} />
          ))}
        </>
      )}

      {view === "board" && (
        <BoardsView people={people} onOpenTask={setOpenId} onEditTask={editTask} onChanged={changed} openId={boardOpenId} setOpenId={setBoardOpenId} />
      )}

      {view === "calendar" && (
        <Calendar
          tasks={shown}
          colorOf={colorOf}
          onOpen={setOpenId}
          onChanged={changed}
          onCreate={(day) => {
            setNewDue(day);
            setCreating(true);
          }}
        />
      )}

      {current && (
        <TaskDetail
          task={current}
          viewer={viewer}
          onChanged={changed}
          onEdit={() => {
            setEditing(current);
            setOpenId(null);
          }}
          onDeleted={async () => {
            setOpenId(null);
            await changed();
          }}
          onClose={() => setOpenId(null)}
        />
      )}

      {creatingBoard && (
        <BoardForm
          onCancel={() => setCreatingBoard(false)}
          onCreated={(id) => {
            setCreatingBoard(false);
            setBoardOpenId(id);
            void changed();
          }}
        />
      )}

      {(creating || editing) && (
        <TaskForm
          viewer={viewer}
          people={people}
          committee={committee}
          boards={boards}
          adminChats={adminChats}
          defaultDue={newDue}
          initial={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await changed();
          }}
        />
      )}
    </section>
  );
}

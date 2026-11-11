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
  confirm_condition: string | null;
  reminders: string[];
  subtasks: { id: number; title: string; done: number }[];
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

function TaskCard({ task, onOpen }: { task: Task; onOpen: (id: number) => void }) {
  const done = task.status === "done";
  const overdue = isOverdue(task);
  return (
    <div
      onClick={() => onOpen(task.id)}
      style={{ ...card, padding: 14, marginBottom: 8, cursor: "pointer", opacity: done ? 0.6 : 1, boxSizing: "border-box" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <b style={{ overflowWrap: "anywhere", textDecoration: done ? "line-through" : "none" }}>{task.title}</b>
        <Stars value={task.importance} />
      </div>
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
  const [showHistory, setShowHistory] = useState(false);
  const [err, setErr] = useState("");
  const isCreator = task.creator_id === viewer.id;
  // Исполнители — видящие, отмеченные как исполнитель
  const executors = task.viewers.filter((v) => v.is_executor === 1);
  const isAssignee = task.assignee_id === viewer.id || executors.some((v) => v.user_id === viewer.id);
  const committeeViewer = COMMITTEE_ROLES.includes(viewer.role);
  const needsCheck = task.for_all !== 1 && (task.needs_confirm === 1 || task.assigned_by_committee === 1 || executors.length > 1);
  // Подтверждает: при нескольких исполнителях — создатель, иначе — комсостав (для задач комсостава и с галочкой)
  const confirmer =
    executors.length > 1 ? isCreator : (task.assigned_by_committee === 1 || task.needs_confirm === 1) && committeeViewer;
  const markDone = task.status === "open" || (task.status === "waiting" && confirmer);
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
    const { status, data } = await request(`/api/tasks/${task.id}/subtasks`, "POST", { title: text });
    if (status === 201) {
      setNewSub("");
      onChanged();
    } else setErr(data.error ?? "Не удалось добавить пункт");
  }

  async function toggleSub(id: number, done: boolean) {
    const { status, data } = await request(`/api/subtasks/${id}`, "PUT", { done });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось изменить пункт");
  }

  async function removeSub(id: number) {
    const { status, data } = await request(`/api/subtasks/${id}`, "DELETE");
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось удалить пункт");
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
      {task.subtasks.length === 0 && <p style={{ color: colors.gray, fontSize: 14, margin: "0 0 6px" }}>Пунктов нет.</p>}
      {task.subtasks.map((sub) => (
        <div key={sub.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <input type="checkbox" checked={!!sub.done} disabled={!canEditSub} onChange={(e) => toggleSub(sub.id, e.target.checked)} />
          <span style={{ flex: 1, overflowWrap: "anywhere", textDecoration: sub.done ? "line-through" : "none", color: sub.done ? colors.gray : colors.white }}>
            {sub.title}
          </span>
          {canEditSub && (
            <button type="button" onClick={() => removeSub(sub.id)} aria-label="Удалить пункт" style={linkButton}>
              ✕
            </button>
          )}
        </div>
      ))}
      {canEditSub && (
        <form onSubmit={addSub} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input style={{ ...input, margin: 0 }} value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder="Новый пункт..." maxLength={200} />
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
  initial,
  onSaved,
  onCancel,
}: {
  viewer: User;
  people: Member[];
  committee: boolean;
  initial: Task | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [dueDate, setDueDate] = useState(initial?.due_date ?? "");
  const [importance, setImportance] = useState(initial?.importance ?? 3);
  const [assignee, setAssignee] = useState<string>(initial?.for_all === 1 ? "all" : String(viewer.id));
  const [needsConfirm, setNeedsConfirm] = useState(initial?.needs_confirm === 1);
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
    const payload: Record<string, unknown> = {
      title: title.trim(),
      description,
      due_date: dueDate || null,
      importance,
      reminders: newReminders,
    };
    if (committee) {
      payload.assignee_id = assignee === "all" ? "all" : viewer.id;
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
      if (status === 200 || status === 201) onSaved();
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

function Calendar({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: number) => void }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDay = (month.getDay() + 6) % 7; // неделя с понедельника
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.due_date) continue;
    byDay.set(t.due_date, [...(byDay.get(t.due_date) ?? []), t]);
  }
  const monthPrefix = `${year}-${pad(mon + 1)}-`;
  const outside = tasks.filter((t) => !t.due_date || !t.due_date.startsWith(monthPrefix));
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button type="button" style={tabButton(false)} onClick={() => setMonth(new Date(year, mon - 1, 1))}>‹</button>
        <b style={{ textTransform: "capitalize" }}>{month.toLocaleString("ru-RU", { month: "long", year: "numeric" })}</b>
        <button type="button" style={tabButton(false)} onClick={() => setMonth(new Date(year, mon + 1, 1))}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
          <div key={d} style={{ fontSize: 12, color: colors.blue, textAlign: "center" }}>
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const key = `${year}-${pad(mon + 1)}-${pad(day)}`;
          const dayTasks = byDay.get(key) ?? [];
          const isToday = key === todayIso();
          return (
            <div
              key={i}
              style={{ background: colors.field, borderRadius: 6, minHeight: 56, padding: 3, boxSizing: "border-box", border: isToday ? `2px solid ${colors.yellow}` : "2px solid transparent", overflow: "hidden" }}
            >
              <div style={{ fontSize: 11, color: colors.navy, fontWeight: isToday ? 700 : 400 }}>{day}</div>
              {dayTasks.map((t) => (
                <div
                  key={t.id}
                  onClick={() => onOpen(t.id)}
                  title={t.title}
                  style={{
                    fontSize: 10,
                    color: colors.navy,
                    background: t.status === "done" ? "#c9d3dc" : isOverdue(t) ? "#ffb4b4" : colors.yellow,
                    borderRadius: 4,
                    padding: "1px 3px",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {t.title}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {outside.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 14, color: colors.blue, marginBottom: 6 }}>Вне этого месяца и без срока ({outside.length})</div>
          {outside.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksPage({ viewer, onChanged }: { viewer: User; onChanged: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Member[]>([]);
  const [scope, setScope] = useState<Scope>("mine");
  const [view, setView] = useState<View>("list");
  const [listTab, setListTab] = useState<"open" | "done">("open");
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const committee = COMMITTEE_ROLES.includes(viewer.role);

  async function load() {
    try {
      const { status, data } = await request("/api/tasks");
      if (status === 200) setTasks(data.tasks ?? []);
      else setMessage(data.error ?? "Не удалось загрузить задачи");
    } catch {
      setMessage("Нет связи с сервером");
    }
  }

  useEffect(() => {
    load();
    request("/api/profiles")
      .then(({ status, data }) => {
        if (status === 200) setPeople(data.users ?? []);
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

  const current = openId !== null ? tasks.find((t) => t.id === openId) ?? null : null;
  const open = shown.filter((t) => t.status !== "done");
  const done = shown.filter((t) => t.status === "done");

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Задачи</h2>
        <button type="button" style={{ ...button, width: "auto", padding: "8px 14px" }} onClick={() => setCreating(true)}>
          + Новая задача
        </button>
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {(
              [
                ["open", `Не выполнено (${open.length})`],
                ["done", `Выполнено (${done.length})`],
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
          {(listTab === "open" ? open : done).length === 0 && (
            <p style={{ color: colors.gray }}>{listTab === "open" ? "Невыполненных задач нет." : "Выполненных задач пока нет."}</p>
          )}
          {(listTab === "open" ? open : done).map((t) => (
            <TaskCard key={t.id} task={t} onOpen={setOpenId} />
          ))}
        </>
      )}

      {view === "board" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, alignItems: "start" }}>
          {[
            { title: "К выполнению", items: open },
            { title: "Выполнено", items: done },
          ].map((col) => (
            <div key={col.title} style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 10 }}>
              <div style={{ fontSize: 14, color: colors.blue, marginBottom: 8 }}>
                {col.title} ({col.items.length})
              </div>
              {col.items.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={setOpenId} />
              ))}
            </div>
          ))}
        </div>
      )}

      {view === "calendar" && <Calendar tasks={shown} onOpen={setOpenId} />}

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

      {(creating || editing) && (
        <TaskForm
          viewer={viewer}
          people={people}
          committee={committee}
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

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
  remind_at: string | null;
  created_at: string;
  comments_count: number;
}

interface Member {
  id: number;
  full_name: string;
  role: string;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  author_id: number;
  author_name: string;
}

type Scope = "mine" | "assigned" | "all";
type View = "list" | "board" | "calendar";

const SCOPES: [Scope, string][] = [
  ["mine", "Мне"],
  ["assigned", "Я назначил"],
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
        Исполнитель: {task.assignee_name} · Автор: {task.creator_name}
      </div>
      <div style={{ fontSize: 13, marginTop: 4, color: overdue ? "#ff8a8a" : colors.blue }}>
        {task.due_date ? `Срок: ${formatDate(task.due_date)}${overdue ? " · просрочено" : ""}` : "Без срока"}
        {task.remind_at ? ` · напоминание ${formatWhen(task.remind_at)}` : ""}
        {task.comments_count ? ` · комментариев: ${task.comments_count}` : ""}
      </div>
    </div>
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
  const [remind, setRemind] = useState(toLocalInput(task.remind_at));
  const [err, setErr] = useState("");
  const isCreator = task.creator_id === viewer.id;
  const isAssignee = task.assignee_id === viewer.id;

  async function loadComments() {
    const { status, data } = await request(`/api/tasks/${task.id}/comments`);
    if (status === 200) setComments(data.comments ?? []);
  }

  useEffect(() => {
    loadComments();
    // Открыли другую задачу — обновляем поле напоминания
    setRemind(toLocalInput(task.remind_at));
  }, [task.id]);

  async function setDone(done: boolean) {
    setErr("");
    const { status, data } = await request(`/api/tasks/${task.id}/status`, "PUT", { done });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось изменить статус");
  }

  async function saveRemind(value: string | null) {
    setErr("");
    const { status, data } = await request(`/api/tasks/${task.id}`, "PUT", { remind_at: value });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось сохранить напоминание");
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
      <div style={{ marginTop: 8, fontSize: 14, color: colors.blue }}>
        <Stars value={task.importance} />
        <div style={{ marginTop: 6 }}>Исполнитель: {task.assignee_name}</div>
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

      {(isAssignee || isCreator) && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", fontSize: 14 }}>
            Напоминание
            <input style={input} type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={{ ...button, width: "auto", padding: "8px 14px", fontSize: 14 }} onClick={() => saveRemind(fromLocalInput(remind))}>
              Сохранить напоминание
            </button>
            {task.remind_at && (
              <button type="button" style={{ ...tabButton(false), padding: "8px 14px" }} onClick={() => saveRemind(null)}>
                Убрать
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        {(isAssignee || isCreator) && (
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px", fontSize: 14 }} onClick={() => setDone(task.status !== "done")}>
            {task.status === "done" ? "Вернуть в работу" : "Отметить выполненной"}
          </button>
        )}
        {isCreator && (
          <>
            <button type="button" style={{ ...tabButton(false), padding: "8px 14px" }} onClick={onEdit}>
              Редактировать
            </button>
            <button type="button" style={{ ...tabButton(false), padding: "8px 14px", color: "#b00020" }} onClick={remove}>
              Удалить
            </button>
          </>
        )}
      </div>

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

function TaskForm({
  viewer,
  members,
  committee,
  initial,
  onSaved,
  onCancel,
}: {
  viewer: User;
  members: Member[];
  committee: boolean;
  initial: Task | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [dueDate, setDueDate] = useState(initial?.due_date ?? "");
  const [importance, setImportance] = useState(initial?.importance ?? 3);
  const [assigneeId, setAssigneeId] = useState(initial?.assignee_id ?? viewer.id);
  const [remindAt, setRemindAt] = useState(toLocalInput(initial?.remind_at ?? null));
  // undefined — файл не трогали; null — файл убрали; строка — новый файл
  const [attachmentId, setAttachmentId] = useState<string | null | undefined>(undefined);
  const [attachmentLabel, setAttachmentLabel] = useState<string | null>(initial?.attachment_name ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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
    const payload: Record<string, unknown> = {
      title: title.trim(),
      description,
      due_date: dueDate || null,
      importance,
      remind_at: fromLocalInput(remindAt),
    };
    if (committee) payload.assignee_id = assigneeId;
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
          <input style={input} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          Важность <Stars value={importance} onChange={setImportance} />
        </div>
        {committee ? (
          <label style={{ display: "block" }}>
            Исполнитель
            <select style={input} value={assigneeId} onChange={(e) => setAssigneeId(Number(e.target.value))}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div style={{ fontSize: 14, color: colors.blue, marginBottom: 12 }}>Исполнитель: вы</div>
        )}
        <label style={{ display: "block" }}>
          Напоминание (дата и время)
          <input style={input} type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
        </label>
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
  const noDate: Task[] = [];
  for (const t of tasks) {
    if (!t.due_date) {
      noDate.push(t);
      continue;
    }
    byDay.set(t.due_date, [...(byDay.get(t.due_date) ?? []), t]);
  }
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
      {noDate.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 14, color: colors.blue, marginBottom: 6 }}>Без срока ({noDate.length})</div>
          {noDate.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksPage({ viewer, onChanged }: { viewer: User; onChanged: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [scope, setScope] = useState<Scope>("mine");
  const [view, setView] = useState<View>("list");
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
    if (committee) {
      request("/api/admin/members")
        .then(({ status, data }) => {
          if (status === 200) setMembers(data.members ?? []);
        })
        .catch(() => undefined);
    }
  }, []);

  // Любое изменение: перечитываем список и обновляем значок в меню
  async function changed() {
    await load();
    onChanged();
  }

  const shown = useMemo(() => {
    if (scope === "mine") return tasks.filter((t) => t.assignee_id === viewer.id);
    if (scope === "assigned") return tasks.filter((t) => t.creator_id === viewer.id && t.assignee_id !== viewer.id);
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
          <h4 style={{ margin: "0 0 8px", color: colors.blue }}>Открытые ({open.length})</h4>
          {open.length === 0 && <p style={{ color: colors.gray }}>Открытых задач нет.</p>}
          {open.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={setOpenId} />
          ))}
          {done.length > 0 && (
            <>
              <h4 style={{ margin: "16px 0 8px", color: colors.blue }}>Выполненные ({done.length})</h4>
              {done.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={setOpenId} />
              ))}
            </>
          )}
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
          members={members}
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

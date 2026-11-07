// Чаты в стиле Telegram: слева список диалогов, справа сам чат.
// Новые сообщения приходят через Ably, без перезагрузки страницы.
import { CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import * as Ably from "ably";
import { COMMITTEE_ROLES, User, downloadAttachment, loadAttachmentUrl, request, uploadAttachment } from "../api";
import { button, card, colors, input } from "../styles";

// Кнопки в строках и шапке не растягиваются на всю ширину
const inlineButton: CSSProperties = { ...button, width: "auto", whiteSpace: "nowrap" };
import { ReactionBar } from "./FeedPage";
import { TabIcon } from "../TabIcon";

interface ChatItem {
  id: number;
  kind: string;
  title: string;
  last_body: string | null;
  last_kind: string | null;
  last_at: string | null;
  unread: number;
}

interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  users: string[];
}

interface Msg {
  id: number;
  chat_id: number;
  author_id: number;
  author_name: string;
  body: string;
  attachment_id: string | null;
  attachment_name: string | null;
  attachment_kind: string | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reactions: Reaction[];
}

const PAGE = 50;
const MAX_FILE = 20 * 1024 * 1024;

function parseEvent<T>(data: unknown): T {
  return (typeof data === "string" ? JSON.parse(data) : data) as T;
}

// Время из базы приходит в UTC без пометки, поэтому добавляем её
function utcDate(iso: string): Date {
  return new Date(iso.replace(" ", "T") + "Z");
}

function timeText(iso: string): string {
  return utcDate(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function shortDate(iso: string): string {
  const d = utcDate(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return timeText(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function previewOf(chat: ChatItem): string {
  if (chat.last_kind === "image") return "📷 Фото";
  if (chat.last_kind === "file") return "📎 Файл";
  return chat.last_body ?? "Нет сообщений";
}

export function ChatsPage({ viewer }: { viewer: User }) {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");
  const [ably, setAbly] = useState<Ably.Realtime | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 760);
  const subscribed = useRef(new Set<number>());
  const activeRef = useRef<number | null>(null);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 760);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  async function loadChats() {
    const { status, data } = await request("/api/chats");
    if (status === 200) setChats(data.chats);
    else setError(data.error ?? "Не удалось загрузить чаты");
  }

  // Подключение к Ably: токен выдаёт сервер и только для доступных чатов
  useEffect(() => {
    const client = new Ably.Realtime({
      authCallback: (_params, callback) => {
        request("/api/ably/token")
          .then(({ status, data }) => (status === 200 ? callback(null, data) : callback(String(data.error ?? "Ошибка"), null)))
          .catch(() => callback("Нет связи с сервером", null));
      },
    });
    setAbly(client);
    loadChats();
    return () => {
      client.close();
      subscribed.current.clear();
      setAbly(null);
    };
  }, []);

  // Подписка на все чаты из списка: для обновления списка и уведомлений
  useEffect(() => {
    if (!ably) return;
    for (const chat of chats) {
      if (subscribed.current.has(chat.id)) continue;
      subscribed.current.add(chat.id);
      ably.channels.get(`chat:${chat.id}`).subscribe("message", (m) => {
        const msg = parseEvent<Msg>(m.data);
        if (msg.author_id !== viewer.id && (document.hidden || activeRef.current !== msg.chat_id)) {
          notify(msg);
        }
        loadChats();
      });
    }
  }, [chats, ably]);

  function notify(msg: Msg) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      new Notification(msg.author_name, {
        body: msg.body || (msg.attachment_kind === "image" ? "📷 Фото" : "📎 Файл"),
        tag: `chat-${msg.chat_id}`,
      });
    } catch {
      // Браузер может запретить уведомления в фоне; это не критично
    }
  }

  async function chatCreated(id: number) {
    // Новый чат появился в правах доступа: просим Ably выдать обновлённый токен
    await ably?.auth.authorize().catch(() => undefined);
    await loadChats();
    setActiveId(id);
    setShowNew(false);
  }

  const active = chats.find((c) => c.id === activeId) ?? null;

  return (
    <div style={wide ? { display: "flex", gap: 16, alignItems: "flex-start" } : undefined}>
      {(wide || !active) && (
        <aside style={{ width: wide ? 300 : "100%", flexShrink: 0, ...card, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ fontSize: 18 }}>Чаты</b>
            <button style={inlineButton} onClick={() => setShowNew(true)}>+ Новый чат</button>
          </div>
          {error && <p style={{ color: "#b00020" }}>{error}</p>}
          {chats.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "10px 8px",
                border: "none",
                borderRadius: 8,
                background: c.id === activeId ? colors.yellow : "transparent",
                color: colors.navy,
                cursor: "pointer",
                marginBottom: 4,
              }}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: "bold", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</div>
                <div style={{ fontSize: 13, color: colors.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {previewOf(c)}
                </div>
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                {c.last_at && <span style={{ fontSize: 12, color: colors.gray }}>{shortDate(c.last_at)}</span>}
                {c.unread > 0 && (
                  <span style={{ background: colors.navy, color: colors.yellow, borderRadius: 999, padding: "0 7px", fontSize: 12, fontWeight: "bold" }}>
                    {c.unread}
                  </span>
                )}
              </span>
            </button>
          ))}
          {chats.length === 0 && <p style={{ color: colors.gray }}>Чатов пока нет.</p>}
        </aside>
      )}

      {active && (
        <section style={{ flex: 1, minWidth: 0 }}>
          <ChatView
            key={active.id}
            chat={active}
            viewer={viewer}
            ably={ably}
            onBack={wide ? undefined : () => setActiveId(null)}
            onRead={loadChats}
          />
        </section>
      )}

      {!active && wide && (
        <div style={{ ...card, flex: 1, color: colors.gray }}>Выберите чат слева, чтобы начать переписку.</div>
      )}

      {showNew && (
        <NewChatPanel viewerId={viewer.id} onCreated={chatCreated} onClose={() => setShowNew(false)} />
      )}
    </div>
  );
}

function ChatView({
  chat,
  viewer,
  ably,
  onBack,
  onRead,
}: {
  chat: ChatItem;
  viewer: User;
  ably: Ably.Realtime | null;
  onBack?: () => void;
  onRead: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const committee = COMMITTEE_ROLES.includes(viewer.role);
  const moderated = committee && (chat.kind === "general" || chat.kind === "committee");

  function merge(incoming: Msg[]) {
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m] as const));
      for (const m of incoming) map.set(m.id, m);
      return [...map.values()].sort((a, b) => a.id - b.id);
    });
  }

  async function loadLatest() {
    const { status, data } = await request(`/api/chats/${chat.id}/messages`);
    if (status === 200) {
      merge(data.messages);
      setHasMore(data.messages.length >= PAGE);
    } else setErr(data.error ?? "Не удалось загрузить сообщения");
  }

  async function loadOlder() {
    const first = messages[0]?.id;
    if (!first) return;
    const { status, data } = await request(`/api/chats/${chat.id}/messages?before=${first}`);
    if (status === 200) {
      merge(data.messages);
      setHasMore(data.messages.length >= PAGE);
    }
  }

  useEffect(() => {
    setMessages([]);
    setEditing(null);
    setText("");
    loadLatest();
  }, [chat.id]);

  // Подписка на события этого чата: новые сообщения, правки, удаления и реакции
  useEffect(() => {
    if (!ably) return;
    const channel = ably.channels.get(`chat:${chat.id}`);
    const onMessage = (m: Ably.Message) => merge([parseEvent<Msg>(m.data)]);
    const onEdit = (m: Ably.Message) => {
      const d = parseEvent<{ id: number; body: string; edited_at: string }>(m.data);
      setMessages((prev) => prev.map((x) => (x.id === d.id ? { ...x, body: d.body, edited_at: d.edited_at } : x)));
    };
    const onDelete = (m: Ably.Message) => {
      const d = parseEvent<{ id: number }>(m.data);
      setMessages((prev) => prev.map((x) => (x.id === d.id ? { ...x, body: "", deleted: true, attachment_id: null } : x)));
    };
    const onReact = () => loadLatest();
    channel.subscribe("message", onMessage);
    channel.subscribe("edit", onEdit);
    channel.subscribe("delete", onDelete);
    channel.subscribe("react", onReact);
    return () => {
      channel.unsubscribe("message", onMessage);
      channel.unsubscribe("edit", onEdit);
      channel.unsubscribe("delete", onDelete);
      channel.unsubscribe("react", onReact);
    };
  }, [ably, chat.id]);

  // Отметка «прочитано» и прокрутка вниз при новых сообщениях
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!lastId) return;
    request(`/api/chats/${chat.id}/read`, "POST", { last_id: lastId })
      .then(() => onRead())
      .catch(() => undefined);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastId]);

  async function sendText() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr("");
    try {
      if (editing) {
        const { status, data } = await request(`/api/messages/${editing.id}`, "PUT", { body });
        if (status === 200) {
          const edited = editing;
          setMessages((prev) =>
            prev.map((x) => (x.id === edited.id ? { ...x, body, edited_at: new Date().toISOString() } : x)),
          );
          setEditing(null);
          setText("");
        } else setErr(data.error ?? "Не удалось сохранить");
      } else {
        const { status, data } = await request(`/api/chats/${chat.id}/messages`, "POST", { body });
        if (status === 201) {
          merge([data.message]);
          setText("");
        } else setErr(data.error ?? "Не удалось отправить");
      }
    } catch {
      setErr("Нет связи с сервером");
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: File) {
    if (file.size > MAX_FILE) {
      setErr("Файл больше 20 МБ");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const up = await uploadAttachment(file);
      if (!up.ok || !up.id) {
        setErr(up.error ?? "Не удалось загрузить файл");
        return;
      }
      const { status, data } = await request(`/api/chats/${chat.id}/messages`, "POST", {
        body: text.trim(),
        attachment_id: up.id,
        attachment_name: file.name,
        attachment_kind: file.type.startsWith("image/") ? "image" : "file",
      });
      if (status === 201) {
        merge([data.message]);
        setText("");
      } else setErr(data.error ?? "Не удалось отправить");
    } catch {
      setErr("Нет связи с сервером");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(m: Msg) {
    if (!window.confirm("Удалить сообщение?")) return;
    const { status, data } = await request(`/api/messages/${m.id}`, "DELETE");
    if (status === 200) {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, body: "", deleted: true, attachment_id: null } : x)));
    } else setErr(data.error ?? "Не удалось удалить");
  }

  function startEdit(m: Msg) {
    setEditing(m);
    setText(m.body);
  }

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        {onBack && (
          <button onClick={onBack} style={{ background: "none", border: "none", color: colors.blue, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 16 }}>
            ← Назад
          </button>
        )}
        <b style={{ fontSize: 18 }}>{chat.title}</b>
      </div>

      <div style={{ height: "calc(100vh - 300px)", minHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "4px 2px" }}>
        {hasMore && (
          <button onClick={loadOlder} style={{ alignSelf: "center", ...inlineButton, padding: "4px 12px", fontSize: 13 }}>
            Загрузить раньше
          </button>
        )}
        {messages.map((m) => {
          const own = m.author_id === viewer.id;
          const canEdit = own && !m.deleted && !m.attachment_id;
          const canDelete = !m.deleted && (own || moderated);
          return (
            <div key={m.id} style={{ alignSelf: own ? "flex-end" : "flex-start", maxWidth: "80%" }}>
              <div
                style={{
                  background: own ? colors.yellow : colors.field,
                  color: colors.navy,
                  borderRadius: 12,
                  padding: "6px 10px",
                }}
              >
                {!own && <div style={{ fontSize: 12, fontWeight: "bold", color: colors.blue }}>{m.author_name}</div>}
                {m.deleted ? (
                  <div style={{ fontStyle: "italic", color: colors.gray }}>Сообщение удалено</div>
                ) : (
                  <>
                    {m.attachment_id && m.attachment_kind === "image" && <AttachmentImage id={m.attachment_id} name={m.attachment_name ?? "фото"} />}
                    {m.attachment_id && m.attachment_kind !== "image" && (
                      <button
                        onClick={() => downloadAttachment(m.attachment_id!, m.attachment_name ?? "file")}
                        style={{ background: "none", border: "none", color: colors.blue, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 14 }}
                      >
                        📎 {m.attachment_name ?? "Файл"}
                      </button>
                    )}
                    {m.body && <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>}
                  </>
                )}
                <div style={{ fontSize: 11, color: colors.gray, textAlign: "right" }}>
                  {timeText(m.created_at)}
                  {m.edited_at ? " · изменено" : ""}
                </div>
              </div>
              {!m.deleted && (
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 2, justifyContent: own ? "flex-end" : "flex-start" }}>
                  {canEdit && (
                    <button onClick={() => startEdit(m)} style={linkStyle}>Изменить</button>
                  )}
                  {canDelete && (
                    <button onClick={() => remove(m)} style={linkStyle}>Удалить</button>
                  )}
                </div>
              )}
              {!m.deleted && (
                <ReactionBar
                  reactions={m.reactions}
                  onPick={async (emoji) => {
                    await request("/api/reactions", "POST", { target_type: "message", target_id: m.id, emoji });
                    loadLatest();
                  }}
                />
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {editing && (
        <div style={{ fontSize: 13, color: colors.blue, marginTop: 6 }}>
          Редактирование сообщения ·{" "}
          <button onClick={() => { setEditing(null); setText(""); }} style={linkStyle}>Отмена</button>
        </div>
      )}
      {err && <div style={{ color: "#b00020", fontSize: 13, marginTop: 4 }}>{err}</div>}

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          sendText();
        }}
        style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8 }}
      >
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) attach(f);
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || !!editing} style={{ ...inlineButton, padding: "8px 12px" }}>
          Прикрепить
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendText();
            }
          }}
          rows={2}
          placeholder="Написать сообщение"
          style={{ ...input, flex: 1, resize: "none" }}
        />
        <button type="submit" style={inlineButton} disabled={busy || !text.trim()}>
          {editing ? "Сохранить" : "Отправить"}
        </button>
      </form>
    </div>
  );
}

const linkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: colors.gray,
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
  fontSize: 12,
};

function AttachmentImage({ id, name }: { id: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    loadAttachmentUrl(id).then((u) => {
      url = u;
      setSrc(u);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (!src) return <div style={{ fontSize: 13, color: colors.gray }}>Загрузка фото…</div>;
  return <img src={src} alt={name} style={{ display: "block", maxWidth: 260, maxHeight: 260, borderRadius: 8, marginBottom: 4 }} />;
}

function NewChatPanel({
  viewerId,
  onCreated,
  onClose,
}: {
  viewerId: number;
  onCreated: (id: number) => void;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<{ id: number; full_name: string }[]>([]);
  const [mode, setMode] = useState<"personal" | "group">("personal");
  const [personalId, setPersonalId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    request("/api/profiles").then(({ status, data }) => {
      if (status === 200) setUsers((data.users as { id: number; full_name: string }[]).filter((u) => u.id !== viewerId));
    });
  }, []);

  async function create() {
    setErr("");
    if (mode === "personal") {
      if (!personalId) {
        setErr("Выберите собеседника");
        return;
      }
      const { status, data } = await request("/api/chats", "POST", { kind: "personal", user_id: personalId });
      if (status === 200 || status === 201) onCreated(data.id);
      else setErr(data.error ?? "Не удалось создать чат");
    } else {
      const { status, data } = await request("/api/chats", "POST", { kind: "group", title, member_ids: picked });
      if (status === 200 || status === 201) onCreated(data.id);
      else setErr(data.error ?? "Не удалось создать группу");
    }
  }

  return (
    <div style={{ ...card, width: "min(420px, 100%)", position: "fixed", top: 80, left: "50%", transform: "translateX(-50%)", zIndex: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button style={{ ...inlineButton, opacity: mode === "personal" ? 1 : 0.6 }} onClick={() => setMode("personal")}>Личный чат</button>
        <button style={{ ...inlineButton, opacity: mode === "group" ? 1 : 0.6 }} onClick={() => setMode("group")}>Группа</button>
      </div>

      {mode === "personal" ? (
        <select style={input} value={personalId ?? ""} onChange={(e) => setPersonalId(Number(e.target.value) || null)}>
          <option value="">Выберите участника</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.full_name}</option>
          ))}
        </select>
      ) : (
        <>
          <label>
            Название группы
            <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
          </label>
          <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }}>
            {users.map((u) => (
              <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <input
                  type="checkbox"
                  checked={picked.includes(u.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id)))}
                />
                {u.full_name}
              </label>
            ))}
          </div>
        </>
      )}

      {err && <p style={{ color: "#b00020" }}>{err}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button style={inlineButton} onClick={create}>Создать</button>
        <button style={inlineButton} onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}

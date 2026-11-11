// Чаты в стиле Telegram: слева список диалогов, справа сам чат.
// Новые сообщения приходят через Ably, без перезагрузки страницы.
import { CSSProperties, FormEvent, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { enablePush, disablePush } from "../push";
import * as Ably from "ably";
import { COMMITTEE_ROLES, User, downloadAttachment, loadAttachmentUrl, loadImage, request, uploadAttachment, uploadFile } from "../api";
import { button, card, colors, input } from "../styles";

// Кнопки в строках и шапке не растягиваются на всю ширину
const inlineButton: CSSProperties = { ...button, width: "auto", whiteSpace: "nowrap" };
import { TabIcon } from "../TabIcon";

interface ChatItem {
  id: number;
  kind: string;
  title: string;
  photo_id: string | null;
  description: string | null;
  invite_mode: string;
  edit_mode: string;
  created_by: number | null;
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
  reply_to: { id: number; author_name: string; body: string } | null;
  forwarded_from: string | null;
}

const PAGE = 50;
const MAX_FILE = 20 * 1024 * 1024;

// Настройки уведомлений: хранятся в браузере на этом устройстве
function readSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Настройка не сохранится, но чат работает
  }
}

// Аватарка: фото, а если его нет — первая буква названия
function ChatAvatar({ photoId, title, size = 40 }: { photoId: string | null; title: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    setSrc(null);
    if (photoId) {
      loadImage(photoId).then((u) => {
        url = u;
        setSrc(u);
      });
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [photoId]);
  const box: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: colors.yellow,
    color: colors.navy,
    fontWeight: "bold",
    fontSize: size / 2.5,
  };
  if (src) return <img src={src} alt="" style={{ ...box, objectFit: "cover", background: "none" }} />;
  return <div style={box}>{(title.trim()[0] ?? "?").toUpperCase()}</div>;
}

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
  const [showSettings, setShowSettings] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [query, setQuery] = useState("");
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
    if (!readSetting("chat-notify", false)) return;
    if (readSetting(`chat-mute-${msg.chat_id}`, false)) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const preview = readSetting("chat-notify-preview", true);
    try {
      new Notification(msg.author_name, {
        body: !preview ? "Новое сообщение" : msg.body || (msg.attachment_kind === "image" ? "📷 Фото" : "📎 Файл"),
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
  const shownChats = chats.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div style={wide ? { display: "flex", gap: 16, alignItems: "flex-start" } : undefined}>
      {(wide || !active) && (
        <aside style={{ width: wide ? 300 : "100%", flexShrink: 0, ...card, background: "#0b1420", color: "#f5f5f5", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ fontSize: 18 }}>Чаты</b>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...inlineButton, padding: "6px 10px", fontSize: 13 }} onClick={() => setShowSettings(true)}>Настройки</button>
              <button style={{ ...inlineButton, padding: "6px 10px", fontSize: 13 }} onClick={() => setShowNew(true)}>+ Новый чат</button>
            </div>
          </div>
          <input style={{ ...input, marginBottom: 8 }} placeholder="Поиск чатов" value={query} onChange={(e) => setQuery(e.target.value)} />
          {error && <p style={{ color: "#b00020" }}>{error}</p>}
          {shownChats.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                // Выбор чата закрывает панель «Новый чат», иначе она перекрывает список
                setShowNew(false);
                setActiveId(c.id);
              }}
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
                color: c.id === activeId ? colors.navy : "#f5f5f5",
                cursor: "pointer",
                marginBottom: 4,
              }}
            >
              <ChatAvatar photoId={c.photo_id} title={c.title} size={36} />
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
          {chats.length > 0 && shownChats.length === 0 && <p style={{ color: colors.gray }}>Ничего не найдено.</p>}
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
            onChanged={loadChats}
            onInfo={() => setShowInfo(true)}
          />
        </section>
      )}

      {!active && wide && (
        <div style={{ ...card, background: "#0b1420", flex: 1, color: colors.gray }}>Выберите чат слева, чтобы начать переписку.</div>
      )}

      {showNew && (
        <NewChatPanel viewerId={viewer.id} onCreated={chatCreated} onClose={() => setShowNew(false)} />
      )}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showInfo && active && (
        <ChatInfoPanel
          chat={active}
          viewer={viewer}
          onClose={() => setShowInfo(false)}
          onChanged={loadChats}
          onLeft={() => {
            setShowInfo(false);
            setActiveId(null);
            loadChats();
          }}
        />
      )}
    </div>
  );
}

interface PinnedMsg {
  id: number;
  body: string;
  author_name: string;
  attachment_kind: string | null;
}

// Закреплять сообщения: в группе — кому разрешено менять информацию, в общих чатах — комсоставу, в личных — любому участнику
function canPinChat(chat: ChatItem, viewer: User): boolean {
  if (chat.kind === "personal" || chat.kind === "favorites") return true;
  return canEditChat(chat, viewer);
}

// Реакции под сообщением: только счётчики, добавлять и убирать их можно через меню сообщения
const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👏", "🙏"];

function ReactionChips({ reactions, onPick }: { reactions: Reaction[]; onPick: (emoji: string) => void }) {
  if (reactions.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          title={r.users.join(", ")}
          onClick={() => onPick(r.emoji)}
          style={{
            border: "none",
            borderRadius: 12,
            padding: "2px 8px",
            fontSize: 13,
            cursor: "pointer",
            color: colors.navy,
            background: r.mine ? colors.yellow : colors.field,
          }}
        >
          {r.emoji} {r.count}
        </button>
      ))}
    </div>
  );
}

// Меню сообщения по правому клику: реакции сверху, затем действия
function MessageMenu({
  x,
  y,
  canPin,
  pinned,
  canCopy,
  canDownload,
  canEdit,
  canDelete,
  onReact,
  onReply,
  onPin,
  onCopy,
  onDownload,
  onEdit,
  onForward,
  onSelect,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  canPin: boolean;
  pinned: boolean;
  canCopy: boolean;
  canDownload: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onPin: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onEdit: () => void;
  onForward: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const left = Math.max(8, Math.min(x, window.innerWidth - 268));
  const top = Math.max(8, Math.min(y, window.innerHeight - 440));
  const item: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    padding: "10px 16px",
    fontSize: 15,
    cursor: "pointer",
    color: "#f5f5f5",
  };
  return (
    <div
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 40 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "fixed", left, top, width: 260, background: "#0b1420", borderRadius: 14, boxShadow: "0 6px 24px rgba(0,0,0,0.25)", overflow: "hidden", padding: "6px 0" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 10px 8px" }}>
          {QUICK_EMOJI.map((emoji) => (
            <button key={emoji} onClick={() => onReact(emoji)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", padding: 2 }}>
              {emoji}
            </button>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${colors.field}` }}>
          <button onClick={onReply} style={item}>Ответить</button>
          {canPin && <button onClick={onPin} style={item}>{pinned ? "Открепить" : "Закрепить"}</button>}
          {canCopy && <button onClick={onCopy} style={item}>Копировать текст</button>}
          {canDownload && <button onClick={onDownload} style={item}>Скачать</button>}
          {canEdit && <button onClick={onEdit} style={item}>Изменить</button>}
          <button onClick={onForward} style={item}>Переслать</button>
          <button onClick={onSelect} style={item}>Выделить</button>
          {canDelete && <button onClick={onDelete} style={{ ...item, color: "#b00020" }}>Удалить</button>}
        </div>
      </div>
    </div>
  );
}

// Выбор чата для пересылки
function ForwardDialog({
  chats,
  count,
  onPick,
  onClose,
}: {
  chats: ChatItem[];
  count: number;
  onPick: (chatId: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = chats.filter((c) => c.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal onClose={onClose}>
      <div style={{ fontSize: 18, fontWeight: "bold", color: "#f5f5f5", marginBottom: 10 }}>
        Переслать{count > 1 ? ` (${count})` : ""}
      </div>
      <input style={{ ...input, marginBottom: 8 }} placeholder="Поиск чата" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        {shown.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: "none", border: "none", padding: "8px 4px", cursor: "pointer", textAlign: "left", color: colors.navy }}
          >
            <ChatAvatar photoId={c.photo_id} title={c.title} size={36} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
          </button>
        ))}
        {shown.length === 0 && <p style={{ color: colors.gray }}>Чаты не найдены</p>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button onClick={onClose} style={inlineButton}>Отмена</button>
      </div>
    </Modal>
  );
}

// Отдельное окно поверх чата, как в Telegram
function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "min(420px, 100%)", boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
        {children}
      </div>
    </div>
  );
}

function ChatView({
  chat,
  viewer,
  ably,
  onBack,
  onRead,
  onChanged,
  onInfo,
}: {
  chat: ChatItem;
  viewer: User;
  ably: Ably.Realtime | null;
  onBack?: () => void;
  onRead: () => void;
  onChanged: () => void;
  onInfo: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [editText, setEditText] = useState("");
  const [deleting, setDeleting] = useState<number[] | null>(null);
  const [menu, setMenu] = useState<{ msg: Msg; x: number; y: number } | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [pinned, setPinned] = useState<PinnedMsg | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [forwarding, setForwarding] = useState<number[] | null>(null);
  const [chatList, setChatList] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const committee = COMMITTEE_ROLES.includes(viewer.role);
  const moderated = committee && (chat.kind === "general" || chat.kind === "committee");
  // Фото меняет любой участник группы, а фото общих чатов — только комсостав
  const canSetPhoto = chat.kind === "group" || (committee && (chat.kind === "general" || chat.kind === "committee"));
  const canPin = canPinChat(chat, viewer);
  const photoRef = useRef<HTMLInputElement>(null);

  async function setPhoto(file: File) {
    setErr("");
    const up = await uploadFile(file);
    if (!up.ok || !up.id) {
      setErr(up.error ?? "Не удалось загрузить фото");
      return;
    }
    const { status, data } = await request(`/api/chats/${chat.id}/photo`, "PUT", { photo_id: up.id });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось сменить фото");
  }

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
      setPinned(data.pinned ?? null);
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
    setDeleting(null);
    setMenu(null);
    setReplyTo(null);
    setPinned(null);
    setSelectMode(false);
    setSelected([]);
    setForwarding(null);
    setText("");
    loadLatest();
  }, [chat.id]);

  // Подписка на события этого чата: сообщения, правки, удаления, реакции и закрепление
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
      setMessages((prev) => prev.filter((x) => x.id !== d.id));
      loadLatest();
    };
    const onRefresh = () => loadLatest();
    channel.subscribe("message", onMessage);
    channel.subscribe("edit", onEdit);
    channel.subscribe("delete", onDelete);
    channel.subscribe("react", onRefresh);
    channel.subscribe("pin", onRefresh);
    return () => {
      channel.unsubscribe("message", onMessage);
      channel.unsubscribe("edit", onEdit);
      channel.unsubscribe("delete", onDelete);
      channel.unsubscribe("react", onRefresh);
      channel.unsubscribe("pin", onRefresh);
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

  function insertEmoji(emoji: string) {
    const el = textRef.current;
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // Закрываем панель смайлов при клике вне её (кнопка смайлика переключает сама)
  useEffect(() => {
    if (!pickerOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (pickerRef.current?.contains(target) || target.closest("[data-emoji-toggle]")) return;
      setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  async function sendText() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr("");
    try {
      const { status, data } = await request(`/api/chats/${chat.id}/messages`, "POST", { body, reply_to_id: replyTo?.id ?? null });
      if (status === 201) {
        merge([data.message]);
        setText("");
        setReplyTo(null);
      } else setErr(data.error ?? "Не удалось отправить");
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
        reply_to_id: replyTo?.id ?? null,
      });
      if (status === 201) {
        merge([data.message]);
        setText("");
        setReplyTo(null);
      } else setErr(data.error ?? "Не удалось отправить");
    } catch {
      setErr("Нет связи с сервером");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function confirmDelete() {
    const ids = deleting ?? [];
    setDeleting(null);
    for (const id of ids) {
      const { status, data } = await request(`/api/messages/${id}`, "DELETE");
      if (status === 200) setMessages((prev) => prev.filter((x) => x.id !== id));
      else {
        setErr(data.error ?? "Не удалось удалить");
        break;
      }
    }
    endSelect();
  }

  async function saveEdit() {
    if (!editing) return;
    const body = editText.trim();
    if (!body) return;
    const id = editing.id;
    const { status, data } = await request(`/api/messages/${id}`, "PUT", { body });
    if (status === 200) {
      setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, body, edited_at: new Date().toISOString() } : x)));
      setEditing(null);
    } else setErr(data.error ?? "Не удалось сохранить");
  }

  function startEdit(m: Msg) {
    setMenu(null);
    setEditing(m);
    setEditText(m.body);
  }

  async function react(m: Msg, emoji: string) {
    setMenu(null);
    await request("/api/reactions", "POST", { target_type: "message", target_id: m.id, emoji });
    loadLatest();
  }

  async function setPinState(id: number, pin: boolean) {
    const { status, data } = await request(`/api/messages/${id}/pin`, "PUT", { pinned: pin });
    if (status === 200) loadLatest();
    else setErr(data.error ?? "Не удалось закрепить");
  }

  function openForward(ids: number[]) {
    setMenu(null);
    setForwarding(ids);
    request("/api/chats")
      .then(({ status, data }) => {
        if (status === 200) setChatList(data.chats);
      })
      .catch(() => undefined);
  }

  async function forwardTo(chatId: number) {
    const ids = forwarding ?? [];
    setForwarding(null);
    for (const id of ids) await request(`/api/messages/${id}/forward`, "POST", { chat_id: chatId });
    endSelect();
    if (chatId === chat.id) loadLatest();
  }

  function startSelect(m: Msg) {
    setMenu(null);
    setSelectMode(true);
    setSelected([m.id]);
  }

  function toggleSelect(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function endSelect() {
    setSelectMode(false);
    setSelected([]);
  }

  function scrollToMessage(id: number) {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div style={{ ...card, background: "#0b1420", display: "flex", flexDirection: "column", padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        {onBack && (
          <button onClick={onBack} style={{ background: "none", border: "none", color: colors.blue, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 16 }}>
            ← Назад
          </button>
        )}
        <button
          onClick={onInfo}
          title="Информация о чате"
          style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, cursor: "pointer", color: "#f5f5f5", textAlign: "left" }}
        >
          <ChatAvatar photoId={chat.photo_id} title={chat.title} size={36} />
          <b style={{ fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{chat.title}</b>
        </button>
        {canSetPhoto && (
          <>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setPhoto(f);
                if (photoRef.current) photoRef.current.value = "";
              }}
            />
            <button onClick={() => photoRef.current?.click()} style={linkStyle}>Фото чата</button>
          </>
        )}
      </div>

      {pinned && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#17212b", borderRadius: 8, padding: "6px 10px", marginBottom: 6 }}>
          <button
            onClick={() => scrollToMessage(pinned.id)}
            style={{ flex: 1, minWidth: 0, background: "none", border: "none", textAlign: "left", cursor: "pointer", color: "#f5f5f5", padding: 0 }}
          >
            <div style={{ fontSize: 12, color: colors.blue, fontWeight: "bold" }}>📌 Закреплено · {pinned.author_name}</div>
            <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {pinned.body || (pinned.attachment_kind === "image" ? "Фото" : "Файл")}
            </div>
          </button>
          {canPin && (
            <button onClick={() => setPinState(pinned.id, false)} aria-label="Открепить" style={linkStyle}>✕</button>
          )}
        </div>
      )}

      <div style={{ height: "calc(100vh - 320px)", minHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "4px 2px" }}>
        {hasMore && (
          <button onClick={loadOlder} style={{ alignSelf: "center", ...inlineButton, padding: "4px 12px", fontSize: 13 }}>
            Загрузить раньше
          </button>
        )}
        {messages.map((m) => {
          const own = m.author_id === viewer.id;
          const isSelected = selected.includes(m.id);
          return (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              onMouseEnter={() => setHoverId(m.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === m.id ? null : cur))}
              style={{ alignSelf: own ? "flex-end" : "flex-start", maxWidth: "80%", position: "relative" }}
            >
              <div
                onClick={() => {
                  if (selectMode && !m.deleted) toggleSelect(m.id);
                }}
                onContextMenu={(e) => {
                  if (m.deleted) return;
                  e.preventDefault();
                  setMenu({ msg: m, x: e.clientX, y: e.clientY });
                }}
                style={{
                  background: own ? colors.yellow : colors.field,
                  color: colors.navy,
                  borderRadius: 12,
                  padding: "6px 10px",
                  cursor: selectMode && !m.deleted ? "pointer" : undefined,
                  outline: isSelected ? `2px solid ${colors.blue}` : undefined,
                }}
              >
                {m.forwarded_from && !m.deleted && (
                  <div style={{ fontSize: 12, fontStyle: "italic", color: colors.gray }}>Переслано от {m.forwarded_from}</div>
                )}
                {!own && <div style={{ fontSize: 12, fontWeight: "bold", color: colors.blue }}>{m.author_name}</div>}
                {m.reply_to && !m.deleted && (
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      scrollToMessage(m.reply_to!.id);
                    }}
                    style={{ borderLeft: `3px solid ${colors.blue}`, paddingLeft: 6, margin: "2px 0 4px", background: "rgba(0,0,0,0.05)", borderRadius: 4, cursor: "pointer" }}
                  >
                    <div style={{ fontSize: 12, fontWeight: "bold", color: colors.blue }}>{m.reply_to.author_name}</div>
                    <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.reply_to.body || "Вложение"}</div>
                  </div>
                )}
                {m.deleted ? (
                  <div style={{ fontStyle: "italic", color: colors.gray }}>Сообщение удалено</div>
                ) : (
                  <>
                    {m.attachment_id && m.attachment_kind === "image" && <AttachmentImage id={m.attachment_id} name={m.attachment_name ?? "фото"} />}
                    {m.attachment_id && m.attachment_kind !== "image" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadAttachment(m.attachment_id!, m.attachment_name ?? "file");
                        }}
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
              {hoverId === m.id && !m.deleted && !selectMode && (
                <div
                  style={{
                    position: "absolute",
                    top: -14,
                    ...(own ? { right: 6 } : { left: 6 }),
                    display: "flex",
                    alignItems: "center",
                    background: colors.navy,
                    borderRadius: 16,
                    padding: 2,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                    zIndex: 5,
                  }}
                >
                  <button type="button" onClick={() => setReplyTo(m)} aria-label="Ответить" style={hoverButton}>
                    <ReplyIcon />
                  </button>
                  <span style={{ width: 1, height: 18, background: "rgba(255,255,255,0.2)" }} />
                  <button
                    type="button"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenu({ msg: m, x: r.left, y: r.bottom + 4 });
                    }}
                    aria-label="Действия"
                    style={hoverButton}
                  >
                    <DotsIcon />
                  </button>
                </div>
              )}
              {!m.deleted && <ReactionChips reactions={m.reactions} onPick={(emoji) => react(m, emoji)} />}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {menu && (
        <MessageMenu
          x={menu.x}
          y={menu.y}
          canPin={canPin}
          pinned={pinned?.id === menu.msg.id}
          canCopy={!!menu.msg.body}
          canDownload={!!menu.msg.attachment_id}
          onDownload={() => {
            const m = menu.msg;
            setMenu(null);
            if (m.attachment_id) downloadAttachment(m.attachment_id, m.attachment_name ?? "file").then((e) => { if (e) setErr(e); });
          }}
          canEdit={menu.msg.author_id === viewer.id && !menu.msg.attachment_id}
          canDelete={menu.msg.author_id === viewer.id || moderated}
          onReact={(emoji) => react(menu.msg, emoji)}
          onReply={() => {
            setMenu(null);
            setReplyTo(menu.msg);
          }}
          onPin={() => {
            const id = menu.msg.id;
            const pin = pinned?.id !== id;
            setMenu(null);
            setPinState(id, pin);
          }}
          onCopy={() => {
            navigator.clipboard?.writeText(menu.msg.body).catch(() => undefined);
            setMenu(null);
          }}
          onEdit={() => startEdit(menu.msg)}
          onForward={() => openForward([menu.msg.id])}
          onSelect={() => startSelect(menu.msg)}
          onDelete={() => {
            setDeleting([menu.msg.id]);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <div style={{ fontSize: 18, fontWeight: "bold", color: "#f5f5f5" }}>Изменить сообщение</div>
          <textarea
            style={{ ...input, minHeight: 100, resize: "vertical", marginTop: 10 }}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setEditing(null)} style={inlineButton}>Отмена</button>
            <button onClick={saveEdit} disabled={!editText.trim()} style={inlineButton}>Сохранить</button>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <div style={{ fontSize: 16, color: "#f5f5f5" }}>
            {deleting.length === 1 ? "Удалить сообщение?" : `Удалить сообщения (${deleting.length})?`} Восстановить нельзя.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button onClick={() => setDeleting(null)} style={inlineButton}>Отмена</button>
            <button onClick={confirmDelete} style={{ ...inlineButton, background: "#b00020", color: "#fff" }}>Удалить</button>
          </div>
        </Modal>
      )}

      {forwarding && <ForwardDialog chats={chatList} count={forwarding.length} onPick={forwardTo} onClose={() => setForwarding(null)} />}

      {err && <div style={{ color: "#ff8a8a", fontSize: 13, marginTop: 4 }}>{err}</div>}

      {selectMode ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, background: colors.navy, borderRadius: 24, padding: "10px 16px", color: "#fff" }}>
          <button onClick={endSelect} style={{ ...linkStyle, color: "#fff" }}>Отмена</button>
          <span>Выбрано: {selected.length}</span>
          <div style={{ display: "flex", gap: 14 }}>
            <button onClick={() => openForward(selected)} disabled={selected.length === 0} style={{ ...linkStyle, color: "#fff" }}>Переслать</button>
            <button onClick={() => setDeleting(selected)} disabled={selected.length === 0} style={{ ...linkStyle, color: "#ff8a8a" }}>Удалить</button>
          </div>
        </div>
      ) : (
        <>
          {replyTo && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: colors.blue, marginTop: 6 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Ответ на сообщение {replyTo.author_name}: {replyTo.body || "вложение"}
              </span>
              <button onClick={() => setReplyTo(null)} aria-label="Отменить ответ" style={linkStyle}>✕</button>
            </div>
          )}
          <div style={{ position: "relative", marginTop: 8 }}>
          {pickerOpen && <EmojiPicker pickerRef={pickerRef} onPick={insertEmoji} />}
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              sendText();
            }}
            style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 0, background: colors.navy, borderRadius: 24, padding: "4px 8px 4px 6px" }}
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
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Прикрепить файл" style={composerIconButton}>
              <ClipIcon />
            </button>
            <textarea
              ref={textRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendText();
                }
              }}
              rows={1}
              placeholder="Сообщение..."
              style={{
                flex: 1,
                resize: "none",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#f5f5f5",
                fontSize: 16,
                fontFamily: "inherit",
                padding: "8px 4px",
                maxHeight: 120,
              }}
            />
            <button
              type="button"
              data-emoji-toggle
              onClick={() => setPickerOpen((open) => !open)}
              aria-label="Смайлики"
              style={{ ...composerIconButton, color: pickerOpen ? colors.yellow : composerIconButton.color }}
            >
              <SmileIcon />
            </button>
            {text.trim() ? (
              <button type="submit" disabled={busy} aria-label="Отправить" style={composerIconButton}>
                <SendIcon />
              </button>
            ) : (
              <button type="button" disabled aria-label="Голосовое сообщение" style={composerIconButton}>
                <MicIcon />
              </button>
            )}
          </form>
          </div>
        </>
      )}
    </div>
  );
}

const hoverButton: CSSProperties = {
  background: "none",
  border: "none",
  padding: "6px 8px",
  cursor: "pointer",
  color: "#f5f5f5",
  display: "flex",
  alignItems: "center",
};

function ReplyIcon() {
  return (
    <svg {...iconProps} width={18} height={18}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 6 6v3" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="18" cy="12" r="1.8" fill="currentColor" />
    </svg>
  );
}

const composerIconButton: CSSProperties = {
  background: "none",
  border: "none",
  padding: 6,
  cursor: "pointer",
  color: "#6c7883",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const iconProps = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ClipIcon() {
  return (
    <svg {...iconProps}>
      <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-2.8-2.8l8.2-8.2" />
    </svg>
  );
}

const EMOJI_SET = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "😉", "😍", "🥰", "😘", "😋",
  "😎", "🤩", "🥳", "😏", "😒", "😔", "😢", "😭", "😤", "😡", "🤔", "🤨", "😐", "😶", "😴", "🤒",
  "👍", "👎", "👏", "🙌", "🙏", "💪", "🤝", "👌", "✌️", "🤞", "👋", "🫡", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🔥", "⭐", "✨", "🎉", "🎂", "💯", "✅", "❌", "⚠️", "📌", "📎", "📷", "🎵", "🏆",
];

function EmojiPicker({ pickerRef, onPick }: { pickerRef: RefObject<HTMLDivElement | null>; onPick: (emoji: string) => void }) {
  return (
    <div
      ref={pickerRef}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: 0,
        width: 296,
        maxWidth: "100%",
        background: colors.navy,
        border: `1px solid ${colors.blue}`,
        borderRadius: 16,
        padding: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        display: "grid",
        gridTemplateColumns: "repeat(8, 1fr)",
        gap: 2,
        zIndex: 50,
      }}
    >
      {EMOJI_SET.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onPick(emoji)}
          aria-label={`Смайлик ${emoji}`}
          style={{ background: "none", border: "none", fontSize: 22, padding: 4, cursor: "pointer", borderRadius: 8, lineHeight: 1 }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

function SmileIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M8 14.2c1 1.3 2.4 2 4 2s3-.7 4-2" />
      <circle cx="9" cy="10" r="0.8" fill="currentColor" />
      <circle cx="15" cy="10" r="0.8" fill="currentColor" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg {...iconProps}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...iconProps} stroke="#5ca9e6">
      <path d="M4 12l16-8-6 16-2.5-6.5z" />
    </svg>
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
  const [mode, setMode] = useState<"personal" | "group">("group");
  const [personalId, setPersonalId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const found = users.filter((u) => u.full_name.toLowerCase().includes(search.trim().toLowerCase()));

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
        <button style={{ ...inlineButton, opacity: mode === "group" ? 1 : 0.6 }} onClick={() => setMode("group")}>Группа</button>
      </div>

      <input style={{ ...input, marginBottom: 8 }} placeholder="Поиск участника" value={search} onChange={(e) => setSearch(e.target.value)} />
      {mode === "personal" ? (
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          {found.map((u) => (
            <button
              key={u.id}
              onClick={() => setPersonalId(u.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                border: "none",
                borderRadius: 8,
                marginBottom: 4,
                cursor: "pointer",
                background: personalId === u.id ? colors.yellow : colors.field,
                color: colors.navy,
              }}
            >
              {u.full_name}
            </button>
          ))}
          {found.length === 0 && <p style={{ color: colors.gray }}>Никого не найдено.</p>}
        </div>
      ) : (
        <>
          <label>
            Название группы
            <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
          </label>
          <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }}>
            {found.map((u) => (
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

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [notify, setNotify] = useState(() => readSetting("chat-notify", false));
  const [preview, setPreview] = useState(() => readSetting("chat-notify-preview", true));
  const [note, setNote] = useState("");

  async function toggleNotify(on: boolean) {
    setNote("");
    if (on) {
      const error = await enablePush();
      if (error) {
        setNote(error);
        return;
      }
    } else {
      await disablePush().catch(() => {});
    }
    writeSetting("chat-notify", on);
    setNotify(on);
  }

  function togglePreview(on: boolean) {
    writeSetting("chat-notify-preview", on);
    setPreview(on);
  }

  const row: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: `1px solid ${colors.field}` };

  return (
    <div style={{ ...card, width: "min(420px, 100%)", position: "fixed", top: 80, left: "50%", transform: "translateX(-50%)", zIndex: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
      <b style={{ fontSize: 18 }}>Настройки чатов</b>
      <div style={row}>
        <span>Уведомления о новых сообщениях</span>
        <input type="checkbox" checked={notify} onChange={(e) => toggleNotify(e.target.checked)} />
      </div>
      <div style={row}>
        <span>Показывать текст в уведомлении</span>
        <input type="checkbox" checked={preview} disabled={!notify} onChange={(e) => togglePreview(e.target.checked)} />
      </div>
      {note && <p style={{ color: "#b00020", fontSize: 13 }}>{note}</p>}
      <p style={{ color: colors.gray, fontSize: 13 }}>Настройки действуют только на этом устройстве.</p>
      <button style={{ ...button, width: "auto", padding: "8px 16px" }} onClick={onClose}>Готово</button>
    </div>
  );
}

interface Member {
  id: number;
  full_name: string;
  role: string;
  photo_id: string | null;
}

// Кто может менять информацию чата (повторяет проверку на сервере)
function canEditChat(chat: ChatItem, viewer: User): boolean {
  if (chat.kind === "group") return chat.created_by === viewer.id || chat.edit_mode === "all";
  if (chat.kind === "general" || chat.kind === "committee") return COMMITTEE_ROLES.includes(viewer.role);
  return false;
}

function GearIcon({ color = colors.navy }: { color?: string }) {
  return (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Экран «Настройки» чата: фото, название, описание и права (для группы)
function ChatSettingsView({
  chat,
  viewer,
  onBack,
  onSaved,
}: {
  chat: ChatItem;
  viewer: User;
  onBack: () => void;
  onSaved: () => void;
}) {
  const isGroup = chat.kind === "group";
  const isCreator = chat.created_by === viewer.id;
  const [title, setTitle] = useState(chat.title);
  const [description, setDescription] = useState(chat.description ?? "");
  const [inviteMode, setInviteMode] = useState(chat.invite_mode);
  const [editMode, setEditMode] = useState(chat.edit_mode);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  async function setPhoto(file: File) {
    setErr("");
    const up = await uploadFile(file);
    if (!up.ok || !up.id) return setErr(up.error ?? "Не удалось загрузить фото");
    const { status, data } = await request(`/api/chats/${chat.id}/photo`, "PUT", { photo_id: up.id });
    if (status === 200) onSaved();
    else setErr(data.error ?? "Не удалось сменить фото");
  }

  async function save() {
    setErr("");
    if (isGroup && !title.trim()) return setErr("Введите название группы");
    setSaving(true);
    const body: Record<string, string> = { description };
    if (isGroup) body.title = title.trim();
    if (isGroup && isCreator) {
      body.invite_mode = inviteMode;
      body.edit_mode = editMode;
    }
    const { status, data } = await request(`/api/chats/${chat.id}/settings`, "PUT", body);
    setSaving(false);
    if (status === 200) onSaved();
    else setErr(data.error ?? "Не удалось сохранить");
  }

  const rightsSelect = (value: string, onChange: (v: string) => void) => (
    <select
      style={{ ...input, marginBottom: 14 }}
      value={value}
      disabled={!isCreator}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="all">Все участники</option>
      <option value="creator">Только создатель</option>
    </select>
  );

  return (
    <div style={{ ...card, width: "min(460px, 100%)", maxHeight: "85vh", overflowY: "auto", position: "fixed", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <button onClick={onBack} style={{ ...linkStyle, fontSize: 22, color: "#f5f5f5" }} aria-label="Назад">←</button>
        <span style={{ fontSize: 18, fontWeight: "bold" }}>Настройки</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 14 }}>
        <ChatAvatar photoId={chat.photo_id} title={chat.title} size={100} />
        {(isGroup || chat.kind === "general" || chat.kind === "committee") && (
          <>
            <input ref={photoRef} type="file" accept="image/*" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPhoto(f);
              if (photoRef.current) photoRef.current.value = "";
            }} />
            <button onClick={() => photoRef.current?.click()} style={{ ...linkStyle, color: colors.blue, fontSize: 15, marginTop: 8 }}>Изменить фото</button>
          </>
        )}
      </div>

      {isGroup && (
        <>
          <div style={{ color: colors.gray, fontSize: 13, marginBottom: 4 }}>Название</div>
          <input style={{ ...input, marginBottom: 14 }} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
        </>
      )}

      <div style={{ color: colors.gray, fontSize: 13, marginBottom: 4 }}>Описание</div>
      <textarea
        style={{ ...input, minHeight: 80, resize: "vertical", marginBottom: 14 }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={500}
        placeholder="Чем занимается чат"
      />

      {isGroup && (
        <>
          <div style={{ color: colors.gray, fontSize: 13, marginBottom: 4 }}>Кто может приглашать участников в чат</div>
          {rightsSelect(inviteMode, setInviteMode)}
          <div style={{ color: colors.gray, fontSize: 13, marginBottom: 4 }}>Кто может редактировать информацию чата</div>
          {rightsSelect(editMode, setEditMode)}
          {!isCreator && <p style={{ color: colors.gray, fontSize: 13, marginTop: -6 }}>Права может менять только создатель группы.</p>}
        </>
      )}

      {err && <p style={{ color: "#b00020", fontSize: 13 }}>{err}</p>}
      <button onClick={save} disabled={saving} style={button}>{saving ? "Сохранение..." : "Сохранить"}</button>
    </div>
  );
}

// Панель чата: фото, название, участники, уведомления, добавление людей и выход из группы
function ChatInfoPanel({
  chat,
  viewer,
  onClose,
  onChanged,
  onLeft,
}: {
  chat: ChatItem;
  viewer: User;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [muted, setMuted] = useState(() => readSetting(`chat-mute-${chat.id}`, false));
  const [adding, setAdding] = useState(false);
  const [candidates, setCandidates] = useState<Member[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [err, setErr] = useState("");
  const photoRef = useRef<HTMLInputElement>(null);
  const committee = COMMITTEE_ROLES.includes(viewer.role);
  const isGroup = chat.kind === "group";
  const canSetPhoto = isGroup || (committee && (chat.kind === "general" || chat.kind === "committee"));
  const canEdit = canEditChat(chat, viewer);
  const canInvite = isGroup && (chat.invite_mode !== "creator" || chat.created_by === viewer.id);
  const [editing, setEditing] = useState(false);

  async function loadMembers() {
    const { status, data } = await request(`/api/chats/${chat.id}/members`);
    if (status === 200) setMembers(data.members);
    else setErr(data.error ?? "Не удалось загрузить участников");
  }

  useEffect(() => {
    loadMembers();
  }, [chat.id]);

  function toggleMute() {
    const next = !muted;
    writeSetting(`chat-mute-${chat.id}`, next);
    setMuted(next);
  }

  async function startAdding() {
    setErr("");
    const { status, data } = await request("/api/profiles");
    if (status !== 200) return setErr("Не удалось загрузить участников отряда");
    const inChat = new Set(members.map((m) => m.id));
    setCandidates((data.users as Member[]).filter((u) => !inChat.has(u.id)));
    setPicked([]);
    setAdding(true);
  }

  async function addPicked() {
    if (picked.length === 0) return;
    const { status, data } = await request(`/api/chats/${chat.id}/members`, "POST", { user_ids: picked });
    if (status === 200) {
      setAdding(false);
      loadMembers();
      onChanged();
    } else setErr(data.error ?? "Не удалось добавить");
  }

  async function leave() {
    if (!window.confirm("Выйти из группы?")) return;
    const { status, data } = await request(`/api/chats/${chat.id}/members/me`, "DELETE");
    if (status === 200) onLeft();
    else setErr(data.error ?? "Не удалось выйти");
  }

  async function setPhoto(file: File) {
    setErr("");
    const up = await uploadFile(file);
    if (!up.ok || !up.id) return setErr(up.error ?? "Не удалось загрузить фото");
    const { status, data } = await request(`/api/chats/${chat.id}/photo`, "PUT", { photo_id: up.id });
    if (status === 200) onChanged();
    else setErr(data.error ?? "Не удалось сменить фото");
  }

  const actionBtn: CSSProperties = { ...inlineButton, flex: 1, padding: "10px 6px", fontSize: 14 };

  if (editing) {
    return (
      <ChatSettingsView
        chat={chat}
        viewer={viewer}
        onBack={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <div style={{ ...card, width: "min(460px, 100%)", maxHeight: "85vh", overflowY: "auto", position: "fixed", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.3)", textAlign: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {canEdit ? (
          <button onClick={() => setEditing(true)} style={{ ...linkStyle, color: "#f5f5f5" }} aria-label="Настройки">
            <GearIcon />
          </button>
        ) : (
          <span />
        )}
        <button onClick={onClose} style={{ ...linkStyle, fontSize: 22, color: "#f5f5f5" }} aria-label="Закрыть">×</button>
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <ChatAvatar photoId={chat.photo_id} title={chat.title} size={120} />
      </div>
      <div style={{ fontSize: 22, fontWeight: "bold", marginTop: 10 }}>{chat.title}</div>
      {chat.description && <p style={{ marginTop: 8, whiteSpace: "pre-wrap", textAlign: "left" }}>{chat.description}</p>}
      <div style={{ color: colors.gray, marginTop: 4 }}>
        {members.length} {members.length === 1 ? "участник" : members.length < 5 ? "участника" : "участников"}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button onClick={toggleMute} style={actionBtn}>{muted ? "Уведомления выключены" : "Уведомления включены"}</button>
        {canSetPhoto && (
          <>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setPhoto(f);
                if (photoRef.current) photoRef.current.value = "";
              }}
            />
            <button onClick={() => photoRef.current?.click()} style={actionBtn}>Фото чата</button>
          </>
        )}
        {isGroup && <button onClick={leave} style={actionBtn}>Выйти</button>}
      </div>

      {err && <p style={{ color: "#b00020", fontSize: 13 }}>{err}</p>}

      <div style={{ textAlign: "left", marginTop: 16 }}>
        {canInvite && !adding && (
          <button onClick={startAdding} style={{ ...linkStyle, fontSize: 15, color: colors.blue, marginBottom: 8 }}>+ Добавить участников</button>
        )}
        {adding && (
          <div style={{ background: colors.field, borderRadius: 10, padding: 10, marginBottom: 10 }}>
            {candidates.length === 0 && <p style={{ color: colors.gray, margin: 0 }}>Все участники отряда уже в группе.</p>}
            {candidates.map((u) => (
              <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <input
                  type="checkbox"
                  checked={picked.includes(u.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id)))}
                />
                {u.full_name}
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={addPicked} style={inlineButton}>Добавить</button>
              <button onClick={() => setAdding(false)} style={inlineButton}>Отмена</button>
            </div>
          </div>
        )}

        {members.map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${colors.field}` }}>
            <ChatAvatar photoId={m.photo_id} title={m.full_name} size={36} />
            <span style={{ fontWeight: m.id === viewer.id ? "bold" : "normal" }}>
              {m.full_name}
              {m.id === viewer.id ? " (вы)" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

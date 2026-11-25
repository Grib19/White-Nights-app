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
  mention_mode?: string;
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
  author_photo_id?: string | null;
  transcript?: string | null;
  canvas_id?: number | null;
  canvas_mode?: string | null;
  canvas_until?: string | null;
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
// Голосовое длиннее этого срока обрывается автоматически (так файл остаётся небольшим)
const MAX_VOICE_SECONDS = 300;
const MAX_VIDEO_NOTE_SECONDS = 60;

function pickVideoMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
}

// Запись видеокружка: круглый предпросмотр с камеры, таймер, отправка или отмена
function VideoNoteRecorder({ onRecorded, onClose }: { onRecorded: (file: File) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");

  function stopTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    let alive = true;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErr("Видеокружки не поддерживаются в этом браузере");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { width: 480, height: 480, facingMode: "user" }, audio: true })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setReady(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      })
      .catch(() => setErr("Нет доступа к камере или микрофону. Разрешите их в настройках браузера."));
    return () => {
      alive = false;
      cancelledRef.current = true;
      recRef.current?.stop();
      recRef.current = null;
      stopTracks();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    if (recording && seconds >= MAX_VIDEO_NOTE_SECONDS) finish(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, seconds]);

  function start() {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = pickVideoMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunksRef.current = [];
    cancelledRef.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      stopTracks();
      const type = rec.mimeType || mime || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (!cancelledRef.current && blob.size > 0) {
        const ext = type.includes("mp4") ? "mp4" : "webm";
        onRecorded(new File([blob], `Видеокружок ${new Date().toLocaleString("ru-RU").replace(/[:\s,]+/g, "-")}.${ext}`, { type }));
      }
    };
    recRef.current = rec;
    setSeconds(0);
    rec.start();
    setRecording(true);
  }

  function finish(send: boolean) {
    cancelledRef.current = !send;
    setRecording(false);
    const rec = recRef.current;
    recRef.current = null;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    } else {
      stopTracks();
      if (!send) onClose();
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 40, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 16 }}>
      <div style={{ width: 260, height: 260, borderRadius: "50%", overflow: "hidden", background: "#0b1420", border: `3px solid ${recording ? "#ff4d4f" : colors.blue}` }}>
        <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
      </div>
      <div style={{ color: "#f5f5f5", fontVariantNumeric: "tabular-nums", fontSize: 16 }}>
        {recording ? `${formatDuration(seconds)} / ${formatDuration(MAX_VIDEO_NOTE_SECONDS)}` : "Видеокружок до 1 минуты"}
      </div>
      {err && <div style={{ color: "#ff8a8a", textAlign: "center", maxWidth: 300 }}>{err}</div>}
      <div style={{ display: "flex", gap: 12 }}>
        <button type="button" onClick={() => finish(false)} style={inlineButton}>Отмена</button>
        {recording ? (
          <button type="button" onClick={() => finish(true)} style={{ ...button, background: "#ff4d4f", color: "#fff" }}>Отправить</button>
        ) : (
          <button type="button" onClick={start} disabled={!ready} style={button}>● Записать</button>
        )}
      </div>
    </div>
  );
}

// Формат записи, который поддерживает браузер (Chrome/Edge — webm, Safari — mp4)
function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  return `${m}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

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
    setSrc(null);
    // Адрес картинки берётся из общего кеша и не отзывается: при повторном открытии он ещё рабочий
    if (photoId) loadImage(photoId).then(setSrc);
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
  if (chat.last_kind === "audio") return "🎤 Голосовое";
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
  // Звонок в любом чате (не только открытом): баннер поверх списка
  const [liveCall, setLiveCall] = useState<{ chat_id: number; call_id: number; video: boolean; from_name: string } | null>(null);
  // Запрос на присоединение из баннера: передаём открытому ChatView
  const [pendingJoin, setPendingJoin] = useState<{ chat_id: number; call_id: number; video: boolean } | null>(null);

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
      ably.channels.get(`chat:${chat.id}`).subscribe("call", (m) => {
        const d = parseEvent<{ kind: string; call_id: number; chat_id: number; video?: boolean; from_id?: number; from_name?: string }>(m.data);
        if (d.kind === "start") {
          if (d.from_id !== viewer.id) setLiveCall({ chat_id: d.chat_id, call_id: d.call_id, video: !!d.video, from_name: d.from_name ?? "" });
        } else if (d.kind === "end") {
          setLiveCall((cur) => (cur && cur.call_id === d.call_id ? null : cur));
        }
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
        body: !preview ? "Новое сообщение" : msg.body || (msg.attachment_kind === "image" ? "📷 Фото" : msg.attachment_kind === "audio" ? "🎤 Голосовое" : "📎 Файл"),
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

      {liveCall && liveCall.chat_id !== activeId && (
        <div
          role="status"
          style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 60, display: "flex", alignItems: "center", gap: 8, background: colors.yellow, color: colors.navy, borderRadius: 10, padding: "8px 12px", boxShadow: "0 4px 16px rgba(0,0,0,0.35)", maxWidth: "calc(100vw - 32px)" }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            📞 {liveCall.from_name} {liveCall.video ? "начал видеозвонок" : "начал звонок"}
            {chats.find((c) => c.id === liveCall.chat_id) ? ` · ${chats.find((c) => c.id === liveCall.chat_id)?.title}` : ""}
          </span>
          <button
            type="button"
            onClick={() => {
              setPendingJoin({ chat_id: liveCall.chat_id, call_id: liveCall.call_id, video: liveCall.video });
              setLiveCall(null);
              setShowNew(false);
              setActiveId(liveCall.chat_id);
            }}
            style={{ ...inlineButton, padding: "4px 10px" }}
          >
            Присоединиться
          </button>
          <button type="button" onClick={() => setLiveCall(null)} aria-label="Скрыть" style={{ ...linkStyle, color: colors.navy }}>
            ✕
          </button>
        </div>
      )}

      {active && (
        <section style={{ flex: 1, minWidth: 0 }}>
          <ChatView
            key={active.id}
            chat={active}
            viewer={viewer}
            ably={ably}
            pendingJoin={pendingJoin && pendingJoin.chat_id === active.id ? pendingJoin : null}
            onPendingJoinDone={() => setPendingJoin(null)}
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
  pendingJoin,
  onPendingJoinDone,
}: {
  chat: ChatItem;
  viewer: User;
  ably: Ably.Realtime | null;
  onBack?: () => void;
  onRead: () => void;
  onChanged: () => void;
  onInfo: () => void;
  pendingJoin?: { chat_id: number; call_id: number; video: boolean } | null;
  onPendingJoinDone?: () => void;
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
  const [flashId, setFlashId] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [canvasPicking, setCanvasPicking] = useState(false);
  const [canvasStep, setCanvasStep] = useState<"type" | "settings">("type");
  const [canvasEditors, setCanvasEditors] = useState<"all" | "managers" | "author">("all");
  const [canvasUntil, setCanvasUntil] = useState("");
  const [callInfo, setCallInfo] = useState<{ call_id: number; video: boolean; from_name: string } | null>(null);
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  const callMenuTimer = useRef<number | null>(null);
  // Меню не закрывается сразу при уходе курсора: даём время дойти до пункта
  function openCallMenu() {
    if (callMenuTimer.current) window.clearTimeout(callMenuTimer.current);
    callMenuTimer.current = null;
    setCallMenuOpen(true);
  }
  function closeCallMenuLater() {
    if (callMenuTimer.current) window.clearTimeout(callMenuTimer.current);
    callMenuTimer.current = window.setTimeout(() => setCallMenuOpen(false), 400);
  }
  const [inCall, setInCall] = useState<{ callId: number; video: boolean } | null>(null);

  // Вход в звонок из баннера списка чатов
  useEffect(() => {
    if (!pendingJoin) return;
    setCallInfo(null);
    setInCall((cur) => cur ?? { callId: pendingJoin.call_id, video: pendingJoin.video });
    onPendingJoinDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoin]);

  async function startCall(video: boolean) {
    if (inCall) return;
    const { status, data } = await request(`/api/chats/${chat.id}/calls`, "POST", { video });
    if (status === 201) {
      setCallInfo(null);
      setInCall({ callId: data.call_id, video: !!data.video });
    } else setErr(data.error ?? "Не удалось начать звонок");
  }
  const [openCanvasId, setOpenCanvasId] = useState<number | null>(null);
  const [canvasEvent, setCanvasEvent] = useState<CanvasEvent | null>(null);

  // Создание холста: сообщение-холст ответом на выбранное сообщение
  // Отправка холста: PNG уходит в чат как картинка, текст из поля ввода не трогаем
  async function sendCanvasPng(blob: Blob, canvasId: number | null): Promise<number | null> {
    const file = new File([blob], "холст.png", { type: "image/png" });
    const up = await uploadAttachment(file);
    if (!up.ok || !up.id) return null;
    const { status, data } = await request(`/api/chats/${chat.id}/messages`, "POST", {
      body: "",
      attachment_id: up.id,
      attachment_name: file.name,
      attachment_kind: "image",
      reply_to_id: null,
      canvas_id: canvasId,
    });
    if ((status !== 201 && status !== 200) || !data?.message) return null;
    merge([data.message]);
    return data.message.id as number;
  }

  async function createCanvas(mode: "personal" | "shared") {
    const extra = mode === "shared" ? { editors: canvasEditors, edit_until: canvasUntil ? new Date(canvasUntil).toISOString() : null } : {};
    const { status, data } = await request(`/api/chats/${chat.id}/canvases`, "POST", { mode, ...extra });
    // Новый API отдаёт canvas.id; старый отдавал сообщение с canvas_id
    const canvasId = (data?.canvas?.id ?? data?.message?.canvas_id) as number | undefined;
    if (status === 201 && canvasId) {
      setCanvasPicking(false);
      setCanvasStep("type");
      setOpenCanvasId(canvasId);
    } else setErr(data?.error ?? "Не удалось создать холст");
  }

  useEffect(() => {
    const q = searchQ.trim();
    if (!searchOpen || !q) {
      setSearchHits([]);
      return;
    }
    const t = window.setTimeout(async () => {
      const { status, data } = await request(`/api/chats/${chat.id}/search?q=${encodeURIComponent(q)}`);
      if (status === 200) setSearchHits(data.items);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchQ, searchOpen, chat.id]);
  const [pinned, setPinned] = useState<PinnedMsg | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [forwarding, setForwarding] = useState<number[] | null>(null);
  const [chatList, setChatList] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [videoNoteOpen, setVideoNoteOpen] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recCancelRef = useRef(false);
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
    // Расшифровка голосового пришла с сервера: обновляем сообщение на месте
    const onTranscript = (m: Ably.Message) => {
      const d = parseEvent<{ id: number; transcript: string }>(m.data);
      setMessages((prev) => prev.map((x) => (x.id === d.id ? { ...x, transcript: d.transcript } : x)));
    };
    const onCanvas = (m: Ably.Message) => setCanvasEvent(parseEvent<CanvasEvent>(m.data));
    channel.subscribe("message", onMessage);
    channel.subscribe("transcript", onTranscript);
    channel.subscribe("canvas", onCanvas);
    const onCall = (m: Ably.Message) => {
      const d = parseEvent<{ kind: string; call_id: number; video?: boolean; from_name?: string }>(m.data);
      if (d.kind === "start") setCallInfo({ call_id: d.call_id, video: !!d.video, from_name: d.from_name ?? "" });
      else if (d.kind === "end") setCallInfo((cur) => (cur && cur.call_id === d.call_id ? null : cur));
    };
    channel.subscribe("call", onCall);
    channel.subscribe("edit", onEdit);
    channel.subscribe("delete", onDelete);
    channel.subscribe("react", onRefresh);
    channel.subscribe("pin", onRefresh);
    return () => {
      channel.unsubscribe("message", onMessage);
      channel.unsubscribe("transcript", onTranscript);
      channel.unsubscribe("canvas", onCanvas);
      channel.unsubscribe("call", onCall);
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

  // Таймер записи
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [recording]);

  // Лимит длительности: по достижении запись отправляется сама
  useEffect(() => {
    if (recording && recSeconds >= MAX_VOICE_SECONDS) finishRecording(true);
  }, [recording, recSeconds]);

  // Уход из чата во время записи: микрофон отпускаем, запись не отправляем
  useEffect(() => {
    return () => {
      recCancelRef.current = true;
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    };
  }, []);

  // Живая шкала громкости: видно, что микрофон действительно пишет звук
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      const analyser = analyserRef.current;
      if (!analyser) return;
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      setLevels((prev) => [...prev.slice(-29), Math.min(1, rms * 4)]);
    }, 100);
    return () => window.clearInterval(id);
  }, [recording]);

  async function startRecording() {
    if (busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErr("Голосовые сообщения не поддерживаются в этом браузере");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickAudioMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      recCancelRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void audioCtxRef.current?.close();
        audioCtxRef.current = null;
        analyserRef.current = null;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mime || "audio/webm" });
        chunksRef.current = [];
        if (!recCancelRef.current && blob.size > 0) sendVoice(blob);
      };
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      void ctx.resume().catch(() => undefined);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      setLevels([]);
      recorderRef.current = rec;
      setRecSeconds(0);
      setErr("");
      rec.start();
      setRecording(true);
    } catch {
      setErr("Нет доступа к микрофону. Разрешите его в настройках браузера.");
    }
  }

  function finishRecording(send: boolean) {
    const rec = recorderRef.current;
    recorderRef.current = null;
    recCancelRef.current = !send;
    setRecording(false);
    if (rec && rec.state !== "inactive") rec.stop();
  }

  async function sendVideoNote(file: File) {
    setVideoNoteOpen(false);
    setBusy(true);
    setErr("");
    try {
      const up = await uploadAttachment(file);
      if (!up.ok || !up.id) {
        setErr(up.error ?? "Не удалось отправить видеокружок");
        return;
      }
      const { status, data } = await request(`/api/chats/${chat.id}/messages`, "POST", {
        body: "",
        attachment_id: up.id,
        attachment_name: file.name,
        attachment_kind: "video_note",
        reply_to_id: replyTo?.id ?? null,
      });
      if (status === 201) {
        merge([data.message]);
        setReplyTo(null);
      } else setErr(data.error ?? "Не удалось отправить");
    } catch {
      setErr("Нет связи с сервером");
    } finally {
      setBusy(false);
    }
  }

  async function sendVoice(blob: Blob) {
    setBusy(true);
    setErr("");
    try {
      const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      const file = new File([blob], `Голосовое ${new Date().toLocaleString("ru-RU").replace(/[:\s,]+/g, "-")}.${ext}`, { type: blob.type });
      const up = await uploadAttachment(file);
      if (!up.ok || !up.id) {
        setErr(up.error ?? "Не удалось отправить голосовое");
        return;
      }
      const { status, data } = await request(`/api/chats/${chat.id}/messages`, "POST", {
        body: "",
        attachment_id: up.id,
        attachment_name: file.name,
        attachment_kind: "audio",
        reply_to_id: replyTo?.id ?? null,
      });
      if (status === 201) {
        merge([data.message]);
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
        attachment_kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file",
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

  // Переход к сообщению: прокрутка и подсветка на 2 секунды
  function scrollToMessage(id: number) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 2000);
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
        <div
          style={{ position: "relative", display: "flex" }}
          onMouseEnter={openCallMenu}
          onMouseLeave={closeCallMenuLater}
        >
          <button
            type="button"
            onClick={() => setCallMenuOpen((v) => !v)}
            aria-label="Звонок"
            aria-haspopup="menu"
            aria-expanded={callMenuOpen}
            title="Звонок"
            style={{ ...linkStyle, color: "#f5f5f5", display: "flex", alignItems: "center" }}
          >
            <PhoneIcon />
          </button>
          {callMenuOpen && (
            <div
              role="menu"
              style={{ position: "absolute", top: "100%", right: 0, paddingTop: 6, zIndex: 40, background: "#2b2b2b", borderRadius: 10, padding: "6px 0", minWidth: 190, boxShadow: "0 6px 18px rgba(0,0,0,0.45)" }}
            >
              {[
                { label: "Аудиозвонок", video: false, icon: <PhoneIcon /> },
                { label: "Видеозвонок", video: true, icon: <VideoIcon /> },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCallMenuOpen(false);
                    void startCall(item.video);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 16px", border: "none", background: "transparent", color: "#f5f5f5", cursor: "pointer", textAlign: "left", fontSize: 15 }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setSearchOpen((v) => !v)} aria-label="Поиск по сообщениям" title="Поиск" style={{ ...linkStyle, color: "#f5f5f5" }}>
          <SearchIcon />
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

      {searchOpen && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input autoFocus value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Поиск по сообщениям" style={{ ...input, marginBottom: 0 }} />
            <button
              onClick={() => {
                setSearchOpen(false);
                setSearchQ("");
              }}
              style={inlineButton}
            >
              Закрыть
            </button>
          </div>
          {searchQ.trim() && (
            <div style={{ maxHeight: 180, overflowY: "auto", marginTop: 6 }}>
              {searchHits.length === 0 && <div style={{ color: colors.gray, fontSize: 13 }}>Ничего не найдено</div>}
              {searchHits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => scrollToMessage(h.id)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", color: "#f5f5f5", padding: "6px 4px", cursor: "pointer", borderBottom: `1px solid ${colors.field}` }}
                >
                  <div style={{ fontSize: 12, color: colors.blue }}>{h.author_name} · {timeText(h.created_at)}</div>
                  <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.body}</div>
                </button>
              ))}
            </div>
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
              style={{ alignSelf: own ? "flex-end" : "flex-start", maxWidth: "80%", display: "flex", alignItems: "flex-end", gap: 6 }}
            >
              {!own && <ChatAvatar photoId={m.author_photo_id ?? null} title={m.author_name} size={30} />}
              <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
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
                  background: flashId === m.id ? "#ffd65c" : isSelected ? "#cfe3ff" : m.attachment_kind === "video_note" ? "transparent" : own ? colors.yellow : colors.field,
                  transition: "background 0.4s",
                  color: colors.navy,
                  borderRadius: 12,
                  padding: "6px 10px",
                  cursor: selectMode && !m.deleted ? "pointer" : undefined,
                  outline: isSelected ? `3px solid ${colors.blue}` : undefined,
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
                    {m.canvas_id && m.canvas_mode === "shared" && (
                      <CanvasEditChip until={m.canvas_until ?? null} onEdit={() => setOpenCanvasId(m.canvas_id ?? null)} />
                    )}
                    {m.attachment_id && m.attachment_kind === "audio" && <VoiceMessage msg={m} />}
                    {m.attachment_id && m.attachment_kind === "video_note" && <VideoNoteMessage msg={m} />}
                    {m.attachment_id && m.attachment_kind === "video" && <AttachmentVideo id={m.attachment_id} name={m.attachment_name ?? "видео"} />}
                    {m.attachment_id && m.attachment_kind !== "image" && m.attachment_kind !== "audio" && m.attachment_kind !== "video" && m.attachment_kind !== "video_note" && (
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
                    {m.body && (
                      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        <MentionText text={m.body} onMention={setProfileName} />
                      </div>
                    )}
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
                    background: "#F2D98A",
                    borderRadius: 11,
                    padding: 1,
                    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                    zIndex: 5,
                  }}
                >
                  <button type="button" onClick={() => setReplyTo(m)} aria-label="Ответить" style={hoverButton}>
                    <ReplyIcon />
                  </button>
                  <span style={{ width: 1, height: 12, background: "rgba(2,35,66,0.25)" }} />
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
      {profileName && <ProfileModal username={profileName} onClose={() => setProfileName(null)} />}
      {inCall && (
        <CallOverlay callId={inCall.callId} chatTitle={chat.title} video={inCall.video} ably={ably} me={viewer.id} onExit={() => setInCall(null)} />
      )}
      {videoNoteOpen && (
        <VideoNoteRecorder onRecorded={(file) => void sendVideoNote(file)} onClose={() => setVideoNoteOpen(false)} />
      )}
      {canvasPicking && (
        <Modal onClose={() => { setCanvasPicking(false); setCanvasStep("type"); }}>
          {(
            <>
              <div style={{ fontSize: 18, fontWeight: "bold", color: "#f5f5f5" }}>Настройки общего холста</div>
              <div style={{ color: colors.gray, fontSize: 13, marginTop: 12 }}>Кто может редактировать</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                {([
                  ["all", "Все участники чата"],
                  ["managers", "Только администраторы (группа) или комсостав"],
                  ["author", "Только я (автор)"],
                ] as const).map(([value, label]) => (
                  <label key={value} style={{ display: "flex", gap: 8, alignItems: "center", color: "#f5f5f5", cursor: "pointer" }}>
                    <input type="radio" name="canvas-editors" checked={canvasEditors === value} onChange={() => setCanvasEditors(value)} />
                    {label}
                  </label>
                ))}
              </div>
              <div style={{ color: colors.gray, fontSize: 13, marginTop: 14 }}>Редактировать до (необязательно, по вашему времени)</div>
              <input type="datetime-local" value={canvasUntil} onChange={(e) => setCanvasUntil(e.target.value)} style={{ ...input, marginTop: 6 }} />
              {canvasUntil && (
                <button type="button" onClick={() => setCanvasUntil("")} style={{ ...inlineButton, marginTop: 6 }}>Без срока</button>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
                <button onClick={() => { setCanvasPicking(false); setCanvasStep("type"); }} style={inlineButton}>Отмена</button>
                <button onClick={() => void createCanvas("shared")} style={button}>Создать холст</button>
              </div>
            </>
          )}
        </Modal>
      )}
      {openCanvasId && (
        <CanvasModal
          canvasId={openCanvasId}
          event={canvasEvent}
          onClose={() => setOpenCanvasId(null)}
          onSend={async (png, canvasId) => {
            const id = await sendCanvasPng(png, canvasId);
            if (!id) return false;
            setOpenCanvasId(null);
            window.setTimeout(() => scrollToMessage(id), 50);
            return true;
          }}
        />
      )}

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
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#17212b", borderRadius: 10, padding: "8px 12px", marginTop: 6 }}>
              <div style={{ flex: 1, minWidth: 0, borderLeft: `3px solid ${colors.blue}`, paddingLeft: 8 }}>
                <div style={{ fontSize: 13, fontWeight: "bold", color: colors.blue }}>{replyTo.author_name}</div>
                <div style={{ fontSize: 13, color: "#f5f5f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {replyTo.body || "Вложение"}
                </div>
              </div>
              <button onClick={() => setReplyTo(null)} aria-label="Отменить ответ" style={{ ...linkStyle, color: "#f5f5f5" }}>✕</button>
            </div>
          )}
          {callInfo && !inCall && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: colors.yellow, color: colors.navy, borderRadius: 10, padding: "8px 12px", marginTop: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>📞 {callInfo.from_name} {callInfo.video ? "начал видеозвонок" : "начал звонок"}</span>
              <button
                type="button"
                onClick={() => {
                  setInCall({ callId: callInfo.call_id, video: callInfo.video });
                  setCallInfo(null);
                }}
                style={{ ...inlineButton, padding: "4px 10px" }}
              >
                Присоединиться
              </button>
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
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Прикрепить файл" hidden={recording} style={composerIconButton}>
              <ClipIcon />
            </button>
            <textarea
              hidden={recording}
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
              hidden={recording}
              onClick={() => {
                setCanvasStep("settings");
                setCanvasPicking(true);
              }}
              aria-label="Холст"
              title="Холст"
              style={composerIconButton}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                <path d="M2 2l7.586 7.586" />
                <circle cx="11" cy="11" r="2" />
              </svg>
            </button>
            <button
              type="button"
              data-emoji-toggle
              hidden={recording}
              onClick={() => setPickerOpen((open) => !open)}
              aria-label="Смайлики"
              style={{ ...composerIconButton, color: pickerOpen ? colors.yellow : composerIconButton.color }}
            >
              <SmileIcon />
            </button>
            {recording ? (
              <>
                <button type="button" onClick={() => finishRecording(false)} aria-label="Отменить запись" style={{ ...composerIconButton, fontSize: 18 }}>
                  ✕
                </button>
                <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 2, height: 28, overflow: "hidden" }}>
                    {Array.from({ length: 30 }, (_, i) => {
                      const v = levels[levels.length - 30 + i] ?? 0.08;
                      return <span key={i} style={{ flex: 1, height: `${Math.max(8, Math.round(v * 100))}%`, minHeight: 3, borderRadius: 2, background: colors.blue }} />;
                    })}
                  </div>
                  <span style={{ fontSize: 15, color: colors.white, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatDuration(recSeconds)}</span>
                </div>
                <button type="button" onClick={() => finishRecording(true)} aria-label="Отправить голосовое" style={composerIconButton}>
                  <SendIcon />
                </button>
              </>
            ) : text.trim() ? (
              <button type="submit" disabled={busy} aria-label="Отправить" style={composerIconButton}>
                <SendIcon />
              </button>
            ) : (
              <>
                <button type="button" onClick={() => setVideoNoteOpen(true)} disabled={busy} aria-label="Видеокружок" style={composerIconButton}>
                  <CameraIcon />
                </button>
                <button type="button" onClick={startRecording} disabled={busy} aria-label="Голосовое сообщение" style={composerIconButton}>
                  <MicIcon />
                </button>
              </>
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
  padding: "4px 6px",
  cursor: "pointer",
  color: colors.navy,
  display: "flex",
  alignItems: "center",
};

function ReplyIcon() {
  return (
    <svg {...iconProps} width={12} height={12}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 6 6v3" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
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

function EmojiPicker({ pickerRef, onPick }: { pickerRef: RefObject<HTMLDivElement>; onPick: (emoji: string) => void }) {
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
        boxSizing: "border-box",
        display: "grid",
        // minmax(0, 1fr): столбцы сжимаются вместе с панелью и не выходят за её край
        gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
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
          style={{ background: "none", border: "none", width: "100%", boxSizing: "border-box", fontSize: 20, padding: 2, cursor: "pointer", borderRadius: 8, lineHeight: 1 }}
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

function PhoneIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="14" height="10" rx="2" />
      <path d="M16 10l6-3v10l-6-3" />
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

// Прикреплённое видеофайл: обычный плеер, не кружок
function AttachmentVideo({ id, name }: { id: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    loadAttachmentUrl(id).then(setSrc);
  }, [id]);
  if (!src) return <div style={{ fontSize: 13, color: colors.gray }}>Загрузка видео…</div>;
  return <video src={src} controls playsInline preload="metadata" aria-label={name} style={{ display: "block", maxWidth: 300, width: "100%", borderRadius: 8, marginBottom: 4 }} />;
}

function AttachmentImage({ id, name }: { id: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // Адрес из общего кеша не отзываем (см. api.ts), иначе после переключения раздела картинка пропадёт
    loadAttachmentUrl(id).then(setSrc);
  }, [id]);
  if (!src) return <div style={{ fontSize: 13, color: colors.gray }}>Загрузка фото…</div>;
  return <img src={src} alt={name} style={{ display: "block", maxWidth: 260, maxHeight: 260, borderRadius: 8, marginBottom: 4 }} />;
}

// Поиск в шапке чата
function SearchIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

interface SearchHit {
  id: number;
  body: string;
  author_name: string;
  created_at: string;
}

type MediaTab = "members" | "image" | "video" | "file" | "link";

interface MediaItem {
  id: number;
  attachment_id?: string | null;
  attachment_name?: string | null;
  url?: string;
  author_name: string;
  created_at: string;
}

const TAB_LABELS: [MediaTab, string][] = [
  ["members", "Участники"],
  ["image", "Фотографии"],
  ["video", "Видео"],
  ["file", "Файлы"],
  ["link", "Ссылки"],
];

// Видеокружок: сначала превью, по нажатию загружается и играет; пауза по второму нажатию
function VideoCircle({ id, name, size = 200 }: { id: string; name: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(true);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ringRef = useRef<SVGSVGElement>(null);
  const seekingRef = useRef(false);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (started && src) void videoRef.current?.play().catch(() => undefined);
  }, [started, src]);

  // Перемотка: положение указателя по кругу задаёт долю видео (0 — вверху, по часовой)
  function seekAt(clientX: number, clientY: number) {
    const svg = ringRef.current;
    const v = videoRef.current;
    if (!svg || !v || !v.duration) return;
    const rect = svg.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    let theta = Math.atan2(dx, -dy);
    if (theta < 0) theta += 2 * Math.PI;
    const f = theta / (2 * Math.PI);
    v.currentTime = f * v.duration;
    setProgress(f);
  }

  async function onClick(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!started) {
      setStarted(true);
      if (!src) setSrc(await loadAttachmentUrl(id));
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }

  return (
    <div
      role="button"
      aria-label={`Видеокружок ${name}`}
      onClick={onClick}
      style={{ position: "relative", width: size, height: size, borderRadius: "50%", overflow: "hidden", background: "#0b1420", cursor: "pointer", margin: "4px 0", flexShrink: 0 }}
    >
      {src && (
        <video
          ref={videoRef}
          src={src}
          playsInline
          preload="metadata"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setProgress(v.duration ? v.currentTime / v.duration : 0);
          }}
          onEnded={() => {
            setPaused(true);
            setStarted(false);
            setProgress(0);
          }}
        />
      )}
      {paused && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: size / 5, pointerEvents: "none" }}>
          ▶
        </div>
      )}
      <svg
        ref={ringRef}
        viewBox="0 0 100 100"
        aria-hidden="true"
        onPointerDown={(e) => {
          if (!started || !src) return;
          e.stopPropagation();
          e.preventDefault();
          // Простое нажатие — обычный клик (пауза/продолжение); протягивание — перемотка
          seekingRef.current = true;
          movedRef.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!seekingRef.current) return;
          movedRef.current = true;
          seekAt(e.clientX, e.clientY);
        }}
        onPointerUp={() => {
          if (seekingRef.current && movedRef.current) suppressClickRef.current = true;
          seekingRef.current = false;
          movedRef.current = false;
        }}
        onPointerCancel={() => {
          seekingRef.current = false;
          movedRef.current = false;
        }}
        style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)", cursor: started ? "pointer" : "default", touchAction: "none" }}
        width="100%"
        height="100%"
      >
        {/* широкая невидимая полоса — чтобы попадать по обводке пальцем */}
        <circle cx="50" cy="50" r="48" fill="none" stroke="transparent" strokeWidth="12" />
        <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" style={{ pointerEvents: "none" }} />
        <circle cx="50" cy="50" r="48" fill="none" stroke={colors.blue} strokeWidth="3" strokeDasharray={`${progress * 301.6} 301.6`} style={{ pointerEvents: "none" }} />
      </svg>
    </div>
  );
}

// Текст сообщения с подсветкой @упоминаний: @all — всем, @имя — открывает профиль
function MentionText({ text, onMention }: { text: string; onMention: (name: string) => void }) {
  const parts: ReactNode[] = [];
  const re = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_]{3,32})/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    const name = m[2];
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      name.toLowerCase() === "all" ? (
        <b key={`m${start}`} style={{ color: colors.blue }}>@all</b>
      ) : (
        <button
          key={`m${start}`}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMention(name);
          }}
          style={{ background: "none", border: "none", padding: 0, color: colors.blue, fontWeight: "bold", cursor: "pointer", font: "inherit" }}
        >
          @{name}
        </button>
      ),
    );
    last = start + name.length + 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// Профиль участника, открытый по @юзернейму
function ProfileModal({ username, onClose }: { username: string; onClose: () => void }) {
  const [profile, setProfile] = useState<Record<string, string | null> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    request(`/api/profiles/by-username/${encodeURIComponent(username)}`).then(({ status, data }) => {
      if (status === 200) setProfile(data.profile);
      else setErr(data.error ?? "Не удалось открыть профиль");
    });
  }, [username]);
  return (
    <Modal onClose={onClose}>
      {err && <div style={{ color: "#ff8a8a" }}>{err}</div>}
      {profile && (
        <div style={{ textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ChatAvatar photoId={profile.photo_id ?? null} title={profile.full_name ?? username} size={96} />
          </div>
          <div style={{ fontSize: 20, fontWeight: "bold", marginTop: 10, color: "#f5f5f5" }}>{profile.full_name}</div>
          <div style={{ color: colors.gray }}>@{username}</div>
          {profile.position && <div style={{ color: "#f5f5f5", marginTop: 8 }}>{profile.position}</div>}
        </div>
      )}
    </Modal>
  );
}

// Миниатюра фото для вкладки «Фотографии»
function ThumbImage({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    loadAttachmentUrl(id).then(setSrc);
  }, [id]);
  return (
    <div style={{ aspectRatio: "1", background: colors.field, borderRadius: 6, overflow: "hidden" }}>
      {src && <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
    </div>
  );
}

// Содержимое вкладок медиа в панели чата
function MediaList({ tab, items }: { tab: Exclude<MediaTab, "members">; items: MediaItem[] }) {
  if (items.length === 0) return <p style={{ color: colors.gray, marginTop: 12 }}>Пока пусто.</p>;
  if (tab === "image")
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginTop: 12 }}>
        {items.map((it) => (
          <ThumbImage key={it.id} id={it.attachment_id ?? ""} />
        ))}
      </div>
    );
  if (tab === "video")
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 12, justifyItems: "center" }}>
        {items.map((it) => (
          <VideoCircle key={it.id} id={it.attachment_id ?? ""} name={it.attachment_name ?? "видео"} size={140} />
        ))}
      </div>
    );
  if (tab === "file")
    return (
      <div style={{ marginTop: 12, textAlign: "left" }}>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => void downloadAttachment(it.attachment_id ?? "", it.attachment_name ?? "file")}
            style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", color: colors.blue, padding: "8px 0", cursor: "pointer", borderBottom: `1px solid ${colors.field}` }}
          >
            📎 {it.attachment_name ?? "Файл"}
            <div style={{ color: colors.gray, fontSize: 12 }}>{it.author_name} · {shortDate(it.created_at)}</div>
          </button>
        ))}
      </div>
    );
  return (
    <div style={{ marginTop: 12, textAlign: "left" }}>
      {items.map((it, i) => (
        <a key={`${it.id}-${i}`} href={it.url} target="_blank" rel="noreferrer" style={{ display: "block", color: colors.blue, padding: "8px 0", wordBreak: "break-all", borderBottom: `1px solid ${colors.field}` }}>
          {it.url}
          <div style={{ color: colors.gray, fontSize: 12 }}>{it.author_name} · {shortDate(it.created_at)}</div>
        </a>
      ))}
    </div>
  );
}

// Голосовое с кнопкой «Aa» слева: по нажатию раскрывается расшифровка
// Видеокружок с расшифровкой: кнопка «Aa» слева, текст появляется под кружком
function VideoNoteMessage({ msg }: { msg: Msg }) {
  const [open, setOpen] = useState(false);
  const pending = msg.transcript === undefined || msg.transcript === null;
  const fresh = Date.now() - utcDate(msg.created_at).getTime() < 120000;
  let text: string;
  if (!pending) text = msg.transcript ? msg.transcript : "Не удалось расшифровать";
  else text = fresh ? "Расшифровываем…" : "Расшифровки нет";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-label="Показать расшифровку"
          title="Расшифровка"
          style={{ background: "#17212b", color: colors.blue, border: "none", borderRadius: 8, padding: "4px 8px", fontWeight: "bold", fontSize: 13, cursor: "pointer", flexShrink: 0, marginTop: 8 }}
        >
          Aa
        </button>
        <VideoCircle id={msg.attachment_id ?? ""} name={msg.attachment_name ?? "видеокружок"} />
      </div>
      {open && (
        <div style={{ marginTop: 6, fontSize: 14, color: colors.navy, background: colors.blue, borderRadius: 8, padding: "6px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
        </div>
      )}
    </div>
  );
}

function VoiceMessage({ msg }: { msg: Msg }) {
  const [open, setOpen] = useState(false);
  const pending = msg.transcript === undefined || msg.transcript === null;
  // Старые голосовые без расшифровки не ждём вечно: через 2 минуты после отправки пишем «нет текста»
  const fresh = Date.now() - utcDate(msg.created_at).getTime() < 120000;
  let text: string;
  if (!pending) text = msg.transcript ? msg.transcript : "Не удалось расшифровать";
  else text = fresh ? "Расшифровываем…" : "Расшифровки нет";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-label="Показать расшифровку"
          title="Расшифровка"
          style={{ background: "#17212b", color: colors.blue, border: "none", borderRadius: 8, padding: "4px 8px", fontWeight: "bold", fontSize: 13, cursor: "pointer", flexShrink: 0 }}
        >
          Aa
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <AudioMessage id={msg.attachment_id ?? ""} />
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 6, fontSize: 14, color: colors.navy, background: colors.blue, borderRadius: 8, padding: "6px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
        </div>
      )}
    </div>
  );
}

// ---------- Звонки: WebRTC, сигнализация через Ably (канал call:<id>) ----------
interface CallPeerInfo {
  name: string;
  photo: string | null;
}

interface CallSignalMsg {
  from: number;
  to: number;
  data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; screen?: boolean };
}

interface CallMemberMsg {
  kind: "join" | "leave";
  user_id: number;
  full_name?: string;
  photo_id?: string | null;
}

// mode: grid — обычная плитка 4:3; main — демонстрация экрана на всё поле (без обрезки); strip — маленькая плитка внизу
function CallTile({ stream, name, photo, mine, mode = "grid" }: { stream: MediaStream | null; name: string; photo: string | null; mine?: boolean; mode?: "grid" | "main" | "strip" }) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = !!stream && stream.getVideoTracks().length > 0;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  return (
    <div
      style={
        mode === "main"
          ? { position: "relative", background: "#000", borderRadius: 12, overflow: "hidden", flex: 1, minHeight: 0, width: "100%", height: "100%" }
          : mode === "strip"
            ? { position: "relative", background: "#17212b", borderRadius: 12, overflow: "hidden", width: 200, height: 150, flexShrink: 0 }
            : { position: "relative", background: "#17212b", borderRadius: 12, overflow: "hidden", height: "100%", minHeight: 160 }
      }
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={!!mine}
        style={{
          width: "100%",
          height: "100%",
          // Видео (камера и экран) показываем целиком, без обрезки; пустые поля заполняет фон плитки
          objectFit: "contain",
          display: hasVideo ? "block" : "none",
          transform: mine && mode !== "main" ? "scaleX(-1)" : undefined,
        }}
      />
      {!hasVideo && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ChatAvatar photoId={photo} title={name} size={72} />
        </div>
      )}
      <div style={{ position: "absolute", left: 8, bottom: 8, background: "rgba(0,0,0,0.5)", color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 13 }}>{name}</div>
    </div>
  );
}

function CallOverlay({ callId, chatTitle, video, ably, me, onExit }: { callId: number; chatTitle: string; video: boolean; ably: Ably.Realtime | null; me: number; onExit: () => void }) {
  const [names, setNames] = useState<Record<number, CallPeerInfo>>({});
  const [streams, setStreams] = useState<Record<number, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(video);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState("Подключение…");
  const [err, setErr] = useState("");
  const [turnOn, setTurnOn] = useState(true);
  const turnRef = useRef(true);
  // Кто из собеседников сейчас показывает экран (приходит сигналом, не по настройкам трека)
  const [screenPeers, setScreenPeers] = useState<Record<number, boolean>>({});
  // Демонстрация экрана есть не везде (на большинстве телефонов её нет)
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function";

  const pcs = useRef(new Map<number, RTCPeerConnection>());
  const pendingIce = useRef(new Map<number, RTCIceCandidateInit[]>());
  const iceRef = useRef<RTCIceServer[]>([{ urls: "stun:stun.l.google.com:19302" }]);
  const tracks = useRef<{ audio: MediaStreamTrack | null; camera: MediaStreamTrack | null; screen: MediaStreamTrack | null }>({ audio: null, camera: null, screen: null });
  const remote = useRef(new Map<number, MediaStream>());
  const leftRef = useRef(false);

  function currentVideo(): MediaStreamTrack | null {
    return tracks.current.screen ?? tracks.current.camera;
  }

  function refreshLocal() {
    const list = [tracks.current.audio, currentVideo()].filter((t): t is MediaStreamTrack => !!t);
    setLocalStream(new MediaStream(list));
  }

  // Новая картинка (камера или экран) уходит всем участникам без переподключения
  function sendVideoToAll() {
    const t = currentVideo();
    for (const pc of pcs.current.values()) {
      const vt = pc.getTransceivers().find((x) => x.receiver.track.kind === "video");
      void vt?.sender.replaceTrack(t).catch(() => undefined);
    }
  }

  function signal(to: number, data: object) {
    void request(`/api/calls/${callId}/signal`, "POST", { to, data });
  }

  // Сообщаем всем участникам, что мы начали или закончили показ экрана
  function announceScreen(on: boolean) {
    for (const id of pcs.current.keys()) signal(id, { screen: on });
  }

  function ensurePc(peerId: number): RTCPeerConnection {
    const old = pcs.current.get(peerId);
    if (old) return old;
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    pc.addTransceiver("audio", { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "sendrecv" });
    for (const x of pc.getTransceivers()) {
      const isAudio = x.receiver.track.kind === "audio";
      void x.sender.replaceTrack(isAudio ? tracks.current.audio : currentVideo()).catch(() => undefined);
    }
    pc.ontrack = (e) => {
      let st = remote.current.get(peerId);
      if (!st) {
        st = new MediaStream();
        remote.current.set(peerId, st);
      }
      if (!st.getTracks().includes(e.track)) st.addTrack(e.track);
      setStreams(Object.fromEntries(remote.current));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) signal(peerId, { candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        setErr(
          turnRef.current
            ? "Связь с участником прервалась. Выйдите из звонка и зайдите снова."
            : "Связь с участником прервалась. Без TURN-сервера такое часто случается за NAT и в мобильной сети.",
        );
      }
    };
    pcs.current.set(peerId, pc);
    return pc;
  }

  function dropPeer(peerId: number) {
    pcs.current.get(peerId)?.close();
    pcs.current.delete(peerId);
    pendingIce.current.delete(peerId);
    remote.current.delete(peerId);
    setStreams(Object.fromEntries(remote.current));
    setNames((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }

  // Новичок отправляет предложение всем, кто уже в звонке; ответ отдают уже находящиеся
  async function offerTo(peerId: number) {
    const pc = ensurePc(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const d = pc.localDescription;
    if (d) signal(peerId, { sdp: { type: d.type, sdp: d.sdp } });
  }

  async function onSignal(from: number, data: CallSignalMsg["data"]) {
    if (data.screen !== undefined) {
      setScreenPeers((prev) => ({ ...prev, [from]: !!data.screen }));
      return;
    }
    if (data.sdp) {
      const pc = ensurePc(from);
      await pc.setRemoteDescription(data.sdp);
      for (const c of pendingIce.current.get(from) ?? []) await pc.addIceCandidate(c).catch(() => undefined);
      pendingIce.current.delete(from);
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const d = pc.localDescription;
        if (d) signal(from, { sdp: { type: d.type, sdp: d.sdp } });
      }
    } else if (data.candidate) {
      const pc = pcs.current.get(from);
      if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => undefined);
      else pendingIce.current.set(from, [...(pendingIce.current.get(from) ?? []), data.candidate]);
    }
  }

  // Сердцебиение: без него сервер через минуту сочтёт участника вышедшим (например, после закрытия вкладки)
  useEffect(() => {
    const id = window.setInterval(() => {
      void request(`/api/calls/${callId}/ping`, "POST").catch(() => undefined);
    }, 20000);
    return () => window.clearInterval(id);
  }, [callId]);

  function leaveOnce() {
    if (leftRef.current) return;
    leftRef.current = true;
    void request(`/api/calls/${callId}/leave`, "POST").catch(() => undefined);
  }

  useEffect(() => {
    if (!ably) {
      setErr("Чат ещё подключается, попробуйте через секунду");
      return;
    }
    let alive = true;
    const onSig = (m: Ably.Message) => {
      const d = parseEvent<CallSignalMsg>(m.data);
      if (d.to === me) void onSignal(d.from, d.data);
    };
    const onMember = (m: Ably.Message) => {
      const d = parseEvent<CallMemberMsg>(m.data);
      if (d.user_id === me) return;
      if (d.kind === "join") {
        setNames((prev) => ({ ...prev, [d.user_id]: { name: d.full_name ?? "", photo: d.photo_id ?? null } }));
        if (tracks.current.screen) signal(d.user_id, { screen: true });
      }
      else dropPeer(d.user_id);
    };
    const ch = ably.channels.get(`call:${callId}`);

    (async () => {
      try {
        // Токен обновляем, чтобы он уже включал канал этого звонка
        await ably.auth.authorize();
        if (!alive) return;
        ch.subscribe("signal", onSig);
        ch.subscribe("member", onMember);

        const ice = await request("/api/calls/ice");
        if (ice.status === 200 && Array.isArray(ice.data.iceServers)) {
          iceRef.current = ice.data.iceServers;
          turnRef.current = ice.data.turn === true;
          setTurnOn(turnRef.current);
        } else {
          turnRef.current = false;
          setTurnOn(false);
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 640, height: 480, facingMode: "user" } : false });
        } catch {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            setErr("Камера недоступна, звонок только с микрофоном");
          } catch {
            throw new Error("Нет доступа к микрофону. Разрешите его в настройках браузера.");
          }
        }
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        tracks.current.audio = stream.getAudioTracks()[0] ?? null;
        tracks.current.camera = stream.getVideoTracks()[0] ?? null;
        setCamOn(!!tracks.current.camera);
        refreshLocal();

        const { status: st, data } = await request(`/api/calls/${callId}/join`, "POST");
        if (st !== 200) throw new Error(data.error ?? "Не удалось войти в звонок");
        const roster: { user_id: number; full_name: string; photo_id: string | null }[] = data.participants;
        const info: Record<number, CallPeerInfo> = {};
        for (const p of roster) if (p.user_id !== me) info[p.user_id] = { name: p.full_name, photo: p.photo_id };
        setNames(info);
        setStatus("");
        for (const p of roster) if (p.user_id !== me) await offerTo(p.user_id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Не удалось подключиться");
        setStatus("");
      }
    })();

    return () => {
      alive = false;
      ch.unsubscribe("signal", onSig);
      ch.unsubscribe("member", onMember);
      leaveOnce();
      for (const pc of pcs.current.values()) pc.close();
      pcs.current.clear();
      remote.current.clear();
      tracks.current.audio?.stop();
      tracks.current.camera?.stop();
      tracks.current.screen?.stop();
      tracks.current = { audio: null, camera: null, screen: null };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, ably]);

  function hangUp() {
    leaveOnce();
    onExit();
  }

  function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    if (tracks.current.audio) tracks.current.audio.enabled = next;
  }

  async function toggleCam() {
    if (camOn) {
      tracks.current.camera?.stop();
      tracks.current.camera = null;
      setCamOn(false);
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
        tracks.current.camera = s.getVideoTracks()[0] ?? null;
        setCamOn(true);
      } catch {
        setErr("Нет доступа к камере");
        return;
      }
    }
    sendVideoToAll();
    refreshLocal();
  }

  function stopShare() {
    tracks.current.screen?.stop();
    tracks.current.screen = null;
    setSharing(false);
    announceScreen(false);
    sendVideoToAll();
    refreshLocal();
  }

  async function toggleShare() {
    if (sharing) {
      stopShare();
      return;
    }
    try {
      // Подсказки браузеру: сначала предлагать весь экран (монитор), а не окно или вкладку.
      // Итоговый выбор всё равно за пользователем в окне браузера.
      const options = {
        video: { displaySurface: "monitor" },
        audio: false,
        monitorTypeSurfaces: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      } as unknown as DisplayMediaStreamOptions;
      const s = await navigator.mediaDevices.getDisplayMedia(options);
      const t = s.getVideoTracks()[0];
      if (!t) return;
      t.onended = () => {
        if (tracks.current.screen === t) stopShare();
      };
      tracks.current.screen = t;
      setSharing(true);
      announceScreen(true);
      sendVideoToAll();
      refreshLocal();
    } catch {
      setErr("Демонстрация экрана недоступна или отменена");
    }
  }

  const others = Object.keys(names).map(Number);
  // Если кто-то показывает экран (мы или собеседник), он занимает всё поле
  const mainId: "me" | number | null = sharing ? "me" : others.find((id) => screenPeers[id] && streams[id]) ?? null;
  const btn = (on: boolean): CSSProperties => ({
    width: 52,
    height: 52,
    borderRadius: 26,
    border: "none",
    background: on ? colors.yellow : "#3a4a5c",
    color: colors.navy,
    fontSize: 22,
    cursor: "pointer",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b1420", zIndex: 45, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", color: "#f5f5f5", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <b style={{ fontSize: 17, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📞 {chatTitle}</b>
        <span style={{ fontSize: 13, color: colors.gray }}>{err ? <span style={{ color: "#ff8a8a" }}>{err}</span> : status || `Участников: ${others.length + 1}${turnOn ? "" : " · без TURN связь может не работать в мобильной сети"}`}</span>
      </div>
      {mainId === null ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gridAutoRows: "minmax(160px, 1fr)", gap: 8, padding: 8 }}>
          <CallTile stream={localStream} name="Вы" photo={null} mine />
          {others.map((id) => (
            <CallTile key={id} stream={streams[id] ?? null} name={names[id].name || "Участник"} photo={names[id].photo} />
          ))}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: 8 }}>
          {mainId === "me" ? (
            <CallTile stream={localStream} name="Ваш экран" photo={null} mode="main" />
          ) : (
            <CallTile stream={streams[mainId] ?? null} name={names[mainId].name || "Участник"} photo={names[mainId].photo} mode="main" />
          )}
          <div style={{ display: "flex", gap: 8, overflowX: "auto", flexShrink: 0 }}>
            {mainId !== "me" && <CallTile stream={localStream} name="Вы" photo={null} mine mode="strip" />}
            {others.filter((id) => id !== mainId).map((id) => (
              <CallTile key={id} stream={streams[id] ?? null} name={names[id].name || "Участник"} photo={names[id].photo} mode="strip" />
            ))}
          </div>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, padding: 14 }}>
        <button type="button" onClick={toggleMic} aria-label={micOn ? "Выключить микрофон" : "Включить микрофон"} style={btn(micOn)}>
          {micOn ? "🎤" : "🔇"}
        </button>
        <button type="button" onClick={() => void toggleCam()} aria-label={camOn ? "Выключить камеру" : "Включить камеру"} style={btn(camOn)}>
          {camOn ? "📷" : "🚫"}
        </button>
        <button
          type="button"
          onClick={() => void toggleShare()}
          disabled={!canShare && !sharing}
          aria-label="Демонстрация экрана"
          title={canShare ? "Демонстрация экрана" : "Демонстрация экрана не поддерживается в этом браузере (на телефонах обычно недоступна)"}
          style={{ ...btn(sharing), opacity: canShare || sharing ? 1 : 0.35, cursor: canShare || sharing ? "pointer" : "not-allowed" }}
        >
          🖥
        </button>
        <button type="button" onClick={hangUp} aria-label="Завершить звонок" style={{ ...btn(false), background: "#e53935", color: "#fff" }}>
          ☎
        </button>
      </div>
    </div>
  );
}

interface CanvasStroke {
  id: number;
  author_id: number;
  color: string;
  width: number;
  points: [number, number][];
}

interface CanvasEvent {
  id: number;
  stroke?: CanvasStroke;
  cleared?: boolean;
}

interface HistoryGroup {
  author_id: number;
  author_name: string;
  author_photo_id: string | null;
  started_at: string;
  ended_at: string;
  strokes: { color: string; width: number; points: [number, number][] }[];
}

interface CanvasData {
  id: number;
  mode: string;
  author_id: number;
  can_draw: boolean;
  can_clear: boolean;
  editors?: string;
  edit_until?: string | null;
  strokes: CanvasStroke[];
}

function canvasRulesText(c: CanvasData): string {
  const who = c.mode === "personal" ? "только автор" : c.editors === "author" ? "только автор" : c.editors === "managers" ? "администраторы / комсостав" : "все участники";
  const until = c.edit_until ? ` · до ${new Date(c.edit_until).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "";
  return `Редактировать: ${who}${until}`;
}

const CANVAS_COLORS = ["#000000", "#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa"];
const CANVAS_WIDTHS = [3, 8, 16];
const CANVAS_W = 1000;
const CANVAS_H = 600;
const ERASER_WIDTH = 24;

// Под общим холстом в чате: таймер редактирования и кнопка, которая пропадает по истечении срока
function CanvasEditChip({ until, onEdit }: { until: string | null; onEdit: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  const end = until ? Date.parse(until) : null;
  const left = end === null ? null : end - now;
  const open = left === null || left > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: open ? colors.gray : "#ff8a8a" }}>
        {end === null ? "Без срока" : open ? `Осталось ${fmtLeft(left ?? 0)}` : "Редактирование закрыто"}
      </span>
      {open && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          style={{ ...inlineButton, padding: "3px 10px", fontSize: 12 }}
        >
          Редактировать
        </button>
      )}
    </div>
  );
}

function fmtLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// Холст: белое поле, на котором можно рисовать; штрихи синхронизируются через Ably
function CanvasModal({ canvasId, event, onClose, onSend }: { canvasId: number; event: CanvasEvent | null; onClose: () => void; onSend: (png: Blob, linkCanvasId: number | null) => Promise<boolean> }) {
  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [color, setColor] = useState(CANVAS_COLORS[0]);
  const [width, setWidth] = useState(CANVAS_WIDTHS[1]);
  const [eraser, setEraser] = useState(false);
  const [current, setCurrent] = useState<[number, number][] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryGroup[] | null>(null);

  // История обновляется при открытии и при каждом новом штрихе
  useEffect(() => {
    if (!showHistory) return;
    let cancelled = false;
    request(`/api/canvases/${canvasId}/history`).then(({ status, data }) => {
      if (!cancelled && status === 200) setHistory(data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [showHistory, canvasId, event]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    request(`/api/canvases/${canvasId}`).then(({ status, data }) => {
      if (status === 200) setCanvas(data.canvas);
      else setErr(data.error ?? "Не удалось открыть холст");
    });
  }, [canvasId]);

  // Штрихи других участников приходят через Ably
  useEffect(() => {
    if (!event || event.id !== canvasId) return;
    setCanvas((prev) => {
      if (!prev) return prev;
      if (event.cleared) return { ...prev, strokes: [] };
      if (event.stroke && !prev.strokes.some((x) => x.id === event.stroke!.id)) {
        return { ...prev, strokes: [...prev.strokes, event.stroke] };
      }
      return prev;
    });
  }, [event, canvasId]);

  function pointAt(clientX: number, clientY: number): [number, number] | null {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return [x, y];
  }

  async function finishStroke() {
    const pts = current;
    setCurrent(null);
    if (!pts || pts.length < 2 || !canvas) return;
    const body = { color: eraser ? "#ffffff" : color, width: eraser ? ERASER_WIDTH : width, points: pts };
    // Штрих сразу виден на холсте (временный отрицательный id), потом заменяется серверным
    const tempId = -Date.now();
    const local: CanvasStroke = { id: tempId, author_id: -1, color: body.color, width: body.width, points: pts };
    setCanvas((prev) => (prev ? { ...prev, strokes: [...prev.strokes, local] } : prev));
    const { status, data } = await request(`/api/canvases/${canvasId}/strokes`, "POST", body);
    if (status === 201 && data?.stroke) {
      const real = data.stroke as CanvasStroke;
      setCanvas((prev) => {
        if (!prev) return prev;
        const without = prev.strokes.filter((x) => x.id !== tempId);
        return { ...prev, strokes: without.some((x) => x.id === real.id) ? without : [...without, real] };
      });
    } else {
      setCanvas((prev) => (prev ? { ...prev, strokes: prev.strokes.filter((x) => x.id !== tempId) } : prev));
      setErr(data?.error ?? "Не удалось сохранить штрих");
    }
  }

  // Снимок холста в PNG: SVG рисуем на белом поле нужного размера
  async function sendPng() {
    const svg = svgRef.current;
    if (!svg) return;
    setSending(true);
    setErr("");
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.removeAttribute("style");
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(CANVAS_W));
      clone.setAttribute("height", String(CANVAS_H));
      const xml = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image"));
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
      });
      const c = document.createElement("canvas");
      c.width = CANVAS_W;
      c.height = CANVAS_H;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("context");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("png");
      // Общий холст в чате остаётся связанным с таймером редактирования
      const ok = await onSend(blob, canvas?.mode === "shared" ? canvasId : null);
      if (!ok) setErr("Не удалось отправить холст");
    } catch {
      setErr("Не удалось отправить холст");
    } finally {
      setSending(false);
    }
  }

  async function clearAll() {
    if (!window.confirm("Очистить холст? Это нельзя отменить.")) return;
    const { status, data } = await request(`/api/canvases/${canvasId}/strokes`, "DELETE");
    if (status === 200) setCanvas((prev) => (prev ? { ...prev, strokes: [] } : prev));
    else setErr(data.error ?? "Не удалось очистить холст");
  }

  const until = canvas?.edit_until ? Date.parse(canvas.edit_until) : null;
  const timeLeft = until === null ? null : until - now;
  const expired = timeLeft !== null && timeLeft <= 0;
  const canEditNow = !!canvas?.can_draw && !expired;
  const drawing = editing && canEditNow;
  const toPoints = (pts: [number, number][]) => pts.map(([x, y]) => `${x * CANVAS_W},${y * CANVAS_H}`).join(" ");

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "min(900px, 100%)", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 18, fontWeight: "bold", color: "#f5f5f5" }}>
            🎨 {canvas?.mode === "personal" ? "Личный холст" : "Общий холст"}
          </div>
          <button onClick={onClose} aria-label="Закрыть" style={{ background: "none", border: "none", color: "#f5f5f5", fontSize: 22, cursor: "pointer" }}>×</button>
        </div>

        {!canvas && !err && <p style={{ color: colors.gray }}>Загрузка…</p>}
        {err && <p style={{ color: "#ff8a8a" }}>{err}</p>}

        {canvas && (
          <>
            <p style={{ color: colors.gray, fontSize: 13, marginTop: 0 }}>{canvasRulesText(canvas)}</p>
            <button type="button" onClick={() => setShowHistory((v) => !v)} style={{ ...inlineButton, padding: "4px 10px", marginBottom: 8 }}>
              {showHistory ? "Скрыть редактирования" : "Посмотреть редактирования"}
            </button>
            {showHistory && (
              <div style={{ maxHeight: 260, overflowY: "auto", background: "#0b1420", borderRadius: 10, padding: "4px 10px", marginBottom: 10 }}>
                {history === null && <p style={{ color: colors.gray }}>Загрузка…</p>}
                {history && history.length === 0 && <p style={{ color: colors.gray }}>Изменений пока нет.</p>}
                {history?.map((g, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid #1f2d3d" }}>
                    <ChatAvatar photoId={g.author_photo_id} title={g.author_name} size={36} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#f5f5f5", fontWeight: "bold", fontSize: 14 }}>{g.author_name}</div>
                      <div style={{ color: colors.gray, fontSize: 12 }}>
                        {timeText(g.started_at)}
                        {g.ended_at !== g.started_at ? ` – ${timeText(g.ended_at)}` : ""} · штрихов: {g.strokes.length}
                      </div>
                    </div>
                    <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} style={{ width: 140, height: 84, background: "#ffffff", borderRadius: 6, flexShrink: 0 }}>
                      {g.strokes.map((st, j) => (
                        <polyline
                          key={j}
                          points={st.points.map(([x, y]) => `${x * CANVAS_W},${y * CANVAS_H}`).join(" ")}
                          fill="none"
                          stroke={st.color}
                          strokeWidth={st.width}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                    </svg>
                  </div>
                ))}
              </div>
            )}
            {canvas.can_draw && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                <span style={{ color: expired ? "#ff8a8a" : colors.gray, fontSize: 13 }}>
                  {until === null ? "Без срока" : expired ? "Редактирование закрыто" : `Осталось ${fmtLeft(timeLeft ?? 0)}`}
                </span>
                {canEditNow && !editing && (
                  <button type="button" onClick={() => setEditing(true)} style={{ ...inlineButton, padding: "4px 10px" }}>Редактировать</button>
                )}
                {drawing && (
                  <button type="button" onClick={() => setEditing(false)} style={{ ...inlineButton, padding: "4px 10px" }}>Готово</button>
                )}
              </div>
            )}
            <svg
              ref={svgRef}
              viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
              onPointerDown={(e) => {
                if (!drawing) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                const p = pointAt(e.clientX, e.clientY);
                if (p) setCurrent([p]);
              }}
              onPointerMove={(e) => {
                if (!current) return;
                const p = pointAt(e.clientX, e.clientY);
                if (p) setCurrent((cur) => (cur ? [...cur, p] : cur));
              }}
              onPointerUp={() => void finishStroke()}
              onPointerCancel={() => void finishStroke()}
              style={{ width: "100%", background: "#ffffff", borderRadius: 10, touchAction: "none", cursor: drawing ? "crosshair" : "default", display: "block" }}
            >
              {canvas.strokes.map((s) => (
                <polyline key={s.id} points={toPoints(s.points)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {current && current.length > 1 && (
                <polyline points={toPoints(current)} fill="none" stroke={eraser ? "#ffffff" : color} strokeWidth={eraser ? ERASER_WIDTH : width} strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>

            {drawing && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                {CANVAS_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Цвет ${c}`}
                    onClick={() => {
                      setColor(c);
                      setEraser(false);
                    }}
                    style={{ width: 24, height: 24, borderRadius: 12, background: c, border: !eraser && color === c ? `3px solid ${colors.blue}` : "1px solid #888", cursor: "pointer", padding: 0 }}
                  />
                ))}
                {CANVAS_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => {
                      setWidth(w);
                      setEraser(false);
                    }}
                    style={{ ...inlineButton, padding: "4px 8px", background: !eraser && width === w ? colors.blue : colors.yellow, color: colors.navy }}
                  >
                    {w}
                  </button>
                ))}
                <button type="button" onClick={() => setEraser((v) => !v)} style={{ ...inlineButton, padding: "4px 10px", background: eraser ? colors.blue : colors.yellow, color: colors.navy }}>
                  Ластик
                </button>
                <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                  {canvas.can_clear && (
                    <button type="button" onClick={() => void clearAll()} style={{ ...inlineButton, padding: "4px 10px", background: "#b00020", color: "#fff" }}>
                      Очистить
                    </button>
                  )}
                  <button type="button" disabled={sending} onClick={() => void sendPng()} style={{ ...inlineButton, padding: "4px 10px", background: colors.blue, color: colors.navy, opacity: sending ? 0.6 : 1 }}>
                    {sending ? "Отправка…" : "Отправить"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const VOICE_BARS = 36;

// Высоты полосок по звуковой волне: делим запись на отрезки и берём максимум громкости в каждом
function computePeaks(data: Float32Array, count: number): number[] {
  const step = Math.max(1, Math.floor(data.length / count));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    for (let j = i * step; j < Math.min((i + 1) * step, data.length); j++) max = Math.max(max, Math.abs(data[j]));
    out.push(max);
  }
  const top = Math.max(...out, 0.05);
  return out.map((v) => Math.max(0.12, Math.min(1, v / top)));
}

function PlayGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" fill="currentColor" />
    </svg>
  );
}

function AudioMessage({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let alive = true;
    loadAttachmentUrl(id).then(async (u) => {
      if (!alive) return;
      if (!u) {
        setFailed(true);
        return;
      }
      setSrc(u);
      // Декодируем запись: так узнаём точную длительность и строим волну (у записей браузера длительность в плеере часто не известна)
      try {
        const buf = await (await fetch(u)).arrayBuffer();
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const decoded = await ctx.decodeAudioData(buf);
        void ctx.close();
        if (!alive) return;
        setDuration(decoded.duration);
        setPeaks(computePeaks(decoded.getChannelData(0), VOICE_BARS));
      } catch {
        // Волну построить не удалось: покажем ровную полоску, проигрывание работает и без неё
      }
    });
    return () => {
      alive = false;
    };
  }, [id]);

  function toggle(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  }

  function seek(e: { currentTarget: HTMLDivElement; clientX: number; stopPropagation: () => void }) {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = share * duration;
    setCurrent(a.currentTime);
  }

  if (failed) return <div style={{ fontSize: 13, color: colors.gray }}>Не удалось загрузить голосовое</div>;
  if (!src) return <div style={{ fontSize: 13, color: colors.gray }}>Загрузка голосового…</div>;

  const bars = peaks.length ? peaks : Array.from({ length: VOICE_BARS }, () => 0.25);
  const progress = duration > 0 ? current / duration : 0;
  const shownTime = playing || current > 0 ? current : duration;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, width: 260, maxWidth: "100%", padding: "2px 0 4px" }}>
      <audio
        ref={audioRef}
        src={src}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (isFinite(d)) setDuration((prev) => prev || d);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Пауза" : "Слушать голосовое"}
        style={{ width: 40, height: 40, borderRadius: 20, border: "none", background: colors.blue, color: colors.navy, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
      >
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div onClick={seek} style={{ display: "flex", alignItems: "center", gap: 2, height: 28, cursor: "pointer" }}>
          {bars.map((h, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: `${Math.round(h * 100)}%`,
                minHeight: 3,
                borderRadius: 2,
                background: i / bars.length < progress ? colors.blue : "rgba(148,192,217,0.35)",
              }}
            />
          ))}
        </div>
        <div style={{ fontSize: 12, color: colors.gray, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{formatDuration(Math.floor(shownTime))}</div>
      </div>
    </div>
  );
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

function GearIcon({ color = "#ffffff" }: { color?: string }) {
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
  onLeave,
}: {
  chat: ChatItem;
  viewer: User;
  onBack: () => void;
  onSaved: () => void;
  onLeave?: () => void;
}) {
  const isGroup = chat.kind === "group";
  // Общий чат и чат комсостава настраиваются так же, как группа
  const groupLike = isGroup || chat.kind === "general" || chat.kind === "committee";
  const isCreator = chat.created_by === viewer.id;
  // Права меняет создатель группы, а в общих чатах — комсостав
  const canManage = isGroup ? isCreator : COMMITTEE_ROLES.includes(viewer.role);
  const [title, setTitle] = useState(chat.title);
  const [description, setDescription] = useState(chat.description ?? "");
  const [inviteMode, setInviteMode] = useState(chat.invite_mode);
  const [editMode, setEditMode] = useState(chat.edit_mode);
  const [mentionMode, setMentionMode] = useState(chat.mention_mode ?? "all");
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
    if (groupLike && !title.trim()) return setErr("Введите название");
    setSaving(true);
    const body: Record<string, string> = { description };
    if (groupLike) body.title = title.trim();
    if (groupLike && canManage) {
      body.invite_mode = inviteMode;
      body.edit_mode = editMode;
      body.mention_mode = mentionMode;
    }
    const { status, data } = await request(`/api/chats/${chat.id}/settings`, "PUT", body);
    setSaving(false);
    if (status === 200) onSaved();
    else setErr(data.error ?? "Не удалось сохранить");
  }

  // Строка права, как в VK: подпись, текущее значение и выпадающий список поверх строки
  const rightsRow = (label: string, value: string, onChange: (v: string) => void) => (
    <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "12px 4px", borderBottom: `1px solid ${colors.field}` }}>
      <div>
        <div style={{ color: "#f5f5f5", fontSize: 15 }}>{label}</div>
        <div style={{ color: colors.gray, fontSize: 13 }}>{value === "creator" ? "Только создатель" : "Все участники"}</div>
      </div>
      <span aria-hidden="true" style={{ color: colors.gray, fontSize: 18 }}>⇕</span>
      <select
        aria-label={label}
        value={value}
        disabled={!canManage}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: canManage ? "pointer" : "default" }}
      >
        <option value="all">Все участники</option>
        <option value="creator">Только создатель</option>
      </select>
    </div>
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

      {groupLike && (
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

      {groupLike && (
        <div style={{ marginBottom: 10 }}>
          {rightsRow("Кто может приглашать участников", inviteMode, setInviteMode)}
          {rightsRow("Кто может редактировать информацию чата", editMode, setEditMode)}
          {rightsRow("Кто может отправлять массовые упоминания @all", mentionMode, setMentionMode)}
          {!canManage && <p style={{ color: colors.gray, fontSize: 13, marginTop: 8 }}>{isGroup ? "Права может менять только создатель группы." : "Права может менять только комсостав."}</p>}
        </div>
      )}

      {err && <p style={{ color: "#b00020", fontSize: 13 }}>{err}</p>}
      <button onClick={save} disabled={saving} style={button}>{saving ? "Сохранение..." : "Сохранить"}</button>
      {isGroup && onLeave && (
        <button onClick={onLeave} style={{ ...button, background: "#b00020", color: "#fff", marginTop: 10 }}>
          Выйти из группы
        </button>
      )}
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
  const [tab, setTab] = useState<MediaTab>("members");
  const [media, setMedia] = useState<MediaItem[]>([]);

  async function loadMembers() {
    const { status, data } = await request(`/api/chats/${chat.id}/members`);
    if (status === 200) setMembers(data.members);
    else setErr(data.error ?? "Не удалось загрузить участников");
  }

  useEffect(() => {
    loadMembers();
  }, [chat.id]);

  useEffect(() => {
    if (tab === "members") return;
    let cancelled = false;
    request(`/api/chats/${chat.id}/media?kind=${tab}`).then(({ status, data }) => {
      if (!cancelled && status === 200) setMedia(data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, chat.id]);

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

  // Назначить или снять админа группы (только создатель группы)
  async function setAdmin(userId: number, admin: boolean) {
    setErr("");
    const { status, data } = await request(`/api/chats/${chat.id}/members/${userId}/admin`, "PUT", { admin });
    if (status === 200) loadMembers();
    else setErr(data.error ?? "Не удалось изменить права");
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
        onLeave={() => void leave()}
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

      <div style={{ display: "flex", gap: 6, marginTop: 16, overflowX: "auto", paddingBottom: 4 }}>
        {TAB_LABELS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              ...inlineButton,
              padding: "6px 10px",
              fontSize: 13,
              background: tab === key ? colors.blue : colors.yellow,
              color: tab === key ? "#fff" : colors.navy,
            }}
          >
            {key === "members" ? `${label} ${members.length}` : label}
          </button>
        ))}
      </div>

      {tab !== "members" ? (
        <MediaList tab={tab} items={media} />
      ) : (
      <div style={{ textAlign: "left", marginTop: 12 }}>
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

        {members.map((m) => {
          const isAdmin = (m as { is_admin?: number }).is_admin === 1;
          const isCreator = chat.created_by === m.id;
          return (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${colors.field}` }}>
              <ChatAvatar photoId={m.photo_id} title={m.full_name} size={36} />
              <span style={{ fontWeight: m.id === viewer.id ? "bold" : "normal" }}>
                {m.full_name}
                {m.id === viewer.id ? " (вы)" : ""}
                {isAdmin && isGroup ? (isCreator ? " · создатель" : " · админ") : ""}
              </span>
              {isGroup && chat.created_by === viewer.id && m.id !== viewer.id && !isCreator && (
                <button onClick={() => setAdmin(m.id, !isAdmin)} style={{ ...inlineButton, marginLeft: "auto" }}>
                  {isAdmin ? "Снять админа" : "Сделать админом"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

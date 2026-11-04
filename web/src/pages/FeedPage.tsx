import { CSSProperties, FormEvent, useEffect, useState } from "react";
import { User, downloadAttachment, loadImage, request, uploadAttachment, uploadFile } from "../api";
import { button, card, colors, input } from "../styles";

interface PollOption {
  id: number;
  text: string;
  votes: number;
  voters?: string[]; // только в неанонимных опросах
}

interface Poll {
  id: number;
  question: string;
  multiple: boolean;
  lock_vote: boolean;
  anonymous: boolean;
  ends_at: string | null;
  ended: boolean;
  options: PollOption[];
  my_votes: number[];
}

interface Post {
  id: number;
  body: string;
  photo_id: string | null;
  text_position: "top" | "bottom";
  attachment_id: string | null;
  attachment_name: string | null;
  created_at: string;
  author_id: number;
  author_name: string;
  poll: Poll | null;
}

const MAX_OPTIONS = 10;

// Лента новостей: посты с текстом, фото, файлом и опросом. Удалить может автор или комсостав.
export function FeedPage({ viewer }: { viewer: User }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [committee, setCommittee] = useState(false);
  const [message, setMessage] = useState("");

  // Новый пост
  const [body, setBody] = useState("");
  const [textTop, setTextTop] = useState(true);
  // Одна кнопка «Прикрепить»: картинка показывается в посте, любой другой файл — ссылкой на скачивание
  const [attached, setAttached] = useState<File | null>(null);
  const [attachedKey, setAttachedKey] = useState(0);
  const [pollOn, setPollOn] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [lock, setLock] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [timed, setTimed] = useState(false);
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);

  const attachedIsImage = !!attached && attached.type.startsWith("image/");
  const hasMedia = !!attached || pollOn;
  const canPublish = !!body.trim() || !!attached || (pollOn && !!question.trim());

  async function load() {
    const { status, data } = await request("/api/posts");
    if (status === 200) {
      setPosts(data.posts ?? []);
      setCommittee(!!data.viewer_committee);
    } else setMessage(data.error ?? "Не удалось загрузить ленту");
  }

  useEffect(() => {
    load();
  }, []);

  function resetComposer() {
    setBody("");
    setAttached(null);
    setAttachedKey((k) => k + 1);
    setPollOn(false);
    setQuestion("");
    setOptions(["", ""]);
    setMultiple(false);
    setLock(false);
    setAnonymous(false);
    setTimed(false);
    setEndsAt("");
  }

  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      let photoId: string | undefined;
      let attachmentId: string | undefined;
      if (attached && attachedIsImage) {
        const up = await uploadFile(attached);
        if (!up.ok) return setMessage(up.error ?? "Не удалось загрузить фото");
        photoId = up.id;
      } else if (attached) {
        const up = await uploadAttachment(attached);
        if (!up.ok) return setMessage(up.error ?? "Не удалось загрузить файл");
        attachmentId = up.id;
      }
      const poll = pollOn
        ? {
            question: question.trim(),
            options: options.map((o) => o.trim()).filter(Boolean),
            multiple,
            lock,
            anonymous,
            ends_at: timed && endsAt ? new Date(endsAt).toISOString() : null,
          }
        : undefined;
      const { status, data } = await request("/api/posts", "POST", {
        body: body.trim(),
        text_position: textTop ? "top" : "bottom",
        photo_id: photoId,
        attachment_id: attachmentId,
        poll,
      });
      if (status === 201) {
        resetComposer();
        await load();
      } else setMessage(data.error ?? "Не удалось опубликовать");
    } catch {
      setMessage("Не удалось связаться с сервером. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(post: Post) {
    if (!window.confirm("Удалить этот пост?")) return;
    const { status, data } = await request(`/api/posts/${post.id}`, "DELETE");
    if (status === 200) await load();
    else setMessage(data.error ?? "Не удалось удалить");
  }

  function setOption(i: number, value: string) {
    setOptions((list) => list.map((o, j) => (j === i ? value : o)));
  }

  return (
    <section>
      <h2>Лента</h2>
      <form onSubmit={publish} style={card}>
        <textarea
          style={{ ...input, minHeight: 90 }}
          placeholder="Что нового в отряде?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
        />

        {hasMedia && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <span style={{ color: colors.gray, alignSelf: "center" }}>Текст:</span>
            <button type="button" onClick={() => setTextTop(true)} style={chip(textTop)}>сверху</button>
            <button type="button" onClick={() => setTextTop(false)} style={chip(!textTop)}>снизу</button>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <label style={linkLabel}>
            Прикрепить
            <input key={attachedKey} type="file" style={{ display: "none" }} onChange={(e) => setAttached(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" onClick={() => setPollOn((v) => !v)} style={linkButton}>
            {pollOn ? "Убрать опрос" : "Опрос"}
          </button>
        </div>
        {attached && (
          <div style={{ color: colors.gray, fontSize: 14, marginBottom: 6 }}>
            Прикреплено: {attached.name}{" "}
            <button type="button" onClick={() => { setAttached(null); setAttachedKey((k) => k + 1); }} style={linkButton}>
              убрать
            </button>
          </div>
        )}

        {pollOn && (
          <div style={{ background: colors.field, borderRadius: 12, padding: 12, marginBottom: 12 }}>
            <label style={{ display: "block" }}>
              Тема вопроса
              <input style={input} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} />
            </label>
            {options.map((o, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input style={input} placeholder={`Вариант ${i + 1}`} value={o} onChange={(e) => setOption(i, e.target.value)} maxLength={200} />
                {options.length > 2 && (
                  <button type="button" onClick={() => setOptions((list) => list.filter((_, j) => j !== i))} style={linkButton}>
                    убрать
                  </button>
                )}
              </div>
            ))}
            {options.length < MAX_OPTIONS && (
              <button type="button" onClick={() => setOptions((list) => [...list, ""])} style={{ ...linkButton, marginBottom: 12 }}>
                + Добавить вариант
              </button>
            )}
            <label style={checkRow}>
              <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Выбор нескольких вариантов
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Запретить отмену голоса
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Анонимно
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Ограниченное время голосования
            </label>
            {timed && (
              <label style={{ display: "block", marginTop: 6 }}>
                Голосование до
                <input style={input} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
              </label>
            )}
          </div>
        )}

        <button style={button} type="submit" disabled={busy || !canPublish}>
          {busy ? "Публикация…" : "Опубликовать"}
        </button>
      </form>

      {posts.length === 0 && <div style={card}>Постов пока нет.</div>}
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          canDelete={committee || post.author_id === viewer.id}
          onDelete={() => remove(post)}
          onChanged={load}
        />
      ))}
      {message && <p>{message}</p>}
    </section>
  );
}

function PostCard({ post, canDelete, onDelete, onChanged }: { post: Post; canDelete: boolean; onDelete: () => void; onChanged: () => void }) {
  const text = post.body ? <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, marginTop: 8 }}>{post.body}</div> : null;
  const media = (
    <>
      {post.photo_id && <PostPhoto id={post.photo_id} />}
      {post.attachment_id && post.attachment_name && <AttachmentLink id={post.attachment_id} name={post.attachment_name} />}
      {post.poll && <PollView poll={post.poll} onVoted={onChanged} />}
    </>
  );

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <b>{post.author_name}</b>
        <span style={{ fontSize: 13, color: colors.gray }}>{new Date(post.created_at).toLocaleString("ru-RU")}</span>
      </div>
      {post.text_position === "bottom" ? (
        <>
          {media}
          {text}
        </>
      ) : (
        <>
          {text}
          {media}
        </>
      )}
      {canDelete && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={onDelete}
            style={{ background: "none", border: "none", color: colors.gray, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 14 }}
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}

function PostPhoto({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    loadImage(id).then((u) => {
      url = u;
      if (alive) setSrc(u);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (!src) return null;
  return <img src={src} alt="" style={{ display: "block", width: "100%", borderRadius: 10, marginTop: 8 }} />;
}

function AttachmentLink({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState("");
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={async () => setError((await downloadAttachment(id, name)) ?? "")}
        style={{ ...button, width: "auto", padding: "8px 14px", fontSize: 15 }}
      >
        Скачать: {name}
      </button>
      {error && <div style={{ color: "#b00020", fontSize: 14 }}>{error}</div>}
    </div>
  );
}

function PollView({ poll, onVoted }: { poll: Poll; onVoted: () => void }) {
  const [error, setError] = useState("");
  const total = poll.options.reduce((sum, o) => sum + o.votes, 0);

  async function vote(optionId: number) {
    setError("");
    const { status, data } = await request(`/api/polls/${poll.id}/vote`, "POST", { option_id: optionId });
    if (status === 200) onVoted();
    else setError(data.error ?? "Не удалось проголосовать");
  }

  const [showVoters, setShowVoters] = useState(false);

  const status = [
    poll.multiple ? "Можно выбрать несколько вариантов" : "Один вариант",
    poll.anonymous ? "анонимно" : null,
    poll.lock_vote ? "отмена голоса запрещена" : null,
    poll.ended ? "голосование завершено" : poll.ends_at ? `до ${new Date(poll.ends_at).toLocaleString("ru-RU")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ marginTop: 10, border: `1px solid ${colors.field}`, borderRadius: 12, padding: 12 }}>
      <b>{poll.question}</b>
      <div style={{ fontSize: 13, color: colors.gray, marginBottom: 8 }}>{status}</div>
      {poll.options.map((o) => {
        const mine = poll.my_votes.includes(o.id);
        const pct = total ? Math.round((o.votes / total) * 100) : 0;
        return (
          <button
            key={o.id}
            disabled={poll.ended}
            onClick={() => vote(o.id)}
            style={{
              position: "relative",
              display: "flex",
              justifyContent: "space-between",
              width: "100%",
              marginBottom: 6,
              padding: "10px 12px",
              borderRadius: 8,
              border: mine ? `2px solid ${colors.navy}` : `1px solid ${colors.field}`,
              background: `linear-gradient(to right, ${colors.blue} ${pct}%, ${colors.field} ${pct}%)`,
              color: colors.navy,
              fontWeight: mine ? 700 : 400,
              cursor: poll.ended ? "default" : "pointer",
              textAlign: "left",
            }}
          >
            <span>{o.text}</span>
            <span>{o.votes} · {pct}%</span>
          </button>
        );
      })}
      <div style={{ fontSize: 13, color: colors.gray }}>Проголосовало: {total}</div>
      {poll.anonymous ? (
        <div style={{ fontSize: 13, color: colors.gray, marginTop: 4 }}>Опрос анонимный, имена не показываются.</div>
      ) : (
        total > 0 && (
          <div style={{ marginTop: 4 }}>
            <button type="button" onClick={() => setShowVoters(true)} style={linkButton}>
              Кто проголосовал
            </button>
          </div>
        )
      )}
      {showVoters && <VotersModal poll={poll} onClose={() => setShowVoters(false)} />}
      {error && <div style={{ color: "#b00020", fontSize: 14 }}>{error}</div>}
    </div>
  );
}

function chip(active: boolean): CSSProperties {
  return {
    padding: "4px 12px",
    borderRadius: 999,
    border: "none",
    background: active ? colors.yellow : colors.field,
    color: colors.navy,
    fontWeight: active ? 700 : 400,
    cursor: "pointer",
  };
}

const linkLabel: CSSProperties = {
  color: colors.navy,
  textDecoration: "underline",
  cursor: "pointer",
};

const linkButton: CSSProperties = {
  background: "none",
  border: "none",
  color: colors.navy,
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
  fontSize: 15,
};

const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 6,
  color: colors.navy,
};

// Окно «Кто проголосовал»: вкладки по вариантам, число людей, список с именами
function VotersModal({ poll, onClose }: { poll: Poll; onClose: () => void }) {
  const [tab, setTab] = useState<number | null>(null);
  const names = new Set<string>();
  poll.options.forEach((o) => (o.voters ?? []).forEach((n) => names.add(n)));
  const uniqueVoters = names.size;
  const maxVotes = Math.max(0, ...poll.options.map((o) => o.votes));
  const shown = poll.options.filter((o) => tab === null || o.id === tab);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2, 35, 66, 0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: colors.white,
          color: colors.navy,
          borderRadius: 16,
          width: "100%",
          maxWidth: 520,
          maxHeight: "85vh",
          overflowY: "auto",
          padding: 20,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <b style={{ fontSize: 18 }}>{poll.question}</b>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            style={{ background: "none", border: "none", fontSize: 26, lineHeight: 1, cursor: "pointer", color: colors.navy }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          <button type="button" onClick={() => setTab(null)} style={chip(tab === null)}>Все варианты</button>
          {poll.options.map((o) => (
            <button key={o.id} type="button" onClick={() => setTab(o.id)} style={chip(tab === o.id)}>
              {o.text}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 15, marginBottom: 16 }}>
          Проголосовали <b>{uniqueVoters}</b> {personWord(uniqueVoters)}
        </div>

        {shown.map((o) => {
          const share = uniqueVoters ? (o.votes / uniqueVoters) * 100 : 0;
          const leader = o.votes > 0 && o.votes === maxVotes;
          const voters = o.voters ?? [];
          return (
            <div key={o.id} style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: 700 }}>
                <span>{o.text}</span>
                <span>
                  {leader && "✓ "}
                  {share.toFixed(2)} %
                </span>
              </div>
              <div style={{ height: 6, background: colors.field, borderRadius: 3, margin: "6px 0 10px", overflow: "hidden" }}>
                <div style={{ width: `${share}%`, height: "100%", background: colors.blue }} />
              </div>
              {voters.length === 0 ? (
                <div style={{ fontSize: 14, color: colors.gray }}>Голосов нет</div>
              ) : (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {voters.map((name) => (
                      <div key={name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar name={name} />
                        <span>{name}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: colors.gray, marginTop: 6 }}>
                    {o.votes} {voteWord(o.votes)}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        background: colors.blue,
        color: colors.navy,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 14,
        flexShrink: 0,
      }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

// Склонения: 1 человек / 2 человека / 5 человек; 1 голос / 2 голоса / 5 голосов
function personWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return "человек";
  if (m10 === 1) return "человек";
  if (m10 >= 2 && m10 <= 4) return "человека";
  return "человек";
}

function voteWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return "голосов";
  if (m10 === 1) return "голос";
  if (m10 >= 2 && m10 <= 4) return "голоса";
  return "голосов";
}

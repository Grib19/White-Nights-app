import { CSSProperties, FormEvent, useEffect, useState } from "react";
import { User, downloadAttachment, loadImage, request, uploadAttachment, uploadFile } from "../api";
import { button, card, colors, input } from "../styles";

interface PollOption {
  id: number;
  text: string;
  votes: number;
}

interface Poll {
  id: number;
  question: string;
  multiple: boolean;
  lock_vote: boolean;
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

  const status = [
    poll.multiple ? "Можно выбрать несколько вариантов" : "Один вариант",
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

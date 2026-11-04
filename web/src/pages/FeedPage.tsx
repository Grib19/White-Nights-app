import { FormEvent, useEffect, useState } from "react";
import { User, loadImage, request, uploadFile } from "../api";
import { button, card, colors, input } from "../styles";

interface Post {
  id: number;
  body: string;
  photo_id: string | null;
  created_at: string;
  author_id: number;
  author_name: string;
}

// Лента новостей: все участники пишут посты (текст и/или фото), удалить может автор или комсостав
export function FeedPage({ viewer }: { viewer: User }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [committee, setCommittee] = useState(false);
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

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

  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      let photoId: string | undefined;
      if (file) {
        const up = await uploadFile(file);
        if (!up.ok) {
          setMessage(up.error ?? "Не удалось загрузить фото");
          return;
        }
        photoId = up.id;
      }
      const { status, data } = await request("/api/posts", "POST", { body: body.trim(), photo_id: photoId });
      if (status === 201) {
        setBody("");
        setFile(null);
        setFileKey((k) => k + 1);
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
        <input
          key={fileKey}
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ display: "block", marginBottom: 12 }}
        />
        <button style={button} type="submit" disabled={busy || (!body.trim() && !file)}>
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
        />
      ))}
      {message && <p>{message}</p>}
    </section>
  );
}

function PostCard({ post, canDelete, onDelete }: { post: Post; canDelete: boolean; onDelete: () => void }) {
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!post.photo_id) return;
    let url: string | null = null;
    let alive = true;
    loadImage(post.photo_id).then((u) => {
      url = u;
      if (alive) setPhoto(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [post.photo_id]);

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <b>{post.author_name}</b>
        <span style={{ fontSize: 13, color: colors.gray }}>{new Date(post.created_at).toLocaleString("ru-RU")}</span>
      </div>
      {post.body && <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, marginTop: 8 }}>{post.body}</div>}
      {photo && <img src={photo} alt="" style={{ display: "block", width: "100%", borderRadius: 10, marginTop: 8 }} />}
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

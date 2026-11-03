import { FormEvent, useEffect, useRef, useState } from "react";
import { Song, User, loadAudio, request, uploadSong } from "../api";
import { button, card, colors, input } from "../styles";

// PDF-файлы документов: лежат в web/public и скачиваются по прямой ссылке
const DOC_FILES: Record<string, { file: string; name: string }> = {
  "corporate-code": { file: "/korporativny-kodeks.pdf", name: "Корпоративный кодекс МООО РСО.pdf" },
  "rules-otryad": { file: "/polozhenie-o-linejnom-otryade.pdf", name: "Положение о линейном студенческом отряде.pdf" },
  "rules-shtab": { file: "/polozhenie-o-shtabe.pdf", name: "Положение о Штабе Молодость.pdf" },
  symbols: { file: "/polozhenie-o-simvolike.pdf", name: "Положение о символике и атрибутике.pdf" },
  ustav: { file: "/ustav-mooo-rso.pdf", name: "Устав МООО РСО.pdf" },
};

interface DocItem {
  slug: string;
  title: string;
  updated_at: string;
}

export function InfoPage({ viewer }: { viewer: User }) {
  const committee = ["master", "commissar", "commander"].includes(viewer.role);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");

  const textRef = useRef<HTMLTextAreaElement>(null);

  // Высота поля подстраивается под текст, чтобы весь документ был виден без прокрутки
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 4}px`;
  }, [body, slug]);

  useEffect(() => {
    request("/api/info").then(({ data }) => setDocs(data.docs ?? []));
  }, []);

  useEffect(() => {
    if (!slug) return;
    setMessage("");
    request(`/api/info/${slug}`).then(({ status, data }) => {
      if (status === 200) {
        setTitle(data.doc.title);
        setBody(data.doc.body);
      } else setMessage(data.error ?? "Ошибка");
    });
  }, [slug]);

  async function save() {
    if (!slug) return;
    const { status, data } = await request(`/api/info/${slug}`, "PUT", { body });
    setMessage(status === 200 ? "Сохранено" : data.error ?? "Ошибка");
  }

  if (!slug) {
    return (
      <section>
        {docs.map((d) => (
          <button
            key={d.slug}
            onClick={() => setSlug(d.slug)}
            style={{ ...card, width: "100%", textAlign: "left", background: "white", cursor: "pointer" }}
          >
            <b>{d.title}</b>
          </button>
        ))}
      </section>
    );
  }

  return (
    <section>
      <button onClick={() => setSlug(null)} style={{ marginBottom: 12, background: "none", border: "none", color: "#94C0D9", fontSize: 16, textDecoration: "underline", cursor: "pointer" }}>
        ← Назад
      </button>
      <h2>{title}</h2>
      {DOC_FILES[slug] && (
        <a
          href={DOC_FILES[slug].file}
          download={DOC_FILES[slug].name}
          style={{ ...button, display: "inline-block", width: "auto", marginBottom: 16, textDecoration: "none", boxSizing: "border-box" }}
        >
          Скачать PDF
        </a>
      )}
      {committee ? (
        <>
          <textarea ref={textRef} style={{ ...input, minHeight: 240, overflow: "hidden", resize: "vertical" }} value={body} onChange={(e) => setBody(e.target.value)} />
          <button style={button} onClick={save}>Сохранить</button>
        </>
      ) : (
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{body || "Пока пусто."}</div>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}

// Раздел «Песни»: плеер для всех участников, добавление и удаление — для комсостава
export function SongsSection({ committee }: { committee: boolean }) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);

  async function load() {
    const { status, data } = await request("/api/songs");
    if (status === 200) setSongs(data.songs ?? []);
    else setMessage(data.error ?? "Не удалось загрузить песни");
  }

  useEffect(() => {
    load();
  }, []);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setMessage("");
    const res = await uploadSong(file, title.trim(), author.trim());
    setBusy(false);
    if (res.ok) {
      setTitle("");
      setAuthor("");
      setFile(null);
      setFileKey((k) => k + 1);
      setMessage("Песня добавлена");
      await load();
    } else setMessage(res.error ?? "Ошибка");
  }

  async function remove(song: Song) {
    if (!window.confirm(`Удалить песню «${song.title}»?`)) return;
    const { status, data } = await request(`/api/songs/${song.id}`, "DELETE");
    if (status === 200) await load();
    else setMessage(data.error ?? "Не удалось удалить");
  }

  return (
    <>
      {committee && (
        <form onSubmit={add} style={card}>
          <b>Добавить песню</b>
          <label style={{ display: "block", marginTop: 8 }}>
            Название
            <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label style={{ display: "block" }}>
            Автор / исполнитель
            <input style={input} value={author} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Аудиофайл (mp3, m4a, wav, ogg до 20 МБ)
            <input key={fileKey} type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ display: "block", margin: "4px 0" }} />
          </label>
          <p style={{ fontSize: 13, color: colors.gray, margin: "0 0 12px" }}>
            Загружайте только записи, на которые у СОП есть права.
          </p>
          <button style={button} type="submit" disabled={busy || !file || !title.trim()}>
            {busy ? "Загрузка…" : "Добавить песню"}
          </button>
        </form>
      )}

      {songs.length === 0 && <div style={card}>Песен пока нет.</div>}
      {songs.map((song, i) => (
        <SongCard key={song.id} song={song} index={i + 1} canDelete={committee} onDelete={() => remove(song)} />
      ))}
      {message && <p>{message}</p>}
    </>
  );
}

function SongCard({
  song,
  index,
  canDelete,
  onDelete,
}: {
  song: Song;
  index: number;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Освобождаем память от загруженной записи, когда она больше не нужна
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function play() {
    setLoading(true);
    setError("");
    const url = await loadAudio(song.id);
    setLoading(false);
    if (url) setSrc(url);
    else setError("Не удалось загрузить запись");
  }

  return (
    <div style={card}>
      <div>
        <b>
          {index}. {song.title}
        </b>
      </div>
      {song.author && <div style={{ color: colors.gray }}>{song.author}</div>}
      {src ? (
        <audio controls autoPlay src={src} style={{ width: "100%", marginTop: 8 }} />
      ) : (
        <button
          onClick={play}
          disabled={loading}
          style={{ ...button, width: "auto", padding: "8px 16px", marginTop: 8 }}
        >
          {loading ? "Загрузка…" : "▶ Слушать"}
        </button>
      )}
      {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}
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

import { useEffect, useState } from "react";
import { User, request } from "../api";
import { button, card, input } from "../styles";

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
        <a
          href="/korporativny-kodeks.pdf"
          download="Корпоративный кодекс МООО РСО.pdf"
          style={{ ...button, display: "block", textAlign: "center", textDecoration: "none", boxSizing: "border-box", marginBottom: 16 }}
        >
          Скачать Корпоративный кодекс (PDF)
        </a>
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
      {committee ? (
        <>
          <textarea style={{ ...input, minHeight: 240 }} value={body} onChange={(e) => setBody(e.target.value)} />
          <button style={button} onClick={save}>Сохранить</button>
        </>
      ) : (
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{body || "Пока пусто."}</div>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}

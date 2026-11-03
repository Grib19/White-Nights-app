import { useEffect, useState } from "react";
import { User, loadImage, request, roleLabel } from "../api";
import { card, input } from "../styles";

interface Member {
  id: number;
  full_name: string;
  role: string;
  username: string | null;
  position: string | null;
  photo_id: string | null;
}

export function MembersPage({ viewer }: { viewer: User }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    request("/api/profiles").then(({ data }) => setMembers(data.users ?? []));
  }, []);

  if (openId !== null) {
    return <MemberCard id={openId} viewer={viewer} onBack={() => setOpenId(null)} />;
  }

  const q = query.trim().toLowerCase();
  const shown = members.filter(
    (m) => !q || m.full_name.toLowerCase().includes(q) || (m.username ?? "").toLowerCase().includes(q),
  );

  return (
    <section>
      <input style={input} placeholder="Поиск по имени" value={query} onChange={(e) => setQuery(e.target.value)} />
      {shown.length === 0 && <p>Никого не найдено.</p>}
      {shown.map((m) => (
        <button
          key={m.id}
          onClick={() => setOpenId(m.id)}
          style={{ ...card, display: "flex", gap: 12, alignItems: "center", width: "100%", textAlign: "left", background: "white", cursor: "pointer" }}
        >
          <Avatar photoId={m.photo_id} />
          <div>
            <div><b>{m.full_name}</b></div>
            <div style={{ fontSize: 13, color: "#555" }}>
              {roleLabel(m.role)}{m.position ? `, ${m.position}` : ""}
            </div>
          </div>
        </button>
      ))}
    </section>
  );
}

function Avatar({ photoId, size = 48 }: { photoId: string | null; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!photoId) return setSrc(null);
    let url: string | null = null;
    loadImage(photoId).then((u) => {
      url = u;
      setSrc(u);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [photoId]);
  return src ? (
    <img src={src} alt="" style={{ width: size, height: size, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: 8, background: "#eee", flexShrink: 0 }} />
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MemberCard({ id, viewer, onBack }: { id: number; viewer: User; onBack: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [profile, setProfile] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [priv, setPriv] = useState<any>(null);
  const [error, setError] = useState("");
  const committee = ["master", "commissar", "commander"].includes(viewer.role);

  useEffect(() => {
    request(`/api/profiles/${id}`).then(({ status, data }) => {
      if (status === 200) setProfile(data.profile);
      else setError(data.error ?? "Ошибка");
    });
    if (committee) {
      request(`/api/profiles/${id}/private`).then(({ status, data }) => {
        if (status === 200) setPriv(data.private);
      });
    }
  }, [id, committee]);

  return (
    <section>
      <button onClick={onBack} style={{ marginBottom: 12, background: "none", border: "none", textDecoration: "underline", cursor: "pointer" }}>
        ← Назад к списку
      </button>
      {error && <p>{error}</p>}
      {profile && (
        <>
          <div style={{ ...card, display: "flex", gap: 12, alignItems: "center" }}>
            <Avatar photoId={profile.photo_id} size={80} />
            <div>
              <div><b>{profile.full_name}</b></div>
              <div>{roleLabel(profile.role)}</div>
              {profile.username && <div>@{profile.username}</div>}
            </div>
          </div>
          <div style={card}>
            <h3>Личная информация</h3>
            <Row label="Телефон" value={profile.phone} />
            <Row label="Должность" value={profile.position} />
            <Row label="Место обучения" value={profile.study_place} />
            <Row label="Курс" value={profile.course} />
            <Row label="Специальность" value={profile.specialty} />
            <Row label="Дата рождения" value={profile.birth_date} />
            <Row label="Размеры" value={profile.sizes} />
            <Row label="Достижения" value={profile.achievements} />
          </div>
          {committee && priv && (
            <div style={card}>
              <h3>Только для комсостава</h3>
              <Row label="Паспорт" value={priv.passport} />
              <Row label="ИНН" value={priv.inn} />
              <Row label="СНИЛС" value={priv.snils} />
              <Row label="Прописка" value={priv.address} />
              <Row label="ФИО родителя" value={priv.parent_name} />
              <Row label="Телефон родителя" value={priv.parent_phone} />
              <Row label="Дополнительно" value={priv.extra} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div>{value || "—"}</div>
    </div>
  );
}


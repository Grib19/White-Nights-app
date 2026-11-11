import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { User, loadImage, request, uploadFile } from "../api";
import { button, card, input } from "../styles";

const PUBLIC_LABELS: [string, string][] = [
  ["username", "Имя пользователя"],
  ["position", "Должность"],
  ["study_place", "Место обучения"],
  ["course", "Курс"],
  ["specialty", "Специальность"],
  ["birth_date", "Дата рождения"],
  ["sizes", "Размеры"],
  ["achievements", "Достижения в отряде"],
];

const PRIVATE_LABELS: [string, string][] = [
  ["passport", "Паспорт"],
  ["inn", "ИНН"],
  ["snils", "СНИЛС"],
  ["address", "Прописка"],
  ["parent_name", "ФИО родителя (если нет 18 лет)"],
  ["parent_phone", "Телефон родителя"],
  ["extra", "Дополнительно"],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Values = Record<string, any>;

export function ProfilePage({ user }: { user: User }) {
  const [pub, setPub] = useState<Values>({});
  const [priv, setPriv] = useState<Values>({});
  const [photo, setPhoto] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    request(`/api/profiles/${user.id}`).then(({ data }) => {
      if (data.profile) setPub(data.profile);
    });
    request(`/api/profiles/${user.id}/private`).then(({ data }) => {
      if (data.private) setPriv(data.private);
    });
  }, [user.id]);

  useEffect(() => {
    if (!pub.photo_id) return setPhoto(null);
    loadImage(pub.photo_id).then(setPhoto);
  }, [pub.photo_id]);

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMessage("Загружаем фото…");
    const up = await uploadFile(file);
    if (!up.ok || !up.id) return setMessage(up.error ?? "Ошибка загрузки");
    const { status, data } = await request("/api/profiles/me", "PUT", { ...pub, photo_id: up.id });
    setMessage(status === 200 ? "Фото сохранено" : data.error ?? "Ошибка");
    if (status === 200) setPub({ ...pub, photo_id: up.id });
  }

  async function savePublic(e: FormEvent) {
    e.preventDefault();
    const { status, data } = await request("/api/profiles/me", "PUT", pub);
    setMessage(status === 200 ? "Профиль сохранён" : data.error ?? "Ошибка");
  }

  async function savePrivate(e: FormEvent) {
    e.preventDefault();
    const { status, data } = await request("/api/profiles/me/private", "PUT", priv);
    setMessage(status === 200 ? "Закрытые данные сохранены" : data.error ?? "Ошибка");
  }

  return (
    <section>
      <div style={{ ...card, display: "flex", gap: 12, alignItems: "center" }}>
        {photo ? (
          <img src={photo} alt="" style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover" }} />
        ) : (
          <div style={{ width: 80, height: 80, borderRadius: 8, background: "#eee" }} />
        )}
        <div>
          <div><b>{user.full_name}</b></div>
          <div>{user.phone}</div>
          <label style={{ display: "inline-block", marginTop: 6, cursor: "pointer", textDecoration: "underline" }}>
            Загрузить фото
            <input type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} />
          </label>
        </div>
      </div>

      <form onSubmit={savePublic} style={card}>
        <h3>Личная информация для всех</h3>
        {PUBLIC_LABELS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              style={input}
              value={pub[key] ?? ""}
              onChange={(e) => setPub({ ...pub, [key]: e.target.value })}
            />
          </label>
        ))}
        <button style={button} type="submit">Сохранить профиль</button>
      </form>

      <form onSubmit={savePrivate} style={card}>
        <h3>Только для комсостава</h3>
        <p style={{ fontSize: 13, color: "#555" }}>Эти данные видите только вы и комсостав.</p>
        {PRIVATE_LABELS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              style={input}
              value={priv[key] ?? ""}
              onChange={(e) => setPriv({ ...priv, [key]: e.target.value })}
            />
          </label>
        ))}
        <button style={button} type="submit">Сохранить закрытые данные</button>
      </form>

      {message && <p>{message}</p>}
    </section>
  );
}

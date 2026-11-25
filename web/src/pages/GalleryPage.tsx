import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { User, loadGalleryPhoto, request, uploadGalleryPhoto } from "../api";
import { button, card, colors, input, tabButton } from "../styles";

type Scope = "managers" | "all";

interface Album {
  id: number;
  title: string;
  description: string;
  cover_photo_id: number | null;
  upload_scope: Scope;
  created_by: number;
  created_by_name: string;
  created_at: string;
  photos_count: number;
  can_manage: boolean;
  can_upload: boolean;
}

interface Photo {
  id: number;
  caption: string;
  mime: string;
  name: string;
  added_by: number;
  added_by_name: string;
  created_at: string;
  can_delete: boolean;
}

// Галерея: альбомы отряда. Создаёт комсостав и пресрук, фото — по настройке альбома.
export function GalleryPage({ viewer }: { viewer: User }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [connected, setConnected] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadAlbums() {
    try {
      const { status, data } = await request("/api/gallery/albums");
      if (status === 200) {
        setAlbums(data.albums ?? []);
        setCanManage(!!data.can_manage);
        setConfigured(!!data.configured);
        setConnected(!!data.connected);
        setMessage("");
      } else setMessage(data.error ?? "Не удалось загрузить альбомы");
    } catch {
      setMessage("Нет связи с сервером");
    }
  }

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("gallery");
    if (result) {
      if (result === "connected") setMessage("Google Диск подключён.");
      else setMessage("Не удалось подключить Google Диск. Попробуйте ещё раз.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    loadAlbums();
  }, []);

  // Подключение Диска: уходим на страницу Google и возвращаемся с ?gallery=connected
  async function connectDrive() {
    const { status, data } = await request(`/api/gallery/oauth/start?origin=${encodeURIComponent(window.location.origin)}`);
    if (status === 200 && data.url) window.location.href = data.url;
    else setMessage(data.error ?? "Не удалось начать подключение");
  }

  if (openId !== null) {
    return (
      <AlbumView
        albumId={openId}
        viewer={viewer}
        connected={connected}
        canManage={canManage}
        onBack={() => {
          setOpenId(null);
          loadAlbums();
        }}
        onConnect={connectDrive}
      />
    );
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Галерея</h2>
        {canManage && connected && (
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px" }} onClick={() => setCreating((v) => !v)}>
            {creating ? "Отмена" : "+ Альбом"}
          </button>
        )}
      </div>

      {message && <p style={{ color: colors.yellow }}>{message}</p>}

      {canManage && !configured && (
        <div style={{ ...card, marginBottom: 12 }}>
          <b>Google Диск не настроен на сервере.</b>
          <p style={{ color: colors.gray, fontSize: 14, margin: "6px 0 0" }}>
            Нужно задать GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET — после этого здесь появится кнопка подключения.
          </p>
        </div>
      )}

      {canManage && configured && !connected && (
        <div style={{ ...card, marginBottom: 12 }}>
          <b>Google Диск ещё не подключён.</b>
          <p style={{ color: colors.gray, fontSize: 14 }}>
            Фотографии хранятся на Google Диске. Подключить его может комсостав или пресрук — один раз для всего отряда.
          </p>
          <button type="button" style={{ ...button, width: "auto", padding: "8px 14px" }} onClick={() => void connectDrive()}>
            Подключить Google Диск
          </button>
        </div>
      )}

      {!canManage && !connected && (
        <p style={{ color: colors.gray }}>Галерея пока не подключена. Попросите комсостав подключить Google Диск.</p>
      )}

      {creating && canManage && connected && <CreateAlbum onCreated={() => {
        setCreating(false);
        loadAlbums();
      }} />}

      {albums.length === 0 && connected && <p style={{ color: colors.blue }}>Альбомов пока нет.</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {albums.map((a) => (
          <div
            key={a.id}
            onClick={() => setOpenId(a.id)}
            style={{ ...card, marginBottom: 0, padding: 12, cursor: "pointer", borderTop: `6px solid ${colors.yellow}` }}
          >
            <Cover id={a.cover_photo_id} />
            <div style={{ fontWeight: 700, marginTop: 8, overflowWrap: "anywhere" }}>{a.title}</div>
            <div style={{ fontSize: 13, color: colors.gray, marginTop: 4 }}>
              {a.photos_count} фото · {a.created_by_name}
            </div>
            <div style={{ fontSize: 12, color: colors.blue, marginTop: 4 }}>
              {a.upload_scope === "all" ? "Фото добавляют все" : "Фото добавляет комсостав и пресрук"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Cover({ id }: { id: number | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) return setSrc(null);
    let alive = true;
    loadGalleryPhoto(id).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <div style={{ aspectRatio: "4 / 3", background: "#0b1420", borderRadius: 10, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {src ? (
        <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <span style={{ fontSize: 28, color: colors.gray }}>▦</span>
      )}
    </div>
  );
}

function CreateAlbum({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<Scope>("managers");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return setErr("Укажите название альбома");
    setBusy(true);
    setErr("");
    const { status, data } = await request("/api/gallery/albums", "POST", { title: t, description, upload_scope: scope });
    setBusy(false);
    if (status === 201) onCreated();
    else setErr(data.error ?? "Не удалось создать альбом");
  }

  return (
    <form onSubmit={submit} style={{ ...card, marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Новый альбом</h3>
      <label>
        Название
        <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <label>
        Описание
        <textarea
          style={{ ...input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
        />
      </label>
      <label>
        Кто добавляет фото
        <select style={input} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="managers">Только комсостав и пресрук</option>
          <option value="all">Все участники</option>
        </select>
      </label>
      {err && <p style={{ color: "#ff8a8a", margin: 0 }}>{err}</p>}
      <button style={button} type="submit" disabled={busy}>
        {busy ? "Создаю…" : "Создать альбом"}
      </button>
    </form>
  );
}

function AlbumView({
  albumId,
  viewer,
  connected,
  canManage,
  onBack,
  onConnect,
}: {
  albumId: number;
  viewer: User;
  connected: boolean;
  canManage: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [canUpload, setCanUpload] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<Scope>("managers");
  const [opened, setOpened] = useState<Photo | null>(null);

  async function load() {
    try {
      const { status, data } = await request(`/api/gallery/albums/${albumId}`);
      if (status === 200) {
        setAlbum(data.album);
        setPhotos(data.photos ?? []);
        setCanUpload(!!data.can_upload);
        setTitle(data.album.title);
        setDescription(data.album.description);
        setScope(data.album.upload_scope);
        setMessage("");
      } else setMessage(data.error ?? "Не удалось открыть альбом");
    } catch {
      setMessage("Нет связи с сервером");
    }
  }

  useEffect(() => {
    load();
  }, [albumId]);

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setMessage("");
    let done = 0;
    let failed = 0;
    for (const file of files) {
      done++;
      setProgress(`Загружаю ${done} из ${files.length}…`);
      const up = await uploadGalleryPhoto(albumId, file, "");
      if (!up.ok) {
        failed++;
        setMessage(up.error ?? "Не удалось загрузить фото");
      }
    }
    setBusy(false);
    setProgress("");
    await load();
    if (failed === 0) setMessage(`Загружено фото: ${files.length}.`);
  }

  async function saveAlbum() {
    const { status, data } = await request(`/api/gallery/albums/${albumId}`, "PUT", { title, description, upload_scope: scope });
    if (status === 200) {
      setShowSettings(false);
      await load();
    } else setMessage(data.error ?? "Не удалось сохранить альбом");
  }

  async function removeAlbum() {
    if (!window.confirm("Удалить альбом вместе со всеми фотографиями?")) return;
    const { status, data } = await request(`/api/gallery/albums/${albumId}`, "DELETE");
    if (status === 200) onBack();
    else setMessage(data.error ?? "Не удалось удалить альбом");
  }

  async function removePhoto(p: Photo) {
    if (!window.confirm("Удалить это фото?")) return;
    const { status, data } = await request(`/api/gallery/photos/${p.id}`, "DELETE");
    if (status === 200) {
      setOpened(null);
      await load();
    } else setMessage(data.error ?? "Не удалось удалить фото");
  }

  async function editCaption(p: Photo) {
    const value = window.prompt("Подпись к фото", p.caption);
    if (value === null) return;
    const { status, data } = await request(`/api/gallery/photos/${p.id}`, "PUT", { caption: value.trim() });
    if (status === 200) {
      setOpened(null);
      await load();
    } else setMessage(data.error ?? "Не удалось сохранить подпись");
  }

  if (!album) {
    return (
      <div>
        <button type="button" style={tabButton(false)} onClick={onBack}>
          ← Все альбомы
        </button>
        {message && <p style={{ color: "#ff8a8a" }}>{message}</p>}
      </div>
    );
  }

  const canManageAlbum = album.can_manage;
  return (
    <section>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <button type="button" style={tabButton(false)} onClick={onBack}>
          ← Все альбомы
        </button>
        <b style={{ fontSize: 18, overflowWrap: "anywhere" }}>{album.title}</b>
        {canManageAlbum && (
          <>
            <button type="button" style={tabButton(false)} onClick={() => setShowSettings((v) => !v)}>
              Настройки
            </button>
            <button type="button" style={{ ...tabButton(false), color: "#ff8a8a" }} onClick={() => void removeAlbum()}>
              Удалить альбом
            </button>
          </>
        )}
      </div>
      {album.description && <p style={{ color: colors.gray, marginTop: 0 }}>{album.description}</p>}
      <div style={{ fontSize: 13, color: colors.blue, marginBottom: 12 }}>
        {album.upload_scope === "all" ? "Фото добавляют все участники" : "Фото добавляет комсостав и пресрук"} · фото: {photos.length}
      </div>

      {message && <p style={{ color: colors.yellow }}>{message}</p>}

      {showSettings && canManageAlbum && (
        <div style={{ ...card, marginBottom: 12 }}>
          <label>
            Название
            <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </label>
          <label>
            Описание
            <textarea
              style={{ ...input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </label>
          <label>
            Кто добавляет фото
            <select style={input} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="managers">Только комсостав и пресрук</option>
              <option value="all">Все участники</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" style={{ ...button, width: "auto", padding: "8px 14px" }} onClick={() => void saveAlbum()}>
              Сохранить
            </button>
            <button type="button" style={tabButton(false)} onClick={() => setShowSettings(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {!connected && <p style={{ color: colors.gray }}>Google Диск ещё не подключён — фотографии не загрузятся.</p>}
      {!connected && canManage && (
        <button type="button" style={{ ...button, width: "auto", padding: "8px 14px", marginBottom: 12 }} onClick={onConnect}>
          Подключить Google Диск
        </button>
      )}

      {connected && canUpload && (
        <label style={{ ...button, display: "inline-block", width: "auto", padding: "8px 14px", marginBottom: 12, cursor: busy ? "default" : "pointer", boxSizing: "border-box" }}>
          {busy ? progress || "Загружаю…" : "Добавить фото"}
          <input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => void onFiles(e)} />
        </label>
      )}
      {connected && !canUpload && <p style={{ color: colors.gray }}>Фото в этот альбом добавляет комсостав и пресрук.</p>}

      {photos.length === 0 && <p style={{ color: colors.gray }}>В этом альбоме пока нет фото.</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {photos.map((p) => (
          <PhotoCard
            key={p.id}
            photo={p}
            canManage={canManage || p.added_by === viewer.id}
            onOpen={() => setOpened(p)}
            onDelete={() => void removePhoto(p)}
          />
        ))}
      </div>

      {opened && (
        <div
          onClick={() => setOpened(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 60 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: "min(1000px, 100%)", maxHeight: "90vh", display: "flex", flexDirection: "column", gap: 10 }}>
            <BigPhoto id={opened.id} />
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", color: "#f5f5f5" }}>
              <span style={{ fontSize: 14 }}>{opened.caption || "Без подписи"} · {opened.added_by_name}</span>
              <span style={{ flex: 1 }} />
              {opened.can_delete && (
                <>
                  <button type="button" style={tabButton(false)} onClick={() => void editCaption(opened)}>
                    Изменить подпись
                  </button>
                  <button type="button" style={{ ...tabButton(false), color: "#ff8a8a" }} onClick={() => void removePhoto(opened)}>
                    Удалить
                  </button>
                </>
              )}
              <button type="button" style={tabButton(false)} onClick={() => setOpened(null)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function BigPhoto({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadGalleryPhoto(id).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return src ? (
    <img src={src} alt="" style={{ maxWidth: "100%", maxHeight: "75vh", objectFit: "contain", borderRadius: 8 }} />
  ) : (
    <div style={{ width: 300, height: 200, background: "#0b1420", borderRadius: 8 }} />
  );
}

function PhotoCard({
  photo,
  canManage,
  onOpen,
  onDelete,
}: {
  photo: Photo;
  canManage: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadGalleryPhoto(photo.id).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [photo.id]);
  return (
    <div style={{ ...card, marginBottom: 0, padding: 8 }}>
      <div onClick={onOpen} style={{ cursor: "pointer", aspectRatio: "1 / 1", background: "#0b1420", borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {src ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      </div>
      <div style={{ fontSize: 13, marginTop: 6, overflowWrap: "anywhere" }}>{photo.caption || "Без подписи"}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 12, color: colors.gray }}>{photo.added_by_name}</span>
        {canManage && (
          <button type="button" onClick={onDelete} style={{ background: "none", border: "none", color: "#ff8a8a", cursor: "pointer", fontSize: 13 }}>
            Удалить
          </button>
        )}
      </div>
    </div>
  );
}

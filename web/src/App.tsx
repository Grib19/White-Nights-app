import { FormEvent, useEffect, useState } from "react";
import { COMMITTEE_ROLES, User, clearImageCache, getToken, request, roleLabel, setToken } from "./api";
import { button, card, colors, input, page, tabButton, tabs } from "./styles";
import { Logo } from "./Logo";
import { ProfilePage } from "./pages/ProfilePage";
import { MembersPage } from "./pages/MembersPage";
import { InfoPage } from "./pages/InfoPage";
import { MusicPage } from "./pages/MusicPage";
import { FeedPage } from "./pages/FeedPage";
import { ChatsPage } from "./pages/ChatsPage";
import { TabIcon } from "./TabIcon";

type Mode = "login" | "register";
type Tab = "profile" | "feed" | "chats" | "members" | "info" | "music" | "committee";

type Pending = User;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("feed");
  const [mode, setMode] = useState<Mode>("login");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // На широком экране меню слева (как во ВКонтакте), на телефоне — полоской сверху
  const [wide, setWide] = useState(() => window.innerWidth >= 760);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 760);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isCommittee = !!user && user.status === "approved" && COMMITTEE_ROLES.includes(user.role);

  // Если токен сохранён, проверяем, что он ещё действует
  useEffect(() => {
    if (!getToken()) return;
    request("/api/me")
      .then(({ status, data }) => {
        if (status === 200) setUser(data.user);
        else setToken(null);
      })
      .catch(() => setMessage("Не удалось связаться с сервером"));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values = Object.fromEntries(form.entries()) as Record<string, string>;
    setBusy(true);
    setMessage("");
    try {
      if (mode === "register") {
        const { status, data } = await request("/api/register", "POST", values);
        if (status === 201) {
          setMessage("Регистрация отправлена. Комсостав подтвердит аккаунт, после этого можно войти.");
          setMode("login");
        } else setMessage(data.error ?? "Ошибка регистрации");
      } else {
        const { status, data } = await request("/api/login", "POST", values);
        if (status === 200) {
          setToken(data.token);
          setUser(data.user);
          setTab("feed");
        } else setMessage(data.error ?? "Ошибка входа");
      }
    } catch {
      setMessage("Не удалось связаться с сервером");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await request("/api/logout", "POST").catch(() => undefined);
    clearImageCache();
    setToken(null);
    setUser(null);
  }

  if (user) {
    const tabList: [Tab, string][] = [
      ["feed", "Лента"],
      ["chats", "Чаты"],
      ["profile", "Профиль"],
      ["music", "Музыка"],
      ["members", "Участники"],
      ["info", "Информация"],
    ];
    if (isCommittee) tabList.push(["committee", "Комсостав"]);

    return (
      <main style={page}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Logo height={30} />
            <div>
              <b style={{ fontSize: 18 }}>СОП "Белые Ночи"</b>
              <div style={{ fontSize: 13, color: colors.blue }}>{user.full_name} · {roleLabel(user.role)}</div>
            </div>
          </div>
          <button onClick={logout} style={{ ...tabButton(false), cursor: "pointer" }}>Выйти</button>
        </header>

        <div style={wide ? { display: "flex", gap: 20, alignItems: "flex-start" } : undefined}>
          <nav
            style={
              wide
                ? { width: 220, flexShrink: 0, position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 8 }
                : tabs
            }
          >
            {tabList.map(([key, label]) => (
              <button
                key={key}
                className="nav-tab"
                onClick={() => setTab(key)}
                disabled={tab === key}
                style={
                  wide
                    ? { ...tabButton(tab === key), width: "100%", textAlign: "left", fontSize: 16, padding: "10px 14px" }
                    : tabButton(tab === key)
                }
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <TabIcon name={key} color={tab === key ? colors.navy : colors.white} />
                  {label}
                </span>
              </button>
            ))}
          </nav>

          <div style={{ flex: 1, minWidth: 0 }}>
            {tab === "feed" && <FeedPage viewer={user} />}
            {tab === "chats" && <ChatsPage viewer={user} />}
            {tab === "profile" && <ProfilePage user={user} />}
            {tab === "members" && <MembersPage viewer={user} />}
            {tab === "info" && <InfoPage viewer={user} />}
            {tab === "music" && <MusicPage viewer={user} />}
            {tab === "committee" && isCommittee && <CommitteePage />}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={page}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "24px 0 8px" }}>
        <Logo height={56} />
        <div>
          <h1 style={{ margin: 0, fontSize: 40 }}>Белые Ночи</h1>
          <div style={{ color: colors.blue, fontSize: 16 }}>СОП "Белые Ночи" · вход в приложение</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <button style={tabButton(mode === "login")} onClick={() => setMode("login")} disabled={mode === "login"}>Вход</button>
        <button style={tabButton(mode === "register")} onClick={() => setMode("register")} disabled={mode === "register"}>Регистрация</button>
      </div>
      <div style={card}>

      <form onSubmit={submit}>
        {mode === "register" && (
          <>
            <label>ФИО<input style={input} name="full_name" required /></label>
            <label>Телефон<input style={input} name="phone" type="tel" required /></label>
            <label>Дата рождения<input style={input} name="birth_date" type="date" required /></label>
          </>
        )}
        <label>Почта<input style={input} name="email" type="email" required /></label>
        <label>
          Пароль (не короче 8 символов)
          <input style={input} name="password" type="password" minLength={8} required />
        </label>
        <button style={button} type="submit" disabled={busy}>
          {mode === "login" ? "Войти" : "Зарегистрироваться"}
        </button>
      </form>
      {message && <p>{message}</p>}
      </div>
    </main>
  );
}

// Список заявок на подтверждение (только для комсостава)
function CommitteePage() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const { status, data } = await request("/api/admin/pending");
    if (status === 200) setPending(data.users);
    else setMessage(data.error ?? "Не удалось загрузить список");
  }

  useEffect(() => {
    load();
  }, []);

  async function decide(id: number, action: "approve" | "reject", role = "candidate") {
    const { status, data } = await request(`/api/admin/users/${id}/${action}`, "POST", { role });
    if (status === 200) await load();
    else setMessage(data.error ?? "Не удалось выполнить действие");
  }

  return (
    <section>
      <h2>Ждут подтверждения ({pending.length})</h2>
      {pending.length === 0 && <p>Новых заявок нет.</p>}
      {pending.map((p) => (
        <PendingCard key={p.id} user={p} onDecide={decide} />
      ))}
      {message && <p>{message}</p>}
      <ImportantAccess />
    </section>
  );
}

function PendingCard({
  user,
  onDecide,
}: {
  user: User;
  onDecide: (id: number, action: "approve" | "reject", role?: string) => void;
}) {
  const [role, setRole] = useState("candidate");
  return (
    <div style={card}>
      <div><b>{user.full_name}</b></div>
      <div>{user.email}</div>
      <div>{user.phone}</div>
      <label>
        Роль
        <select style={input} value={role} onChange={(e) => setRole(e.target.value)}>
          {["candidate", "fighter", "master", "commissar", "commander"].map((r) => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={button} onClick={() => onDecide(user.id, "approve", role)}>Подтвердить</button>
        <button style={button} onClick={() => onDecide(user.id, "reject")}>Отклонить</button>
      </div>
    </div>
  );
}

// Право писать в «Важное»: выдаёт комсостав. Комсостав пишет туда всегда.
function ImportantAccess() {
  const [members, setMembers] = useState<{ id: number; full_name: string; role: string; can_post_important: number }[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const { status, data } = await request("/api/admin/members");
    if (status === 200) setMembers(data.members ?? []);
    else setMessage(data.error ?? "Не удалось загрузить список");
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(id: number, allow: boolean) {
    const { status, data } = await request(`/api/admin/users/${id}/important`, "POST", { allow });
    if (status === 200) await load();
    else setMessage(data.error ?? "Не удалось сохранить");
  }

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>Право писать в «Важное»</h3>
      <p style={{ color: colors.gray, fontSize: 14, marginTop: 0 }}>
        Комсостав пишет в «Важное» всегда. Отметьте участников, которым тоже можно писать.
      </p>
      {members.map((m) => (
        <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
          <input type="checkbox" checked={!!m.can_post_important} onChange={(e) => toggle(m.id, e.target.checked)} />
          <span>{m.full_name}</span>
          <span style={{ color: colors.gray, fontSize: 13 }}>{roleLabel(m.role)}</span>
        </label>
      ))}
      {message && <p>{message}</p>}
    </div>
  );
}

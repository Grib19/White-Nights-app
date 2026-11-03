import { FormEvent, useEffect, useState } from "react";
import { COMMITTEE_ROLES, User, getToken, request, roleLabel, setToken } from "./api";
import { button, card, colors, input, page, tabButton, tabs } from "./styles";
import { Logo } from "./Logo";
import { ProfilePage } from "./pages/ProfilePage";
import { MembersPage } from "./pages/MembersPage";
import { InfoPage } from "./pages/InfoPage";

type Mode = "login" | "register";
type Tab = "profile" | "members" | "info" | "committee";

type Pending = User;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("profile");
  const [mode, setMode] = useState<Mode>("login");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

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
          setTab("profile");
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
    setToken(null);
    setUser(null);
  }

  if (user) {
    const tabList: [Tab, string][] = [
      ["profile", "Профиль"],
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

        <nav style={tabs}>
          {tabList.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              disabled={tab === key}
              style={tabButton(tab === key)}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "profile" && <ProfilePage user={user} />}
        {tab === "members" && <MembersPage viewer={user} />}
        {tab === "info" && <InfoPage viewer={user} />}
        {tab === "committee" && isCommittee && <CommitteePage />}
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

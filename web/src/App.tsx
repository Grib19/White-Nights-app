import { FormEvent, useEffect, useState } from "react";
import { COMMITTEE_ROLES, ROLES, User, getToken, request, setToken } from "./api";

type Mode = "login" | "register";

const page: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 420,
  margin: "0 auto",
  padding: 16,
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 10,
  margin: "6px 0 12px",
  fontSize: 16,
};
const button: React.CSSProperties = {
  width: "100%",
  padding: 12,
  fontSize: 16,
  cursor: "pointer",
};
const card: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [pending, setPending] = useState<User[]>([]);
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

  async function loadPending() {
    const { status, data } = await request("/api/admin/pending");
    if (status === 200) setPending(data.users);
    else setMessage(data.error ?? "Не удалось загрузить список");
  }

  useEffect(() => {
    if (isCommittee) loadPending().catch(() => setMessage("Не удалось связаться с сервером"));
  }, [isCommittee]);

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
        } else {
          setMessage(data.error ?? "Ошибка регистрации");
        }
      } else {
        const { status, data } = await request("/api/login", "POST", values);
        if (status === 200) {
          setToken(data.token);
          setUser(data.user);
        } else {
          setMessage(data.error ?? "Ошибка входа");
        }
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
    setPending([]);
  }

  async function decide(id: number, action: "approve" | "reject", role = "candidate") {
    const { status, data } = await request(`/api/admin/users/${id}/${action}`, "POST", { role });
    if (status === 200) await loadPending();
    else setMessage(data.error ?? "Не удалось выполнить действие");
  }

  // Экран после входа
  if (user) {
    return (
      <main style={page}>
        <h1>White Nights</h1>
        <div style={card}>
          <div><b>{user.full_name}</b></div>
          <div>Роль: {ROLES.find((r) => r.value === user.role)?.label ?? user.role}</div>
          <div>Почта: {user.email}</div>
          <button style={{ ...button, marginTop: 8 }} onClick={logout}>Выйти</button>
        </div>

        {isCommittee && (
          <section>
            <h2>Ждут подтверждения ({pending.length})</h2>
            {pending.length === 0 && <p>Новых заявок нет.</p>}
            {pending.map((p) => (
              <PendingCard key={p.id} user={p} onDecide={decide} />
            ))}
          </section>
        )}
        {message && <p>{message}</p>}
      </main>
    );
  }

  // Экран входа и регистрации
  return (
    <main style={page}>
      <h1>White Nights</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button style={button} onClick={() => setMode("login")} disabled={mode === "login"}>
          Вход
        </button>
        <button style={button} onClick={() => setMode("register")} disabled={mode === "register"}>
          Регистрация
        </button>
      </div>

      <form onSubmit={submit}>
        {mode === "register" && (
          <>
            <label>ФИО<input style={input} name="full_name" required /></label>
            <label>Телефон<input style={input} name="phone" type="tel" required /></label>
          </>
        )}
        <label>Почта<input style={input} name="email" type="email" required /></label>
        <label>Пароль (не короче 8 символов)
          <input style={input} name="password" type="password" minLength={8} required />
        </label>
        <button style={button} type="submit" disabled={busy}>
          {mode === "login" ? "Войти" : "Зарегистрироваться"}
        </button>
      </form>
      {message && <p>{message}</p>}
    </main>
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
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
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

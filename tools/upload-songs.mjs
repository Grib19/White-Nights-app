// Загрузка песен отряда в раздел «Музыка» приложения «Белые Ночи».
// Нужен вход аккаунта с ролью комсостава (мастер, комиссар или командир):
// загружать и удалять песни может только комсостав.
//
// Проверка без загрузки (ничего не отправляет):
//   node tools/upload-songs.mjs
//
// Загрузка:
//   node tools/upload-songs.mjs --apply --email "почта" --password "пароль"
//   WN_EMAIL=... WN_PASSWORD=... node tools/upload-songs.mjs --apply
//
// Параметры:
//   --apply           действительно загружать (без него — только показать план)
//   --email, --password   данные для входа
//   --dir ПАПКА       папка с песнями (по умолчанию ../песни рядом с проектом)
//   --api URL         адрес API (по умолчанию боевой)
//   --only ТЕКСТ      загрузить только файлы, в имени которых есть ТЕКСТ
//
// Название и автор берутся из tools/songs.json (если файл есть) или из имени файла.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const API = (arg("api") || process.env.WN_API || "https://white-nights-api.white-nights.workers.dev").replace(/\/+$/, "");
const DIR = path.resolve(arg("dir") || process.env.WN_SONGS_DIR || path.join(here, "..", "..", "песни"));
const EMAIL = arg("email") || process.env.WN_EMAIL || "";
const PASSWORD = arg("password") || process.env.WN_PASSWORD || "";
const APPLY = flag("apply");
const ONLY = (arg("only") || "").toLowerCase();
const MANIFEST = path.join(here, "songs.json");
const MAX_BYTES = 20 * 1024 * 1024;

const MIME = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

// 'Горизонт' → «Горизонт»
function quotes(text) {
  return text.replace(/'([^']+)'/g, "«$1»");
}

// «Автор - Название.mp3» → { author, title }
function parseName(file) {
  const base = file.replace(/\.[^.]+$/, "").replace(/\s+$/, "");
  const dash = base.indexOf(" - ");
  if (dash <= 0) return { author: "", title: quotes(base) };
  return { author: quotes(base.slice(0, dash).trim()), title: quotes(base.slice(dash + 3).trim()) };
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

async function api(pathname, options = {}) {
  const res = await fetch(API + pathname, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

async function main() {
  const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : {};
  const all = (await readdir(DIR, { withFileTypes: true }))
    .filter((e) => e.isFile() && MIME[path.extname(e.name).toLowerCase()])
    .map((e) => e.name)
    .filter((name) => !ONLY || name.toLowerCase().includes(ONLY))
    .sort((a, b) => a.localeCompare(b, "ru"));

  if (all.length === 0) {
    console.log(`В папке ${DIR} нет аудиофайлов (mp3, m4a, wav, ogg).`);
    process.exit(1);
  }

  const planned = [];
  for (const file of all) {
    const full = path.join(DIR, file);
    const size = (await stat(full)).size;
    const meta = manifest[file] ?? parseName(file);
    const title = String(meta.title ?? "").trim() || parseName(file).title;
    const author = String(meta.author ?? "").trim();
    planned.push({ file, full, size, title, author });
  }

  console.log(`API:  ${API}`);
  console.log(`Папка: ${DIR}`);
  console.log(`Найдено песен: ${planned.length}\n`);

  let bad = 0;
  for (const [i, p] of planned.entries()) {
    const warn = p.size > MAX_BYTES ? "  ← больше 20 МБ, сервер откажет" : "";
    if (p.size > MAX_BYTES) bad++;
    console.log(`${String(i + 1).padStart(2)}. ${p.author || "—"} — ${p.title}  (${human(p.size)})${warn}`);
    console.log(`    файл: ${p.file}`);
  }

  if (bad > 0) {
    console.log(`\nОстановлено: ${bad} файл(ов) больше 20 МБ. Уменьшите их или загрузите через приложение.`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nЭто проверка: ничего не загружено. Для загрузки добавьте --apply и данные входа.");
    console.log("Название и автора можно поправить в tools/songs.json и запустить снова.");
    return;
  }

  if (!EMAIL || !PASSWORD) {
    console.log("\nНе хватает данных входа: --email и --password (или WN_EMAIL, WN_PASSWORD).");
    process.exit(1);
  }

  const login = await api("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (login.status !== 200 || !login.data.token) {
    console.log(`\nНе удалось войти: ${login.data.error ?? login.status}`);
    if (login.status === 403) console.log("Аккаунт ещё не подтверждён комсоставом.");
    process.exit(1);
  }
  const token = login.data.token;
  const user = login.data.user ?? {};
  console.log(`\nВход выполнен: ${user.full_name ?? EMAIL} (${user.role ?? "?"}).`);

  const existing = await api("/api/songs", { headers: { authorization: `Bearer ${token}` } });
  if (existing.status !== 200) {
    console.log(`\nНе удалось получить список песен: ${existing.data.error ?? existing.status}`);
    process.exit(1);
  }
  const known = new Set(
    (existing.data.songs ?? []).map((s) => `${String(s.title).trim().toLowerCase()}|${String(s.author ?? "").trim().toLowerCase()}`),
  );

  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of planned) {
    const key = `${p.title.toLowerCase()}|${p.author.toLowerCase()}`;
    if (known.has(key)) {
      console.log(`= уже есть: ${p.author || "—"} — ${p.title}`);
      skipped++;
      continue;
    }
    const type = MIME[path.extname(p.file).toLowerCase()] ?? "audio/mpeg";
    const res = await api("/api/songs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": type,
        "x-song-title": encodeURIComponent(p.title),
        "x-song-author": encodeURIComponent(p.author),
      },
      body: await readFile(p.full),
    });
    if (res.status === 201) {
      console.log(`+ загружено: ${p.author || "—"} — ${p.title}`);
      known.add(key);
      added++;
    } else {
      console.log(`! ошибка: ${p.author || "—"} — ${p.title}: ${res.data.error ?? res.status}`);
      failed++;
    }
  }

  console.log(`\nИтого: загружено ${added}, уже было ${skipped}, ошибок ${failed}.`);
  if (failed > 0) process.exit(1);
}

await main();

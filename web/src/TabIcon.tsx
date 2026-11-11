// Белые контурные значки для вкладок.
import type { ReactElement } from "react";

const paths: Record<string, ReactElement> = {
  // Важное: восклицательный знак в круге
  important: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.3v.2" />
    </>
  ),
  // Посты: облачко сообщения
  posts: (
    <>
      <path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5z" />
    </>
  ),
  // Чаты: два облачка
  chats: (
    <>
      <path d="M4 5.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 2.5V14.5H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5z" />
      <path d="M18 9.5h1.5A1.5 1.5 0 0 1 21 11v5.5a1.5 1.5 0 0 1-1.5 1.5H18v2.5l-3.5-2.5H13" />
    </>
  ),
  // Комментарии: облачко с тремя точками
  comment: (
    <>
      <path d="M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9.5l-4.5 3v-3h-1A1.5 1.5 0 0 1 3 16V8a1.5 1.5 0 0 1 1.5-1.5z" />
      <circle cx="8" cy="12" r="0.9" fill="currentColor" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
      <circle cx="16" cy="12" r="0.9" fill="currentColor" />
    </>
  ),
  // Задачи: квадрат с галочкой
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12l2.5 2.5L16 9" />
    </>
  ),
  // Лента: лист с текстом
  feed: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </>
  ),
  // Профиль: человек
  profile: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5" />
    </>
  ),
  // Музыка: нота
  music: (
    <>
      <path d="M9 17.5V6l10-2v11.5" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </>
  ),
  // Участники: два человека
  members: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 20c.9-2.9 3-4.3 5.5-4.3s4.6 1.4 5.5 4.3" />
      <path d="M15.5 5.8a3 3 0 0 1 0 5.7M17.5 15.8c1.6.5 2.7 1.8 3 4.2" />
    </>
  ),
  // Информация: открытая книга
  info: (
    <>
      <path d="M12 6.5C9.5 5 6.5 4.8 3.5 5.5v13c3-.7 6-.5 8.5 1 2.5-1.5 5.5-1.7 8.5-1v-13c-3-.7-6-.5-8.5 1z" />
      <path d="M12 6.5v13" />
    </>
  ),
  // Комсостав: командир сверху, комиссар справа внизу, мастер слева внизу
  committee: (
    <>
      <path d="M12 3.2l1.1 2.3 2.5.3-1.8 1.7.5 2.5-2.3-1.2-2.3 1.2.5-2.5-1.8-1.7 2.5-.3z" />
      <path d="M16.5 12.2c1.8 1.7 2.7 3 2.7 4.4a2.7 2.7 0 0 1-5.4 0c0-1.4.9-2.7 2.7-4.4z" />
      <path d="M5 12.5l4.5 4.5M9.5 12.5L5 17" />
    </>
  ),
};

export function TabIcon({ name, color = "#FFFFFF" }: { name: string; color?: string }) {
  return (
    <svg
      aria-hidden="true"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {paths[name]}
    </svg>
  );
}

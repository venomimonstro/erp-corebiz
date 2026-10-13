"use client";

const items = [
  { key: "overview", href: "/app/dance", label: "Обзор", hint: "Деньги и контроль" },
  { key: "groups", href: "/app/dance/groups", label: "Расписание", hint: "Группы и занятия" },
  { key: "students", href: "/app/dance/students", label: "Ученики", hint: "Семьи и оплаты" },
  { key: "clients", href: "/app/dance/clients", label: "Кабинеты", hint: "Доступ родителей" },
  { key: "budget", href: "/app/dance/budget", label: "Бюджет", hint: "План и сезонность" },
  { key: "staff", href: "/app/dance/staff", label: "Тренеры", hint: "Нагрузка и кадры" },
  { key: "team", href: "/app/dance/team", label: "Команда и залы", hint: "Тренеры, аренда, ресурсы" },
  { key: "setup", href: "/app/dance/setup", label: "Настройка", hint: "Цены, услуги, зоны" }
] as const;

export function DanceWorkspaceNav({
  active
}: {
  active: "overview" | "groups" | "students" | "clients" | "budget" | "staff" | "team" | "setup";
}) {
  return (
    <nav className="studio-nav" aria-label="Разделы студии">
      {items.map((item) => (
        <a
          key={item.key}
          href={item.href}
          className={active === item.key ? "active" : ""}
          aria-current={active === item.key ? "page" : undefined}
        >
          <strong>{item.label}</strong>
          <span>{item.hint}</span>
        </a>
      ))}
    </nav>
  );
}

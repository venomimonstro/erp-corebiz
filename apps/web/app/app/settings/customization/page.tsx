"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Capability = {
  key: string;
  enabled: boolean;
};

type BusinessProfile = {
  profileCode: "GENERAL" | "TRADE" | "ECOMMERCE" | "SERVICE" | "WAREHOUSE_3PL";
  verticalCode?: string | null;
  verticalTitle?: string | null;
  verticalVersion?: number | null;
  appliedAt: string;
  capabilities: Capability[];
};

type BusinessVertical = {
  code: string;
  title: string;
  summary: string;
  profileCode: BusinessProfile["profileCode"];
  version: number;
  ownerQuestions: string[];
  primaryWorkspaces: string[];
};

const PROFILE_CARDS = [
  {
    code: "GENERAL",
    title: "Универсальный бизнес",
    text: "Все основные контуры доступны. Подходит, если процессы смешанные или вы пока не хотите ничего скрывать."
  },
  {
    code: "TRADE",
    title: "Торговля / опт / розница",
    text: "CRM, заказы, закупки, остатки, деньги, автоматизации и аналитика без сложного WMS."
  },
  {
    code: "ECOMMERCE",
    title: "Интернет-магазин / маркетплейсы",
    text: "Торговое ядро + каналы продаж, OMS, сайт-магазин и сквозная аналитика."
  },
  {
    code: "SERVICE",
    title: "Услуги / салон / автосервис",
    text: "CRM, задачи, запись клиентов, услуги, материалы, деньги, сайт и аналитика."
  },
  {
    code: "WAREHOUSE_3PL",
    title: "Склад / 3PL",
    text: "Операционный склад, OMS, закупки, финансы, WMS и 3PL без лишнего маркетингового интерфейса."
  }
] as const;

type Field = {
  id: string;
  entity_type: string;
  field_key: string;
  label: string;
  data_type: string;
  is_required: boolean;
};

export default function CustomizationPage() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [verticals, setVerticals] = useState<BusinessVertical[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [entityType, setEntityType] = useState("DEAL");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Capability[]>("/customization/capabilities"),
        apiRequest<BusinessProfile>("/customization/business-profile"),
        apiRequest<BusinessVertical[]>("/customization/business-verticals"),
        apiRequest<Field[]>("/customization/fields?entityType=" + encodeURIComponent(entityType))
      ]);
      setCapabilities(data[0]);
      setProfile(data[1]);
      setVerticals(data[2]);
      setFields(data[3]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить настройки");
    }
  }, [entityType]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleCapability(item: Capability) {
    setPending(true);
    try {
      await apiRequest("/customization/capabilities/" + encodeURIComponent(item.key), {
        method: "PUT",
        body: JSON.stringify({ enabled: !item.enabled })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить модуль");
    } finally {
      setPending(false);
    }
  }

  async function applyProfile(profileCode: string) {
    if (
      !window.confirm(
        "Применить этот профиль? Данные не удаляются; изменится только набор включённых рабочих модулей."
      )
    ) {
      return;
    }

    setPending(true);
    try {
      await apiRequest("/customization/business-profile", {
        method: "PUT",
        body: JSON.stringify({ profileCode })
      });
      await load();
      window.dispatchEvent(new Event("corebiz-capabilities-changed"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось применить профиль бизнеса"
      );
    } finally {
      setPending(false);
    }
  }

  async function applyVertical(verticalCode: string) {
    if (
      !window.confirm(
        "Применить шаблон этого бизнеса? Существующие данные и ваши поля не удаляются. Будут включены подходящие модули и добавлены только отсутствующие типовые поля."
      )
    ) {
      return;
    }

    setPending(true);
    try {
      const result = await apiRequest<{
        verticalTitle: string;
        createdFields: number;
      }>("/customization/business-vertical", {
        method: "PUT",
        body: JSON.stringify({ verticalCode })
      });
      await load();
      window.dispatchEvent(new Event("corebiz-capabilities-changed"));
      window.alert(
        result.verticalTitle +
          ": шаблон применён. Добавлено типовых полей: " +
          result.createdFields
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось применить шаблон бизнеса"
      );
    } finally {
      setPending(false);
    }
  }

  async function createField() {
    const label = window.prompt("Название поля");
    if (!label?.trim()) return;

    const key = window.prompt(
      "Системный ключ поля: латиница и _",
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "custom_field"
    );
    if (!key?.trim()) return;

    const type = (window.prompt(
      "Тип: TEXT, NUMBER, DATE, BOOLEAN, SELECT",
      "TEXT"
    ) ?? "TEXT").toUpperCase();

    const allowed = ["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTISELECT"];
    if (!allowed.includes(type)) {
      setError("Неизвестный тип поля");
      return;
    }

    let options: string[] | undefined;
    if (type === "SELECT" || type === "MULTISELECT") {
      const raw = window.prompt("Варианты через запятую", "");
      options = (raw ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }

    try {
      await apiRequest("/customization/fields", {
        method: "POST",
        body: JSON.stringify({
          entityType,
          fieldKey: key.trim(),
          label: label.trim(),
          dataType: type,
          options
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать поле");
    }
  }

  async function createLayout() {
    const layout = {
      sections: [
        {
          key: "main",
          title: "Основное",
          fields: fields.map((field) => field.field_key)
        }
      ]
    };

    try {
      const draft = await apiRequest<{ id: string; version: number }>(
        "/customization/layouts",
        {
          method: "POST",
          body: JSON.stringify({
            entityType,
            layout
          })
        }
      );

      if (
        window.confirm(
          "Создан layout v" + draft.version + ". Опубликовать сразу?"
        )
      ) {
        await apiRequest("/customization/layouts/" + draft.id + "/publish", {
          method: "POST"
        });
      }

      window.alert("Конфигурация формы сохранена");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить layout");
    }
  }

  async function createRole() {
    const name = window.prompt("Название новой роли");
    if (!name?.trim()) return;

    try {
      const role = await apiRequest<{ id: string; name: string }>(
        "/customization/roles",
        {
          method: "POST",
          body: JSON.stringify({ name: name.trim() })
        }
      );

      window.alert(
        "Создана роль " +
          role.name +
          ". Права можно назначать через Role Editor API."
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать роль");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="customization" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Настройки / Clean Core</p>
            <h1>Настройка системы</h1>
            <p className="workspace-summary">
              Меняйте конфигурацию, не переписывая бизнес-ядро и ledger.
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createRole()} type="button">
              + Роль
            </button>
            <button onClick={() => void createLayout()} type="button">
              Сохранить layout
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Первый день / Business preset</p>
              <h2>Как работает ваша компания</h2>
              <p className="workspace-summary">
                Это не отдельные версии программы. Профиль только включает нужные рабочие контуры единого Business OS.
              </p>
            </div>
          </div>

          <div className="profile-preset-grid">
            {PROFILE_CARDS.map((item) => (
              <button
                key={item.code}
                className={
                  profile?.profileCode === item.code
                    ? "profile-preset-card active"
                    : "profile-preset-card"
                }
                disabled={pending}
                onClick={() => void applyProfile(item.code)}
                type="button"
              >
                <span className="status-pill">
                  {profile?.profileCode === item.code ? "Активен" : "Выбрать"}
                </span>
                <strong>{item.title}</strong>
                <p>{item.text}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Отраслевой шаблон / без форка Core</p>
              <h2>Какой у вас бизнес</h2>
              <p className="workspace-summary">
                Выберите ближайший сценарий. Система подстроит стартовую конфигурацию,
                но останется единым продуктом и продолжит получать общие обновления.
              </p>
            </div>
          </div>

          <div className="profile-preset-grid">
            {verticals.map((item) => (
              <button
                key={item.code}
                className={
                  profile?.verticalCode === item.code
                    ? "profile-preset-card active"
                    : "profile-preset-card"
                }
                disabled={pending}
                onClick={() => void applyVertical(item.code)}
                type="button"
              >
                <span className="status-pill">
                  {profile?.verticalCode === item.code ? "Активен" : item.profileCode}
                </span>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
                <small>
                  Главные зоны: {item.primaryWorkspaces.join(" · ")}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Capability toggles</p>
              <h2>Модули компании</h2>
            </div>
          </div>

          <div className="capability-grid">
            {capabilities.map((item) => (
              <button
                className={item.enabled ? "capability-card enabled" : "capability-card"}
                disabled={pending}
                key={item.key}
                onClick={() => void toggleCapability(item)}
                type="button"
              >
                <strong>{item.key}</strong>
                <span>{item.enabled ? "Включён" : "Выключен"}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card customization-fields">
          <div className="section-heading">
            <div>
              <p className="muted">Custom fields</p>
              <h2>Поля сущности</h2>
            </div>

            <div className="header-actions">
              <select
                onChange={(event) => setEntityType(event.target.value)}
                value={entityType}
              >
                <option value="DEAL">Сделка</option>
                <option value="PARTY">Клиент/контрагент</option>
                <option value="PRODUCT">Товар</option>
                <option value="SALES_ORDER">Заказ</option>
                <option value="PURCHASE_ORDER">Закупка</option>
              </select>
              <button onClick={() => void createField()} type="button">
                + Поле
              </button>
            </div>
          </div>

          <div className="custom-field-list">
            {fields.map((field) => (
              <article key={field.id}>
                <div>
                  <strong>{field.label}</strong>
                  <span>{field.field_key}</span>
                </div>
                <span className="status-pill">{field.data_type}</span>
              </article>
            ))}

            {!fields.length ? (
              <div className="table-empty">
                <strong>Дополнительных полей нет</strong>
                <span>Core-поля остаются неизменяемыми.</span>
              </div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}

"use client";

import {
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Deal = {
  id: string;
  title: string;
  amountMinor: string;
  currency: string;
  partyName: string | null;
  responsibleMembershipId: string | null;
  version: number;
  hasNextAction: boolean;
  overdueTasks: number;
};

type Stage = {
  id: string;
  name: string;
  kind: "NORMAL" | "WON" | "LOST";
  position: number;
  probability: number | null;
  color: string | null;
  deals: Deal[];
};

type Pipeline={id:string;name:string;is_default:boolean};
type Board = {
  pipeline: { id: string; name: string };
  stages: Stage[];
};

type DragPayload = {
  dealId: string;
  version: number;
};

function formatMoney(amountMinor: string, currency: string): string {
  const amount = Number(amountMinor) / 100;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(amount);
}

export default function DealsPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState<string | null>(null);
  const [pipelines,setPipelines]=useState<Pipeline[]>([]);
  const [pipelineId,setPipelineId]=useState("");
  const [filter,setFilter]=useState("");
  const [onlyNeedsAction,setOnlyNeedsAction]=useState(false);
  const [actionDeal,setActionDeal]=useState<Deal|null>(null);
  const [actionTitle,setActionTitle]=useState("");
  const [actionDue,setActionDue]=useState("");
  const [actionKey,setActionKey]=useState("");
  const [savingAction,setSavingAction]=useState(false);
  const [notice,setNotice]=useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await apiRequest<Board>(
        "/crm/board"+(pipelineId?"?pipelineId="+encodeURIComponent(pipelineId):""));
      setBoard(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить CRM");
    } finally {
      setLoading(false);
    }
  }, [pipelineId]);

  useEffect(()=>{
    void apiRequest<Pipeline[]>("/crm/pipelines")
      .then(setPipelines).catch(()=>setPipelines([]));
  },[]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") !== "1") return;

    params.delete("create");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? "?" + next : "")
    );
    void quickCreate();
  }, []);

  async function createPipeline(){
    const name=window.prompt("Название новой воронки");
    if(!name?.trim())return;
    try{
      const result=await apiRequest<{id:string}>("/crm/pipelines",{
        method:"POST",body:JSON.stringify({name:name.trim()})
      });
      const list=await apiRequest<Pipeline[]>("/crm/pipelines");
      setPipelines(list);setPipelineId(result.id);
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось создать воронку");}
  }

  function openNextAction(deal:Deal){
    setActionDeal(deal);setActionTitle("Связаться с клиентом");
    const date=new Date(Date.now()+86400000);
    setActionDue(
      new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)
    );
    setActionKey(typeof crypto!=="undefined"&&crypto.randomUUID?
      crypto.randomUUID():String(Date.now())+"-next-action");
  }
  async function saveNextAction(){
    if(!actionDeal||!actionTitle.trim()||!actionDue)return;
    const date=new Date(actionDue);
    if(!Number.isFinite(date.getTime())){setError("Некорректный срок задачи");return;}
    setSavingAction(true);setError("");
    try{
      await apiRequest("/crm/deals/"+actionDeal.id+"/next-action",{
        method:"POST",body:JSON.stringify({
          title:actionTitle.trim(),dueAt:date.toISOString(),idempotencyKey:actionKey
        })
      });
      setNotice("Задача поставлена, ответственный назначен.");
      setActionDeal(null);await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Задача не сохранена");}
    finally{setSavingAction(false);}
  }

  const visibleStages=useMemo(()=>board?.stages.map(stage=>({
    ...stage,
    deals:stage.deals.filter(deal=>{
      if(onlyNeedsAction && deal.hasNextAction && deal.overdueTasks===0)return false;
      const term=filter.trim().toLowerCase();
      return !term || deal.title.toLowerCase().includes(term) ||
        (deal.partyName??"").toLowerCase().includes(term);
    })
  }))??[],[board,filter,onlyNeedsAction]);

  const totals = useMemo(() => {
    if (!board) return { deals: 0, amountMinor: 0, forecastMinor: 0, needsAction: 0 };
    return visibleStages.reduce(
      (acc, stage) => {
        acc.deals += stage.deals.length;
        acc.needsAction += stage.deals.filter(d=>
          !d.hasNextAction || d.overdueTasks>0).length;
        acc.forecastMinor += stage.deals.reduce((sum,deal)=>
          sum+Math.round(Number(deal.amountMinor)*
            (stage.kind==="WON"?1:stage.kind==="LOST"?0:
              (stage.probability??0)/100)),0);
        acc.amountMinor += stage.deals.reduce(
          (sum, deal) => sum + Number(deal.amountMinor),
          0
        );
        return acc;
      },
      { deals: 0, amountMinor: 0, forecastMinor: 0, needsAction: 0 }
    );
  }, [board, visibleStages]);

  function startDrag(event: DragEvent, deal: Deal) {
    const payload: DragPayload = {
      dealId: deal.id,
      version: deal.version
    };
    event.dataTransfer.setData("application/json", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  }

  async function dropOnStage(event: DragEvent, stage: Stage) {
    event.preventDefault();

    const raw = event.dataTransfer.getData("application/json");
    if (!raw) return;

    const payload = JSON.parse(raw) as DragPayload;
    let lostReason: string | undefined;

    if (stage.kind === "LOST") {
      const reason = window.prompt("Почему сделка проиграна?");
      if (!reason?.trim()) return;
      lostReason = reason.trim();
    }

    setMoving(payload.dealId);
    setError("");

    try {
      await apiRequest(`/crm/deals/${payload.dealId}/stage`, {
        method: "PATCH",
        body: JSON.stringify({
          toStageId: stage.id,
          version: payload.version,
          ...(lostReason ? { lostReason } : {})
        })
      });

      if (
        stage.kind === "WON" &&
        window.confirm("Сделка успешна. Создать заказ?")
      ) {
        const order = await apiRequest<{ number: string }>(
          `/sales/orders/from-deal/${payload.dealId}`,
          {
            method: "POST",
            body: JSON.stringify({
              idempotencyKey: `deal:${payload.dealId}:order:1`
            })
          }
        );

        window.alert(`Создан заказ ${order.number}`);
      }

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось перенести сделку"
      );
      await load();
    } finally {
      setMoving(null);
    }
  }

  async function quickCreate() {
    const title = window.prompt("Название сделки");
    if (!title?.trim()) return;

    const amountRub = window.prompt("Сумма, ₽", "0") ?? "0";
    const amount = Number(amountRub.replace(",", "."));

    if (!Number.isFinite(amount) || amount < 0) {
      setError("Некорректная сумма");
      return;
    }

    try {
      await apiRequest("/crm/deals", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          amountMinor: String(Math.round(amount * 100))
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось создать сделку"
      );
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="deals" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">CRM / Продажи</p>
            <h1>{board?.pipeline.name ?? "Сделки"}</h1>
            {board ? (
              <p className="workspace-summary">
                {totals.deals} сделок · {formatMoney(String(totals.amountMinor), "RUB")} в работе
              </p>
            ) : null}
          </div>

          <div className="studio-hero-actions">
            <button className="secondary-button" type="button"
              onClick={()=>void createPipeline()}>+ Воронка</button>
            <button onClick={quickCreate} type="button">+ Сделка</button>
          </div>
        </header>

        <div className="crm-funnel-metrics">
          <article><small>Прогноз по вероятности этапов*</small>
            <strong>{formatMoney(String(totals.forecastMinor),"RUB")}</strong>
          </article>
          <article><small>Сделки без действия / с просрочкой</small>
            <strong>{totals.needsAction}</strong>
          </article>
        </div>
        <section className="crm-workspace-controls">
          <label>Воронка
            <select value={pipelineId} onChange={e=>setPipelineId(e.target.value)}>
              <option value="">Основная</option>
              {pipelines.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>Найти сделку
            <input value={filter} onChange={e=>setFilter(e.target.value)}
              placeholder="Название сделки или клиент"/>
          </label>
          <label className="crm-check">
            <input type="checkbox" checked={onlyNeedsAction}
              onChange={e=>setOnlyNeedsAction(e.target.checked)}/>
            Только без следующего действия или с просрочкой
          </label>
        </section>
        <p className="muted">*Оценочный прогноз только по загруженным карточкам
          выбранной воронки, не финансовая выручка и без учёта возвратов.</p>
        {notice?<p role="status">{notice}</p>:null}
        {actionDeal?<section className="studio-section crm-next-action">
          <h2>Следующее действие · {actionDeal.title}</h2>
          <p>Задача попадёт в общий список и историю сделки.</p>
          <div className="studio-form-grid">
            <label>Что нужно сделать
              <input value={actionTitle} onChange={e=>setActionTitle(e.target.value)}/>
            </label>
            <label>Срок
              <input type="datetime-local" value={actionDue}
                onChange={e=>setActionDue(e.target.value)}/>
            </label>
          </div>
          <div className="studio-hero-actions">
            <button type="button" disabled={savingAction||!actionTitle.trim()||!actionDue}
              onClick={()=>void saveNextAction()}>
              {savingAction?"Сохраняем…":"Назначить задачу"}
            </button>
            <button type="button" className="secondary-button"
              onClick={()=>setActionDeal(null)}>Отмена</button>
          </div>
        </section>:null}
        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="board-loading">Загружаем воронку…</div>
        ) : null}

        {!loading && board ? (
          <div className="kanban">
            {visibleStages.map((stage) => {
              const stageAmount = stage.deals.reduce(
                (sum, deal) => sum + Number(deal.amountMinor),
                0
              );

              return (
                <section
                  className="kanban-column"
                  key={stage.id}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => void dropOnStage(event, stage)}
                >
                  <header className="kanban-column-header">
                    <div>
                      <span
                        className="stage-dot"
                        style={{ background: stage.color ?? "#9ca3af" }}
                      />
                      <strong>{stage.name}</strong>
                    </div>
                    <small>
                      {stage.deals.length} · {formatMoney(String(stageAmount), "RUB")}
                    </small>
                  </header>

                  <div className="kanban-cards">
                    {stage.deals.map((deal) => (
                      <article
                        className={[
                          "deal-card",
                          moving === deal.id ? "is-moving" : ""
                        ].join(" ")}
                        draggable
                        key={deal.id}
                        onDragStart={(event) => startDrag(event, deal)}
                      >
                        <a className="deal-title-link" href={"/app/crm/deals/"+deal.id}>
  <strong>{deal.title}</strong>
</a>
                        <span className="deal-amount">
                          {formatMoney(deal.amountMinor, deal.currency)}
                        </span>
                        <span className="deal-party">
                          {deal.partyName ?? "Клиент не указан"}
                        </span>

                        <footer>
                          {stage.kind==="NORMAL"?<button type="button"
                            className="secondary-button" disabled={Boolean(moving)}
                            onClick={()=>openNextAction(deal)}>
                            + Задача
                          </button>:null}
                          {deal.overdueTasks > 0 ? (
                            <span className="deal-alert danger">
                              Просрочено: {deal.overdueTasks}
                            </span>
                          ) : !deal.hasNextAction && stage.kind === "NORMAL" ? (
                            <span className="deal-alert warning">
                              Нет следующего действия
                            </span>
                          ) : (
                            <span className="deal-alert ok">Следующее действие есть</span>
                          )}
                        </footer>
                      </article>
                    ))}

                    {stage.deals.length === 0 ? (
                      <div className="kanban-empty">Перетащите сделку сюда</div>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}

        {!loading && !board && !error ? (
          <div className="empty-state">
            <h2>Воронка пока недоступна</h2>
            <p>После настройки компании здесь появятся сделки.</p>
          </div>
        ) : null}
      </section>
    </main>
  );
}

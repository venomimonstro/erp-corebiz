"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Check={id:string;label:string;observed:number;target:number;
  href:string;fix:string;importance:"blocker"|"warning";ok:boolean};
type Doctor={scenario:string;checks:Check[];blockers:Check[];
  warnings:Check[];nextAction:Check|null;operationalSetupComplete:boolean;
  commercialReady:false;externalGates:string[];disclaimer:string};
export default function DanceSetupDiagnostics(){
  const [diagnostic,setDiagnostic]=useState<Doctor|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [showDone,setShowDone]=useState(false);
  const run=useCallback(async()=>{
    setBusy(true);setError("");setDiagnostic(null);
    try{
      const result=await apiRequest<Doctor>(
        "/dance/setup-doctor?scenario=two_branch_52"
      );
      setDiagnostic(result);
    }catch(cause){
      setError(cause instanceof Error?cause.message:
        "Не удалось проверить настройки компании");
    }finally{setBusy(false);}
  },[]);
  useEffect(()=>{void run();},[run]);
  const visible=diagnostic?.checks.filter(c=>showDone||!c.ok)??[];
  return <main className="app-shell">
    <AppSidebar active="dance-setup"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div>
          <p className="dance-owner-kicker">Диагностика перед открытием</p>
          <h1>Почему не получается запустить студию?</h1>
          <p>Пройдём ваш сценарий: два филиала, 12 направлений,
            52 тренера, залы, абонементы, менеджеры и кабинеты родителей.</p>
        </div>
        <button type="button" disabled={busy} onClick={()=>void run()}>
          {busy?"Проверяем…":"Проверить заново"}
        </button>
      </header>
      <DanceWorkspaceNav active="doctor"/>
      {busy?<p role="status">Получаем действующие настройки с сервера…</p>:null}
      {error?<section role="alert" className="dance-customer-alert">
        <h2>Проверка не завершилась</h2>
        <p>{error}. Ранее показанные зелёные статусы сброшены.
          Это не означает, что бизнес готов к продажам.</p>
        <button type="button" onClick={()=>void run()} disabled={busy}>
          Повторить проверку
        </button>
        <p>Если проблема повторяется, продолжайте с уже созданными
          карточками: данные не нужно вводить заново. Обратитесь к
          администратору с названием неоткрывающегося раздела.</p>
      </section>:null}
      {diagnostic?<section className="dance-customer-panel">
        <h2>Состояние настройки</h2>
        <div className="dance-doctor-summary">
          <div><small>Обязательные препятствия</small>
            <strong>{diagnostic.blockers.length}</strong></div>
          <div><small>Замечания к учёту</small>
            <strong>{diagnostic.warnings.length}</strong></div>
          <div><small>Проверено шагов</small>
            <strong>{diagnostic.checks.filter(x=>x.ok).length}
              {" / "}{diagnostic.checks.length}</strong></div>
        </div>
        {diagnostic.nextAction?<section className="dance-doctor-next">
          <p>Что исправить в первую очередь</p>
          <h2>{diagnostic.nextAction.label}</h2>
          <p>{diagnostic.nextAction.fix}</p>
          <a href={diagnostic.nextAction.href} className="secondary-button">
            Перейти к исправлению →
          </a>
        </section>:<p role="status">
          Основные справочники заполнены. Это ещё не проверка денег,
          кассы и возможности коммерческого запуска.
        </p>}
        <label className="dance-doctor-toggle">
          <input type="checkbox" checked={showDone}
            onChange={event=>setShowDone(event.target.checked)}/>
          Показать уже выполненные настройки
        </label>
        <div className="dance-doctor-steps">
          {visible.map(item=><article key={item.id} className="dance-doctor-step">
            <div className="dance-doctor-header">
              <strong>{item.label}</strong>
              <span>{item.ok?"Настроено":
                item.importance==="blocker"?"Не готово":"Требует внимания"}</span>
            </div>
            <p>Есть: {item.observed}. {item.id==="reconcile"||
              item.id==="missing_resources"?"Допустимо: 0.":"Нужно: "+item.target+"."}</p>
            {!item.ok?<><p>{item.fix}</p>
              <a href={item.href}>Открыть нужный экран →</a></>:null}
          </article>)}
        </div>
        <section className="dance-doctor-external">
          <h2>Что этот экран не может подтвердить автоматически</h2>
          {diagnostic.externalGates.map(x=><p key={x}>• {x}</p>)}
          <p><strong>Коммерческая готовность: не подтверждена.</strong>
            Не принимайте реальные оплаты только на основании заполненного
            каталога или зелёного статуса расписания.</p>
        </section>
      </section>:null}
    </section>
  </main>;
}

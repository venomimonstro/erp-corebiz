"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Owner = {
  id:string;
  code:string;
  name:string;
  owner_type:"INTERNAL"|"CLIENT";
  party_name:string|null;
  status:string;
};

type Access = {
  id:string;
  owner_id:string;
  owner_code:string;
  owner_name:string;
  label:string;
  status:string;
  expires_at:string|null;
  last_used_at:string|null;
  access_count:string;
  created_at:string;
};

export default function Wms3plPortalAdminPage(){
  const [owners,setOwners]=useState<Owner[]>([]);
  const [accesses,setAccesses]=useState<Access[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState("");

  const load=useCallback(async()=>{
    try{
      const [o,a]=await Promise.all([
        apiRequest<Owner[]>("/wms/owners"),
        apiRequest<Access[]>("/wms/3pl-portal/accesses")
      ]);
      setOwners(o.filter(x=>x.owner_type==="CLIENT"&&x.status==="ACTIVE"));
      setAccesses(a);
      setError("");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить доступы");
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  async function createAccess(){
    if(!owners.length){
      setError("Нет активных 3PL-владельцев.");
      return;
    }

    const list=owners.map((o,i)=>(i+1)+". "+o.name+" · "+o.code).join("\n");
    const index=Number(window.prompt("Выберите владельца:\n"+list,"1"))-1;
    const owner=owners[index];
    if(!owner)return;

    const label=window.prompt("Название доступа","Личный кабинет клиента")??"";
    const daysRaw=window.prompt("Срок действия, дней. 0 = без срока","90")??"90";
    const days=Number(daysRaw);
    if(!Number.isFinite(days)||days<0){
      setError("Некорректный срок");
      return;
    }

    const expiresAt=days>0
      ? new Date(Date.now()+days*86400000).toISOString()
      : undefined;

    setBusy("create");
    try{
      const result=await apiRequest<{
        id:string;
        token:string;
        expiresAt:string|null;
      }>("/wms/3pl-portal/owners/"+owner.id+"/accesses",{
        method:"POST",
        body:JSON.stringify({
          label:label.trim()||"Личный кабинет клиента",
          expiresAt
        })
      });

      window.prompt(
        "Токен показывается один раз. Передайте клиенту адрес /3pl и этот токен:",
        result.token
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать доступ");
    }finally{
      setBusy("");
    }
  }

  async function revoke(access:Access){
    if(!window.confirm("Отозвать доступ для "+access.owner_name+"?"))return;
    setBusy(access.id);
    try{
      await apiRequest("/wms/3pl-portal/accesses/"+access.id+"/revoke",{
        method:"POST"
      });
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось отозвать доступ");
    }finally{
      setBusy("");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="wms-portal"/>
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">WMS / 3PL / Client Portal</p>
            <h1>Доступ клиентов 3PL</h1>
            <p className="workspace-summary">
              Отдельный read-only кабинет без доступа к внутренней ERP. Каждый токен видит ровно одного владельца товара.
            </p>
          </div>
          <button onClick={()=>void createAccess()} disabled={busy!==""}>
            + Доступ
          </button>
        </header>

        {error?<div className="inline-error"><strong>3PL Portal</strong><span>{error}</span></div>:null}

        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Владелец</th>
                <th>Доступ</th>
                <th>Статус</th>
                <th>Использование</th>
                <th>Срок</th>
                <th/>
              </tr>
            </thead>
            <tbody>
              {accesses.map(access=>(
                <tr key={access.id}>
                  <td>
                    <strong>{access.owner_name}</strong>
                    <small>{access.owner_code}</small>
                  </td>
                  <td>
                    {access.label}
                    <small>{new Date(access.created_at).toLocaleString("ru-RU")}</small>
                  </td>
                  <td><span className="status-pill">{access.status}</span></td>
                  <td>
                    {access.access_count}
                    <small>
                      {access.last_used_at
                        ? new Date(access.last_used_at).toLocaleString("ru-RU")
                        :"ещё не входил"}
                    </small>
                  </td>
                  <td>
                    {access.expires_at
                      ? new Date(access.expires_at).toLocaleDateString("ru-RU")
                      :"без срока"}
                  </td>
                  <td className="table-actions">
                    {access.status==="ACTIVE"?(
                      <button
                        className="secondary-button"
                        disabled={busy===access.id}
                        onClick={()=>void revoke(access)}
                      >
                        Отозвать
                      </button>
                    ):null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

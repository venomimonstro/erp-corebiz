"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";
type Role={id:string;code:string;name:string;permissions:Array<{code:string;scope:string}>};
type Member={membership_id:string;email:string;status:string;is_owner:boolean;
  roles:Array<{id:string;code:string;name:string}>};
type Invite={id:string;email:string;status:string;expires_at:string;
  created_at:string;role_name:string|null;role_code:string|null};
type Created={invitationId:string;expiresAt:string;oneTimeToken:string};
export default function TeamPage(){
  const [roles,setRoles]=useState<Role[]>([]);
  const [members,setMembers]=useState<Member[]>([]);
  const [invites,setInvites]=useState<Invite[]>([]);
  const [email,setEmail]=useState("");
  const [roleId,setRoleId]=useState("");
  const [link,setLink]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const load=useCallback(async()=>{
    try{
      const [staff, pending,available]=await Promise.all([
        apiRequest<Member[]>("/tenants/team"),
        apiRequest<Invite[]>("/tenants/invitations"),
        apiRequest<Role[]>("/roles")
      ]);
      setMembers(staff);setInvites(pending);setRoles(available);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Недостаточно прав для управления командой");
    }
  },[]);
  useEffect(()=>{void load();},[load]);
  async function invite(){
    if(!email.trim()||busy)return;
    setBusy(true);setError("");setLink("");setNotice("");
    try{
      const result=await apiRequest<Created>("/tenants/invite",{
        method:"POST",body:JSON.stringify({email:email.trim(),
          ...(roleId?{roleId}:{})})
      });
      // The secret is delivered ONCE to the authorized user. The fragment
      // is never sent in the HTTP request or server logs.
      setLink(window.location.origin+"/invite#token="+encodeURIComponent(result.oneTimeToken));
      setNotice("Приглашение создано, действует 7 дней. Скопируйте ссылку сейчас.");
      setEmail("");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось пригласить");}
    finally{setBusy(false);}
  }
  async function revoke(id:string){
    if(!window.confirm("Отозвать приглашение? Прежняя ссылка перестанет работать."))return;
    setBusy(true);setError("");setLink("");
    try{
      await apiRequest("/tenants/invitations/"+id+"/revoke",{method:"POST"});
      await load();setNotice("Приглашение отозвано");
    }catch(cause){setError(cause instanceof Error?cause.message:"Ошибка отзыва");}
    finally{setBusy(false);}
  }
  async function changeRole(member:Member,id:string){
    if(member.is_owner||busy)return;
    if(!window.confirm("Изменить права пользователя "+member.email+"?"))return;
    setBusy(true);setError("");
    try{
      await apiRequest("/roles/assign",{method:"PUT",
        body:JSON.stringify({membershipId:member.membership_id,roleId:id})});
      await load();setNotice("Роль сотрудника обновлена.");
    }catch(cause){setError(cause instanceof Error?cause.message:"Роль не назначена");}
    finally{setBusy(false);}
  }
  return <main className="app-shell">
    <AppSidebar active="settings"/>
    <section className="workspace workspace-wide studio-premium">
      <header className="studio-hero compact">
        <div><span className="studio-eyebrow">Управление компанией</span>
          <h1>Сотрудники и приглашения</h1>
          <p>Приглашайте управляющих, продавцов, кладовщиков и менеджеров.
            Новые сотрудники не получают роль владельца автоматически.</p>
        </div>
        <a href="/app/settings" className="secondary-button">Настройки</a>
      </header>
      {error?<p role="alert" className="inline-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <section className="studio-section">
        <h2>Пригласить сотрудника</h2>
        <div className="studio-form-grid">
          <label>Email сотрудника
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="employee@example.ru" autoComplete="email" />
          </label>
          <label>Роль после принятия приглашения
            <select value={roleId} onChange={e=>setRoleId(e.target.value)}>
              <option value="">Наблюдатель (минимальные права)</option>
              {roles.filter(r=>r.code!=="OWNER").map(r=>(
                <option value={r.id} key={r.id}>{r.name} ({r.code})</option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">Приглашение действительно 7 дней. Если выбрана роль,
          сервер проверит, что вы можете делегировать все её полномочия.</p>
        <button type="button" disabled={busy||!email.includes("@")} onClick={()=>void invite()}>
          {busy?"Создаём…":"Создать ссылку приглашения"}
        </button>
        {link?<div className="first-day-summary">
          <strong>Ссылка доступна только сейчас</strong>
          <p>Скопируйте и отправьте её сотруднику удобным способом.
            Никакая почта от сервиса автоматически не отправлена.</p>
          <input readOnly value={link} aria-label="Ссылка приглашения" />
          <button type="button" onClick={()=>void navigator.clipboard.writeText(link)}>
            Копировать ссылку
          </button>
        </div>:null}
      </section>
      <section className="studio-section">
        <h2>Сотрудники ({members.length})</h2>
        <div className="data-table-wrap">
          <table className="data-table"><thead><tr>
            <th>Сотрудник</th><th>Статус</th><th>Роль</th><th>Назначить</th>
          </tr></thead><tbody>
            {members.map(m=><tr key={m.membership_id}>
              <td>{m.email}{m.is_owner?" · владелец":""}</td>
              <td>{m.status}</td>
              <td>{m.roles.map(r=>r.name).join(", ")||"Не назначена"}</td>
              <td>{m.is_owner?"—":(
                <select disabled={busy} value={m.roles[0]?.id??""}
                  onChange={e=>void changeRole(m,e.target.value)}>
                  <option value="">Выберите роль</option>
                  {roles.filter(r=>r.code!=="OWNER").map(r=>
                    <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>)}</td>
            </tr>)}
          </tbody></table>
        </div>
      </section>
      <section className="studio-section">
        <h2>Приглашения</h2>
        <div className="data-table-wrap">
          <table className="data-table"><thead><tr>
            <th>Email</th><th>Роль</th><th>Статус</th><th>Истекает</th><th></th>
          </tr></thead><tbody>{invites.map(i=><tr key={i.id}>
            <td>{i.email}</td><td>{i.role_name??"Наблюдатель"}</td>
            <td>{i.status}</td>
            <td>{new Date(i.expires_at).toLocaleString("ru-RU")}</td>
            <td>{i.status==="PENDING"?<button type="button" className="secondary-button"
              disabled={busy} onClick={()=>void revoke(i.id)}>Отозвать</button>:null}</td>
          </tr>)}</tbody></table>
        </div>
      </section>
      <p className="muted">Ограничение: роли имеют уровни доступа
        «свои / команда / филиал / все». Для кассиров отдельной торговой
        точки потребуется дополнительная привязка сотрудника к точке.</p>
    </section>
  </main>;
}

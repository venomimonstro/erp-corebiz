"use client";
import {type FormEvent,useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Customer={id:string;displayName:string;phone?:string|null};
type TeamMember={membership_id:string;email:string;status:string;roles:Array<{code:string}>};
type Role={id:string;code:string;name:string};
type ClientAccount={membership_id:string;email:string;party_id:string;
  display_name:string;status:"ACTIVE"|"REVOKED"};
export default function DanceClientAccessPage(){
  const [members,setMembers]=useState<TeamMember[]>([]);
  const [parties,setParties]=useState<Customer[]>([]);
  const [role,setRole]=useState<Role|null>(null);
  const [accounts,setAccounts]=useState<ClientAccount[]>([]);
  const [revokeId,setRevokeId]=useState("");
  const [email,setEmail]=useState("");
  const [member,setMember]=useState("");
  const [party,setParty]=useState("");
  const [token,setToken]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const refresh=useCallback(async()=>{
    setLoading(true);setError("");
    // Stale invitees must never remain visible after a failed access check.
    setMembers([]);setParties([]);setAccounts([]);setRole(null);
    const [team,customers,roles,linked]=await Promise.allSettled([
      apiRequest<TeamMember[]>("/tenants/team"),
      apiRequest<Customer[]>("/crm/customers"),
      apiRequest<Role[]>("/roles"),
      apiRequest<ClientAccount[]>("/dance/portal/accounts")
    ]);
    const issues:string[]=[];
    if(team.status==="fulfilled")setMembers(team.value);
    else issues.push("Не загружены приглашения сотрудников — проверьте права владельца.");
    if(customers.status==="fulfilled")setParties(customers.value);
    else issues.push("CRM недоступна — сначала проверьте клиентов.");
    if(roles.status==="fulfilled"){
      const customerRole=roles.value.find(x=>x.code==="DANCE_CUSTOMER");
      setRole(customerRole??null);
      if(!customerRole)issues.push(
        "Отсутствует роль клиента. Примените миграции и проверьте каталог ролей."
      );
    }else issues.push("Не удалось проверить клиентскую роль.");
    if(linked.status==="fulfilled")setAccounts(linked.value);
    else issues.push("Список привязанных аккаунтов не проверен. Не создавайте дубли.");
    setError(issues.join(" "));
    setLoading(false);
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  const pendingInvites=members.filter(x=>x.status==="INVITED"&&
    x.roles.some(r=>r.code==="DANCE_CUSTOMER"));
  const candidates=members.filter(x=>x.status==="ACTIVE"&&
    x.roles.length===1&&x.roles[0]?.code==="DANCE_CUSTOMER");
  async function invite(e:FormEvent){
    e.preventDefault();
    if(!role||busy)return;
    setBusy(true);setError("");setToken("");setNotice("");
    try{
      const result=await apiRequest<{oneTimeToken:string}>("/tenants/invite",{
        method:"POST",body:JSON.stringify({email,roleId:role.id})
      });
      // Show invitation token once to owner; do not place in persistent storage.
      setToken(result.oneTimeToken);setNotice("Приглашение создано. Передайте ссылку клиенту лично.");
      setEmail("");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось пригласить");}
    finally{setBusy(false);}
  }
  async function bind(e:FormEvent){
    e.preventDefault();if(busy||!member||!party)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/dance/portal/link",{
        method:"POST",body:JSON.stringify({membershipId:member,partyId:party})
      });
      setNotice("Аккаунт связан с CRM-карточкой. Клиент увидит свои данные.");
      setMember("");setParty("");
    }catch(e){setError(e instanceof Error?e.message:"Привязка не удалась");}
    finally{setBusy(false);}
  }
  async function revoke(){
    if(!revokeId||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/dance/portal/accounts/"+encodeURIComponent(revokeId)+"/revoke",{
        method:"POST"
      });
      setNotice("Доступ клиента отозван. История посещений и оплат сохранена.");
      setRevokeId("");await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось отозвать доступ");}
    finally{setBusy(false);}
  }
  return <main className="app-shell">
    <AppSidebar active="dance-students"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Доступ учеников</p>
          <h1>Личный кабинет клиента</h1>
          <p>Привяжите логин родителя или ученика к существующей карточке CRM.
            Сотрудникам и клиентам назначаются разные роли.</p></div>
        <button type="button" onClick={()=>void refresh()}
          disabled={loading||busy}>Обновить</button>
      </header>
      <DanceWorkspaceNav active="clients"/>
      {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <div className="dance-client-admin-grid">
        <form className="dance-customer-panel" onSubmit={e=>void invite(e)}>
          <h2>1. Пригласить клиента</h2>
          <p>Аккаунт получает только право собственного кабинета, без CRM,
            финансов, зарплат и сведений о других клиентах.</p>
          <label>Email клиента<input type="email" required value={email}
            onChange={e=>setEmail(e.target.value)}/></label>
          <button type="submit" disabled={!role||busy||!email.trim()}>
            Создать приглашение
          </button>
          {!role?<p role="status">Нельзя отправить приглашение: роль клиента
            пока не подтверждена. Проверьте миграции и права администратора.</p>:null}
          {token?<div className="dance-customer-secret">
            <strong>Одноразовая ссылка приглашения</strong>
            <p>Скопируйте и передайте конкретному клиенту. После
              закрытия страницы ссылка здесь не сохраняется.</p>
            <input readOnly aria-label="Ссылка приглашения" value={
              typeof window==="undefined"?"":window.location.origin+"/invite#token="+
              encodeURIComponent(token)
            } onFocus={e=>e.currentTarget.select()}/>
            <button type="button" onClick={()=>setToken("")}>Скрыть ссылку</button>
          </div>:null}
        </form>
        <form className="dance-customer-panel" onSubmit={e=>void bind(e)}>
          <h2>2. Связать аккаунт с клиентом</h2>
          <p>После принятия приглашения выберите логин и карточку плательщика
            или ученика. Данные детей доступны по подтверждённым связям семьи.</p>
          <label>Подтверждённый аккаунт
            <select required value={member} onChange={e=>setMember(e.target.value)}>
              <option value="">Выберите пользователя</option>
              {candidates.map(x=><option key={x.membership_id}
                value={x.membership_id}>{x.email}</option>)}
            </select>
          </label>
          <label>Клиент CRM / плательщик
            <select required value={party} onChange={e=>setParty(e.target.value)}>
              <option value="">Выберите клиента</option>
              {parties.map(x=><option key={x.id} value={x.id}>
                {x.displayName}{x.phone?" · "+x.phone:""}</option>)}
            </select>
          </label>
          {candidates.length===0?<p role="status">Пока нет активных
            клиентских аккаунтов. Родитель должен принять приглашение
            и завершить регистрацию; затем нажмите «Обновить».</p>:null}
          {pendingInvites.length>0?<p>Приглашение ожидают:
            {" "}{pendingInvites.map(x=>x.email).join(", ")}.
            Не создавайте второе приглашение до проверки первого.</p>:null}
          {parties.length===0?<p>Нет клиентов для привязки.
            <a href="/app/dance/students"> Создайте ученика и плательщика →</a>
          </p>:null}
          <button type="submit" disabled={busy||!member||!party}>Связать</button>
          <p><a href="/portal/dance">Открыть клиентский кабинет →</a></p>
        </form>
      </div>
      <section className="dance-customer-panel">
        <h2>Привязанные клиентские аккаунты</h2>
        {accounts.length===0?<p>Пока нет активированных клиентских кабинетов.</p>:
          <div className="dance-customer-list">
            {accounts.map(a=><article key={a.membership_id}>
              <strong>{a.display_name}</strong>
              <span>{a.email} · {a.status==="ACTIVE"?"Доступен":"Отозван"}</span>
              {a.status==="ACTIVE"?(revokeId===a.membership_id?
                <div className="dance-client-revoke">
                  <p>Клиент потеряет доступ к своему кабинету сразу после
                    подтверждения. История занятий сохранится.</p>
                  <button type="button" disabled={busy}
                    onClick={()=>void revoke()}>Подтвердить отзыв доступа</button>
                  <button type="button" disabled={busy}
                    onClick={()=>setRevokeId("")}>Отмена</button>
                </div>:
                <button type="button" disabled={busy}
                  onClick={()=>setRevokeId(a.membership_id)}>
                  Отозвать доступ</button>):null}
            </article>)}
          </div>}
      </section>
      <p className="muted">При увольнении сотрудника снимайте его внутренние
        полномочия отдельно. Клиентские аккаунты не должны получать роли
        сотрудников студии.</p>
    </section>
  </main>;
}

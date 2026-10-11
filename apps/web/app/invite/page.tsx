"use client";
import {FormEvent,useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {apiRequest} from "../../lib/api";

type Me={auth:{email:string;tenantId:string}|null};
type Acceptance={tenantId:string;membershipId:string};
export default function InvitationPage(){
  const router=useRouter();
  const [token,setToken]=useState("");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [isSignedIn,setIsSignedIn]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    const hash=new URLSearchParams(window.location.hash.replace(/^#/,""));
    const fromLink=hash.get("token")||"";
    const stored=window.sessionStorage.getItem("corebiz.pending_invite")||"";
    const found=fromLink||stored;
    if(found.length>=32){
      setToken(found);
      window.sessionStorage.setItem("corebiz.pending_invite",found);
      // Remove the bearer secret from the visible address once captured.
      if(fromLink)window.history.replaceState(null,"",window.location.pathname);
    }else setError("Ссылка приглашения неполная");
    void apiRequest<Me>("/auth/me").then(d=>{
      setIsSignedIn(Boolean(d.auth));
      if(d.auth?.email)setEmail(d.auth.email);
    }).catch(()=>setIsSignedIn(false));
  },[]);

  async function accept(){
    if(!token||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const a=await apiRequest<Acceptance>("/tenants/accept-invitation",{
        method:"POST",body:JSON.stringify({token})
      });
      await apiRequest("/auth/switch-tenant",{method:"POST",
        body:JSON.stringify({membershipId:a.membershipId})});
      window.sessionStorage.removeItem("corebiz.pending_invite");
      setNotice("Приглашение принято, компания доступна.");
      router.push("/app");router.refresh();
    }catch(e){setError(e instanceof Error?e.message:"Приглашение недоступно");}
    finally{setBusy(false);}
  }

  async function register(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    if(!token||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/auth/register-invited",{method:"POST",
        body:JSON.stringify({email,password,invitationToken:token})
      });
      window.sessionStorage.removeItem("corebiz.pending_invite");
      router.push("/app");router.refresh();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось присоединиться");}
    finally{setBusy(false);}
  }
  return <main className="auth-page">
    <section className="auth-card">
      <a className="brand" href="/">CoreBiz</a>
      <h1>Приглашение в команду</h1>
      <p className="muted">Присоединитесь к существующей компании.
        Создавать новую организацию не нужно.</p>
      {error?<p role="alert" className="form-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {isSignedIn?<>
        <p>Вы вошли как <strong>{email}</strong>.
          Приглашение привязано к конкретному email: аккаунт должен совпадать.</p>
        <button type="button" disabled={busy||!token} onClick={()=>void accept()}>
          {busy?"Присоединяем…":"Принять приглашение"}
        </button>
        <p className="auth-footer">Не та почта?
          <a href="/login"> Войдите в другой аккаунт.</a>
        </p>
      </>:<>
        <form className="auth-form" onSubmit={e=>void register(e)}>
          <label>Email из приглашения
            <input type="email" required value={email}
              onChange={e=>setEmail(e.target.value)} autoComplete="email"/>
          </label>
          <label>Пароль нового сотрудника
            <input type="password" minLength={10} required value={password}
              onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/>
          </label>
          <button type="submit" disabled={busy||!token}>
            {busy?"Создаём доступ…":"Зарегистрироваться и принять"}
          </button>
        </form>
        <p className="auth-footer">
          Уже есть аккаунт? <a href="/login">Войти и принять приглашение</a>
        </p>
      </>}
      <p className="muted">Ссылка действует 7 дней и подходит только
        для адресата приглашения. При проблеме попросите владельца
        создать новую ссылку.</p>
    </section>
  </main>;
}

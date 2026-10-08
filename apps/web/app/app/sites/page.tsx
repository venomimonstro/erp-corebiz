"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Site={id:string;name:string;code:string;status:string;pages:number};
type Page={id:string;name:string;slug:string;page_type:string;published_version_id:string|null;latest_version_no:number;drafts:number};
type Block={id?:string;block_type:string;sort_order?:number;config:Record<string,unknown>};
type Editor={page:Page;version:{id:string;version_no:number;status:string;title:string;meta_description:string|null};blocks:Block[]};

const TYPES=["HERO","TEXT","IMAGE","FEATURES","CTA","FORM","BOOKING","CATALOG","PRODUCT_GRID","SPACER"];

export default function SitesPage(){
  const [sites,setSites]=useState<Site[]>([]);
  const [siteId,setSiteId]=useState("");
  const [pages,setPages]=useState<Page[]>([]);
  const [editor,setEditor]=useState<Editor|null>(null);
  const [blocks,setBlocks]=useState<Block[]>([]);
  const [error,setError]=useState("");

  const loadSites=useCallback(async()=>{
    try{
      const rows=await apiRequest<Site[]>("/sites");
      setSites(rows);
      if(!siteId&&rows[0]) setSiteId(rows[0].id);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить сайты");}
  },[siteId]);

  useEffect(()=>{void loadSites();},[loadSites]);

  useEffect(()=>{
    if(!siteId){setPages([]);return;}
    void apiRequest<Page[]>("/sites/"+siteId+"/pages")
      .then(setPages)
      .catch(e=>setError(e instanceof Error?e.message:"Не удалось загрузить страницы"));
  },[siteId]);

  async function createSite(){
    const name=window.prompt("Название сайта","Основной сайт");
    if(!name?.trim()) return;
    try{
      const created=await apiRequest<{id:string}>("/sites",{method:"POST",body:JSON.stringify({name:name.trim()})});
      await loadSites(); setSiteId(created.id);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось создать сайт");}
  }

  async function createPage(){
    if(!siteId) return;
    const name=window.prompt("Название страницы","Главная");
    if(!name?.trim()) return;
    const home=pages.length===0;
    try{
      const created=await apiRequest<{id:string}>("/sites/"+siteId+"/pages",{
        method:"POST",
        body:JSON.stringify({name:name.trim(),pageType:home?"HOME":"CONTENT"})
      });
      const rows=await apiRequest<Page[]>("/sites/"+siteId+"/pages");
      setPages(rows); await openPage(created.id);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось создать страницу");}
  }

  async function openPage(pageId:string){
    try{
      let data=await apiRequest<Editor>("/sites/pages/"+pageId+"/editor");
      if(data.version.status!=="DRAFT"){
        const draft=await apiRequest<{versionId:string}>("/sites/pages/"+pageId+"/draft",{method:"POST"});
        data=await apiRequest<Editor>("/sites/pages/"+pageId+"/editor?versionId="+draft.versionId);
      }
      setEditor(data); setBlocks(data.blocks.map(b=>({...b,config:{...b.config}})));
    }catch(e){setError(e instanceof Error?e.message:"Не удалось открыть редактор");}
  }

  function addBlock(){
    const type=(window.prompt("Тип блока: "+TYPES.join(", "),"HERO")??"").toUpperCase();
    if(!TYPES.includes(type)) return;
    const defaults:Record<string,Record<string,unknown>>={
      HERO:{heading:"Заголовок",text:"Короткое объяснение ценности",buttonLabel:"Подробнее",buttonHref:"#"},
      TEXT:{heading:"О компании",text:"Текст блока"},
      IMAGE:{src:"https://",alt:"Изображение"},
      FEATURES:{heading:"Преимущества",items:[{title:"Преимущество",text:"Описание"}]},
      CTA:{heading:"Готовы начать?",text:"Оставьте заявку",buttonLabel:"Связаться",buttonHref:"#"},
      FORM:{heading:"Оставить заявку",bindingId:""},
      BOOKING:{heading:"Записаться",bindingId:""},
      CATALOG:{heading:"Каталог",bindingId:"",limit:12},
      PRODUCT_GRID:{heading:"Товары",bindingId:"",limit:12},
      SPACER:{size:32}
    };
    setBlocks(v=>[...v,{block_type:type,config:defaults[type]??{}}]);
  }

  function updateJson(index:number,value:string){
    try{
      const parsed=JSON.parse(value);
      setBlocks(current=>current.map((b,i)=>i===index?{...b,config:parsed}:b));
      setError("");
    }catch{setError("JSON блока пока некорректен");}
  }

  async function save(){
    if(!editor) return;
    try{
      await apiRequest("/sites/pages/"+editor.page.id+"/versions/"+editor.version.id+"/blocks",{
        method:"PUT",body:JSON.stringify({blocks:blocks.map(b=>({type:b.block_type,config:b.config}))})
      });
      setEditor(await apiRequest<Editor>("/sites/pages/"+editor.page.id+"/editor?versionId="+editor.version.id));
      setError("");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить");}
  }

  async function publish(){
    if(!editor) return;
    try{
      await save();
      await apiRequest("/sites/pages/"+editor.page.id+"/versions/"+editor.version.id+"/publish",{method:"POST"});
      window.alert("Версия опубликована");
      setEditor(null);setBlocks([]);
      setPages(await apiRequest<Page[]>("/sites/"+siteId+"/pages"));
    }catch(e){setError(e instanceof Error?e.message:"Не удалось опубликовать");}
  }

  const preview=useMemo(()=>blocks,[blocks]);

  return <main className="app-shell">
    <AppSidebar active="sites"/>
    <section className="workspace">
      <header className="workspace-header">
        <div><p className="muted">Sites / Block Builder</p><h1>Сайты</h1><p className="workspace-summary">Версионируемый конструктор без произвольного JavaScript.</p></div>
        <div className="header-actions"><button className="secondary-button" onClick={()=>void createSite()}>+ Сайт</button><button onClick={()=>void createPage()} disabled={!siteId}>+ Страница</button></div>
      </header>
      {error?<div className="inline-error"><strong>Редактор</strong><span>{error}</span></div>:null}

      <div className="site-builder-layout">
        <aside className="site-list">
          <strong>Сайты</strong>
          {sites.map(s=><button key={s.id} className={siteId===s.id?"active":""} onClick={()=>{setSiteId(s.id);setEditor(null);}}>{s.name}<small>{s.pages} страниц</small></button>)}
          <strong>Страницы</strong>
          {pages.map(p=><button key={p.id} onClick={()=>void openPage(p.id)}>{p.name}<small>{p.slug} · v{p.latest_version_no}</small></button>)}
        </aside>

        <section className="site-editor">
          {editor?<><div className="site-editor-header"><div><small>{editor.version.status} · v{editor.version.version_no}</small><h2>{editor.page.name}</h2></div><div className="builder-actions"><button className="secondary-button" onClick={addBlock}>+ Блок</button><button className="secondary-button" onClick={()=>void save()}>Сохранить</button><button onClick={()=>void publish()}>Опубликовать</button></div></div>
          <div className="block-editor-list">
            {blocks.map((b,i)=><article className="block-editor" key={i}><header><strong>{i+1}. {b.block_type}</strong><div className="builder-actions">{i>0?<button className="secondary-button" onClick={()=>setBlocks(v=>{const a=[...v];[a[i-1],a[i]]=[a[i]!,a[i-1]!];return a;})}>↑</button>:null}{i<blocks.length-1?<button className="secondary-button" onClick={()=>setBlocks(v=>{const a=[...v];[a[i],a[i+1]]=[a[i+1]!,a[i]!];return a;})}>↓</button>:null}<button className="secondary-button" onClick={()=>setBlocks(v=>v.filter((_,x)=>x!==i))}>Удалить</button></div></header><textarea defaultValue={JSON.stringify(b.config,null,2)} onBlur={e=>updateJson(i,e.target.value)}/></article>)}
          </div></>:<div className="table-empty"><strong>Выберите страницу</strong><span>Откроется DRAFT-версия для редактирования.</span></div>}
        </section>

        <aside className="site-preview">
          {preview.length?preview.map((b,i)=><Preview key={i} block={b}/>):<div className="preview-placeholder">Предпросмотр появится после добавления блоков.</div>}
        </aside>
      </div>
    </section>
  </main>;
}

function Preview({block}:{block:Block}){
  const c=block.config as any;
  if(block.block_type==="HERO") return <section className="preview-block preview-hero"><h2>{c.heading}</h2><p>{c.text}</p></section>;
  if(block.block_type==="TEXT") return <section className="preview-block"><h3>{c.heading}</h3><p>{c.text}</p></section>;
  if(block.block_type==="IMAGE") return <section className="preview-block">{c.src?<img className="preview-image" src={c.src} alt={c.alt??""}/>:null}</section>;
  if(block.block_type==="FEATURES") return <section className="preview-block"><h3>{c.heading}</h3><div className="preview-features">{(c.items??[]).map((x:any,i:number)=><article key={i}><strong>{x.title}</strong><p>{x.text}</p></article>)}</div></section>;
  if(block.block_type==="CTA") return <section className="preview-block"><h3>{c.heading}</h3><p>{c.text}</p></section>;
  if(block.block_type==="SPACER") return <div style={{height:Number(c.size??32)}}/>;
  return <section className="preview-block"><div className="preview-placeholder">{block.block_type} · binding {c.bindingId||"не настроен"}</div></section>;
}

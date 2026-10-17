import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { verifyPanelToken } from "../lib/tokens.js";
import { getContext, getHistory } from "../store/redis.js";
import type { HistoryEntry, PanelData, StoredContext } from "../types.js";

/**
 * Arma el historial visible: saca la interacción en curso (ya se muestra arriba)
 * y recorta a `historyMaxItems`.
 */
function buildHistory(
  all: StoredContext[],
  currentConversationId: string,
): HistoryEntry[] {
  return all
    .filter((c) => c.conversation_id !== currentConversationId)
    .slice(0, config.historyMaxItems)
    .map((c) => ({
      conversation_id: c.conversation_id,
      summary: c.summary,
      intent: c.intent,
      fields: c.fields,
      created_at: c.created_at,
    }));
}

export async function panelRoutes(app: FastifyInstance) {
  // JSON endpoint — consumed by the panel front-end
  app.get("/api/panel-data", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.code(400).send({ error: "Missing token" });
    }

    const claims = await verifyPanelToken(token);
    if (!claims) {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }

    const [context, allHistory] = await Promise.all([
      getContext(claims.phone),
      getHistory(claims.phone),
    ]);

    // Sin contexto en curso el panel igual sirve: puede haber interacciones previas.
    if (!context) {
      const history = buildHistory(allHistory, claims.conversation_id);
      const empty: PanelData = {
        caller_number: claims.phone,
        conversation_id: claims.conversation_id,
        summary: "",
        intent: "",
        fields: {},
        created_at: "",
        history,
        history_count: history.length,
      };
      return reply.send(empty);
    }

    const history = buildHistory(allHistory, context.conversation_id);
    const data: PanelData = {
      caller_number: context.caller_number,
      conversation_id: context.conversation_id,
      summary: context.summary,
      intent: context.intent,
      fields: context.fields,
      created_at: context.created_at,
      crm: context.crm,
      history,
      history_count: history.length,
    };

    return reply.send(data);
  });

  // HTML panel — opened inside Linkus iframe via contact_url
  app.get("/panel", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.code(400).type("text/html").send("<h1>Token requerido</h1>");
    }

    const claims = await verifyPanelToken(token);
    if (!claims) {
      return reply
        .code(401)
        .type("text/html")
        .send("<h1>Token inválido o expirado</h1>");
    }

    return reply.type("text/html").send(panelHtml(token));
  });
}

function panelHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contexto de llamada</title>
<style>
  /* Direccion: "consultorio de autor" — papel calido, tinta profunda, un
     serif editorial para lo que se lee de un vistazo y terracota como unico
     acento vivo. Nada de azul-gris clinico. Sin fuentes externas a proposito:
     el panel se abre mientras suena el telefono y no puede depender de una
     descarga — toda la calidez sale de la paleta y la tipografia del sistema. */
  :root{
    --paper:#f5f0e6; --surface:#fffdf8; --ink:#20221c; --muted:#6b6456;
    --faint:#a39a87; --line:#e6dfcd;
    --teal:#3d6b5c; --teal-soft:#e4ede7;
    --rust:#bd5b34; --rust-dark:#a34c29; --rust-soft:#f6e3d6;
    --serif:ui-serif,Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif;
    --sans:"Segoe UI",system-ui,-apple-system,sans-serif;
    --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{background:var(--paper)}
  body{font-family:var(--sans);font-size:14px;color:var(--ink);
    background:var(--paper);
    background-image:radial-gradient(130% 70% at 50% -10%,#fffefa 0,transparent 62%);
    position:relative;padding:26px 16px 36px;-webkit-font-smoothing:antialiased}
  /* Grano de papel sutil, generado en linea (sin red) via feTurbulence. */
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    opacity:.05;mix-blend-mode:multiply;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
  #loading,#app{position:relative;z-index:1}
  #loading{max-width:620px;margin:0 auto}
  #app{max-width:1100px;margin:0 auto}

  .layout{max-width:620px;margin:0 auto}

  /* Encabezado editorial: una etiqueta pequena anuncia el evento, el numero
     domina en serif, el id tecnico queda discreto abajo en mono. */
  .header{padding-bottom:16px;margin-bottom:20px;position:relative}
  .header::after{content:"";position:absolute;left:0;bottom:0;width:52px;height:3px;
    border-radius:3px;background:linear-gradient(90deg,var(--rust),var(--teal))}
  .header .eyebrow{display:block;font-size:10.5px;font-weight:700;color:var(--rust);
    text-transform:uppercase;letter-spacing:.14em;margin-bottom:6px}
  .header .phone{font-family:var(--serif);font-size:29px;font-weight:600;
    letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--ink)}
  .header .conv-id{font-family:var(--mono);font-size:11px;color:var(--faint);
    margin-top:5px;word-break:break-all}

  .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:17px 19px;margin-bottom:11px;
    box-shadow:0 1px 2px rgba(32,34,28,.04),0 10px 24px -18px rgba(32,34,28,.35)}
  .card h2{font-family:var(--serif);font-size:12.5px;font-weight:600;
    font-style:italic;color:var(--teal);margin-bottom:10px;letter-spacing:.01em}
  /* El resumen es lo unico que la recepcionista lee entero: mas grande y aireado. */
  .card p{font-size:15px;line-height:1.64;color:#2a2c23}

  .intent{display:inline-block;background:var(--teal-soft);color:var(--teal);
    padding:5px 14px;border-radius:999px;font-weight:600;font-size:13px;
    box-shadow:inset 0 0 0 1px rgba(61,107,92,.18)}

  .field-grid{display:grid;grid-template-columns:auto 1fr;gap:0 16px;
    font-size:13.5px}
  .field-grid>span{padding:7px 0;border-top:1px solid var(--line)}
  .field-grid>span:nth-child(1),.field-grid>span:nth-child(2){border-top:0;padding-top:0}
  .field-key{color:var(--muted);text-transform:uppercase;font-size:10.5px;
    font-weight:700;letter-spacing:.07em;padding-top:9px;white-space:nowrap}
  .field-val{color:var(--ink)}

  .crm{border-left:3px solid var(--teal)}
  .crm-name{font-family:var(--serif);font-size:19px;font-weight:600;margin-bottom:10px}
  .crm-link{display:inline-block;margin-top:12px;font-size:13px;font-weight:600;
    color:var(--rust-dark);text-decoration:none}
  .crm-link:hover{text-decoration:underline}

  .meta{font-size:11.5px;color:var(--faint);text-align:right;padding:2px 2px 0;
    font-style:italic}
  .empty{text-align:center;padding:38px 20px}
  .empty h2{font-family:var(--serif);font-size:17px;font-style:italic;
    font-weight:600;color:var(--muted);margin-bottom:7px}
  .empty p{font-size:13.5px;color:var(--faint)}
  .error{text-align:center;padding:44px 20px;color:var(--rust-dark);font-weight:600}
  #loading{text-align:center;padding:56px;color:var(--muted);
    font-family:var(--serif);font-style:italic;font-size:15px}
  #loading::after{content:"";display:block;width:26px;height:26px;margin:16px auto 0;
    border-radius:50%;border:2.5px solid var(--line);border-top-color:var(--rust);
    animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* --- historial de interacciones previas --- */
  .hist-title{display:flex;align-items:center;gap:9px;margin:28px 0 11px;
    font-family:var(--serif);font-style:italic;font-size:13.5px;font-weight:600;
    color:var(--muted)}
  .hist-title::after{content:"";flex:1;height:1px;background:var(--line)}
  .badge{background:var(--rust);color:#fff;border-radius:999px;padding:2px 9px;
    font-size:11.5px;font-weight:700;letter-spacing:0;font-family:var(--sans);
    font-style:normal;font-variant-numeric:tabular-nums}
  .hist-item{background:var(--surface);border:1px solid var(--line);
    border-radius:12px;margin-bottom:7px;overflow:hidden;
    transition:border-color .15s,box-shadow .15s}
  .hist-item[open]{border-color:#d8cba8;box-shadow:0 3px 10px rgba(32,34,28,.07)}
  .hist-item summary{padding:12px 15px;cursor:pointer;list-style:none;
    display:flex;align-items:center;gap:11px;font-size:13px;
    transition:background .12s}
  .hist-item summary::-webkit-details-marker{display:none}
  .hist-item summary:hover{background:#faf6ec}
  .hist-item summary::before{content:"";flex-shrink:0;width:6px;height:6px;
    border-right:1.5px solid var(--faint);border-bottom:1.5px solid var(--faint);
    transform:rotate(-45deg);transition:transform .18s ease}
  .hist-item[open] summary::before{transform:rotate(45deg);
    border-color:var(--rust)}
  .hist-date{color:var(--muted);flex-shrink:0;font-family:var(--mono);
    font-size:12px;font-variant-numeric:tabular-nums}
  .hist-intent{background:var(--paper);color:var(--muted);padding:3px 9px;
    border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;max-width:55%;border:1px solid var(--line)}
  .hist-body{padding:2px 15px 15px 32px;border-top:1px solid var(--line)}
  .hist-body h3{font-size:10px;color:var(--faint);text-transform:uppercase;
    letter-spacing:.09em;font-weight:700;margin:13px 0 5px}
  .hist-body p{font-size:13.5px;line-height:1.6}
  .hist-conv{font-family:var(--mono);font-size:10.5px;color:#c2b89e;
    margin-top:12px;word-break:break-all}
  .hist-none{color:var(--faint);font-size:13.5px;padding:4px 0 8px;font-style:italic}
  /* Slide suave nativo al abrir/cerrar el acordeon, sin JS. Donde el navegador
     no soporte ::details-content todavia, se degrada al toggle instantaneo
     de siempre: nada se rompe. */
  @supports (interpolate-size:allow-keywords){
    :root{interpolate-size:allow-keywords}
    /* No se fuerza content-visibility aca: el navegador ya lo maneja solo
       segun [open] (oculto cuando cerrado, visible cuando abierto). Fijarlo
       "a mano" en la regla base lo dejaba oculto siempre, aunque la altura
       animara a auto: el acordeon nunca llegaba a mostrarse. */
    .hist-item::details-content{height:0;overflow:clip;
      transition:height .28s cubic-bezier(.4,0,.2,1),
        content-visibility .28s allow-discrete}
    .hist-item[open]::details-content{height:auto}
  }

  /* Entrada escalonada: da la sensacion de que el panel "llego", no que parpadeo. */
  .col-left>*{animation:rise .32s ease-out backwards}
  .col-left>*:nth-child(2){animation-delay:.04s}
  .col-left>*:nth-child(3){animation-delay:.08s}
  .col-left>*:nth-child(n+4){animation-delay:.12s}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;
    transition:none!important}}
</style>
</head>
<body>
<div id="loading">Cargando contexto…</div>
<div id="app" style="display:none"></div>
<script>
(async()=>{
  const app=document.getElementById("app");
  const loading=document.getElementById("loading");
  try{
    const r=await fetch("/api/panel-data?token=${token}");
    loading.style.display="none";
    app.style.display="block";
    if(!r.ok){
      app.innerHTML='<div class="error"><h2>Error</h2><p>'+r.status+'</p></div>';
      return;
    }
    const d=await r.json();
    const hist=Array.isArray(d.history)?d.history:[];
    const current=d.summary
      ? \`<div class="card"><h2>Intención</h2><span class="intent">\${esc(d.intent)}</span></div>
         <div class="card"><h2>Resumen</h2><p>\${esc(d.summary)}</p></div>
         <div class="card"><h2>Datos capturados</h2><div class="field-grid">\${fieldsHtml(d.fields)}</div></div>
         <div class="meta">Contexto creado: \${fmt(d.created_at)}</div>\`
      : \`<div class="card empty">
           <h2>Sin contexto previo</h2>
           <p>No hay información del voicebot para esta llamada.</p>
         </div>\`;
    app.innerHTML=\`
      <div class="layout">
        <div class="col-left">
          <div class="header">
            <span class="eyebrow">Llamada entrante</span>
            <div class="phone">\${esc(d.caller_number)}</div>
            <div class="conv-id">\${esc(d.conversation_id)}</div>
          </div>
          \${crmHtml(d.crm)}
          \${current}
          <div class="hist-title">
            Interacciones previas <span class="badge">\${hist.length}</span>
          </div>
          \${hist.length?hist.map(histHtml).join(""):'<div class="hist-none">Es la primera vez que llama.</div>'}
        </div>
      </div>
    \`;
  }catch(e){
    loading.style.display="none";
    app.style.display="block";
    app.innerHTML='<div class="error"><h2>Error de conexión</h2></div>';
  }
})();
function esc(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML}
function fmt(iso){
  if(!iso)return "—";
  const dt=new Date(iso);
  return isNaN(dt)?"—":dt.toLocaleString("es-AR",
    {day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});
}
function fieldsHtml(f){
  if(!f||!Object.keys(f).length)
    return '<span class="field-val" style="grid-column:span 2">—</span>';
  return Object.entries(f).map(([k,v])=>
    '<span class="field-key">'+esc(k)+'</span>'+
    '<span class="field-val">'+esc(typeof v==="object"&&v!==null?JSON.stringify(v):String(v))+'</span>'
  ).join("");
}
function crmHtml(c){
  if(!c)return "";
  const rows={Empresa:c.company,Estado:c.status,...(c.extras||{})};
  const grid=Object.entries(rows).filter(([,v])=>v).map(([k,v])=>
    '<span class="field-key">'+esc(k)+'</span><span class="field-val">'+esc(v)+'</span>'
  ).join("");
  return \`<div class="card crm">
    <h2>CRM</h2>
    <div class="crm-name">\${esc(c.name)}</div>
    \${grid?'<div class="field-grid">'+grid+'</div>':""}
    \${c.url?'<a class="crm-link" href="'+esc(c.url).replace(/"/g,"&quot;")+'" target="_blank" rel="noopener">Abrir en el CRM →</a>':""}
  </div>\`;
}
function histHtml(h){
  return \`<details class="hist-item">
    <summary>
      <span class="hist-date">\${fmt(h.created_at)}</span>
      <span class="hist-intent">\${esc(h.intent||"sin intención")}</span>
    </summary>
    <div class="hist-body">
      <h3>Resumen</h3>
      <p>\${esc(h.summary||"—")}</p>
      <h3>Datos capturados</h3>
      <div class="field-grid">\${fieldsHtml(h.fields)}</div>
      <div class="hist-conv">\${esc(h.conversation_id||"")}</div>
    </div>
  </details>\`;
}
</script>
</body>
</html>`;
}

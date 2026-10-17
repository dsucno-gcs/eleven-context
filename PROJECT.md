# GCS Context Bridge <sup style="font-size:.5em">v1.0</sup>

> ⚠️ **Este repo es un fork para Reino Cerámicos** (agente ElevenLabs `agent_3901m0dppqc8ehtafxv04kxhyapy`,
> "Aris - Reino Cerámicos"), clonado del conector original construido para INEBA. La
> arquitectura, el contrato de API y los gotchas de infraestructura de abajo siguen aplicando
> tal cual; lo que **no** aplica a este cliente (datos de ejemplo, agente/LXC/dominio/destino
> de INEBA, vocabulario médico) está marcado como TODO. Diferencia de topología clave:
> Reino Cerámicos es un **discador saliente** (ElevenLabs origina la llamada), no un flujo
> entrante como INEBA — con troncal SIP propia hacia Yeastar, el SIP REFER sigue siendo el
> mecanismo de transferencia. Ver detalle en `AGENTE-ELEVENLABS.md` §0.

> Traspaso de contexto entre un voicebot (ElevenLabs) y los agentes humanos de un call
> center sobre Yeastar P-Series. Cuando el bot deriva una llamada, el agente que la atiende
> recibe automáticamente en su pantalla el resumen de lo que el cliente venía hablando.

> **Nombre y versión:** el proyecto pasa a llamarse **GCS Context Bridge** a partir de la
> **v1.0** (29/07/2026). Esa historia de nombre es del repo original de INEBA (LXC 101,
> `/root/voicebot-context-bridge`); **este fork todavía no tiene LXC ni ruta de despliegue
> propia** — pendiente clonar el LXC de INEBA, vaciar sus datos (SQLite/Redis tienen
> historial real de pacientes, no puede viajar a otro cliente) y generar keys nuevas.

Este documento es la **fuente de verdad** del proyecto y está pensado para seguirse desde
Claude Code. Las fases al final tienen checkboxes: se van marcando a medida que se avanza.

> **Estado heredado de INEBA (29/07/2026): en ESE proyecto el flujo completo funciona de
> punta a punta.** Llamada → bot → `guardar_contexto` → SIP REFER → el interno suena →
> pop-up automático en Linkus con el contexto **y las últimas 10 interacciones previas de ese
> número**. Fases 0 a 4 cerradas para INEBA.
>
> **Para Reino Cerámicos nada de esto está verificado todavía** — LXC propio, agente,
> dirección de la llamada (saliente) y destino del REFER (queue, no interno fijo) son
> distintos, así que la Fase 4 (telefonía) hay que rehacerla de cero con una llamada real.
> Hoy sigue usando el interno de pruebas `9999` **temporalmente** (ver §9.3.1).

El stack técnico detallado (versiones, paquetes, requisitos) está en **[STACK.md](STACK.md)**.
El diagnóstico de la transferencia SIP REFER (causa raíz, arreglo y descartes) está en
**[TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md)**.
La config del agente de ElevenLabs (LLM, TTS, ASR y calidad de voz) está en
**[AGENTE-ELEVENLABS.md](AGENTE-ELEVENLABS.md)**.

---

## 1. Objetivo

Mostrar un **screen-pop** en el softphone (Linkus) del agente exacto que recibe la llamada,
alimentado con el contexto que el voicebot capturó, **en el momento** en que la llamada le
entra — sin que el agente haga nada y sin mandarle el mismo contexto a todos.

La pieza central que desarrollamos es el **Conector**: un servicio propio que recibe el
contexto del bot, lo retiene mientras el cliente espera en la cola, y se lo entrega a la
central haciéndose pasar por un CRM.

---

## 2. Topología de la llamada

```
[Cliente / PSTN]
      │  (1) llamada entrante
      ▼
 ┌─────────────┐   (2) troncal SIP saliente ─────────►  ┌──────────────────┐
 │   Yeastar   │        (pasa X-CALLER-ID)               │   ElevenLabs     │
 │  P-Series   │                                         │   (voicebot)     │
 │             │   ◄──── (3) SIP REFER (Refer-To: cola) ─┤  conversa +      │
 └─────────────┘                                         │  arma contexto   │
      │                                                   └──────────────────┘
      │                                                          │
      │  (4) Yeastar reconecta al cliente con la cola            │ (2b) POST /api/context
      ▼                                                          ▼   (número + resumen)
 [Cola → Agente]                                          ┌──────────────────┐
      │                                                    │    CONECTOR      │
      │  (5) Call Popup: GET /crm/contacts/search?phone=──►│  (lo construimos)│
      │  ◄──────────── contact + contact_url ──────────────│   + Redis (TTL)  │
      ▼                                                    └──────────────────┘
 [Panel en Linkus del agente]  ──(6) GET /panel?token=──►   (sirve el contexto)
```

**Puntos clave de esta topología:**

- La **Yeastar es la puerta de entrada y de salida**. Conoce el número real del cliente
  desde el ingreso y controla el Caller ID en cada tramo. Esto hace la correlación robusta.
- Yeastar rutea a ElevenLabs por troncal SIP y le envía el número del cliente en el header
  `X-CALLER-ID`, que en ElevenLabs queda disponible como la variable de sistema
  `system__caller_id`. Ese es el número con el que el bot cachea el contexto.
- El bot devuelve la llamada con **SIP REFER** apuntando a la cola/agente. Como Yeastar
  originó la llamada y tiene al llamante desde el principio, el tramo hacia el agente puede
  presentar el CLI original del cliente.
- El **Call Popup** de Yeastar dispara la consulta al Conector cuando la llamada llega al
  agente, pasándole `{{.Phone}}` = número del cliente.

**Dato clave de ElevenLabs (validado en docs):** el system tool `transfer_to_number` con
modo **SIP REFER** incluye automáticamente los headers `X-Caller-ID` y `X-Conversation-ID`
en el REFER. Esto significa que Yeastar recibe de vuelta tanto el número del llamante como
el ID de conversación sin configuración extra. Además, soporta **custom SIP headers** y
**UUI** (User-to-User Information, max 256 bytes) que podrían transportar un `context_id`
directamente en el SIP REFER — un canal de correlación adicional al número de teléfono.

**Alternativa al header X-CALLER-ID:** si la troncal SIP no permite headers custom, el
**Call Flow Designer** de Yeastar (requiere **Ultimate Plan**, firmware **83.22.0.17+**)
tiene un componente **HTTP Request** que puede inyectar datos en la llamada saliente
usando `$Session.ani` (ANI del llamante). Evaluar si es necesario.

---

## 3. Estrategia de correlación

El **número del cliente (E.164)** es la llave que une las dos puntas:

1. El bot **guarda** el contexto en el Conector con ese número como clave (paso 2b).
2. La central **busca** en el Conector con el mismo número cuando la llamada llega al
   agente (paso 5).

No hace falta integración directa entre bot y central. El Conector desacopla el momento en
que el bot suelta el contexto del momento en que el agente lo necesita.

**Retención vs. entrega:** el Conector *entrega* al instante (fracción de segundo), pero
*retiene* el contexto por minutos, porque entre el paso 2b y el paso 5 el cliente puede
esperar en la cola. El TTL debe cubrir la **espera máxima de cola** del cliente (configurable,
default 15 min).

**Fallbacks de correlación (por si el número no alcanza):**

- **DID único por sesión:** Yeastar rutea a un destino distinto por llamada concurrente; ese
  DID se vuelve la clave (`Get DID From`). Blindado contra colisiones de número.
- **WebSocket evento 30011 (opcional, hardening):** el Conector se suscribe a los eventos
  de la Yeastar API (`Call State Changed`) para trazar `call_id → extensión que atendió`
  de forma event-driven. El evento devuelve `call_id`, `members[]` con `number`,
  `channel_id`, `member_status` (ALERT/RING/ANSWERED/ANSWER/HOLD/BYE) y datos de
  inbound/outbound (`from`, `to`, `trunk_name`). También se pueden usar los eventos
  **30012** (Call End Details), **30013** (Call Transfer Report) y **30016** (Incoming Call
  Request) para trazabilidad completa. Sólo si se necesita robustez extra.

---

## 4. Stack técnico

> Versiones exactas, paquetes npm y detalles de infraestructura: ver **[STACK.md](STACK.md)**.

### 4.1. Componentes de plataforma (terceros — se configuran, no se desarrollan)

| Componente | Detalle / requisito |
|---|---|
| **Yeastar P-Series Software Edition** | Plan **Enterprise (EP) o Ultimate (UP)**. Firmware **83.20.0.19+** (Custom CRM). Firmware **83.22.0.17+** (Call Flow Designer, solo si se usa). Integración **Custom CRM** habilitada. Softphone **Linkus** (Web o Desktop) por agente. |
| **ElevenLabs Conversational AI (Agents)** | Plan con **SIP trunking** (Enterprise). **Webhook tools** habilitadas en el agente. |
| **Troncal SIP Yeastar ↔ ElevenLabs** | TLS + SRTP recomendado. Auth por digest (usuario/clave) o ACL por IP. Codecs G711/G722. |

### 4.2. Conector (lo que desarrollamos)

| Capa | Elección | Motivo |
|---|---|---|
| Runtime | **Node.js 20 LTS** | Webhooks/JSON nativos; mismo lenguaje back y front del panel. |
| Lenguaje | **TypeScript** | Tipado sobre los contratos con 11L y Yeastar. |
| HTTP framework | **Fastify 5** | Liviano, rápido, buen manejo de JSON y esquemas. |
| Validación | **Zod** | Validar payloads de 11L y query params de Yeastar. |
| Almacén / cache | **Redis 7 + ioredis** | TTL nativo, sobrevive reinicios, escala entre instancias. |
| Tokens del panel | **jose** (JWT/HMAC) | Firmar tokens cortos para que el panel no sea spoofeable. |
| Normalización tel. | **libphonenumber-js** | Normalización E.164 robusta y ligera. |
| Logging | **pino** | Logs estructurados. |
| Front del panel | **Vite + React** (o HTML+fetch para MVP) | Se abre embebido en Linkus; simple de servir. |
| Contenedores | **Docker + docker-compose** | Conector + Redis + reverse proxy en un stack. |
| Reverse proxy / TLS | **Caddy** | HTTPS automático (Yeastar y 11L llaman por internet). |
| Hosting | VPS/contenedor con **IP pública + dominio + TLS** | HTTPS es obligatorio. |

### 4.3. Tooling de desarrollo

- **Claude Code** (seguimiento de este `PROJECT.md`)
- **Git + GitHub**, **pnpm**
- **ESLint + Prettier**, **Vitest** (tests)
- **cloudflared** o **ngrok** — túnel para exponer el Conector local a 11L/Yeastar en pruebas
- **curl / Postman** — probar endpoints
- **Wireshark / sngrep** — captura SIP para validar Caller ID en Fase 4

### 4.4. Requisitos de red

- Dominio + certificado TLS para el Conector (ej. `connector.midominio.com`).
- Si la Yeastar filtra el troncal por IP: allowlistear el **bloque /24** de ElevenLabs
  (`sip-static.rtc.elevenlabs.io`) o usar **digest auth** (recomendado).
- Puertos SIP (5060 TCP / 5061 TLS) y RTP (rango dinámico) entre Yeastar y 11L.

---

## 5. API del Conector

Base URL: `PUBLIC_BASE_URL` (ej. `https://connector.midominio.com`).

### `POST /api/context` — ingesta desde ElevenLabs
Lo llama el webhook tool del bot, justo antes del REFER. Auth: `Authorization: Bearer <INGEST_API_KEY>`.

```jsonc
// request body
{
  "caller_number": "+5491155554820",   // desde system__caller_id
  "conversation_id": "conv_abc123",
  "summary": "Pidió estado del pedido #48213. El bot confirmó despachado; la clienta quiere cambiar la dirección de entrega.",
  "intent": "cambio_direccion_entrega",
  "fields": { "pedido": "48213", "cliente_id": "00291", "verificado": true }
}
// → 200 OK  { "status": "ok", "message": "Contexto guardado" }
```

Efecto de una llamada exitosa: **dos escrituras en Redis** (ver §6).

1. `ctx:{E164}` — el contexto en curso, TTL corto (`CONTEXT_TTL_SECONDS`).
2. `hist:{E164}` — la misma interacción se agrega al historial, TTL largo
   (`HISTORY_TTL_SECONDS`).

⚠️ **No devolver `204`.** Con body vacío, el tool result le llega al LLM como string vacío y
le rompe el flujo (commit `75b01d8`).

⚠️ **El historial nunca puede hacer fallar este endpoint.** Está en el camino crítico de la
transferencia: un `500` acá le devuelve un error al LLM con el paciente en línea. Por eso el
`pushHistory` va dentro de un `try/catch` que sólo loguea un warning (`src/routes/context.ts`).

### `GET /crm/contacts/search?phone={{.Phone}}` — "Contact Match Query URL" de Yeastar
Lo llama Yeastar (Call Popup) cuando la llamada llega al agente. Auth: header personalizado
o Bearer Token según el template (ver §9.2). Devuelve un contacto con forma de CRM,
incluyendo la URL del panel con token firmado.

```jsonc
// → 200 OK
{
  "data": [
    {
      "id": "ctx_8f3a",
      "first_name": "Cliente",
      "phone": "+5491155554820",
      "contact_url": "https://connector.midominio.com/panel?token=eyJhbGciOi..."
    }
  ]
}
// Si NO hay contexto para ese número: decisión de producto (ver §11).
```

**Mapeo en el template de Yeastar** (Contact Field Mapping):
- `Contact ID` ← `data.#.id`
- `First Name` ← `data.#.first_name`
- `BusinessNumber` ← `data.#.phone`
- **Contact Popup URL** ← `Retrieve from Contact Fields` → `data.#.contact_url`

> **Nota sobre GJSON:** Yeastar usa [GJSON Path Syntax](https://github.com/tidwall/gjson)
> para parsear las respuestas JSON. El `#` itera sobre arrays. Para filtros condicionales
> se usa `data.#(key=="value").field`.

### `GET /panel?token=...` — panel del agente
Verifica el token firmado y sirve la página que se abre dentro de Linkus.

### `GET /api/panel-data?token=...` — datos del panel (JSON)
Lo consume el front del panel para renderizar el contexto y el historial.

```jsonc
// → 200 OK
{
  "caller_number": "+5491155554820",
  "conversation_id": "conv_abc123",
  "summary": "...", "intent": "...", "fields": { },
  "created_at": "2026-07-29T13:22:41.000Z",
  "history_count": 3,        // interacciones PREVIAS (no incluye la actual)
  "history": [               // más reciente primero, máximo HISTORY_MAX_ITEMS
    { "conversation_id": "...", "summary": "...", "intent": "...",
      "fields": { }, "created_at": "..." }
  ]
}
```

Dos comportamientos que no son obvios:

- **El historial excluye la interacción en curso** para no mostrarla duplicada (ya se
  renderiza arriba). Por eso `pushHistory` guarda `HISTORY_MAX_ITEMS + 1` elementos: uno se
  gasta en la actual y quedan 10 previas visibles.
- **Si no hay contexto en curso, el panel igual sirve.** Puede pasar que el TTL de `ctx:`
  haya vencido, o que el bot no haya llegado a llamar `guardar_contexto`. En ese caso
  `summary`/`intent` vienen vacíos pero `history` se devuelve igual.

### `POST /crm/journal` — Call Journal sink
Yeastar postea el CDR al cerrar la llamada. Variables disponibles del template: `{{.StartTimeUnix}}`,
`{{.Talk_Duration_Sec}}`, `{{.Call_Log_Status}}`, `{{.Call_From}}`, `{{.Call_To}}`,
`{{.Subject}}`, `{{.Description}}`, `{{.RecordPath}}`, `{{.Owner}}`, `{{.WhoModule}}`.

Este endpoint existe porque Yeastar lo llama solo (tiene `CallJournal=1` en el template de
`recursos/yeastar/yeastar-crm-template.xml`), es parte obligatoria de la integración Custom
CRM. El Conector lo acepta y loguea; no persiste nada en base de datos propia — para este
fork (Reino Cerámicos) no hay tabla `llamadas` ni tipificación que completar con el agente
que atendió (esa pieza era específica de INEBA, ver nota al pie de §9.2).

### `POST /crm/users` — (opcional) User Association
Si se activa la asociación de usuarios en Yeastar, devuelve la lista de "usuarios del CRM"
(uno sintético por agente) para asociarlos a extensiones. El mapeo requiere:
`User Unique ID`, `First Name`, `Last Name`, `Email`.

### `GET /healthz` — health check

---

## 6. Modelo de datos (Redis)

```
ctx:{E164}   STRING -> JSON { conversation_id, summary, intent, fields, created_at }
                       TTL = CONTEXT_TTL_SECONDS (default 900 = 15 min)

hist:{E164}  LIST   -> [ mismo JSON, más reciente primero ]
                       TTL = HISTORY_TTL_SECONDS (default 7776000 = 90 días)
                       Largo máximo = HISTORY_MAX_ITEMS + 1
```

**Por qué son dos claves y no una.** Cumplen funciones distintas y tienen vidas distintas:
`ctx:` es un buzón efímero que sólo tiene que sobrevivir la espera en cola; `hist:` es la
memoria del paciente y tiene que durar meses. Meterlos en la misma clave obligaría a elegir
un TTL que sirve mal para las dos cosas.

El `hist:` se escribe con un `MULTI` de `LPUSH` + `LTRIM` + `EXPIRE` (`store/redis.ts`), así
que **el TTL se renueva en cada llamada**: un paciente que llama seguido no pierde su
historial, y uno que no llama nunca más se limpia solo a los 90 días.

- Clave normalizada a **E.164** (`lib/phone.ts`) para que 11L y Yeastar coincidan.
- **`getHistory` deduplica por `conversation_id`** y descarta entradas corruptas en silencio:
  un JSON roto en Redis no puede dejar en blanco el panel durante una llamada.
- **Durabilidad:** Redis corre con `appendonly yes` (AOF, `appendfsync everysec`). Con sólo
  snapshots RDB la pérdida en un corte podía ser de hasta 1 hora, aceptable para un cache de
  15 minutos pero no para un historial de 90 días.
- Token del panel: HMAC/JWT corto que embebe `{E164 | conversation_id, exp}` — evita que un
  agente abra contextos ajenos. TTL propio (`PANEL_TOKEN_TTL_SECONDS`).
- (Opcional) `conv:{conversation_id}` para dedup / correlación por sesión.

---

## 7. Variables de entorno

```bash
PORT=8080
PUBLIC_BASE_URL=https://connector.midominio.com
REDIS_URL=redis://localhost:6379

CONTEXT_TTL_SECONDS=900        # retención = espera máx. de cola (ajustar al cliente)

HISTORY_TTL_SECONDS=7776000    # 90 días; se renueva en cada llamada del paciente
HISTORY_MAX_ITEMS=10           # interacciones PREVIAS visibles en el panel

INGEST_API_KEY=change-me       # 11L -> POST /api/context
CRM_API_KEY=change-me          # Yeastar CRM template -> /crm/*
PANEL_TOKEN_SECRET=change-me   # firma HMAC de tokens del panel
PANEL_TOKEN_TTL_SECONDS=1800

LOG_LEVEL=info
```

---

## 8. Estructura del repo

```
voicebot-context-bridge/
├─ PROJECT.md                  # este doc: fuente de verdad
├─ STACK.md                    # versiones y dependencias detalladas
├─ TRANSFERENCIA-SIP-REFER.md  # diagnóstico del REFER (causa raíz y descartes)
├─ AGENTE-ELEVENLABS.md        # config del agente: LLM, TTS, ASR, calidad de voz
├─ backups/                    # snapshots de la config de 11L (⚠️ gitignored: traen secretos)
├─ recursos/                   # material de apoyo, nada que el código importe
│  ├─ manuales/                #   PDFs de Yeastar (gitignored: 55 MB)
│  ├─ capturas/                #   pcaps de diagnóstico (gitignored: datos personales)
│  └─ yeastar/                 #   template Custom CRM importable (versionado)
├─ .claude/skills/             # skills de Claude Code del proyecto
├─ docker-compose.yml          # conector + redis + caddy
├─ Caddyfile
├─ .env.example
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ server.ts
│  ├─ config.ts
│  ├─ routes/
│  │  ├─ context.ts            # POST /api/context
│  │  ├─ crm.ts                # GET /crm/contacts/search, POST /crm/journal, /crm/users
│  │  ├─ panel.ts              # GET /panel, GET /api/panel-data
│  │  └─ health.ts
│  ├─ store/redis.ts           # ctx: (contexto) + hist: (historial)
│  ├─ lib/
│  │  ├─ tokens.ts             # firmar/verificar tokens del panel
│  │  └─ phone.ts              # normalización E.164
│  └─ types.ts
├─ panel/                      # front del panel (Vite) o public/ estático
└─ test/
```

---

## 9. Config de plataformas (resumen operativo)

### 9.1. ElevenLabs

> Config completa del agente (LLM, TTS, ASR, calibración de calidad de voz, backups y
> trampas de la API) en **[AGENTE-ELEVENLABS.md](AGENTE-ELEVENLABS.md)**.
> Agente en uso: `agent_3901m0dppqc8ehtafxv04kxhyapy` ("Aris - Reino Cerámicos").

**SIP Trunk entrante:**
- URI de 11L: `sip:<identifier>@sip.rtc.elevenlabs.io:5060`
- Auth: Digest (recomendado) o ACL por IP. TLS 1.2+ requerido.
- Yeastar envía header `X-CALLER-ID` → 11L lo expone como `{{system__caller_id}}`.
- Otros headers `X-` custom se convierten automáticamente a variables dinámicas
  (ej. `X-Contact-ID` → `{{sip_contact_id}}`).

**Variables de sistema disponibles automáticamente:**
- `{{system__caller_id}}` — número del llamante
- `{{system__called_number}}` — número marcado
- `{{system__conversation_id}}` — ID único de la conversación
- Se referencian en prompt, first message, y herramientas con `{{nombre}}`.

**Webhook tool `enviar_contexto`:**
- Método: POST
- URL: `{PUBLIC_BASE_URL}/api/context`
- Auth: Header `Authorization: Bearer {INGEST_API_KEY}` (tipo Secret en 11L)
- Body (JSON): los parámetros son **generados por el LLM** a partir de la conversación.
  Definir en la descripción del tool los campos esperados: `caller_number` (indicar
  que debe tomarse de `{{system__caller_id}}`), `conversation_id` (de
  `{{system__conversation_id}}`), `summary`, `intent`, `fields`.
- **System prompt:** instruir al agente a llamar `enviar_contexto` **antes** de derivar.
  Enfatizar que `caller_number` viene de `{{system__caller_id}}`, no transcrito de oído.
- Modelos recomendados para tool calling: GPT 5.2, Gemini-2.5-Flash, Claude Sonnet 4.5.

**System tool `transfer_to_number` (derivación):**
- Modo: **SIP REFER** (requiere que la conversación sea por SIP trunk).
- Destino: SIP URI de la cola/agente en Yeastar (ej. `sip:6500@yeastar.example.com`).
- Parámetro `client_message`: texto que el agente lee al usuario durante la transferencia
  (ej. "Lo transfiero con un agente que va a poder ayudarlo").
- Headers automáticos en el REFER: `X-Caller-ID`, `X-Conversation-ID`.
- **Custom SIP headers** opcionales: se pueden agregar headers extra al REFER con valores
  estáticos o variables dinámicas (ej. `X-Context-ID: {{system__conversation_id}}`).
- **UUI** (User-to-User Info): payload de hasta 256 bytes en el REFER a SIP URIs.
  Podría usarse para pasar un `context_id` compacto directamente en la señalización SIP.

### 9.2. Yeastar — Custom CRM Template

**Creación del template** (Integrations > CRM > Custom > Template Management > Add):

1. **General:** nombre del CRM (ej. "Context Bridge"), Max Concurrent Request = 5.
2. **User Association:** deshabilitado (a menos que se implemente `/crm/users`).
3. **Authentication Method:** `Bearer Token`.
   - Campo custom: `base_url` (Text Input) — la PUBLIC_BASE_URL del Conector.
   - Campo custom: `api_key` (Password Input) — el CRM_API_KEY.
   - Token Endpoint: endpoint que devuelva un token, o usar `None` auth con header custom
     `Authorization: Bearer {{.api_key}}` si se prefiere simplificar.
4. **Headers:** `Authorization: Bearer {{.api_key}}` (si auth = None).
5. **Synchronize Contacts Automatically:**
   - Contact Type: `Contexts`
   - Contact Match Query URL: `{{.base_url}}/crm/contacts/search?phone={{.Phone}}`
   - Contact Popup URL: **Retrieve from Contact Fields** → `data.#.contact_url`
   - Contact Field Mapping:
     - Contact ID: `data.#.id`
     - First Name: `data.#.first_name`
     - BusinessNumber: `data.#.phone`
6. **Create New Contact:** deshabilitado.
7. **Call Journal:** URL = `{{.base_url}}/crm/journal`, body con variables de CDR (ver
   `recursos/yeastar/yeastar-crm-template.xml`). Requisito obligatorio de la integración
   Custom CRM en sí (Yeastar lo llama solo); el Conector solo lo loguea, ver §5.

> **Nota (15/09/2026):** el proyecto original de INEBA tenía además una tabla `llamadas`
> (SQLite) con tipificación manual por agente (`POST /api/panel/tipificar`, panel de
> supervisor con export CSV) — vocabulario 100% médico (turnos, RESO, EEG, etc.), sin sentido
> para Reino Cerámicos. Se removió entero de este fork (`src/routes/tipificacion.ts`,
> `src/routes/supervisor.ts`, `src/store/sqlite.ts`, `src/jobs/cleanup.ts`,
> `src/lib/password.ts`). Si un futuro cliente necesita algo similar, es más rápido
> rediseñarlo a medida que resucitar ese código.

**Setup de la integración:**
- Integrations > CRM > click en "Context Bridge" > ingresar `base_url` y `api_key`.
- **Always Query CRM** = habilitado.

**Call Popup por extensión** (es por extensión, no global):
- Extension and Trunk > Extension > editar > pestaña **Linkus Clients** > bajar al cliente.
- Checkbox: **Open Contact URL Using System-Integrated CRM**.
- Popup Method: **Automatically (Only for Incoming Calls)**.
  - La otra opción es `Manually`: el contexto no salta solo, pero aparece un **botón de CRM**
    en la ventana de llamada que lo abre. Útil como fallback y para diagnosticar.
- Trigger Event: **Ringing** (muestra el contexto antes de contestar) o **Answered** / `Call End`.

⚠️ **Dos requisitos que no dan ningún error si faltan:**

1. **El pop-up solo existe dentro de Linkus** (Web Client o Desktop Client) y con sesión
   iniciada. Desde un teléfono físico o un softphone que no sea Linkus **no hay pop-up**,
   por más que esté bien configurado — no hay nada que el PBX pueda abrir.
2. **El bloqueador de ventanas emergentes del navegador lo tapa en silencio.** Chrome bloquea
   el pop-up sin avisar del lado del PBX: la integración funciona, el contacto matchea, pero
   no se ve nada. Hay que **permitir emergentes para el dominio de Linkus**. Ya nos pasó:
   se diagnosticó como "no funciona el popup" cuando en realidad estaba todo bien.

Requisitos de plataforma: firmware **83.18.0.102+** y **Enterprise Plan o Ultimate Plan**.

### 9.3. Yeastar — Troncal SIP hacia ElevenLabs
- Troncal SIP saliente hacia 11L; enviar el CLI del cliente en `X-CALLER-ID`.
- Inbound route: confirmar `Get Caller ID From` correcto para que el agente vea el número real.
- Troncal en **TCP**, Qualify **activado**.
- ⚠️ **`PBX Settings → SIP Settings → General → Qualify Frequency (s)` debe estar en `25`.**
  Con el default de 120 s la transferencia falla en toda llamada que dure más de ~35 s:
  Yeastar cierra la conexión TCP a los 33 s de inactividad SIP y el REFER no llega a salir.
  Diagnóstico completo en **[TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md)**.

### 9.3.1. ElevenLabs — configuración del REFER
- `transfer_type: sip_refer` + `transfer_destination: {type: "sip_uri", sip_uri: "sip:<destino>@<host-yeastar>"}`.
- **No usar `type: "phone"`**: emite `Refer-To: tel:9999` (URI pelado, sin host). Yeastar
  responde 202 + NOTIFY `100 Trying` y nunca rutea. Ver §5 del doc de transferencia.

**El destino es un parámetro de instalación, no una constante del proyecto.** Cambia con
cada cliente y con cada entorno: puede ser una cola, un ring group, un IVR o un interno
suelto. En INEBA está en `sip:9999@200.41.236.251` (interno de pruebas de Guido, Yeastar
on-prem). Para Reino Cerámicos es `sip:6401@18.231.0.5:10050` (queue 6401, Yeastar P-Series
Cloud Edition — infraestructura distinta a la de INEBA, IP/puerto confirmados contra el
phone number `phnum_4701m1phhr2we3pv4p5g269frxe0` en ElevenLabs) — ya cargado en el agente.

### 9.3.2. ⚠️ Discador saliente — `system__caller_id` NO es el número del cliente

**Bug real, encontrado en la primera llamada de prueba de Reino Cerámicos (15/09/2026).**
Aplica a cualquier agente que **origine** la llamada (discador), no a uno que la reciba.

En un flujo **inbound** (INEBA), `system__caller_id` es el número del que llama — correcto
usarlo como `caller_number` en `guardar_contexto`. En un flujo **outbound** (Reino), ese
mismo dynamic variable **deja de significar eso**: pasa a ser un identificador interno del
canal/troncal saliente (en la prueba real vino como `"10004201"`, ni parece un teléfono). El
número real del cliente al que se llamó está en otra variable: **`system__called_number`**.

**Síntoma:** `guardar_contexto` se llama, el LLM arma bien el resumen, pero el conector
devuelve `400` (`normalizeE164` no puede parsear `"10004201"` como número AR válido). El
agente lo nota, dice "tuve un problema técnico" y sigue igual con la transferencia — la
llamada se transfiere pero **sin contexto guardado**. No hay pop-up en Linkus del lado
Yeastar porque `/crm/contacts/search` (que Yeastar sí consulta con el número real, sacado de
su propia señalización SIP) nunca encuentra nada: el conector nunca guardó nada bajo esa
clave.

Esto **no tiene nada que ver** con la manipulación de dígitos que hace Guido en la troncal
Yeastar→net2phone (`+5491161626716` → `1561626716` para que net2phone lo acepte) — esa
conversión pasa en una troncal totalmente distinta, río abajo, invisible para ElevenLabs.

**Fix aplicado:** en el tool `guardar_contexto`, el campo `caller_number` del
`request_body_schema` se mapea a `dynamic_variable: system__called_number` (antes:
`system__caller_id`). Backup pre-fix: `backups/aris_agent_20260915_153116_pre-caller-id-fix.json`.

**Regla general para el próximo cliente con discador:** antes de cablear `guardar_contexto`,
mirar el `conversation_initiation_client_data.dynamic_variables` de una llamada de prueba
real (`GET /v1/convai/conversations/{id}`) y confirmar a ojo cuál variable trae el número del
cliente — no asumir que es `system__caller_id` sólo porque funcionó así en un flujo inbound.

Para moverlo a otro destino o a otro cliente hay que tocar **dos lugares**, y sólo dos:

| Qué | Dónde |
|---|---|
| El destino del REFER | Agente 11L → system tool `transfer_to_number` → `transfer_destination.sip_uri` |
| La URL del Conector | Yeastar → Integrations → CRM → campo `base_url` del template |

El resto del stack es agnóstico al destino: el Conector nunca ve el número al que se
transfiere, sólo el del llamante. Lo que **sí** hay que re-verificar en cada instalación es
que el `sip_uri` apunte al host correcto de esa Yeastar y que el destino exista como
extensión ruteable — un destino inexistente da `202 Accepted` igual y falla en silencio.

⚠️ Antes de dar por buena una instalación nueva, repasar el **checklist de §9.3**
(`Qualify Frequency = 25`) — es específico de cada PBX y no viaja con el código.

### 9.4. Yeastar — Call Flow Designer (alternativa, requiere Ultimate Plan)
Si el header `X-CALLER-ID` en la troncal no es viable, el componente **HTTP Request**
del Call Flow Designer permite hacer un POST/GET a una URL externa durante el flujo de
llamada, usando `$Session.ani` como número del llamante. La respuesta queda en
`$HttpRequest{n}.responseContent`. Se puede combinar con componentes **Condition** y
**Transfer** para tomar decisiones antes de rutear.

---

## 10. Fases y tareas

> ⚠️ Las Fases 0-5 de abajo documentan el build **original de INEBA**, como checklist/
> plantilla de lo que hay que rehacer para Reino Cerámicos — no dan por hecho nada de este
> fork. Server-side (Fases 0-3) probablemente se replica sin cambios de código una vez que
> el LXC propio esté arriba; la **Fase 4 (telefonía) hay que rehacerla entera**: dirección de
> llamada distinta (saliente), destino distinto (queue en vez de interno fijo), y agente/LXC
> propios.

### Fase 0 — Setup (INEBA; replicar en el LXC propio de Reino Cerámicos)
- [x] Repo + Claude Code + toolchain (pnpm, TS, ESLint, Prettier, Vitest)
- [x] Esqueleto Fastify + `GET /healthz`
- [x] `docker-compose` con Redis nativo del LXC + conector
- [x] `.env.example` con todas las variables documentadas
- [x] Dominio propio definido: `contexto-reino.duckdns.org`
- [x] LXC clonado del 101, datos de INEBA (Redis/SQLite) purgados, repo nuevo desplegado

#### ⚠️ Cambio de topología vs. INEBA: TLS deja de ser por-cliente

INEBA y Reino Cerámicos comparten la misma IP pública fija (`181.104.117.58`) — el router
(Draytek) solo puede reenviar el puerto 80/443 a **una** IP interna, no puede repartir por
dominio a nivel NAT. Un Caddy con TLS propio embebido en el `docker-compose` de cada cliente
(como tenía INEBA) no escala: además, encadenar el Caddy de Reino detrás del de INEBA acopla
la disponibilidad de un cliente a la del otro (si se reinicia el LXC de INEBA para
mantenimiento, se cae Reino con él).

**Solución adoptada:** un LXC "edge" nuevo, dedicado únicamente a correr Caddy, en su propio
contenedor, sin ninguna lógica de cliente. Es el único punto que recibe el port-forward del
Draytek. Tiene un site block por cliente, cada uno con TLS automático propio, que hace
`reverse_proxy` por LAN al conector de ese cliente:

```
contexto-bridge.duckdns.org { reverse_proxy <ip-lan-lxc101>:8080 }
contexto-reino.duckdns.org  { reverse_proxy 192.168.1.227:8080 }
```

Consecuencia para este repo: **ya no corre Caddy ni maneja TLS**. El `docker-compose.yml`
publica el conector directo en `8080:8080` (antes `expose`, solo alcanzable dentro de la red
Docker propia) para que el edge lo alcance por LAN en texto plano — ese salto es interno, no
sale a internet. `PUBLIC_BASE_URL` no cambia (`https://contexto-reino.duckdns.org`), es el
dominio de cara al cliente; el TLS lo termina el edge, no el conector.

**Pendiente:** el LXC edge todavía no existe. Cuando esté arriba, además de este site block
hay que migrar también el de INEBA (sacarle el Caddy embebido a LXC 101 y exponer su conector
a LAN igual que acá) — **eso requiere tocar infraestructura productiva de INEBA, no se hace
sin confirmación explícita aparte**, es un cliente en producción.

Fase 0 del stack técnico (Fastify/Redis/SQLite) no cambia por esto — es puramente el borde de
red lo que se reestructura.

### Fase 1 — Ingesta de contexto (INEBA; lógica reusable, no requiere cambios para Reino)
- [x] `POST /api/context` con auth Bearer + validación Zod
- [x] Normalización E.164 (`lib/phone.ts` con libphonenumber-js)
- [x] Guardado en Redis con TTL configurable
- [x] Tests unitarios de ingesta y normalización
- [x] Webhook tool `guardar_contexto` en ElevenLabs + system prompt (llama antes del REFER)
- [x] Responde `200` + JSON. **No usar `204`**: con body vacío el tool result le llega al
      LLM como string vacío (commit `75b01d8`)

### Fase 2 — Respuesta tipo CRM (INEBA; lógica reusable)
- [x] `GET /crm/contacts/search` devolviendo el shape CRM esperado (GJSON-compatible)
- [x] Generación de token firmado del panel (`lib/tokens.ts`)
- [x] Template Custom CRM en Yeastar (según §9.2) — para Reino Cerámicos hay que crear el
      template de nuevo apuntando al `base_url` de su propio conector
- [x] Habilitar Call Popup por extensión (trigger ringing/answered) — replicar en cada
      agente de la queue de Reino Cerámicos, no solo en un interno de test
- [x] Tests unitarios de búsqueda CRM y generación de token

### Fase 3 — Panel del agente (INEBA; lógica reusable)
- [x] `GET /panel?token=` (verifica token, sirve la página)
- [x] `GET /api/panel-data?token=` (JSON del contexto)
- [x] Front del panel: render de resumen, intención, fields, datos del llamante
- [x] Estado "sin contexto previo" (`src/routes/panel.ts`)
- [x] **Historial de interacciones previas** (commit `dc64b17`): `hist:{E164}` en Redis,
      acordeón con las últimas `HISTORY_MAX_ITEMS`, contador, y estado "es la primera vez
      que llama". Verificado en producción de punta a punta para INEBA.
- [x] AOF activado en Redis (`appendonly yes`) — el historial no puede depender de snapshots
- [x] Rediseño visual del panel (commit `654299a`): jerarquía para lectura rápida durante la
      llamada. Sin fuentes externas a propósito — el panel se abre mientras suena el teléfono
      y no puede depender de una descarga.

### Fase 4 — Telefonía / correlación (VALIDACIÓN CRÍTICA) — ⚠️ pendiente entera para Reino Cerámicos
Lo de abajo es lo que se verificó para INEBA (flujo entrante); sirve como checklist de método,
no como estado de este proyecto.
- [x] *(INEBA)* Troncal Yeastar → 11L (SIP) enviando `X-CALLER-ID`
- [x] *(INEBA)* Confirmar `system__caller_id` en 11L = número real del cliente
- [x] *(INEBA)* REFER de vuelta al destino; **verificado con pcap** — CLI llega correcto
- [x] *(INEBA)* **Transferencia SIP REFER funcionando de punta a punta** (ver
      [TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md)): `sip_uri` en vez de `phone`
      + `Qualify Frequency` 120 → 25
- [ ] **Reino Cerámicos**: confirmar cómo se ve el `caller_id`/CLI en un flujo **saliente**
      (el discador de ElevenLabs origina la llamada — no es simétrico al caso entrante de
      INEBA, hay que validarlo con una llamada real + pcap, no asumir)
- [ ] **Reino Cerámicos**: definir el **destino** real del REFER — hoy `9999`, interno de
      pruebas compartido con INEBA, **temporal**. Va a ser una queue, no un interno fijo —
      ver la nota sobre `CONTEXT_TTL_SECONDS` vs. espera de cola en §9.3.1 y en el chat de
      diseño de este fork
- [ ] **Reino Cerámicos**: si comparte PBX Yeastar con INEBA, confirmar que `Qualify
      Frequency = 25` (global) ya aplica; si es una Yeastar distinta, aplicarlo ahí también
- [ ] Ajustar `Get Caller ID From` en Yeastar según lo observado
- [ ] Si el CLI no sobrevive → implementar plan B (DID único o Call Flow Designer)

### Fase 5 — Robustez / opcional
- [ ] Logging estructurado + métricas básicas
- [ ] Fallback de correlación vía WebSocket evento 30011
- [ ] Manejo de concurrencia y colisiones de número
- [ ] Rate limiting en endpoints públicos

---

## 11. Preguntas abiertas / decisiones

- **[CRÍTICO] CLI tras el REFER:** ¿qué número ve el agente cuando la llamada vuelve? Se
  resuelve con una llamada de prueba + captura SIP en Fase 4. La topología (Yeastar en ambas
  puntas) juega a favor, pero hay que confirmarlo empíricamente. **Dato nuevo:** el SIP REFER
  de 11L incluye automáticamente `X-Caller-ID` y `X-Conversation-ID` en los headers, lo que
  da un canal extra de correlación incluso si el CLI no sobrevive.
- **Popup sin match:** si no hay contexto para el número (ej. llamada que no pasó por el bot),
  ¿devolvemos contacto vacío (no hay popup) o un contacto con panel "sin contexto previo"?
  Decisión de producto. Opciones:
  - Devolver `{ "data": [] }` → Yeastar no muestra popup (silencioso).
  - Devolver contacto con `contact_url` apuntando a un panel "sin contexto" (informativo).
- **TTL real:** ajustar `CONTEXT_TTL_SECONDS` a la espera máxima de cola del cliente (con
  margen). Parámetro, no valor fijo.
- **El historial cuenta interacciones *con contexto capturado*, no llamadas totales.** Sólo
  se escribe cuando el bot llama `guardar_contexto`; si el paciente corta antes de dar sus
  datos, esa llamada no queda registrada. Es lo razonable (no habría resumen que mostrar),
  pero conviene decirlo antes de que alguien lea el contador como "cantidad de llamadas".
- **Retención del historial:** para INEBA el historial guardaba resúmenes de consultas
  médicas por 90 días (dato sensible, requería confirmación explícita del cliente). Reino
  Cerámicos no maneja datos de salud, pero igual conviene confirmar con ellos qué plazo y
  qué contenido de las llamadas (pedidos, direcciones, datos de contacto) les parece
  razonable retener — `HISTORY_TTL_SECONDS` es un parámetro, se ajusta sin tocar código.
- **Número por header a 11L:** confirmar en Fase 1 que Yeastar envía y 11L expone el
  `X-CALLER-ID` correctamente. Si no funciona, evaluar Call Flow Designer (§9.4).
- **UUI como canal de correlación:** el SIP REFER de 11L soporta User-to-User Info
  (max 256 bytes). Se podría enviar un `context_id` compacto directamente en la
  señalización SIP, eliminando la dependencia del número de teléfono como clave.
  Requiere que Yeastar soporte leer UUI del REFER (verificar en Fase 4).
- **Auth del template CRM:** decidir entre `Bearer Token` (con Token Endpoint) o `None`
  auth con header custom. `None` + header `Authorization: Bearer {{.api_key}}` es más
  simple si no necesitamos refresh de token.
- **CORS del panel:** Linkus Web Client abre el panel en un iframe. Verificar que los
  headers CORS y `X-Frame-Options` permitan el embed desde el dominio de Linkus.
- ~~**Modelo LLM del agente 11L**~~ — **DECIDIDO (29/07/2026):** `gemini-3.5-flash` con
  `temperature 0.3`. Los webhook tools requieren buen tool calling; se eligió quedarse en la
  familia Gemini para no alterar ese comportamiento. Alternativas si hace falta más
  razonamiento: `claude-sonnet-4-5` o `gpt-5.4-mini` (cambian de familia → reprobar el flujo
  de transferencia completo). Evitar modelos de baja capacidad como `gemini-2.0-flash`.
  Detalle en [AGENTE-ELEVENLABS.md](AGENTE-ELEVENLABS.md).

---

## 12. Cómo laburar este doc desde Claude Code

1. Trabajar fase por fase; marcar los checkboxes al cerrar cada tarea.
2. Ante ambigüedad, respetar los contratos de la **§5 (API)** y **§6 (datos)** como fijos.
3. La **Fase 4** es la única con incertidumbre real (telefonía); el resto es determinístico.
4. No hardcodear secretos: todo va por `.env` (§7).
5. Consultar **STACK.md** para versiones exactas de dependencias.
6. Para dudas de Yeastar, consultar los manuales en `recursos/manuales/` (no están en el
   repo por tamaño; ver [recursos/README.md](recursos/README.md)).
7. Para dudas de ElevenLabs, consultar `elevenlabs_referencias.txt` (índice de docs) o
   acceder directamente a las páginas `.md` agregando `.md` a la URL de cualquier página
   de docs (ej. `https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking.md`).
   Las páginas clave son:
   - SIP trunking: `eleven-agents/phone-numbers/sip-trunking`
   - Webhook tools: `eleven-agents/customization/tools/webhook-tools`
   - Transfer to number: `eleven-agents/customization/tools/system-tools/transfer-to-number`
   - Dynamic variables: `eleven-agents/customization/personalization/dynamic-variables`
   - SIP reference: `eleven-agents/phone-numbers/sip-reference`

# Stack Tecnico — GCS Context Bridge v1.0

> ⚠️ Fork para Reino Cerámicos. El stack tecnico (runtime, dependencias, infraestructura) es
> identico al original de INEBA — nada de esto cambia entre clientes. Lo que si es especifico
> de la instalacion de INEBA (agente 11L, IP de Yeastar, destino del REFER) esta marcado
> abajo como referencia/TODO, no como valor vigente de este proyecto.

> Documento de referencia con todas las dependencias, versiones minimas,
> requisitos de plataforma y decisiones tecnicas del proyecto.

---

## 1. Plataformas externas (se configuran, no se desarrollan)

### Yeastar P-Series Software Edition

| Requisito | Valor |
|---|---|
| Plan | **Enterprise (EP)** o **Ultimate (UP)** |
| Firmware minimo (Custom CRM) | **83.20.0.19** o superior |
| Firmware minimo (Call Flow Designer) | **83.22.0.17** o superior (solo si se usa CFD) |
| Firmware recomendado | **83.24.0.30** o superior (ultimo estable) |
| Funcionalidad clave | Integrations > CRM > **Custom** template |
| Softphone | **Linkus Web Client** o **Linkus Desktop Client** |
| API (opcional, para WebSocket 30011) | Habilitada en Settings > API |
| Developer Guide de referencia | Cloud Edition v1.0 (la API es equivalente entre Cloud y Software) |

**Notas de la documentacion oficial:**
- El Custom CRM template usa **GJSON Path Syntax** para mapear campos JSON.
- Las variables de template siguen la sintaxis **text/template de Go** (`{{.variable}}`).
- Auth soportada en el template: None, Basic, OAuth2, **Bearer Token** (la que usamos).
- El Contact Popup URL puede ser **"Retrieve from Contact Fields"** (nuestro caso: `data.#.contact_url`).
- Call Popup trigger configurable por extension: **Ringing** o **Answered**.
- **Always Query CRM** debe estar habilitado para lookup en tiempo real.
- Call Journal es opcional — se configura como POST con variables como `{{.StartTimeUnix}}`, `{{.Talk_Duration_Sec}}`, etc.
- El template soporta funciones: `TimeFormat`, `ToMillis`, `Capitalize`, `UrlEncode`.

### ElevenLabs Conversational AI

| Requisito | Valor |
|---|---|
| Plan | **Enterprise** (con SIP trunking) |
| SIP URI | `sip:<identifier>@sip.rtc.elevenlabs.io:5060` |
| Funcionalidad clave | **Webhook tools** + **Transfer to number** (system tool) |
| Variable del caller | `system__caller_id` — caller's phone number (voice calls) |
| Derivacion | **SIP REFER** via system tool `transfer_to_number` |
| Agente en uso | `agent_3901m0dppqc8ehtafxv04kxhyapy` ("Aris - Reino Cerámicos") |
| LLM | `gemini-3.5-flash`, `temperature 0.3` |
| TTS | `eleven_turbo_v2_5`, `optimize_streaming_latency 1`, `stability 0.6` |
| ASR | `scribe_realtime`, `quality: high`, 25 keywords del dominio |

> Calibracion de calidad de voz, backups y trampas de la API en
> [AGENTE-ELEVENLABS.md](AGENTE-ELEVENLABS.md).

**Variables de sistema disponibles en el agente (automaticas):**
- `system__caller_id` — numero del llamante (voz solamente)
- `system__called_number` — numero de destino marcado (voz solamente)
- `system__conversation_id` — ID unico de la conversacion
- `system__call_duration_secs` — duracion de la llamada en segundos
- `system__time_utc` — hora UTC actual en formato ISO
- `system__agent_id` — ID del agente que inicio la conversacion

Se referencian en prompts, first messages y herramientas con `{{variable_name}}`.

**Headers SIP custom → variables dinamicas:**
Los headers `X-` inbound se convierten automaticamente a variables dinamicas por
normalizacion. Ej: `X-Contact-ID` → `{{sip_contact_id}}`. Esto permite pasar datos
extra desde Yeastar al agente sin configuracion adicional.

**Webhook tools — configuracion:**
- Soportan POST/GET/PUT/PATCH con body JSON o URL-encoded
- Auth: Bearer token via header (marcar como "Secret"), OAuth2, Basic, o custom headers
- Los parametros del body son **generados por el LLM** a partir del contexto de la
  conversacion (no son valores estaticos hardcodeados)
- La respuesta puede poblar variables dinamicas para uso posterior en la conversacion
- Modelos recomendados para tool calling: GPT 5.2, Gemini-2.5-Flash, Claude Sonnet 4.5

**Transfer to number — SIP REFER:**
- El system tool `transfer_to_number` soporta 3 modos:
  1. **Conference Transfer** (default) — crea conferencia, luego el agente se retira
  2. **Blind Transfer** — solo con numeros nativos Twilio
  3. **SIP REFER** — usa el protocolo SIP REFER directamente. Requiere SIP trunk.
- Para nuestro caso usamos **SIP REFER** (el agente esta en SIP trunk)
- Headers automaticos en el REFER: `X-Conversation-ID`, `X-Caller-ID`
- Soporta **custom SIP headers** en el REFER (valores estaticos o variables dinamicas)
- Soporta **User-to-User Information (UUI)** en REFER a SIP URIs (max 256 bytes UTF-8)
  — potencialmente util para pasar un context_id directamente en el REFER
- Destinos: numeros E.164 o SIP URIs (`sip:1234567890@example.com`)
- Parametros: `transfer_number`, `client_message` (texto leido al usuario), `reason`

### Troncal SIP (Yeastar <-> ElevenLabs)

| Parametro | Valor |
|---|---|
| SIP URI de ElevenLabs | `sip:<identifier>@sip.rtc.elevenlabs.io:5060` |
| Transporte | **TLS** recomendado, TCP/UDP aceptable |
| Media | SRTP recomendado |
| Codecs | G.711 (8kHz, u-law/a-law), G.722 (16kHz) |
| Autenticacion | **Digest auth** (usuario/clave) recomendado sobre ACL por IP |
| Header custom entrante | `X-CALLER-ID` — Yeastar lo envia, 11L lo expone como `system__caller_id` |
| Headers automaticos en REFER | `X-Caller-ID`, `X-Conversation-ID` (los manda 11L) |
| TLS minimo | **1.2+** requerido por ElevenLabs |
| Transporte en uso (INEBA, referencia) | **TCP**. Reino Cerámicos usa **UDP** (troncal saliente confirmada vía ElevenLabs, ver abajo) — son PBX distintas, no asumir que lo de INEBA aplica |
| Destino del REFER | `sip_uri` → `sip:<destino>@<host-yeastar>`. **Nunca `phone`** (emite `tel:` sin host y no rutea). INEBA: `200.41.236.251` (Yeastar on-prem). **Reino Cerámicos: `18.231.0.5:10050`** (Yeastar P-Series Cloud Edition — instancia totalmente distinta, no la misma PBX). Confirmado contra el phone number `phnum_4701m1phhr2we3pv4p5g269frxe0` ("to_reino") en la API de ElevenLabs: `provider_config.address = "18.231.0.5:10050"`, `transport: udp`, sin auth |
| Qualify Frequency (global) | **25 s** en la Yeastar de INEBA (default 120 s cierra la conexión TCP a los 33 s de inactividad y el REFER no sale). Reino Cerámicos es **otra instancia (PCE) y otro transporte (UDP)** — el bug era específico de TCP, puede no aplicar igual, pero la troncal saliente ya está probada y funcionando según Guido. Igual, si el REFER falla en silencio, este es el primer sospechoso — ver [TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md) |

> Detalle completo del diagnostico y del arreglo en
> [TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md).

---

## 2. Conector (lo que desarrollamos)

### Runtime y lenguaje

| Componente | Version | Justificacion |
|---|---|---|
| **Node.js** | **20 LTS** (>=20.11) o **22 LTS** | Webhooks/JSON nativos, mismo lenguaje back+front |
| **TypeScript** | **5.4+** | Tipado sobre contratos con 11L y Yeastar |
| **pnpm** | **9+** | Package manager rapido, workspace-ready |

### Dependencias de produccion

| Paquete | Version minima | Uso |
|---|---|---|
| **fastify** | 5.x | HTTP framework principal |
| **@fastify/cors** | 10.x | CORS para panel embebido en Linkus |
| **@fastify/static** | 8.x | Servir archivos del panel (si no se usa Vite en dev aparte) |
| **zod** | 3.23+ | Validacion de payloads (ingesta 11L, query params Yeastar) |
| **ioredis** | 5.x | Cliente Redis (preferido sobre `redis` por robustez y cluster) |
| **jose** | 5.x | Firmar/verificar JWT (tokens del panel) |
| **pino** | 9.x | Logging estructurado |
| **pino-pretty** | 11.x | Formato legible en desarrollo |
| **libphonenumber-js** | 1.11+ | Normalizacion E.164 (mas ligero que google-libphonenumber) |
| **dotenv** | 16.x | Carga de `.env` (solo si no se usa `--env-file` de Node 20.6+) |

### Dependencias de desarrollo

| Paquete | Version minima | Uso |
|---|---|---|
| **typescript** | 5.4+ | Compilador |
| **tsx** | 4.x | Ejecucion directa de TS en desarrollo |
| **vitest** | 2.x | Testing |
| **eslint** | 9.x | Linting (flat config) |
| **prettier** | 3.x | Formateo |
| **@types/node** | 20.x | Tipos de Node.js |

### Infraestructura

| Componente | Version | Uso |
|---|---|---|
| **Redis** | **7.x** | Cache con TTL nativo, persistencia RDB |
| **Docker** | 24+ | Contenedorizacion |
| **Docker Compose** | v2 (plugin) | Orquestacion local: conector + redis + caddy |
| **Caddy** | 2.8+ | Reverse proxy con HTTPS automatico (Let's Encrypt) |

### Panel del agente (front)

| Componente | Version | Uso |
|---|---|---|
| **Vite** | 6.x | Bundler/dev server |
| **React** | 19.x | UI del panel (o HTML+fetch para MVP rapido) |

> **Alternativa MVP:** un archivo HTML estatico con `fetch()` al endpoint
> `/api/panel-data?token=...` y renderizado vanilla. Suficiente para la primera version.

---

## 3. Herramientas de desarrollo

| Herramienta | Uso |
|---|---|
| **Claude Code** | Seguimiento del PROJECT.md, desarrollo asistido |
| **Git + GitHub** | Control de versiones |
| **cloudflared** o **ngrok** | Tunel para exponer el Conector local a 11L/Yeastar en pruebas |
| **curl / Postman** | Testeo manual de endpoints |
| **Wireshark / sngrep** | Captura SIP para validar CLI en Fase 4 |

---

## 4. Requisitos de red y hosting

| Requisito | Detalle |
|---|---|
| **IP publica** | El Conector debe ser accesible desde internet (11L y Yeastar lo llaman) |
| **Dominio** | Ej: `connector.midominio.com` |
| **TLS** | Obligatorio — Caddy lo maneja automaticamente con Let's Encrypt |
| **Puertos** | 443 (HTTPS para API/panel), 80 (redirect a HTTPS) |
| **Puertos SIP** (en Yeastar) | 5060 TCP / 5061 TLS + rango RTP dinamico |
| **VPS minimo** | 1 vCPU, 1 GB RAM, 20 GB disco (el servicio es liviano) |

---

## 5. Variables de entorno

```bash
# Servidor
PORT=8080
PUBLIC_BASE_URL=https://connector.midominio.com

# Redis
REDIS_URL=redis://localhost:6379

# Retencion de contexto (debe cubrir espera maxima de cola)
CONTEXT_TTL_SECONDS=900

# Auth: ElevenLabs -> POST /api/context
INGEST_API_KEY=<generar-secreto>

# Auth: Yeastar CRM template -> /crm/*
CRM_API_KEY=<generar-secreto>

# Tokens del panel
PANEL_TOKEN_SECRET=<generar-secreto-hmac>
PANEL_TOKEN_TTL_SECONDS=1800

# Logging
LOG_LEVEL=info
```

---

## 6. Eventos Yeastar relevantes (API WebSocket)

Para la Fase 5 (robustez), el Conector puede suscribirse a eventos via WebSocket:

| Evento | ID | Uso en el proyecto |
|---|---|---|
| **Call State Changed** | 30011 | Trazar `call_id -> extension que atendio` para correlacion avanzada |
| **Call End Details** | 30012 | CDR en tiempo real para trazabilidad |
| **Call Transfer Report** | 30013 | Detectar transferencias (REFER del bot de vuelta) |
| **Incoming Call Request** | 30016 | Detectar llamada entrante en troncal monitoreada |

El evento **30011** devuelve `call_id`, `members[]` con info de extension (`number`, `channel_id`, `member_status`) y llamada inbound/outbound (`from`, `to`, `trunk_name`). Los estados posibles son: `ALERT`, `RING`, `ANSWERED`, `ANSWER`, `HOLD`, `BYE`.

---

## 7. Estructura del template XML (Custom CRM)

El template XML de Yeastar sigue esta jerarquia:

```
<Information Provider="crm" AuthType="none|basic|oauth2|bearer_token" ...>
  <Scenarios>
    <Scenario Id="..." Type="REST">
      <Parameters> ... </Parameters>
      <Requests>
        <Request Name="..." Method="GET|POST" URL="...">
          <Outputs>
            <Output Name="ContactId" Path="data.#.id" />
          </Outputs>
        </Request>
      </Requests>
    </Scenario>
  </Scenarios>
</Information>
```

Para este proyecto, el template necesita:
- **Auth:** Bearer Token con `CRM_API_KEY` como campo de input
- **Contact Match Query URL:** `{{.base_url}}/crm/contacts/search?phone={{.Phone}}`
- **Contact Popup URL:** Retrieve from Contact Fields → `data.#.contact_url`
- **Field Mapping:** `ContactId ← data.#.id`, `FirstName ← data.#.first_name`, `BusinessNumber ← data.#.phone`
- **Call Journal URL (opcional):** `{{.base_url}}/crm/journal` (POST)

---

## 8. Call Flow Designer (alternativa/complemento)

El Call Flow Designer de Yeastar (requiere **Ultimate Plan**, firmware **83.22.0.17+**) ofrece
un componente **HTTP Request** que puede hacer llamadas a APIs externas durante el
flujo de llamada. Variables disponibles:

- `$Session.ani` — numero del llamante (ANI)
- `$Session.did` — numero marcado (DID)
- `$HttpRequest{index}.responseContent` — body de la respuesta
- `$HttpRequest{index}.responseStatusCode` — status code

Esto podria usarse como alternativa al Custom CRM para inyectar el header `X-CALLER-ID`
en la troncal hacia ElevenLabs, o para hacer lookup de contexto directamente desde el
flujo de llamada. Evaluar si aporta valor adicional al flujo CRM ya planificado.

# Agente de ElevenLabs — configuración y calidad de voz

> Config del agente conversacional, por qué cada parámetro está donde está, y cómo tocarlo
> sin romper el flujo de transferencia.
>
> **Agente:** `agent_3901m0dppqc8ehtafxv04kxhyapy` ("Aris - Reino Cerámicos")
> **Fork de:** el conector `voicebot-context-bridge` original (INEBA). Ver diferencia clave
> en §0.

> ⚠️ Este doc es un **fork heredado de INEBA** (29/07/2026), todavía sin recalibrar para
> Reino Cerámicos. Las secciones 2-8 documentan hallazgos genéricos de ElevenLabs que siguen
> aplicando; lo que sí es específico de INEBA (keywords ASR, destino SIP) está marcado abajo
> como pendiente.

---

## 0. Diferencia clave vs. INEBA: discador saliente, no entrante

Este agente **origina** la llamada (herramienta de discado de ElevenLabs) en vez de recibirla
por la troncal SIP de Yeastar. Reino Cerámicos tiene troncal SIP propia hacia Yeastar también
para salientes, así que el **SIP REFER sigue siendo el mecanismo de transferencia** (no hace
falta un dial-out por PSTN). El resto del flujo (`guardar_contexto` → Redis → CRM template en
Linkus) es idéntico al de INEBA.

---

## 1. Config vigente

| Bloque | Parámetro | Valor | Por qué |
|---|---|---|---|
| **LLM** | `llm` | `gemini-3.5-flash` | Comprensión bastante mejor que `2.5-flash` manteniendo la misma clase de latencia. Misma familia = tool calling sin sorpresas. |
| | `temperature` | `0.3` | En `0.0` repetía frases calcadas y sonaba robótico. `0.3` da naturalidad sin volverlo impredecible al elegir herramientas. |
| | `language` | `es` | |
| **TTS** | `model_id` | `eleven_turbo_v2_5` | Modelo de baja latencia. En teléfono la latencia se nota más que el último 10% de calidad. |
| | `optimize_streaming_latency` | `1` | **Era `3`.** El nivel 3 es el principal culpable del "arrastra las palabras". |
| | `stability` | `0.6` | Sube de `0.5`. Menos artefactos de pronunciación. |
| | `speed` | `1.0` | |
| | `similarity_boost` | `0.8` | |
| **ASR** | `provider` | `scribe_realtime` | |
| | `quality` | `high` | |
| | `keywords` | ⚠️ TODO | Heredadas de INEBA (obras sociales/neurociencias), **no aplican a Reino Cerámicos**. Ver §3. |
| **Turn** | `turn_model` | `turn_v3` | |
| | `turn_timeout` | `7.0` s | |

**Herramientas:** `guardar_contexto` (webhook) → `transfer_to_number` (system, `sip_refer`).
El orden importa y está fijado tanto en el prompt como en el `condition` de la herramienta.

---

## 2. Las tres quejas y qué las causaba

Reporte original: *"es medio tosco, no traduce todo bien, no entiende todo de 10, y le cuesta
hablar un poco, arrastra las palabras."*

### "Arrastra las palabras" → `optimize_streaming_latency: 3`

Es el parámetro que decide cuánto sacrifica ElevenLabs de calidad de audio para empezar a
hablar antes. En `3` la degradación de pronunciación es audible. Bajarlo a `1` cuesta unos
50-100 ms y arregla la mayor parte.

### "Medio tosco / repetitivo" → `temperature: 0.0`

Con temperatura cero el modelo emite siempre la formulación más probable, y en una
conversación larga eso se escucha como un robot repitiendo plantillas. En los logs de las
llamadas fallidas se ve clarísimo: la misma frase palabra por palabra ocho veces seguidas.

### "No entiende todo de 10" → ASR sin vocabulario del dominio

El ASR estaba bien configurado (`scribe_realtime`, `quality: high`) pero con `keywords: []`.
Nombres de obras sociales y términos de neurociencias son justo lo que un ASR genérico
transcribe mal.

### 🔑 El hallazgo que no estaba en la lista: el prompt sin acentos

El prompt original estaba escrito **sin ningún acento**: *"Sos un asistente virtual de
atencion al cliente de INEBA, un centro medico"*, *"Necesitas obtener estos datos"*.

El LLM **copia el estilo ortográfico del prompt** y devuelve texto sin acentos. El TTS
pronuncia bastante peor una palabra sin tilde: no sabe dónde cae el acento tónico, y ahí
aparece parte del arrastre.

Se reescribió el prompt entero con ortografía correcta, y se le agregó una sección explícita
de instrucciones de habla. **Puede pesar tanto como el cambio de latencia.**

---

## 3. Keywords del ASR

⚠️ **TODO — pendiente de definir para Reino Cerámicos.** Las de abajo son las de INEBA, quedan
solo como ejemplo del formato (van **sin acentos**, son hints para el reconocedor, no texto
para pronunciar):

```
Obras sociales:  INEBA, OSDE, Swiss Medical, PAMI, IOMA, Medicus, Galeno,
                 OSPRERA, Osecac, Medife, Omint, Avalian, particular
Estudios:        resonancia, tomografia, electroencefalograma, electromiografia
Especialidades:  neurologia, psiquiatria, neurocirugia, neuropsicologia
Gestión:         turno, derivacion, orden medica, estudio
```

Para Reino Cerámicos hay que armar la lista equivalente con su propio vocabulario (productos,
marcas, medidas, zonas de entrega, etc.) a partir de las primeras llamadas reales — mismo
criterio: lo que un ASR genérico transcribe mal.

---

## 4. Sección `CÓMO HABLAR` del prompt

Se agregó antes del flujo. No toca la lógica, solo la forma de hablar:

- Escribir **con acentos** — se aclara explícitamente que el texto se convierte en voz.
- Frases cortas, una sola idea por turno, nunca dos preguntas encadenadas.
- No repetir literal; reformular con otras palabras.
- Números dictados **separados**: "once, cinco cinco cinco cinco, cuatro ocho dos cero",
  no "1155554820".
- Pedir repetición con naturalidad en vez de asumir: *"Perdoná, ¿me lo repetís?"*.
- Repetir para confirmar los datos importantes (nombres, números) si hay duda.
- Tono calmo con pacientes de neurología o psiquiatría, personas mayores y familiares
  angustiados; bajar el ritmo si se nota confusión.

Y una regla nueva de alcance: **no dar información médica, no interpretar síntomas y no
confirmar disponibilidad de turnos.** Tomar los datos y derivar.

---

## 5. Si todavía no alcanza

En orden, del cambio más barato al más caro:

1. **Sigue arrastrando** → `optimize_streaming_latency: 1 → 0`.
2. **Sigue sin alcanzar** → `model_id: eleven_turbo_v2_5 → eleven_multilingual_v2`.
   Es el salto grande de calidad de pronunciación, al precio de ~200-300 ms por respuesta.
3. **Quedó lento** → volver `optimize_streaming_latency` a `2` (revertir esto **primero**,
   antes de tocar el modelo).
4. **Sigue sin entender bien** → sumar keywords al ASR con lo que aparezca en llamadas reales.
5. **Falla el razonamiento, no la voz** → `claude-sonnet-4-5` o `gpt-5.4-mini`.
   Cambia de familia: **reprobar el flujo completo de transferencia** después.

Modelos TTS disponibles, de más rápido a mejor: `eleven_flash_v2_5` → `eleven_turbo_v2_5` →
`eleven_multilingual_v2` → `eleven_v3`.

Para listar los LLM soportados:

```bash
curl -s -X POST -H "xi-api-key: $K" -H "Content-Type: application/json" \
  -d '{"prompt_length":1000,"number_of_pages":0,"rag_enabled":false}' \
  "https://api.elevenlabs.io/v1/convai/llm-usage/calculate"
```

---

## 6. Backups

Están en `backups/` (**gitignoreados**, ver §7). El procedimiento completo de backup y
restore está en [`backups/README.md`](backups/README.md).

Regla: **snapshot antes de tocar nada**, y otro después de que el cambio quede validado.

---

## 7. ⚠️ Los backups tienen secretos

Los snapshots del agente y de las tools incluyen el header de autenticación del webhook:

```json
"request_headers": {"Authorization": "Bearer 7b59cc78...<INGEST_API_KEY>"}
```

**El repo es público.** En `.gitignore`:

```
backups/*.json
!backups/README.md
```

Verificar con `git check-ignore -q <archivo>` antes de commitear, no confiar en que el patrón
esté bien escrito.

---

## 8. Trampas de la API de ElevenLabs

Las cuatro cuestan tiempo y ninguna tiene un mensaje de error obvio.

### `tools` y `tool_ids` no van juntos

```json
{"status":"both_tools_and_tool_ids_provided",
 "message":"Cannot specify both tools and tool IDs - please provide only one of these options."}
```

El `GET` devuelve **ambos** (`tool_ids` con el id del webhook y `tools` con las definiciones
expandidas). Al hacer `PATCH` hay que mandar **solo `tools`**, inline.

### El body del patch tiene que ser UTF-8 explícito

En Windows, `json.dump(..., ensure_ascii=False)` escribe en cp1252 y la API rechaza:

```json
{"type":"invalid_unicode","message":"Request body contains invalid UTF-8 encoding."}
```

Aparece apenas el prompt tiene acentos —o sea, siempre en español. Solución:

```python
json.dump(patch, io.open(path, 'w', encoding='utf-8'), ensure_ascii=False)
```

```bash
curl -X PATCH -H "Content-Type: application/json; charset=utf-8" --data-binary "@patch.json" ...
```

### `built_in_tools` se manda entero o no se manda

Si se incluye parcial, se pierde lo que no viaje. Si no hace falta tocarlo, **omitirlo**: se
conserva solo.

### `system__caller_id` no es el número del cliente en un discador

Encontrado el 15/09/2026 en la primera llamada de prueba real. Ver detalle completo en
`PROJECT.md` §9.3.2. Resumen: en un agente que **origina** la llamada (como este), el dynamic
variable con el número del cliente es **`system__called_number`**, no `system__caller_id`
(ese trae un id interno de canal/troncal, tipo `"10004201"`, que ni parece teléfono). Usar
`system__caller_id` ahí rompe `guardar_contexto` con un `400` silencioso — el agente sigue la
conversación como si nada, dice "tuve un problema técnico" y transfiere sin contexto. No tira
ningún error visible del lado de ElevenLabs; solo se nota mirando el transcript completo de
una llamada real (`GET /v1/convai/conversations/{id}`) y comparando contra los logs 400 del
conector.

---

## 9. Verificación obligatoria post-cambio

Todo el flujo del REFER depende de esto. Después de **cualquier** `PATCH`, confirmar contra
la respuesta de la API:

- [ ] `tools` = `['guardar_contexto', 'transfer_to_number']`
- [ ] destino = `sip:6401@18.231.0.5:10050` (queue 6401, Yeastar P-Series Cloud Edition de
      Reino Cerámicos — **no** la IP de la Yeastar on-prem de INEBA, es infraestructura
      distinta). Confirmado contra el phone number `phnum_4701m1phhr2we3pv4p5g269frxe0`
      ("to_reino") en la API de ElevenLabs, trunk UDP sin auth. `transfer_type` = `sip_refer`
- [ ] webhook = `https://contexto-reino.duckdns.org/api/context` — **todavía no deployado**,
      el LXC/dominio existen en config pero falta el `PATCH` real a la API de ElevenLabs
- [ ] en el prompt, `guardar_contexto` aparece **antes** que la transferencia
- [ ] el prompt conserva los acentos (`'atención' in prompt`)

Y después, **una llamada real**. La config puede quedar perfecta y el flujo romperse igual;
ver [TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md).

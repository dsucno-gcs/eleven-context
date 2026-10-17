# Transferencia SIP REFER — ElevenLabs → Yeastar

> ⚠️ **Fork para Reino Cerámicos.** Este documento es el diagnóstico original hecho para
> INEBA (agente `agent_3001kynj11tvfbq8ezwye94j7rfj`, IP de Yeastar `200.41.236.251`, interno
> `9999`). Se deja tal cual porque **la causa raíz y el arreglo (Qualify Frequency) son
> genéricos de cualquier troncal Yeastar↔ElevenLabs**, no específicos de ese cliente — si la
> transferencia de Reino Cerámicos falla con el mismo síntoma (~35-45 s de cuelgue), empezar
> por acá. Si Reino Cerámicos usa una Yeastar distinta a la de INEBA, el ajuste de §3 hay que
> **repetirlo ahí** (es un setting global de PBX, no viaja con el código ni con este repo).

> **Estado: RESUELTO** (29/07/2026, para INEBA). La transferencia falla o funciona según
> cuánto duró la llamada antes de dispararla. La causa no estaba en la señalización SIP ni en
> el conector, sino en el **timeout de conexión TCP del PBX contra la frecuencia de qualify**.

Este documento existe porque el diagnóstico llevó dos días, produjo tres atribuciones falsas,
y la evidencia que lo cerró es muy fácil de perder. Si la transferencia vuelve a romperse,
**empezá por acá antes de tocar nada**.

---

## 1. El síntoma

El agente conversa normalmente, llama a `transfer_to_number`, y la herramienta se cuelga
**35-45 segundos** antes de devolver:

```json
{"result_type":"transfer_to_number_error","status":"error",
 "error":"twirp error unknown: request timed out","details":null}
```

Cuando funciona, la misma herramienta responde en **2 segundos**. No hay término medio.

Efecto secundario que confunde: **después del intento fallido, el ASR deja de transcribir al
usuario**. Todos los turnos siguientes llegan vacíos y el bot repite "¿seguís ahí?". Es una
**consecuencia** del fallo, no una pista sobre su causa.

---

## 2. La causa raíz

**Yeastar cierra la conexión TCP de señalización 33,0 segundos después del último mensaje
SIP, con la llamada en curso.** El `Qualify Frequency` global estaba en **120 segundos**, así
que la conexión siempre se moría en el hueco entre dos OPTIONS.

Cuando el agente intenta transferir después de ese cierre, **el REFER no llega a salir** —no
hay conexión por dónde mandarlo— y ElevenLabs se queda esperando hasta rendirse con el
timeout de twirp.

### Evidencia (`recursos/capturas/prueba_nueva.pcap`, 366 s de captura)

```
 4.58  SYN → 199.88.252.34:5060 (puerto origen 56129)
 5.63  200 OK + ACK              ← acá arranca el reloj de ElevenLabs (t=0)
22.93  OPTIONS → 200 OK          ← último SIP en esa conexión
56.11  FIN de Yeastar            ← 33,01 s después. La llamada seguía en curso.
143.1  OPTIONS, pero en una conexión NUEVA (puerto 53559)
200.5  BYE en una TERCERA conexión → 481 Call/Transaction Does Not Exist
```

Contra el log de ElevenLabs de la misma llamada:

```
[95s]  >> CALL transfer_to_number
[136s] << RES  twirp error unknown: request timed out
```

**La conexión llevaba ~45 segundos muerta cuando el agente quiso transferir.**

### Los tres hechos que cierran el caso

1. **Cero REFER en toda la captura.** Filtrando `sip.Method=="REFER"` sobre los 581 KB
   completos, sin filtro de IP, no aparece nada. Tampoco aparece `9999` en ningún paquete
   hacia ElevenLabs. La señalización no falla: **no llega a existir**. Yeastar nunca tuvo
   nada que rechazar.

2. **Los 33,0 s se reprodujeron en tres capturas independientes.** No es ruido ni
   coincidencia.

3. **El qualify corría cada 120 s, medido.** Agrupando todos los OPTIONS de la captura por
   destino y sacando los intervalos:

   ```
   intervalos OPTIONS (seg -> veces):
     120.0s -> 100
     120.2s ->   1
   ```

   101 mediciones sobre ~100 dispositivos. Medido, no asumido del default del manual.

### Por qué explica todo el histórico

| transfer disparado a los | resultado |
|---|---|
| 12, 15, 26, 28 s | **OK** |
| 29, 42, 49, 95 s | falla |

Todas las que anduvieron dispararon **dentro** de la ventana; todas las que fallaron,
**después**. El caso que parecía romper la regla —un éxito a los 43 s— encaja igual: el reloj
no corre desde que empieza la llamada sino **desde el último mensaje SIP**, y ahí hubo un
OPTIONS en el medio que lo reseteó.

---

## 3. El arreglo

**`PBX Settings → SIP Settings → General → SIP Endpoint Registration Timer → Qualify Frequency (s)`**

```
120  →  25
```

Manual de referencia: `recursos/manuales/p-series-administrator-guide-software-edition-en.pdf`,
pág. 839:

> **Qualify Frequency (s)** — How often to send SIP OPTIONS packet to SIP device to check if
> the device is up.

### Detalles que importan

- **Es un ajuste global**, no de troncal. En la troncal solo se puede **activar o desactivar**
  el qualify; la frecuencia se define acá y aplica a todas las extensiones y troncales.
- **25 y no 30**, para dejar margen. El OPTIONS tiene que llegar antes de los 33 s; no
  conviene quedar en el borde si hay un reintento o una demora.
- **Impacto despreciable.** ~100 dispositivos a 25 s son unos 4 OPTIONS por segundo, paquetes
  de ~400 bytes. Nada para el PBX.
- **El Qualify de la troncal tiene que quedar activado.** Ya lo estaba —los OPTIONS salían
  hacia `199.88.252.34`—, así que ese toggle no se toca.

### Cómo verificar que quedó aplicado

Con un pcap durante una llamada:

- Los OPTIONS hacia `199.88.252.34` aparecen **cada 25 s**.
- **No hay ningún FIN** desde `172.20.23.1` mientras la llamada está en curso.

Si eso se cumple, la transferencia deja de depender de cuánto habló el paciente.

---

## 4. Lo que NO era la causa

Todo esto está **descartado con evidencia**. No volver sobre estos puntos sin un dato nuevo.

| Sospechoso | Cómo se descartó |
|---|---|
| **`guardar_contexto`** | Cuadro 2×2 completo (llamada corta/larga × con/sin webhook). Falla igual **sin** el webhook en llamada larga, y funciona **con** el webhook en llamada corta. Absuelto en las dos direcciones. |
| **La respuesta `204 No Content`** | El tool result llegaba a 11L como string vacío. Se cambió a `200` + `{"status":"ok",...}` (commit `75b01d8`, desplegado y verificado) y **siguió fallando**. El cambio se dejó porque es correcto, pero no era la causa. |
| **NAT / `Via` con IP privada** | El INVITE sale con `Via: SIP/2.0/TCP 172.20.23.1` (privada) y `Contact: <sip:...@200.41.236.251>` (pública). Parecía impedir que 11L reconectara. Pero **11L no llega ni a intentar reconectar** —no sale un solo byte—, así que el `Via` nunca entra en juego. |
| **Transporte TCP vs UDP** | Falla en ambos. (En UDP el error cambia a `sip status: 408: Request Timeout` en vez de `request timed out`; anotado, sin explicar, pero no cambia el diagnóstico.) |
| **El parámetro `reason`** | Las corridas fallidas que no lo mandaban fallaban igual. |
| **Puertos efímeros** | Irrelevante. |
| **uaCSTA (`application/csta+xml` → 415) y OPTIONS masivos** | Ruido de fondo: barrido CTI y qualify de los internos. |
| **El FQDN `ineba.ras.yeastar.com`** | No sirve para mandar un INVITE directo, solo para registrar. La IP es `200.41.236.251`. No proponerlo como destino del REFER. |

---

## 5. Causa previa, ya resuelta: `phone` vs `sip_uri`

Antes de todo esto había un **segundo bug, distinto**, que conviene no reintroducir.

Con `transfer_destination: {type: "phone"}`, ElevenLabs emite:

```
Refer-To: tel:9999
```

Un URI **pelado, sin host**. Yeastar responde `202 Accepted` y manda un `NOTIFY` con sipfrag
`100 Trying`, pero **nunca rutea la llamada**. Parece que funciona y no funciona.

Por diseño, el modo `phone` **siempre** emite `tel:`. **No volver a `phone`.**

La configuración correcta es:

```json
{
  "transfer_type": "sip_refer",
  "transfer_destination": {
    "type": "sip_uri",
    "sip_uri": "sip:9999@200.41.236.251"
  }
}
```

Con eso el REFER sale bien formado: `202 Accepted` en **1 ms**, `NOTIFY` con sipfrag
`SIP/2.0 200 OK` a los **177 ms**, el interno suena y el caller ID llega correcto.

---

## 6. Trampa del log de ElevenLabs

> `twirp error unknown: request timed out` es **exactamente el mismo mensaje** en dos
> escenarios completamente distintos:
>
> 1. El REFER salió y Yeastar no lo completó.
> 2. 11L no emitió un solo byte.

**Sin pcap no se pueden separar**, y confundirlos manda el diagnóstico para el lado
equivocado. Siempre pedir captura antes de teorizar.

---

## 7. Lección de método

La atribución falsa a `guardar_contexto` duró varias rondas porque la correlación parecía
concluyente: **4/4 sin webhook vs 0/5 con webhook**.

Estaba **contaminada**: todas las llamadas sin webhook eran cortas y todas las que lo tenían
eran largas. La variable real era la duración, y las dos columnas la escondían.

> Cuando dos condiciones siempre co-ocurren, no hay correlación que valga.
> Antes de nombrar un culpable: dibujar el cuadro 2×2 de las dos variables candidatas y
> **correr primero la celda vacía**, aunque parezca redundante. Si falta una celda no hay
> conclusión, hay una corazonada.

La celda que faltaba (llamada larga **sin** webhook) tardó cuatro rondas en correrse. Cuando
se corrió, falló —y cerró el caso en una sola llamada.

Corolario del mismo caso: **medir en vez de asumir defaults**. El intervalo de qualify de
120 s salió de 101 mediciones del pcap, no del manual.

---

## 8. Configuración de referencia (funcionando para INEBA — usar como plantilla, no como valores de Reino Cerámicos)

**Yeastar**
- PBX: Yeastar P-Series Software Edition 83.23.0.83
- IP interna `172.20.23.1` · pública `200.41.236.251`
- `PBX Settings → SIP Settings → General → Qualify Frequency (s)`: **25**
- Qualify de la troncal hacia 11L: **activado**
- Troncal en **TCP**

**ElevenLabs**
- Agente: `agent_3001kynj11tvfbq8ezwye94j7rfj` ("Test Context Bridge")
  > Ojo: `agent_9701kyq3rj84ed68dz1wsv9j5t0g` ("INEBA - Orquestador de entrada") es **otro**
  > agente, no el de este flujo.
- Herramientas: `guardar_contexto` (webhook) + `transfer_to_number` (system)
- Destino: `sip:9999@200.41.236.251` — **es el interno de pruebas de Guido**, falta definir el
  productivo (mismo formato `sip:<destino>@200.41.236.251`)
- Backup del prompt productivo: `backups/elevenlabs_agent_prompt_PROD_backup.json`

**Gotcha de la API de ElevenLabs**

El `PATCH /v1/convai/agents/{id}` rechaza mandar `tools` y `tool_ids` juntos:

```json
{"status":"both_tools_and_tool_ids_provided",
 "message":"Cannot specify both tools and tool IDs - please provide only one of these options."}
```

Mandar **solo `tools`**, con las definiciones inline.

**Conector**
- `POST /api/context` devuelve `200` + `{"status":"ok","message":"Contexto guardado"}`.
  **No volver a `204`**: con un body vacío el tool result le llega al LLM como string vacío.
- Verificado end-to-end: el botón de CRM aparece en Linkus y abre el panel con el contexto
  correcto (`conv_0601kyq3839jft5ays61fbwggshs`).

---

## 9. Apéndice: el pop-up no aparece

Falla distinta a la del REFER, pero se diagnostica en la misma sesión de pruebas y **no
produce ningún error del lado del PBX**. Descartar en este orden:

1. **¿El bloqueador de emergentes del navegador?** ← *fue esto la primera vez.* Chrome bloquea
   el pop-up en silencio: la integración funciona, el contacto matchea, el PBX cree que lo
   abrió, y no se ve nada. **Permitir ventanas emergentes para el dominio de Linkus.**
2. **¿Estás en Linkus?** El pop-up solo existe en Linkus Web Client o Desktop Client, con
   sesión iniciada. Desde un teléfono físico u otro softphone no hay pop-up posible.
3. **¿`Popup Method` está en `Automatically`?** Si está en `Manually` el contexto no salta
   solo, pero aparece un botón de CRM en la ventana de llamada que lo abre.
   `Extension and Trunk → Extension → editar → Linkus Clients`.

**Cómo separar "el pop-up no salta" de "la integración no anda":** si el **botón de CRM**
abre el panel con el contexto correcto, entonces el template, el `contacts/search`, la
correlación por número y el panel funcionan. El problema es solo el disparo automático —
o sea, punto 1 o 3.

---

## 10. Capturas de referencia

Están en `recursos/capturas/` **en local, no en el repo**: llevan números de teléfono
reales, IPs internas y Call-IDs, y el repo es público (ver `.gitignore`). Conviene no
borrarlas: son la única evidencia de los timings y no se pueden reproducir.

| Archivo | Qué muestra |
|---|---|
| `siprefer_test.pcap` | Transferencia **exitosa**. REFER a los 38,5 s → 202 en 1 ms → NOTIFY sipfrag `200 OK` en 177 ms → BYE. Filtrado a puerto 5060. |
| `captura.pcap` | Fallo. Yeastar manda FIN a los 33,0 s exactos del último SIP, con la llamada en curso. |
| `prueba_nueva.pcap` | **La que cerró el caso.** Llamada larga sin `guardar_contexto`. Cero REFER en toda la captura. Los 101 intervalos de qualify de 120 s salen de acá. |

### Comandos útiles

```bash
TS="/c/Program Files/Wireshark/tshark.exe"

# ¿Salió algún REFER? (vacío = no salió ninguno)
"$TS" -r recursos/capturas/prueba_nueva.pcap -Y 'sip.Method=="REFER"' \
      -T fields -e frame.time_relative -e ip.src -e ip.dst

# Timeline SIP con ElevenLabs
"$TS" -r recursos/capturas/prueba_nueva.pcap -Y "sip && ip.addr==199.88.252.0/24" \
      -T fields -e frame.time_relative -e ip.src -e ip.dst \
      -e tcp.srcport -e sip.Method -e sip.Status-Code

# SYN / FIN / RST: ver cuándo se abre y se cierra la conexión
"$TS" -r recursos/capturas/prueba_nueva.pcap \
      -Y "tcp.flags.syn==1 || tcp.flags.fin==1 || tcp.flags.reset==1" \
      -T fields -e frame.time_relative -e ip.src -e ip.dst \
      -e tcp.srcport -e tcp.flags.str | grep 199.88.252
```

Para medir el intervalo real de qualify, agrupar los OPTIONS por IP destino y sacar las
diferencias entre timestamps consecutivos (así salieron los 120,0 s × 101).

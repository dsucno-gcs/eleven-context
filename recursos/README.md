# recursos/

Material de apoyo del proyecto. **Nada de acá se ejecuta ni se importa desde el código** —
son documentos de referencia y evidencia de diagnóstico.

```
recursos/
├─ manuales/     PDFs oficiales de Yeastar          (gitignored: 55 MB)
├─ capturas/     capturas SIP de las pruebas        (gitignored: datos personales)
└─ yeastar/      configuración exportable de la PBX (versionada)
```

## manuales/

| Archivo | Qué es |
|---|---|
| `p-series-administrator-guide-software-edition-en.pdf` | Manual completo de administración (51 MB). La pág. **839** documenta `Qualify Frequency`, el parámetro que rompía la transferencia. |
| `custom-crm-integration-guide-p-series-software-edition-en.pdf` | Guía de la integración Custom CRM: template, GJSON, Call Popup, Call Journal. |

**No están en el repo** — 55 MB no van a un repositorio de código. Se bajan del sitio de
soporte de Yeastar cuando hagan falta.

## capturas/

Capturas de tráfico SIP de las pruebas de transferencia. El análisis completo, con los
comandos `tshark` que se usaron, está en
[../TRANSFERENCIA-SIP-REFER.md](../TRANSFERENCIA-SIP-REFER.md) §10.

| Archivo | Qué muestra |
|---|---|
| `prueba_nueva.pcap` | La que cerró el caso: llamada larga sin `guardar_contexto`, cero REFER en toda la captura. De acá salen los 101 intervalos de qualify de 120 s. |

**No están en el repo, y no deberían estarlo.** Llevan números de teléfono reales de
pacientes, IPs internas y Call-IDs. Son evidencia local, no material publicable.

Si alguna captura se borra, se rehace: `tcpdump -i any -s0 -w captura.pcap port 5060` en la
Yeastar mientras se reproduce el escenario.

## yeastar/

| Archivo | Qué es |
|---|---|
| `yeastar-crm-template.xml` | El template Custom CRM listo para importar en `Integrations → CRM → Custom → Template Management`. Evita rehacer a mano los ~15 campos de mapeo GJSON descritos en PROJECT.md §9.2. |

Este sí está versionado: es texto, no tiene secretos (las claves se cargan al *instalar* el
template, no viven en el XML) y es lo que hay que reimportar en cada PBX nueva.

# Adaptador de CRM genérico

Sirve para sumar al panel del agente los datos del contacto que ya existen en el CRM del cliente
(HubSpot, Zoho, un CRM propio, cualquier API REST con JSON). **No hay que tocar código**: se
configura con un JSON en la variable `CRM_ADAPTER_CONFIG`. Sin esa variable el Conector funciona
exactamente igual que antes.

## Cómo funciona

1. El bot llama a `POST /api/context`. El Conector guarda el contexto y **responde enseguida**.
2. Después, en segundo plano, busca al contacto en el CRM por teléfono y guarda la tarjeta en Redis
   junto al contexto (mismo TTL). Si hay `write`, deja el resumen como nota en el contacto.
3. Cuando la Yeastar consulta `/crm/contacts/search`, el `first_name` ya es el nombre del CRM, y el
   panel muestra la tarjeta **CRM** sin esperar a nada externo.

Si el CRM falla o tarda más que `timeoutMs`, el panel sale igual, sin la tarjeta (queda en el log
como `CRM: fallo`). Si el contacto no existe, no se escribe nada.

## Configuración

```json
{
  "baseUrl": "https://api.crm-del-cliente.com",
  "auth": { "type": "bearer", "value": "${CRM_TOKEN}" },
  "timeoutMs": 1500,
  "headers": { "X-Version": "2" },
  "read": {
    "method": "GET",
    "path": "/contactos?telefono={{phone}}",
    "phoneFormats": ["e164", "national"],
    "pick": "data.0",
    "map": {
      "id": "id",
      "name": "nombre",
      "company": "empresa.nombre",
      "status": "etapa",
      "url": "links.web",
      "extras": { "Vendedor": "owner.nombre" }
    }
  },
  "write": {
    "method": "POST",
    "path": "/contactos/{{crm_id}}/notas",
    "body": { "texto": "{{summary}}", "motivo": "{{intent}}" }
  }
}
```

| Campo | Qué hace |
|---|---|
| `auth.type` | `bearer`, `header` (`name`,`value`), `basic` (`user`,`pass`), `query` (`name`,`value`) o `none` |
| `${VAR}` | Se reemplaza por la variable de entorno `VAR` al arrancar (así el secreto no queda en el JSON). Si falta, el Conector no arranca |
| `read.path` | Ruta de búsqueda por teléfono. Los `{{...}}` se codifican para URL |
| `read.phoneFormats` | Formatos del teléfono a probar en orden hasta encontrarlo: `e164` (`+5491155554820`), `digits` (`5491155554820`), `national` (`91155554820`). `{{phone}}` toma el formato del intento |
| `read.pick` | Ruta (`a.b.0.c`) del contacto dentro de la respuesta. Vacío = la respuesta entera. Si apunta a una lista vacía o no existe → "no encontrado" |
| `read.map` | Rutas de cada dato. Solo `name` es obligatorio. `extras` son pares `etiqueta → ruta` que se muestran en el panel |
| `write` | Opcional. Se ejecuta solo si el contacto existe, una vez por conversación |

Variables disponibles en `read.path` y en `write.path`/`write.body`:
`{{phone}}`, `{{phone_e164}}`, `{{phone_digits}}`, `{{phone_national}}`. Solo en `write`:
`{{crm_id}}`, `{{summary}}`, `{{intent}}`, `{{conversation_id}}`, `{{created_at}}`, `{{fields}}`
(los datos capturados, una línea por campo).

## Notas

- Los datos del CRM se guardan en Redis con el mismo TTL del contexto (15 min por defecto); el
  historial de 90 días **no** los guarda.
- `url` solo se muestra si empieza con `http://` o `https://`.
- Probar antes de desplegar: `pnpm test` incluye un CRM de mentira (`test/crm-adapter.test.ts`) que
  sirve de ejemplo de cada tipo de autenticación.

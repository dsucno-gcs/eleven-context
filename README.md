# eleven-context (GCS Context Bridge)

Conector entre un voicebot de ElevenLabs y los agentes humanos de una central Yeastar P-Series:
el bot guarda un resumen de la conversación (`POST /api/context`) y, cuando la llamada llega al
agente, la Yeastar abre en Linkus un panel con ese resumen (Custom CRM → `/crm/contacts/search`).

- Fastify + Redis, un contenedor por cliente (`ctx-<cliente>`).
- **CRM del cliente (opcional):** adaptador genérico de lectura y escritura configurado por JSON,
  sin código. Ver [docs/CRM-ADAPTER.md](docs/CRM-ADAPTER.md).
- Diseño y decisiones: [PROJECT.md](PROJECT.md). Agente de ElevenLabs: [AGENTE-ELEVENLABS.md](AGENTE-ELEVENLABS.md).
  Transferencia SIP REFER: [TRANSFERENCIA-SIP-REFER.md](TRANSFERENCIA-SIP-REFER.md).
  Template de la Yeastar: [recursos/yeastar/](recursos/yeastar/).

```
pnpm install
pnpm test
pnpm dev        # requiere Redis y un .env (ver .env.example)
```

Origen: derivado de `guidocesa91/reino-ceramicos-context-bridge`.

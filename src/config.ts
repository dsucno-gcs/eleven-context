import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT ?? "8080", 10),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8080",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  contextTtlSeconds: parseInt(process.env.CONTEXT_TTL_SECONDS ?? "900", 10),
  // Historial de interacciones previas (independiente del contexto en curso)
  historyTtlSeconds: parseInt(
    process.env.HISTORY_TTL_SECONDS ?? "7776000", // 90 dias
    10,
  ),
  historyMaxItems: parseInt(process.env.HISTORY_MAX_ITEMS ?? "10", 10),
  ingestApiKey: process.env.INGEST_API_KEY ?? "",
  crmApiKey: process.env.CRM_API_KEY ?? "",
  panelTokenSecret: process.env.PANEL_TOKEN_SECRET ?? "",
  panelTokenTtlSeconds: parseInt(
    process.env.PANEL_TOKEN_TTL_SECONDS ?? "1800",
    10,
  ),
  // JSON del adaptador de CRM (ver docs/CRM-ADAPTER.md). Vacio = sin integracion.
  crmAdapterConfig: process.env.CRM_ADAPTER_CONFIG ?? "",
  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;

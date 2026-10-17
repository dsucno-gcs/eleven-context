export interface ContextPayload {
  caller_number: string;
  conversation_id: string;
  summary: string;
  intent: string;
  fields: Record<string, unknown>;
}

/** Contacto del CRM del cliente, ya mapeado a un formato fijo para el panel. */
export interface CrmCard {
  id: string;
  name: string;
  company?: string;
  status?: string;
  /** Enlace al contacto en el CRM (solo http/https). */
  url?: string;
  /** Campos extra elegidos en la configuracion: etiqueta -> valor. */
  extras: Record<string, string>;
}

export interface StoredContext extends ContextPayload {
  created_at: string;
  /** Presente solo si hay un CRM configurado y se encontro al contacto. */
  crm?: CrmCard;
}

export interface CrmContact {
  id: string;
  first_name: string;
  phone: string;
  contact_url: string;
}

export interface CrmSearchResponse {
  data: CrmContact[];
}

/** Una interacción previa del mismo número, para el historial del panel. */
export interface HistoryEntry {
  conversation_id: string;
  summary: string;
  intent: string;
  fields: Record<string, unknown>;
  created_at: string;
}

export interface PanelData {
  caller_number: string;
  conversation_id: string;
  summary: string;
  intent: string;
  fields: Record<string, unknown>;
  created_at: string;
  crm?: CrmCard;
  /** Interacciones anteriores, de la más reciente a la más vieja. Excluye la actual. */
  history: HistoryEntry[];
  /** Cantidad de interacciones en `history`. */
  history_count: number;
}

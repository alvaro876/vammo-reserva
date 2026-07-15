// Tipos centrais do projeto
// TypeScript "contratos" — se você tentar passar um campo errado, o editor avisa na hora

export type OSStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "AWAITING_MECHANIC"
  | "PAUSED"
  | "IN_QA"
  | "AWAITING_QA"
  | "AWAITING_CX"
  | "COMPLETED"
  | "CANCELED";

export type ReservaDecision = "RESERVA" | "SEM_RESERVA" | "OUT_OF_SCOPE";

// Uma OS vinda do ClickHouse
export interface OS {
  os_id: number;
  placa: string;
  modelo: string;
  so_type: string;
  location_id: number;
  status_atual: OSStatus;
  open_at: string;
  ts_awaiting_mec: string | null;
  min_desde_open: number;
  mecanico_atual: string | null;
  n_pecas_diag: number;
  peca_principal: string | null;
  tempo_estimado_min: number;
}

// Resultado do algoritmo para uma OS
export interface Recomendacao {
  os_id: number;
  decision: ReservaDecision;
  rule_triggered: string | null;
  motivo: string;
  tempo_previsto_min: number | null;
  mecanico_sugerido: string | null;
  tempo_para_inicio_min: number | null;
  metadata: {
    n_pecas_diag: number;
    complexidade_max: number;
    tem_peca_critica: boolean;
    estoque_ok: boolean;
  };
}

// Log salvo no Supabase quando shift leader aceita/rejeita
export interface FeedbackLog {
  os_id: number;
  placa: string;
  decision_algoritmo: ReservaDecision;
  rule_triggered: string | null;
  motivo: string;
  aceitou: boolean; // shift leader acatou a sugestão?
  created_at?: string;
}

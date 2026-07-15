"use client";

import { useEffect, useState, type CSSProperties } from "react";

const BASES: Record<number, string> = { 1: "Mooca", 34: "Osasco", 166: "SBC" };
const MOTIVOS: Record<string, string> = {
  complex_service: "Serviço complexo",
  awaiting_special_service: "Serviço especial",
  workshop_busy: "Oficina cheia",
  awaiting_plate: "Aguardando placa",
  awaiting_part: "Aguardando peça",
  so_opening_error: "Erro de abertura",
  relocation_crack: "Trinca",
};

interface Caso {
  os_id: number;
  placa: string;
  base: number;
  algo_reserva: boolean;
  algo_motivo: string | null;
  algo_ts: number | null;
  oficina_entregue: boolean;
  oficina_ts: number | null;
  motivo_oficina: string;
  antecip_min: number | null;
  tempo_real_min: number | null;
}
interface Resumo {
  n_casos: number;
  n_entregues: number;
  n_algo_reserva: number;
  n_acertos: number;
  recall: number | null;
  precisao: number | null;
  antecip_mediana_min: number | null;
  n_com_antecip: number;
}
interface Dados {
  dias: number;
  resumo: Resumo;
  casos: Caso[];
}

const hhmm = (ts: number | null) =>
  ts
    ? new Date(ts * 1000).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const cardStyle: CSSProperties = {
  flex: "1 1 200px",
  background: "#fff",
  border: "0.5px solid #e2e8f0",
  borderRadius: 12,
  padding: "16px 18px",
};

export default function AcuraciaPage() {
  const [data, setData] = useState<Dados | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    fetch("/api/accuracy")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setErro(true));
  }, []);

  const r = data?.resumo;

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 20px", fontFamily: "system-ui, sans-serif", color: "#0f172a" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Acurácia do RIVERS</h1>
      <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 20px" }}>
        O que o algoritmo sugeriu × o que a oficina fez de verdade (Maestro) — e quem decidiu primeiro. Últimos {data?.dias ?? 7} dias.
      </p>

      {erro && <p style={{ color: "#b91c1c" }}>Erro ao carregar.</p>}
      {!data && !erro && <p style={{ color: "#94a3b8" }}>Carregando…</p>}

      {data && r && (
        <>
          <div style={{ background: "#fffbeb", border: "0.5px solid #fde68a", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#92400e", marginBottom: 16 }}>
            ⏳ O algoritmo começou a registrar em produção em 25/06 — então os números ainda são poucos e vão encorpar a cada dia. Base atual: <b>{r.n_casos}</b> OS que passaram pelo check-in <i>e</i> o algoritmo avaliou.
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 22 }}>
            <Kpi
              label="Reservas que o algoritmo pegou"
              value={r.recall === null ? "—" : `${r.recall}%`}
              hint={`de ${r.n_entregues} entregues pela oficina, pegou ${r.n_acertos}`}
            />
            <Kpi
              label="Precisão"
              value={r.precisao === null ? "—" : `${r.precisao}%`}
              hint={`de ${r.n_algo_reserva} que o algoritmo mandou, ${r.n_acertos} confirmaram`}
            />
            <Kpi
              label="Antecipação"
              value="aguardando cron"
              hint="‘o algoritmo foi mais rápido?’ só fica confiável com o cron rodando — hoje o horário do log não é o momento real da detecção"
            />
          </div>

          <div style={{ overflowX: "auto", border: "0.5px solid #e2e8f0", borderRadius: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f8fafc", textAlign: "left", color: "#475569" }}>
                  <th style={th}>Moto / OS</th>
                  <th style={th}>Base</th>
                  <th style={th}>Algoritmo</th>
                  <th style={th}>Oficina</th>
                  <th style={th}>Antecipação*</th>
                  <th style={th}>Tempo real</th>
                </tr>
              </thead>
              <tbody>
                {data.casos.map((c) => (
                  <tr key={c.os_id} style={{ borderTop: "0.5px solid #f1f5f9" }}>
                    <td style={td}>
                      <b>{c.placa || "—"}</b>
                      <div style={{ color: "#94a3b8", fontSize: 11 }}>OS {c.os_id}</div>
                    </td>
                    <td style={td}>{BASES[c.base] ?? c.base}</td>
                    <td style={td}>
                      {c.algo_reserva ? (
                        <span style={{ color: "#185FA5", fontWeight: 600 }}>RESERVA</span>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>—</span>
                      )}
                      <div style={{ color: "#94a3b8", fontSize: 11 }}>{c.algo_reserva ? hhmm(c.algo_ts) : "não sugeriu"}</div>
                    </td>
                    <td style={td}>
                      {c.oficina_entregue ? (
                        <span style={{ color: "#15803d", fontWeight: 600 }}>entregou</span>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>não deu</span>
                      )}
                      <div style={{ color: "#94a3b8", fontSize: 11 }}>
                        {c.oficina_entregue ? `${MOTIVOS[c.motivo_oficina] ?? c.motivo_oficina} · ${hhmm(c.oficina_ts)}` : ""}
                      </div>
                    </td>
                    <td style={td}><span style={{ color: "#cbd5e1" }}>—</span></td>
                    <td style={td}>{c.tempo_real_min != null ? `${Math.round(c.tempo_real_min / 60)}h` : "em curso"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12.5, color: "#94a3b8", margin: "12px 2px 0" }}>
            <b>Como ler:</b> "pegou" = o algoritmo sugeriu reserva pras motos que a oficina de fato reservou. <b>*Antecipação</b> (o ganho do RIVERS — apontar antes do humano) só vai medir certo depois do <b>cron rodando</b>: hoje o algoritmo só registra quando alguém abre a tela, então o horário do log não é o momento real em que ele detectou. Recall/precisão também são preliminares e encorpam com o cron + dias.
          </p>
        </>
      )}
    </div>
  );
}

const th: CSSProperties = { padding: "10px 12px", fontWeight: 600, fontSize: 12 };
const td: CSSProperties = { padding: "10px 12px", verticalAlign: "top" };

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "#0f172a" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{hint}</div>
    </div>
  );
}

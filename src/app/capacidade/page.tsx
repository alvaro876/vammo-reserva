"use client";

// Tela "Capacidade de mecânicos" — versão pra gestor: linguagem simples,
// indicadores de acerto, gráficos previsto vs real e um quadro explicando a lógica.

import { useEffect, useState, type CSSProperties } from "react";

type Curva = { hora: number; estimado: number; real: number; dia: string };
type Erro = { dia: string; erro: number; real_medio: number };
type Data = { base: string; baseName: string; dia: string | null; curva: Curva[]; erros: Erro[] };

const BASES = [
  { id: "1", nome: "Mooca" },
  { id: "34", nome: "Osasco" },
  { id: "166", nome: "SBC" },
];

function LineChart({
  labels, series, yMax, height = 250,
}: { labels: string[]; series: { color: string; dash?: boolean; points: number[] }[]; yMax: number; height?: number }) {
  const W = 720, H = height, padL = 30, padR = 10, padT = 10, padB = 24;
  const n = labels.length;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (yMax <= 0 ? 0 : (v / yMax) * innerH);
  const ticks = 4;
  const step = Math.max(1, Math.ceil(n / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {Array.from({ length: ticks + 1 }).map((_, k) => {
        const val = (yMax / ticks) * k;
        const yy = y(val);
        return (
          <g key={k}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="rgba(128,128,128,0.18)" />
            <text x={padL - 5} y={yy + 3} textAnchor="end" fontSize="10" fill="#94a3b8">{Math.round(val)}</text>
          </g>
        );
      })}
      {labels.map((lb, i) => (i % step === 0 ? (
        <text key={i} x={x(i)} y={H - 7} textAnchor="middle" fontSize="10" fill="#94a3b8">{lb}</text>
      ) : null))}
      {series.map((s, si) => (
        <polyline key={si} fill="none" stroke={s.color} strokeWidth={2.5}
          strokeDasharray={s.dash ? "6 4" : undefined}
          points={s.points.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      ))}
    </svg>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 13, color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, color: "#0f172a", margin: "2px 0" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>{hint}</div>
    </div>
  );
}

const cardStyle: CSSProperties = { background: "#fff", border: "0.5px solid #e2e8f0", borderRadius: 12, padding: 16 };

export default function Capacidade() {
  const [base, setBase] = useState("1");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);
    fetch(`/api/capacity?base=${base}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
      .then((d) => { if (!cancel) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancel) { setErro(e.message); setLoading(false); } });
    return () => { cancel = true; };
  }, [base]);

  const curva = data?.curva ?? [];
  const errosF = (data?.erros ?? []).filter((e) => e.real_medio >= 8);
  const meanReal = curva.length ? curva.reduce((a, c) => a + c.real, 0) / curva.length : 0;
  const maeTipico = errosF.length ? errosF.reduce((a, e) => a + e.erro, 0) / errosF.length : 0;
  const semDados = errosF.length === 0; // ex.: SBC, volume baixo demais pro corte de >=8
  const acerto = !semDados && meanReal > 0 ? Math.round(100 * (1 - maeTipico / meanReal)) : 0;
  let pico = { hora: 0, real: 0 };
  for (const c of curva) if (c.real > pico.real) pico = { hora: c.hora, real: c.real };
  const yMaxCurva = Math.ceil(Math.max(10, ...curva.flatMap((c) => [c.estimado, c.real])) / 5) * 5;
  const yMaxErro = Math.ceil(Math.max(4, ...errosF.map((e) => e.erro)) / 2) * 2;

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 20px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1e293b" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" }}>Capacidade da oficina — previsão vs. realidade</h1>
      <p style={{ color: "#64748b", fontSize: 15, marginTop: 6, lineHeight: 1.5 }}>
        Quantos mecânicos costumam estar trabalhando em cada hora, por oficina — e o quão perto a previsão fica do que acontece de verdade.
      </p>

      <div style={{ display: "flex", gap: 8, margin: "18px 0" }}>
        {BASES.map((b) => (
          <button key={b.id} onClick={() => setBase(b.id)}
            style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14, cursor: "pointer",
              background: base === b.id ? "#185FA5" : "#fff", color: base === b.id ? "#fff" : "#334155", fontWeight: base === b.id ? 600 : 400 }}>
            {b.nome}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: "#64748b" }}>Carregando…</p>}
      {erro && <p style={{ color: "#b91c1c" }}>Erro: {erro}</p>}

      {!loading && !erro && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 18 }}>
            <Kpi label="Acerto da previsão" value={semDados ? "amostra baixa" : `${acerto}%`} hint={semDados ? "poucos dados nessa base" : "quanto mais perto de 100%, melhor"} />
            <Kpi label="Erro médio" value={semDados ? "—" : `~${maeTipico.toFixed(1)} mec/h`} hint="diferença média entre previsto e real" />
            <Kpi label={`Pico do dia (${data.dia ?? "—"})`} value={`${Math.round(pico.real)} mec`} hint={`por volta das ${pico.hora}h`} />
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 460px", minWidth: 300, display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={cardStyle}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 13, color: "#475569", marginBottom: 6, alignItems: "center" }}>
                  <strong style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>Previsto vs Real por hora</strong>
                  <span style={{ marginLeft: 6 }}><span style={{ display: "inline-block", width: 14, height: 3, background: "#185FA5", verticalAlign: "middle", marginRight: 6 }} />Real ({data.dia})</span>
                  <span><span style={{ display: "inline-block", width: 14, borderTop: "3px dashed #888780", verticalAlign: "middle", marginRight: 6 }} />Previsto</span>
                </div>
                <LineChart labels={curva.map((c) => `${c.hora}h`)} yMax={yMaxCurva}
                  series={[
                    { color: "#185FA5", points: curva.map((c) => c.real) },
                    { color: "#888780", dash: true, points: curva.map((c) => c.estimado) },
                  ]} />
                <p style={{ fontSize: 12.5, color: "#94a3b8", margin: "8px 0 0" }}>Quanto mais as duas linhas se sobrepõem, melhor a previsão. Repare que o vale do almoço e a virada de turno aparecem nas duas.</p>
              </div>

              <div style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 13, color: "#475569", marginBottom: 6 }}>
                  <strong style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>Confiabilidade por dia</strong>
                  <span>{semDados ? "" : `erro típico: ${maeTipico.toFixed(1)} mec/h`}</span>
                </div>
                {semDados ? (
                  <p style={{ fontSize: 13, color: "#94a3b8", padding: "10px 0" }}>Amostra baixa nessa base (poucos mecânicos/dia) — o erro por dia precisa de uma janela maior pra ser confiável.</p>
                ) : (
                  <>
                    <LineChart labels={errosF.map((e) => e.dia.slice(5))} yMax={yMaxErro}
                      series={[{ color: "#185FA5", points: errosF.map((e) => e.erro) }]} height={190} />
                    <p style={{ fontSize: 12.5, color: "#94a3b8", margin: "8px 0 0" }}>O erro do modelo a cada dia. Quanto menor e mais estável, mais confiável a previsão.</p>
                  </>
                )}
              </div>
            </div>

            <aside style={{ flex: "1 1 260px", minWidth: 240, background: "#f1f5f9", border: "0.5px solid #e2e8f0", borderRadius: 12, padding: "18px 20px" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#0f172a", marginBottom: 12 }}>Como funciona</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13.5, color: "#475569", lineHeight: 1.55 }}>
                <div><b style={{ color: "#0f172a" }}>O que é.</b> Um modelo que estima, a partir do histórico, quantos mecânicos costumam estar trabalhando em cada hora — em cada oficina.</div>
                <div><b style={{ color: "#0f172a" }}>Pra que serve.</b> O sistema de moto reserva usa essa estimativa pra prever se a moto do cliente fica pronta a tempo. Oficina cheia e com poucos mecânicos → ele sugere a reserva mais cedo.</div>
                <div><b style={{ color: "#0f172a" }}>Como ler.</b> A linha cheia é o que <b>aconteceu</b> (real); a tracejada é o que o modelo <b>previu</b>. Coladas = previsão boa.</div>
                <div><b style={{ color: "#0f172a" }}>Por que acompanhar.</b> Vendo o erro a cada dia, sabemos quando o modelo precisa de ajuste — pra a sugestão de reserva ficar sempre certeira.</div>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

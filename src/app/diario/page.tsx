// Relatório diário do RIVERS: uma linha por moto que fez check-in no dia, com o que
// o motor fez, a que horas, por qual regra — e, quando calou, POR QUE calou.
//
// REGRA DA TELA (mordeu 3 vezes antes, não repita): a tela fica SEMPRE na mesma
// coisa. Sem rotação, sem paginação, sem auto-scroll, sem redirect e sem perder os
// query params. Trocar de dia atualiza a URL por replaceState, nunca por navegação.
//
// A QUEBRA SEMPRE FECHA: A + B + C + D + E = chegaram, e a lista do "por que não
// pegou" soma exatamente o C. Se não somar, tem bucket OUTRO visível — o relatório
// nunca esconde resto.

"use client";

import { useCallback, useEffect, useState } from "react";

const RECARGA_MS = 5 * 60 * 1000;

interface Linha {
  os_id: number; placa: string; base: number; so_type: string;
  chegou: string; pronta: string; origem_relogio: string;
  dur_min: number; aberta: boolean; estourou: boolean; excesso: number;
  caixa: string; avisou: boolean; a_tempo: boolean;
  regra: string | null; regra_nome: string | null; submotivo: string | null;
  avisou_hora: string; avisou_no_min: number | null; folga_min: number | null;
  est_no_aviso: number | null;
  motivo_nao_pegou: string; detalhe: string;
  status_120: string; est_120: number; exec_120: number; proj_120: number | null; piso_120: number;
  min_conta_fecha: number | null; tiques: number;
  replay_regra: string | null; replay_min: number | null;
  est_fim: number; est_chegou_tarde: number;
  peca_que_puxou: string; peca_que_puxou_min: number; top_pecas: string;
  pecas_depois_do_prazo: string;
  guincho: number; troca_placa: number; n_checkins: number;
  cliente_saiu_no_min: number; cliente_saiu_antes: boolean; virou_o_dia: boolean;
  no_universo: boolean; fora_do_universo: string; recebeu_reserva: boolean; ficou_na_mao: boolean;
  ofertou: number; recusou: number; encerrou: number; motivo_cx: string;
  ofertou_no_min: number | null; entregue: number; status_final: string;
}
interface Diario {
  dia: string; bases: number[]; parcial: boolean; versao: string; gerado_em: string;
  resumo: {
    chegaram: number; fechados: number; ainda_na_oficina: number; estouraram: number;
    estouros_ficou_na_mao: number; estouros_saiu_de_reserva: number;
    estouros_fora_do_universo: number; estouros_total: number;
    avisou: number; avisou_a_tempo: number; avisou_em_cima_da_hora: number;
    alcance: number | null; precisao: number | null;
  };
  caixas: { A: number; B: number; C: number; D: number; E: number };
  porque_nao: { codigo: string; n: number }[];
  conferencia: {
    versoes_no_log: string[]; log_e_de_outra_versao: boolean;
    divergencia_t0: number; replay_sem_log: number; log_sem_replay: number;
    avisos_sem_desfecho_no_dia: number; linhas_de_log: number;
    regras_estruturalmente_tardias: Record<string, number>;
  };
  fora_do_universo: { motivo: string; n: number }[];
  linhas: Linha[];
}

const MOTIVO: Record<string, string> = {
  FORA_DO_ESCOPO: "moto que o motor não avalia",
  GUINCHO: "moto de guincho (o motor foi mandado ignorar)",
  OS_ABERTA_DEPOIS: "a OS foi aberta depois do prazo de aviso",
  SEM_TIQUE: "o motor não chegou a olhar dentro do prazo",
  CLIENTE_JA_SAIU: "o cliente foi embora antes das 2h",
  NUNCA_FOI_PISO: "o cliente nunca constou como esperando na base",
  SEM_DIAGNOSTICO: "às 2h de casa não havia diagnóstico",
  PECA_CHEGOU_TARDE: "a peça entrou depois do prazo de aviso",
  SO_FECHOU_TARDE: "a regra fechou, mas tarde demais",
  COMECOU_RAPIDO: "começou no prazo e a bancada passou da estimativa",
  CONTA_NAO_CHEGOU_LA: "às 2h a conta não chegava no corte",
  OUTRO: "não classificado, investigar",
};
const NOME_BASE: Record<number, string> = { 1: "Mooca", 34: "Osasco", 166: "SBC" };

const BLOCOS = [
  { k: "A", t: "Estourou e o RIVERS pegou a tempo", cor: "ok" as const },
  { k: "C", t: "Estourou e o RIVERS não pegou a tempo", cor: "ruim" as const },
  { k: "B", t: "Não estourou e o RIVERS pegou (alarme falso)", cor: "ink2" as const },
  { k: "E", t: "Ainda na oficina", cor: "ink2" as const },
  { k: "D", t: "Não estourou e o RIVERS calou (certo por omissão)", cor: "ink3" as const },
];

function somaDia(dia: string, d: number): string {
  const t = new Date(`${dia}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

export default function DiarioPage() {
  const [d, setD] = useState<Diario | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [dia, setDia] = useState<string>("");
  const [foco, setFoco] = useState<string | null>(null);

  useEffect(() => {
    const u = new URL(window.location.href);
    setDia(u.searchParams.get("d") ?? "");
  }, []);

  const buscar = useCallback(async (qDia: string) => {
    try {
      const r = await fetch(`/api/diario${qDia ? `?d=${qDia}` : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 401 ? "Sem acesso (401)." : `Erro ${r.status}`);
      setD(await r.json());
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falhou.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    buscar(dia);
    const t = setInterval(() => buscar(dia), RECARGA_MS);
    return () => clearInterval(t);
  }, [buscar, dia]);

  // troca de dia: atualiza a URL PRESERVANDO os outros params, sem navegar
  const trocarDia = (novo: string) => {
    setDia(novo);
    setCarregando(true);
    const u = new URL(window.location.href);
    if (novo) u.searchParams.set("d", novo); else u.searchParams.delete("d");
    window.history.replaceState(null, "", u.toString());
  };

  if (carregando) return <Moldura><p style={S.espera}>Carregando…</p></Moldura>;
  if (erro || !d) return <Moldura><p style={S.espera}>{erro ?? "Sem dados."}</p></Moldura>;

  const r = d.resumo, cx = d.caixas;
  const fecha = cx.A + cx.B + cx.C + cx.D + cx.E;
  const visiveis = foco ? d.linhas.filter((l) => l.caixa === foco) : d.linhas;

  return (
    <Moldura>
      <header style={S.topo}>
        <div>
          <div style={S.selo}>RIVERS · relatório do dia</div>
          <h1 style={S.h1}>O que o RIVERS pegou, e o que não pegou</h1>
        </div>
        <div style={S.janela}>
          {d.dia}
          {d.parcial && <span style={S.parcial}> · parcial, último dado {d.gerado_em}</span>}
          <br />
          base {d.bases.map((b) => NOME_BASE[b] ?? b).join(", ")} · motor {d.versao}
        </div>
      </header>

      <div style={S.filtros}>
        <button style={S.chip} onClick={() => trocarDia(somaDia(d.dia, -1))}>‹ dia anterior</button>
        <button style={{ ...S.chip, ...(dia === "" ? S.chipOn : {}) }} onClick={() => trocarDia("")}>hoje</button>
        <button style={S.chip} onClick={() => trocarDia(somaDia(d.dia, 1))}>dia seguinte ›</button>
        <span style={{ ...S.cmp3s, marginLeft: ".5rem" }}>
          {foco ? `mostrando só o bloco ${foco} · ` : ""}
          {foco && <button style={S.chip} onClick={() => setFoco(null)}>ver todas</button>}
        </span>
      </div>

      <div style={S.cards}>
        <Card n={String(r.chegaram)} rot="motos no dia" sub={`${r.fechados} já saíram + ${r.ainda_na_oficina} ainda na oficina`} />
        <Card n={String(r.estouros_ficou_na_mao)} rot="clientes que ficaram na mão" alerta
              sub={`de ${r.estouros_total} que passaram de 3h: ${r.estouros_saiu_de_reserva} saíram de reserva e ${r.estouros_fora_do_universo} fora do alvo`} />
        <Card n={String(r.avisou_a_tempo)} rot="avisos com 1h de folga" destaque
              sub={`${r.avisou} avisos no total, ${r.avisou_em_cima_da_hora} em cima da hora`} />
        <Card n={r.alcance === null ? "—" : `${r.alcance}%`} rot="dos estouros, pegos a tempo"
              sub={`${cx.A} de ${r.estouraram} · precisão ${r.precisao === null ? "—" : `${r.precisao}%`}`} />
      </div>

      <section style={S.bloco}>
        <h2 style={S.h2}>As quatro caixas</h2>
        <p style={S.cmp3s}>
          A + B + C + D + E = {fecha}
          {fecha !== r.chegaram && <b style={{ color: C.ruim }}> (não fecha com {r.chegaram}, há erro)</b>}
        </p>
        <div style={S.comparaTres}>
          {BLOCOS.map((b) => (
            <button key={b.k} style={{ ...S.cmp3, cursor: "pointer", textAlign: "left",
                       ...(foco === b.k ? { borderColor: C.azul, background: C.azulLav } : {}) }}
                    onClick={() => setFoco(foco === b.k ? null : b.k)}>
              <div style={{ ...S.cmp3N, color: C[b.cor] }}>{cx[b.k as keyof typeof cx]}</div>
              <div style={S.cmp3s}>{b.k} · {b.t}</div>
            </button>
          ))}
        </div>
      </section>

      {d.fora_do_universo.length > 0 && (
        <section style={S.bloco}>
          <h2 style={S.h2}>Quem fica fora da conta, e por quê</h2>
          <p style={S.rodape}>
            O alcance divide pelos estouros em que a moto reserva resolve. Estes não entram,
            porque não existe aviso que os resolva:
          </p>
          {d.fora_do_universo.map((f) => (
            <div key={f.motivo} style={S.ins}>
              <div style={S.insN}>{f.n}</div>
              <div>{f.motivo}</div>
            </div>
          ))}
          <p style={{ ...S.cmp3s, marginTop: ".5rem" }}>
            {r.estouros_total} que passaram de 3h = {r.estouros_ficou_na_mao} ficaram na mão
            + {r.estouros_saiu_de_reserva} saíram de reserva + {r.estouros_fora_do_universo} fora do alvo.
          </p>
        </section>
      )}

      {d.porque_nao.length > 0 && (
        <section style={S.bloco}>
          <h2 style={S.h2}>Por que o RIVERS não pegou os {cx.C} que estouraram</h2>
          {d.porque_nao.map((m) => (
            <div key={m.codigo} style={S.ins}>
              <div style={S.insN}>{m.n}</div>
              <div>
                <b>{MOTIVO[m.codigo] ?? m.codigo}</b>
                <div style={S.cmp3s}>
                  {d.linhas.filter((l) => l.caixa === "C" && l.motivo_nao_pegou === m.codigo)
                    .slice(0, 3).map((l) => l.placa).join(", ")}
                </div>
              </div>
            </div>
          ))}
          <p style={{ ...S.cmp3s, marginTop: ".5rem" }}>
            Soma {d.porque_nao.reduce((a, m) => a + m.n, 0)} de {cx.C}.
          </p>
        </section>
      )}

      {d.conferencia.log_e_de_outra_versao && d.conferencia.replay_sem_log > 0 && (
        <section style={{ ...S.bloco, borderColor: C.azul }}>
          <h2 style={{ ...S.h2, color: C.azul }}>Neste dia o motor no ar era outro</h2>
          <p style={S.rodape}>
            O log deste dia é da versão {d.conferencia.versoes_no_log.join(", ")}, e o replay roda
            sempre com as regras de hoje ({d.versao}). Em <b>{d.conferencia.replay_sem_log}</b> motos
            as regras de hoje teriam avisado a tempo e o motor daquele dia não avisou. É o ganho das
            regras novas medido neste dia, não erro do relatório.
          </p>
        </section>
      )}

      {((!d.conferencia.log_e_de_outra_versao && d.conferencia.replay_sem_log > 0)
        || d.conferencia.divergencia_t0 > 0 || d.conferencia.log_sem_replay > 0) && (
        <section style={{ ...S.bloco, borderColor: C.ruim }}>
          <h2 style={{ ...S.h2, color: C.ruim }}>Conferência do próprio relatório</h2>
          <p style={S.rodape}>
            {!d.conferencia.log_e_de_outra_versao && d.conferencia.replay_sem_log > 0 && (
              <>Em <b>{d.conferencia.replay_sem_log}</b> motos o replay diz que uma regra fechava a
                tempo e não existe linha no log, rodando a mesma versão. Ou o motor não olhou
                naquele minuto, ou o replay está errado. Vale abrir uma.<br /></>
            )}
            {d.conferencia.log_sem_replay > 0 && (
              <>Em <b>{d.conferencia.log_sem_replay}</b> motos o log tem aviso a tempo e o replay não
                reproduz. Costuma ser peça apagada depois ou estado que o ClickHouse não guarda.<br /></>
            )}
            {d.conferencia.divergencia_t0 > 0 && (
              <>Em <b>{d.conferencia.divergencia_t0}</b> motos o relógio que o motor gravou não bate
                com o daqui por mais de 3 min: as duas contas partem de origens diferentes.</>
            )}
          </p>
        </section>
      )}

      <section style={S.bloco}>
        <h2 style={S.h2}>Uma linha por moto</h2>
        {BLOCOS.filter((b) => !foco || foco === b.k).map((b) => {
          const ls = visiveis.filter((l) => l.caixa === b.k);
          if (!ls.length) return null;
          return (
            <div key={b.k} style={{ marginBottom: "1.2rem" }}>
              <h3 style={{ ...S.subtit, color: C[b.cor], marginTop: ".8rem" }}>
                {b.k} · {b.t} <span style={S.dimT}>({ls.length})</span>
              </h3>
              <div style={{ overflowX: "auto" }}>
                <table style={S.tab}>
                  <thead><tr>
                    <th style={S.th}>placa</th><th style={S.th}>horas</th><th style={S.thR}>ficou</th>
                    <th style={S.th}>o RIVERS</th><th style={S.thR}>folga</th>
                    <th style={S.th}>por que não pegou</th>
                    <th style={S.th}>no minuto 120</th><th style={S.th}>peça que puxou</th>
                    <th style={S.th}>o CX</th>
                  </tr></thead>
                  <tbody>
                    {ls.map((l) => (
                      <tr key={l.os_id} style={l.ofertou && (l.ofertou_no_min ?? 999) <= 60 ? { background: C.okLav } : undefined}>
                        <td style={{ ...S.td, fontFamily: C.mono }}>
                          {l.placa}{l.guincho ? " 🚛" : ""}{l.troca_placa ? " 🔖" : ""}
                          {l.n_checkins > 1 ? ` ·${l.n_checkins}` : ""}
                          {l.virou_o_dia && <div style={S.cmp3s}>virou o dia</div>}
                          {l.cliente_saiu_antes && !l.virou_o_dia &&
                            <div style={S.cmp3s}>cliente saiu aos {l.cliente_saiu_no_min}</div>}
                        </td>
                        <td style={{ ...S.td, fontFamily: C.mono, fontSize: ".72rem" }}>
                          {l.chegou}{l.pronta ? ` → ${l.pronta}` : " → …"}
                        </td>
                        <td style={{ ...S.tdR, fontWeight: 700,
                                     color: l.dur_min > 240 ? C.ruim : l.estourou ? C.ruim : C.ink }}>
                          {l.aberta ? "em aberto" : `${l.dur_min} min`}
                        </td>
                        <td style={S.td}>
                          {l.avisou
                            ? <><b style={{ color: C.azul }}>{l.regra_nome}</b>
                                <div style={S.cmp3s}>{l.avisou_hora} · min {l.avisou_no_min}{l.submotivo ? ` · ${l.submotivo}` : ""}</div></>
                            : <span style={{ color: C.ink3 }}>calou</span>}
                        </td>
                        <td style={{ ...S.tdR, fontWeight: 700,
                                     color: l.folga_min === null ? C.ink3 : l.folga_min >= 60 ? C.ok : C.ruim }}>
                          {l.folga_min === null ? "—" : `${l.folga_min > 0 ? "+" : ""}${l.folga_min} min`}
                        </td>
                        <td style={{ ...S.td, maxWidth: 320 }}>
                          {l.motivo_nao_pegou
                            ? <><b>{MOTIVO[l.motivo_nao_pegou] ?? l.motivo_nao_pegou}</b>
                                <div style={S.cmp3s}>{l.detalhe}</div></>
                            : <span style={{ color: C.ink3 }}>—</span>}
                        </td>
                        <td style={{ ...S.td, fontFamily: C.mono, fontSize: ".7rem", color: C.ink2 }}>
                          {l.status_120}<br />exec {l.exec_120} · est {l.est_120} · conta {l.proj_120 ?? "—"}
                          {l.min_conta_fecha !== null && <><br />fecha aos {l.min_conta_fecha} min</>}
                        </td>
                        <td style={{ ...S.td, fontSize: ".74rem" }}>
                          {l.peca_que_puxou
                            ? <>{l.peca_que_puxou} <b>({l.peca_que_puxou_min}min)</b>
                                <div style={S.cmp3s}>estimativa final {l.est_fim} min
                                  {l.est_chegou_tarde > 0 && <> · <b style={{ color: C.ruim }}>+{l.est_chegou_tarde} min entraram depois das 2h</b></>}
                                </div></>
                            : <span style={{ color: C.ink3 }}>sem peça lançada</span>}
                        </td>
                        <td style={{ ...S.td, fontSize: ".74rem" }}>
                          {l.entregue ? <b style={{ color: C.ok }}>entregou reserva</b>
                            : l.recusou ? "cliente recusou"
                            : l.ofertou ? "ofertou" : <span style={{ color: C.ink3 }}>—</span>}
                          {l.ofertou_no_min !== null && <div style={S.cmp3s}>min {l.ofertou_no_min}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </section>

      <section style={S.bloco}>
        <h2 style={S.h2}>Como este relatório é montado</h2>
        <p style={S.rodape}>
          Uma linha por moto que fez <b>check-in</b> no dia nas bases do piloto. O relógio conta
          desde a chegada do cliente quando existe check-in até 4h antes da abertura da OS, senão
          desde a abertura — a mesma régua do <code>min_desde_chegada</code> que o motor usa.
          &ldquo;Pronta&rdquo; é o primeiro <code>AWAITING_CX</code>. Estouro é passar de 180 min.
        </p>
        <p style={S.rodape}>
          O <b>minuto 120</b> é o último instante em que um aviso ainda teria 1h de antecedência,
          que é o mínimo pra buscar e entregar uma reserva. Por isso a coluna &ldquo;por que não
          pegou&rdquo; mede tudo nesse instante: é ali que a pergunta &ldquo;dava pra avisar a
          tempo?&rdquo; tem resposta.
        </p>
        <p style={S.rodape}>
          O estado de cada moto é reconstruído minuto a minuto do ClickHouse e as regras rodam de
          novo em cima dele, chamando a <b>mesma função que decide na tela</b> (<code>avaliarOS</code>,
          motor {d.versao}) numa grade de 10 min entre 7h e 21h, que é quando o motor roda. Mudou um
          limiar no motor, este relatório muda junto.
        </p>
        <p style={S.rodape}>
          Três regras do conjunto são <b>estruturalmente tardias</b>: elas só acordam em um relógio
          que já não deixa 1h de folga ({Object.entries(d.conferencia.regras_estruturalmente_tardias)
            .map(([k, v]) => `${k} aos ${v} min`).join(", ")}). Quando uma moto cai nelas, o
          relatório não chama de falha de calibração.
        </p>
        <p style={S.rodape}>
          <b>Onde este número pode divergir do painel /kpi:</b> aqui entram todas as motos, inclusive
          as que ainda não ficaram prontas e as que viraram o dia, que o /kpi descarta; e aqui a
          população não filtra por tipo de OS. Conferido em 10/09: a estimativa reconstruída bate
          exatamente com a que o motor gravou em 141 de 151 casos (93,4%); as 10 diferenças são
          todas no mesmo sentido (a reconstrução enxerga a peça alguns segundos antes do motor) e
          8 delas em OS que estavam em diagnóstico, que é justamente quando o mecânico está
          lançando peça. Avisos sem desfecho neste dia: {d.conferencia.avisos_sem_desfecho_no_dia}.
        </p>
      </section>
    </Moldura>
  );
}

function Moldura({ children }: { children: React.ReactNode }) {
  return <div style={S.fundo}><div style={S.folha}>{children}</div></div>;
}

function Card({ n, rot, sub, destaque, alerta }: {
  n: string; rot: string; sub: string; destaque?: boolean; alerta?: boolean;
}) {
  return (
    <div style={{ ...S.card, ...(destaque ? { borderColor: C.azul } : {}) }}>
      <div style={{ ...S.cardN, color: alerta ? C.ruim : destaque ? C.azul : C.ink }}>{n}</div>
      <div style={S.cardRot}>{rot}</div>
      <div style={S.cardSub}>{sub}</div>
    </div>
  );
}

const C = {
  fundo: "#F1F5F9", papel: "#FFFFFF", ink: "#0F172A", ink2: "#475569", ink3: "#94A3B8",
  linha: "#E2E8F0", azul: "#0B3B8C", azul2: "#1E6FB8", azulLav: "#EAF2FA",
  okLav: "#E9F6EE", ok: "#15803D", ruim: "#B91C1C",
  mono: "ui-monospace, 'Cascadia Code', Consolas, monospace",
};

const S: Record<string, React.CSSProperties> = {
  fundo: { background: C.fundo, minHeight: "100vh", padding: "1.75rem 1rem 3rem",
           fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", color: C.ink },
  folha: { maxWidth: 1400, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1.1rem" },
  espera: { textAlign: "center", color: C.ink3, padding: "4rem 0", fontSize: "1rem" },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-end",
          gap: "1rem", flexWrap: "wrap", borderBottom: `2px solid ${C.azul}`, paddingBottom: ".6rem" },
  selo: { fontFamily: C.mono, fontSize: ".68rem", letterSpacing: ".14em", textTransform: "uppercase",
          color: C.azul, fontWeight: 600 },
  h1: { fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-.03em", margin: ".2rem 0 0" },
  h2: { fontSize: "1rem", fontWeight: 700, margin: "0 0 .5rem" },
  janela: { fontFamily: C.mono, fontSize: ".74rem", lineHeight: 1.6, textAlign: "right", color: C.ink2 },
  filtros: { display: "flex", flexWrap: "wrap", gap: ".4rem", alignItems: "center" },
  chip: { fontFamily: "inherit", fontSize: ".78rem", fontWeight: 600, padding: ".38rem .7rem",
          borderRadius: 6, border: `1px solid ${C.linha}`, background: C.papel, color: C.ink2,
          cursor: "pointer", lineHeight: 1.2 },
  chipOn: { background: C.azul, borderColor: C.azul, color: "#FFFFFF" },
  parcial: { fontSize: ".74rem", color: C.ruim, fontWeight: 600 },
  bloco: { background: C.papel, border: `1px solid ${C.linha}`, borderRadius: 8, padding: "1rem 1.1rem" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: ".75rem" },
  card: { background: C.papel, border: `1px solid ${C.linha}`, borderRadius: 8, padding: ".9rem 1rem" },
  cardN: { fontFamily: C.mono, fontSize: "2.15rem", fontWeight: 700, letterSpacing: "-.045em", lineHeight: 1 },
  cardRot: { fontSize: ".82rem", fontWeight: 700, marginTop: ".35rem" },
  cardSub: { fontSize: ".72rem", color: C.ink3, lineHeight: 1.35, marginTop: ".15rem" },
  comparaTres: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                 gap: ".7rem", margin: ".2rem 0 .2rem" },
  cmp3: { border: `1px solid ${C.linha}`, borderRadius: 8, padding: ".75rem .85rem", background: C.fundo },
  cmp3N: { fontFamily: C.mono, fontSize: "1.7rem", fontWeight: 700, lineHeight: 1, letterSpacing: "-.04em" },
  cmp3s: { fontSize: ".72rem", color: C.ink3, lineHeight: 1.35 },
  subtit: { fontSize: ".82rem", fontWeight: 700, margin: "0 0 .45rem" },
  dimT: { fontWeight: 400, color: C.ink3 },
  ins: { display: "grid", gridTemplateColumns: "3.2rem 1fr", gap: ".8rem", alignItems: "start",
         padding: ".45rem 0", borderBottom: `1px solid ${C.linha}`, fontSize: ".86rem" },
  insN: { fontFamily: C.mono, fontSize: "1.5rem", fontWeight: 700, lineHeight: 1, textAlign: "right" },
  tab: { width: "100%", borderCollapse: "collapse", fontSize: ".8rem" },
  th: { textAlign: "left", fontWeight: 700, fontSize: ".7rem", textTransform: "uppercase",
        letterSpacing: ".04em", color: C.ink3, padding: ".35rem .5rem", borderBottom: `1px solid ${C.linha}` },
  thR: { textAlign: "right", fontWeight: 700, fontSize: ".7rem", textTransform: "uppercase",
         letterSpacing: ".04em", color: C.ink3, padding: ".35rem .5rem", borderBottom: `1px solid ${C.linha}` },
  td: { padding: ".4rem .5rem", borderBottom: `1px solid ${C.linha}`, verticalAlign: "top" },
  tdR: { padding: ".4rem .5rem", borderBottom: `1px solid ${C.linha}`, textAlign: "right", verticalAlign: "top" },
  rodape: { fontSize: ".78rem", color: C.ink2, lineHeight: 1.55, margin: "0 0 .6rem" },
};

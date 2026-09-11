// Painel de KPI do piloto RIVERS.
//
// REGRA DA TELA (mordeu 3 vezes antes, não repita): a tela fica SEMPRE na mesma
// coisa. Sem rotação de painel, sem paginação, sem auto-scroll, sem redirect, e
// sem perder os query params. Só recarrega os números no lugar.
//
// Cores: os azuis das telas do RIVERS (#0B3B8C / #1E6FB8), já usados no /cx.

"use client";

import { useCallback, useEffect, useState } from "react";

const RECARGA_MS = 5 * 60 * 1000;

interface Topo {
  clientes: number; estouros: number; taxa_estouro: number | null;
  avisos: number; precisao: number | null; alcance: number | null;
  adesao: number | null; entregas: number; ofertas: number; recusas: number;
  escapes: number; folga_mediana: number | null; excesso_mediano: number | null;
}
interface Faixa { faixa: string; n: number }
interface Kpi {
  janela: { de: string; ate: string; dias: number; bases: number[]; preset: string; parcial: boolean; inicio_piloto: string };
  topo: Topo;
  funil: { etapa: string; n: number; de: number; de_nome: string; perdeu: number; perda: string }[];
  funil_nota?: string;
  desfecho_da_oferta: { desfecho: string; n: number; nota: string }[];
  seguidas: { situacao: string; n: number }[];
  submotivos: { regra: string; nome: string; submotivo: string; submotivo_nome: string; avisos: number; estourou: number; precisao: number | null; ofertou: number; espera_mediana: number | null }[];
  tempo_checkin_ate_aviso: { mediana: number | null; n: number; faixas: Faixa[] };
  tempo_aviso_ate_oferta: { mediana: number | null; n: number; cx_veio_antes: number; faixas: Faixa[] };
  antecedencia_por_atraso: { faixa: string; avisos: number; folga_mediana: number | null; em_cima_da_hora: number; com_tempo_util: number; pct_util: number | null; ofertou: number; entregue: number }[];
  sem_aviso_detalhe: {
    total: number; cx_ofertou: number; passou_em_branco: number;
    mediana_checkin_ate_oferta: number | null;
    mediana_rivers_avisa: number | null;
    mediana_checkin_ate_oferta_com_aviso: number | null;
    faixas: Faixa[];
    casos: { placa: string; os_id: number; dia: string; cx_ofertou_em: number | null; motivo_cx: string; ficou_min: number; excesso: number; entregue: boolean; recusou: boolean }[];
    em_branco: { placa: string; os_id: number; dia: string; ficou_min: number; excesso: number }[];
  };
  estimado_vs_real: { n: number; estimado_mediano: number | null; real_mediano: number | null; erro_mediano_pct: number | null; subestimou: number; superestimou: number };
  insights: { n: number; texto: string; detalhe: string; tom: string }[];
  magnitude: { faixa: string; casos: number; ofertou: number; taxa: number | null; ic_lo: number; ic_hi: number; entregue: number }[];
  caixas: { caixa: string; casos: number; ofertou: number; entregue: number; recusou: number; taxa_oferta: number | null }[];
  motivos: { regra: string; nome: string; avisos: number; estourou: number; errou: number; precisao: number | null; ofertou: number; entregue: number; folga_mediana: number | null; excesso_mediano: number | null }[];
  motivo_do_cx: { motivo: string; n: number }[];
  dia_a_dia: { dia: string; clientes: number; estouros: number; avisos: number; acertos: number; precisao: number | null; alcance: number | null; ofertas: number; entregas: number }[];
  gerado_em: string;
  error?: string;
}

const dia = (s: string) => {
  const [a, m, d] = s.split("-");
  return `${d}/${m}${a ? "" : ""}`;
};
const num = (n: number | null, suf = "") => (n === null ? "—" : `${String(n).replace(".", ",")}${suf}`);

// Presets de janela. Ficam na URL (?j=) para a TV não perder a escolha ao recarregar.
const PRESETS = [
  { id: "tudo", rot: "Desde 13/08" },
  { id: "7d", rot: "7 dias" },
  { id: "semana", rot: "Esta semana" },
  { id: "semana_ant", rot: "Semana passada" },
  { id: "ontem", rot: "Ontem" },
  { id: "hoje", rot: "Hoje" },
  { id: "tudo_hoje", rot: "Tudo + hoje" },
];

export default function PainelKpi() {
  const [d, setD] = useState<Kpi | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [preset, setPreset] = useState("tudo");

  // lê o preset da URL na entrada, sem redirecionar nem limpar outros params
  useEffect(() => {
    const j = new URLSearchParams(window.location.search).get("j");
    if (j && PRESETS.some((p) => p.id === j)) setPreset(j);
  }, []);

  const buscar = useCallback(async (p: string) => {
    try {
      const r = await fetch(`/api/kpi?j=${encodeURIComponent(p)}`, { cache: "no-store" });
      const j = (await r.json()) as Kpi;
      if (j.error) setErro(j.error);
      else { setD(j); setErro(null); }
    } catch {
      setErro("Não consegui carregar os dados.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    buscar(preset);
    const t = setInterval(() => buscar(preset), RECARGA_MS);
    return () => clearInterval(t);
  }, [buscar, preset]);

  // troca de janela: atualiza a URL PRESERVANDO os outros params (a TV mantém o
  // que já estava lá) e sem recarregar a página
  const trocarJanela = (p: string) => {
    setPreset(p);
    setCarregando(true);
    const u = new URL(window.location.href);
    u.searchParams.set("j", p);
    window.history.replaceState(null, "", u.toString());
  };

  if (carregando) return <Moldura><p style={S.espera}>Carregando…</p></Moldura>;
  if (erro || !d) return <Moldura><p style={S.espera}>{erro ?? "Sem dados."}</p></Moldura>;

  const t = d.topo;

  return (
    <Moldura>
      <header style={S.topo}>
        <div>
          <div style={S.selo}>RIVERS · painel do piloto</div>
          <h1 style={S.h1}>Como o RIVERS está indo</h1>
        </div>
        <div style={S.janela}>
          <b>{dia(d.janela.de)} a {dia(d.janela.ate)}</b><br />
          {d.janela.dias} {d.janela.dias === 1 ? "dia" : "dias"} com movimento<br />
          <span style={{ color: C.ink3 }}>
            base {d.janela.bases.join(", ")} · {t.clientes} clientes
          </span>
        </div>
      </header>

      {/* ── filtros de janela ─────────────────────────────────────────── */}
      <div style={S.filtros}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => trocarJanela(p.id)}
            style={{ ...S.chip, ...(preset === p.id ? S.chipOn : {}) }}
          >
            {p.rot}
          </button>
        ))}
        {d.janela.parcial && (
          <span style={S.parcial}>
            inclui hoje — o dia ainda está entrando, os números sobem durante o turno
          </span>
        )}
      </div>

      {/* ── os quatro números que resumem ─────────────────────────────── */}
      <div style={S.cards}>
        {/* contagem ABSOLUTA primeiro (01/09, pergunta do Guida: "só teve isso de
            sugestões?" — ele procurou o nº de avisos e só achou percentuais; o
            "302 no canto" é a população de clientes, não sugestão) */}
        <Card
          n={String(t.avisos)} rot="Avisos do RIVERS"
          sub={`sugestões de reserva por SLA com cliente na base — em ${t.clientes} clientes atendidos`} destaque
        />
        <Card
          n={num(t.precisao, "%")} rot="Precisão do aviso"
          sub={`${d.caixas[0].casos} de ${t.avisos} avisos estouraram de fato`}
        />
        <Card
          n={num(t.alcance, "%")} rot="Alcance"
          sub={`dos ${t.estouros} estouros, o RIVERS viu ${d.caixas[0].casos}`} alerta
        />
        <Card
          n={num(t.adesao, "%")} rot="Adesão do CX"
          sub={`ofertou reserva em ${d.caixas[0].ofertou} dos ${d.caixas[0].casos} avisos certos`}
        />
        <Card
          n={String(t.recusas)} rot="Clientes que recusaram"
          sub={`de ${t.ofertas} ofertas feitas no período`} alerta
        />
        <Card
          n={String(t.escapes)} rot="Passou em branco"
          sub="estourou com o RIVERS calado e sem ninguém ofertar reserva" alerta
        />
      </div>

      {/* ── desfecho da oferta: a pergunta "quantas o cliente recusou?" ──── */}
      <Bloco
        titulo="O que aconteceu com cada reserva ofertada"
        nota={`as ${t.ofertas} ofertas do período — recusa é cancelamento de operador com a moto ainda longe de pronta; não confundir com o sistema encerrando quando a moto fica pronta`}
      >
        {d.desfecho_da_oferta.map((f) => (
          <div key={f.desfecho} style={S.fl}>
            <span style={S.flNome}>{f.desfecho}<br /><small style={{ color: C.ink3 }}>{f.nota}</small></span>
            <div style={S.trilha}>
              <i style={{ ...S.preenche, width: `${t.ofertas ? (100 * f.n) / t.ofertas : 0}%`,
                          background: /reserva/.test(f.desfecho) ? C.ok
                                    : /recusou/.test(f.desfecho) ? C.ruim : C.ink3 }} />
            </div>
            <span style={S.flN}>
              {f.n}
              <small style={S.flPct}>{t.ofertas ? `${Math.round((100 * f.n) / t.ofertas)}%` : ""}</small>
            </span>
          </div>
        ))}
      </Bloco>

      {/* ── insights ─────────────────────────────────────────────────── */}
      <Bloco titulo="O que salta aos olhos" nota="lido direto da tabela, sem interpretação minha">
        {d.insights.map((i) => (
          <div key={i.texto} style={S.ins}>
            <span style={{ ...S.insN, color: i.tom === "ruim" ? C.ruim : C.azul }}>{i.n}</span>
            <span>
              <b>{i.texto}</b>
              {i.detalhe && <><br /><small style={{ color: C.ink2 }}>{i.detalhe}</small></>}
            </span>
          </div>
        ))}
      </Bloco>

      <div style={S.duas}>
        {/* ── funil ───────────────────────────────────────────────────── */}
        <Bloco titulo="O caminho de um estouro"
               nota="cada linha é um subconjunto da anterior; o % diz de quem é. Onde o caminho afunila é onde o processo perde o cliente.">
          {d.funil.map((f, i) => (
            <div key={f.etapa}>
              {i > 0 && f.perdeu > 0 && (
                <div style={{ fontSize: 11, color: C.ink3, margin: "2px 0 2px 8px" }}>
                  ↳ −{f.perdeu} {f.perda}
                </div>
              )}
              <div style={S.fl}>
                <span style={S.flNome}>{f.etapa}</span>
                <div style={S.trilha}>
                  <i style={{ ...S.preenche, width: `${f.de ? (100 * f.n) / f.de : 0}%`,
                              background: i === 0 ? C.ink3 : i >= 4 ? C.ok : C.azul }} />
                </div>
                <span style={S.flN}>
                  {f.n}
                  <small style={S.flPct}>{i === 0 ? "100%" : f.de ? `${Math.round((100 * f.n) / f.de)}% ${f.de_nome}` : ""}</small>
                </span>
              </div>
            </div>
          ))}
          <p style={{ fontSize: 11, color: C.ink3, marginTop: 8 }}>
            Da 3ª linha em diante o % é sobre os avisados, não sobre a linha de cima. Ex.: entregas ÷ avisados.
            {d.funil_nota ? <><br />{d.funil_nota}</> : null}
          </p>
        </Bloco>

        {/* ── magnitude (pergunta do Guida) ───────────────────────────── */}
        <Bloco
          titulo="Quanto mais a moto atrasa, mais tempo o CX tem para ofertar"
          nota={`os ${d.magnitude.reduce((a, m) => a + m.casos, 0)} avisos do RIVERS, pelo tamanho do estouro. A taxa sobe com o atraso porque a janela para agir é maior, não porque alguém prevê o atraso. Faixa com poucos casos = intervalo largo.`}
        >
          <table style={S.tab}>
            <thead>
              <tr>
                <th style={S.th}>Quanto estourou</th>
                <th style={S.thR}>Avisos</th>
                <th style={S.thR}>CX ofertou</th>
                <th style={S.thR}>Taxa</th>
                <th style={S.thR}>IC 95%</th>
              </tr>
            </thead>
            <tbody>
              {d.magnitude.map((m, i) => (
                <tr key={m.faixa} style={i === 0 ? { background: "#FFF6EE" } : undefined}>
                  <td style={S.td}>{m.faixa}{i === 0 ? <small style={{ color: C.ink3 }}> · alarme falso do RIVERS</small> : null}</td>
                  <td style={S.tdR}>{m.casos}</td>
                  <td style={S.tdR}>{m.ofertou}</td>
                  <td style={{ ...S.tdR, fontWeight: 700, color: C.ink }}>{num(m.taxa, "%")}</td>
                  <td style={{ ...S.tdR, color: C.ink3, fontSize: 12 }}>{m.casos ? `${m.ic_lo}–${m.ic_hi}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: C.ink3, marginTop: 8 }}>
            Na 1ª linha a moto ficou pronta no prazo: as {d.magnitude[0]?.ofertou ?? 0} ofertas ali foram reservas dadas por causa de um aviso errado.
          </p>
        </Bloco>
      </div>

      {/* ── as quatro caixas ─────────────────────────────────────────── */}
      <Bloco titulo="RIVERS × o que aconteceu × o que o CX fez"
             nota={`as ${t.clientes} pessoas do período, sem sobreposição`}>
        <table style={S.tab}>
          <thead>
            <tr>
              <th style={S.th}>Caixa</th>
              <th style={S.thR}>Clientes</th>
              <th style={S.thR}>CX ofertou</th>
              <th style={S.thR}>Taxa</th>
              <th style={S.thR}>Entregou</th>
              <th style={S.thR}>Recusou</th>
            </tr>
          </thead>
          <tbody>
            {d.caixas.map((c, i) => (
              <tr key={c.caixa} style={i === 0 ? { background: C.azulLav } : undefined}>
                <td style={S.td}><b>{c.caixa}</b></td>
                <td style={S.tdR}>{c.casos}</td>
                <td style={S.tdR}>{c.ofertou}</td>
                <td style={S.tdR}>{num(c.taxa_oferta, "%")}</td>
                <td style={S.tdR}>{c.entregue}</td>
                <td style={{ ...S.tdR, color: c.recusou > 0 ? C.ruim : C.ink3 }}>{c.recusou}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bloco>

      {/* ── por regra ────────────────────────────────────────────────── */}
      <Bloco titulo="Por que o RIVERS disparou"
             nota="com menos de 5 avisos, leia a fração crua e não o percentual">
        <table style={S.tab}>
          <thead>
            <tr>
              <th style={S.th}>Regra</th>
              <th style={S.thR}>Avisos</th>
              <th style={S.thR}>Estourou</th>
              <th style={S.thR}>Errou</th>
              <th style={S.thR}>Precisão</th>
              <th style={S.thR}>Folga</th>
              <th style={S.thR}>CX ofertou</th>
              <th style={S.thR}>Entregou</th>
            </tr>
          </thead>
          <tbody>
            {d.motivos.map((m) => (
              <tr key={m.regra}>
                <td style={S.td}><b>{m.nome}</b></td>
                <td style={S.tdR}>{m.avisos}</td>
                <td style={S.tdR}>{m.estourou}</td>
                <td style={{ ...S.tdR, color: m.errou > 0 ? C.ruim : C.ink3 }}>{m.errou}</td>
                <td style={S.tdR}>
                  {m.avisos >= 5 ? num(m.precisao, "%") : `${m.estourou} de ${m.avisos}`}
                </td>
                <td style={S.tdR}>{m.folga_mediana === null ? "—" : `${m.folga_mediana} min`}</td>
                <td style={S.tdR}>{m.ofertou}</td>
                <td style={S.tdR}>{m.entregue}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={S.tdF}>Total</td>
              <td style={S.tdFR}>{t.avisos}</td>
              <td style={S.tdFR}>{d.caixas[0].casos}</td>
              <td style={S.tdFR}>{d.caixas[1].casos}</td>
              <td style={S.tdFR}>{num(t.precisao, "%")}</td>
              <td style={S.tdFR}>{t.folga_mediana === null ? "—" : `${t.folga_mediana} min`}</td>
              {/* somar as LINHAS, não o total geral: entregas do período inteiro (t.entregas)
                  inclui casos que o RIVERS não avisou e não fecharia com a coluna acima */}
              <td style={S.tdFR}>{d.motivos.reduce((s, m) => s + m.ofertou, 0)}</td>
              <td style={S.tdFR}>{d.motivos.reduce((s, m) => s + m.entregue, 0)}</td>
            </tr>
          </tfoot>
        </table>
      </Bloco>

      {/* ── deep dive: o que o RIVERS não viu ────────────────────────── */}
      <Bloco
        titulo="O que o RIVERS não viu — e quando o CX agiu"
        nota="a pergunta é se o CX ofertou cedo nesses casos. Se ofertou, ele viu com os olhos algo que o sistema não enxerga — e é isso que o modelo precisa aprender"
      >
        <div style={S.comparaTres}>
          <div style={S.cmp3}>
            <div style={{ ...S.cmp3N, color: C.ok }}>
              {d.sem_aviso_detalhe.mediana_checkin_ate_oferta ?? "—"}<small style={S.cmp3u}> min</small>
            </div>
            <div style={S.cmp3r}>O CX oferta sozinho</div>
            <div style={S.cmp3s}>quando o RIVERS ficou calado</div>
          </div>
          <div style={S.cmp3}>
            <div style={{ ...S.cmp3N, color: C.ink2 }}>
              {d.sem_aviso_detalhe.mediana_checkin_ate_oferta_com_aviso ?? "—"}<small style={S.cmp3u}> min</small>
            </div>
            <div style={S.cmp3r}>O CX oferta com aviso</div>
            <div style={S.cmp3s}>nos casos que os dois viram</div>
          </div>
          <div style={S.cmp3}>
            <div style={{ ...S.cmp3N, color: C.ruim }}>
              {d.sem_aviso_detalhe.mediana_rivers_avisa ?? "—"}<small style={S.cmp3u}> min</small>
            </div>
            <div style={S.cmp3r}>O RIVERS avisa</div>
            <div style={S.cmp3s}>mediana de todos os avisos</div>
          </div>
        </div>
        <p style={S.destaque}>
          O humano chega{" "}
          <b>
            {(d.sem_aviso_detalhe.mediana_rivers_avisa ?? 0) -
              (d.sem_aviso_detalhe.mediana_checkin_ate_oferta ?? 0)}{" "}
            minutos antes
          </b>{" "}
          do sistema. Ele olha a moto; o RIVERS olha o relógio.
        </p>

        <div style={{ ...S.duas, marginTop: ".9rem" }}>
          <div>
            <p style={S.subtit}>
              Quando o CX pegou sozinho <span style={S.dimT}>({d.sem_aviso_detalhe.cx_ofertou} casos)</span>
            </p>
            {d.sem_aviso_detalhe.faixas.map((f) => (
              <div key={f.faixa} style={S.fl}>
                <span style={S.flNome}>{f.faixa}</span>
                <div style={S.trilha}>
                  <i style={{ ...S.preenche,
                              width: `${d.sem_aviso_detalhe.cx_ofertou ? (100 * f.n) / d.sem_aviso_detalhe.cx_ofertou : 0}%`,
                              background: /1ª hora/.test(f.faixa) ? C.ok : C.azul }} />
                </div>
                <span style={S.flN}>{f.n}</span>
              </div>
            ))}
          </div>
          <div>
            <p style={S.subtit}>
              Nem o RIVERS nem o CX viram{" "}
              <span style={S.dimT}>({d.sem_aviso_detalhe.passou_em_branco} casos)</span>
            </p>
            <p style={{ ...S.nota, marginTop: "-.3rem" }}>
              o sistema ficou calado <b>e</b> ninguém ofertou reserva — o cliente estourou sozinho
            </p>
            <table style={S.tab}>
              <thead>
                <tr><th style={S.th}>Placa</th><th style={S.th}>Dia</th>
                    <th style={S.thR}>Ficou</th><th style={S.thR}>Além do prazo</th></tr>
              </thead>
              <tbody>
                {d.sem_aviso_detalhe.em_branco.map((c) => (
                  <tr key={c.os_id}>
                    <td style={{ ...S.td, fontFamily: C.mono }}>{c.placa}</td>
                    <td style={S.td}>{dia(c.dia)}</td>
                    <td style={S.tdR}>{c.ficou_min} min</td>
                    <td style={{ ...S.tdR, color: c.excesso > 60 ? C.ruim : C.ink2 }}>
                      +{c.excesso} min
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p style={{ ...S.subtit, marginTop: "1rem" }}>
          Caso a caso, do que o CX pegou mais cedo para o mais tarde
        </p>
        <table style={S.tab}>
          <thead>
            <tr>
              <th style={S.th}>Placa</th><th style={S.th}>Dia</th>
              <th style={S.thR}>CX ofertou em</th>
              <th style={S.th}>Motivo que o CX deu</th>
              <th style={S.thR}>Cliente ficou</th>
              <th style={S.thR}>Além do prazo</th>
              <th style={S.th}>Fim</th>
            </tr>
          </thead>
          <tbody>
            {d.sem_aviso_detalhe.casos.map((c) => (
              <tr key={c.os_id} style={(c.cx_ofertou_em ?? 999) <= 60 ? { background: C.okLav } : undefined}>
                <td style={{ ...S.td, fontFamily: C.mono }}>{c.placa}</td>
                <td style={S.td}>{dia(c.dia)}</td>
                <td style={{ ...S.tdR, fontWeight: 700,
                             color: (c.cx_ofertou_em ?? 999) <= 60 ? C.ok : C.ink }}>
                  {c.cx_ofertou_em} min
                </td>
                <td style={S.td}>{c.motivo_cx || "—"}</td>
                <td style={S.tdR}>{c.ficou_min} min</td>
                <td style={S.tdR}>+{c.excesso} min</td>
                <td style={S.td}>
                  {c.entregue ? "entregou" : c.recusou ? "recusou" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bloco>

      {/* ── antecedência × tamanho do atraso ─────────────────────────── */}
      <Bloco
        titulo="Para a moto que ia demorar 3h15, o aviso saiu quando?"
        nota="cada linha é o tempo REAL que o cliente ficou; a folga é quanto faltava para as 3h quando o RIVERS falou. Buscar uma reserva leva ~16 min, então folga abaixo de 30 min é aviso que não dá para usar"
      >
        <table style={S.tab}>
          <thead>
            <tr>
              <th style={S.th}>O cliente ficou</th>
              <th style={S.thR}>Avisos</th>
              <th style={S.thR}>Folga mediana</th>
              <th style={S.thR}>Em cima da hora<br /><span style={{ textTransform: "none" }}>&lt; 30 min</span></th>
              <th style={S.thR}>Com tempo útil</th>
              <th style={S.thR}>% útil</th>
              <th style={S.thR}>Virou moto</th>
            </tr>
          </thead>
          <tbody>
            {d.antecedencia_por_atraso.map((f) => (
              <tr key={f.faixa} style={/3h a 3h15/.test(f.faixa) ? { background: C.azulLav } : undefined}>
                <td style={S.td}><b>{f.faixa}</b></td>
                <td style={S.tdR}>{f.avisos}</td>
                <td style={S.tdR}>{f.folga_mediana === null ? "—" : `${f.folga_mediana} min`}</td>
                <td style={{ ...S.tdR, color: f.em_cima_da_hora > 0 ? C.ruim : C.ink3 }}>
                  {f.em_cima_da_hora}
                </td>
                <td style={S.tdR}>{f.com_tempo_util}</td>
                <td style={{ ...S.tdR, fontWeight: 700,
                             color: (f.pct_util ?? 0) >= 50 ? C.ok : (f.pct_util ?? 0) < 20 ? C.ruim : C.ink }}>
                  {f.avisos >= 4 ? num(f.pct_util, "%") : `${f.com_tempo_util}/${f.avisos}`}
                </td>
                <td style={S.tdR}>{f.entregue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bloco>

      {/* ── submotivo ────────────────────────────────────────────────── */}
      <Bloco titulo="Submotivo: onde a moto estava travada quando a regra disparou"
             nota="o mesmo motivo pode pegar situações bem diferentes — é aqui que dá para ver">
        <table style={S.tab}>
          <thead>
            <tr>
              <th style={S.th}>Motivo</th>
              <th style={S.th}>Submotivo — estado da OS</th>
              <th style={S.thR}>Avisos</th>
              <th style={S.thR}>Estourou</th>
              <th style={S.thR}>Precisão</th>
              <th style={S.thR}>Espera no aviso</th>
              <th style={S.thR}>CX ofertou</th>
            </tr>
          </thead>
          <tbody>
            {d.submotivos.map((s) => (
              <tr key={`${s.regra}-${s.submotivo}`}>
                <td style={S.td}>{s.nome}</td>
                <td style={S.td}><b>{s.submotivo_nome}</b></td>
                <td style={S.tdR}>{s.avisos}</td>
                <td style={S.tdR}>{s.estourou}</td>
                <td style={S.tdR}>
                  {s.avisos >= 5 ? num(s.precisao, "%") : `${s.estourou} de ${s.avisos}`}
                </td>
                <td style={S.tdR}>{s.espera_mediana === null ? "—" : `${s.espera_mediana} min`}</td>
                <td style={S.tdR}>{s.ofertou}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bloco>

      <div style={S.duas}>
        {/* ── seguida ou não ─────────────────────────────────────────── */}
        <Bloco titulo="A sugestão foi seguida?" nota={`os ${t.avisos} avisos do período`}>
          {d.seguidas.map((s) => (
            <div key={s.situacao} style={S.fl}>
              <span style={S.flNome}>{s.situacao}</span>
              <div style={S.trilha}>
                <i style={{ ...S.preenche, width: `${t.avisos ? (100 * s.n) / t.avisos : 0}%`,
                            background: /^Seguida/.test(s.situacao) ? C.ok
                                      : /estourou/.test(s.situacao) ? C.ruim : C.ink3 }} />
              </div>
              <span style={S.flN}>
                {s.n}
                <small style={S.flPct}>{t.avisos ? `${Math.round((100 * s.n) / t.avisos)}%` : ""}</small>
              </span>
            </div>
          ))}
        </Bloco>

        {/* ── estimado vs real ───────────────────────────────────────── */}
        <Bloco titulo="Estimativa da oficina × tempo real"
               nota={`nos ${d.estimado_vs_real.n} avisos com estimativa registrada`}>
          <table style={S.tab}>
            <tbody>
              <tr><td style={S.td}>Estimativa da oficina (mediana)</td>
                  <td style={S.tdR}>{d.estimado_vs_real.estimado_mediano ?? "—"} min</td></tr>
              <tr><td style={S.td}>Tempo real do cliente na base (mediana)</td>
                  <td style={S.tdR}><b>{d.estimado_vs_real.real_mediano ?? "—"} min</b></td></tr>
              <tr><td style={S.td}>Erro mediano da estimativa</td>
                  <td style={{ ...S.tdR, color: (d.estimado_vs_real.erro_mediano_pct ?? 0) > 0 ? C.ruim : C.ok }}>
                    <b>{d.estimado_vs_real.erro_mediano_pct === null ? "—"
                        : `${d.estimado_vs_real.erro_mediano_pct > 0 ? "+" : ""}${d.estimado_vs_real.erro_mediano_pct}%`}</b>
                  </td></tr>
              <tr><td style={S.td}>A oficina <b>subestimou</b> (real maior)</td>
                  <td style={S.tdR}>{d.estimado_vs_real.subestimou}</td></tr>
              <tr><td style={S.td}>A oficina <b>superestimou</b></td>
                  <td style={S.tdR}>{d.estimado_vs_real.superestimou}</td></tr>
            </tbody>
          </table>
          <p style={S.nota}>A estimativa cobre só o serviço; o tempo real inclui filas e QA.
          A comparação serve para ver o <b>viés</b>, não para cobrar a oficina.</p>
        </Bloco>
      </div>

      <div style={S.duas}>
        {/* ── tempo check-in → aviso ─────────────────────────────────── */}
        <Bloco titulo="Do check-in até o RIVERS avisar"
               nota={`mediana de ${d.tempo_checkin_ate_aviso.mediana ?? "—"} min · ${d.tempo_checkin_ate_aviso.n} avisos`}>
          {d.tempo_checkin_ate_aviso.faixas.map((f) => (
            <div key={f.faixa} style={S.fl}>
              <span style={S.flNome}>{f.faixa}</span>
              <div style={S.trilha}>
                <i style={{ ...S.preenche,
                            width: `${d.tempo_checkin_ate_aviso.n ? (100 * f.n) / d.tempo_checkin_ate_aviso.n : 0}%`,
                            background: /155/.test(f.faixa) ? C.ruim : C.azul }} />
              </div>
              <span style={S.flN}>{f.n}</span>
            </div>
          ))}
        </Bloco>

        {/* ── tempo aviso → oferta do CX ─────────────────────────────── */}
        <Bloco titulo="Do aviso do RIVERS até o CX ofertar"
               nota={`mediana de ${d.tempo_aviso_ate_oferta.mediana ?? "—"} min · em ${d.tempo_aviso_ate_oferta.cx_veio_antes} casos o CX chegou primeiro`}>
          {d.tempo_aviso_ate_oferta.faixas.map((f) => (
            <div key={f.faixa} style={S.fl}>
              <span style={S.flNome}>{f.faixa}</span>
              <div style={S.trilha}>
                <i style={{ ...S.preenche,
                            width: `${d.tempo_aviso_ate_oferta.n ? (100 * f.n) / d.tempo_aviso_ate_oferta.n : 0}%`,
                            background: C.azul }} />
              </div>
              <span style={S.flN}>{f.n}</span>
            </div>
          ))}
          <p style={S.nota}>Este indicador <b>morre</b> quando a sugestão virar automática — aí a
          medida passa a ser do aviso até o cliente ser chamado.</p>
        </Bloco>
      </div>

      <div style={S.duas}>
        {/* ── dia a dia ──────────────────────────────────────────────── */}
        <Bloco titulo="Dia a dia" nota="o dia de hoje fica fora: ainda entra check-in">
          <table style={S.tab}>
            <thead>
              <tr>
                <th style={S.th}>Dia</th>
                <th style={S.thR}>Clientes</th>
                <th style={S.thR}>Estouros</th>
                <th style={S.thR}>Avisos</th>
                <th style={S.thR}>Precisão</th>
                <th style={S.thR}>Alcance</th>
                <th style={S.thR}>Ofertas</th>
              </tr>
            </thead>
            <tbody>
              {d.dia_a_dia.map((r) => (
                <tr key={r.dia}>
                  <td style={S.td}>{dia(r.dia)}</td>
                  <td style={S.tdR}>{r.clientes}</td>
                  <td style={S.tdR}>{r.estouros}</td>
                  <td style={S.tdR}>{r.avisos}</td>
                  <td style={S.tdR}>{r.avisos >= 3 ? num(r.precisao, "%") : `${r.acertos}/${r.avisos}`}</td>
                  <td style={S.tdR}>{r.estouros >= 3 ? num(r.alcance, "%") : `${r.acertos}/${r.estouros}`}</td>
                  <td style={S.tdR}>{r.ofertas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Bloco>

        {/* ── motivo do CX, nas palavras dele ────────────────────────── */}
        <Bloco titulo="Por que o CX ofertou" nota="motivo que ele registrou ao ofertar a reserva">
          {d.motivo_do_cx.length === 0 ? (
            <p style={S.vazio}>Nenhum motivo registrado no período.</p>
          ) : (
            <table style={S.tab}>
              <tbody>
                {d.motivo_do_cx.map((m) => (
                  <tr key={m.motivo}>
                    <td style={S.td}>{m.motivo}</td>
                    <td style={{ ...S.tdR, width: 60 }}>{m.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Bloco>
      </div>

      <footer style={S.pe}>
        <b>Como os números são medidos.</b> <b>Estourou</b> = mais de 180 min entre o check-in do
        cliente e a moto ficar pronta aguardando o CX. <b>População</b>: cliente que deixou a moto e
        esperou na base — OS de reparo na base do piloto (pelo <code>location_id</code> da OS, nunca
        o do check-in), check-in de manutenção sem desistência, check-in até 4h antes da abertura da
        OS, e check-in e moto pronta no mesmo dia. <b>Aviso</b> = o RIVERS sugeriu reserva por regra
        de previsão de SLA, com o cliente na base — ficam fora as regras de política (placa, guincho,
        peça) e a de anomalia. <b>CX ofertou/cancelou</b> vem dos eventos do Maestro
        (<code>RESERVE_OFFERED</code> / <code>RESERVE_CANCELLED</code>), não das colunas antigas do
        check-in, que subcontam depois do Check-in 2.0. <b>Recusou</b> = cancelamento com
        <code>source = OPERATOR</code>, que vem em mediana 15 min depois da oferta com a moto ainda a
        ~79 min de ficar pronta; o cancelamento automático do OMS
        (<code>source = KAFKA_OMS</code>, disparado quando a moto fica pronta) <b>não</b> conta como
        recusa — contá-lo inflava o número em 40%. Não é possível separar &quot;o cliente disse
        não&quot; de &quot;não tinha moto reserva&quot;: o campo de motivo do cancelamento vem vazio
        em 100% dos eventos. <b>Folga</b> = minutos entre o aviso e o limite de 3h.
        <br />
        <span style={{ color: C.ink3 }}>
          Atualiza a cada 5 minutos · gerado em{" "}
          {new Date(d.gerado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
        </span>
      </footer>
    </Moldura>
  );
}

/* ── pedaços ─────────────────────────────────────────────────────────── */

function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <div style={S.fundo}>
      <div style={S.folha}>{children}</div>
    </div>
  );
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

function Bloco({ titulo, nota, children }: {
  titulo: string; nota?: string; children: React.ReactNode;
}) {
  return (
    <section style={S.bloco}>
      <h2 style={S.h2}>{titulo}</h2>
      {nota && <p style={S.nota}>{nota}</p>}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </section>
  );
}

/* ── cores e estilos ─────────────────────────────────────────────────── */

const C = {
  fundo: "#F1F5F9",
  papel: "#FFFFFF",
  ink: "#0F172A",
  ink2: "#475569",
  ink3: "#94A3B8",
  linha: "#E2E8F0",
  azul: "#0B3B8C",
  azul2: "#1E6FB8",
  azulLav: "#EAF2FA",
  okLav: "#E9F6EE",
  ok: "#15803D",
  ruim: "#B91C1C",
  mono: "ui-monospace, 'Cascadia Code', Consolas, monospace",
};

const S: Record<string, React.CSSProperties> = {
  fundo: { background: C.fundo, minHeight: "100vh", padding: "1.75rem 1rem 3rem",
           fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", color: C.ink },
  folha: { maxWidth: 1180, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1.1rem" },
  espera: { textAlign: "center", color: C.ink3, padding: "4rem 0", fontSize: "1rem" },

  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-end",
          gap: "1rem", flexWrap: "wrap", borderBottom: `2px solid ${C.azul}`, paddingBottom: ".6rem" },
  selo: { fontFamily: C.mono, fontSize: ".68rem", letterSpacing: ".14em", textTransform: "uppercase",
          color: C.azul, fontWeight: 600 },
  h1: { fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-.03em", margin: ".2rem 0 0" },
  janela: { fontFamily: C.mono, fontSize: ".74rem", lineHeight: 1.6, textAlign: "right", color: C.ink2 },

  filtros: { display: "flex", flexWrap: "wrap", gap: ".4rem", alignItems: "center" },
  chip: { fontFamily: "inherit", fontSize: ".78rem", fontWeight: 600, padding: ".38rem .7rem",
          borderRadius: 6, border: `1px solid ${C.linha}`, background: C.papel, color: C.ink2,
          cursor: "pointer", lineHeight: 1.2 },
  chipOn: { background: C.azul, borderColor: C.azul, color: "#FFFFFF" },
  parcial: { fontSize: ".74rem", color: C.ruim, fontWeight: 600, marginLeft: ".3rem" },

  comparaTres: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                 gap: ".7rem", margin: ".2rem 0 .6rem" },
  cmp3: { border: `1px solid ${C.linha}`, borderRadius: 8, padding: ".75rem .85rem",
          background: C.fundo },
  cmp3N: { fontFamily: C.mono, fontSize: "1.7rem", fontWeight: 700, lineHeight: 1,
           letterSpacing: "-.04em" },
  cmp3u: { fontSize: ".55em", fontWeight: 500 },
  cmp3r: { fontSize: ".82rem", fontWeight: 700, marginTop: ".3rem" },
  cmp3s: { fontSize: ".72rem", color: C.ink3, lineHeight: 1.35 },
  destaque: { fontSize: ".95rem", margin: ".2rem 0 0", padding: ".6rem .8rem",
              background: C.azulLav, borderRadius: 6, borderLeft: `3px solid ${C.azul}` },
  subtit: { fontSize: ".82rem", fontWeight: 700, margin: "0 0 .45rem" },
  dimT: { fontWeight: 400, color: C.ink3 },

  ins: { display: "grid", gridTemplateColumns: "3.2rem 1fr", gap: ".8rem", alignItems: "start",
         padding: ".45rem 0", borderBottom: `1px solid ${C.linha}`, fontSize: ".86rem" },
  insN: { fontFamily: C.mono, fontSize: "1.5rem", fontWeight: 700, lineHeight: 1, textAlign: "right" },

  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: ".75rem" },
  card: { background: C.papel, border: `1px solid ${C.linha}`, borderRadius: 8, padding: ".9rem 1rem" },
  cardN: { fontFamily: C.mono, fontSize: "2.15rem", fontWeight: 700, letterSpacing: "-.045em", lineHeight: 1 },
  cardRot: { fontSize: ".84rem", fontWeight: 700, marginTop: ".3rem" },
  cardSub: { fontSize: ".74rem", color: C.ink2, marginTop: ".15rem", lineHeight: 1.4 },

  duas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(430px, 1fr))", gap: "1.1rem" },
  bloco: { background: C.papel, border: `1px solid ${C.linha}`, borderRadius: 8, padding: "1rem 1.1rem" },
  h2: { fontSize: "1rem", fontWeight: 700, margin: 0, letterSpacing: "-.015em" },
  nota: { fontSize: ".74rem", color: C.ink3, margin: ".2rem 0 .8rem" },
  vazio: { fontSize: ".85rem", color: C.ink3, margin: 0 },

  fl: { display: "grid", gridTemplateColumns: "12rem 1fr 4.6rem", gap: ".7rem",
        alignItems: "center", padding: ".3rem 0" },
  flNome: { fontSize: ".82rem", color: C.ink2 },
  trilha: { background: C.fundo, borderRadius: 3, height: 18, overflow: "hidden", minWidth: 0 },
  preenche: { display: "block", height: "100%", borderRadius: 3 },
  flN: { fontFamily: C.mono, fontSize: ".95rem", fontWeight: 700, textAlign: "right" },
  flPct: { display: "block", fontSize: ".62rem", fontWeight: 400, color: C.ink3 },

  tab: { borderCollapse: "collapse", width: "100%", fontSize: ".84rem" },
  th: { textAlign: "left", fontFamily: C.mono, fontSize: ".62rem", textTransform: "uppercase",
        letterSpacing: ".06em", color: C.ink3, fontWeight: 600, padding: ".4rem .55rem .4rem 0",
        borderBottom: `1px solid ${C.ink}`, whiteSpace: "nowrap" },
  thR: { textAlign: "right", fontFamily: C.mono, fontSize: ".62rem", textTransform: "uppercase",
         letterSpacing: ".06em", color: C.ink3, fontWeight: 600, padding: ".4rem 0 .4rem .55rem",
         borderBottom: `1px solid ${C.ink}`, whiteSpace: "nowrap" },
  td: { padding: ".42rem .55rem .42rem 0", borderBottom: `1px solid ${C.linha}` },
  tdR: { padding: ".42rem 0 .42rem .55rem", borderBottom: `1px solid ${C.linha}`,
         textAlign: "right", fontFamily: C.mono, whiteSpace: "nowrap" },
  tdF: { padding: ".45rem .55rem .2rem 0", borderTop: `1px solid ${C.ink}`, fontWeight: 700 },
  tdFR: { padding: ".45rem 0 .2rem .55rem", borderTop: `1px solid ${C.ink}`, textAlign: "right",
          fontFamily: C.mono, fontWeight: 700, whiteSpace: "nowrap" },

  pe: { fontSize: ".72rem", color: C.ink2, lineHeight: 1.65, background: C.papel,
        border: `1px solid ${C.linha}`, borderRadius: 8, padding: ".9rem 1.1rem" },
};

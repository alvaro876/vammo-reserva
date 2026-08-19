"use client";

// Tela do CX Piso — fila de ação, não painel de análise.
// Responde uma pergunta só: "quem eu preciso avisar agora, e o que eu falo?"
// Pensada pra ficar aberta numa TV/computador da área de CX: letra grande,
// ordenada por urgência (quem está mais perto de estourar as 3h no topo) e
// um clique pra registrar que o cliente já sabe.

import { useEffect, useState } from "react";

interface ClienteCx {
  os_id: number;
  placa: string;
  cliente: string | null;
  mecanico: string | null;
  asset_model: string;
  so_type: string;
  guincho: boolean;
  acidente: boolean;
  imobilizada: boolean;
  // sintoma relatado pelo cliente + histórico dele (CONTEXTO, não decide reserva)
  sintoma: { nome: string; pct: number; n: number } | null;
  status_atual: string;
  minutos_na_base: number;
  minutos_pro_sla: number;
  reservar: boolean;
  regra: string | null;
  motivo: string;
  confianca: "alta" | "fronteira" | null;
  acao_automatica: boolean;
  tempo_previsto_min: number | null;
  // quanto falta pra moto ficar pronta (13/08) — guia a conversa do CX
  pronta_em_min: number | null;
  pronta_tipo: "estimado" | "qa" | "retrabalho" | "sem_diag" | "vencida";
  ofertada_em: number | null;
  ofertou: string | null;
  recusada: boolean;
  chamada_retirada: boolean;
  entregue: boolean;
  avisado_em: string | null;
  avisado_por: string | null;
}

interface Resposta {
  atualizado_em: string;
  base: string;
  pressao_piso: number;
  total: number;
  clientes: ClienteCx[];
}

const STATUS_HUMANO: Record<string, string> = {
  OPEN: "aguardando diagnóstico",
  IN_DIAGNOSIS: "em diagnóstico",
  AWAITING_MECHANIC: "aguardando mecânico",
  IN_PROGRESS: "em execução",
  PAUSED: "pausada",
  AWAITING_PARTS: "aguardando peça",
  AWAITING_SERVICE: "aguardando serviço",
  AWAITING_QA: "na fila da qualidade",
  IN_QA: "em qualidade",
  QA_REJECTED: "reprovada na qualidade",
  AWAITING_VMGMT: "aguardando gestão de frota",
};

function primeiroNome(nome: string | null) {
  if (!nome) return "cliente";
  return nome.trim().split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase());
}

// Nome que caiba sem reticências: "Gabriel Melo De Araujo" → "Gabriel M."
// Corte com intenção lê melhor que texto picado no meio.
function nomeCurto(nome: string | null, limite = 18) {
  if (!nome) return "—";
  const limpo = nome.trim().replace(/\s+/g, " ");
  if (limpo.length <= limite) return limpo;
  const partes = limpo.split(" ");
  return `${partes[0]} ${partes[1]?.[0] ?? ""}.`.trim();
}

function relogio(min: number) {
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

function hora(iso: string | number) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// "pronta em ~X" — o que o CX fala pro cliente (13/08). `forte` = número com lastro
// (vira destaque); sem lastro a tela diz o porquê em texto miúdo, nunca um número falso.
function prontaInfo(c: ClienteCx): { txt: string; forte: boolean } {
  switch (c.pronta_tipo) {
    case "estimado":
      return { txt: `~${relogio(c.pronta_em_min ?? 0)}`, forte: true };
    case "qa":
      return { txt: `revisão final · ~${relogio(c.pronta_em_min ?? 0)}`, forte: true };
    case "retrabalho":
      return { txt: `reprovou na revisão · ~${relogio(c.pronta_em_min ?? 0)}`, forte: true };
    case "sem_diag":
      return { txt: "sem previsão — aguarda diagnóstico", forte: false };
    case "vencida":
      return { txt: "passou da estimativa — confirmar com o mecânico", forte: false };
  }
}

// Zona de urgência — UM sistema de cor só (o relógio do SLA), pra cor significar
// sempre a mesma coisa na tela. Trio validado (contraste >= 3:1 na superfície clara
// e separação suficiente pra daltonismo): azul → âmbar → vermelho.
const ZONAS = {
  tranquilo: { cor: "#1E6FB8", fundo: "#EAF2FA", rotulo: "no prazo" },
  atencao: { cor: "#d97706", fundo: "#FDF3E3", rotulo: "apertado" },
  estourou: { cor: "#be123c", fundo: "#FCEAEE", rotulo: "passou das 3h" },
} as const;

function zona(minutosProSla: number) {
  if (minutosProSla <= 0) return ZONAS.estourou;
  if (minutosProSla <= 60) return ZONAS.atencao;
  return ZONAS.tranquilo;
}

// Medidor de consumo do SLA: quanto das 3h já foi gasto. Barra fina, ponta
// arredondada, ancorada na esquerda — dá o estado num relance de TV.
function Medidor({ minutosNaBase, cor, altura = 6 }: { minutosNaBase: number; cor: string; altura?: number }) {
  const pct = Math.max(2, Math.min(100, (minutosNaBase / 180) * 100));
  return (
    <div
      className="w-full overflow-hidden rounded-full bg-slate-200/70"
      style={{ height: altura }}
      role="img"
      aria-label={`${Math.round(pct)}% das 3 horas`}
    >
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${pct}%`, backgroundColor: cor }}
      />
    </div>
  );
}

function mensagemPronta(c: ClienteCx) {
  // Sem sugestão de reserva (entrou na fila pelo relógio): a mensagem certa é
  // desculpa + previsão, não oferta de reserva que o RIVERS não recomendou.
  if (!c.reservar) {
    return (
      `Oi ${primeiroNome(c.cliente)}! Sua moto (${c.placa}) está na reta final do reparo — ` +
      `passou um pouco do nosso prazo de 3h e pedimos desculpa pela espera. Já estamos finalizando e te chamamos assim que estiver pronta.`
    );
  }
  return (
    `Oi ${primeiroNome(c.cliente)}! Sua moto (${c.placa}) está na oficina e o reparo vai passar das 3h. ` +
    `Você tem direito a uma moto reserva e a gente já está preparando — passa no balcão do atendimento que te entregamos.`
  );
}

// Placa no padrão Mercosul — é assim que o piso identifica a moto de longe,
// e é o mesmo visual da Mesa, pra tela não parecer de outro mundo.
function Placa({ numero, tam = "m" }: { numero: string; tam?: "g" | "m" | "p" }) {
  const t = {
    g: { faixa: "text-[10px] py-0.5", corpo: "text-[34px] leading-[1.05] px-3 py-1", larg: "min-w-[186px]" },
    m: { faixa: "text-[8px] py-px", corpo: "text-xl leading-tight px-2 py-0.5", larg: "min-w-[116px]" },
    p: { faixa: "text-[7px] py-px", corpo: "text-base leading-tight px-1.5 py-0.5", larg: "min-w-[96px]" },
  }[tam];
  return (
    <span
      className={`inline-block overflow-hidden rounded-md border-2 border-slate-900 bg-white text-center align-middle shadow-sm ${t.larg}`}
    >
      <span
        className={`block w-full bg-[#0B3B8C] font-bold uppercase tracking-[0.3em] text-white ${t.faixa}`}
      >
        Brasil
      </span>
      <span className={`block font-mono font-black tracking-[0.08em] text-slate-900 ${t.corpo}`}>
        {numero || "—"}
      </span>
    </span>
  );
}

function Selo({ tom, children }: { tom: "auto" | "fronteira" | "oficina" | "alerta" | "ok"; children: React.ReactNode }) {
  const cores = {
    auto: "bg-emerald-100 text-emerald-800 border-emerald-300",
    fronteira: "bg-amber-100 text-amber-800 border-amber-300",
    oficina: "bg-sky-100 text-sky-800 border-sky-300",
    alerta: "bg-rose-100 text-rose-800 border-rose-300",
    ok: "bg-slate-100 text-slate-700 border-slate-300",
  }[tom];
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold ${cores}`}>
      {children}
    </span>
  );
}

// AVISO ANTECIPADO (13/08, caso SVY1F76; AMPLIADO em 20/08, caso SUI0J43 + ordem do
// Alvaro: "se a estimativa diz que vai passar das 3h, independente do tempo, deve
// aparecer"). O card da SUI0J43 dizia "pronta em ~4h04" e "faltam 1h32" ao mesmo
// tempo — contradição na cara do CX. Regra:
//  - com número FIRME dizendo que NÃO sai a tempo (pronta > tempo que falta): sobe
//    pra fila de aviso NA HORA, não importa há quanto tempo o cliente chegou;
//  - sem número confiável (sem diagnóstico / estimativa vencida): sobe só na janela
//    final (<=30min), senão toda moto recém-chegada viraria alarme.
// A RESERVA continua com as regras medidas (nem-começou 98%, estimativa >=230,
// relógio) — aqui é a fila de atenção/conversa do CX.
function vaiEstourar(c: ClienteCx) {
  if (c.minutos_pro_sla <= 0) return false; // já estourou — outro caminho cuida
  if (c.pronta_em_min !== null) return c.pronta_em_min > c.minutos_pro_sla;
  return c.minutos_pro_sla <= 30;
}

function CardAcao({ c }: { c: ClienteCx }) {
  const estourou = c.minutos_pro_sla <= 0;
  const z = zona(c.minutos_pro_sla);
  const pi = prontaInfo(c);

  return (
    <div
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
      style={{ borderLeft: `6px solid ${z.cor}` }}
    >
      <div className="flex flex-wrap items-start gap-5 p-5">
        {/* relógio do SLA — sempre com a palavra do lado: número pelado se lê
            como "está esperando há tanto", que é o contrário do que ele diz */}
        <div className="min-w-[150px]">
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: z.cor }}>
            {estourou ? "já passou das 3h" : "faltam"}
          </div>
          <div className="text-4xl font-black leading-none tabular-nums" style={{ color: z.cor }}>
            {relogio(c.minutos_pro_sla)}
          </div>
          <div className="mt-1 text-xs font-semibold text-slate-500">
            {estourou ? "de atraso" : "pro limite de 3h"}
          </div>
          <div className="mt-2">
            <Medidor minutosNaBase={c.minutos_na_base} cor={z.cor} altura={8} />
          </div>
          {/* o outro relógio da conversa: quanto falta pra PRONTA (13/08) */}
          <div className="mt-3 border-t border-slate-100 pt-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              moto pronta em
            </div>
            {pi.forte ? (
              <div className="text-xl font-black leading-tight tabular-nums text-slate-700">{pi.txt}</div>
            ) : (
              <div className="text-xs font-semibold leading-snug text-slate-500">{pi.txt}</div>
            )}
          </div>
        </div>

        {/* quem é o cliente e por quê */}
        <div className="min-w-[280px] flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <Placa numero={c.placa} tam="g" />
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Cliente</div>
              <div className="text-xl font-bold leading-tight text-slate-800">
                {c.cliente || "sem nome no check-in"}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
            <span>
              {c.asset_model} · {STATUS_HUMANO[c.status_atual] ?? c.status_atual.toLowerCase()} · na base há{" "}
              {relogio(c.minutos_na_base)}
            </span>
            {c.mecanico && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-slate-600">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">mecânico </span>
                <span className="font-semibold">{c.mecanico}</span>
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!estourou && vaiEstourar(c) && (
              <Selo tom="fronteira">VAI PASSAR DAS 3H — dá pra avisar o cliente com antecedência</Selo>
            )}
            {c.acao_automatica && <Selo tom="auto">AUTOMÁTICA — pode entregar</Selo>}
            {c.confianca === "fronteira" && <Selo tom="fronteira">MARGEM APERTADA — confirme com o mecânico se sai a tempo</Selo>}
            {c.ofertada_em && (
              <Selo tom="oficina">
                oficina ofertou {hora(c.ofertada_em)}
                {c.ofertou ? ` · ${c.ofertou.split(" ")[0]}` : ""}
              </Selo>
            )}
            {!c.ofertada_em && <Selo tom="ok">sem oferta no Maestro ainda</Selo>}
            {c.recusada && <Selo tom="alerta">cliente recusou</Selo>}
            {c.chamada_retirada && <Selo tom="oficina">chamado pra retirar</Selo>}
            {/* contexto do incidente — informação pra conversa, não motivo da reserva */}
            {c.so_type === "RETURN_INSPECTION" && <Selo tom="ok">inspeção de retorno</Selo>}
            {c.guincho && <Selo tom="ok">veio de guincho</Selo>}
            {c.acidente && <Selo tom="ok">acidente</Selo>}
            {c.imobilizada && <Selo tom="ok">moto imobilizada</Selo>}
            {/* Sintoma do cliente: só destaca quando o histórico é ruim (>=50% passa de
                3h, contra base de ~27%). Abaixo disso não vira selo pra não poluir a TV. */}
            {c.sintoma && c.sintoma.pct >= 50 && (
              <Selo tom="fronteira">
                {c.sintoma.nome} — {c.sintoma.pct}% passa de 3h
              </Selo>
            )}
          </div>
          <p className="mt-3 text-sm text-slate-600">
            {c.motivo ||
              // sem regra disparada = entrou aqui pelo relógio; se nenhuma regra pegou,
              // a projeção ficou abaixo do gatilho — ou seja, o que resta é curto
              "já passou das 3h — avisar o cliente (sem sugestão de reserva: a previsão indica conserto perto do fim)"}
          </p>
        </div>

        {/* Botões removidos em 05/08 (pedido do Alvaro): a tela vive numa TV, ninguém
            clica. O registro de aviso (POST /api/cx e rivers_cx_aviso) continua de pé
            pra quando houver uma superfície clicável (celular/desktop do CX). */}
      </div>
    </div>
  );
}

export default function CxPiso() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [quem, setQuem] = useState("");
  const [avisadosLocal, setAvisadosLocal] = useState<Set<number>>(new Set());

  useEffect(() => {
    setQuem(localStorage.getItem("rivers_cx_quem") ?? "");
  }, []);

  async function buscar() {
    try {
      const res = await fetch("/api/cx");
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      setDados(await res.json());
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro desconhecido");
    }
  }

  useEffect(() => {
    buscar();
    const t = setInterval(buscar, 45_000);
    return () => clearInterval(t);
  }, []);

  function marcarAvisado(os: number) {
    setAvisadosLocal((s) => new Set(s).add(os));
  }

  const clientes = dados?.clientes ?? [];
  const jaAvisado = (c: ClienteCx) => Boolean(c.avisado_em) || avisadosLocal.has(c.os_id);
  // Cliente que JÁ CRUZOU as 3h entra na fila de aviso MESMO sem regra de reserva —
  // caso real UFJ8I67 (31/07): 3h01 na base, em execução, projeção 195min (< gatilho
  // de 240, restante era curto) → nenhuma regra disparou e o card ficou em "dentro do
  // prazo" com relógio vermelho. Estourar o SLA é FATO, não previsão: o aviso ao
  // cliente é devido sempre; a reserva continua sendo decisão das regras.
  //
  // AVISO ANTECIPADO (13/08, pedido do Victor/CX, caso SVY1F76): faltando <=30min pro
  // SLA e a moto NÃO ficando pronta antes da linha (ou sem número confiável), o estouro
  // é questão de relógio — o card sobe ANTES, pro CX conversar com antecedência em vez
  // de correr atrás no minuto 181. Só fica no "no prazo" quem tem número dizendo que
  // sai ANTES da linha.
  const precisaAtencao = (c: ClienteCx) => c.reservar || c.minutos_pro_sla <= 0 || vaiEstourar(c);
  const precisaAvisar = clientes.filter((c) => precisaAtencao(c) && !jaAvisado(c) && !c.entregue);
  const emAndamento = clientes.filter((c) => precisaAtencao(c) && (jaAvisado(c) || c.entregue));
  const noPrazo = clientes.filter((c) => !precisaAtencao(c));

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">
              Reserva · CX Piso
              <span className="ml-3 rounded-full bg-sky-100 px-3 py-1 align-middle text-sm font-bold text-sky-700">
                {dados?.base ?? "..."}
              </span>
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {dados
                // total (nº de cards), não pressao_piso: o termômetro conta TODO atendimento
                // aberto — inclui moto pronta esperando retirada e cliente ainda não chamado —
                // então "14 na base" com 10 cards não fechava a conta na cara do CX (31/07).
                ? `atualizado às ${hora(dados.atualizado_em)} · atualiza sozinho a cada 45s · ${dados.total} clientes em acompanhamento`
                : "carregando a fila..."}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              piloto na Mooca — Osasco e SBC seguem sendo monitorados pelo RIVERS, mas fora desta tela
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div
              className="min-w-[92px] rounded-xl px-4 py-2 text-center"
              style={{
                backgroundColor: precisaAvisar.length > 0 ? ZONAS.estourou.fundo : "#F1F5F9",
                color: precisaAvisar.length > 0 ? ZONAS.estourou.cor : "#64748B",
              }}
            >
              <div className="text-3xl font-black leading-tight tabular-nums">{precisaAvisar.length}</div>
              <div className="text-xs font-bold uppercase tracking-wide">avisar</div>
            </div>
            <div
              className="min-w-[92px] rounded-xl px-4 py-2 text-center"
              style={{ backgroundColor: "#E9F6EE", color: "#15803d" }}
            >
              <div className="text-3xl font-black leading-tight tabular-nums">{emAndamento.length}</div>
              <div className="text-xs font-bold uppercase tracking-wide">avisados</div>
            </div>
            <div
              className="min-w-[92px] rounded-xl px-4 py-2 text-center"
              style={{ backgroundColor: ZONAS.tranquilo.fundo, color: ZONAS.tranquilo.cor }}
            >
              <div className="text-3xl font-black leading-tight tabular-nums">{noPrazo.length}</div>
              <div className="text-xs font-bold uppercase tracking-wide">no prazo</div>
            </div>
            {/* input "seu nome" removido: tela de TV, ninguém digita (05/08) */}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {erro && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-700">{erro}</div>
        )}

        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
            Precisa avisar o cliente
          </h2>
          {precisaAvisar.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400">
              {dados ? "ninguém pendente agora — fila limpa" : "..."}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {precisaAvisar.map((c) => (
                <CardAcao key={c.os_id} c={c} />
              ))}
            </div>
          )}
        </section>

        {emAndamento.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
              Cliente já avisado
            </h2>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {emAndamento.map((c) => (
                <div
                  key={c.os_id}
                  className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3 last:border-b-0"
                >
                  <Placa numero={c.placa} tam="p" />
                  <span>
                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">cliente </span>
                    <span className="font-semibold text-slate-700">{nomeCurto(c.cliente, 26)}</span>
                  </span>
                  <span className="text-sm text-slate-500">
                    {STATUS_HUMANO[c.status_atual] ?? c.status_atual.toLowerCase()}
                    {c.mecanico ? ` · mecânico ${c.mecanico.split(" ")[0]}` : ""}
                    {" · "}
                    <span className="font-semibold text-slate-600">
                      {c.pronta_tipo === "estimado" ? `pronta em ${prontaInfo(c).txt}` : prontaInfo(c).txt}
                    </span>
                  </span>
                  <span className="ml-auto flex items-center gap-2 text-sm">
                    {c.entregue && <Selo tom="auto">reserva entregue</Selo>}
                    {c.avisado_em && (
                      <span className="text-slate-500">
                        avisado {hora(c.avisado_em)}
                        {c.avisado_por ? ` · ${c.avisado_por}` : ""}
                      </span>
                    )}
                    {!c.avisado_em && avisadosLocal.has(c.os_id) && (
                      <span className="text-emerald-600">avisado agora</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {noPrazo.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
              No piso, dentro do prazo
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {noPrazo.map((c) => (
                <div
                  key={c.os_id}
                  className="overflow-hidden rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-slate-300 hover:shadow-sm"
                  style={{ borderLeft: `4px solid ${zona(c.minutos_pro_sla).cor}` }}
                >
                  {/* linha 1: placa + o que o piso observa (tempo na base) */}
                  <div className="flex items-center gap-2">
                    <Placa numero={c.placa} tam="m" />
                    <span
                      className="ml-auto whitespace-nowrap text-base font-bold tabular-nums"
                      style={{ color: zona(c.minutos_pro_sla).cor }}
                    >
                      há {relogio(c.minutos_na_base)}
                    </span>
                  </div>
                  {/* linha 2: o cliente, com espaço próprio pro nome respirar */}
                  <div className="mt-2 truncate">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">cliente </span>
                    <span className="text-sm font-semibold text-slate-700">{nomeCurto(c.cliente, 22)}</span>
                  </div>
                  <div className="mt-1.5">
                    <Medidor minutosNaBase={c.minutos_na_base} cor={zona(c.minutos_pro_sla).cor} altura={4} />
                  </div>
                  {/* linha 4: contexto que pode encurtar × "faltam" que nunca corta */}
                  <div className="mt-1.5 flex items-baseline gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-slate-500">
                      {STATUS_HUMANO[c.status_atual] ?? c.status_atual.toLowerCase()}
                      {c.mecanico ? ` · mec. ${c.mecanico.split(" ")[0]}` : ""}
                      {/* "pronta em" trocou a "previsão" (total projetado): é o número
                          que o CX fala pro cliente, não o que o motor usa por dentro */}
                      {" · "}
                      {c.pronta_tipo === "estimado" ? `pronta em ${prontaInfo(c).txt}` : prontaInfo(c).txt}
                    </span>
                    <span
                      className="shrink-0 font-semibold tabular-nums"
                      style={{ color: zona(c.minutos_pro_sla).cor }}
                    >
                      faltam {relogio(c.minutos_pro_sla)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-10 text-xs leading-relaxed text-slate-400">
          Dois relógios, pra não confundir: <b>&ldquo;há X&rdquo;</b> é o tempo que o cliente está na base;
          <b> &ldquo;faltam X&rdquo;</b> é o que sobra até o limite de 3h (a régua conta da abertura da OS).
          A barra mostra quanto das 3h já foi gasto, e a cor é sempre a mesma coisa:{" "}
          <span className="font-bold" style={{ color: ZONAS.tranquilo.cor }}>azul no prazo</span> ·{" "}
          <span className="font-bold" style={{ color: ZONAS.atencao.cor }}>âmbar na última hora</span> ·{" "}
          <span className="font-bold" style={{ color: ZONAS.estourou.cor }}>vermelho passou das 3h</span>.
          &ldquo;Automática&rdquo; são as regras que nunca erraram no histórico — pode entregar direto.
          &ldquo;Fronteira&rdquo; é previsão perto do limite: vale confirmar com a oficina.
          O estado da oferta vem do Maestro em tempo real.
        </p>
      </main>
    </div>
  );
}

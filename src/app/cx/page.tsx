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
  asset_model: string;
  status_atual: string;
  minutos_na_base: number;
  minutos_pro_sla: number;
  reservar: boolean;
  regra: string | null;
  motivo: string;
  confianca: "alta" | "fronteira" | null;
  acao_automatica: boolean;
  tempo_previsto_min: number | null;
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

function relogio(min: number) {
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

function hora(iso: string | number) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function mensagemPronta(c: ClienteCx) {
  return (
    `Oi ${primeiroNome(c.cliente)}! Sua moto (${c.placa}) está na oficina e o reparo vai passar das 3h. ` +
    `Você tem direito a uma moto reserva e a gente já está preparando — passa no balcão do atendimento que te entregamos.`
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

function CardAcao({ c, quem, onAvisado }: { c: ClienteCx; quem: string; onAvisado: (os: number) => void }) {
  const [copiado, setCopiado] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const estourou = c.minutos_pro_sla <= 0;
  const apertado = !estourou && c.minutos_pro_sla <= 45;

  async function avisar() {
    setSalvando(true);
    try {
      const res = await fetch("/api/cx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ os_id: c.os_id, actor: quem || null }),
      });
      if (res.ok) onAvisado(c.os_id);
    } finally {
      setSalvando(false);
    }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(mensagemPronta(c));
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      /* clipboard bloqueado — o texto continua visível na tela */
    }
  }

  return (
    <div
      className={`rounded-2xl border bg-white p-5 shadow-sm ${
        estourou ? "border-rose-300 ring-1 ring-rose-200" : apertado ? "border-amber-300" : "border-slate-200"
      }`}
    >
      <div className="flex flex-wrap items-start gap-5">
        {/* relógio do SLA */}
        <div className="min-w-[124px]">
          <div
            className={`text-4xl font-black leading-none tabular-nums ${
              estourou ? "text-rose-600" : apertado ? "text-amber-600" : "text-slate-800"
            }`}
          >
            {estourou ? `+${relogio(c.minutos_pro_sla)}` : relogio(c.minutos_pro_sla)}
          </div>
          <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {estourou ? "passou das 3h" : "pro limite de 3h"}
          </div>
        </div>

        {/* quem é o cliente e por quê */}
        <div className="min-w-[280px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-slate-900 px-2 py-1 font-mono text-base font-bold tracking-wider text-white">
              {c.placa}
            </span>
            <span className="text-lg font-bold text-slate-800">{c.cliente || "cliente sem nome no check-in"}</span>
          </div>
          <div className="mt-1 text-sm text-slate-500">
            {c.asset_model} · {STATUS_HUMANO[c.status_atual] ?? c.status_atual.toLowerCase()} · na base há{" "}
            {relogio(c.minutos_na_base)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {c.acao_automatica && <Selo tom="auto">AUTOMÁTICA — pode entregar</Selo>}
            {c.confianca === "fronteira" && <Selo tom="fronteira">FRONTEIRA — confirmar no piso</Selo>}
            {c.ofertada_em && (
              <Selo tom="oficina">
                oficina ofertou {hora(c.ofertada_em)}
                {c.ofertou ? ` · ${c.ofertou.split(" ")[0]}` : ""}
              </Selo>
            )}
            {!c.ofertada_em && <Selo tom="ok">sem oferta no Maestro ainda</Selo>}
            {c.recusada && <Selo tom="alerta">cliente recusou</Selo>}
            {c.chamada_retirada && <Selo tom="oficina">chamado pra retirar</Selo>}
          </div>
          <p className="mt-3 text-sm text-slate-600">{c.motivo}</p>
        </div>

        {/* ação */}
        <div className="flex w-full flex-col gap-2 sm:w-56">
          <button
            onClick={avisar}
            disabled={salvando}
            className="rounded-xl bg-emerald-600 px-4 py-3 text-base font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {salvando ? "registrando..." : "Avisei o cliente"}
          </button>
          <button
            onClick={copiar}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            {copiado ? "mensagem copiada!" : "copiar mensagem pronta"}
          </button>
        </div>
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
  const precisaAvisar = clientes.filter((c) => c.reservar && !jaAvisado(c) && !c.entregue);
  const emAndamento = clientes.filter((c) => c.reservar && (jaAvisado(c) || c.entregue));
  const noPrazo = clientes.filter((c) => !c.reservar);

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
                ? `atualizado às ${hora(dados.atualizado_em)} · atualiza sozinho a cada 45s · ${dados.pressao_piso} clientes na base`
                : "carregando a fila..."}
            </p>
          </div>
          <div className="flex items-end gap-6">
            <div className="text-center">
              <div className="text-3xl font-black tabular-nums text-rose-600">{precisaAvisar.length}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">avisar</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-black tabular-nums text-emerald-600">{emAndamento.length}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">em andamento</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-black tabular-nums text-slate-400">{noPrazo.length}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">no prazo</div>
            </div>
            <input
              value={quem}
              onChange={(e) => {
                setQuem(e.target.value);
                localStorage.setItem("rivers_cx_quem", e.target.value);
              }}
              placeholder="seu nome"
              className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
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
                <CardAcao key={c.os_id} c={c} quem={quem} onAvisado={marcarAvisado} />
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
                  <span className="rounded bg-slate-900 px-2 py-0.5 font-mono text-sm font-bold text-white">
                    {c.placa}
                  </span>
                  <span className="font-semibold text-slate-700">{c.cliente || "—"}</span>
                  <span className="text-sm text-slate-500">
                    {STATUS_HUMANO[c.status_atual] ?? c.status_atual.toLowerCase()}
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
                <div key={c.os_id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-bold text-slate-700">
                      {c.placa}
                    </span>
                    <span className="truncate text-sm font-semibold text-slate-700">{c.cliente || "—"}</span>
                    <span className="ml-auto text-sm font-bold tabular-nums text-slate-400">
                      {relogio(c.minutos_pro_sla)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-500">
                    {STATUS_HUMANO[c.status_atual] ?? c.status_atual.toLowerCase()}
                    {c.tempo_previsto_min ? ` · previsão ${relogio(c.tempo_previsto_min)}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-10 text-xs leading-relaxed text-slate-400">
          A régua é o SLA de 3h desde a abertura da OS. O relógio é o tempo que falta (ou passou).
          &ldquo;Automática&rdquo; são as regras que nunca erraram no histórico — pode entregar direto.
          &ldquo;Fronteira&rdquo; é previsão perto do limite: vale confirmar com a oficina.
          O estado da oferta vem do Maestro em tempo real.
        </p>
      </main>
    </div>
  );
}

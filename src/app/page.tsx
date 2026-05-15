"use client";

// Por que "use client"?
// Precisamos de useState (guardar os dados) e useEffect (buscar ao carregar).
// Esses hooks só existem no browser — não funcionam no servidor.
// "use client" diz pro Next.js: renderize este componente no browser, não no servidor.

import { useEffect, useState } from "react";
import { Recomendacao } from "@/types";

// Tipo completo de uma OS com todos os campos que a API devolve
interface OSRow {
  os_id: number;
  so_type: string;
  location_id: number;
  asset_model: string;
  placa: string;
  status_atual: string;
  min_desde_open: number;
  min_no_status: number;
  imobilizada: number;
  acidente: number;
  guincho: number;
  min_open_to_awaiting: number;
  mecanico_atual: string;
  n_pecas: number;
  tempo_estimado_min: number;
  complexidade_max: number;
  n_pecas_criticas: number;
  peca_principal: string;
  n_sem_estoque: number;
  todas_pecas_diag: string;
  pecas_sem_estoque: string;
  pecas_criticas: string;
  descricao_cx: string;
  is_piso: number;
  recomendacao: Recomendacao | null;
}

// Converte minutos em "2h 15min" ou "45min"
function formatMin(min: number): string {
  if (min <= 0) return "—";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// Badge colorido pelo status atual da OS
function StatusBadge({ status }: { status: string }) {
  const cores: Record<string, string> = {
    OPEN: "bg-slate-100 text-slate-700",
    IN_DIAGNOSIS: "bg-purple-100 text-purple-800",
    IN_PROGRESS: "bg-blue-100 text-blue-800",
    AWAITING_MECHANIC: "bg-yellow-100 text-yellow-800",
    PAUSED: "bg-orange-100 text-orange-800",
    AWAITING_QA: "bg-teal-100 text-teal-800",
    IN_QA: "bg-teal-200 text-teal-900",
    QA_REJECTED: "bg-red-100 text-red-800",
    AWAITING_VMGMT: "bg-gray-100 text-gray-700",
  };
  const labels: Record<string, string> = {
    OPEN: "Aberta",
    IN_DIAGNOSIS: "Em diagnóstico",
    IN_PROGRESS: "Em andamento",
    AWAITING_MECHANIC: "Aguard. mecânico",
    PAUSED: "Pausada",
    AWAITING_QA: "Aguard. QA",
    IN_QA: "Em QA",
    QA_REJECTED: "Reprovada",
    AWAITING_VMGMT: "Aguard. gestão",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cores[status] ?? "bg-gray-100 text-gray-600"}`}>
      {labels[status] ?? status}
    </span>
  );
}

// Badge de reserva — só aparece pra OS em AWAITING_MECHANIC
// Para outros status mostra traço (não houve avaliação ainda)
function ReservaBadge({ os, onClick }: { os: OSRow; onClick: () => void }) {
  if (os.status_atual !== "AWAITING_MECHANIC") {
    return <span className="text-slate-300">—</span>;
  }
  if (!os.recomendacao) {
    return <span className="text-slate-400 text-xs">avaliando...</span>;
  }
  // C4_PENDING = Claude ainda não respondeu
  if (os.recomendacao.rule_triggered === "C4_PENDING") {
    return (
      <span className="flex items-center gap-1 text-xs text-slate-400">
        <span className="inline-block w-3 h-3 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />
        analisando...
      </span>
    );
  }
  // C4_ERRO = Claude retornou erro
  if (os.recomendacao.rule_triggered === "C4_ERRO") {
    return (
      <span className="text-xs text-orange-500" title={os.recomendacao.motivo ?? ""}>
        erro IA
      </span>
    );
  }
  if (os.recomendacao.decision === "RESERVA") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        className="flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-700 text-xs font-semibold hover:bg-red-200 transition-colors"
      >
        🔴 RESERVAR
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs font-medium text-green-700">
      🟢 Sem reserva
    </span>
  );
}

// Label de complexidade baseada no tempo estimado (mesma escala do Retool)
function complexidadeLabel(min: number): { texto: string; cor: string } {
  if (min <= 0)   return { texto: "Sem diag",    cor: "text-slate-400" };
  if (min <= 20)  return { texto: "🟢 Muito Baixa", cor: "text-green-700" };
  if (min <= 40)  return { texto: "🟢 Baixa",       cor: "text-green-700" };
  if (min <= 60)  return { texto: "🟡 Média",        cor: "text-yellow-700" };
  if (min <= 120) return { texto: "🟠 Alta",         cor: "text-orange-700" };
  return           { texto: "🔴 Muito Alta",   cor: "text-red-700" };
}

// Painel lateral de detalhes da OS — abre ao clicar na linha
function DetalhePanel({ os, onClose }: { os: OSRow; onClose: () => void }) {
  const cx = complexidadeLabel(os.tempo_estimado_min);
  return (
    // Overlay clicável para fechar
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div
        className="relative bg-white w-full max-w-sm h-full shadow-2xl overflow-y-auto border-l border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header do painel */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-start justify-between">
          <div>
            <p className="text-xs text-slate-400 font-mono">OS {os.os_id}</p>
            <h3 className="text-lg font-bold text-slate-800">{os.placa || "Sem placa"}</h3>
            <p className="text-sm text-slate-500">{os.asset_model}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none mt-1">×</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Status e tempo */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-50 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Status</p>
              <StatusBadge status={os.status_atual} />
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Tempo em aberto</p>
              <p className="text-sm font-semibold text-slate-800">{formatMin(os.min_desde_open)}</p>
            </div>
          </div>

          {/* Complexidade */}
          <div className="bg-slate-50 rounded-lg p-3">
            <p className="text-xs text-slate-400 mb-1">Complexidade da OS</p>
            <p className={`text-sm font-semibold ${cx.cor}`}>{cx.texto}</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Estimado: {os.tempo_estimado_min > 0 ? `${os.tempo_estimado_min}min` : "—"}
              {" · "}{os.n_pecas} peça{os.n_pecas !== 1 ? "s" : ""} no diag
            </p>
          </div>

          {/* Peças do diagnóstico */}
          {os.todas_pecas_diag ? (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Peças do diagnóstico ({os.n_pecas})
              </p>
              <div className="bg-slate-50 rounded-lg p-3 space-y-1">
                {os.todas_pecas_diag.split(', ').map((peca, i) => {
                  const isCritica = os.pecas_criticas.includes(peca);
                  const semEstoque = os.pecas_sem_estoque.includes(peca);
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        isCritica ? 'bg-red-500' : semEstoque ? 'bg-orange-400' : 'bg-slate-300'
                      }`} />
                      <span className={`text-sm ${
                        isCritica ? 'text-red-700 font-medium' :
                        semEstoque ? 'text-orange-700' : 'text-slate-700'
                      }`}>{peca}</span>
                      {isCritica && <span className="text-xs text-red-500 ml-auto">crítica</span>}
                      {semEstoque && !isCritica && <span className="text-xs text-orange-500 ml-auto">sem estoque</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-400 text-center">
              Diagnóstico não iniciado
            </div>
          )}

          {/* Descrição CX */}
          {os.descricao_cx && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Apontamento CX</p>
              <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 leading-relaxed">{os.descricao_cx}</p>
            </div>
          )}

          {/* Mecânico */}
          {os.mecanico_atual && (
            <div className="bg-slate-50 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-1">Mecânico atual</p>
              <p className="text-sm font-semibold text-slate-800">{os.mecanico_atual}</p>
            </div>
          )}

          {/* Recomendação (só pra AWAITING_MECHANIC) */}
          {os.recomendacao && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Recomendação</p>
              {os.recomendacao.decision === "RESERVA" ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-1">
                  <p className="text-xs font-bold text-red-700">🔴 RESERVAR</p>
                  <p className="text-sm text-red-800">{os.recomendacao.motivo}</p>
                  <p className="text-xs text-red-500">Regra: {os.recomendacao.rule_triggered}</p>
                </div>
              ) : (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                  <p className="text-xs font-bold text-green-700">🟢 Sem reserva</p>
                  <p className="text-xs text-green-600 mt-0.5">Avaliação de mecânicos pendente</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Ícone e título amigável por tipo de regra
function motivoInfo(rule: string | null): { icone: string; titulo: string } {
  if (!rule) return { icone: "🔴", titulo: "Reserva recomendada" };
  if (rule.startsWith("C1_HARD"))      return { icone: "🚨", titulo: "Situação crítica" };
  if (rule === "C1_ANOMALIA")          return { icone: "⚠️", titulo: "Anomalia de fluxo" };
  if (rule === "C2_SEM_ESTOQUE")       return { icone: "📦", titulo: "Peça sem estoque" };
  if (rule === "C3_PECA_CRITICA")      return { icone: "🔧", titulo: "Peça de alta complexidade" };
  if (rule === "C3_DIVERSAS_AVARIAS")  return { icone: "🔩", titulo: "Diversas avarias" };
  if (rule === "C3_TEMPO_ALTO")        return { icone: "⏱️", titulo: "Trabalho muito longo" };
  if (rule === "C3_TEMPO_COMBINADO")   return { icone: "⏳", titulo: "Tempo total excede limite" };
  if (rule === "C4_CLAUDE")            return { icone: "🤖", titulo: "Recomendação por IA" };
  return { icone: "🔴", titulo: "Reserva recomendada" };
}

// Modal de confirmação de reserva — abre ao clicar no badge 🔴
function ReservaModal({ os, onClose }: { os: OSRow; onClose: () => void }) {
  const rec = os.recomendacao!;
  const { icone, titulo } = motivoInfo(rec.rule_triggered);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-4">
          <div>
            <p className="text-xs text-slate-400 font-mono mb-0.5">{os.placa} · {os.asset_model}</p>
            <h2 className="text-lg font-bold text-slate-800">{icone} {titulo}</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        <div className="space-y-3">
          {/* Motivo principal */}
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            {rec.rule_triggered === "C4_CLAUDE" && (
              <p className="text-xs text-red-500 font-medium mb-1">🤖 Análise por IA</p>
            )}
            <p className="text-sm font-semibold text-red-800 leading-relaxed">{rec.motivo}</p>
          </div>

          {/* Detalhes técnicos da OS */}
          <div className="bg-slate-50 rounded-lg p-3 space-y-1.5 text-xs text-slate-600">
            <div className="flex justify-between">
              <span>Peças no diagnóstico</span>
              <span className="font-semibold text-slate-800">{rec.metadata.n_pecas_diag}</span>
            </div>
            <div className="flex justify-between">
              <span>Complexidade máxima</span>
              <span className="font-semibold text-slate-800">{rec.metadata.complexidade_max}/7</span>
            </div>
            <div className="flex justify-between">
              <span>Peça crítica no diag</span>
              <span className={`font-semibold ${rec.metadata.tem_peca_critica ? "text-red-600" : "text-green-600"}`}>
                {rec.metadata.tem_peca_critica ? "Sim" : "Não"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Estoque disponível</span>
              <span className={`font-semibold ${rec.metadata.estoque_ok ? "text-green-600" : "text-orange-600"}`}>
                {rec.metadata.estoque_ok ? "OK" : "Falta peça"}
              </span>
            </div>
            {rec.tempo_previsto_min && rec.tempo_previsto_min > 0 && (
              <div className="flex justify-between">
                <span>Tempo estimado</span>
                <span className="font-semibold text-slate-800">{rec.tempo_previsto_min}min</span>
              </div>
            )}
          </div>

          {/* Botões — Fase 4 vai ligar ao Supabase */}
          <div className="flex gap-2 pt-1">
            <button className="flex-1 py-2.5 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors">
              ✓ Confirmar reserva
            </button>
            <button className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-600 text-sm hover:bg-slate-50 transition-colors">
              ✗ Não reservar
            </button>
          </div>
          <p className="text-center text-xs text-slate-400">Feedback salvo no Supabase em breve</p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [osList, setOsList] = useState<OSRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [modalOS, setModalOS] = useState<OSRow | null>(null);
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState<Date | null>(null);
  const [baseFiltro, setBaseFiltro] = useState<"todas" | "1" | "34" | "166">("todas");
  const [detalheOS, setDetalheOS] = useState<OSRow | null>(null);

  async function buscarOS() {
    try {
      const res = await fetch("/api/os");
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const data: OSRow[] = await res.json();
      setOsList(data);
      setUltimaAtualizacao(new Date());
      setErro(null);

      // Depois de carregar, pede pro Claude avaliar os casos C4_PENDING
      // Só OS em AWAITING_MECHANIC que passaram por C1-C3 sem disparar
      const pendentes = data.filter(
        os => os.status_atual === "AWAITING_MECHANIC" &&
              os.recomendacao?.rule_triggered === "C4_PENDING"
      );

      // Chama em paralelo — Claude Haiku responde em ~1s cada
      pendentes.forEach(async (os) => {
        try {
          // Estado atual da oficina na mesma base — passado pro Claude raciocinar
          const osNaBase = data.filter(o => o.location_id === os.location_id);
          const emAndamento = osNaBase.filter(o => o.status_atual === "IN_PROGRESS");
          const aguardandoMec = osNaBase.filter(
            o => o.status_atual === "AWAITING_MECHANIC" && o.os_id !== os.os_id
          );
          // Tempo restante estimado por mecânico = estimado - tempo já no status atual
          const tempoRestanteList = emAndamento.map(o =>
            Math.max(0, o.tempo_estimado_min - o.min_no_status)
          );
          const tempoMedioRestante = tempoRestanteList.length > 0
            ? Math.round(tempoRestanteList.reduce((a, b) => a + b, 0) / tempoRestanteList.length)
            : 0;

          const r = await fetch("/api/recommendation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              os_id: os.os_id,
              placa: os.placa,
              asset_model: os.asset_model,
              location_id: os.location_id,
              min_desde_open: os.min_desde_open,
              tempo_estimado_min: os.tempo_estimado_min,
              n_pecas: os.n_pecas,
              complexidade_max: os.complexidade_max,
              todas_pecas_diag: os.todas_pecas_diag,
              peca_principal: os.peca_principal,
              mecanico_atual: os.mecanico_atual,
              descricao_cx: os.descricao_cx,
              oficina_estado: {
                mecanicos_em_os: emAndamento.length,
                tempo_medio_restante_min: tempoMedioRestante,
                outras_os_aguardando_mec: aguardandoMec.length,
              },
            }),
          });
          const resultado = await r.json();

          if (!r.ok) {
            // API retornou erro — mostra "erro" em vez de spinner eterno
            setOsList(prev => prev.map(item => {
              if (item.os_id !== os.os_id) return item;
              return {
                ...item,
                recomendacao: {
                  ...item.recomendacao!,
                  decision: "SEM_RESERVA" as const,
                  rule_triggered: "C4_ERRO",
                  motivo: resultado?.error ?? "Erro ao consultar Claude",
                  motivo_claude: null,
                },
              };
            }));
            return;
          }

          // Atualiza só a OS correspondente no estado — não refaz o fetch inteiro
          setOsList(prev => prev.map(item => {
            if (item.os_id !== os.os_id) return item;
            return {
              ...item,
              recomendacao: {
                ...item.recomendacao!,
                decision: resultado.decision,
                rule_triggered: "C4_CLAUDE",
                motivo: resultado.motivo_claude,
                motivo_claude: resultado.motivo_claude,
              },
            };
          }));
        } catch (err) {
          // Mostra erro em vez de spinner eterno
          setOsList(prev => prev.map(item => {
            if (item.os_id !== os.os_id) return item;
            return {
              ...item,
              recomendacao: {
                ...item.recomendacao!,
                decision: "SEM_RESERVA" as const,
                rule_triggered: "C4_ERRO",
                motivo: err instanceof Error ? err.message : "Erro desconhecido",
                motivo_claude: null,
              },
            };
          }));
        }
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    buscarOS();
    // Auto-refresh a cada 60 segundos — dados operacionais mudam a cada minuto
    const interval = setInterval(buscarOS, 60_000);
    return () => clearInterval(interval); // limpa ao desmontar o componente
  }, []);

  const base = (id: number) => id === 1 ? "Mooca" : id === 34 ? "Osasco" : id === 166 ? "SBC" : `Base ${id}`;

  // Aplica filtros: apenas piso + base selecionada
  const osExibidas = osList.filter(os => {
    if (os.is_piso !== 1) return false;
    if (baseFiltro !== "todas" && os.location_id !== Number(baseFiltro)) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-800">Recomendador de Reserva</h1>
            <p className="text-sm text-slate-500">
              {ultimaAtualizacao
                ? `Atualizado às ${ultimaAtualizacao.toLocaleTimeString("pt-BR")} · auto-refresh 60s`
                : "Carregando..."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Seletor de base */}
            <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm">
              {(["todas", "1", "34", "166"] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setBaseFiltro(b)}
                  className={`px-3 py-1.5 transition-colors ${
                    baseFiltro === b
                      ? "bg-slate-800 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {b === "todas" ? "Todas" : b === "1" ? "Mooca" : b === "34" ? "Osasco" : "SBC"}
                </button>
              ))}
            </div>

            {/* Contadores rápidos */}
            {!loading && (
              <div className="flex gap-3 text-sm">
                <span className="text-slate-500">
                  <span className="font-semibold text-slate-800">{osExibidas.length}</span> no piso
                </span>
                <span className="text-slate-300">|</span>
                <span className="text-red-600">
                  <span className="font-semibold">
                    {osExibidas.filter(o => o.recomendacao?.decision === "RESERVA").length}
                  </span> reservas
                </span>
              </div>
            )}

            <button
              onClick={buscarOS}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-100 transition-colors"
            >
              ↻ Atualizar
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {loading && (
          <div className="text-center py-20 text-slate-400">Buscando OS no ClickHouse...</div>
        )}
        {erro && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{erro}</div>
        )}

        {!loading && !erro && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="px-4 py-3">OS</th>
                  <th className="px-4 py-3">Placa</th>
                  <th className="px-4 py-3">Modelo</th>
                  <th className="px-4 py-3">Base</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">T. em aberto</th>
                  <th className="px-4 py-3">T. estimado</th>
                  <th className="px-4 py-3">Peça principal</th>
                  <th className="px-4 py-3">Mecânico</th>
                  <th className="px-4 py-3">Piso</th>
                  <th className="px-4 py-3">Reserva</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {osExibidas.map((os) => (
                  <tr
                    key={os.os_id}
                    onClick={() => setDetalheOS(os)}
                    className={`cursor-pointer hover:bg-slate-50 transition-colors ${
                      os.recomendacao?.decision === "RESERVA" ? "bg-red-50/40" : ""
                    } ${detalheOS?.os_id === os.os_id ? "ring-1 ring-inset ring-blue-300 bg-blue-50/30" : ""}`}
                  >
                    <td className="px-4 py-3 font-mono text-slate-600">{os.os_id}</td>
                    <td className="px-4 py-3 font-semibold text-slate-800">{os.placa || "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{os.asset_model}</td>
                    <td className="px-4 py-3 text-slate-500">{base(os.location_id)}</td>
                    <td className="px-4 py-3"><StatusBadge status={os.status_atual} /></td>
                    <td className="px-4 py-3 text-slate-600">{formatMin(os.min_desde_open)}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {os.tempo_estimado_min > 0 ? formatMin(os.tempo_estimado_min) : "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600 max-w-[140px] truncate" title={os.peca_principal}>
                      {os.peca_principal || "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {os.mecanico_atual || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {os.is_piso === 1 ? "👤" : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <ReservaBadge os={os} onClick={() => setModalOS(os)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Painel lateral de detalhes — abre ao clicar na linha */}
      {detalheOS && (
        <DetalhePanel os={detalheOS} onClose={() => setDetalheOS(null)} />
      )}

      {/* Modal de reserva — abre ao clicar no badge 🔴 */}
      {modalOS && (
        <ReservaModal os={modalOS} onClose={() => setModalOS(null)} />
      )}
    </div>
  );
}

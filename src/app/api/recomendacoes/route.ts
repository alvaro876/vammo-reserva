// GET /api/recomendacoes
//
// Endpoint enxuto pra consumo externo (ex.: ferramenta de gestão de outro time).
// Devolve, por OS ativa, a recomendação do RIVERS (reservar ou não + motivo),
// calculada na hora. Casar pelo os_id (= so_id no sistema de origem).
//
// É o mesmo motor do app (runRivers); aqui só entregamos um JSON limpo e estável.

import { NextResponse } from "next/server";
import { runRivers } from "@/lib/rivers-engine";

const BASES: Record<number, string> = { 1: "Mooca", 34: "Osasco", 166: "SBC" };

export async function GET(req: Request) {
  // Proteção por chave: se RIVERS_API_KEY estiver no ambiente, exige o header x-api-key.
  const key = process.env.RIVERS_API_KEY;
  if (key && req.headers.get("x-api-key") !== key) {
    return NextResponse.json(
      { error: "não autorizado — envie o header x-api-key" },
      { status: 401 }
    );
  }

  try {
    const rows = await runRivers();
    const recomendacoes = rows
      .filter((o) => o.recomendacao)
      .map((o) => ({
        os_id: o.os_id,
        placa: o.placa,
        base: BASES[o.location_id] ?? String(o.location_id),
        status: o.status_atual,
        is_piso: o.is_piso === 1,
        reservar: o.recomendacao!.decision === "RESERVA",
        decisao: o.recomendacao!.decision, // RESERVA | SEM_RESERVA
        motivo: o.recomendacao!.motivo, // texto legível do porquê
        regra: o.recomendacao!.rule_triggered, // código da regra que decidiu
        // "alta" | "fronteira" | null — fronteira = projeção a <30min da linha das 3h
        // (decisão de foto de chegada; vale confirmar no piso). null = regra sem projeção.
        confianca: o.recomendacao!.confianca ?? null,
        tempo_previsto_min: o.recomendacao!.tempo_previsto_min,
        // true = regra de alta precisão (~90%) + cliente em piso → pode acatar
        // direto, sem revisão. false = sugestão pra revisão humana.
        acao_automatica: o.acao_automatica,
        // termômetro da base: check-ins de manutenção ainda abertos agora. Insumo de
        // POLÍTICA de piso cheio (régua da operação); não dispara reserva sozinho.
        pressao_piso: o.pressao_piso,
      }));

    return NextResponse.json({
      atualizado_em: new Date().toISOString(),
      total: recomendacoes.length,
      recomendacoes,
    });
  } catch (e) {
    console.error("[recomendacoes] erro:", e);
    return NextResponse.json({ error: "Erro ao gerar recomendações" }, { status: 500 });
  }
}

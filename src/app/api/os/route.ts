// GET /api/os
//
// Por que esta rota existe?
// O browser não pode chamar o ClickHouse diretamente (as credenciais ficariam expostas).
// Esta rota roda no servidor Vercel, busca os dados, e devolve JSON limpo pro browser.
//
// A lógica (buscar OS, avaliar, logar) mora em @/lib/rivers-engine — porque o motor
// agendado (/api/cron) usa exatamente a mesma coisa.

import { NextResponse } from "next/server";
import { runRivers } from "@/lib/rivers-engine";
import { getLoggedReservaOsIds } from "@/lib/supabase";
import { notifyReserva } from "@/lib/slack";
import { basesTeste } from "@/lib/autonomia";
import { ALGO_VERSION } from "@/lib/algorithm";

// Hora de São Paulo (0-23) — usada pra só notificar dentro do horário de operação.
function horaSP(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Sao_Paulo" }).format(new Date())
  );
}

export async function GET() {
  try {
    // Quem já tinha reserva logada ANTES desta rodada (pra não notificar a mesma OS 2x)
    const jaLogadas = await getLoggedReservaOsIds(ALGO_VERSION);
    const osComRecomendacao = await runRivers();

    // Tela aberta vira gatilho: manda no Slack as reservas de piso NOVAS, dentro do horário (7h-21h).
    try {
      const hora = horaSP();
      if (hora >= 7 && hora < 21) {
        // Piloto: notifica só as bases do teste (Mooca; env RIVERS_BASES_TESTE expande sem deploy)
        const novas = osComRecomendacao.filter(
          (o) => o.recomendacao?.decision === "RESERVA" && o.is_piso === 1 && !jaLogadas.has(o.os_id) && basesTeste().has(o.location_id) && o.oferta_ativa !== 1
        );
        await notifyReserva(
          novas.map((o) => ({ os_id: o.os_id, placa: o.placa, location_id: o.location_id, motivo: o.recomendacao!.motivo, auto: o.acao_automatica, fronteira: o.recomendacao!.confianca === "fronteira" }))
        );
      }
    } catch (e) {
      console.error("[os] notify falhou:", e);
    }

    return NextResponse.json(osComRecomendacao);
  } catch (error) {
    console.error("Erro ao buscar OS:", error);
    // Retorna 500 com mensagem de erro — nunca expõe detalhes internos pro browser
    return NextResponse.json(
      { error: "Erro ao buscar dados. Verifique os logs do servidor." },
      { status: 500 }
    );
  }
}

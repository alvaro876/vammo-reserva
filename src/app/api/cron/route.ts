// GET /api/cron — o motor agendado do RIVERS.
//
// Roda SOZINHO (chamado por um agendador a cada 5-10min): avalia as OS, grava o log
// e notifica no Slack só as reservas NOVAS. Não depende de ninguém abrir a tela.
//
// Proteção: se CRON_SECRET estiver no ambiente, exige header
//   Authorization: Bearer <CRON_SECRET>
// (o Vercel Cron manda esse header automaticamente quando CRON_SECRET existe).
// Sem CRON_SECRET, a rota responde normal — útil pra testar antes de configurar.

import { NextRequest, NextResponse } from "next/server";
import { runRivers } from "@/lib/rivers-engine";
import { getBotPostsOsIds, registrarAvisosBot } from "@/lib/supabase";
import { notifyReserva, notifyAviso } from "@/lib/slack";
import { basesTeste } from "@/lib/autonomia";
import { ALGO_VERSION, restanteParaPronta } from "@/lib/algorithm";

// Janela de operação da oficina (horário de São Paulo). Fora disso não roda.
const HORA_ABRE = 7;
const HORA_FECHA = 21;

function horaSP(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/Sao_Paulo",
    }).format(new Date())
  );
}

export async function GET(req: NextRequest) {
  // ?test=1 → ignora horário e dedup, só pra validar o webhook do Slack na hora
  const isTest = req.nextUrl.searchParams.get("test") === "1";

  // 1) Autorização por segredo (quando configurado)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "não autorizado" }, { status: 401 });
    }
  }

  // 2) Só dentro do horário de operação
  const hora = horaSP();
  if (!isTest && (hora < HORA_ABRE || hora >= HORA_FECHA)) {
    return NextResponse.json({ skipped: true, motivo: `fora do horário (SP ${hora}h)` });
  }

  try {
    // 3) O que o BOT já postou (não o que o motor logou!) — a TV loga decisão a cada
    //    45s e o dedup pelo log fazia o bot perder quase toda reserva nova (TKX1J23).
    //    Em teste, ignora (sets vazios) pra forçar o envio dos casos atuais.
    const jaPostadasReserva = isTest ? new Set<number>() : await getBotPostsOsIds("reserva");

    // 4) Avalia + grava o log (idempotente)
    const result = await runRivers();

    // 5) Reservas de piso desta rodada, e quais são novas
    const reservasPiso = result.filter(
      (o) => o.recomendacao?.decision === "RESERVA" && o.is_piso === 1
    );
    // Piloto: notifica só as bases do teste (Mooca; env RIVERS_BASES_TESTE expande sem deploy).
    // E nunca anuncia cliente que a oficina JÁ atendeu — o check-in segue aberto ~4h depois
    // da oferta, então sem esse filtro o bot ficava pedindo reserva pra quem já tinha.
    const novas = reservasPiso.filter(
      (o) => !jaPostadasReserva.has(o.os_id) && basesTeste().has(o.location_id) && o.oferta_ativa !== 1
    );

    // 6) Notifica só as novas — e REGISTRA o post (é o registro que deduplica)
    const notificadas = await notifyReserva(
      novas.map((o) => ({
        os_id: o.os_id,
        placa: o.placa,
        location_id: o.location_id,
        motivo: o.recomendacao!.motivo,
        auto: o.acao_automatica,
        fronteira: o.recomendacao!.confianca === "fronteira",
      }))
    );
    if (notificadas > 0 && !isTest) {
      await registrarAvisosBot(novas.map((o) => ({ os_id: o.os_id, tipo: "reserva" })), ALGO_VERSION);
    }

    // 7) AVISOS de SLA (18/08, caso UGA1G47): cliente que vai cruzar (<=30min) ou já
    //    cruzou as 3h SEM regra de reserva — a moto sai antes de uma reserva chegar,
    //    e a ação certa é o CX conversar com o cliente. Mesma lógica do bucket
    //    "precisa avisar" da tela. Dedup próprio (rivers_bot_aviso, 48h, 1 por OS).
    const jaAvisadas = isTest ? new Set<number>() : await getBotPostsOsIds("aviso");
    const candidatosAviso = result.filter((o) => {
      if (o.is_piso !== 1 || !basesTeste().has(o.location_id)) return false;
      if (o.recomendacao?.decision === "RESERVA") return false; // reserva já tem mensagem própria
      if (o.oferta_ativa === 1) return false; // oficina já agiu — cliente já sabe
      if (jaAvisadas.has(o.os_id)) return false;
      // OS que o bot JÁ anunciou como reserva não ganha aviso depois (caso SWI9B54,
      // 18/08: "dê reserva" às 14:04 e "sem reserva, avisa que tá saindo" às 14:30 —
      // pra mesma moto isso lê como contradição; quem viu o alerta já está de olho).
      // (O contrário — reserva depois de aviso — é escalada legítima e continua indo.)
      if (jaPostadasReserva.has(o.os_id)) return false;
      const relogio =
        (o as unknown as { min_desde_chegada?: number }).min_desde_chegada ?? o.min_desde_open;
      const slaRestante = 180 - relogio;
      // Só ESTOURO (18/08, ajuste do Alvaro): o pré-aviso "vai passar mas sai logo"
      // virou ruído no grupo — no Slack fica só o caso específico que importa:
      // cliente que JÁ cruzou as 3h sem reserva sugerida e sem oferta da oficina
      // (o estouro silencioso). O pré-aviso continua na TELA (selo VAI PASSAR DAS 3H).
      if (slaRestante > 0) return false;
      return true;
    });
    const avisadas = await notifyAviso(
      candidatosAviso.map((o) => {
        const relogio =
          (o as unknown as { min_desde_chegada?: number }).min_desde_chegada ?? o.min_desde_open;
        const pronta = restanteParaPronta(o.status_atual, o.tempo_estimado_min || 0, o.exec_acum_min);
        return {
          os_id: o.os_id,
          placa: o.placa,
          location_id: o.location_id,
          sla_restante_min: 180 - relogio,
          pronta_em_min: pronta.min,
        };
      })
    );
    if (avisadas > 0 && !isTest) {
      await registrarAvisosBot(
        candidatosAviso.map((o) => {
          const relogio =
            (o as unknown as { min_desde_chegada?: number }).min_desde_chegada ?? o.min_desde_open;
          return { os_id: o.os_id, tipo: 180 - relogio > 0 ? "pre" : "estouro" };
        }),
        ALGO_VERSION
      );
    }

    return NextResponse.json({
      ok: true,
      test: isTest,
      hora_sp: hora,
      avaliadas: result.length,
      reservas_piso: reservasPiso.length,
      novas: novas.length,
      notificadas,
      avisos_sla: candidatosAviso.length,
      avisados: avisadas,
    });
  } catch (e) {
    console.error("[cron] erro:", e);
    return NextResponse.json({ error: "erro no cron" }, { status: 500 });
  }
}

// GET /api/health — monitor de precisão POR REGRA (o medidor da autonomia).
//
// Pra cada regra, nos últimos 14 dias: das OSs em que ela mandou RESERVA,
// quantas de fato passaram de 3h até ficar prontas? É a taxa que diz se a
// regra merece continuar no modo automático (ver src/lib/autonomia.ts).
//
// ?alert=1 → além de devolver o JSON, posta alerta no Slack se alguma regra
// AUTOMÁTICA estiver com precisão < 70% (com amostra mínima de 5 casos).
// Chamado 1x/dia pelo GitHub Actions (rivers-health.yml).
//
// Auth: mesmo esquema do cron — se CRON_SECRET existir, exige Bearer.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { getRecentSuggestions } from "@/lib/supabase";
import { regrasAuto } from "@/lib/autonomia";
import { notifyTexto } from "@/lib/slack";

const DIAS = 14;
const PRECISAO_MINIMA = 0.7; // abaixo disso, regra automática dispara alerta
const AMOSTRA_MINIMA = 5;    // sem amostra, sem veredito
const MATURIDADE_MIN = 180;  // só avalia sugestões com idade >= 3h (desfecho decidível)

interface Desfecho {
  os_id: number;
  pronta_min: number | null;
  permanencia_min: number | null;
  status_atual: string;
  idade_min: number;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }
  const alertar = req.nextUrl.searchParams.get("alert") === "1";

  try {
    // 1) Primeira decisão RESERVA por OS nos últimos N dias (qualquer versão)
    const sugestoes = await getRecentSuggestions(DIAS);
    const primeira = new Map<number, { regra: string; ts: number }>();
    for (const s of sugestoes) {
      if (s.decision !== "RESERVA" || !s.fired_layer) continue;
      if (!primeira.has(s.os_id)) {
        primeira.set(s.os_id, { regra: s.fired_layer, ts: Date.parse(s.created_at) });
      }
    }
    // maturidade: só sugestões feitas há pelo menos 3h (senão o desfecho não existe ainda)
    const agora = Date.now();
    const maduras = [...primeira.entries()].filter(
      ([, v]) => (agora - v.ts) / 60000 >= MATURIDADE_MIN
    );
    if (maduras.length === 0) {
      return NextResponse.json({ ok: true, janela_dias: DIAS, regras: {}, obs: "sem sugestões maduras na janela" });
    }

    // 2) Desfecho real no ClickHouse (em lotes de 1000 ids)
    const ids = maduras.map(([id]) => id);
    const desfechos = new Map<number, Desfecho>();
    for (let i = 0; i < ids.length; i += 1000) {
      const lote = ids.slice(i, i + 1000);
      const rows = await query<Desfecho>(`
        WITH st AS (
          SELECT so_id,
            argMax(status, created_at) AS status_atual,
            min(if(status='COMPLETED', created_at, NULL)) AS completed_at,
            min(if(status='AWAITING_CX', created_at, NULL)) AS pronta_at
          FROM oms_r.so_status FINAL
          WHERE _peerdb_is_deleted = 0 AND so_id IN (${lote.join(",")})
          GROUP BY so_id
        )
        SELECT so.id AS os_id,
          if(st.pronta_at IS NOT NULL AND st.pronta_at > so.created_at,
             dateDiff('minute', so.created_at, st.pronta_at), NULL) AS pronta_min,
          if(st.completed_at IS NOT NULL AND st.completed_at > so.created_at,
             dateDiff('minute', so.created_at, st.completed_at), NULL) AS permanencia_min,
          st.status_atual AS status_atual,
          dateDiff('minute', so.created_at, now()) AS idade_min
        FROM oms_r.so so FINAL
        JOIN st ON st.so_id = so.id
        WHERE so._peerdb_is_deleted = 0 AND so.id IN (${lote.join(",")})
      `);
      for (const r of rows) desfechos.set(Number(r.os_id), r);
    }

    // 3) Precisão por regra: passou de 3h até ficar pronta?
    //    (mesmas definições dos relatórios: pronta = 1º AWAITING_CX ou COMPLETED;
    //     ainda em atendimento com idade > 3h conta como "passou"; cancelada fica fora)
    const porRegra: Record<string, { n: number; passou_3h: number; sem_desfecho: number }> = {};
    for (const [os_id, { regra }] of maduras) {
      const d = desfechos.get(os_id);
      const acc = (porRegra[regra] ??= { n: 0, passou_3h: 0, sem_desfecho: 0 });
      if (!d) { acc.sem_desfecho++; continue; }
      const tempoUtil =
        d.pronta_min != null && d.permanencia_min != null
          ? Math.min(d.pronta_min, d.permanencia_min)
          : d.pronta_min ?? d.permanencia_min;
      if (tempoUtil != null) {
        acc.n++;
        if (tempoUtil > 180) acc.passou_3h++;
      } else if (d.status_atual === "CANCELLED") {
        acc.sem_desfecho++;
      } else {
        acc.n++;
        if (d.idade_min > 180) acc.passou_3h++;
      }
    }

    const auto = regrasAuto();
    const regras = Object.fromEntries(
      Object.entries(porRegra)
        .sort((a, b) => b[1].n - a[1].n)
        .map(([regra, v]) => [
          regra,
          {
            ...v,
            precisao: v.n > 0 ? Math.round((v.passou_3h / v.n) * 100) / 100 : null,
            modo: auto.has(regra) ? "AUTOMATICA" : "sugestao",
          },
        ])
    );

    // 4) Alerta: regra AUTOMÁTICA com precisão abaixo do piso
    const degradadas = Object.entries(regras).filter(
      ([, v]) =>
        v.modo === "AUTOMATICA" && v.n >= AMOSTRA_MINIMA && (v.precisao ?? 1) < PRECISAO_MINIMA
    );
    let alerta_enviado = false;
    if (alertar && degradadas.length > 0) {
      const linhas = degradadas
        .map(([r, v]) => `• *${r}*: ${Math.round((v.precisao ?? 0) * 100)}% em ${v.n} casos (piso: ${PRECISAO_MINIMA * 100}%)`)
        .join("\n");
      alerta_enviado = await notifyTexto(
        `⚠️ *RIVERS — regra automática com precisão degradada (últimos ${DIAS} dias)*\n` +
          linhas +
          `\nAção: revisar e, se preciso, tirar do modo automático via env RIVERS_REGRAS_AUTO.`
      );
    }

    return NextResponse.json({
      ok: true,
      janela_dias: DIAS,
      maturidade_min: MATURIDADE_MIN,
      sugestoes_avaliadas: maduras.length,
      regras,
      degradadas: degradadas.map(([r]) => r),
      alerta_enviado,
    });
  } catch (e) {
    console.error("[health] erro:", e);
    return NextResponse.json({ error: "erro no health" }, { status: 500 });
  }
}

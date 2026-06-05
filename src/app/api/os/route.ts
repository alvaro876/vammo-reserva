// GET /api/os
//
// Por que esta rota existe?
// O browser não pode chamar o ClickHouse diretamente (as credenciais ficariam expostas).
// Esta rota roda no servidor Vercel, busca os dados, e devolve JSON limpo pro browser.
//
// Como funciona uma rota no Next.js App Router?
// Basta exportar uma função com o nome do método HTTP (GET, POST, etc.)
// no arquivo route.ts dentro de app/api/alguma-coisa/.
// Sem Express, sem configuração extra.

import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { avaliarOS, AlgoritmoInput, MecanicoEstado } from "@/lib/algorithm";

// SQL que busca OS ativas com tudo que o algoritmo e a tabela precisam
// Já validado manualmente no ClickHouse em 11/05/2026
const OS_QUERY = `
WITH
item_skill AS (
    SELECT item_group_id AS igid, skill_level AS skill FROM (
        SELECT 296 AS item_group_id, 7 AS skill_level UNION ALL
        SELECT 240,6 UNION ALL SELECT 250,6 UNION ALL SELECT 308,6 UNION ALL
        SELECT 340,6 UNION ALL SELECT 359,6 UNION ALL
        SELECT 184,5 UNION ALL SELECT 357,5 UNION ALL SELECT 229,5 UNION ALL
        SELECT 257,5 UNION ALL SELECT 258,5 UNION ALL SELECT 259,5 UNION ALL SELECT 260,5 UNION ALL
        SELECT 214,4 UNION ALL SELECT 215,4 UNION ALL
        SELECT 219,3 UNION ALL SELECT 247,3 UNION ALL SELECT 344,3 UNION ALL
        SELECT 345,3 UNION ALL SELECT 346,3 UNION ALL
        SELECT 212,2 UNION ALL SELECT 222,2 UNION ALL SELECT 223,2 UNION ALL SELECT 224,2 UNION ALL
        SELECT 310,2 UNION ALL SELECT 330,2 UNION ALL SELECT 331,2 UNION ALL SELECT 332,2 UNION ALL
        SELECT 273,1 UNION ALL SELECT 274,1 UNION ALL SELECT 288,1 UNION ALL SELECT 289,1
    )
),
os_meta AS (
    SELECT
        so.id AS os_id,
        so.so_type AS so_type,
        so.location_id AS location_id,
        so.asset_model AS asset_model,
        JSONExtractString(so.maintenance_metadata, 'license_plate') AS placa,
        coalesce(so.so_description, '') AS descricao_cx,
        JSONExtractBool(so.maintenance_metadata, 'checklist_tags.immobilizing') AS imobilizada,
        JSONExtractBool(so.maintenance_metadata, 'checklist_tags.accident') AS acidente,
        JSONExtractBool(so.maintenance_metadata, 'checklist_tags.towing') AS guincho,
        argMax(ss.status, ss.created_at) AS status_atual,
        maxIf(ss.created_at, ss.status = 'AWAITING_MECHANIC') AS ts_awaiting_mec,
        dateDiff('minute', so.created_at, now('America/Sao_Paulo')) AS min_desde_open,
        dateDiff('minute', so.created_at, maxIf(ss.created_at, ss.status = 'AWAITING_MECHANIC')) AS min_open_to_awaiting,
        dateDiff('minute', max(ss.created_at), now('America/Sao_Paulo')) AS min_no_status
    FROM oms_r.so so FINAL
    JOIN oms_r.so_status ss FINAL ON ss.so_id = so.id
    WHERE so.asset_type = 'BIKE'
      AND so.location_id IN (1, 34, 166)
      AND so.deleted_at IS NULL
      AND so._peerdb_is_deleted = 0
      AND ss._peerdb_is_deleted = 0
      AND so.asset_model NOT IN ('S 60V45Ah', 'T 74V28Ah')
    GROUP BY so.id, so.so_type, so.location_id, so.asset_model,
             so.maintenance_metadata, so.so_description, so.created_at
    HAVING status_atual IN ('OPEN', 'IN_PROGRESS', 'IN_DIAGNOSIS', 'AWAITING_MECHANIC', 'PAUSED', 'AWAITING_QA', 'IN_QA', 'QA_REJECTED', 'AWAITING_VMGMT')
       AND toDate(so.created_at, 'America/Sao_Paulo') >= toDate(now('America/Sao_Paulo')) - 1
),
mecanico_atual AS (
    SELECT
        ss.so_id AS os_id,
        argMaxIf(u.name, ss.created_at, ss.status = 'IN_PROGRESS') AS mecanico_nome
    FROM oms_r.so_status ss FINAL
    JOIN ims_r."user" u FINAL ON u.id = ss.user_id
    WHERE ss._peerdb_is_deleted = 0
      AND u._peerdb_is_deleted = 0
    GROUP BY ss.so_id
),
pecas_diag AS (
    SELECT
        si.so_id AS os_id,
        count(DISTINCT si.item_group_id) AS n_pecas,
        sum(si.quantity * coalesce(nullIf(ig.time_target, 0), if(ig.id = 308, 41, 0))) + 12 AS tempo_estimado_min,
        max(coalesce(isk.skill, 1)) AS complexidade_max,
        sumIf(1, si.item_group_id IN (257,258,259,260,184,357,250,308,340,359,296,240)) AS n_pecas_criticas,
        argMaxIf(ig.name, coalesce(isk.skill, 1), si.item_group_id > 0) AS peca_principal,
        arrayStringConcat(groupUniqArray(ig.name), ', ') AS todas_pecas_diag
    FROM oms_r.so_item si FINAL
    LEFT JOIN ims_r.item_group ig FINAL ON ig.id = si.item_group_id
    LEFT JOIN item_skill isk ON isk.igid = si.item_group_id
    WHERE si.origin IN ('DIAGNOSIS', 'MECHANIC')
      AND si._peerdb_is_deleted = 0
      AND si.quantity > 0
    GROUP BY si.so_id
),
estoque AS (
    SELECT
        i.item_group_id AS item_group_id,
        d.location_id AS location_id,
        sum(inv.quantity) AS qty_disponivel
    FROM ims_r.inventory inv FINAL
    INNER JOIN ims_r.item i FINAL ON i.id = inv.item_id
    INNER JOIN ims_r.deposit d FINAL ON d.id = inv.deposit_id
    WHERE inv.status = 'AVAILABLE'
      AND d.type IN ('STORAGE', 'STAGING')
      AND d.location_id IN (1, 34, 166)
      AND inv._peerdb_is_deleted = 0
      AND i._peerdb_is_deleted = 0
      AND d._peerdb_is_deleted = 0
    GROUP BY i.item_group_id, d.location_id
),
sem_estoque AS (
    SELECT
        si.so_id AS os_id,
        sumIf(1, if(e.qty_disponivel > 0, e.qty_disponivel, 0) < si.qty_s) AS n_sem_estoque,
        arrayStringConcat(
            arrayFilter(x -> x != '',
                groupArray(if(if(e.qty_disponivel > 0, e.qty_disponivel, 0) < si.qty_s, ig2.name, ''))
            ), ', '
        ) AS pecas_sem_estoque
    FROM (
        SELECT so_id AS so_id, item_group_id AS item_group_id, sum(quantity) AS qty_s
        FROM oms_r.so_item FINAL
        WHERE origin IN ('DIAGNOSIS','MECHANIC') AND _peerdb_is_deleted = 0 AND quantity > 0
        GROUP BY so_id, item_group_id
    ) si
    INNER JOIN os_meta om ON om.os_id = si.so_id
    LEFT JOIN estoque e ON e.item_group_id = si.item_group_id AND e.location_id = om.location_id
    LEFT JOIN ims_r.item_group ig2 FINAL ON ig2.id = si.item_group_id
    GROUP BY si.so_id
),
pecas_criticas_nomes AS (
    SELECT
        si.so_id AS os_id,
        arrayStringConcat(groupArray(ig3.name), ', ') AS pecas_criticas
    FROM oms_r.so_item si FINAL
    JOIN ims_r.item_group ig3 FINAL ON ig3.id = si.item_group_id
    WHERE si.item_group_id IN (257,258,259,260,184,357,250,308,340,359,296,240)
      AND si.origin IN ('DIAGNOSIS','MECHANIC')
      AND si._peerdb_is_deleted = 0
      AND si.quantity > 0
    GROUP BY si.so_id
),
is_piso AS (
    SELECT c.so_id AS os_id
    FROM maestro_scheduler_r.checkin c FINAL
    WHERE c._peerdb_is_deleted = 0
      AND c.checkin_type = 'MAINTENANCE'
      AND c.so_id IS NOT NULL
      AND c.status NOT IN ('NO_SHOW', 'CANCELLED', 'DROPOUT')
      AND c.called_at IS NOT NULL
      AND toDate(c.created_at, 'America/Sao_Paulo') = toDate(now('America/Sao_Paulo'))
)
SELECT
    om.os_id AS os_id,
    om.so_type AS so_type,
    om.location_id AS location_id,
    om.asset_model AS asset_model,
    om.placa AS placa,
    om.descricao_cx AS descricao_cx,
    om.status_atual AS status_atual,
    om.min_desde_open AS min_desde_open,
    om.min_no_status AS min_no_status,
    om.imobilizada AS imobilizada,
    om.acidente AS acidente,
    om.guincho AS guincho,
    om.min_open_to_awaiting AS min_open_to_awaiting,
    coalesce(ma.mecanico_nome, '') AS mecanico_atual,
    coalesce(p.n_pecas, 0) AS n_pecas,
    coalesce(p.tempo_estimado_min, 0) AS tempo_estimado_min,
    coalesce(p.complexidade_max, 0) AS complexidade_max,
    coalesce(p.n_pecas_criticas, 0) AS n_pecas_criticas,
    coalesce(p.peca_principal, '') AS peca_principal,
    coalesce(p.todas_pecas_diag, '') AS todas_pecas_diag,
    coalesce(se.n_sem_estoque, 0) AS n_sem_estoque,
    coalesce(se.pecas_sem_estoque, '') AS pecas_sem_estoque,
    coalesce(pcn.pecas_criticas, '') AS pecas_criticas,
    if(ip.os_id IS NOT NULL, 1, 0) AS is_piso
FROM os_meta om
LEFT JOIN mecanico_atual ma ON ma.os_id = om.os_id
LEFT JOIN pecas_diag p ON p.os_id = om.os_id
LEFT JOIN sem_estoque se ON se.os_id = om.os_id
LEFT JOIN pecas_criticas_nomes pcn ON pcn.os_id = om.os_id
LEFT JOIN is_piso ip ON ip.os_id = om.os_id
ORDER BY om.min_desde_open DESC
`;

// Tipo estendido do que o SQL retorna (inclui campos não presentes em AlgoritmoInput)
type OSRow = AlgoritmoInput & { mecanico_atual: string };

export async function GET() {
  try {
    // Busca os dados do ClickHouse
    const rows = await query<OSRow>(OS_QUERY);

    // ── C4: Computa estado dos mecânicos a partir das OS ativas ──────────
    // Mecânicos IN_PROGRESS → ocupados, min_restantes = estimado - já trabalhado
    // Mecânicos em AWAITING_QA/PAUSED → livres (acabaram a OS, esperando próxima)
    // Skill proxy: se a OS atual tem complexidade >= 5 (MEC2), o mecânico é MEC2+
    //
    // Limitação conhecida: mecânicos que finalizaram todas as OS hoje e estão
    // ociosos não aparecem aqui (não têm OS ativa). Resulta em contagem conservadora
    // (pode sugerir reserva para OS que teriam mecânico disponível). Aceitável no DEV.
    const mecMap = new Map<string, MecanicoEstado>();

    for (const row of rows) {
      if (!row.mecanico_atual) continue;
      const email = row.mecanico_atual;

      if (row.status_atual === "IN_PROGRESS") {
        // Ocupado — prioridade sobre qualquer estado "livre" anterior
        mecMap.set(email, {
          email,
          status_atual: "IN_PROGRESS",
          location_id: row.location_id,
          min_restantes: Math.max(0, row.tempo_estimado_min - row.min_no_status),
          skill_level: row.complexidade_max >= 5 ? 5 : 3,
        });
      } else if (!mecMap.has(email)) {
        // Livre (AWAITING_QA, PAUSED, etc.) — só registra se ainda não vimos ele ocupado
        mecMap.set(email, {
          email,
          status_atual: row.status_atual,
          location_id: row.location_id,
          min_restantes: 0,
          skill_level: row.complexidade_max >= 5 ? 5 : 3,
        });
      }
    }

    const todosMecanicos = Array.from(mecMap.values());

    // Statuses onde reserva ainda faz sentido — cliente está esperando
    const STATUSES_AVALIAVEIS = new Set([
      "OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "IN_PROGRESS", "PAUSED", "AWAITING_VMGMT",
    ]);

    const osComRecomendacao = rows.map((row) => {
      const recomendacao = STATUSES_AVALIAVEIS.has(row.status_atual)
        ? avaliarOS({ ...row, mecanicos: todosMecanicos } as AlgoritmoInput)
        : null;

      return {
        ...row,
        recomendacao,
      };
    });

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

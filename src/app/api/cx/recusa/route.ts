// POST /api/cx/recusa → registra POR QUE o cliente recusou a moto reserva.
//
// Protegida pelo mesmo token da tela (/api/cx/* está em PROTEGIDAS no middleware).
// Corpo: { os_id: number, motivo: <código de src/lib/recusa.ts>, detalhe?: string,
//          actor?: string, placa?: string, location_id?: number }
// Uma linha por OS (upsert): registrar de novo sobrescreve o motivo anterior.

import { NextRequest, NextResponse } from "next/server";
import { registrarRecusaMotivo } from "@/lib/supabase";
import { CODIGOS_RECUSA, MOTIVOS_RECUSA } from "@/lib/recusa";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corpo JSON inválido" }, { status: 400 });
  }
  try {
    if (typeof body.os_id !== "number" || !Number.isInteger(body.os_id)) {
      return NextResponse.json({ error: "os_id (inteiro) é obrigatório" }, { status: 400 });
    }
    if (typeof body.motivo !== "string" || !CODIGOS_RECUSA.has(body.motivo)) {
      return NextResponse.json(
        { error: "motivo inválido", motivos: MOTIVOS_RECUSA.map((m) => m.code) },
        { status: 400 }
      );
    }
    const detalhe =
      typeof body.detalhe === "string" && body.detalhe.trim() ? body.detalhe.trim().slice(0, 500) : null;
    if (body.motivo === "outro" && !detalhe) {
      return NextResponse.json({ error: "em 'outro', descreva o motivo em detalhe" }, { status: 400 });
    }
    const r = await registrarRecusaMotivo({
      os_id: body.os_id,
      placa: typeof body.placa === "string" ? body.placa.trim().slice(0, 16) || null : null,
      location_id:
        typeof body.location_id === "number" && Number.isInteger(body.location_id) ? body.location_id : null,
      motivo: body.motivo,
      detalhe,
      actor: typeof body.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 80) : null,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Erro ao registrar o motivo da recusa" }, { status: 500 });
  }
}

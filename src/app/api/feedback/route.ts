// POST /api/feedback
//
// Registra se o líder de turno acatou (ou não) a sugestão de reserva.
// É a metade "humana" da medição de acurácia (a outra é a verdade de campo).

import { NextRequest, NextResponse } from "next/server";
import { logRiversFeedback } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (typeof body.os_id !== "number" || typeof body.aceitou !== "boolean") {
      return NextResponse.json(
        { error: "os_id (number) e aceitou (boolean) sao obrigatorios" },
        { status: 400 }
      );
    }

    const r = await logRiversFeedback({
      os_id: body.os_id,
      aceitou: body.aceitou,
      actor: body.actor ?? null,
      motivo_humano: body.motivo_humano ?? null,
    });

    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Erro ao registrar feedback" }, { status: 500 });
  }
}

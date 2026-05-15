// POST /api/recommendation
//
// Recebe os dados de uma OS que passou por C1-C3 sem disparar nenhuma regra
// (rule_triggered = "C4_PENDING") e pede pro Claude decidir.
//
// Por que Claude aqui e não mais regras IF/ELSE?
// C1-C3 cobrem os casos determinísticos (~90%). O que sobra são combinações
// sutis: descrição CX preocupante, skill do mecânico vs complexidade, mix
// incomum de peças. Isso é exatamente o que um LLM faz bem.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Payload que o frontend manda
interface RecommendationRequest {
  os_id: number;
  placa: string;
  asset_model: string;
  location_id: number;
  min_desde_open: number;
  tempo_estimado_min: number;
  n_pecas: number;
  complexidade_max: number;
  todas_pecas_diag: string;
  peca_principal: string;
  mecanico_atual: string;
  descricao_cx: string;
  oficina_estado?: {
    mecanicos_em_os: number;
    tempo_medio_restante_min: number;
    outras_os_aguardando_mec: number;
  };
}

function baseName(id: number): string {
  if (id === 1) return "Mooca";
  if (id === 34) return "Osasco";
  if (id === 166) return "São Bernardo";
  return `Base ${id}`;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY não configurada" },
      { status: 500 }
    );
  }

  const data: RecommendationRequest = await req.json();

  const estado = data.oficina_estado;
  const estadoTexto = estado
    ? `ESTADO ATUAL DA OFICINA (${baseName(data.location_id)}):
- Mecânicos trabalhando agora: ${estado.mecanicos_em_os}
- Tempo médio restante nas OS em andamento: ${estado.tempo_medio_restante_min}min
- Outras OS aguardando mecânico (fila): ${estado.outras_os_aguardando_mec}
`
    : "";

  // Prompt direto ao ponto — Claude age como assistente do shift leader
  const prompt = `Você é um assistente de decisão da oficina Vammo (motos elétricas por assinatura em São Paulo).

Uma OS acabou de entrar em AWAITING_MECHANIC. O algoritmo determinístico verificou e confirmou:
- Moto NÃO está imobilizada, sem acidente, sem guincho
- TODAS as peças têm estoque disponível
- NENHUMA peça crítica (motor, balança, caixa de direção, chassi, garfo)
- Menos de 9 tipos de peça diferentes
- Trabalho estimado ≤ 120min
- Tempo total (espera + estimado) ≤ 180min

Mesmo assim, pode haver motivo para reserva baseado no contexto.

DADOS DA OS:
- Placa: ${data.placa} | Modelo: ${data.asset_model} | Base: ${baseName(data.location_id)}
- Tempo esperando: ${data.min_desde_open}min
- Peças no diagnóstico: ${data.n_pecas} peça(s), estimado ${data.tempo_estimado_min}min
- Peças diagnosticadas: ${data.todas_pecas_diag || "não informado"}
- Peça principal: ${data.peca_principal || "não identificada"}
- Nível de complexidade: ${data.complexidade_max}/7
- Mecânico designado: ${data.mecanico_atual || "nenhum ainda"}
- Apontamento do CX: "${data.descricao_cx || "sem apontamento"}"

${estadoTexto}CRITÉRIO:
Recomende reserva se o conjunto de fatores indicar que a moto provavelmente não ficará pronta em tempo hábil para o cliente (meta: até 3h desde abertura da OS). Considere especialmente:
1. O apontamento do CX, que pode revelar problemas não capturados no diagnóstico formal.
2. A demanda atual da oficina — se há muitos mecânicos ocupados com OS longas e uma fila de espera grande, mesmo uma OS simples pode não ser concluída a tempo.

Responda APENAS com JSON válido, sem texto adicional:
{"decision": "RESERVA" ou "SEM_RESERVA", "motivo": "explicação em 1 frase curta em português, direto ao shift leader"}`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

    // Extrai o texto da resposta
    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Resposta inesperada do Claude");
    }

    // Parse do JSON — Claude às vezes inclui markdown ```json ... ```
    const jsonText = content.text.replace(/```json\n?|\n?```/g, "").trim();
    const result = JSON.parse(jsonText);

    if (!result.decision || !result.motivo) {
      throw new Error("JSON inválido: faltam campos decision ou motivo");
    }

    return NextResponse.json({
      os_id: data.os_id,
      decision: result.decision,
      motivo_claude: result.motivo,
    });
  } catch (error) {
    console.error("Erro ao chamar Claude:", error);
    return NextResponse.json(
      { error: "Falha ao obter recomendação do Claude" },
      { status: 500 }
    );
  }
}

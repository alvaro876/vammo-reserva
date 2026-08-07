// Algoritmo de recomendação de reserva — camadas determinísticas
//
// Camada 4: capacidade da oficina — usa a curva de mecânicos ESPERADOS
// (base × dia-da-semana × hora, do histórico, injetada em route.ts) + a fila de
// trabalho esperando mecânico, pra estimar se a OS fica pronta em 3h.

import { Recomendacao, ReservaDecision } from "@/types";

// Versão da lógica — muda quando alteramos regras/thresholds (p/ comparar acurácia no log)
export const ALGO_VERSION = "0.26.0"; // 0.26.0 = RÉGUA DO CLIENTE. O relógio de TODAS as regras passa
                                     // a contar desde o CHECK-IN, não desde a abertura da OS.
                                     // Achado pelo Alvaro em 06/08 comparando as telas: Maestro
                                     // mostrava 3h15 e o RIVERS 2h44 pra mesma moto (TJC3C62) —
                                     // 31min de gap. Medido em 90d/Mooca: gap mediano 15min (p75
                                     // 26, p90 42); 27,2% dos clientes estouram 3h pela régua
                                     // real contra 22,3% pela régua da OS; 168 clientes (~2/dia)
                                     // estouraram sendo INVISÍVEIS pro sistema. Backtest (config
                                     // cli160): precisão 89,6%→95,5%, +57 clientes pegos a tempo,
                                     // e todos os dias da amostra >=80% (30/07 67%→80%, 31/07
                                     // 71%→93%). Gatilho do relógio 150→160 pra acompanhar a
                                     // escala nova. A tela do CX passa a mostrar o MESMO número
                                     // do Maestro — some a divergência que minava a confiança.
                                     // 0.25.0 = fix no gate do C3_RELOGIO_150: usa o restante SEM
                                     // CLAMP (permite negativo) — antes, execução que já passava
                                     // da estimativa lia restante=0 e o gate calava a regra bem no
                                     // caso mais perigoso (estimativa provada errada). Achado no
                                     // caçador de erros de 06/08 (OS 50408: 159min de execução com
                                     // estimativa de 71, ficou 176min em silêncio total até entrar
                                     // em QA e sair do radar — nem contava como erro, só desaparecia).
                                     // Backtest 92d: recall 71,9%→82,5% (+160 disparos), precisão da
                                     // regra 91,0%→88,7%. Custo real, não escondido: alguns dias
                                     // mostram precisão diária pior, porque escapes antes invisíveis
                                     // passam a aparecer como tentativa (certa ou errada) em vez de
                                     // silêncio — preferível pro cliente, mais ruidoso pro placar.
                                     // 0.24.0 = C3_RELOGIO_150: gate de "quase pronta" de 30→60min
                                     // (investigação do dia 05/08 à noite). Precisão real do dia:
                                     // 50% (4/8) — em TODOS os 4 erros a estimativa achava 40-71min
                                     // restantes e o real era 9-24. O gate de 30 nunca pegava porque
                                     // mede a mesma estimativa que infla. Backtest 92d: 60 leva a
                                     // regra de 86,6%→90,9% (n=317). TRADE-OFF medido e assumido: não
                                     // é rampa, é penhasco — já em 45min o recall do dia 04/08 cai de
                                     // 71%→43% e não piora mais depois; 60 é o ponto de equilíbrio,
                                     // não o ótimo de precisão pura (esse seria ~90, custando mais
                                     // recall). Ratio de ritmo do mecânico testado e descartado (não
                                     // separou os casos tão bem quanto o limiar simples).
                                     // 0.23.0 = MADRUGADA DE 05/08 (ordem do Alvaro: 3 fases + backtest
                                     // até >=80%/dia). Diagnóstico: pesquisa de indústria (Lyft/Uber/
                                     // DoorDash + literatura de process monitoring) + análise de 92d.
                                     // Novo: (a) C3_RELOGIO_150 — piso, 150min, FORA de QA, não-quase-
                                     // pronta = 87,3% (n=887; hazard lognormal, split QA vale 65pp);
                                     // (b) C1_QA_TARDIA — rejeição c/ 165min+ = 98,9% (n=91);
                                     // (c) retrabalho pós-rejeição = 45min (era 0);
                                     // (d) COMB firme só com estimativa >=180 (faixa 150-180 = 63,8%
                                     // vira relógio/aviso); (e) vistoria com gate de projeção;
                                     // (f) fator 9+ peças 0,85 / 13+ 0,80 (viés +39/+47 corrigido);
                                     // (g) classificador logístico EM SOMBRA (calib/classificador-v1,
                                     // teste 5d: 89,3%/96,2%) — promove só com validação ao vivo.
                                     // BACKTEST (scripts/backtest-v23.mjs, config f2b, 92d):
                                     // 88,7% de precisão, 84% recall<180; últimos 5 dias TODOS >=80%
                                     // (80,0/81,8/100/100/100/83,3). Antes: 73,2% e dias de 38-50%.
                                     // 0.22.0 = C4_CAPACIDADE desligado como gatilho de reserva
                                     // (segue como medidor; religa com RIVERS_REGRA_C4=on). Placar de
                                     // 03/08: pós-v0.21 TODOS os erros do dia foram C4 (projeções
                                     // coladas em 181 — o teto de fila tirou a resolução da regra);
                                     // 1 acerto em 5 no dia; e desde julho sabemos que lotação não
                                     // prevê estouro. Sem ele, a noite de 03/08 fechava 3/3. O tempo
                                     // fica 100% com o C3 (combinado + serviço grande).
                                     // 0.21.0 = dois consertos pela meta de 80%/dia (Alvaro, 03/08):
                                     // (a) RESERVA só se o restante+QA >= 30min — moto quase pronta
                                     // que cruza a linha de raspão ganha AVISO pelo relógio na tela,
                                     // não reserva (a entrega da reserva leva ~30min, não chega antes
                                     // da moto; 3 dos 10 erros do dia 31 eram essa classe);
                                     // (b) teto de 15min na espera de fila do C4 pra cliente de piso
                                     // (piso fura a fila, mediana real 4-5min; a fila de papel do fim
                                     // de tarde gerou os 2 piores erros do dia 31). Fator até 16
                                     // peças foi testado e NÃO melhorou (80,5→80,1%) — não subiu.
                                     // 0.20.0 = gatilho da projeção volta pra LINHA DAS 3H (180) por
                                     // decisão do Alvaro no dia 1: "se der estimado mais de 3h, tem
                                     // que disparar reserva" (caso TMB8G64: 2h48 em fila de QA, 12min
                                     // da linha, zero aviso). Troca consciente: 71% de acerto em >180
                                     // (~6,8/dia) vs 90,2% em >240 (3,2/dia); a faixa 180-240 sai
                                     // marcada FRONTEIRA. C3_TEMPO_ALTO segue em 240 (dispara antes,
                                     // com confiança alta, pros serviços grandes).
                                     // 0.19.0 = REMOVIDA a C1_RETORNO (inspeção de retorno com
                                     // cliente em piso → reserva). Decisão do Alvaro no go-live:
                                     // regra de TIPO não mede nada da moto — os 84,4% (Mooca/60d)
                                     // vêm em boa parte de priorização da oficina (mediana 13h =
                                     // "sem pressa", não reparo longo), e dar reserva pode se
                                     // auto-alimentar (moto vira ainda menos urgente). O tipo
                                     // segue no payload como CONTEXTO (selo na tela do CX); essas
                                     // OSs voltam ao fluxo normal (C5_AGUARDA_DIAG → C3/C4).
                                     // 0.18.0 = RECALIBRAÇÃO COMPLETA dos tempos (antecipada de
                                     // sábado a pedido do Alvaro): mapa de minutos/peça vira a
                                     // mediana REAL de bancada (141 peças, treino 150-60d atrás,
                                     // teste separado 60d piso Mooca), fator por nº de peças refeito
                                     // ([1.39..0.94] — o antigo [0.2..1.0] compensava tempos irreais)
                                     // e gatilhos na escala nova: C3_TEMPO_ALTO >240 (87,5%, n=72),
                                     // C3_COMBINADO/C4 por projecao_reserva_min=240 (90,2%, n=194,
                                     // 3,2/dia — a regra de hoje media 71-77%). tempo_total_max=180
                                     // segue sendo a LINHA das 3h pra exibição; o gatilho de reserva
                                     // é a projeção 240 (projetar 190 não condena: 71% em >180).
                                     // 0.17.0 = C3_TEMPO_ALTO sobe 140→180. Medido na MOOCA (60d,
                                     // piso): em 140 acertava 57,6% porque a estimativa mente na
                                     // faixa 141-180 (diz 155min, a bancada faz 100). Em 180 = 79,5%.
                                     // A recalibração completa dos tempos (mapa histórico + fator +
                                     // gatilho juntos) fica pro sábado com validação por replay: a
                                     // simulação de 31/07 mostrou que trocar SÓ o mapa piora o
                                     // C3_COMBINADO de 77→71% — os erros do cadastro e o fator antigo
                                     // se cancelam em parte, não dá pra mexer num sem mexer no outro.
                                     // 0.16.0 = regra nova C1_PLACA (automática): troca de placa é
                                     // reserva SEMPRE — moto sem placa não circula, é lei e não tempo
                                     // de bancada (envolve Detran, não resolve no dia). Pedido da
                                     // operação. Mooca 60d/piso: 15 casos (1 a cada 4 dias), 67%
                                     // passam de 3h, mediana de 12 HORAS, e o serviço é registrado
                                     // 26min depois de abrir a OS. n pequeno demais pra estatística
                                     // decidir — e não precisa: a régua aqui é legal, não temporal. // 0.15.0 = regra de estoque DESLIGADA no piloto: 0 acerto em 7
                                     // disparos de piso (10d) e 0 em 9 (semana anterior) — a peça existe
                                     // sob grupo irmão ou sem registro. Religa com RIVERS_REGRA_ESTOQUE=on
                                     // quando a investigação fechar. O caso real de moto parada por peça
                                     // segue coberto pelo C2_TRAVADA_SEM_PECA (93,7%).
                                     // 0.14.0 = auditoria pré-go-live: (a) o motor era CEGO pra oferta
                                     // já feita pela oficina — o check-in segue aberto ~4h depois da
                                     // oferta, então o bot pedia reserva pra quem já tinha sido atendido;
                                     // agora lê checkin_event (oferta_ativa, com recusa reabrindo o caso)
                                     // e não notifica esses; (b) regra nova C2_PARADA_TERCEIRO —
                                     // AWAITING_SERVICE/AWAITING_VMGMT parados 30min+ não tinham NENHUMA
                                     // regra (94,7% de estouro, 0,3-0,9/dia); (c) dedup de notificação
                                     // deixa de ser por versão do algoritmo (cada deploy re-notificava
                                     // o backlog inteiro no Slack).
                                     // 0.13.0 = dois achados da investigação do Guida: (a) o payload da
                                     // triagem mudou (checklist_tags → triage.incidents) e as flags de
                                     // imobilizada/acidente/guincho vinham SEMPRE 0 — corrigido o caminho,
                                     // mas medida a precisão real (17,9% / 31,8% / 53,8% no piso) elas
                                     // saem da DECISÃO e viram contexto: descrevem o incidente, não a
                                     // duração do reparo; (b) regra nova C1_RETORNO — inspeção de retorno
                                     // com cliente em piso: 3/dia, 82,7% estouram, mediana de 20h, e é
                                     // conhecido na abertura da OS (cobre a janela pré-diagnóstico).
                                     // 0.12.0 = piso = atendimento AINDA ABERTO. O Maestro fecha o
                                     // atendimento quando o cliente resolve (moto devolvida, reserva
                                     // entregue ou moto TROCADA) — fechado = ele foi embora. Sem isso
                                     // o RIVERS sugeria reserva pra quem já tinha saído com outra moto
                                     // (SUC2B36 e SUI2F42 em 30/07, ambos BIKE_REPLACED) e a tela do CX
                                     // divergia do Maestro. Alinha a definição de "aguardando" das duas.
                                     // 0.11.0 = regra nova C1_FILA_DIAG_LONGA (pedido da operação):
                                     // cliente em piso há +1h30 e a moto nem entrou em diagnóstico
                                     // (segue em OPEN) → recomendação. Medido em 45d: 5,4/dia, 79%
                                     // estouram; fica fora do automático (piso de 90%) e o mesmo
                                     // cliente escala pra automática às 2h30 pelo C1_ESPERA_SEM_DIAG.
                                     // 0.10.0 = moto em QA entra no radar (AWAITING_QA/IN_QA/
                                     // QA_REJECTED): antes saía sem decisão e desaparecia das telas
                                     // justo na hora do estouro. Medido em 21d: 199 clientes de piso
                                     // (9,5/dia) cruzaram as 3h em QA e 92% estouraram. Em QA o
                                     // restante do serviço é 0 (a rampa acabou) e o C3_TEMPO_ALTO não
                                     // dispara — quem decide é o relógio + os 8min de QA.
                                     // 0.9.1 = escopo do piloto: autonomia (⚡) e notificações só nas
                                     // bases do teste (RIVERS_BASES_TESTE, default Mooca=1); demais
                                     // bases seguem avaliadas/logadas normalmente (tela/API/log).
                                     // 0.9.0 = piso completo + termômetro: (a) is_piso = união do
                                     // "chamado no balcão" com client_present da fonte (o chamado
                                     // perdia 29% dos presentes; o client_present vira NÃO quando o
                                     // cliente sai com reserva — juntos cobrem o piso real);
                                     // (b) pressao_piso por base exposta na API/log — insumo de
                                     // POLÍTICA de piso cheio (validado: lotação não prevê estouro,
                                     // 19,3%×19,4% — régua de agir é da operação).
                                     // 0.8.0 = peça segurando a moto: (a) AWAITING_PARTS/AWAITING_SERVICE
                                     // entram no radar (OSs travadas sumiam — furos 42908/43397/44130);
                                     // (b) regra nova C2_TRAVADA_SEM_PECA (93,7% no histórico 45d:
                                     // parada 30min+ & relógio 90-480min), pega até OS sem item
                                     // registrado; (c) C2_SEM_ESTOQUE só dispara com a moto parada
                                     // 30min+ fora de execução (leitura sozinha errou 9/9 na semana:
                                     // estoque vive sob grupo irmão ou fora do registro).
                                     // 0.7.0 = confiança na sugestão: projeção a <30min da linha das
                                     // 3h sai marcada "fronteira" (zona cara-ou-coroa — o encarregado
                                     // decide sabendo que é foto de chegada); demais saem "alta".
                                     // Exposta na API/Slack/log. Não muda O QUE dispara, muda como
                                     // a incerteza é comunicada.
                                     // 0.6.0 = ataque ao excesso das regras de tempo (semana 20-26:
                                     // 39 sugestões de piso ficaram prontas <3h): (a) C3_TEMPO_ALTO
                                     // sobe 120→140 (faixa 121-140 acertou 36%; 141+ acertou 100%);
                                     // (b) restante = estimativa − execução ACUMULADA (episódios
                                     // IN_PROGRESS somados; antes só o episódio atual descontava e
                                     // pause/retoma re-somava trabalho feito). Simulado na semana:
                                     // excesso C3 39→~6/sem, capturas 39/39 mantidas (5 ~15-50min
                                     // mais tarde via C3.5/C4 conforme o relógio acumula).
                                     // 0.5.1 = C1_ANOMALIA enxerga moto presa em OPEN que nunca
                                     // entrou na oficina (maxIf sem match virava epoch 1970 →
                                     // dateDiff negativo → regra cega; furo de dom 26/07, OS 44862).
                                     // 0.5.0 = fila do C4 conta só o trabalho de PISO à frente
                                     // (decomposição 20/07: piso fura a fila — espera real 4-5min;
                                     // a fila cheia superestimava e era a maior fonte de excesso).
                                     // 0.4.1 = fator por nº de peças na estimativa (recalibração
                                     // 20/07: aditivo superestimava OS de 1-3 peças; validado OOS)
                                     // + deleted_at filtrado nas peças do diagnóstico.
                                     // 0.4.0 = C2 só dispara p/ peça BLOQUEANTE + estoque conta
                                     // todos os depósitos da base (antes: cosmético disparava e
                                     // peça na bancada/recebimento contava como "sem estoque");
                                     // janela de OS avaliadas: 1 → 7 dias (causa dos furos).
                                     // 0.3.0 = estimativa de tempo calibrada (tempo-pecas.ts)

const THRESHOLDS = {
  relogio_reserva_min: 160,  // C3_RELOGIO: piso + 160min de relógio DO CLIENTE + FORA de QA.
                             // Era 150 na régua da OS; virou 160 em 06/08 junto com a troca
                             // pra régua do check-in (gap mediano de 15min entre chegada e
                             // abertura da OS — 160 desde a chegada ≈ 145 desde a OS, ou seja,
                             // dispara um pouco MAIS cedo do que antes na prática).
                             // Backtest 92d (config cli160): a regra vai a 97,6% e o conjunto
                             // a 95,5% de precisão. Em QA no mesmo minuto só 22,6% estouram →
                             // o split de QA vale 65pp e continua valendo.
  qa_rejeicao_tarde_min: 165,// C1_QA_TARDIA: rejeição de QA com 165min+ de relógio = 98,9%
                             // de estouro (n=91). Retrabalho não cabe no prazo.
  qa_retrabalho_min: 45,     // retrabalho pós-rejeição: mediana medida 45min (p75 86) —
                             // substitui o 0 que o motor assumia em QA_REJECTED desde v0.10.
  est_firme_min: 180,        // C3.5: projeção cedo só vira RESERVA com estimativa >=180
                             // (80,8% n=120); a faixa 150-180 mede 63,8% (n=141) e fica
                             // por conta do relógio/aviso. Backtest 92d: scripts/backtest-v23.mjs.
  relogio_gate_min: 60,      // C3_RELOGIO: "quase pronta" pro relógio-150 = restante+QA < 60.
                             // Era 30 até 05/08: investigado o dia 1 (4 erros, 50% de precisão
                             // vs 86,6% no backtest) — em TODOS, a estimativa achava 40-71min
                             // restantes e o real era 9-24. O limiar de 30 não pegava porque
                             // mede a MESMA estimativa que infla. Testado no backtest de 92d:
                             // 30→60 leva a regra de 86,6%→90,9% (n=317); acima de 60 o ganho
                             // marginal cai rápido e o custo de recall não (penhasco, não
                             // rampa) — 60 é o ponto de equilíbrio, não o ótimo de precisão pura.
  restante_min_reserva: 30,  // C3.5/C4: só sugere RESERVA se o que falta (restante + QA) for
                             // maior que o tempo de ENTREGAR uma reserva (handover medido ~30min).
                             // Moto quase pronta que cruza a linha de raspão ganha AVISO pelo
                             // relógio na tela (>=3h, sempre), não reserva — a reserva não chega
                             // antes de a moto ficar pronta. Motivado no dia 03/08: 3 dos 10 erros
                             // do dia 31 foram disparos com restante de 8-20min (UEA5B42 projetou
                             // 181 e aprontou em 177). Meta do Alvaro: 80%+ de acerto/dia.
  fila_piso_max_min: 15,     // C4: teto da espera de fila cobrada de cliente de PISO — o piso fura
                             // a fila (espera real mediana 4-5min, medida 20/07; p90 ~15). Sem o
                             // teto, o fim de tarde (escala caindo, fila de papel acumulando)
                             // cobrava 30-34min fictícios e gerou os 2 piores erros do dia 31
                             // (SUO6I07 pronta em 67min com sugestão de reserva).
  anomalia_min: 240,         // C1: OS aberta há mais de 4h antes do diag fechar
  diversas_avarias: 9,       // C3: 9+ tipos de peça diferentes no diag
  tempo_estimado_max: 240,   // C3: trabalho estimado > 240 min. RECALIBRADO em 31/07 junto com
                             // o mapa de tempos (agora mediana REAL de bancada) e o fator novo:
                             // na escala honesta, 240 estimados = serviço que não cabe em 3h.
                             // Teste (60d piso Mooca, fora do treino): >240 = 87,5% (n=72).
                             // (Na escala antiga o gatilho foi 140→180 mais cedo em 31/07,
                             // quando medimos que a faixa 141-180 acertava 36-57%.)
  tempo_total_max: 180,      // a LINHA das 3h (SLA) — usada pra exibição e pro relógio
  projecao_reserva_min: 180, // C3.5 / C4: projeção (espera + restante + QA) que dispara reserva.
                             // DECISÃO DO ALVARO no dia 1 (31/07, caso TMB8G64 a 12min da linha
                             // sem nenhum aviso): "se der estimado mais de 3h, tem que disparar" —
                             // a régua da sugestão É a linha das 3h, não a de convicção. Trade-off
                             // medido e aceito: projeção >180 = 71% de acerto (n=407, ~6,8/dia)
                             // contra 90,2% em >240 (n=194, 3,2/dia) — ou seja, ~3 em 10 sugestões
                             // da faixa 180-240 são de moto que se salva; elas saem marcadas
                             // FRONTEIRA (até gatilho+30) pro CX confirmar no piso antes de
                             // prometer. Estourar de fato continua coberto pela fila de aviso da
                             // tela (relógio >= 3h entra sem depender de regra).
  qa_min: 8,                 // C3.5 / C4: tempo médio de QA somado ao total (pedido da operação)
  espera_sem_diag_min: 150,  // C1: piso aberto há +2h30 sem diagnóstico → esperando demais
  fila_diag_min: 90,         // C1: piso há +1h30 e a moto NEM entrou em diagnóstico (status OPEN).
                             // Medido em 45d: 5,4 casos/dia, 79% estouram — bom pra avisar cedo,
                             // não pra entregar sozinho (por isso fica como recomendação; aos
                             // 2h30 o mesmo cliente escala pra automática pela regra acima).
  fronteira_margem_min: 30,  // projeção a menos de 30min da linha das 3h = "fronteira"
                             // (zona cara-ou-coroa: variação natural do serviço decide o lado)
};

// Moto em conferência final: o trabalho de rampa já acabou.
const QA_STATUSES = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);

// Peças que sozinhas justificam reserva imediata
const PECAS_CRITICAS = new Set([
  257, 258, 259, 260,  // Motor
  184, 357,            // Balança
  250, 308, 340, 359,  // Caixa direção
  296,                 // Chassi
  240,                 // Garfo
]);

export interface AlgoritmoInput {
  os_id: number;
  so_type: string;
  location_id: number;
  asset_model: string;
  placa: string;
  descricao_cx: string;
  status_atual: string;
  imobilizada: number;
  acidente: number;
  guincho: number;
  min_open_to_awaiting: number;
  n_pecas: number;
  tempo_estimado_min: number;
  complexidade_max: number;
  n_pecas_criticas: number;
  n_sem_estoque: number;
  pecas_sem_estoque: string;
  n_sem_estoque_bloq: number;      // só peças BLOQUEANTES (tração/freio/rodante) em falta
  pecas_sem_estoque_bloq: string;  // nomes das bloqueantes em falta
  pecas_criticas: string;
  is_piso: number;
  troca_placa?: number;          // 1 = OS tem serviço de troca de placa (Detran, não bancada)
  min_ate_rejeicao?: number;     // minutos do relógio na 1ª rejeição de QA (-1 = nunca)
  tem_direcao?: number;          // 1 = diagnóstico tem peça do cluster direção/rodante/discos
  min_no_status: number;
  min_desde_open: number;
  min_desde_chegada?: number;    // relógio do CLIENTE (desde o check-in). Fallback: min_desde_open
  exec_acum_min?: number;        // execução acumulada (todos os episódios IN_PROGRESS), em min
  oferta_ativa?: number;         // 1 = a oficina já ofereceu reserva (e o cliente não recusou)
  capacidade_esperada?: number;  // nº esperado de mecânicos na base/hora atual (curva do histórico)
  fila_min?: number;             // soma do tempo estimado das OS esperando mecânico na base
}

export function avaliarOS(input: AlgoritmoInput): Recomendacao {
  // RELÓGIO DO CLIENTE (06/08): todas as regras de tempo contam desde o CHECK-IN, não
  // desde a abertura da OS. O Maestro conta assim e o cliente sente assim — ele espera
  // desde que pisou na base. Gap mediano de 15min (p90 42) entre chegada e abertura;
  // medido em 90d/Mooca, 168 clientes (~2/dia) estouraram as 3h REAIS sendo invisíveis
  // pro RIVERS. Backtest com a régua nova (config cli160): precisão 89,6%→95,5%,
  // +57 clientes pegos a tempo, e TODOS os dias da amostra >=80%.
  // Fallback pro relógio da OS quando não há check-in confiável (OS sem cliente em piso).
  const relogio = input.min_desde_chegada ?? input.min_desde_open;
  const base = {
    os_id: input.os_id,
    tempo_previsto_min: input.tempo_estimado_min,
    mecanico_sugerido: null as string | null,
    tempo_para_inicio_min: null as number | null,
    metadata: {
      n_pecas_diag: input.n_pecas,
      complexidade_max: input.complexidade_max,
      tem_peca_critica: input.n_pecas_criticas > 0,
      estoque_ok: input.n_sem_estoque === 0,
    },
  };

  // ── CAMADA 1: Regras duras ─────────────────────────────────────────────

  if (input.so_type === "INSURANCE_QUOTE") {
    // Gate (05/08, backtest): vistoria com diagnóstico pequeno JÁ FEITO sai rápido
    // (61-117min nos casos recentes) — só mantém a reserva-por-política enquanto não
    // há diagnóstico ou quando a projeção não cabe nas 3h. 66,7%→80% no backtest.
    const execHard = input.exec_acum_min ?? 0;
    const restHard = QA_STATUSES.has(input.status_atual) ? 0 : Math.max(0, input.tempo_estimado_min - execHard);
    if (input.tempo_estimado_min === 0 || relogio + restHard + 8 > 180) {
      return reserva("C1_HARD", "vistoria de seguro", base, "alta");
    }
  }

  // TROCA DE PLACA: moto sem placa válida não circula — é lei, não é tempo de bancada.
  // A troca envolve Detran e não se resolve no dia. Regra de OPERAÇÃO (pedida pelo Alvaro
  // em 31/07): placa quebrada é reserva SEMPRE, independente da estimativa. Medido na
  // Mooca (60d, piso): 15 casos (1 a cada 4 dias), 67% passam de 3h, mediana de 12 HORAS,
  // e o serviço aparece 26min depois de abrir a OS. O n é pequeno demais pra estatística
  // decidir — e não precisa decidir: a régua aqui é legal.
  if (input.troca_placa === 1) {
    return reserva("C1_PLACA", "troca de placa — a moto não pode circular", base, "alta");
  }

  // Incidente (imobilizada / acidente / guincho) NÃO decide sozinho: as flags descrevem
  // o que aconteceu com a moto, não quanto tempo o reparo leva. Medido em 45d (clientes
  // de piso): imobilizada 17,9% · acidente 31,8% · guincho 53,8% de estouro, contra 10,7%
  // da linha de base — sinal fraco. Elas seguem no payload e aparecem como CONTEXTO nas
  // telas; "cliente chegou sem moto rodando" é decisão de política da operação, como a
  // de oficina cheia. (Até 30/07 a regra lia um caminho de JSON inexistente e nunca
  // disparava — o efeito prático é o mesmo, agora com o motivo medido.)

  // C1_RETORNO removida em 0.19.0 (decisão do Alvaro, dia do go-live). Disparava por
  // TIPO de OS (inspeção de retorno + piso, 84,4% Mooca/60d) sem medir a moto; a
  // mediana de 13h aponta priorização da oficina, não duração de reparo — e reserva
  // automática nesse caso pode se auto-alimentar. so_type segue como contexto na UI.
  if (input.min_open_to_awaiting > THRESHOLDS.anomalia_min) {
    return reserva("C1_ANOMALIA", `moto não entrou na oficina há ${input.min_open_to_awaiting}min`, base, "alta");
  }

  // Piso esperando demais SEM diagnóstico: moto em piso, aberta há muito tempo, e o
  // diagnóstico nem começou (sem estimativa de tempo). Não vai ficar pronta no prazo
  // → reserva. (Sem essa regra, OS sem diagnóstico escapavam, pois não há tempo p/ estimar.)
  if (
    input.is_piso === 1 &&
    input.tempo_estimado_min === 0 &&
    relogio > THRESHOLDS.espera_sem_diag_min
  ) {
    return reserva(
      "C1_ESPERA_SEM_DIAG",
      `em piso há ${relogio}min e ainda sem diagnóstico — esperando demais`,
      base,
      "alta"
    );
  }

  // Cliente em piso e a moto ainda NÃO ENTROU em diagnóstico (segue em OPEN, ou
  // seja, parada na fila de diagnóstico). Aviso adiantado: dispara 1h antes da regra
  // acima, com 79% de acerto no histórico — logo, recomendação e não entrega direta.
  if (
    input.is_piso === 1 &&
    input.status_atual === "OPEN" &&
    relogio > THRESHOLDS.fila_diag_min
  ) {
    return reserva(
      "C1_FILA_DIAG_LONGA",
      `cliente em piso há ${relogio}min e a moto ainda não entrou em diagnóstico`,
      base
    );
  }

  // ── CAMADA 2: Peça segurando a moto ────────────────────────────────────

  // Moto TRAVADA aguardando peça (status AWAITING_PARTS) no fluxo do dia: validado no
  // histórico de 45d — parada 30min+ com relógio total 90min+ = 93,7% de estouro.
  // Cobre inclusive OS sem nenhum item registrado (o mecânico sabe da falta, o sistema não).
  if (
    input.status_atual === "AWAITING_PARTS" &&
    input.min_no_status >= 30 &&
    relogio >= 90 &&
    relogio <= 480
  ) {
    return reserva(
      "C2_TRAVADA_SEM_PECA",
      `parada aguardando peça há ${input.min_no_status}min (cliente na base há ${relogio}min)`,
      base,
      "alta"
    );
  }

  // Moto parada em serviço externo ou aguardando gestão de frota: nenhuma regra
  // cobria esses dois statuses (AWAITING_VMGMT não aparecia em condição nenhuma).
  // Medido em 45d no piso: parada 30min+ = 94,7% de estouro, 0,3-0,9/dia. Espelha
  // o gatilho da regra de peça acima, que já está validada.
  if (
    (input.status_atual === "AWAITING_SERVICE" || input.status_atual === "AWAITING_VMGMT") &&
    input.min_no_status >= 30 &&
    relogio >= 90 &&
    relogio <= 480
  ) {
    return reserva(
      "C2_PARADA_TERCEIRO",
      `parada em ${input.status_atual === "AWAITING_SERVICE" ? "serviço externo" : "gestão de frota"} há ${input.min_no_status}min (cliente na base há ${relogio}min)`,
      base
    );
  }

  // Leitura de estoque: DESLIGADA no piloto (30/07). Medida duas vezes em clientes de
  // piso, deu 0 acerto em 7 disparos (10 dias) e 0 em 9 (semana anterior) — a oficina
  // resolve mesmo com a leitura dizendo zero, porque a peça está cadastrada em grupo
  // irmão (ex.: "Roda traseira Dual suspension" com estoque zero vs "_v1/_v2" com 298
  // unidades) ou fisicamente na base sem registro. Enquanto a investigação não fecha, a
  // regra só liga com RIVERS_REGRA_ESTOQUE=on (sem deploy). O caso REAL de moto parada
  // por peça continua coberto pelo C2_TRAVADA_SEM_PECA, que mediu 93,7%.
  if (
    process.env.RIVERS_REGRA_ESTOQUE === "on" &&
    input.n_sem_estoque_bloq > 0 &&
    ["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "PAUSED", "AWAITING_SERVICE"].includes(input.status_atual) &&
    input.min_no_status >= 30
  ) {
    return reserva(
      "C2_SEM_ESTOQUE",
      `peça bloqueante sem estoque na base (${input.pecas_sem_estoque_bloq}) e moto parada há ${input.min_no_status}min`,
      base
    );
  }

  // ── CAMADA 3: Complexidade ─────────────────────────────────────────────

  // Restante desconta a execução ACUMULADA (todos os episódios IN_PROGRESS): o
  // desconto antigo via min_no_status zerava a cada pausa/retomada e re-somava
  // trabalho já feito. Fallback pro comportamento antigo se o campo não vier.
  const execFeita = input.exec_acum_min ??
    (input.status_atual === "IN_PROGRESS" ? input.min_no_status : 0);
  // Em QA o serviço já acabou: o que falta é a conferência (qa_min) — EXCETO se foi
  // REPROVADA: aí tem retrabalho, mediana medida de 45min (o 0 antigo fazia o motor
  // tratar moto reprovada como pronta; buraco apontado pelo Alvaro em 30/07).
  const emQa = QA_STATUSES.has(input.status_atual);
  const tempoRestanteC3 = emQa
    ? (input.status_atual === "QA_REJECTED" ? THRESHOLDS.qa_retrabalho_min : 0)
    : Math.max(0, input.tempo_estimado_min - execFeita);

  // ── AS DUAS REGRAS DO RELÓGIO (diagnóstico de 05/08 — hazard lognormal) ──
  // Reparo tem cauda lognormal: quem já demorou vai demorar mais — EXCETO em QA,
  // que é sinal de conserto no fim. Números do hazard (90d, piso Mooca):
  // 150min fora de QA = 87,3% de estouro (n=887, 95% de recall); em QA = 22,6%.
  if (
    input.is_piso === 1 &&
    !emQa &&
    relogio >= THRESHOLDS.relogio_reserva_min &&
    // moto em execução com restante curto está TERMINANDO — reserva não chega antes.
    // Limiar próprio (relogio_gate_min), não o restante_min_reserva do COMB/C4: aqui a
    // pergunta é "a estimativa restante já é pequena o bastante pra suspeitar que está
    // quase pronta", e a estimativa infla — por isso o limiar é mais alto que o handover.
    // BUG achado em 06/08 (caso 50408): tempoRestanteC3 vem CLAMPADO em 0 (Math.max) —
    // quando a execução já passa da estimativa (moto rodou 159min, estimativa dizia 71),
    // o gate lê restante=0 como "quase pronta" quando é o CONTRÁRIO: a estimativa já
    // provou estar errada, a moto está descontrolada. Esse caso ficou 176min em silêncio
    // até entrar em QA e sair do radar de vez — nem apareceu como erro, só desapareceu.
    // Fix: usa o valor SEM CLAMP pro gate — só é "quase pronta" se ainda sobra estimativa
    // POSITIVA e pequena; execução que já passou da estimativa nunca conta como pronta.
    // Backtest 92d: recall geral 71,9%→82,5% (+160 disparos capturados), precisão da
    // regra 91,0%→88,7% — queda pequena por ganho grande, e o "custo" aparente em alguns
    // dias é escape que antes era invisível (nem contava como erro) virando tentativa.
    !(input.status_atual === "IN_PROGRESS" && input.tempo_estimado_min > 0 &&
      (input.tempo_estimado_min - execFeita) >= 0 &&
      (input.tempo_estimado_min - execFeita) + THRESHOLDS.qa_min < THRESHOLDS.relogio_gate_min)
  ) {
    return reserva(
      "C3_RELOGIO_150",
      `cliente em piso há ${relogio}min e o conserto segue em andamento — 87% dos casos assim passam das 3h`,
      base,
      "alta"
    );
  }
  // Rejeição de QA tarde = retrabalho que não cabe no prazo: 98,9% (n=91).
  if ((input.min_ate_rejeicao ?? -1) >= THRESHOLDS.qa_rejeicao_tarde_min) {
    return reserva(
      "C1_QA_TARDIA",
      `reprovada na qualidade aos ${input.min_ate_rejeicao}min — o retrabalho (mediana 45min) não cabe nas 3h`,
      base,
      "alta"
    );
  }
  const totalSemMec = relogio + tempoRestanteC3 + THRESHOLDS.qa_min;
  // Projeção a menos de 30min da linha = fronteira: a sugestão sai marcada pro
  // encarregado saber que é decisão de foto de chegada, não de convicção.
  const confiancaTempo = (proj: number): "alta" | "fronteira" =>
    proj >= THRESHOLDS.projecao_reserva_min + THRESHOLDS.fronteira_margem_min ? "alta" : "fronteira";

  // Peça crítica e nº de peças foram REMOVIDOS como critério (decisão da operação):
  // ter um Motor ou muitas peças não significa, por si só, passar de 3h — quem decide
  // é o tempo. Quando a estimativa de tempo for recalibrada, ela já captura essas peças.
  // Serviço grande só importa se ainda há serviço pra fazer: em QA a rampa já
  // terminou, então o que decide é o relógio (C3.5 abaixo), não o tamanho do serviço.
  if (!emQa && input.tempo_estimado_min > THRESHOLDS.tempo_estimado_max) {
    // acima de 180 mediu 79,5% na Mooca (60d) — e 220+ mediu 85,2%
    return reserva("C3_TEMPO_ALTO", `trabalho estimado em ${input.tempo_estimado_min}min`, base, "alta");
  }

  // ── CAMADA 3.5: Tempo total combinado (sem capacidade) ─────────────────
  // Se a soma do tempo já esperado + restante já passa de 3h, não adianta.
  if (
    input.tempo_estimado_min >= THRESHOLDS.est_firme_min &&
    relogio < 480 &&
    totalSemMec > THRESHOLDS.projecao_reserva_min &&
    tempoRestanteC3 + THRESHOLDS.qa_min >= THRESHOLDS.restante_min_reserva
  ) {
    return reserva(
      "C3_TEMPO_COMBINADO",
      `já esperou ${relogio}min + restante ~${tempoRestanteC3}min + ${THRESHOLDS.qa_min}min QA = ${totalSemMec}min total`,
      base,
      confiancaTempo(totalSemMec)
    );
  }

  // ── CAMADA 4: Capacidade da oficina (modelo de presença) ───────────────
  // Usa a CAPACIDADE ESPERADA de mecânicos na base/hora (curva do histórico,
  // injetada em route.ts) + a fila de trabalho esperando mecânico, pra estimar
  // quanto tempo até esta OS ser atendida. Substitui o antigo proxy de "quem
  // está mexendo numa moto agora" (que despencava no almoço e na troca de turno).
  const cap = input.capacidade_esperada ?? 0;
  if (cap > 0 && input.tempo_estimado_min > 0) {
    const filaMin = input.fila_min ?? 0;
    // Cliente de PISO fura a fila: espera real mediana 4-5min (medida 20/07). O teto de
    // 15min evita a fila "de papel" do fim de tarde cobrar espera que o piso não paga.
    const esperaBruta = Math.round(filaMin / cap);   // fila de serviço ÷ mecânicos em paralelo
    const tempoEspera = input.is_piso === 1 ? Math.min(esperaBruta, THRESHOLDS.fila_piso_max_min) : esperaBruta;
    base.tempo_para_inicio_min = tempoEspera;
    const tempoTotal = relogio + tempoEspera + tempoRestanteC3 + THRESHOLDS.qa_min;
    base.tempo_previsto_min = tempoTotal;

    // C4 DESLIGADO como gatilho de reserva (03/08 23h, meta 80%/dia do Alvaro).
    // Ficha corrida: em julho medimos que lotação NÃO prevê estouro (19,3%×19,4%);
    // no dia 1 deu os 2 piores erros (fila fictícia de 30-34min que o piso não paga);
    // com o teto de 15min perdeu a resolução (5 disparos projetando 181/181/181/182/181
    // — virou C3 com viés de +15). No dia 03/08: 1 acerto em 5. Pós-v0.21, TODOS os
    // erros do dia foram C4 — sem ele a noite fechava 3/3. Ele segue como MEDIDOR
    // (tempo_previsto/fila na tela). Religa com RIVERS_REGRA_C4=on, sem deploy.
    if (
      process.env.RIVERS_REGRA_C4 === "on" &&
      input.tempo_estimado_min > 0 &&
      tempoTotal > THRESHOLDS.projecao_reserva_min &&
      tempoRestanteC3 + THRESHOLDS.qa_min >= THRESHOLDS.restante_min_reserva
    ) {
      return reserva(
        "C4_CAPACIDADE",
        `oficina saturada: fila ~${tempoEspera}min (${filaMin}min de serviço ÷ ${cap} mec esperados) + ${tempoRestanteC3}min serviço + ${THRESHOLDS.qa_min}min QA, já esperou ${relogio}min → ${tempoTotal}min`,
        base,
        confiancaTempo(tempoTotal)
      );
    }

    return {
      ...base,
      decision: "SEM_RESERVA" as ReservaDecision,
      rule_triggered: "C4_OK",
      motivo: `dentro do prazo: ~${tempoTotal}min (fila ~${tempoEspera}min com ${cap} mec esperados + ${tempoRestanteC3}min serviço + ${THRESHOLDS.qa_min}min QA)`,
    };
  }

  // ── Sem capacidade (curva indisponível) → decisão determinística ───────
  const semDiag = input.tempo_estimado_min === 0;
  return {
    ...base,
    decision: "SEM_RESERVA" as ReservaDecision,
    rule_triggered: semDiag ? "C5_AGUARDA_DIAG" : "C5_DENTRO_PRAZO",
    motivo: semDiag
      ? `aguardando diagnóstico (na base há ${relogio}min, sem estimativa de tempo ainda)`
      : `dentro do prazo: na base há ${relogio}min, estimado ${input.tempo_estimado_min}min`,
  };
}

function reserva(
  rule: string,
  motivo: string,
  base: Omit<Recomendacao, "decision" | "rule_triggered" | "motivo">,
  confianca?: "alta" | "fronteira"
): Recomendacao {
  return {
    ...base,
    decision: "RESERVA",
    rule_triggered: rule,
    motivo,
    confianca,
  };
}

export { THRESHOLDS, PECAS_CRITICAS };

# -*- coding: utf-8 -*-
"""v2 do "motivo da recusa fica visível" (08/09), depois da revisão adversarial barrar a v1.

A v1 virava card no formato do CardAcao. Dois bloqueios, os dois medidos:
 1) VOLUME NA TV. Pico real de 13 recusas num dia (02/09) e 5 dias com 9+ nas últimas 3 semanas.
    Card sem motivo tem ~200px (os 7 botões têm rótulo de até 59 caracteres e quebram em 3 linhas),
    então 13 recusas = ~2.800px contra ~930px úteis na TV. "Cliente já avisado" e "no prazo" saíam
    da tela. Trocaria "ninguém vê a recusa" por "ninguém vê o resto".
 2) COR. O filete âmbar de 6px é o token do relógio do SLA (ZONAS.atencao) e o rodapé da própria
    página promete "âmbar na última hora". Card âmbar embaixo da fila de ação lê como cliente
    apertado, quando é justamente quem saiu da fila por decisão de 20/08. Sinal invertido.

v2: mantém a POSIÇÃO (colado na fila de ação, que é o pedido) e devolve o FORMATO de painel de
lista, que é a gramática que a página já usa em "Cliente já avisado". O painel virou <details>
fechado por padrão: na TV custa uma faixa de ~56px com o contador, e no computador do CX um clique
abre e fica aberto (<details> não-controlado guarda o estado entre os refreshes de 45 s, porque o
elemento não desmonta). Zero cor de zona, e o campo de nome sai da TV para dentro do aberto.

A lógica de salvar continua intacta (revisão de 04/09).
"""
import io, os, shutil, sys
sys.stdout.reconfigure(encoding="utf-8")
P = r"C:\Users\Usuário\Desktop\vammo-reserva\src\app\cx\page.tsx"
BAK = r"C:\Users\USURIO~2\AppData\Local\Temp\claude\C--Users-Usu-rio-Desktop-call-processor\6432861b-3b76-4cf3-a79b-585a04f2f052\scratchpad\page.tsx.bak"

shutil.copyfile(BAK, P)      # desfaz a v1 inteira antes de começar
s = io.open(P, encoding="utf-8").read()
print("restaurado do .bak")

def sub(velho, novo, nome):
    global s
    assert s.count(velho) == 1, (nome, "ancora nao unica:", s.count(velho))
    s = s.replace(velho, novo, 1)
    print("  ok", nome)

# ── 1) painel vira <details>, com a faixa sempre visível no <summary> ──
sub(
    '''      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
          Recusou a reserva hoje: por quê?
        </h2>
        {semMotivo > 0 ? (
          <Selo tom="alerta">{semMotivo} sem motivo</Selo>
        ) : (
          <Selo tom="auto">todas com motivo</Selo>
        )}
        <input''',
    '''      <details className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {/* faixa sempre visível: na TV é isso que importa (o contador). O clique acontece no
            computador do CX; <details> não-controlado guarda o aberto entre os refreshes. */}
        <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-5 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
            Recusou a reserva hoje: por quê?
          </h2>
          <span className="text-sm text-slate-500">
            {lista.length} {lista.length === 1 ? "recusa" : "recusas"} hoje
          </span>
          {/* cor de zona é só do relógio do SLA: pendência aqui é slate, nunca vermelho nem âmbar */}
          {semMotivo > 0 ? (
            <Selo tom="ok">{semMotivo} sem motivo</Selo>
          ) : (
            <Selo tom="auto">todas com motivo</Selo>
          )}
        </summary>
      <div className="border-t border-slate-100 px-5 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input''',
    "painel vira details + faixa",
)

# ── 2) a lista aninhada perde o fundo branco e o raio grande ──
sub(
    '''      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {lista.map((r) => {''',
    '''      <div className="overflow-hidden rounded-xl border border-slate-200">
        {lista.map((r) => {''',
    "lista aninhada",
)

# ── 3) fecha o details antes da nota de pé ──
sub(
    '''      <p className="mt-2 text-xs text-slate-400">
        Um clique por recusa.''',
    '''      </div>
      </details>
      <p className="mt-2 text-xs text-slate-400">
        Um clique por recusa.''',
    "fecha o details",
)

# ── 4) sai do fim da página ──
sub(
    '''        <RecusasHoje lista={dados?.recusas_hoje ?? []} />

        <p className="mt-10 text-xs leading-relaxed text-slate-400">''',
    '''        <p className="mt-10 text-xs leading-relaxed text-slate-400">''',
    "remove do fim",
)

# ── 5) entra logo depois da fila de ação ──
sub(
    '''              {precisaAvisar.map((c) => (
                <CardAcao key={c.os_id} c={c} />
              ))}
            </div>
          )}
        </section>
''',
    '''              {precisaAvisar.map((c) => (
                <CardAcao key={c.os_id} c={c} />
              ))}
            </div>
          )}
        </section>

        {/* 08/09: a recusa saiu do fim da página e passou a ficar colada na fila de ação,
            porque lá embaixo ninguém via. Fechada por padrão pra não empurrar as outras
            seções fora da TV nos dias de pico (13 recusas em 02/09). */}
        <RecusasHoje lista={dados?.recusas_hoje ?? []} />
''',
    "entra depois da fila",
)

# ── 6) comentário de cabeçalho do componente ──
sub(
    '''// Maestro não pergunta na hora de cancelar. Esta seção lista as recusas de HOJE e
// pede um clique no motivo (lista fechada em src/lib/recusa.ts). Uma linha por OS;
// "trocar" sobrescreve. É a única parte clicável da tela: pensada pro computador do
// CX. Na TV ela também aparece (mesma página, sem gate) — o selo "N sem motivo" é o
// que importa lá; os botões só fazem efeito em quem tem mouse.''',
    '''// Maestro não pergunta na hora de cancelar. Esta seção lista as recusas de HOJE e
// pede um clique no motivo (lista fechada em src/lib/recusa.ts). Uma linha por OS;
// "trocar" sobrescreve. É a única parte clicável da tela: pensada pro computador do
// CX. Na TV ela também aparece (mesma página, sem gate) — o selo "N sem motivo" é o
// que importa lá; os botões só fazem efeito em quem tem mouse.
// 08/09: saiu do fim da página e passou a ficar logo depois da fila de ação (pedido do
// Alvaro: no fim ninguém via). Virou <details> fechado por padrão porque em dia de pico
// são 13 recusas, e aberto isso tira as outras seções da TV. Nada de cor de zona aqui:
// âmbar e vermelho são do relógio do SLA e a legenda do rodapé promete isso ao CX.''',
    "comentário do componente",
)

# ── 7) marca o selo morto dentro do CardAcao (a lista filtra !c.recusada) ──
sub(
    '''            {c.recusada && <Selo tom="alerta">cliente recusou</Selo>}''',
    '''            {/* morto hoje: `clientes` filtra !c.recusada (regra de 20/08). Só volta a
                renderizar se esse filtro cair. */}
            {c.recusada && <Selo tom="alerta">cliente recusou</Selo>}''',
    "selo morto documentado",
)

io.open(P, "w", encoding="utf-8").write(s)
print("\nv2 aplicada em", P)

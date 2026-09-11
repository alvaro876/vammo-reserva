# -*- coding: utf-8 -*-
"""v3 (08/09): a faixa da recusa passa a aparecer SEMPRE, inclusive em dia sem recusa.

Motivo: com `if (lista.length === 0) return null` o Alvaro abriu a tela duas vezes e não achou o
campo, porque hoje o dia está com zero recusa. Feature que não se acha não está entregue. A faixa
custa uma linha na TV e dá a certeza de onde a coisa mora; o estado vazio diz isso com texto.
"""
import io, sys
sys.stdout.reconfigure(encoding="utf-8")
P = r"C:\Users\Usuário\Desktop\vammo-reserva\src\app\cx\page.tsx"
s = io.open(P, encoding="utf-8").read()

def sub(velho, novo, nome):
    global s
    assert s.count(velho) == 1, (nome, "ancora nao unica:", s.count(velho))
    s = s.replace(velho, novo, 1)
    print("  ok", nome)

# ── 1) não esconde mais o bloco em dia sem recusa ──
sub(
    "  if (lista.length === 0) return null;\n",
    "  // v3: NÃO esconder em dia sem recusa — sem a faixa ninguém acha o campo (08/09)\n",
    "remove o early return",
)

# ── 2) contador do summary cobre o caso zero ──
sub(
    '''          <span className="text-sm text-slate-500">
            {lista.length} {lista.length === 1 ? "recusa" : "recusas"} hoje
          </span>
          {/* cor de zona é só do relógio do SLA: pendência aqui é slate, nunca vermelho nem âmbar */}
          {semMotivo > 0 ? (
            <Selo tom="ok">{semMotivo} sem motivo</Selo>
          ) : (
            <Selo tom="auto">todas com motivo</Selo>
          )}''',
    '''          <span className="text-sm text-slate-500">
            {lista.length === 0
              ? "nenhuma recusa registrada hoje"
              : `${lista.length} ${lista.length === 1 ? "recusa" : "recusas"} hoje`}
          </span>
          {/* cor de zona é só do relógio do SLA: pendência aqui é slate, nunca vermelho nem âmbar */}
          {lista.length === 0 ? null : semMotivo > 0 ? (
            <Selo tom="ok">{semMotivo} sem motivo</Selo>
          ) : (
            <Selo tom="auto">todas com motivo</Selo>
          )}''',
    "contador cobre o zero",
)

# ── 3) estado vazio dentro do aberto: sem campo de nome, sem lista ──
sub(
    '''      <div className="border-t border-slate-100 px-5 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input''',
    '''      <div className="border-t border-slate-100 px-5 py-3">
      {lista.length === 0 && (
        <p className="text-sm text-slate-500">
          Quando o operador cancelar uma oferta de reserva no Maestro, o cliente aparece aqui pra
          você marcar o motivo com um clique. Cancelamento automático (a moto ficou pronta) não entra.
        </p>
      )}
      {lista.length > 0 && (
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input''',
    "estado vazio",
)

# ── 4) fecha o bloco condicional do nome ──
sub(
    '''          aria-label="quem está registrando"
        />
      </div>''',
    '''          aria-label="quem está registrando"
        />
      </div>
      )}''',
    "fecha o condicional do nome",
)

io.open(P, "w", encoding="utf-8").write(s)
print("\nv3 aplicada")

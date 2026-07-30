// Porta de entrada das telas operacionais.
//
// A tela do CX mostra NOME DE CLIENTE e PLACA — dado pessoal. Sem isso o app
// ficava aberto na internet (qualquer pessoa com a URL via a fila da oficina
// com nome dos clientes).
//
// Desenho pensado pra TV/balcão: acesso por token na URL uma única vez
// (/cx?k=<token>), que vira cookie de 30 dias no aparelho. Depois disso o link
// limpo funciona sozinho — sem tela de senha pra travar a TV no meio do turno.
// Integrações continuam podendo usar o header x-api-key.
//
// Se RIVERS_CX_TOKEN não estiver no ambiente, a porta fica ABERTA (para não
// derrubar a operação por falta de config) mas o log avisa.

import { NextRequest, NextResponse } from "next/server";

const PROTEGIDAS = ["/cx", "/api/cx"];
const COOKIE = "rivers_acesso";

export function middleware(req: NextRequest) {
  const token = process.env.RIVERS_CX_TOKEN;
  if (!token) {
    console.warn("[middleware] RIVERS_CX_TOKEN ausente — telas do CX abertas");
    return NextResponse.next();
  }

  const { pathname, searchParams } = req.nextUrl;
  if (!PROTEGIDAS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // 1) integração/serviço: header
  if (req.headers.get("x-api-key") === token) return NextResponse.next();

  // 2) aparelho já liberado: cookie
  if (req.cookies.get(COOKIE)?.value === token) return NextResponse.next();

  // 3) primeiro acesso com ?k=<token> → guarda o cookie e limpa a URL
  if (searchParams.get("k") === token) {
    const limpa = req.nextUrl.clone();
    limpa.searchParams.delete("k");
    const res = NextResponse.redirect(limpa);
    res.cookies.set(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
    return res;
  }

  return new NextResponse(
    "Acesso restrito. Abra o link com o token de acesso (peça pro time de Dados).",
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

export const config = {
  matcher: ["/cx", "/cx/:path*", "/api/cx", "/api/cx/:path*"],
};

// Cliente ClickHouse via HTTPS API
//
// Por que não usar um SDK específico do ClickHouse?
// O ClickHouse expõe uma API HTTP simples: você manda SQL no body do POST,
// ele devolve JSON. Um fetch() já resolve — zero dependências extras.
//
// Por que rodar isso aqui no servidor (lib/), não no browser?
// Porque aqui ficam as credenciais. Se você chamasse o ClickHouse direto
// do React no browser, qualquer pessoa inspecionando o tráfego veria sua senha.

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST!;
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER!;
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD!;

if (!CLICKHOUSE_HOST || !CLICKHOUSE_USER || !CLICKHOUSE_PASSWORD) {
  throw new Error("Variáveis de ambiente do ClickHouse não configuradas. Cheque o .env.local");
}

// Executa uma query SQL e retorna array de objetos tipados
// O genérico <T> faz TypeScript inferir o tipo da linha — você passa o tipo na chamada:
//   await query<{ os_id: number; placa: string }>("SELECT ...")
export async function query<T>(sql: string): Promise<T[]> {
  const url = `${CLICKHOUSE_HOST}/?output_format_json_quote_64bit_integers=0`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      // Authorization via Basic Auth — codifica "user:password" em base64
      Authorization:
        "Basic " +
        Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64"),
    },
    body: sql + "\nFORMAT JSONEachRow",
    // cache: "no-store" porque dados de oficina mudam a cada minuto
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ClickHouse error ${response.status}: ${error.slice(0, 300)}`);
  }

  const text = await response.text();
  if (!text.trim()) return [];

  // JSONEachRow retorna uma linha JSON por linha de texto
  // Ex: {"os_id":16310,"placa":"SUC3G17"}\n{"os_id":16311,...}
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

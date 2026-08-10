// Configuração do adaptador OpenNext pro Cloudflare Workers.
// Sem cache incremental: o RIVERS é 100% dinâmico (lê ClickHouse ao vivo a cada
// requisição) — cachear resposta aqui seria mostrar fila velha na TV do CX.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();

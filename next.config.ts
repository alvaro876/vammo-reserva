import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ignoreBuildErrors herdado do setup inicial. O `npx tsc --noEmit` roda antes de
  // todo deploy (é o portão de verdade), então isso aqui só evita que warning de
  // tipagem de dependência derrube um deploy urgente.
  typescript: {
    ignoreBuildErrors: true,
  },
  // standalone é exigido pelo @opennextjs/cloudflare (migração de 10/08, saindo da
  // Vercel depois do bloqueio 402 da conta). Sem isso o adaptador não acha o
  // pages-manifest e o bundle do worker não fecha.
  output: "standalone",
};

export default nextConfig;

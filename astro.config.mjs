// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';

// https://astro.build/config
// `site` é usado só para canonical/OG. Troque pelo seu domínio de produção
// (o mesmo de SITE.productionHost em src/config/site.config.ts).
export default defineConfig({
  site: 'https://entrega-soarfly.vercel.app',

  vite: {
    plugins: [tailwindcss()]
  },

  adapter: vercel()
});

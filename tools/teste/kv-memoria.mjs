// Banco em memória com a parte da API do @vercel/kv que o projeto usa.
const dados = new Map();
const zsets = new Map();
const copia = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export const kv = {
  _dados: dados,
  async get(k) { return dados.has(k) ? copia(dados.get(k)) : null; },
  async set(k, v, opts = {}) {
    if (opts.nx && dados.has(k)) return null;
    dados.set(k, copia(v));
    return "OK";
  },
  async del(k) { return dados.delete(k) ? 1 : 0; },
  async incr(k) { const n = (Number(dados.get(k)) || 0) + 1; dados.set(k, n); return n; },
  async expire() { return 1; },
  async mget(...ks) { return ks.map((k) => (dados.has(k) ? copia(dados.get(k)) : null)); },
  async zadd(k, { score, member }) {
    const z = zsets.get(k) || new Map(); z.set(member, score); zsets.set(k, z); return 1;
  },
  async zrange(k, ini, fim, opts = {}) {
    let pares = [...(zsets.get(k) || new Map()).entries()].sort((a, b) => a[1] - b[1]);
    if (opts.byScore) {
      pares = pares.filter((e) => e[1] >= Number(ini) && e[1] <= Number(fim));
      let z = pares.map((e) => e[0]);
      if (opts.rev) z.reverse();
      if (opts.offset !== undefined && opts.count !== undefined) z = z.slice(opts.offset, opts.offset + opts.count);
      return z;
    }
    const z = pares.map((e) => e[0]);
    if (opts.rev) z.reverse();
    return fim === -1 ? z.slice(ini) : z.slice(ini, fim + 1);
  },
  async zrem(k, ...membros) {
    const z = zsets.get(k); if (!z) return 0;
    let n = 0; for (const m of membros) if (z.delete(m)) n++; return n;
  },
  async zscore(k, m) { const z = zsets.get(k); return z && z.has(m) ? z.get(m) : null; },
  async zcard(k) { return (zsets.get(k) || new Map()).size; },
  async lpush(k, ...vs) { const l = dados.get(k) || []; l.unshift(...vs.map(copia).reverse()); dados.set(k, l); return l.length; },
  async ltrim(k, ini, fim) { const l = dados.get(k) || []; dados.set(k, l.slice(ini, fim + 1)); return "OK"; },
  async lrange(k, ini, fim) { const l = dados.get(k) || []; return copia(fim === -1 ? l.slice(ini) : l.slice(ini, fim + 1)); },
  async hincrby(k, campo, n) { const o = dados.get(k) || {}; o[campo] = (Number(o[campo]) || 0) + n; dados.set(k, o); return o[campo]; },
  async hgetall(k) { return dados.has(k) ? copia(dados.get(k)) : null; },
};

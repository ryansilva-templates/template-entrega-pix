import { SITE } from "../config/site.config";

// Índice DEDICADO deste produto. Se o Vercel KV for compartilhado entre vários
// produtos, esta chave PRECISA ser única por produto (definida em site.config.ts) —
// caso contrário os pedidos de produtos diferentes se misturam no mesmo admin.
// Os orderId já têm prefixos diferentes na chave `order:${orderId}`, mas o ÍNDICE
// (zset) precisa ser próprio de cada produto.
export const ORDERS_INDEX_KEY = SITE.kvIndexKey;

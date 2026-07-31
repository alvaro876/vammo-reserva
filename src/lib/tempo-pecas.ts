// RECALIBRADO por scripts/recalibrar-tempos.mjs em 2026-07-31 — não editar na mão.
//
// Minutos de RAMPA por peça, aprendidos do tempo REAL de bancada (soma dos episódios
// IN_PROGRESS): mediana das OSs mono-peça como ponto de partida + 6 passadas de descida
// coordenada nas OSs mistas. Treino: 6.453 OSs (150 a 60 dias atrás, todas as bases).
// Teste SEPARADO (últimos 60d, piso Mooca, 2.184 OSs) — números na tabela do gatilho
// em algorithm.ts. 141 peças calibradas; 40 raras (menos de 8 OSs mono-peça no treino)
// mantidas do ajuste anterior de 2026-07-01.
//
// IMPORTANTE: estes tempos andam JUNTO com o multiplicador por nº de peças no
// rivers-engine (FATOR_N_PECAS) e com os gatilhos 240 do algorithm.ts. A calibração
// antiga tinha tempos subestimados compensados por fator baixo — trocar um sem o outro
// piora o conjunto (medido em 31/07: só trocar o mapa levava o C3_COMBINADO de 77→71%).

// Tempo fixo por OS (setup, deslocamento, finalização).
export const TEMPO_BASE_MIN = 25;

// Fallback pra peça fora do mapa e sem time_target no cadastro.
export const TEMPO_FALLBACK_MIN = 15;

export const MINUTOS_POR_PECA: Record<number, number> = {
  172: 16, 173: 5, 174: 6, 175: 6, 177: 12, 178: 14, 179: 15, 180: 10, 182: 17, 183: 17, 184: 18, 185: 12,
  186: 10, 187: 11, 189: 16, 190: 14, 191: 15, 192: 6, 193: 17, 194: 12, 195: 15, 196: 17, 197: 15, 198: 12,
  199: 12, 200: 10, 201: 9, 202: 7, 203: 6, 204: 12, 205: 12, 206: 10, 207: 11, 208: 16, 210: 8, 211: 10,
  212: 49, 213: 36, 214: 19, 215: 54, 216: 12, 217: 24, 218: 12, 220: 16, 221: 25, 222: 52, 224: 43, 225: 11,
  226: 11, 227: 10, 228: 12, 229: 18, 230: 16, 232: 7, 233: 25, 234: 9, 235: 11, 236: 12, 237: 9, 239: 11,
  240: 14, 241: 22, 242: 20, 243: 11, 244: 11, 245: 12, 246: 11, 247: 12, 248: 1, 249: 11, 250: 15, 251: 16,
  252: 15, 253: 11, 254: 9, 255: 12, 256: 10, 257: 24, 259: 34, 260: 71, 261: 8, 262: 3, 263: 11, 264: 11,
  265: 13, 267: 12, 270: 11, 271: 21, 272: 11, 273: 16, 274: 14, 275: 5, 276: 9, 277: 7, 278: 23, 279: 12,
  280: 21, 281: 12, 283: 12, 284: 8, 285: 18, 286: 20, 288: 19, 289: 16, 293: 17, 295: 6, 297: 14, 298: 14,
  299: 9, 300: 10, 301: 10, 302: 24, 303: 6, 304: 12, 305: 12, 306: 11, 307: 12, 308: 11, 309: 7, 310: 11,
  311: 12, 312: 16, 313: 22, 314: 9, 315: 9, 316: 8, 317: 12, 318: 5, 319: 7, 320: 7, 321: 7, 322: 11,
  323: 4, 324: 12, 325: 18, 326: 8, 327: 11, 328: 14, 329: 12, 330: 27, 331: 19, 332: 26, 333: 16, 334: 13,
  335: 11, 336: 7, 338: 12, 339: 19, 340: 14, 341: 8, 342: 7, 343: 12, 344: 21, 345: 20, 346: 29, 347: 25,
  348: 11, 349: 12, 353: 12, 354: 20, 355: 13, 356: 4, 357: 33, 358: 9, 359: 14, 392: 13, 425: 24, 491: 37,
  524: 19, 590: 8, 623: 14, 656: 15, 690: 16, 723: 24, 756: 9, 757: 24, 758: 19, 824: 1, 825: 21, 827: 2,
  828: 8,
};

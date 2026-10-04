process.env.TZ = 'UTC'; // el servidor calcula la fecha de Ecuador a mano (ver hoyTexto)
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.set('trust proxy', true); // Render está detrás de un proxy: así req.ip es la IP real
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '64kb' }));

const KEY = process.env.GEMINI_API_KEY || '';

// ---------- Configuración de seguridad y límites ----------
const OWNER_EMAIL = 'jproducer.ec@gmail.com';
const FREE_LIMIT = 3;            // recetas gratis por día (igual que en la app)
const MAX_ADS_PER_DAY = 5;       // anuncios con recompensa por día (igual que en la app)
const RC_ENTITLEMENT = 'pro';
const RC_SECRET = process.env.REVENUECAT_SECRET_KEY || '';
// Fase 1: "si" (por defecto) = las versiones viejas de la app (sin token) siguen funcionando.
// Fase 2: pon PERMITIR_APPS_VIEJAS = no en Render cuando todos hayan actualizado.
const PERMITIR_APPS_VIEJAS = (process.env.PERMITIR_APPS_VIEJAS || 'si') !== 'no';
// "no" (por defecto) = se acepta el aviso de la app de que vio el anuncio (con tope diario).
// "si" = solo cuenta el aviso firmado por Google (AdMob SSV). Actívalo cuando lo configures.
const ANUNCIOS_VERIFICADOS = (process.env.ANUNCIOS_VERIFICADOS || 'no') === 'si';

// ---------- Firebase Admin ----------
const admin = require('firebase-admin');

// En Render, guarda el JSON completo del service account en una variable
// de entorno llamada FIREBASE_SERVICE_ACCOUNT (como texto plano, todo en una línea).
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ---------- Utilidades de normalización y similitud ----------

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// El ingredientsKey se calcula a partir del string de ingredientes que manda el cliente
// (ej: "pollo, arroz, cebolla" -> ordenado y normalizado)
function ingredientsKey(ingredientsString) {
  return ingredientsString
    .split(',')
    .map((i) => normalizeText(i))
    .filter(Boolean)
    .sort()
    .join('|');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isSimilarName(nameA, nameB, threshold = 0.82) {
  const a = normalizeText(nameA);
  const b = normalizeText(nameB);
  if (a === b) return true;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen > 0 && 1 - dist / maxLen >= threshold;
}

// Extrae un nombre de receta aproximado del texto que devuelve Gemini
// (asume que la primera línea suele ser el título/nombre de la receta)
function extraerNombre(texto) {
  const primeraLinea = texto.split('\n').find((l) => l.trim().length > 0) || '';
  return primeraLinea.replace(/[*#]/g, '').trim().substring(0, 120);
}

// ---------- Paso 1: buscar en el banco antes de llamar a Gemini ----------

// El banco tiene 3 "cajones" separados para que nunca se mezclen categorías:
// - normal: el generador principal por ingredientes (recipes_bank, clave = ingredientes)
// - salud: todo "Cuidamos tu salud" (recipes_bank_salud, clave = categoria exacta,
//   ej. "salud_desayuno", "salud_bebida_dietetica" — cada una en su propio cajón)
// - bebidas: "Bebidas, jugos y cócteles" Pro (recipes_bank_bebidas, clave = categoria)
// Antes todas estas categorías compartían la misma clave (un texto de relleno fijo),
// por eso el banco servía comida donde debía servir una bebida.
function bankConfig(categoria) {
  if (!categoria) return { collection: 'recipes_bank', keyField: 'ingredientsKey' };
  if (categoria.startsWith('bebida_pro')) return { collection: 'recipes_bank_bebidas', keyField: 'categoria' };
  return { collection: 'recipes_bank_salud', keyField: 'categoria' };
}

async function buscarEnBanco(uid, ingredientsString, categoria) {
  const { collection, keyField } = bankConfig(categoria);
  const key = categoria || ingredientsKey(ingredientsString);

  const snapshot = await db
    .collection(collection)
    .where(keyField, '==', key)
    .limit(20)
    .get();

  if (snapshot.empty) return null;

  const shownSnap = await db
    .collection('users').doc(uid)
    .collection('shownRecipes').get();
  const shownIds = new Set(shownSnap.docs.map((d) => d.id));

  const candidatos = snapshot.docs.filter((d) => !shownIds.has(d.id));
  if (candidatos.length === 0) return null;

  const elegido = candidatos[Math.floor(Math.random() * candidatos.length)];
  return { id: elegido.id, ...elegido.data() };
}

async function marcarComoVista(uid, recipeId) {
  await db.collection('users').doc(uid)
    .collection('shownRecipes').doc(recipeId)
    .set({ shownAt: FieldValue.serverTimestamp() });
}

async function esDuplicadaEnBanco(nombre, ingredientsString, categoria) {
  const { collection, keyField } = bankConfig(categoria);

  // Para "Cuidamos tu salud" y "Bebidas Pro", el chequeo de duplicados cruza AMBAS
  // colecciones (no solo la propia categoría) — así un usuario nunca recibe la misma
  // receta tanto en, por ejemplo, "bebida dietética" como en "Bebidas Pro: jugo".
  if (keyField === 'categoria') {
    const colecciones = ['recipes_bank_salud', 'recipes_bank_bebidas'];
    for (const col of colecciones) {
      const snap = await db.collection(col).orderBy('createdAt', 'desc').limit(30).get();
      for (const doc of snap.docs) {
        if (isSimilarName(doc.data().name, nombre)) return true;
      }
    }
    return false;
  }

  const key = ingredientsKey(ingredientsString);
  const exacto = await db.collection(collection)
    .where(keyField, '==', key).limit(5).get();

  for (const doc of exacto.docs) {
    if (isSimilarName(doc.data().name, nombre)) return true;
  }
  return false;
}

async function guardarEnBanco({ nombre, texto, ingredientsString, categoria }) {
  const { collection, keyField } = bankConfig(categoria);
  const doc = {
    name: nombre,
    contenido: texto,
    createdAt: FieldValue.serverTimestamp(),
    timesServed: 1,
  };
  if (keyField === 'ingredientsKey') {
    doc.ingredientsKey = ingredientsKey(ingredientsString);
    doc.ingredientsRaw = ingredientsString;
  } else {
    doc.categoria = categoria;
  }
  const docRef = await db.collection(collection).add(doc);
  return docRef.id;
}

// ---------- Lógica original de llamada a Gemini (sin cambios) ----------

const MODELOS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
const INTENTOS_POR_MODELO = 2;
const ESPERA_ENTRE_INTENTOS_MS = 1500;

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function llamarGemini(modelo, promptFinal) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptFinal }] }]
    })
  });
  const d = await r.json();
  return { ok: r.ok && !d.error, status: r.status, data: d };
}

async function generarConReintentos(promptFinal) {
  let ultimo = null;
  for (const modelo of MODELOS) {
    for (let intento = 0; intento < INTENTOS_POR_MODELO; intento++) {
      if (intento > 0) await esperar(ESPERA_ENTRE_INTENTOS_MS);
      const resultado = await llamarGemini(modelo, promptFinal);
      console.log(`Intento con ${modelo} (${intento + 1}/${INTENTOS_POR_MODELO}) -> status ${resultado.status}`);
      ultimo = resultado;
      if (resultado.ok) return resultado;

      const code = resultado.data?.error?.code;
      if (code === 503 || code === 429) continue;
      break;
    }
  }
  return ultimo;
}

// =====================================================================
// SEGURIDAD: identidad, Pro, límite diario y anuncios
// =====================================================================

// Fecha de "hoy" en Ecuador (UTC-5), en el mismo formato que usa la app (toDateString).
function hoyTexto() {
  return new Date(Date.now() - 5 * 3600 * 1000).toDateString();
}

// Lee el token de Firebase del encabezado Authorization.
// Devuelve: null si no vino token, { error } si vino pero es inválido, o los datos del usuario.
async function leerSesion(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const t = await admin.auth().verifyIdToken(h.slice(7));
    return { uid: t.uid, email: (t.email || '').toLowerCase(), verificado: t.email_verified === true };
  } catch (e) {
    console.log('Token inválido:', e.code || e.message);
    return { error: true };
  }
}

function esDueno(sesion) {
  return !!sesion && sesion.verificado && sesion.email === OWNER_EMAIL;
}

// Consulta a RevenueCat si el usuario tiene "pro" activo. Guarda el resultado 10 min.
// Funciona con claves secretas V1 o V2 de RevenueCat (V2 necesita REVENUECAT_PROJECT_ID).
const RC_PROJECT = process.env.REVENUECAT_PROJECT_ID || '';
const cachePro = new Map();
let idEntitlementV2 = null;

async function proConV1(uid) {
  const r = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${RC_SECRET}` },
  });
  if (!r.ok) { const e = new Error('RevenueCat v1 status ' + r.status); e.status = r.status; throw e; }
  const d = await r.json();
  const ent = d?.subscriber?.entitlements?.[RC_ENTITLEMENT];
  return !!ent && (!ent.expires_date || new Date(ent.expires_date).getTime() > Date.now());
}

async function proConV2(uid) {
  const base = `https://api.revenuecat.com/v2/projects/${encodeURIComponent(RC_PROJECT)}`;
  const h = { Authorization: `Bearer ${RC_SECRET}` };
  if (!idEntitlementV2) {
    const r = await fetch(`${base}/entitlements?limit=100`, { headers: h });
    if (!r.ok) throw new Error('RevenueCat v2 entitlements status ' + r.status);
    const d = await r.json();
    const ent = (d.items || []).find((e) => e.lookup_key === RC_ENTITLEMENT);
    if (!ent) throw new Error(`No existe el entitlement "${RC_ENTITLEMENT}" en RevenueCat`);
    idEntitlementV2 = ent.id;
  }
  const r = await fetch(`${base}/customers/${encodeURIComponent(uid)}/active_entitlements?limit=100`, { headers: h });
  if (r.status === 404) return false; // cliente que nunca compró
  if (!r.ok) throw new Error('RevenueCat v2 status ' + r.status);
  const d = await r.json();
  return (d.items || []).some((e) => e.entitlement_id === idEntitlementV2
    && (e.expires_at == null || Number(e.expires_at) > Date.now()));
}

async function esProReal(uid) {
  const c = cachePro.get(uid);
  if (c && Date.now() - c.t < 10 * 60 * 1000) return c.pro;
  if (!RC_SECRET) { console.log('Falta REVENUECAT_SECRET_KEY en Render'); return c ? c.pro : false; }
  try {
    let pro;
    if (RC_PROJECT) {
      pro = await proConV2(uid);
    } else {
      pro = await proConV1(uid);
    }
    cachePro.set(uid, { pro, t: Date.now() });
    return pro;
  } catch (e) {
    console.log('No se pudo consultar RevenueCat:', e.message);
    return c ? c.pro : false; // si RevenueCat falla, usamos el último dato conocido
  }
}

// Categorías que solo puede pedir un usuario Pro (igual que en la app).
function esCategoriaPro(categoria) {
  if (!categoria) return false;
  return categoria.startsWith('bebida_pro')
    || categoria.startsWith('salud_bebida_')
    || categoria === 'salud_bajarpeso_cena'
    || categoria === 'salud_bajarpeso_bebida';
}

// Uso diario guardado en usage/{uid}. SOLO el servidor lo modifica.
// Una "generación" (ej. el plan de bajar de peso = 2 a 4 recetas seguidas) es un "grupo":
// se descuenta 1 receta al empezar el grupo, y si el grupo nunca tuvo éxito, se devuelve.
const GRUPO_MAX_MS = 15 * 60 * 1000;
const GRUPO_MAX_LLAMADAS = 30;

function normalizarUso(u) {
  const hoy = hoyTexto();
  if (!u || u.date !== hoy) {
    return { date: hoy, recipesUsed: 0, adsUsed: 0, extraEarned: 0, grupo: null };
  }
  u = { recipesUsed: 0, adsUsed: 0, extraEarned: 0, grupo: null, ...u };
  // Grupo viejo que nunca tuvo éxito: se devuelve la receta descontada.
  const g = u.grupo;
  if (g && g.cobrado && !g.exito && Date.now() - g.desde > GRUPO_MAX_MS) {
    u.recipesUsed = Math.max(0, u.recipesUsed - 1);
    u.grupo = { ...g, cobrado: false };
  }
  return u;
}

function usoPublico(u, ilimitado) {
  const limite = FREE_LIMIT + (u.extraEarned || 0);
  return {
    recipesUsed: u.recipesUsed || 0,
    extraEarned: u.extraEarned || 0,
    adsUsed: u.adsUsed || 0,
    limite,
    restantes: ilimitado ? 999 : Math.max(0, limite - (u.recipesUsed || 0)),
    esPro: !!ilimitado,
    date: u.date,
  };
}

async function reservarReceta(uid, grupoId, ilimitado) {
  const ref = db.collection('usage').doc(uid);
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const u = normalizarUso(snap.exists ? snap.data() : null);
    const ahora = Date.now();
    let g = u.grupo;
    const mismoGrupo = g && grupoId && g.id === grupoId
      && ahora - g.desde < GRUPO_MAX_MS && (g.llamadas || 0) < GRUPO_MAX_LLAMADAS;

    if (!mismoGrupo) {
      // Si el grupo anterior se cobró y nunca funcionó, se devuelve antes de empezar otro.
      if (g && g.cobrado && !g.exito) {
        u.recipesUsed = Math.max(0, u.recipesUsed - 1);
        g = { ...g, cobrado: false };
        u.grupo = g;
      }
      if (!ilimitado && u.recipesUsed >= FREE_LIMIT + (u.extraEarned || 0)) {
        t.set(ref, u); // se conserva el grupo en curso
        return { ok: false, uso: usoPublico(u, ilimitado) };
      }
      g = { id: grupoId || crypto.randomUUID(), desde: ahora, llamadas: 0, exito: false, cobrado: !ilimitado };
      if (!ilimitado) u.recipesUsed += 1;
    }
    g.llamadas = (g.llamadas || 0) + 1;
    u.grupo = g;
    t.set(ref, u);
    return { ok: true, uso: usoPublico(u, ilimitado), grupoId: g.id };
  });
}

async function marcarExito(uid, grupoId) {
  const ref = db.collection('usage').doc(uid);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return;
    const u = snap.data();
    if (u.grupo && u.grupo.id === grupoId && !u.grupo.exito) {
      t.update(ref, { 'grupo.exito': true });
    }
  });
}

async function sumarAnuncio(uid, transaccionId) {
  const ref = db.collection('usage').doc(uid);
  const refTx = transaccionId ? ref.collection('anuncios').doc(transaccionId) : null;
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (refTx) {
      const ya = await t.get(refTx);
      if (ya.exists) return { ok: false, motivo: 'repetido' };
    }
    const u = normalizarUso(snap.exists ? snap.data() : null);
    if ((u.adsUsed || 0) >= MAX_ADS_PER_DAY) { t.set(ref, u); return { ok: false, motivo: 'tope', uso: usoPublico(u, false) }; }
    u.adsUsed = (u.adsUsed || 0) + 1;
    u.extraEarned = (u.extraEarned || 0) + 1;
    t.set(ref, u);
    if (refTx) t.set(refTx, { fecha: FieldValue.serverTimestamp() });
    return { ok: true, uso: usoPublico(u, false) };
  });
}

// Freno para las versiones viejas de la app (sin token): máx. 20 pedidos por hora por IP.
const pedidosPorIp = new Map();
function ipExcedida(ip) {
  const ahora = Date.now();
  const r = pedidosPorIp.get(ip);
  if (!r || ahora > r.reinicio) { pedidosPorIp.set(ip, { n: 1, reinicio: ahora + 3600 * 1000 }); return false; }
  r.n += 1;
  return r.n > 20;
}
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, r] of pedidosPorIp) if (ahora > r.reinicio) pedidosPorIp.delete(ip);
}, 10 * 60 * 1000).unref();

function respuestaTexto(res, texto, extra = {}, status = 200) {
  return res.status(status).json({ esError: true, contenido: [{ tipo: 'texto', texto }], ...extra });
}

// Solo aceptamos pedidos que realmente vienen de las instrucciones de MiRecetaAI,
// para que nadie use este servidor como una IA gratis para otras cosas.
function pedidoValido({ ingredients, systemPrompt, categoria }) {
  if (typeof ingredients !== 'string' || ingredients.length === 0 || ingredients.length > 1500) return false;
  if (systemPrompt !== undefined && systemPrompt !== null) {
    if (typeof systemPrompt !== 'string' || systemPrompt.length > 15000) return false;
    if (!systemPrompt.trimStart().startsWith('Eres MiRecetaAI')) return false;
  }
  if (categoria !== undefined && categoria !== null && categoria !== '') {
    if (typeof categoria !== 'string' || !/^[a-z0-9_]{1,60}$/.test(categoria)) return false;
  }
  return true;
}

// ---------- Endpoint principal ----------

app.post('/api/receta', async (req, res) => {
  const { ingredients, systemPrompt, categoria, grupo } = req.body || {};
  console.log('=== /api/receta === categoria:', categoria || 'normal');

  if (!pedidoValido(req.body || {})) {
    return respuestaTexto(res, '🤔 No pudimos procesar ese pedido. Actualiza la app e intenta de nuevo.', { codigo: 'INVALIDO' }, 400);
  }

  const sesion = await leerSesion(req);
  if (sesion && sesion.error) {
    return respuestaTexto(res, '🔒 Tu sesión expiró. Cierra sesión y vuelve a entrar para seguir cocinando.', { codigo: 'SESION' }, 401);
  }

  let uid = null;
  let grupoId = null;
  let usoActual = null;

  if (sesion) {
    // ---- App nueva: identidad verificada por Google ----
    uid = sesion.uid;
    const ilimitado = esDueno(sesion) || await esProReal(uid);

    if (esCategoriaPro(categoria) && !ilimitado) {
      return respuestaTexto(res, '👑 Esta función es exclusiva de Cocinero/a Pro.', { codigo: 'SOLO_PRO' }, 403);
    }

    const reserva = await reservarReceta(uid, typeof grupo === 'string' ? grupo.slice(0, 64) : null, ilimitado);
    if (!reserva.ok) {
      return respuestaTexto(res, '🍽️ Ya usaste tus recetas gratis de hoy. Mañana se renuevan solas.', { codigo: 'LIMITE', uso: reserva.uso }, 429);
    }
    grupoId = reserva.grupoId;
    usoActual = reserva.uso;
  } else {
    // ---- App vieja (sin token) ----
    if (!PERMITIR_APPS_VIEJAS) {
      return respuestaTexto(res, '📲 Hay una nueva versión de MiRecetaAI. Actualízala desde Google Play para seguir cocinando.', { codigo: 'ACTUALIZAR' }, 426);
    }
    if (ipExcedida(req.ip)) {
      return respuestaTexto(res, '⏳ Muchas recetas seguidas. Espera un rato e intenta de nuevo.', { codigo: 'FRENO' }, 429);
    }
    uid = typeof req.body.uid === 'string' ? req.body.uid.slice(0, 128) : null;
  }

  const exito = async (texto) => {
    if (sesion && grupoId) {
      try { await marcarExito(uid, grupoId); } catch (e) { console.log('No se pudo marcar éxito:', e.message); }
    }
    return res.json({ esError: false, contenido: [{ tipo: 'texto', texto }], uso: usoActual, grupo: grupoId });
  };

  try {
    if (uid) {
      const delBanco = await buscarEnBanco(uid, ingredients, categoria);
      if (delBanco) {
        console.log('Receta servida desde el banco, sin llamar a Gemini');
        await marcarComoVista(uid, delBanco.id);
        const { collection } = bankConfig(categoria);
        await db.collection(collection).doc(delBanco.id)
          .update({ timesServed: FieldValue.increment(1) });
        return exito(delBanco.contenido);
      }
    }

    const promptBase = systemPrompt
      ? `${systemPrompt}\n\nIngredientes disponibles: ${ingredients}`
      : `Eres un chef latinoamericano. Crea una receta con estos ingredientes: ${ingredients}. Formatea la respuesta de manera clara.`;

    let texto = null;
    let intentos = 0;
    const nombresRecientes = [];

    while (intentos < 3) {
      const promptFinal = nombresRecientes.length > 0
        ? `${promptBase}\n\nNo generes una receta con nombre igual o muy similar a estas: ${nombresRecientes.join(', ')}. Varía el estilo regional (costa, sierra, oriente, amazonía).`
        : promptBase;

      const { data: d } = await generarConReintentos(promptFinal);

      if (d.error) {
        const code = d.error.code;
        let mensajeAmigable;
        if (code === 503 || code === 429) {
          mensajeAmigable = "⏳ ¡Vaya! Hay muchos usuarios generando recetas en este momento. No te preocupes, no pasa nada raro con la app — espera un par de minutos y vuelve a intentarlo. 🍽️";
        } else if (code === 404) {
          mensajeAmigable = "🔧 Estamos ajustando algo por detrás. Intenta de nuevo en unos minutos.";
        } else if (code === 400) {
          mensajeAmigable = "🤔 No entendí bien esos ingredientes. Intenta escribirlos de otra forma o agrega uno más.";
        } else {
          mensajeAmigable = "😅 Tuvimos un pequeño inconveniente generando tu receta. Intenta de nuevo en un momento.";
        }
        return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: mensajeAmigable }], uso: usoActual });
      }

      const candidato = d?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!candidato) {
        return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: "😅 No pudimos generar tu receta esta vez. Intenta de nuevo en un momento." }], uso: usoActual });
      }

      const nombre = extraerNombre(candidato);

      if (!uid) {
        texto = candidato;
        break;
      }

      const duplicada = await esDuplicadaEnBanco(nombre, ingredients, categoria);
      if (!duplicada) {
        texto = candidato;
        await guardarEnBanco({ nombre, texto: candidato, ingredientsString: ingredients, categoria });
        break;
      }

      nombresRecientes.push(nombre);
      intentos++;
    }

    if (!texto) {
      return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: "😅 No pudimos generar una receta distinta esta vez. Intenta de nuevo en un momento." }], uso: usoActual });
    }

    return exito(texto);
  } catch (mi) {
    console.log('ERROR CAPTURADO:', mi.message);
    res.json({ esError: true, contenido: [{ tipo: 'texto', texto: '😅 Tuvimos un problema de conexión. Por favor intenta de nuevo en un momento.' }], uso: usoActual });
  }
});

// ---------- Consultar el uso del día (lo muestra la app) ----------
app.get('/api/uso', async (req, res) => {
  const sesion = await leerSesion(req);
  if (!sesion || sesion.error) return res.status(401).json({ codigo: 'SESION' });
  try {
    const ilimitado = esDueno(sesion) || await esProReal(sesion.uid);
    const ref = db.collection('usage').doc(sesion.uid);
    const u = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const n = normalizarUso(snap.exists ? snap.data() : null);
      t.set(ref, n);
      return n;
    });
    res.json({ uso: usoPublico(u, ilimitado) });
  } catch (e) {
    console.log('Error en /api/uso:', e.message);
    res.status(500).json({ codigo: 'ERROR' });
  }
});

// ---------- Anuncio con recompensa: aviso desde la app (fase 1) ----------
app.post('/api/anuncio-visto', async (req, res) => {
  const sesion = await leerSesion(req);
  if (!sesion || sesion.error) return res.status(401).json({ codigo: 'SESION' });
  if (ANUNCIOS_VERIFICADOS) {
    // Con AdMob SSV activo, la recompensa la da el aviso firmado de Google, no la app.
    return res.json({ ok: true, verificado: true });
  }
  try {
    const r = await sumarAnuncio(sesion.uid, null);
    res.json(r);
  } catch (e) {
    console.log('Error en /api/anuncio-visto:', e.message);
    res.status(500).json({ ok: false });
  }
});

// ---------- Anuncio con recompensa: aviso firmado por Google (AdMob SSV) ----------
let clavesAdmob = { t: 0, claves: {} };
async function obtenerClavesAdmob() {
  if (Date.now() - clavesAdmob.t < 6 * 3600 * 1000 && Object.keys(clavesAdmob.claves).length) return clavesAdmob.claves;
  const r = await fetch('https://www.gstatic.com/admob/reward/verifier-keys.json');
  const d = await r.json();
  const claves = {};
  for (const k of d.keys || []) claves[String(k.keyId)] = k.pem;
  clavesAdmob = { t: Date.now(), claves };
  return claves;
}

app.get('/api/admob-ssv', async (req, res) => {
  try {
    const query = (req.originalUrl.split('?')[1]) || '';
    const i = query.indexOf('&signature=');
    if (i < 0) return res.status(200).send('ok'); // prueba de AdMob sin firma
    const mensaje = query.slice(0, i);
    const firma = req.query.signature;
    const keyId = String(req.query.key_id || '');
    const claves = await obtenerClavesAdmob();
    const pem = claves[keyId];
    const valida = !!pem && crypto.verify('sha256', Buffer.from(mensaje), pem, Buffer.from(String(firma), 'base64url'));
    if (!valida) { console.log('SSV: firma inválida'); return res.status(200).send('ok'); }

    const uid = String(req.query.user_id || '');
    const tx = String(req.query.transaction_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    if (!uid || !tx) return res.status(200).send('ok'); // verificación de prueba o app vieja
    const r = await sumarAnuncio(uid, tx);
    console.log('SSV recompensa:', uid, r.ok ? 'sumada' : r.motivo);
    res.status(200).send('ok');
  } catch (e) {
    console.log('Error en SSV:', e.message);
    res.status(500).send('error'); // AdMob reintenta más tarde
  }
});

app.get('/salud', (req, res) => res.json({ estado: 'OK' }));

app.listen(process.env.PUERTO || process.env.PORT || 3000, () => console.log('Servidor OK'));

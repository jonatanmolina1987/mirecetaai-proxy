const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const KEY = process.env.GEMINI_API_KEY || '';

// ---------- NUEVO: Firebase Admin para el banco de recetas ----------
const admin = require('firebase-admin');

// En Render, guarda el JSON completo del service account en una variable
// de entorno llamada FIREBASE_SERVICE_ACCOUNT (como texto plano, todo en una línea).
// Se descarga desde: Firebase Console > Configuración del proyecto > Cuentas de servicio > Generar nueva clave privada.
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

// ---------- Endpoint principal, ahora con banco de recetas ----------

app.post('/api/receta', async (req, res) => {
  console.log('=== Petición recibida en /api/receta ===');
  console.log('Body:', JSON.stringify(req.body));
  try {
    const { ingredients, systemPrompt, uid, categoria } = req.body;
    console.log('Ingredientes:', ingredients, '| uid:', uid, '| categoria:', categoria);

    // Si no llega uid (ej. mientras actualizas la app), usamos el flujo viejo sin banco
    if (uid) {
      const delBanco = await buscarEnBanco(uid, ingredients, categoria);
      if (delBanco) {
        console.log('Receta servida desde el banco, sin llamar a Gemini');
        await marcarComoVista(uid, delBanco.id);
        const { collection } = bankConfig(categoria);
        await db.collection(collection).doc(delBanco.id)
          .update({ timesServed: FieldValue.increment(1) });
        return res.json({ esError: false, contenido: [{ tipo: 'texto', texto: delBanco.contenido }] });
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
        return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: mensajeAmigable }] });
      }

      const candidato = d?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!candidato) {
        return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: "😅 No pudimos generar tu receta esta vez. Intenta de nuevo en un momento." }] });
      }

      const nombre = extraerNombre(candidato);

      if (!uid) {
        // Sin uid no podemos chequear el banco por usuario; se sirve directo (comportamiento viejo)
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
      return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: "😅 No pudimos generar una receta distinta esta vez. Intenta de nuevo en un momento." }] });
    }

    res.json({ esError: false, contenido: [{ tipo: 'texto', texto }] });
  } catch (mi) {
    console.log('ERROR CAPTURADO:', mi.message);
    res.json({ esError: true, contenido: [{ tipo: 'texto', texto: '😅 Tuvimos un problema de conexión. Por favor intenta de nuevo en un momento.' }] });
  }
});

app.get('/salud', (req, res) => res.json({ estado: 'OK' }));

app.listen(process.env.PUERTO || process.env.PORT || 3000, () => console.log('Servidor OK'));

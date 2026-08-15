const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const KEY = process.env.GEMINI_API_KEY || '';

// Usamos alias "-latest" en vez de un modelo fijo: Google promete que estos alias
// siempre apuntan a un modelo válido y disponible, así que no nos puede pasar de
// nuevo lo de "este modelo ya no existe" (404) como con gemini-2.5-flash-lite.
// Probamos primero el más barato (Flash-Lite) y caemos a Flash normal si falla.
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

// Prueba cada modelo de la lista en orden. Para cada uno, reintenta un par de veces
// si el error es 503/429 (alta demanda, puede ser transitorio). Si el error es otro
// (por ejemplo 404 "modelo ya no disponible"), no tiene caso reintentar el mismo
// modelo — pasamos directo al siguiente de la lista.
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
      if (code === 503 || code === 429) continue; // vale la pena reintentar el mismo modelo
      break; // 404, 400, etc: no se arregla reintentando, probamos el siguiente modelo
    }
  }
  return ultimo;
}

app.post('/api/receta', async (req, res) => {
  console.log('=== Petición recibida en /api/receta ===');
  console.log('Body:', JSON.stringify(req.body));
  try {
    const { ingredients, systemPrompt } = req.body;
    console.log('Ingredientes:', ingredients);
    console.log('Llave presente:', KEY ? 'SI (' + KEY.substring(0,6) + '...)' : 'NO - LLAVE VACIA');

    const promptFinal = systemPrompt
      ? `${systemPrompt}\n\nIngredientes disponibles: ${ingredients}`
      : `Eres un chef latinoamericano. Crea una receta con estos ingredientes: ${ingredients}. Formatea la respuesta de manera clara.`;

    const { data: d } = await generarConReintentos(promptFinal);
    console.log('Respuesta cruda de Gemini:', JSON.stringify(d).substring(0, 500));

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

      console.log('Error de Gemini detectado, enviando mensaje amigable al usuario');
      return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: mensajeAmigable }] });
    }

    const texto = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) {
      return res.json({ esError: true, contenido: [{ tipo: 'texto', texto: "😅 No pudimos generar tu receta esta vez. Intenta de nuevo en un momento." }] });
    }
    res.json({ esError: false, contenido: [{ tipo: 'texto', texto }] });
  } catch (mi) {
    console.log('ERROR CAPTURADO:', mi.message);
    res.json({ esError: true, contenido: [{ tipo: 'texto', texto: '😅 Tuvimos un problema de conexión. Por favor intenta de nuevo en un momento.' }] });
  }
});

app.get('/salud', (req, res) => res.json({ estado: 'OK' }));

app.listen(process.env.PUERTO || process.env.PORT || 3000, () => console.log('Servidor OK'));

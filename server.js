const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const KEY = process.env.GEMINI_API_KEY || '';

// Modelos fijos (NO alias "latest"): así el precio y el comportamiento no cambian
// solos cuando Google mueve el alias a otro modelo. gemini-2.5-flash-lite es el
// más barato y maduro para este caso de uso (receta corta, formato fijo).
// Si por alta demanda falla incluso después de reintentar, probamos una vez con
// gemini-2.5-flash como red de seguridad antes de rendirnos.
const MODELO_PRINCIPAL = 'gemini-2.5-flash-lite';
const MODELO_RESPALDO = 'gemini-2.5-flash';

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Llama a Gemini con un modelo específico. Devuelve { ok, status, data }.
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

// Intenta generar la receta con reintentos (backoff) en el modelo principal y,
// si sigue fallando por alta demanda/rate limit, un último intento en el de respaldo.
async function generarConReintentos(promptFinal) {
  const intentos = [
    { modelo: MODELO_PRINCIPAL, esperaPrevia: 0 },
    { modelo: MODELO_PRINCIPAL, esperaPrevia: 1500 },
    { modelo: MODELO_RESPALDO, esperaPrevia: 1500 },
  ];

  let ultimoResultado = null;
  for (const intento of intentos) {
    if (intento.esperaPrevia) await esperar(intento.esperaPrevia);
    const resultado = await llamarGemini(intento.modelo, promptFinal);
    console.log(`Intento con ${intento.modelo} -> status ${resultado.status}`);
    ultimoResultado = resultado;
    if (resultado.ok) return resultado;

    const code = resultado.data?.error?.code;
    // Solo vale la pena reintentar en 503 (alta demanda) o 429 (rate limit).
    // Cualquier otro error (400, 404, etc.) no se arregla reintentando.
    if (code !== 503 && code !== 429) return resultado;
  }
  return ultimoResultado;
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

    // Si Gemini devolvió un error, damos un mensaje amigable en vez del JSON crudo
    if (d.error) {
      const code = d.error.code;
      let mensajeAmigable;

      if (code === 503 || code === 429) {
        // Alta demanda / rate limit (ya reintentamos varias veces antes de llegar aquí)
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

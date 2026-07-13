const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const KEY = process.env.GEMINI_API_KEY || '';

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

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptFinal }] }]
      })
    });
    console.log('Status de respuesta de Gemini:', r.status);
    const d = await r.json();
    console.log('Respuesta cruda de Gemini:', JSON.stringify(d).substring(0, 500));

    // Si Gemini devolvió un error, damos un mensaje amigable en vez del JSON crudo
    if (d.error) {
      const code = d.error.code;
      let mensajeAmigable;

      if (code === 503 || code === 429) {
        // Alta demanda / rate limit
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

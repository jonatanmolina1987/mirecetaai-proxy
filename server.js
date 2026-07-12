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
    const { ingredientes } = req.body;
    console.log('Ingredientes:', ingredientes);
    console.log('Llave presente:', KEY ? 'SI (' + KEY.substring(0,6) + '...)' : 'NO - LLAVE VACIA');

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Eres un chef latinoamericano. Crea una receta con estos ingredientes: ${ingredientes}. Formatea la respuesta de manera clara.` }] }]
      })
    });
    console.log('Status de respuesta de Gemini:', r.status);
    const d = await r.json();
    console.log('Respuesta cruda de Gemini:', JSON.stringify(d).substring(0, 500));
    const texto = d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta: ' + JSON.stringify(d).substring(0, 100);
    res.json({ contenido: [{ tipo: 'texto', texto }] });
  } catch (mi) {
    console.log('ERROR CAPTURADO:', mi.message);
    res.json({ contenido: [{ tipo: 'texto', texto: 'Error: ' + mi.message }] });
  }
});

app.get('/salud', (req, res) => res.json({ estado: 'OK' }));

app.listen(process.env.PUERTO || process.env.PORT || 3000, () => console.log('Servidor OK'));

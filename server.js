const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const KEY = process.env.GEMINI_API_KEY || '';

app.post('/api/receta', async (req, res) => {
  try {
    const { ingredientes } = req.body;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Eres un chef latinoamericano. Crea una receta con estos ingredientes: ${ingredientes}. Formatea la respuesta de manera clara.` }] }]
      })
    });
    const d = await r.json();
    const texto = d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta: ' + JSON.stringify(d).substring(0, 100);
    res.json({ contenido: [{ tipo: 'texto', texto }] });
  } catch (mi) {
    res.json({ contenido: [{ tipo: 'texto', texto: 'Error: ' + mi.mensaje }] });
  }
});

app.get('/salud', (req, res) => res.json({ estado: 'OK' }));

app.listen(process.env.PUERTO || 3000, () => console.log('Servidor OK'));

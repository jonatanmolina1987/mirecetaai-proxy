const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const KEY = process.env.GEMINI_API_KEY || '';
app.post('/api/receta', async (req, res) => {
  try {
    const { ingredients } = req.body;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `Eres un chef latinoamericano. Crea una receta con estos ingredientes: ${ingredients}. Formato: RECETA: nombre\nINGREDIENTES:\n- item\nPASOS:\n1. paso\nTIP: consejo\nPRESENTACION: descripcion. Max 200 palabras.` }] }], generationConfig: { maxOutputTokens: 512 } })
    });
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta: ' + JSON.stringify(d).substring(0,100);
    res.json({ content: [{ type: 'text', text }] });
  } catch(e) { res.json({ content: [{ type: 'text', text: 'Error: ' + e.message }] }); }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(process.env.PORT || 3000, () => console.log('Servidor OK'));

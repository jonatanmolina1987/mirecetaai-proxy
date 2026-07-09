const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const systemPrompt = `Eres MiRecetaAI, un chef latinoamericano. Dame una receta corta con estos ingredientes.

Formato:
RECETA: [nombre con emoji]
INGREDIENTES:
- ingrediente 1
- ingrediente 2
PASOS:
1. paso uno
2. paso dos
3. paso tres
TIP: consejo util
PRESENTACION: descripcion visual

Maximo 200 palabras. Espanol latinoamericano.`;

app.post('/api/receta', async (req, res) => {
  try {
    const { ingredients } = req.body;
    console.log('Ingredientes:', ingredients);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: systemPrompt + '\n\nIngredientes: ' + ingredients }]
          }],
          generationConfig: {
            maxOutputTokens: 512,
            temperature: 0.7
          }
        })
      }
    );

    const rawText = await response.text();
    console.log('Status:', response.status);
    console.log('Raw response:', rawText.substring(0, 300));

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('JSON parse error:', e.message);
      return res.json({ content: [{ type: 'text', text: 'Error parsing: ' + rawText.substring(0, 100) }] });
    }

    if (!response.ok) {
      return res.json({ content: [{ type: 'text', text: 'Error ' + response.status + ': ' + (data.error?.message || rawText.substring(0, 100)) }] });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      return res.json({ content: [{ type: 'text', text: 'Sin texto: ' + rawText.substring(0, 200) }] });
    }

    console.log('OK - chars:', text.length);
    res.json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('Error:', err.message);
    res.json({ content: [{ type: 'text', text: 'Error servidor: ' + err.message }] });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasKey: !!GEMINI_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MiRecetaAI Proxy en puerto ' + PORT));

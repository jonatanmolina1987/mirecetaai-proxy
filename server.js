const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const systemPrompt = `Eres MiRecetaAI, un chef latinoamericano experto. Dame una receta con estos ingredientes.

Formato EXACTO que debes usar:
RECETA: [nombre con emoji]
INGREDIENTES:
- ingrediente 1
- ingrediente 2
PASOS:
1. paso uno
2. paso dos
3. paso tres
TIP: consejo util del chef
PRESENTACION: descripcion visual del plato

Maximo 300 palabras. Espanol latinoamericano.`;

app.post('/api/receta', async (req, res) => {
  try {
    const { ingredients } = req.body;
    console.log('Request recibido - ingredientes:', ingredients);
    console.log('API Key configurada:', GEMINI_KEY ? 'SI (' + GEMINI_KEY.substring(0,8) + '...)' : 'NO');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: systemPrompt + '\n\nIngredientes disponibles: ' + ingredients }]
          }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
        })
      }
    );

    const data = await response.json();
    console.log('HTTP Status de Gemini:', response.status);

    if (!response.ok) {
      console.error('Error Gemini:', JSON.stringify(data));
      return res.json({ content: [{ type: 'text', text: 'Error Gemini ' + response.status + ': ' + JSON.stringify(data.error?.message || data) }] });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      console.error('Sin texto. Data:', JSON.stringify(data).substring(0,500));
      return res.json({ content: [{ type: 'text', text: 'Sin respuesta de Gemini: ' + JSON.stringify(data).substring(0,200) }] });
    }

    console.log('Receta generada OK, chars:', text.length);
    res.json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('Error catch:', err.message);
    res.json({ content: [{ type: 'text', text: 'Error: ' + err.message }] });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasKey: !!GEMINI_KEY, keyStart: GEMINI_KEY ? GEMINI_KEY.substring(0,8) : 'none' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MiRecetaAI Proxy en puerto ' + PORT));

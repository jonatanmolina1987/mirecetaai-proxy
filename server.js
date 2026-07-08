const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const systemPrompt = `Eres MiRecetaAI, un chef latinoamericano experto. El usuario te dará ingredientes. Responde con este formato EXACTO:

RECETA: [nombre con emoji]
INGREDIENTES:
- [ingrediente con ✅ si el usuario lo tiene]
PASOS:
1. [paso]
2. [paso]
TIP: [tip con 💡]
PRESENTACION: [descripción visual en 1 oración]

Máximo 320 palabras. Español latinoamericano.`;

app.post('/api/receta', async (req, res) => {
  try {
    const { ingredients } = req.body;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt + '\n\nTengo: ' + ingredients + '. ¿Qué puedo cocinar?' }] }],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
        })
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No pude generar la receta.';
    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

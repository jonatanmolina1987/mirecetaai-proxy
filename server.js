// MiRecetaAI - Servidor Proxy
// Sube esto a Render.com GRATIS y resuelve el error de conexión en la APK
// Instrucciones: ver README abajo

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Tu API key de Anthropic — ponla aquí o en variable de entorno
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || 'TU_API_KEY_AQUI';

app.post('/api/receta', async (req, res) => {
  try {
    const { ingredients, systemPrompt } = req.body;
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Tengo: ${ingredients}. ¿Qué puedo cocinar?` }]
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'MiRecetaAI Proxy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MiRecetaAI Proxy corriendo en puerto ${PORT}`));

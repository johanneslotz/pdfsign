const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function buildPrompt(extractedText, userInfo) {
  const parts = [];

  if (userInfo?.trim()) {
    parts.push(
      `USER INFORMATION (use this to suggest fill values):\n"""\n${userInfo.substring(0, 4000)}\n"""\n`
    );
  }

  if (extractedText?.trim()) {
    parts.push(
      `Embedded PDF text (may be incomplete for scanned pages):\n"""\n${extractedText.substring(0, 3000)}\n"""\n`
    );
  }

  parts.push(`Analyze this PDF page image. Identify every form field that requires user input.
Return ONLY valid JSON — no markdown, no code fences:
{
  "isForm": true,
  "fields": [
    {
      "label": "label text exactly as shown",
      "canonicalKey": "snake_case_identifier",
      "type": "text|date|email|phone|number|checkbox|signature|textarea|select",
      "inputPosition": { "top": 25.0, "left": 60.0 },
      "suggestedValue": "value derived from USER INFORMATION above, or empty string",
      "required": false
    }
  ]
}

Rules:
- inputPosition MUST be a percentage 0–100 (e.g. top:25.0 means 25% from the top of the page, left:60.0 means 60% from the left). Do NOT use pixel values.
- canonicalKey examples: first_name, last_name, date_of_birth, email, phone, address, city, zip, country, company, iban, tax_id, signature
- Only include blank fields for user input — skip pre-filled text
- For signature fields use type "signature" and leave suggestedValue empty
- If not a form, return {"isForm": false, "fields": []}`);

  return parts.join('\n');
}

function extractJSON(text) {
  // 1. Raw JSON
  try { return JSON.parse(text); } catch {}
  // 2. Inside markdown code fences (may be missing closing fence if truncated)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  if (fenceMatch) try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  // 3. Slice from first { to last } (handles leading/trailing prose)
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  // 4. Response was truncated — try to close the JSON by counting unclosed brackets
  if (start !== -1) {
    let partial = text.slice(start);
    // Drop any incomplete trailing object (last unclosed {)
    const lastComplete = partial.lastIndexOf('},');
    if (lastComplete !== -1) partial = partial.slice(0, lastComplete + 1);
    // Close the fields array and root object
    try { return JSON.parse(partial + ']}'); } catch {}
    try { return JSON.parse(partial + ']\n}'); } catch {}
  }
  throw new Error('No valid JSON in model response');
}

async function readStream(response, onToken) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer  = '';
  let content = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onToken(delta, content);
        }
      } catch {}
    }
  }

  return content;
}

export class VisionAPI {
  constructor(apiKey, model = 'google/gemini-2.0-flash-001') {
    this.apiKey = apiKey;
    this.model  = model;
  }

  async analyzeFormPage(imageDataUrl, extractedText = '', userInfo = '', onToken = null) {
    const prompt   = buildPrompt(extractedText, userInfo);
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  window.location.origin,
        'X-Title':       'PDFSign AI Assistant',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens:  4000,
        temperature: 0.1,
        stream:      true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter ${response.status}: ${body.substring(0, 300)}`);
    }

    const content = await readStream(response, onToken || (() => {}));
    if (!content) throw new Error('Empty response from vision model');

    try {
      const result = extractJSON(content);
      result._prompt = prompt;
      result._raw    = content;
      return result;
    } catch (err) {
      err._prompt = prompt;
      err._raw    = content;
      throw err;
    }
  }

  async chat(history, pageContexts = [], userInfo = '', onToken = null, fields = []) {
    if (!history.length) throw new Error('No messages');

    const messages = [];

    const firstUserText = history[0].content;
    const firstContent  = [];

    for (const ctx of pageContexts) {
      firstContent.push({ type: 'image_url', image_url: { url: ctx.imageDataUrl } });
    }

    let preamble = '';
    if (userInfo?.trim()) {
      preamble += `USER INFORMATION:\n"""\n${userInfo.substring(0, 4000)}\n"""\n\n`;
    }
    const pageTexts = pageContexts
      .filter(p => p.text?.trim())
      .map(p => `Page ${p.pageNum}:\n${p.text.substring(0, 2000)}`)
      .join('\n\n');
    if (pageTexts) {
      preamble += `PDF text content:\n"""\n${pageTexts}\n"""\n\n`;
    }
    if (fields.length) {
      const fieldSnapshot = fields.map(f => ({
        canonicalKey:  f.canonicalKey,
        label:         f.label,
        currentValue:  f._panelInput?.value || '',
      }));
      preamble +=
        `Detected form fields (with current values):\n${JSON.stringify(fieldSnapshot, null, 2)}\n\n` +
        `If the user asks to change or fill any fields, append this block at the END of your response ` +
        `(after your plain-text answer) and nothing else after it:\n` +
        `<field_updates>[{"canonicalKey":"...","value":"..."}]</field_updates>\n\n`;
    }

    firstContent.push({ type: 'text', text: preamble + firstUserText });
    messages.push({ role: 'user', content: firstContent });

    for (let i = 1; i < history.length; i++) {
      messages.push({ role: history[i].role, content: history[i].content });
    }

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  window.location.origin,
        'X-Title':       'PDFSign AI Assistant',
      },
      body: JSON.stringify({
        model:       this.model,
        messages,
        max_tokens:  2000,
        temperature: 0.3,
        stream:      true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter ${response.status}: ${body.substring(0, 300)}`);
    }

    const content = await readStream(response, onToken || (() => {}));
    if (!content) throw new Error('Empty response from model');
    return content;
  }
}

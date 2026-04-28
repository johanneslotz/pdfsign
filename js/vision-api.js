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
- inputPosition: percentage (0–100) from page top/left for WHERE the user enters the value
- canonicalKey examples: first_name, last_name, date_of_birth, email, phone, address, city, zip, country, company, iban, tax_id, signature
- Only include blank fields for user input — skip pre-filled text
- For signature fields use type "signature" and leave suggestedValue empty
- If not a form, return {"isForm": false, "fields": []}`);

  return parts.join('\n');
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  throw new Error('No valid JSON in model response');
}

export class VisionAPI {
  constructor(apiKey, model = 'google/gemini-2.0-flash-001') {
    this.apiKey = apiKey;
    this.model  = model;
  }

  async analyzeFormPage(imageDataUrl, extractedText = '', userInfo = '') {
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
            { type: 'text', text: buildPrompt(extractedText, userInfo) },
          ],
        }],
        max_tokens:  2000,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter ${response.status}: ${body.substring(0, 300)}`);
    }

    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from vision model');

    return extractJSON(content);
  }
}

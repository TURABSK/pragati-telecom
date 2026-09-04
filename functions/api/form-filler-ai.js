/**
 * Endpoint: POST /api/form-filler-ai
 * 
 * Smart Form Filler AI Field Detection
 * Securely calls Google Gemini Vision API to detect fields and bounding boxes on scanned forms.
 */

import {
  handleOptions,
  validateRequest,
  extractImageData,
  jsonResponse
} from "./_common.js";

const FORM_FILLER_PROMPT = `You are analyzing a scanned government/official application form image.

Detect EVERY fillable field, blank line, box, and checkbox on the page — including empty ones,
and including repeating rows in tables (e.g. if a family-member table repeats "Name" for 5 rows,
label them "Member 1 Name", "Member 2 Name", etc. — do not collapse them into one field).

Return STRICT JSON only, no markdown code fences, no commentary — a single JSON array:
[
  {
    "label": "short label as printed on the form (in the form's own language)",
    "value": "the filled-in value if the field already has handwritten or printed text in it, otherwise an empty string",
    "type": "text" | "textarea" | "checkbox" | "date" | "number",
    "box_2d": [ymin, xmin, ymax, xmax]
  }
]

Rules for box_2d:
- Integers normalized to a 0-1000 scale relative to the FULL image (top-left corner = [0,0,0,0], bottom-right = 1000).
- The box must cover the BLANK / ANSWER area where a value should be written (the empty underline, the empty box,
  or the checkbox glyph itself) — NOT the printed label text next to it.
- For a checkbox, make the box small and tight around just the checkbox glyph (☐ / □ / [ ]).
- Never skip a field just because it is currently empty.
- Never merge two distinct fields into a single box.`;

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  return handleFormFillerAI(request, env);
}

export async function handleFormFillerAI(request, env) {
  const validation = await validateRequest(request);
  if (validation.isOptions) return handleOptions();
  if (validation.errorResponse) return validation.errorResponse;

  const imageResult = extractImageData(validation.body);
  if (imageResult.error) {
    return jsonResponse({ success: false, error: imageResult.error }, 400);
  }

  const apiKey = env?.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    return jsonResponse({
      success: false,
      error: "Cloudflare secret GEMINI_API_KEY is not configured yet. Please configure it in your Cloudflare dashboard."
    }, 503);
  }

  const rawModel = env?.GEMINI_MODEL;
  const preferredModel = (typeof rawModel === "string" && rawModel.trim()) ? rawModel.trim() : "gemini-3.6-flash";
  const candidateModels = [preferredModel, "gemini-3.5-flash", "gemini-3.0-flash", "gemini-2.5-flash", "gemini-2.0-flash"].filter((m, i, arr) => arr.indexOf(m) === i);

  const payload = {
    contents: [{
      parts: [
        { text: FORM_FILLER_PROMPT },
        { inline_data: { mime_type: imageResult.mimeType || "image/jpeg", data: imageResult.base64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: "application/json"
    }
  };

  let geminiRes = null;
  let responseText = "";
  let data = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const currentModel = candidateModels[i];
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    try {
      geminiRes = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (geminiRes.status === 429) {
        return jsonResponse({
          success: false,
          error: "AI service rate limit reached. Please wait a moment and try again."
        }, 429);
      }

      responseText = await geminiRes.text();
      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }

      const errMsg = data?.error?.message || responseText;
      const recMatch = errMsg.match(/update your code to use (?:models\/)?([a-zA-Z0-9\.\-_]+)/i);
      if (recMatch && recMatch[1] && recMatch[1] !== currentModel) {
        const suggested = recMatch[1].trim();
        if (!candidateModels.includes(suggested)) {
          candidateModels.splice(i + 1, 0, suggested);
        }
        continue;
      }

      const isUnavailable =
        geminiRes.status === 404 ||
        geminiRes.status === 400 ||
        errMsg.includes("not found") ||
        errMsg.includes("no longer available") ||
        errMsg.includes("deprecated") ||
        errMsg.includes("update your code");

      if (isUnavailable && i < candidateModels.length - 1) {
        console.warn(`Model ${currentModel} unavailable, trying next...`);
        continue;
      }

      break;
    } catch (err) {
      console.error(`Fetch error on ${currentModel}:`, err);
    }
  }

  if (!geminiRes || !geminiRes.ok) {
    return jsonResponse({
      success: false,
      error: "Gemini API Error: " + (data?.error?.message || responseText || "Service unavailable")
    }, geminiRes ? geminiRes.status : 500);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    return jsonResponse({
      success: true,
      data: rawText
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: "Worker Error: " + (error.message || String(error))
    }, 500);
  }
}

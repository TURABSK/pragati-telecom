/**
 * Endpoint: POST /api/searchable-pdf-ai
 * 
 * Multi-Column Bengali & English OCR for Searchable PDF Maker
 * Securely calls Google Gemini Vision API without exposing keys to the browser.
 */

import {
  handleOptions,
  validateRequest,
  extractImageData,
  callGeminiVision,
  jsonResponse
} from "./_common.js";

const SEARCHABLE_PDF_PROMPT = `You are an expert OCR engine for multi-column Bengali and English documents, voter lists, and scanned records.
Extract EVERY text segment, word, or separate field with its exact bounding box [ymin, xmin, ymax, xmax].
Return STRICT JSON ONLY as a single array of objects, no markdown fences, no commentary:
[
  {"text": "লাইন বা শব্দের লেখা", "box": [ymin, xmin, ymax, xmax]}
]

CRITICAL POSITIONING RULES:
1. MULTI-COLUMN & VOTER CARDS: NEVER combine text across vertical columns or adjacent cards into a single wide line. Each voter card or table cell must be its OWN separate bounding box.
2. FIELD ISOLATION: Separate labels and values (e.g. "নাম:" and "রহিম সেখ", "বয়স:" and "৩৪") if there is any space or gap between them, so each has its own tight box.
3. TIGHT BOUNDING BOX: Integers normalized to 0-1000 scale relative to the image [ymin, xmin, ymax, xmax]. The box must tightly wrap the exact printed characters with NO extra horizontal or vertical margins.`;

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  return handleSearchablePdfAI(request, env);
}

export async function handleSearchablePdfAI(request, env) {
  const validation = await validateRequest(request);
  if (validation.isOptions) return handleOptions();
  if (validation.errorResponse) return validation.errorResponse;

  const imageResult = extractImageData(validation.body);
  if (imageResult.error) {
    return jsonResponse({ success: false, error: imageResult.error }, 400);
  }

  const result = await callGeminiVision({
    base64: imageResult.base64,
    mimeType: imageResult.mimeType,
    prompt: SEARCHABLE_PDF_PROMPT,
    env
  });

  if (result.status !== 200) {
    return jsonResponse({ success: false, error: result.error }, result.status);
  }

  return jsonResponse({
    success: true,
    blocks: result.blocks,
    truncated: result.truncated
  });
}

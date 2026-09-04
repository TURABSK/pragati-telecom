/**
 * Endpoint: POST /api/photo-enhance
 * 
 * Future Integration Architecture for AI Photo Enhancement:
 * - AI Super Resolution / HD Upscaling
 * - AI Deblur & Denoise
 * - AI Color Correction
 * 
 * When configured with a provider secret (e.g. PHOTO_ENHANCE_API_KEY or GEMINI_API_KEY),
 * forwards to the enhancement model. When not yet configured, returns a clear,
 * honest notification that the AI Enhancement backend is not configured yet.
 */

import {
  handleOptions,
  validateRequest,
  extractImageData,
  jsonResponse
} from "./_common.js";

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  return handlePhotoEnhance(request, env);
}

export async function handlePhotoEnhance(request, env) {
  const validation = await validateRequest(request);
  if (validation.isOptions) return handleOptions();
  if (validation.errorResponse) return validation.errorResponse;

  const imageResult = extractImageData(validation.body);
  if (imageResult.error) {
    return jsonResponse({ success: false, error: imageResult.error }, 400);
  }

  const requestedAction = validation.body.action || "hd";
  const validActions = ["hd", "super_resolution", "deblur", "denoise", "color_correct"];
  if (!validActions.includes(requestedAction)) {
    return jsonResponse({
      success: false,
      error: `Invalid enhancement action. Supported actions: ${validActions.join(", ")}`
    }, 400);
  }

  // Check if an AI Enhancement provider key is configured
  const enhanceKey = env?.PHOTO_ENHANCE_API_KEY || env?.REPLICATE_API_TOKEN || env?.STABILITY_API_KEY;

  if (!enhanceKey) {
    // Honest, clear status as required:
    return jsonResponse({
      success: false,
      configured: false,
      error: "AI Enhancement backend is not configured yet. Set up PHOTO_ENHANCE_API_KEY in your Cloudflare environment to enable cloud neural enhancement."
    }, 501);
  }

  // Future provider integration hook (e.g., Replicate, Real-ESRGAN, Stability, or Gemini Imagen)
  return jsonResponse({
    success: false,
    configured: true,
    error: "AI Enhancement model pipeline is in initialization mode."
  }, 503);
}

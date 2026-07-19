const dotenv = require("dotenv");
dotenv.config();
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_COPY_MODEL || "gemini-2.0-flash-lite";

const systemPrompt = `You are an expert Shopify product listing copywriter for Ironsmith Lighting Products, a high-end architectural lighting brand. You specialize in in-ground well lights, landscape lighting, and architectural fixtures.

Product type: Well Light Fixture
Brand: Ironsmith Lighting Products
SKU: WLC-L-KIT-5WLED-2
Known specs: 5W, 12V, 3000K, G5.3, solid brass body`;

const userMessage = `Step 3 — Generate the listing
Produce a single valid JSON object with these fields:
  "title"            – Buyer-facing SEO title. Formula: [Brand] [Product Type] – [Key Material/Feature], [Use Case] w/ [Core Spec(s)].
                       Max 120 chars. Title Case. Standard codes (MR16, GU10, PAR38, LED) in ALL CAPS.
                       Never put the SKU or model number in the title. Never dump raw spec sequences. Never repeat the product type word.
  "description_html" – Rich HTML body (120-280 words): benefit-led Hook → 1-2 context sentences → <ul> with 6-10 confirmed specs → closer.
  "seo_title"        – Meta page title. Primary buyer search keyword, distinct from title. Max 70 chars.
  "seo_description"  – Meta description. Keyword-rich, ends with a call to action. Max 155 chars.
  "tags"             – JSON array. 8-15 lowercase hyphenated tags.
  "vendor"           – Brand name.
  "product_type"     – Shopify product type.
  "sku"              – Empty string (not provided).
  "price"            – Empty string (not provided).
  "key_features"     – JSON array of 4-8 concise confirmed product attribute bullets.
  "base_type"        – "G5.3"
  "voltage"          – "12V"
  "wattage"          – "5W"
  "color_temp"       – "3000K"
  "material"         – "solid brass"

Return ONLY the JSON object. No markdown. No explanation. No code fences.`;

fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 3200, responseMimeType: "application/json" },
    tools: []
  })
}).then(r => {
  console.log("HTTP status:", r.status);
  return r.json();
}).then(d => {
  const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const finish = d?.candidates?.[0]?.finishReason || "";
  const err = d?.error?.message || "";
  console.log("finishReason:", finish);
  if (err) { console.log("Error:", err); return; }
  if (!text) { console.log("EMPTY RESPONSE. Full:", JSON.stringify(d).slice(0, 500)); return; }
  try {
    const obj = JSON.parse(text);
    console.log("title:", obj.title);
    console.log("base_type:", obj.base_type);
    console.log("material:", obj.material);
    console.log("SUCCESS — AI returned valid JSON with", Object.keys(obj).length, "fields");
  } catch (e) {
    console.log("JSON PARSE FAILED:", text.slice(0, 300));
  }
}).catch(e => console.error("Fetch error:", e.message));

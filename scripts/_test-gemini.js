const dotenv = require("dotenv");
dotenv.config();
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_COPY_MODEL || "gemini-2.0-flash-lite";
console.log("Testing model:", model, "key length:", key ? key.length : 0);
fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ role: "user", parts: [{ text: 'Reply with this exact JSON: {"ok":true}' }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 50, responseMimeType: "application/json" }
  })
}).then(r => {
  console.log("HTTP status:", r.status);
  return r.json();
}).then(d => {
  const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const err = d?.error?.message || "";
  console.log("Response:", text || err || JSON.stringify(d).slice(0, 300));
}).catch(e => console.error("Fetch error:", e.message));

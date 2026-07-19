const http = require("http");

const body = JSON.stringify({
  shortDescription: "12V 5W 3000K G5.3 well light kit solid brass WLC-L-KIT-5WLED-2",
  imageNames: [],
  imageRoot: "assets/products",
  shop: "ironsmith-lighting.myshopify.com"
});

const req = http.request({
  hostname: "127.0.0.1",
  port: 4320,
  path: "/api/workflow/template/from-images",
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
}, (res) => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    try {
      const obj = JSON.parse(data);
      const tpl = obj.template || {};
      console.log("ok:", obj.ok);
      console.log("aiGenerated:", tpl.aiGenerated);
      console.log("title:", tpl.row && tpl.row.title);
      console.log("seo_title:", tpl.row && tpl.row.seo_title);
      console.log("material:", tpl.row && tpl.row.material);
      console.log("base_type:", tpl.row && tpl.row.base_type);
      if (!tpl.aiGenerated) {
        console.log("AI FAILED — aiBuffer:", tpl.aiBuffer);
      } else {
        console.log("AI SUCCESS");
      }
    } catch(e) {
      console.log("Parse error:", e.message);
      console.log("Raw:", data.slice(0, 500));
    }
  });
});
req.on("error", e => console.error("Request error:", e.message));
req.write(body);
req.end();

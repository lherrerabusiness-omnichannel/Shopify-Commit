require("dotenv").config();
const https = require("https");
const { getTokenByShop } = require("./shopify-auth-store");
const t = getTokenByShop("ironsmith-lighting.myshopify.com");

function gql(query, vars) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query, variables: vars || {} });
    const req = https.request(
      {
        hostname: "ironsmith-lighting.myshopify.com",
        path: "/admin/api/2025-10/graphql.json",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": t.accessToken,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (r) => {
        let d = "";
        r.on("data", (c) => { d += c; });
        r.on("end", () => res(JSON.parse(d)));
      }
    );
    req.on("error", rej);
    req.write(body);
    req.end();
  });
}

(async () => {
  // Query all recent products to see current state
  const q = `query {
    products(first: 10, query: "sku:WLC-L-KIT-5WLED") {
      nodes {
        id title handle status updatedAt
        variants(first: 5) { nodes { sku } }
        media(first: 5) { nodes { ... on MediaImage { id image { url } } } }
      }
    }
  }`;
  const r = await gql(q);
  if (r.errors) { console.error(JSON.stringify(r.errors)); return; }
  const prods = r.data.products.nodes;
  if (!prods.length) { console.log("No product found with SKU WLC-L-KIT-5WLED-2"); return; }
  for (const p of prods) {
    const skus = p.variants.nodes.map(v => v.sku || "(no sku)").join(", ");
    const imgs = p.media.nodes.length;
    console.log(`\n[${p.status}] ${p.title}`);
    console.log(`  handle:  ${p.handle}`);
    console.log(`  SKU(s):  ${skus}`);
    console.log(`  media:   ${imgs}`);
    console.log(`  updated: ${p.updatedAt.slice(0, 16)}`);
  }
})().catch((e) => console.error(e.message));

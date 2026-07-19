require('dotenv').config();
const { getTokenByShop } = require('./shopify-auth-store');
const https = require('https');

const { accessToken: token } = getTokenByShop('ironsmith-lighting.myshopify.com');
const query = `{
  products(first: 5, query: "sku:WLC-L-KIT-5WLED", sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id title handle status updatedAt createdAt
      descriptionHtml
      seo { title description }
      tags
      vendor productType
      variants(first: 3) { nodes { sku price inventoryQuantity } }
      media(first: 10) { nodes { mediaContentType status ... on MediaImage { image { url } } } }
      metafields(first: 20) { nodes { namespace key value } }
    }
  }
}`;

const body = JSON.stringify({ query });
const opts = {
  hostname: 'ironsmith-lighting.myshopify.com',
  path: '/admin/api/2025-10/graphql.json',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = https.request(opts, res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    const json = JSON.parse(data);
    if (json.errors) { console.error(JSON.stringify(json.errors, null, 2)); return; }
    const products = json.data.products.nodes;
    products.forEach(p => {
      console.log('=== PRODUCT ===');
      console.log('ID:', p.id);
      console.log('Title:', p.title);
      console.log('Handle:', p.handle);
      console.log('Status:', p.status);
      console.log('Vendor:', p.vendor);
      console.log('ProductType:', p.productType);
      console.log('Tags:', p.tags.join(', '));
      console.log('SEO Title:', p.seo && p.seo.title);
      console.log('SEO Desc:', p.seo && p.seo.description);
      console.log('Body HTML (first 800):', (p.descriptionHtml || '').substring(0, 800));
      console.log('Variants:');
      p.variants.nodes.forEach(v => console.log('  SKU:', v.sku, '| Price:', v.price, '| Qty:', v.inventoryQuantity));
      console.log('Media count:', p.media.nodes.length);
      p.media.nodes.forEach(m => {
        const url = m.image && m.image.url ? m.image.url.substring(0, 90) : '(no url)';
        console.log(' ', m.mediaContentType, m.status, url);
      });
      console.log('Metafields:', p.metafields.nodes.map(m => m.namespace + '.' + m.key + '=' + String(m.value).substring(0, 60)).join('\n  '));
      console.log('Updated:', p.updatedAt);
      console.log('');
    });
  });
});
req.on('error', e => console.error(e));
req.write(body);
req.end();

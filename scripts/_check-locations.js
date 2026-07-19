require("dotenv").config();
const { getLatestToken } = require("./shopify-auth-store");
const { callShopifyGraphql } = require("./shopify-api-client");

(async () => {
  const t = getLatestToken();
  const endpoint = "https://" + t.shop + "/admin/api/2025-10/graphql.json";
  const query = "query { locations(first: 20) { nodes { id name isActive fulfillsOnlineOrders address { formatted } } } }";
  const data = await callShopifyGraphql({
    endpoint,
    token: t.accessToken,
    query,
    variables: {},
    operation: "location-introspect",
    canRetry: true,
  });
  console.log(JSON.stringify(data, null, 2));
})().catch((e) => console.error("ERROR:", e.message));

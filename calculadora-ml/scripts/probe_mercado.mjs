// Sonda a API do ML para ver o SHAPE real dos dados de anúncios/vendedores.
// Uso: node scripts/probe_mercado.mjs "caneta bic cristal"
import 'dotenv/config'

const API = 'https://api.mercadolibre.com'

async function token() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
  })
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const d = await r.json()
  if (!r.ok) throw new Error('auth: ' + JSON.stringify(d))
  return d.access_token
}

async function get(t, p) {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${t}` } })
  const d = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, d }
}

const q = process.argv[2] || 'caneta bic cristal'
const t = await token()

console.log('\n### /products/search q=', q)
const s = await get(t, `/products/search?status=active&site_id=MLB&q=${encodeURIComponent(q)}`)
console.log('status', s.status, 'keys', Object.keys(s.d || {}))
const results = s.d?.results || []
console.log('n results', results.length)
console.log('result[0] keys:', results[0] && Object.keys(results[0]))
console.log('result[0]:', JSON.stringify(results[0], null, 1)?.slice(0, 800))

const pid = results[0]?.id
if (pid) {
  console.log('\n### /products/%s', pid)
  const p = await get(t, `/products/${pid}`)
  console.log('status', p.status, 'keys:', Object.keys(p.d || {}))
  console.log('buy_box_winner:', JSON.stringify(p.d?.buy_box_winner, null, 1)?.slice(0, 900))
  console.log('price_range:', JSON.stringify(p.d?.buy_box_winner_price_range, null, 1))

  console.log('\n### /products/%s/items', pid)
  const it = await get(t, `/products/${pid}/items`)
  console.log('status', it.status, 'keys:', Object.keys(it.d || {}))
  const items = it.d?.results || []
  console.log('n items', items.length, '| paging:', JSON.stringify(it.d?.paging))
  console.log('item[0] keys:', items[0] && Object.keys(items[0]))
  console.log('item[0]:', JSON.stringify(items[0], null, 1)?.slice(0, 900))

  console.log('\n### todos os vendedores (resumo)')
  for (const it of items) {
    console.log(
      `  R$${String(it.price).padEnd(7)} ${it.listing_type_id?.padEnd(12)} ` +
      `${it.shipping?.free_shipping ? 'FRETEGRATIS' : 'frete-pago '} ` +
      `${it.official_store_id ? 'LOJA-OFICIAL' : '           '} ` +
      `${it.seller_address?.state?.name || '?'} ` +
      `tags=[${(it.tags || []).join(',')}]`
    )
  }

  const sid = items[0]?.seller_id
  if (sid) {
    console.log('\n### /users/%s (reputação do vendedor)', sid)
    const u = await get(t, `/users/${sid}`)
    console.log('status', u.status)
    console.log('keys:', Object.keys(u.d || {}))
    console.log('nickname:', u.d?.nickname)
    console.log('seller_reputation:', JSON.stringify(u.d?.seller_reputation, null, 1)?.slice(0, 900))
  }
}

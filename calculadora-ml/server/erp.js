// Proxy para o AGENTE LOCAL do ERP (roda na loja, alcança o Firebird).
// O app na internet chama o agente por um túnel seguro (Cloudflare) — ver
// agente-erp/README.md. As credenciais ficam só no servidor (env), nunca no
// navegador.
//
// Config por variável de ambiente (no easypanel):
//   ERP_API_URL   ex.: https://loja-fantinel.trycloudflare.com
//   ERP_API_KEY   o mesmo AGENT_TOKEN definido no agente
//   ERP_TIMEOUT_MS (opcional, padrão 8000)

export async function consultarProdutoErp(cod) {
  const base = (process.env.ERP_API_URL || '').replace(/\/+$/, '')
  const key = process.env.ERP_API_KEY || ''
  if (!base) return { encontrado: false, erro: 'erp_nao_configurado' }

  const codDig = String(cod || '').replace(/\D/g, '')
  if (!codDig) return { encontrado: false, erro: 'codigo_invalido' }

  const timeout = Number(process.env.ERP_TIMEOUT_MS) || 8000
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(`${base}/produto/${codDig}`, {
      headers: key ? { 'X-API-Key': key } : {},
      signal: ctrl.signal,
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return { encontrado: false, erro: 'erp_erro', status: r.status, detalhe: d?.error }
    return d
  } catch (e) {
    return { encontrado: false, erro: e.name === 'AbortError' ? 'erp_timeout' : 'erp_indisponivel' }
  } finally {
    clearTimeout(t)
  }
}

// status simples da conexão com o agente (para a tela avisar se está no ar)
export async function erpStatus() {
  const base = (process.env.ERP_API_URL || '').replace(/\/+$/, '')
  if (!base) return { configurado: false, online: false }
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
    return { configurado: true, online: r.ok }
  } catch {
    return { configurado: true, online: false }
  }
}

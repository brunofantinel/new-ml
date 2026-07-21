# Agente local do ERP — consulta de produto em tempo real

Permite que o app (na internet, no easypanel) consulte **um produto por código
interno** direto no Firebird da loja, **ao vivo**, sem expor a rede.

```
  App (easypanel)  --HTTPS-->  Túnel Cloudflare  -->  Agente local  -->  Firebird da loja
   /api/produto                (URL pública)         (este programa)      (192.168.0.4:3050)
```

O agente é **somente leitura** (só faz SELECT), exige um **token** e responde:
- `GET /health` — para o app checar se está no ar.
- `GET /produto/<codigo>` — todos os dados do produto (precisa do header `X-API-Key`).

---

## O que instalar na máquina da loja

A máquina precisa **enxergar o Firebird** (192.168.0.4:3050) — normalmente o
próprio servidor ou um PC na mesma rede.

1. **Python 3** (https://www.python.org/downloads/). Marque "Add Python to PATH".
2. **Driver Firebird**:
   ```
   py -m pip install -r requirements.txt
   ```
   E o cliente `fbclient.dll` (já vem com o Firebird instalado; o caminho padrão
   é `C:\Program Files\Firebird\Firebird_3_0\fbclient.dll`).
3. **cloudflared** (o túnel): baixe o `cloudflared.exe` da Cloudflare
   (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   e deixe no PATH (ou na mesma pasta deste README).

---

## Configurar

Copie `.env.example` para `definir_ambiente.bat` e preencha:
- `FB_PASSWORD` — senha do Firebird.
- `AGENT_TOKEN` — invente uma senha forte. **Use a MESMA** no easypanel em `ERP_API_KEY`.

---

## Ligar (todo dia / ao ligar o PC)

Dê dois cliques em **`iniciar.bat`**. Ele sobe o agente e o túnel. Na janela do
túnel aparece uma URL do tipo:

```
https://algo-aleatorio.trycloudflare.com
```

Copie essa URL e configure no **easypanel** (serviço `antl-new-ml` → Environment):
- `ERP_API_URL` = a URL do túnel (sem barra no fim)
- `ERP_API_KEY` = o mesmo `AGENT_TOKEN`

Reinicie o serviço no easypanel. Pronto: a aba **Consultar produto** passa a
funcionar ao vivo.

> ⚠️ **URL aleatória:** o túnel rápido (`trycloudflare`) troca a URL a cada vez
> que reinicia. Para uma **URL fixa**, use um *túnel nomeado* da Cloudflare
> (grátis, precisa de um domínio na conta) — veja abaixo.

---

## URL fixa (recomendado em produção) — túnel nomeado

Uma vez configurado, a URL nunca muda e você não precisa reeditar o easypanel:

```
cloudflared tunnel login
cloudflared tunnel create loja-erp
cloudflared tunnel route dns loja-erp erp.seudominio.com.br
```
Crie um `config.yml` apontando `erp.seudominio.com.br` para
`http://localhost:8799` e rode `cloudflared tunnel run loja-erp`. Depois é só
instalar como serviço do Windows (`cloudflared service install`) para subir
sozinho com o PC.

---

## Rodar o agente como serviço (subir sozinho)

Para não depender de alguém abrir o `.bat`:
- Agende o `iniciar.bat` no **Agendador de Tarefas do Windows** com gatilho
  "Ao iniciar o computador" e "Executar estando o usuário conectado ou não".
- Ou instale o `cloudflared` como serviço (acima) e crie uma tarefa só para o
  `agente_erp.py`.

---

## Segurança
- Só faz **leitura** (SELECT). Não altera nada na base.
- Exige o **token** (`X-API-Key`); sem ele, responde 401.
- A senha do banco e o token ficam **só na máquina da loja** e no easypanel,
  nunca no código nem no git.
- O túnel é **HTTPS** fim a fim (Cloudflare).

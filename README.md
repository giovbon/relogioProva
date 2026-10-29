# Relógio da Prova

Página web escura com a **hora oficial de Brasília** (extraída de [horariodebrasilia.org](https://www.horariodebrasilia.org/)) e uma **contagem regressiva para o fim da prova**, com a cor mudando conforme o tempo restante.

![verde](https://img.shields.io/badge/restante-acima%20de%2050%25-34d399) ![amarelo](https://img.shields.io/badge/restante-50%25%20a%2020%25-fbbf24) ![vermelho](https://img.shields.io/badge/restante-abaixo%20de%2020%25-f87171)

## O que a página faz

- Exibe **data e hora de Brasília** (UTC−3), sincronizadas com o horariodebrasilia.org.
- **Configurações em um modal**, abertas pela engrenagem no topo:
  - **início** e **fim** da prova;
  - **permanência mínima** em minutos (`0` libera a entrega desde o início);
  - atalhos de 1h a 4h que definem o início como "agora";
  - prévia da duração e do horário de liberação, com validação.
- Resumo fixo com início, fim e permanência mínima (e o dia, quando a prova não é hoje).
- Contagem regressiva grande, barra de progresso e estatísticas (duração, decorrido e % restante).
- Cores automáticas:
  - **verde** — mais de 50% do tempo restante;
  - **amarelo** — de 50% a 20%;
  - **vermelho** — menos de 20%;
  - **vermelho pulsando** — tempo esgotado.
- Aviso claro sobre a entrega, com cor e ícone próprios:
  - **Ainda não pode entregar** — antes do início ou antes de cumprir a permanência mínima;
  - **Já pode entregar a prova** — permanência mínima cumprida;
  - **A prova terminou** — fim do tempo.
- Antes do início, mostra quanto falta para a prova começar.
- A prova pode atravessar a meia-noite. Se a janela configurada já passou no dia, ela é considerada para o dia seguinte (o resumo mostra "amanhã").
- Horários e permanência ficam salvos no navegador (`localStorage`); nenhum dado é enviado a servidores.
- Funciona bem no celular e respeita `prefers-reduced-motion`.

## Como o aviso de entrega é calculado

- A entrega é liberada em **início + permanência mínima**, limitada ao fim da prova.
- A permanência mínima não pode ser maior que a duração da prova.
- `0` minuto significa entrega liberada desde o início.
- Ao fim da prova, o aviso passa a **"A prova terminou"**.

Tudo fica salvo em `localStorage` na chave `relogio-da-prova/v1`, no formato
`{ "start": "14:00", "end": "18:00", "minStay": 60, "date": "2026-10-28" }`.
O campo `date` é o dia da prova em Brasília; ele mantém a contagem estável mesmo quando a prova atravessa a meia-noite.

## Rodar localmente

Precisa apenas do Node.js 20 ou superior.

```bash
npm start
```

Abra <http://localhost:3000>. Nesse modo o servidor consulta o site da hora oficial e expõe `GET /api/time`; a página se sincroniza **ao vivo** (cache de 5 minutos).

Para gerar o snapshot manualmente:

```bash
npm run sync
```

## Publicar no GitHub Pages

1. Crie um repositório e envie estes arquivos (a branch pode ser `main` ou `master`).
2. No GitHub, vá em **Settings → Pages** e escolha **Source: GitHub Actions**.
3. O workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) já está configurado: ele captura a hora oficial, gera `public/time.json` e publica a pasta `public/`.

O workflow roda:

- a cada **push**;
- **a cada 30 minutos** (agendamento);
- manualmente, em **Actions → Deploy no GitHub Pages → Run workflow**.

### Por que um GitHub Action?

O navegador **não consegue** ler o horariodebrasilia.org diretamente: o site não envia cabeçalhos CORS, então qualquer `fetch` a partir de outra origem é bloqueado. Por isso o Action faz a captura no servidor e publica um `time.json` estático, que a página consome.

No modo Pages, o `time.json` guarda a hora oficial e o instante da captura; como um site estático não tem uma fonte de tempo independente, o relógio avança com o relógio do dispositivo. Para uma sincronização contínua e independente do relógio do dispositivo, use o modo servidor (`npm start`).

## Estrutura

```
public/
  index.html      página (relógio, resumo, aviso e modal)
  styles.css      tema escuro e estados de cor
  app.js          relógio, contagem, configuração e aviso de entrega
  time.json       snapshot da hora oficial (gerado)
lib/hora.js       leitura/parse da fonte (compartilhado)
server.js         modo ao vivo + servidor estático (opcional)
scripts/
  sync-time.cjs   gera public/time.json
.github/workflows/
  deploy-pages.yml
```

Endpoints do modo servidor:

| Rota          | Descrição                                      |
| ------------- | ---------------------------------------------- |
| `GET /`       | página                                          |
| `GET /api/time` | hora oficial já corrigida (JSON)             |
| `GET /api/health` | status do serviço                          |

Variáveis de ambiente do servidor: `PORT` (3000), `HOST` (`0.0.0.0`), `SOURCE_URL`, `SYNC_TTL_MS` (5 min) e `FETCH_TIMEOUT_MS` (8 s).

## Notas

- A fonte é consultada com cache (5 min no servidor, 30 min no Action), uma requisição por vez e `User-Agent` identificado. Se o site bloquear ou ficar fora do ar, a página continua funcionando com a última referência ou com o relógio local, avisando na tela.
- A precisão é de aproximadamente **1 segundo** (o site exibe a hora com segundos).
- Brasília não tem mais horário de verão desde 2019, então o deslocamento fixo UTC−3 é correto.

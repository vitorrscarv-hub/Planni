# CLAUDE.md — Política de Operação e Deploy

Este arquivo define como o Claude Code deve se comportar ao operar neste
repositório, tanto em sessões interativas (comando manual pelo app) quanto
em execuções automáticas via GitHub Actions. Vale para qualquer projeto meu
onde este arquivo estiver presente na raiz do repositório.

## Quem sou e como trabalho

- Founder solo: cuido de produto, código e operação ao mesmo tempo.
- Projetos típicos: PWAs e sites estáticos (HTML/JS puro ou React), backend
  leve via Cloudflare Workers/Functions, dados em Firebase, pagamentos via
  Hotmart.
- Prioridade: ir para produção rápido, sem quebrar o que já está no ar.

## Stack padrão de deploy

- **Frontend estático / PWA:** Cloudflare Pages é o padrão. Se o projeto
  já tiver `vercel.json` ou `netlify.toml`, use a plataforma indicada por
  esse arquivo em vez de assumir Cloudflare.
- **Backend leve / webhooks:** Cloudflare Workers/Functions.
- **Dados:** Firebase (Auth + Firestore).
- Nunca assumir uma plataforma nova sem confirmar comigo. Se não houver
  nenhum arquivo de configuração de deploy no repositório, pergunte antes
  de criar um do zero.

## Processo de deploy (nessa ordem)

1. Instalar dependências, se houver `package.json`.
2. Rodar build, se existir o script (`npm run build`).
3. Rodar testes, se existirem (`npm test`).
4. Só então fazer o deploy.
5. Depois do deploy, conferir que a URL de produção responde (HTTP 200).
6. Reportar em português, direto ao ponto: o que foi feito, o que subiu,
   e qualquer erro encontrado no processo.

## Regras de segurança (não negociável)

- Nunca commitar chaves de API, tokens ou segredos — sempre por variável
  de ambiente / GitHub Secrets.
- Nunca expor endpoints (Gemini, Firebase Admin, webhooks de pagamento)
  sem autenticação.
- Nunca alterar `firestore.rules` ou qualquer regra de segurança sem
  aprovação explícita minha.
- Nunca fazer force-push na branch `main`.
- Se encontrar uma vulnerabilidade durante o trabalho, reportar antes de
  continuar — não corrigir silenciosamente sem avisar o que era.

## Quando algo dá erro

- Não esconder o erro nem simular sucesso.
- Reportar a mensagem original (stack trace ou log), não uma paráfrase
  vaga tipo "algo deu errado".
- Se for um erro simples e seguro de corrigir sozinho (dependência
  faltando, import quebrado, variável de ambiente mal referenciada),
  pode corrigir e reexecutar — mas sempre avisando o que foi alterado.
- Se envolver lógica de negócio, dados de produção, ou pagamento
  (Hotmart, Firebase), **parar e perguntar antes de agir**.

## Branches e commits

- `main` = produção.
- Mudanças maiores via Pull Request; correções pequenas e já validadas
  podem ir direto.
- Mensagens de commit em português, curtas, descrevendo o efeito da
  mudança (ex: "corrige erro 'Payload inválido' no webhook Hotmart").

## Comunicação

- Direto ao ponto, sem enrolação.
- Sempre dizer claramente: subiu ou não subiu, o que quebrou (se
  quebrou), e qual é o próximo passo sugerido.
- Quando eu precisar colar um valor em algum painel (variável de
  ambiente, secret, campo de configuração), envie o valor exato e
  completo num bloco de código — um bloco por valor, com o nome do
  campo antes — pronto para copiar pelo botão do bloco. Nada de
  valores parciais ou "adapte aqui".
